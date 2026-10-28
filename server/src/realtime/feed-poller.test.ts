import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, toEpochSeconds } from '../clock.js';
import { captureLogger, logEntries } from '../test-support/logger.js';
import { encodeFeed, startFeedHost, type FeedHost } from '../test-support/feeds.js';
import { FeedPoller } from './feed-poller.js';
import { SnapshotStore } from './snapshot-store.js';

const INTERVAL = 10_000;
const SECRET_PATH = '/vp?api_key=SUPERSECRET123';

let host: FeedHost;
let clock: FakeClock;
let store: SnapshotStore;
let logs: string[];
let poller: FeedPoller;
/** Clock times (ms since start) at which the feed host received a request. */
let hits: number[];
let start: number;
/** Snapshots added to the store so far. */
let snapshots: number;

function respondWith(handler: (res: ServerResponse) => void) {
  host.route('/vp', (_req, res) => {
    hits.push(clock.now() - start);
    handler(res);
  });
}

const ok =
  (bytes = encodeFeed()) =>
  (res: ServerResponse) =>
    void res.writeHead(200).end(bytes);

beforeEach(async () => {
  host = await startFeedHost();
  clock = new FakeClock();
  start = clock.now();
  logs = [];
  store = new SnapshotStore({
    clock,
    logger: captureLogger(logs),
    retentionMs: 3_600_000,
    memoryLimitBytes: 10_000_000,
  });
  hits = [];
  snapshots = 0;
  store.onSnapshot(() => snapshots++);
  poller = makePoller();
});

function makePoller(timeoutMs = 8_000): FeedPoller {
  return new FeedPoller({
    feed: 'vehiclePositions',
    url: host.url(SECRET_PATH),
    clock,
    store,
    logger: captureLogger(logs),
    intervalMs: INTERVAL,
    timeoutMs,
    maxBytes: 5_000,
  });
}

afterEach(async () => {
  poller.stop();
  await host.close();
});

// These wait in real time for local I/O to finish; the fake clock only moves when told to.
const settled = (count: number) => vi.waitFor(() => expect(snapshots).toBe(count));
const failed = (code: string) => vi.waitFor(() => expect(poller.status()?.error?.code).toBe(code));

describe('FeedPoller', () => {
  it('fetches immediately at start, then on a fixed cadence', async () => {
    respondWith(ok());
    poller.start();
    await settled(1);
    for (let i = 0; i < 3; i++) {
      await clock.advanceAsync(INTERVAL);
      await settled(i + 2);
    }
    expect(hits).toEqual([0, 10_000, 20_000, 30_000]);
    expect(store.all('vehiclePositions')).toHaveLength(4);
  });

  it('skips (does not queue) a tick while the previous fetch is in flight, keeping the cadence', async () => {
    // A timeout longer than the interval lets a fetch still be in flight at the next tick.
    poller = makePoller(15_000);
    let release: (() => void) | undefined;
    respondWith((res) => {
      if (hits.length === 1) release = () => ok()(res);
      else ok()(res);
    });
    poller.start();
    await vi.waitFor(() => expect(release).toBeDefined());
    await clock.advanceAsync(INTERVAL); // in flight: skipped
    await clock.advanceAsync(4_000);
    release?.();
    await settled(1);
    await clock.advanceAsync(6_000); // the 20 s tick, not one queued at 14 s
    await settled(2);
    expect(hits).toEqual([0, 20_000]);
  });

  it('records success: attempt and success times, header timestamp, no error', async () => {
    respondWith(ok(encodeFeed({ timestamp: 1_768_478_000 })));
    poller.start();
    await settled(1);
    expect(poller.status()).toEqual({
      lastAttemptAt: toEpochSeconds(start),
      lastSuccessAt: toEpochSeconds(start),
      feedTimestamp: 1_768_478_000,
      stale: false,
      error: null,
    });
  });

  it('accepts a gzip-encoded feed', async () => {
    respondWith((res) =>
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(encodeFeed())),
    );
    poller.start();
    await settled(1);
    expect(store.latest('vehiclePositions')?.decode().entity).toHaveLength(1);
  });

  it('times out a slow fetch', async () => {
    respondWith(() => {});
    poller.start();
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    await clock.advanceAsync(8_000);
    await failed('timeout');
    expect(poller.status()?.lastAttemptAt).toBe(toEpochSeconds(start));
    expect(poller.status()?.lastSuccessAt).toBeNull();
  });

  it('fails an oversize response with too_large', async () => {
    respondWith(ok(encodeFeed({ padding: 6_000 })));
    poller.start();
    await failed('too_large');
    expect(store.latest('vehiclePositions')).toBeNull();
  });

  it('fails a garbage body with decode_failed, keeping the last good snapshot until a success clears the error', async () => {
    const good = encodeFeed({ timestamp: 1_768_478_000 });
    let body: Uint8Array = good;
    respondWith((res) => ok(body)(res));
    poller.start();
    await settled(1);
    const lastGood = store.latest('vehiclePositions');

    body = new TextEncoder().encode('<html>not a protobuf</html>');
    await clock.advanceAsync(INTERVAL);
    await failed('decode_failed');
    expect(store.latest('vehiclePositions')).toBe(lastGood);
    expect(poller.status()).toMatchObject({
      lastAttemptAt: toEpochSeconds(start + INTERVAL),
      lastSuccessAt: toEpochSeconds(start),
      feedTimestamp: 1_768_478_000,
    });

    respondWith((res) => res.writeHead(500).end());
    await clock.advanceAsync(INTERVAL);
    await failed('http_status_500');

    body = encodeFeed({ timestamp: 1_768_478_100 });
    respondWith((res) => ok(body)(res));
    await clock.advanceAsync(INTERVAL);
    await settled(2);
    expect(poller.status()).toMatchObject({ error: null, feedTimestamp: 1_768_478_100 });
  });

  it('is stale once the latest success is older than three poll intervals', async () => {
    respondWith(ok());
    poller.start();
    await settled(1);
    respondWith((res) => res.writeHead(503).end());
    await clock.advanceAsync(3 * INTERVAL);
    await failed('http_status_503');
    expect(poller.status()?.stale).toBe(false);
    await clock.advanceAsync(1);
    expect(poller.status()?.stale).toBe(true);
  });

  it('is stale when it never succeeds for three intervals', async () => {
    respondWith((res) => res.writeHead(503).end());
    poller.start();
    await failed('http_status_503');
    await clock.advanceAsync(3 * INTERVAL + 1);
    expect(poller.status()?.stale).toBe(true);
  });

  it('polls nothing while stopped and discards an in-flight fetch at stop', async () => {
    let release: (() => void) | undefined;
    respondWith((res) => (release = () => ok()(res)));
    expect(poller.status()).toBeNull();
    await clock.advanceAsync(5 * INTERVAL);
    expect(hits).toEqual([]);

    poller.start();
    await vi.waitFor(() => expect(release).toBeDefined());
    poller.stop();
    release?.();
    await clock.advanceAsync(5 * INTERVAL);
    expect(hits).toHaveLength(1);
    expect(store.latest('vehiclePositions')).toBeNull();
    expect(poller.status()).toBeNull();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('never puts the feed URL or its query string in status or logs', async () => {
    const failures: Array<(res: ServerResponse) => void> = [
      (res) => res.writeHead(404).end(),
      ok(new TextEncoder().encode('garbage')),
      ok(encodeFeed({ padding: 6_000 })),
      (res) => res.writeHead(302, { location: 'ftp://elsewhere/?api_key=SUPERSECRET123' }).end(),
    ];
    poller.start();
    const statuses: string[] = [];
    for (const handler of failures) {
      respondWith(handler);
      await clock.advanceAsync(INTERVAL);
      await vi.waitFor(() =>
        expect(poller.status()?.lastAttemptAt).toBe(toEpochSeconds(clock.now())),
      );
      await vi.waitFor(() => expect(poller.status()?.error).not.toBeNull());
      statuses.push(JSON.stringify(poller.status()));
    }
    const output = [...statuses, ...logs].join('\n');
    expect(logs.length).toBeGreaterThanOrEqual(4);
    for (const secret of [host.origin, '127.0.0.1', 'SUPERSECRET123', 'api_key', '/vp']) {
      expect(output).not.toContain(secret);
    }
  });

  it('contains failures after a successful fetch: no unhandled rejection, polling continues', async () => {
    const rejections: unknown[] = [];
    const previous = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => rejections.push(reason));
    try {
      respondWith(ok());
      store.onSnapshot(() => {
        throw new Error('listener bug');
      });
      const add = store.add.bind(store);
      let calls = 0;
      store.add = (...args) => {
        if (++calls === 2) throw new Error('store bug');
        return add(...args);
      };
      poller.start();
      await settled(1);
      await clock.advanceAsync(INTERVAL);
      await vi.waitFor(() => expect(logs.join('\n')).toContain('realtime poll failed'));
      await clock.advanceAsync(INTERVAL);
      await settled(2);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of previous) process.on('unhandledRejection', listener);
    }
    expect(rejections).toEqual([]);
    expect(hits).toEqual([0, 10_000, 20_000]);
  });
});

describe('logging', () => {
  const messages = () => logEntries(logs).map((entry) => entry['msg']);

  it('logs the fetch and the parse of a poll', async () => {
    respondWith(ok(encodeFeed({ timestamp: 1_768_478_000, vehicles: 3 })));
    poller.start();
    await settled(1);
    expect(messages()).toEqual([
      'fetch started',
      'fetch completed',
      'realtime parse started',
      'realtime parse succeeded',
    ]);
    const entries = logEntries(logs);
    expect(entries[0]).toMatchObject({ feed: 'vehiclePositions' });
    expect(entries[1]).toMatchObject({ feed: 'vehiclePositions', status: 200 });
    expect(entries[2]).toMatchObject({ feed: 'vehiclePositions' });
    expect(entries[3]).toMatchObject({
      feed: 'vehiclePositions',
      entities: 3,
      feedTimestamp: 1_768_478_000,
    });
  });

  it('logs a failed fetch with its code and no parse', async () => {
    respondWith((res) => void res.writeHead(404).end());
    poller.start();
    await failed('http_status_404');
    expect(messages()).toEqual(['fetch started', 'fetch failed']);
    expect(logEntries(logs)[1]).toMatchObject({ code: 'http_status_404', level: 40 });
  });

  it('logs a body that cannot be decoded as a failed parse', async () => {
    respondWith(ok(new TextEncoder().encode('garbage')));
    poller.start();
    await failed('decode_failed');
    expect(messages()).toEqual([
      'fetch started',
      'fetch completed',
      'realtime parse started',
      'realtime parse failed',
    ]);
    expect(logEntries(logs)[3]).toMatchObject({ feed: 'vehiclePositions', code: 'decode_failed' });
  });
});
