/**
 * The only source of time and timers in the server. Every timer (poll cadence, fetch timeouts,
 * inactivity and maximum-duration timers, the schedule retry delay) goes through a `Clock`, so
 * tests drive time with {@link FakeClock} instead of sleeping.
 *
 * All instants inside the server are Unix epoch **milliseconds**; conversion to the API's epoch
 * seconds happens only when a response is built ({@link toEpochSeconds}).
 */
export interface Clock {
  /** Current instant, epoch milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
  /** Fires every `intervalMs` from now; a slow callback does not shift later ticks. */
  setInterval(callback: () => void, intervalMs: number): Timer;
  clearInterval(timer: Timer): void;
}

/** Opaque timer handle; only meaningful to the clock that created it. */
export type Timer = { readonly __timer: unique symbol };

export function toEpochSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as Timer,
  clearTimeout: (timer) => clearTimeout(timer as unknown as NodeJS.Timeout),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs) as unknown as Timer,
  clearInterval: (timer) => clearInterval(timer as unknown as NodeJS.Timeout),
};

interface FakeTimer {
  id: number;
  due: number;
  interval: number | null;
  callback: () => void;
}

/**
 * Deterministic clock for tests. Time only moves when {@link advance} or {@link advanceAsync} is
 * called; due timers then fire in due order (ties in creation order), each with `now()` equal to
 * its due time.
 */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, FakeTimer>();

  constructor(startMs = Date.UTC(2026, 0, 15, 12, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): Timer {
    return this.#add(callback, delayMs, null);
  }

  setInterval(callback: () => void, intervalMs: number): Timer {
    return this.#add(callback, intervalMs, Math.max(1, intervalMs));
  }

  clearTimeout(timer: Timer): void {
    this.#timers.delete(timer as unknown as number);
  }

  clearInterval(timer: Timer): void {
    this.#timers.delete(timer as unknown as number);
  }

  /** Number of scheduled timers (intervals count once). */
  pendingTimers(): number {
    return this.#timers.size;
  }

  /** Moves time forward by `ms`, firing due timers synchronously. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (let timer = this.#nextDue(target); timer; timer = this.#nextDue(target)) {
      this.#fire(timer);
    }
    this.#now = target;
  }

  /**
   * Like {@link advance}, but lets pending promise callbacks and I/O settle before and after each
   * timer fires, so async work started by one timer can complete before the next one fires.
   */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.#now + ms;
    await settle();
    for (let timer = this.#nextDue(target); timer; timer = this.#nextDue(target)) {
      this.#fire(timer);
      await settle();
    }
    this.#now = target;
  }

  #add(callback: () => void, delayMs: number, interval: number | null): Timer {
    const id = this.#nextId++;
    this.#timers.set(id, { id, due: this.#now + Math.max(0, delayMs), interval, callback });
    return id as unknown as Timer;
  }

  #nextDue(target: number): FakeTimer | undefined {
    let next: FakeTimer | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.due <= target && (!next || timer.due < next.due)) next = timer;
    }
    return next;
  }

  #fire(timer: FakeTimer): void {
    this.#now = timer.due;
    if (timer.interval === null) this.#timers.delete(timer.id);
    else timer.due += timer.interval;
    timer.callback();
  }
}

/** Lets queued microtasks and already-completed I/O callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
