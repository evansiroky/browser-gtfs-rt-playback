import type { SessionStatus } from '@gtfs-rt-debugger/shared';

/** The cadence of pings while engaged ([client-activity](../../../specs/behaviors/client-activity.md)). */
export const PING_INTERVAL_MS = 10_000;
/** Without an interaction for this long, a visible page is no longer engaged. */
export const IDLE_TIMEOUT_MS = 60_000;

/**
 * - `starting`: engaged, but no start has succeeded yet
 * - `engaged`: visible and recently touched; pinging every {@link PING_INTERVAL_MS}
 * - `paused-hidden` / `paused-idle`: nothing is sent or polled
 * - `ended`: the server went dormant with `max-duration`; only {@link ActivityController.restart}
 *   gets out of it, never a ping
 */
export type ActivityPhase = 'starting' | 'engaged' | 'paused-hidden' | 'paused-idle' | 'ended';

export interface Clock {
  /** Milliseconds; only differences are used. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export interface SessionApi {
  start(signal: AbortSignal): Promise<SessionStatus>;
  ping(signal: AbortSignal): Promise<SessionStatus>;
}

export interface ActivitySnapshot {
  phase: ActivityPhase;
  /** The last status the server answered with; kept across failures and pauses. */
  status: SessionStatus | null;
  /** {@link Clock.now} when `status` arrived. */
  statusAt: number | null;
  /** The most recent session request's failure, cleared by the next success. */
  error: Error | null;
  /**
   * True from the moment the page becomes engaged again until the ping (or start) that
   * announces it has been answered, so the server is awake before data is refetched.
   */
  resuming: boolean;
  /** The last Restart / Retry failed and nothing has succeeded since. */
  restartFailed: boolean;
}

type RequestKind = 'start' | 'ping';

interface InFlight {
  kind: RequestKind;
  abort: AbortController;
  /** Sent by the Restart / Retry action rather than by the cadence. */
  userInitiated: boolean;
}

/**
 * Decides when the page pings the server. Framework-free: inputs are visibility changes,
 * interactions, timer ticks (through the injected {@link Clock}) and API responses; outputs are
 * `start`/`ping` requests and snapshots.
 *
 * - The page is *engaged* while visible, not `ended`, and touched within {@link IDLE_TIMEOUT_MS}.
 * - Engaged: a ping every {@link PING_INTERVAL_MS}; a tick never stacks on a request still in
 *   flight, and a failed request leaves the last status in place.
 * - Not engaged: the cadence stops and any in-flight request is aborted.
 * - Becoming engaged again sends exactly one immediate request and then resumes the cadence.
 *   It is a ping, except while no start has ever succeeded (a page loaded in a hidden tab, or a
 *   failed first start), when it is a start.
 * - A response of `dormant` with `max-duration` ends the session: no more requests until
 *   {@link restart}.
 */
export class ActivityController {
  private readonly api: SessionApi;
  private readonly clock: Clock;
  private readonly listeners = new Set<() => void>();

  private running = false;
  private everSent = false;
  private startSucceeded = false;
  private visible: boolean;
  private idle = false;
  private lastInteractionAt = 0;
  private status: SessionStatus | null = null;
  private statusAt: number | null = null;
  private error: Error | null = null;
  private resuming = false;
  private restartFailed = false;
  private inFlight: InFlight | null = null;
  private cadenceTimer: unknown = null;
  private idleTimer: unknown = null;
  private snapshot: ActivitySnapshot;

  constructor(options: { api: SessionApi; clock?: Clock; visible?: boolean }) {
    this.api = options.api;
    this.clock = options.clock ?? systemClock;
    this.visible = options.visible ?? true;
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot = (): ActivitySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Page load: the first request is a start. Idempotent while running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastInteractionAt = this.clock.now();
    this.idle = false;
    this.armIdleTimer();
    this.sync(true);
    this.commit();
  }

  /** Teardown: no timers, no requests. A later {@link start} begins afresh. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.everSent = false;
    this.startSucceeded = false;
    this.cancelCadence();
    this.abortInFlight();
    this.clearIdleTimer();
    this.resuming = false;
    this.commit();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    // Coming back to the tab counts as touching the page.
    if (visible && this.running) this.touch();
    if (this.running) this.sync(true);
    this.commit();
  }

  /** Any pointer, touch, scroll, wheel or key activity. Cheap enough to call on every event. */
  noteInteraction(): void {
    if (!this.running) return;
    this.touch();
    this.sync(true);
    this.commit();
  }

  /** The **Restart** / **Retry** actions: always a start, whatever state the page is in. */
  restart(): void {
    if (!this.running) return;
    this.send('start', false, true);
    // A restart replaces whatever cadence was running.
    if (this.cadenceTimer !== null) {
      this.cancelCadence();
      this.armCadence();
    }
    this.commit();
  }

  private touch(): void {
    this.lastInteractionAt = this.clock.now();
    this.idle = false;
    if (this.idleTimer === null) this.armIdleTimer();
  }

  private isEnded(): boolean {
    return this.status?.state === 'dormant' && this.status.endedReason === 'max-duration';
  }

  private shouldRun(): boolean {
    return this.running && this.visible && !this.idle && !this.isEnded();
  }

  /**
   * Brings the cadence in line with the inputs. Becoming engaged sends the one immediate request
   * when `immediate`; becoming not engaged cancels the cadence and anything in flight.
   */
  private sync(immediate: boolean): void {
    const run = this.shouldRun();
    if (run && this.cadenceTimer === null) {
      if (immediate) this.send(this.startSucceeded ? 'ping' : 'start', this.everSent);
      this.armCadence();
    } else if (!run && this.cadenceTimer !== null) {
      this.cancelCadence();
      this.abortInFlight();
      this.resuming = false;
    }
  }

  private send(kind: RequestKind, resuming: boolean, userInitiated = false): void {
    this.abortInFlight();
    if (userInitiated) this.restartFailed = false;
    const abort = new AbortController();
    const request: InFlight = { kind, abort, userInitiated };
    this.inFlight = request;
    this.everSent = true;
    this.resuming = resuming;

    const call = kind === 'start' ? this.api.start(abort.signal) : this.api.ping(abort.signal);
    call.then(
      (status) => this.onSuccess(request, status),
      (error: unknown) => this.onFailure(request, error),
    );
  }

  private onSuccess(request: InFlight, status: SessionStatus): void {
    if (this.inFlight !== request) return;
    this.inFlight = null;
    this.resuming = false;
    this.status = status;
    this.statusAt = this.clock.now();
    this.error = null;
    this.restartFailed = false;
    if (request.kind === 'start') this.startSucceeded = true;
    // A successful restart re-arms the cadence without another request; a session that just
    // ended disarms it.
    this.sync(false);
    this.commit();
  }

  private onFailure(request: InFlight, error: unknown): void {
    if (this.inFlight !== request || request.abort.signal.aborted) return;
    this.inFlight = null;
    this.resuming = false;
    this.error = error instanceof Error ? error : new Error(String(error));
    if (request.userInitiated) this.restartFailed = true;
    this.commit();
  }

  private abortInFlight(): void {
    this.inFlight?.abort.abort();
    this.inFlight = null;
  }

  private armCadence(): void {
    this.cadenceTimer = this.clock.setTimeout(() => {
      this.cadenceTimer = null;
      if (!this.shouldRun()) return;
      // The idle timer may not have run yet (a throttled or slept page fires overdue timers
      // late), so judge idleness from the clock rather than the cached flag.
      if (this.clock.now() - this.lastInteractionAt >= IDLE_TIMEOUT_MS) {
        this.abortInFlight();
        this.resuming = false;
        this.enterIdle();
        return;
      }
      this.armCadence();
      // Never stack on a request that has not answered yet.
      if (this.inFlight === null) {
        this.send(this.startSucceeded ? 'ping' : 'start', false);
        this.commit();
      }
    }, PING_INTERVAL_MS);
  }

  private cancelCadence(): void {
    if (this.cadenceTimer === null) return;
    this.clock.clearTimeout(this.cadenceTimer);
    this.cadenceTimer = null;
  }

  /** Fires at the earliest moment the page could have gone idle, and re-arms if it has not. */
  private armIdleTimer(): void {
    const remaining = this.lastInteractionAt + IDLE_TIMEOUT_MS - this.clock.now();
    this.idleTimer = this.clock.setTimeout(
      () => {
        this.idleTimer = null;
        if (!this.running) return;
        if (this.clock.now() - this.lastInteractionAt < IDLE_TIMEOUT_MS) {
          this.armIdleTimer();
          return;
        }
        this.enterIdle();
      },
      Math.max(0, remaining),
    );
  }

  private enterIdle(): void {
    this.idle = true;
    this.sync(false);
    this.commit();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private phase(): ActivityPhase {
    if (this.isEnded()) return 'ended';
    if (!this.visible) return 'paused-hidden';
    if (this.idle) return 'paused-idle';
    return this.startSucceeded ? 'engaged' : 'starting';
  }

  private buildSnapshot(): ActivitySnapshot {
    return {
      phase: this.phase(),
      status: this.status,
      statusAt: this.statusAt,
      error: this.error,
      resuming: this.resuming,
      restartFailed: this.restartFailed,
    };
  }

  private commit(): void {
    const next = this.buildSnapshot();
    const prev = this.snapshot;
    if (
      next.phase === prev.phase &&
      next.status === prev.status &&
      next.statusAt === prev.statusAt &&
      next.error === prev.error &&
      next.resuming === prev.resuming &&
      next.restartFailed === prev.restartFailed
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
