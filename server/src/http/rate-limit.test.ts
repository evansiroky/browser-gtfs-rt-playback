import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { clientKey, MAX_TRACKED_CLIENTS, RateLimiter } from './rate-limit.js';

describe('clientKey', () => {
  it('keys IPv4 (also IPv4-mapped) by address and IPv6 by /64', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2::1')).toBe(clientKey('2001:0db8:0001:0002:ffff::9'));
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
  });
});

describe('RateLimiter', () => {
  it('allows the limit per minute, then reports seconds until the window ends', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock, 2);
    expect(limiter.hit('a')).toEqual({ allowed: true });
    clock.advance(15_000);
    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 45 });
    clock.advance(45_000);
    expect(limiter.hit('a')).toEqual({ allowed: true });
  });

  it('limits all addresses of one IPv6 /64 together', () => {
    const limiter = new RateLimiter(new FakeClock(), 2);
    limiter.hit('2001:db8:1:2::1');
    limiter.hit('2001:db8:1:2::2');
    expect(limiter.hit('2001:db8:1:2:ffff::3').allowed).toBe(false);
    expect(limiter.hit('2001:db8:1:3::1').allowed).toBe(true);
  });

  it('a flood of new addresses neither resets a limited client nor slows down', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock, 3);
    for (let i = 0; i < 4; i++) limiter.hit('198.51.100.1');
    expect(limiter.hit('198.51.100.1').allowed).toBe(false);

    const started = performance.now();
    for (let i = 0; i < 1_000_000; i++)
      limiter.hit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(10_000);

    expect(limiter.tracked).toBe(MAX_TRACKED_CLIENTS);
    expect(limiter.hit('198.51.100.1').allowed).toBe(false);
    // Overflow clients share one window, which the flood has long exhausted.
    expect(limiter.hit('203.0.113.77').allowed).toBe(false);

    // Once windows expire, slots free up again for real clients.
    clock.advance(60_000);
    expect(limiter.hit('203.0.113.77').allowed).toBe(true);
    expect(limiter.hit('198.51.100.1').allowed).toBe(true);
  });
});
