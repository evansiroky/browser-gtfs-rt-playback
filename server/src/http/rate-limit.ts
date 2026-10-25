import type { Clock } from '../clock.js';

const WINDOW_MS = 60_000;
/** Bound on tracked addresses, so a flood of distinct addresses cannot grow memory unboundedly. */
const MAX_TRACKED = 10_000;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Per-address fixed one-minute windows: each address may make `limitPerMinute` requests in the
 * minute that starts with its first request.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(clock: Clock, limitPerMinute: number) {
    this.#clock = clock;
    this.#limit = limitPerMinute;
  }

  hit(address: string): RateLimitResult {
    const now = this.#clock.now();
    let window = this.#windows.get(address);
    if (!window || now - window.startedAt >= WINDOW_MS) {
      if (window) this.#windows.delete(address);
      else if (this.#windows.size >= MAX_TRACKED) this.#evict(now);
      window = { startedAt: now, count: 0 };
      this.#windows.set(address, window);
    }
    window.count++;
    if (window.count <= this.#limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000)),
    };
  }

  /** Drops expired windows; if none have expired, the oldest (insertion order is start order). */
  #evict(now: number): void {
    for (const [address, window] of this.#windows) {
      if (now - window.startedAt >= WINDOW_MS) this.#windows.delete(address);
    }
    if (this.#windows.size >= MAX_TRACKED) {
      const oldest = this.#windows.keys().next();
      if (!oldest.done) this.#windows.delete(oldest.value);
    }
  }
}
