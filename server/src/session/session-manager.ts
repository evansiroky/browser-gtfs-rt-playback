import type { EndedReason, SessionStatus } from '@gtfs-rt-debugger/shared';
import type { FastifyBaseLogger } from 'fastify';
import { toEpochSeconds, type Clock, type Timer } from '../clock.js';
import type { FeedPoller } from '../realtime/feed-poller.js';
import type { FeedKind, SnapshotStore } from '../realtime/snapshot-store.js';
import type { ScheduleProvider } from './schedule-provider.js';

export interface SessionManagerOptions {
  clock: Clock;
  logger: FastifyBaseLogger;
  idleTimeoutMs: number;
  maxActivationMs: number;
  exitOnIdle: boolean;
  store: SnapshotStore;
  schedule: ScheduleProvider;
  /** One per configured feed; a feed without a poller is reported as not configured. */
  pollers: readonly FeedPoller[];
  /** Called once after an idle shutdown when `exitOnIdle` is set; should drain and exit. */
  onIdleExit: () => void;
}

/**
 * The single server-wide activation (session-lifecycle.md).
 *
 * - `start()` wakes a dormant server unconditionally; on an active server whose schedule load
 *   failed it calls `ScheduleProvider.retry()`.
 * - `ping()` wakes a dormant server unless the last activation ended by `max-duration`.
 * - Both reset the inactivity timer in every state, dormant included. The timer also runs from
 *   construction, so a process that never receives a session request still shuts down.
 * - When the inactivity timer fires the server forgets everything; with `exitOnIdle` it then calls
 *   `onIdleExit` and never wakes again (a request racing the exit gets a dormant status; the next
 *   one reaches a fresh process), otherwise it stays up, dormant, with no `max-duration` lock.
 * - The maximum-duration timer ends the activation (dormant, `max-duration`) while the process
 *   keeps running and keeps receiving pings.
 *
 * Every transition is synchronous, so concurrent requests can never start two activations.
 */
export class SessionManager {
  readonly #options: SessionManagerOptions;
  #activatedAt: number | null = null;
  #endedReason: EndedReason | null = null;
  #idleTimer: Timer | null = null;
  #maxTimer: Timer | null = null;
  #shutDown = false;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#resetIdleTimer();
  }

  get active(): boolean {
    return this.#activatedAt !== null;
  }

  start(): SessionStatus {
    this.#resetIdleTimer();
    if (this.#shutDown) return this.status();
    if (!this.active) this.#wake();
    else if (this.#options.schedule.status().state === 'failed') this.#options.schedule.retry();
    return this.status();
  }

  ping(): SessionStatus {
    this.#resetIdleTimer();
    if (!this.active && !this.#shutDown && this.#endedReason !== 'max-duration') this.#wake();
    return this.status();
  }

  status(): SessionStatus {
    const { maxActivationMs, schedule, store, pollers } = this.#options;
    if (this.#activatedAt === null) {
      return {
        state: 'dormant',
        endedReason: this.#endedReason,
        activatedAt: null,
        expiresAt: null,
        historyStartsAt: null,
        schedule: { state: 'idle', loadedAt: null, error: null },
        realtime: { vehiclePositions: null, tripUpdates: null },
      };
    }
    const feedStatus = (feed: FeedKind) => pollers.find((p) => p.feed === feed)?.status() ?? null;
    const historyStartsAt = store.historyStartsAt();
    return {
      state: 'active',
      endedReason: null,
      activatedAt: toEpochSeconds(this.#activatedAt),
      expiresAt: toEpochSeconds(this.#activatedAt + maxActivationMs),
      historyStartsAt: historyStartsAt === null ? null : toEpochSeconds(historyStartsAt),
      schedule: schedule.status(),
      realtime: {
        vehiclePositions: feedStatus('vehiclePositions'),
        tripUpdates: feedStatus('tripUpdates'),
      },
    };
  }

  /** Stops every timer and forgets everything without exiting (graceful process shutdown). */
  dispose(): void {
    this.#shutDown = true;
    if (this.#idleTimer) this.#options.clock.clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    if (this.active) this.#end(null);
  }

  #wake(): void {
    const { clock, logger, maxActivationMs, schedule, pollers } = this.#options;
    this.#activatedAt = clock.now();
    this.#endedReason = null;
    this.#maxTimer = clock.setTimeout(() => this.#end('max-duration'), maxActivationMs);
    schedule.start();
    for (const poller of pollers) poller.start();
    logger.info('session activated');
  }

  #end(reason: EndedReason | null): void {
    const { clock, logger, schedule, store, pollers } = this.#options;
    if (this.#maxTimer) clock.clearTimeout(this.#maxTimer);
    this.#maxTimer = null;
    for (const poller of pollers) poller.stop();
    schedule.discard();
    store.clear();
    this.#activatedAt = null;
    this.#endedReason = reason;
    if (reason) logger.info({ reason }, 'session ended');
  }

  #resetIdleTimer(): void {
    const { clock, idleTimeoutMs } = this.#options;
    if (this.#shutDown) return;
    if (this.#idleTimer) clock.clearTimeout(this.#idleTimer);
    this.#idleTimer = clock.setTimeout(() => this.#idle(), idleTimeoutMs);
  }

  #idle(): void {
    const { exitOnIdle, logger, onIdleExit } = this.#options;
    this.#idleTimer = null;
    if (this.active) this.#end('idle');
    // An idle shutdown also clears a max-duration lock.
    else this.#endedReason = null;
    if (!exitOnIdle) return;
    this.#shutDown = true;
    logger.info('idle shutdown: exiting');
    onIdleExit();
  }
}
