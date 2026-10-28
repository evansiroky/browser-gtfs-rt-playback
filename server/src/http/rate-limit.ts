import { isIPv6 } from 'node:net';
import type { Clock } from '../clock.js';

const WINDOW_MS = 60_000;
/** Bound on tracked clients, so a flood of distinct addresses cannot grow memory unboundedly. */
export const MAX_TRACKED_CLIENTS = 10_000;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Window {
  startedAt: number;
  count: number;
}

/**
 * The rate-limit key for a client address: IPv4 as is (also when IPv4-mapped), IPv6 by its /64
 * prefix, since one client typically controls a whole /64.
 */
export function clientKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head = '', tail = ''] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Per-client fixed one-minute windows: each client may make `limitPerMinute` requests in the
 * minute that starts with its first request.
 *
 * At most {@link MAX_TRACKED_CLIENTS} live windows are kept. Expired windows are dropped lazily,
 * oldest first (the map's insertion order is window start order, so the sweep stops at the first
 * live window: amortized O(1) per request). When every slot holds a live window, a new client
 * shares one overflow window with all other overflow clients instead of evicting anyone, so a
 * flood of fresh addresses can never reset an already-limited client's count; during such a
 * flood new clients are limited together, which errs on the side of cost.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #windows = new Map<string, Window>();
  #overflow: Window | null = null;

  constructor(clock: Clock, limitPerMinute: number) {
    this.#clock = clock;
    this.#limit = limitPerMinute;
  }

  hit(address: string): RateLimitResult {
    const now = this.#clock.now();
    const key = clientKey(address);
    let window = this.#windows.get(key);
    if (window && now - window.startedAt >= WINDOW_MS) {
      this.#windows.delete(key);
      window = undefined;
    }
    if (!window) {
      this.#sweep(now);
      if (this.#windows.size < MAX_TRACKED_CLIENTS) {
        window = { startedAt: now, count: 0 };
        this.#windows.set(key, window);
      } else {
        if (!this.#overflow || now - this.#overflow.startedAt >= WINDOW_MS) {
          this.#overflow = { startedAt: now, count: 0 };
        }
        window = this.#overflow;
      }
    }
    window.count++;
    if (window.count <= this.#limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000)),
    };
  }

  /** Number of clients with their own window. */
  get tracked(): number {
    return this.#windows.size;
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt < WINDOW_MS) return;
      this.#windows.delete(key);
    }
  }
}
