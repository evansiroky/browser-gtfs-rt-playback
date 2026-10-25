import type { EndedReason, SessionStatus } from '@gtfs-rt-debugger/shared';
import type { FastifyBaseLogger } from 'fastify';
import { toEpochSeconds, type Clock, type Timer } from '../clock.js';
import type { FeedPoller } from '../realtime/feed-poller.js';
import type { FeedKind, SnapshotStore } from '../realtime/snapshot-store.js';
import { runHook } from '../hooks.js';
import type { ScheduleProvider, ScheduleStatus } from './schedule-provider.js';

const SCHEDULE_FAULT = {
  code: 'internal_error',
  message: 'The schedule could not be loaded because of an internal error.',
};

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
  /** A schedule provider call threw during this activation. */
  #scheduleFault = false;

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
    else if (this.scheduleStatus().state === 'failed') this.#callSchedule('retry');
    return this.status();
  }

  ping(): SessionStatus {
    this.#resetIdleTimer();
    if (!this.active && !this.#shutDown && this.#endedReason !== 'max-duration') this.#wake();
    return this.status();
  }

  /**
   * The schedule block of the status: `idle` while dormant, otherwise the provider's report, or
   * `failed` with a generic `internal_error` when a provider call threw.
   */
  scheduleStatus(): ScheduleStatus {
    if (!this.active) return { state: 'idle', loadedAt: null, error: null };
    if (!this.#scheduleFault) {
      let status: ScheduleStatus | undefined;
      if (
        runHook(this.#options.logger, 'schedule.status', () => {
          status = this.#options.schedule.status();
        }) &&
        status
      ) {
        return status;
      }
    }
    return { state: 'failed', loadedAt: null, error: SCHEDULE_FAULT };
  }

  status(): SessionStatus {
    const { maxActivationMs, store, pollers } = this.#options;
    if (this.#activatedAt === null) {
      return {
        state: 'dormant',
        endedReason: this.#endedReason,
        activatedAt: null,
        expiresAt: null,
        historyStartsAt: null,
        schedule: this.scheduleStatus(),
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
      schedule: this.scheduleStatus(),
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

  /**
   * The activation's state is set before any hook runs, and the pollers start independently of
   * the schedule provider, so a throwing provider leaves a consistent activation whose schedule
   * reports `failed`.
   */
  #wake(): void {
    const { clock, logger, maxActivationMs, pollers } = this.#options;
    this.#activatedAt = clock.now();
    this.#endedReason = null;
    this.#scheduleFault = false;
    this.#maxTimer = clock.setTimeout(() => this.#end('max-duration'), maxActivationMs);
    for (const poller of pollers) poller.start();
    this.#callSchedule('start');
    logger.info('session activated');
  }

  /** The state is dormant before any hook runs; each hook's failure is contained. */
  #end(reason: EndedReason | null): void {
    const { clock, logger, store, pollers } = this.#options;
    if (this.#maxTimer) clock.clearTimeout(this.#maxTimer);
    this.#maxTimer = null;
    this.#activatedAt = null;
    this.#endedReason = reason;
    for (const poller of pollers) poller.stop();
    this.#callSchedule('discard');
    this.#scheduleFault = false;
    store.clear();
    if (reason) logger.info({ reason }, 'session ended');
  }

  #callSchedule(method: 'start' | 'retry' | 'discard'): void {
    const { logger, schedule } = this.#options;
    const completed = runHook(logger, `schedule.${method}`, () => schedule[method]());
    if (method !== 'discard') this.#scheduleFault = !completed;
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
