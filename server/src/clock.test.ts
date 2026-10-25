import { describe, expect, it } from 'vitest';
import { FakeClock, toEpochSeconds } from './clock.js';

describe('FakeClock', () => {
  it('fires timeouts and intervals in due order with now() at the due time', () => {
    const clock = new FakeClock(1_000);
    const fired: string[] = [];
    clock.setInterval(() => fired.push(`i@${clock.now()}`), 100);
    clock.setTimeout(() => fired.push(`t@${clock.now()}`), 150);
    const cancelled = clock.setTimeout(() => fired.push('never'), 120);
    clock.clearTimeout(cancelled);
    clock.advance(300);
    expect(fired).toEqual(['i@1100', 't@1150', 'i@1200', 'i@1300']);
    expect(clock.now()).toBe(1_300);
    expect(clock.pendingTimers()).toBe(1);
  });

  it('runs timers scheduled by timers within the same advance', () => {
    const clock = new FakeClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => clock.setTimeout(() => fired.push(clock.now()), 10), 10);
    clock.advance(25);
    expect(fired).toEqual([20]);
  });

  it('advanceAsync lets async work started by a timer settle', async () => {
    const clock = new FakeClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => void Promise.resolve().then(() => fired.push('async')), 10);
    await clock.advanceAsync(10);
    expect(fired).toEqual(['async']);
  });
});

describe('toEpochSeconds', () => {
  it('floors milliseconds to seconds', () => {
    expect(toEpochSeconds(1_700_000_000_999)).toBe(1_700_000_000);
  });
});
