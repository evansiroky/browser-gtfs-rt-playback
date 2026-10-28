import type { StatusError } from '@gtfs-rt-debugger/shared';
import type { FastifyBaseLogger } from 'fastify';
import { toEpochSeconds, type Clock, type Timer } from '../clock.js';
import type { Config } from '../config.js';
import type { ScheduleProvider, ScheduleStatus } from '../session/schedule-provider.js';
import { downloadSchedule } from './download.js';
import { toStatusError } from './errors.js';
import { LoadGuard } from './guard.js';
import { MemoryBudget } from './memory.js';
import { parseSchedule } from './parse.js';
import type { ScheduleStore } from './store.js';

/** feed-ingest.md "Schedule": one automatic retry follows a failed load after this long. */
export const RETRY_DELAY_MS = 30_000;

/**
 * Reading the downloaded archive is bounded too (the download limit and timeout only cover the
 * download): it may inflate to this many times `SCHEDULE_MAX_BYTES`, else `too_large`.
 */
export const DECOMPRESSION_FACTOR = 8;

/** Reading the archive must finish within this many times `SCHEDULE_TIMEOUT_MS`, else `timeout`. */
export const PARSE_TIMEOUT_FACTOR = 4;

/** Downloads and reduces the schedule; replaceable in tests. Must stop working once `signal` aborts. */
export type LoadSchedule = (signal: AbortSignal) => Promise<ScheduleStore>;

export interface ScheduleLoaderOptions {
  config: Pick<
    Config,
    'scheduleUrl' | 'scheduleTimeoutMs' | 'scheduleMaxBytes' | 'scheduleMemoryLimitBytes'
  >;
  clock: Clock;
  logger: FastifyBaseLogger;
  /** Default: download `config.scheduleUrl` and parse it. */
  load?: LoadSchedule;
}

/**
 * The schedule side of an activation (feed-ingest.md "Schedule", data-retention.md): downloads
 * the schedule once per activation, reduces it to a {@link ScheduleStore} and reports its state
 * for the session status.
 *
 * - `start()` begins the one download of the activation; calls while a load is running, or after
 *   it succeeded or failed, do nothing.
 * - A failed load is retried once automatically after {@link RETRY_DELAY_MS} (on the injected
 *   clock). If that fails too the schedule stays `failed` until `retry()` (a session start) loads
 *   it again, which counts as a fresh load with its own automatic retry.
 * - `discard()` abandons any load in flight, forgets the data and returns to `idle`; a load that
 *   still completes afterwards is ignored.
 *
 * While `failed`, `error` is the last failure; a load in progress (a retry included) reports
 * `loading` with no error.
 */
export class ScheduleLoader implements ScheduleProvider {
  readonly #clock: Clock;
  readonly #logger: FastifyBaseLogger;
  readonly #load: LoadSchedule;
  #state: ScheduleStatus['state'] = 'idle';
  #loadedAt: number | null = null;
  #error: StatusError | null = null;
  #store: ScheduleStore | null = null;
  #controller: AbortController | null = null;
  #retryTimer: Timer | null = null;
  /** Identifies the current load; bumped by every load and by `discard`, so stale results are dropped. */
  #generation = 0;

  constructor({ config, clock, logger, load }: ScheduleLoaderOptions) {
    this.#clock = clock;
    this.#logger = logger;
    this.#load =
      load ??
      (async (signal) => {
        const body = await downloadSchedule(config.scheduleUrl, {
          clock,
          timeoutMs: config.scheduleTimeoutMs,
          maxBytes: config.scheduleMaxBytes,
          signal,
        });
        const guard = new LoadGuard({
          signal,
          maxDecompressedBytes: DECOMPRESSION_FACTOR * config.scheduleMaxBytes,
          deadlineAt: clock.now() + PARSE_TIMEOUT_FACTOR * config.scheduleTimeoutMs,
          now: () => clock.now(),
        });
        return parseSchedule(body, new MemoryBudget(config.scheduleMemoryLimitBytes), guard);
      });
  }

  /** The loaded schedule; null unless `status().state` is `ready`. */
  get store(): ScheduleStore | null {
    return this.#store;
  }

  start(): void {
    if (this.#state === 'idle') this.#begin(true);
  }

  retry(): void {
    if (this.#state === 'failed') this.#begin(true);
  }

  discard(): void {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
    this.#cancelRetry();
    this.#store = null;
    this.#state = 'idle';
    this.#loadedAt = null;
    this.#error = null;
  }

  status(): ScheduleStatus {
    return { state: this.#state, loadedAt: this.#loadedAt, error: this.#error };
  }

  #cancelRetry(): void {
    if (this.#retryTimer) this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** `retryOnFailure`: schedule the one automatic retry if this load fails. */
  #begin(retryOnFailure: boolean): void {
    this.#cancelRetry();
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    this.#state = 'loading';
    this.#error = null;
    (async () => this.#load(controller.signal))().then(
      (store) => {
        if (generation !== this.#generation) return;
        this.#controller = null;
        this.#store = store;
        this.#loadedAt = toEpochSeconds(this.#clock.now());
        this.#state = 'ready';
        this.#logger.info({ ...store.counts() }, 'schedule loaded');
      },
      (error: unknown) => {
        if (generation !== this.#generation) return;
        this.#controller = null;
        this.#state = 'failed';
        this.#error = toStatusError(error);
        if (this.#error.code === 'internal_error') {
          this.#logger.error({ err: error, willRetry: retryOnFailure }, 'schedule load crashed');
        } else {
          this.#logger.warn(
            { code: this.#error.code, willRetry: retryOnFailure },
            'schedule load failed',
          );
        }
        if (retryOnFailure) {
          this.#retryTimer = this.#clock.setTimeout(() => {
            this.#retryTimer = null;
            this.#begin(false);
          }, RETRY_DELAY_MS);
        }
      },
    );
  }
}
