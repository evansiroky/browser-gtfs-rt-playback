import type { SessionStatus } from '@gtfs-rt-debugger/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, settle, toEpochSeconds } from '../clock.js';
import { FeedPoller } from '../realtime/feed-poller.js';
import { decodeFeed, SnapshotStore } from '../realtime/snapshot-store.js';
import { captureLogger } from '../test-support/logger.js';
import { encodeFeed, serveBytes, startFeedHost, type FeedHost } from '../test-support/feeds.js';
import type { ScheduleProvider, ScheduleStatus } from './schedule-provider.js';
import { SessionManager } from './session-manager.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const IDLE = 15 * MINUTE;
const MAX = 120 * MINUTE;

class FakeSchedule implements ScheduleProvider {
  calls: string[] = [];
  state: ScheduleStatus = { state: 'idle', loadedAt: null, error: null };
  start() {
    this.calls.push('start');
    this.state = { state: 'loading', loadedAt: null, error: null };
  }
  retry() {
    this.calls.push('retry');
  }
  discard() {
    this.calls.push('discard');
    this.state = { state: 'idle', loadedAt: null, error: null };
  }
  status() {
    return this.state;
  }
}

let host: FeedHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

type PollerFactory = (store: SnapshotStore, clock: FakeClock) => FeedPoller[];

function setup({
  exitOnIdle = false,
  pollers,
}: { exitOnIdle?: boolean; pollers?: PollerFactory } = {}) {
  const clock = new FakeClock();
  const store = new SnapshotStore({
    clock,
    retentionMs: 60 * MINUTE,
    memoryLimitBytes: 10_000_000,
  });
  const schedule = new FakeSchedule();
  const onIdleExit = vi.fn();
  const session = new SessionManager({
    clock,
    logger: captureLogger([]),
    idleTimeoutMs: IDLE,
    maxActivationMs: MAX,
    exitOnIdle,
    store,
    schedule,
    pollers: pollers?.(store, clock) ?? [],
    onIdleExit,
  });
  /** Advances time, pinging every `everyMs` (the engaged web app pings every 10 s). */
  const pingFor = (durationMs: number, everyMs = 10 * SECOND) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += everyMs) {
      clock.advance(everyMs);
      session.ping();
    }
  };
  return { clock, store, schedule, session, onIdleExit, pingFor };
}

const dormant = (endedReason: SessionStatus['endedReason']): SessionStatus => ({
  state: 'dormant',
  endedReason,
  activatedAt: null,
  expiresAt: null,
  historyStartsAt: null,
  schedule: { state: 'idle', loadedAt: null, error: null },
  realtime: { vehiclePositions: null, tripUpdates: null },
});

describe('SessionManager', () => {
  it('begins dormant with no ending reason', () => {
    const { session } = setup();
    expect(session.status()).toEqual(dormant(null));
    expect(session.active).toBe(false);
  });

  it('wakes on start: activation times, schedule download begins', () => {
    const { clock, session, schedule } = setup();
    const status = session.start();
    expect(status).toEqual({
      state: 'active',
      endedReason: null,
      activatedAt: toEpochSeconds(clock.now()),
      expiresAt: toEpochSeconds(clock.now()) + MAX / SECOND,
      historyStartsAt: null,
      schedule: { state: 'loading', loadedAt: null, error: null },
      realtime: { vehiclePositions: null, tripUpdates: null },
    });
    expect(schedule.calls).toEqual(['start']);
  });

  it('wakes on ping when there was no max-duration end', () => {
    const { session, schedule } = setup();
    expect(session.ping().state).toBe('active');
    expect(schedule.calls).toEqual(['start']);
  });

  it('shares one activation between repeated and concurrent callers', () => {
    const { session, schedule, pingFor } = setup();
    const first = session.start();
    pingFor(30 * MINUTE);
    const later = session.start();
    expect(schedule.calls).toEqual(['start']);
    expect(later.activatedAt).toBe(first.activatedAt);
    // Maximum duration counts from the activation's start, not the latest arrival.
    expect(later.expiresAt).toBe(first.expiresAt);
  });

  it('retries a failed schedule on start (once per start), never on ping', () => {
    const { session, schedule } = setup();
    session.start();
    session.start(); // loading: nothing to retry
    schedule.state = { state: 'failed', loadedAt: null, error: { code: 'timeout', message: 'x' } };
    session.ping();
    expect(schedule.calls).toEqual(['start']);
    session.start();
    session.start();
    expect(schedule.calls).toEqual(['start', 'retry', 'retry']);
  });

  describe('idle shutdown', () => {
    it('forgets everything after 15 minutes without a ping, and stays up when exit-on-idle is off', () => {
      const { clock, session, schedule, store, onIdleExit } = setup();
      session.start();
      store.add('vehiclePositions', encodeFeed(), decodeFeed(encodeFeed()));
      clock.advance(IDLE - 1);
      expect(session.active).toBe(true);
      clock.advance(1);
      expect(session.status()).toEqual(dormant('idle'));
      expect(schedule.calls).toEqual(['start', 'discard']);
      expect(store.latest('vehiclePositions')).toBeNull();
      expect(onIdleExit).not.toHaveBeenCalled();
      expect(clock.pendingTimers()).toBe(0);
      // Still up: a ping wakes it again.
      expect(session.ping().state).toBe('active');
    });

    it('exits after forgetting when exit-on-idle is on, and never wakes again', () => {
      const { clock, session, schedule, onIdleExit } = setup({ exitOnIdle: true });
      session.start();
      clock.advance(IDLE);
      expect(schedule.calls).toEqual(['start', 'discard']);
      expect(onIdleExit).toHaveBeenCalledTimes(1);
      // A request racing the exit is answered dormant without starting anything.
      expect(session.start().state).toBe('dormant');
      expect(schedule.calls).toEqual(['start', 'discard']);
      clock.advance(10 * IDLE);
      expect(onIdleExit).toHaveBeenCalledTimes(1);
      expect(clock.pendingTimers()).toBe(0);
    });

    it('pings and starts reset the inactivity timer', () => {
      const { clock, session, onIdleExit } = setup({ exitOnIdle: true });
      session.start();
      clock.advance(14 * MINUTE);
      session.ping();
      clock.advance(14 * MINUTE);
      session.start();
      clock.advance(IDLE - 1);
      expect(onIdleExit).not.toHaveBeenCalled();
      expect(session.active).toBe(true);
      clock.advance(1);
      expect(onIdleExit).toHaveBeenCalledTimes(1);
    });

    it('also runs from process start, so a process with no session requests exits', () => {
      const { clock, onIdleExit, schedule } = setup({ exitOnIdle: true });
      clock.advance(IDLE);
      expect(onIdleExit).toHaveBeenCalledTimes(1);
      expect(schedule.calls).toEqual([]);
    });
  });

  describe('maximum duration', () => {
    it('ends the activation at 2 h despite pings; the process stays up and pings do not rewake', () => {
      const { clock, session, schedule, store, onIdleExit, pingFor } = setup({ exitOnIdle: true });
      session.start();
      store.add('tripUpdates', encodeFeed(), decodeFeed(encodeFeed()));
      pingFor(MAX - 10 * SECOND);
      expect(session.active).toBe(true);
      clock.advance(10 * SECOND);
      expect(session.status()).toEqual(dormant('max-duration'));
      expect(schedule.calls).toEqual(['start', 'discard']);
      expect(store.latest('tripUpdates')).toBeNull();

      // Pings keep arriving for hours: still dormant, still locked, and still not shut down,
      // because pings reset the inactivity timer while dormant too.
      pingFor(3 * 60 * MINUTE);
      expect(session.ping()).toEqual(dormant('max-duration'));
      expect(schedule.calls).toEqual(['start', 'discard']);
      expect(onIdleExit).not.toHaveBeenCalled();

      // When pings stop, the idle timeout shuts the process down.
      clock.advance(IDLE);
      expect(onIdleExit).toHaveBeenCalledTimes(1);
    });

    it('start clears the lock and begins a fresh activation', () => {
      const { clock, session, schedule, pingFor } = setup();
      session.start();
      pingFor(MAX);
      expect(session.status().endedReason).toBe('max-duration');
      clock.advance(MINUTE);
      const status = session.start();
      expect(status.state).toBe('active');
      expect(status.endedReason).toBeNull();
      expect(status.activatedAt).toBe(toEpochSeconds(clock.now()));
      expect(schedule.calls).toEqual(['start', 'discard', 'start']);
    });

    it('an idle shutdown with exit-on-idle off clears the lock', () => {
      const { clock, session, pingFor } = setup();
      session.start();
      pingFor(MAX);
      expect(session.status().endedReason).toBe('max-duration');
      clock.advance(IDLE);
      expect(session.status()).toEqual(dormant(null));
      expect(session.ping().state).toBe('active');
    });
  });

  it('polls realtime feeds only while active and reports their status and history start', async () => {
    host = await startFeedHost();
    const feedHost = host;
    feedHost.route('/vp', serveBytes(encodeFeed({ timestamp: 1_768_478_000 })));
    const { clock, session } = setup({
      pollers: (store, clock) => [
        new FeedPoller({
          feed: 'vehiclePositions',
          url: feedHost.url('/vp'),
          clock,
          store,
          logger: captureLogger([]),
          intervalMs: 10 * SECOND,
          timeoutMs: 8 * SECOND,
          maxBytes: 1_000_000,
        }),
      ],
    });
    await clock.advanceAsync(MINUTE);
    expect(feedHost.requests).toEqual([]);

    const started = clock.now();
    session.start();
    await vi.waitFor(() => expect(session.status().historyStartsAt).not.toBeNull());
    expect(session.status()).toMatchObject({
      historyStartsAt: toEpochSeconds(started),
      realtime: {
        vehiclePositions: {
          lastSuccessAt: toEpochSeconds(started),
          feedTimestamp: 1_768_478_000,
          stale: false,
        },
        tripUpdates: null,
      },
    });

    clock.advance(IDLE);
    expect(session.status()).toEqual(dormant('idle'));
    await settle();
    const requests = feedHost.requests.length;
    await clock.advanceAsync(5 * MINUTE);
    expect(feedHost.requests).toHaveLength(requests);
  });
});
