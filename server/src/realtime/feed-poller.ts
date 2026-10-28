import type { FeedStatus, StatusError } from '@gtfs-rt-debugger/shared';
import type { FastifyBaseLogger } from 'fastify';
import { toEpochSeconds, type Clock, type Timer } from '../clock.js';
import { FetchError, fetchAll } from '../fetch/bounded-fetch.js';
import type { SecretUrl } from '../secret-url.js';
import {
  decodeFeed,
  headerTimestamp,
  type FeedKind,
  type FeedMessage,
  type SnapshotStore,
} from './snapshot-store.js';

/** A feed is stale when its latest success is older than this many poll intervals. */
export const STALE_AFTER_INTERVALS = 3;

export interface FeedPollerOptions {
  feed: FeedKind;
  url: SecretUrl;
  clock: Clock;
  store: SnapshotStore;
  logger: FastifyBaseLogger;
  intervalMs: number;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Polls one realtime feed while running (feed-ingest.md "Realtime"): a fetch immediately on
 * {@link start}, then one per interval on a fixed cadence; a tick is skipped, not queued, while
 * the previous fetch is still in flight. {@link stop} abandons any in-flight fetch, discards its
 * result and forgets the feed status.
 */
export class FeedPoller {
  readonly feed: FeedKind;
  readonly #options: FeedPollerOptions;
  #timer: Timer | null = null;
  #inFlight: AbortController | null = null;
  #startedAt: number | null = null;
  #lastAttemptAt: number | null = null;
  #lastSuccessAt: number | null = null;
  #feedTimestamp: number | null = null;
  #error: StatusError | null = null;

  constructor(options: FeedPollerOptions) {
    this.feed = options.feed;
    this.#options = options;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer) return;
    const { clock, intervalMs } = this.#options;
    this.#startedAt = clock.now();
    this.#timer = clock.setInterval(() => this.#tick(), intervalMs);
    this.#tick();
  }

  stop(): void {
    if (this.#timer) this.#options.clock.clearInterval(this.#timer);
    this.#timer = null;
    this.#inFlight?.abort();
    this.#inFlight = null;
    this.#startedAt = null;
    this.#lastAttemptAt = null;
    this.#lastSuccessAt = null;
    this.#feedTimestamp = null;
    this.#error = null;
  }

  /** Null while stopped. */
  status(): FeedStatus | null {
    if (this.#startedAt === null) return null;
    const { clock, intervalMs } = this.#options;
    // A feed that has never succeeded ages from the start of polling.
    const since = this.#lastSuccessAt ?? this.#startedAt;
    return {
      lastAttemptAt: this.#lastAttemptAt === null ? null : toEpochSeconds(this.#lastAttemptAt),
      lastSuccessAt: this.#lastSuccessAt === null ? null : toEpochSeconds(this.#lastSuccessAt),
      feedTimestamp: this.#feedTimestamp,
      stale: clock.now() - since > STALE_AFTER_INTERVALS * intervalMs,
      error: this.#error,
    };
  }

  #tick(): void {
    const { store } = this.#options;
    store.prune();
    if (this.#inFlight) return;
    const controller = new AbortController();
    this.#inFlight = controller;
    this.#poll(controller)
      .catch((error: unknown) => {
        this.#options.logger.error({ err: error, feed: this.feed }, 'realtime poll failed');
      })
      .finally(() => {
        if (this.#inFlight === controller) this.#inFlight = null;
      });
  }

  async #poll(controller: AbortController): Promise<void> {
    const { feed, url, clock, store, logger, timeoutMs, maxBytes } = this.#options;
    this.#lastAttemptAt = clock.now();
    let bytes: Uint8Array;
    let message: FeedMessage;
    try {
      bytes = await fetchAll(url, {
        clock,
        logger,
        feed,
        timeoutMs,
        maxBytes,
        signal: controller.signal,
      });
      logger.info({ feed, bytes: bytes.byteLength }, 'realtime parse started');
      try {
        message = decodeFeed(bytes);
      } catch {
        logger.warn({ feed, code: 'decode_failed' }, 'realtime parse failed');
        throw new FetchError('decode_failed', 'The feed response is not a valid GTFS-RT message.');
      }
      logger.info(
        { feed, entities: message.entity.length, feedTimestamp: headerTimestamp(message) },
        'realtime parse succeeded',
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      this.#error =
        error instanceof FetchError
          ? error.toStatusError()
          : { code: 'internal_error', message: 'The fetch failed unexpectedly.' };
      return;
    }
    if (controller.signal.aborted) return;
    const snapshot = store.add(feed, bytes, message);
    this.#lastSuccessAt = snapshot.receivedAt;
    this.#feedTimestamp = snapshot.feedTimestamp;
    this.#error = null;
  }
}
