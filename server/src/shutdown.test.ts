import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeThenExit, DRAIN_DEADLINE_MS, installCrashPolicy } from './shutdown.js';
import { captureLogger } from './test-support/logger.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('closeThenExit', () => {
  it('exits once the server has closed', async () => {
    const exit = vi.fn();
    closeThenExit({ close: () => Promise.resolve() }, exit);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it('exits at the deadline when closing hangs, and only once', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    let finishClose: () => void = () => {};
    closeThenExit({ close: () => new Promise<void>((resolve) => (finishClose = resolve)) }, exit);
    vi.advanceTimersByTime(DRAIN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    finishClose();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits when closing fails', async () => {
    const exit = vi.fn();
    closeThenExit({ close: () => Promise.reject(new Error('close failed')) }, exit);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });
});

describe('installCrashPolicy', () => {
  it.each(['unhandledRejection', 'uncaughtException'])('logs and exits 1 on %s', (event) => {
    const target = new EventEmitter();
    const logs: string[] = [];
    const exit = vi.fn();
    installCrashPolicy(target, captureLogger(logs), exit);
    target.emit(event, new Error('boom'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.join('\n')).toContain(event);
  });
});
