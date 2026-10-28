import type { ServerResponse } from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import { scenario } from '@gtfs-rt-debugger/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, toEpochSeconds } from '../clock.js';
import type { Env } from '../config.js';
import { startFeedHost, testConfig, type FeedHost } from '../test-support/feeds.js';
import { captureLogger, logEntries } from '../test-support/logger.js';
import { miniSchedule, zipOf } from '../test-support/zip.js';
import {
  DECOMPRESSION_FACTOR,
  RETRY_DELAY_MS,
  ScheduleLoader,
  type LoadSchedule,
} from './loader.js';
import type { ScheduleStore } from './store.js';

v8.setFlagsFromString('--expose-gc');
const collectGarbage = vm.runInNewContext('gc') as () => void;

const SECRET_PATH = '/schedule.zip?api_key=SUPERSECRET123';
const NOW = new Date('2026-10-14T19:07:42Z');
const fixtureZip = scenario(NOW).scheduleZip;

let host: FeedHost;
let clock: FakeClock;
let logs: string[];
let loader: ScheduleLoader;

const serveZip =
  (bytes: Uint8Array = fixtureZip) =>
  (res: ServerResponse) =>
    void res.writeHead(200, { 'content-type': 'application/zip' }).end(bytes);

/** The schedule host's requests so far (the path, including the secret query). */
const downloads = () => host.requests.filter((url) => url.startsWith('/schedule.zip'));

function makeLoader(env: Env = {}, load?: LoadSchedule): ScheduleLoader {
  const config = testConfig({ SCHEDULE_URL: `${host.origin}${SECRET_PATH}`, ...env });
  return new ScheduleLoader({ config, clock, logger: captureLogger(logs), load });
}

const state = () => loader.status().state;
const untilState = (expected: string, timeout = 1_000) =>
  vi.waitFor(() => expect(state()).toBe(expected), { timeout });

beforeEach(async () => {
  host = await startFeedHost();
  clock = new FakeClock();
  logs = [];
  host.route('/schedule.zip', (_req, res) => serveZip()(res));
  loader = makeLoader();
});

afterEach(async () => {
  loader.discard();
  await host.close();
});

describe('a successful load', () => {
  it('logs the download and the parse of a load, never the URL', async () => {
    loader.start();
    await untilState('ready');
    const entries = logEntries(logs);
    const messages = entries.map((entry) => entry['msg']);
    expect(messages.slice(0, 2)).toEqual(['fetch started', 'fetch completed']);
    expect(entries[0]).toMatchObject({ feed: 'schedule' });
    expect(messages.slice(2, 4)).toEqual(['schedule parse started', 'schedule archive opened']);
    expect(messages).toContain('schedule file read succeeded');
    expect(messages.slice(-2)).toEqual(['schedule parse succeeded', 'schedule loaded']);
    expect(logs.join('\n')).not.toMatch(/SUPERSECRET123|api_key|127\.0\.0\.1/);
  });

  it('goes idle, loading, ready with loadedAt, and serves the store', async () => {
    expect(loader.status()).toEqual({ state: 'idle', loadedAt: null, error: null });
    expect(loader.store).toBeNull();
    loader.start();
    expect(loader.status()).toEqual({ state: 'loading', loadedAt: null, error: null });
    await untilState('ready');
    expect(loader.status()).toEqual({
      state: 'ready',
      loadedAt: toEpochSeconds(clock.now()),
      error: null,
    });
    expect(loader.store?.agency().names).toEqual(['Fixture Transit', 'Fixture Express']);
  });

  it('downloads exactly once per activation, however often start, retry and time pass', async () => {
    loader.start();
    loader.start();
    loader.retry();
    loader.start();
    await untilState('ready');
    loader.start();
    loader.retry();
    await clock.advanceAsync(2 * 60 * 60 * 1000);
    loader.start();
    expect(downloads()).toHaveLength(1);
    expect(state()).toBe('ready');
    expect(clock.pendingTimers()).toBe(0);
  });

  it('downloads again for the next activation, after a discard', async () => {
    loader.start();
    await untilState('ready');
    loader.discard();
    loader.start();
    await untilState('ready');
    expect(downloads()).toHaveLength(2);
  });
});

describe('failures', () => {
  it('reports an HTTP error status by code and retries once after 30 s on the clock', async () => {
    host.route('/schedule.zip', (_req, res) => void res.writeHead(404).end());
    loader.start();
    await untilState('failed');
    expect(loader.status()).toMatchObject({
      state: 'failed',
      loadedAt: null,
      error: { code: 'http_status_404' },
    });
    expect(loader.store).toBeNull();
    expect(downloads()).toHaveLength(1);

    await clock.advanceAsync(29_999); // feed-ingest.md: 30 s
    expect(downloads()).toHaveLength(1);
    host.route('/schedule.zip', (_req, res) => serveZip()(res));
    await clock.advanceAsync(1);
    expect(loader.status()).toMatchObject({ state: 'loading', error: null });
    await untilState('ready');
    expect(downloads()).toHaveLength(2);
    expect(loader.store).not.toBeNull();
  });

  it('stays failed after the automatic retry fails, until a start retries it', async () => {
    host.route('/schedule.zip', (_req, res) => void res.writeHead(503).end());
    loader.start();
    await untilState('failed');
    await clock.advanceAsync(RETRY_DELAY_MS);
    await vi.waitFor(() => expect(downloads()).toHaveLength(2));
    await untilState('failed');
    expect(loader.status().error?.code).toBe('http_status_503');

    await clock.advanceAsync(24 * 60 * 60 * 1000);
    loader.start(); // not a retry: only a session start while failed is, via retry()
    expect(downloads()).toHaveLength(2);
    expect(state()).toBe('failed');

    host.route('/schedule.zip', (_req, res) => serveZip()(res));
    loader.retry();
    expect(state()).toBe('loading');
    await untilState('ready');
    expect(downloads()).toHaveLength(3);
  });

  it('gives a load started by retry its own single automatic retry', async () => {
    host.route('/schedule.zip', (_req, res) => void res.writeHead(500).end());
    loader.start();
    await untilState('failed');
    await clock.advanceAsync(RETRY_DELAY_MS);
    await vi.waitFor(() => expect(downloads()).toHaveLength(2));
    await untilState('failed');
    loader.retry();
    await vi.waitFor(() => expect(downloads()).toHaveLength(3));
    await untilState('failed');
    await clock.advanceAsync(RETRY_DELAY_MS);
    await vi.waitFor(() => expect(downloads()).toHaveLength(4));
    await untilState('failed');
    await clock.advanceAsync(RETRY_DELAY_MS * 10);
    expect(downloads()).toHaveLength(4);
  });

  it('a retry during the wait loads at once and cancels the pending automatic retry', async () => {
    host.route('/schedule.zip', (_req, res) => void res.writeHead(500).end());
    loader.start();
    await untilState('failed');
    host.route('/schedule.zip', (_req, res) => serveZip()(res));
    loader.retry();
    await untilState('ready');
    await clock.advanceAsync(RETRY_DELAY_MS * 2);
    expect(downloads()).toHaveLength(2);
  });

  it('does nothing on retry unless the schedule has failed', async () => {
    loader.retry();
    expect(state()).toBe('idle');
    expect(downloads()).toHaveLength(0);
  });

  it('times out on the injected clock with the code timeout', async () => {
    loader = makeLoader({ SCHEDULE_TIMEOUT_MS: '5000' });
    host.route('/schedule.zip', () => undefined);
    loader.start();
    await vi.waitFor(() => expect(downloads()).toHaveLength(1));
    await clock.advanceAsync(4_999);
    expect(state()).toBe('loading');
    await clock.advanceAsync(1);
    await untilState('failed');
    expect(loader.status().error).toMatchObject({ code: 'timeout' });
  });

  it('rejects a body over the download limit with too_large', async () => {
    loader = makeLoader({ SCHEDULE_MAX_BYTES: String(fixtureZip.byteLength - 1) });
    loader.start();
    await untilState('failed');
    expect(loader.status().error).toMatchObject({ code: 'too_large' });
    // And accepts one of exactly the limit.
    loader.discard();
    loader = makeLoader({ SCHEDULE_MAX_BYTES: String(fixtureZip.byteLength) });
    loader.start();
    await untilState('ready');
  });

  it('fails with too_large when the archive inflates past the multiple of the download limit', async () => {
    const trips = 'route_id,service_id,trip_id\n' + 'R1,WK,T1\n'.repeat(400_000); // 3.6 MB of text
    const zip = zipOf(miniSchedule({ 'trips.txt': trips }));
    expect(zip.byteLength * DECOMPRESSION_FACTOR).toBeLessThan(3_600_000);
    host.route('/schedule.zip', (_req, res) => serveZip(zip)(res));
    loader = makeLoader({ SCHEDULE_MAX_BYTES: String(zip.byteLength) });
    loader.start();
    await untilState('failed', 15_000);
    expect(loader.status().error).toMatchObject({ code: 'too_large' });
    expect(loader.status().error?.message).not.toMatch(/https?:|\.zip|127\.0/);
    // The same archive loads when the limit leaves room to inflate it.
    loader.discard();
    loader = makeLoader({
      SCHEDULE_MAX_BYTES: String(Math.ceil(3_700_000 / DECOMPRESSION_FACTOR)),
    });
    loader.start();
    await untilState('ready', 15_000);
  }, 30_000);

  it('fails with too_large when the decoded schedule exceeds the memory limit', async () => {
    loader = makeLoader({ SCHEDULE_MEMORY_LIMIT_BYTES: '10000' });
    loader.start();
    await untilState('failed');
    expect(loader.status().error).toMatchObject({ code: 'too_large' });
    expect(loader.store).toBeNull();
  });

  it.each([
    [
      'a missing required file',
      zipOf(miniSchedule({ 'trips.txt': null })),
      'missing_file',
      'trips.txt',
    ],
    [
      'a malformed CSV',
      zipOf(miniSchedule({ 'routes.txt': 'route_id\n"open\n' })),
      'bad_csv',
      'routes.txt',
    ],
    ['a body that is not a zip', new TextEncoder().encode('<html>oops</html>'), 'bad_zip', ''],
  ])('reports %s by code', async (_label, body, code, fragment) => {
    host.route('/schedule.zip', (_req, res) => serveZip(body)(res));
    loader.start();
    await untilState('failed');
    const error = loader.status().error;
    expect(error?.code).toBe(code);
    expect(error?.message).toContain(fragment);
  });

  it('never puts the feed URL or its query string in status or logs', async () => {
    const failures: Array<(res: ServerResponse) => void> = [
      (res) => res.writeHead(404).end(),
      (res) => res.writeHead(302, { location: 'ftp://elsewhere/?api_key=SUPERSECRET123' }).end(),
      (res) => res.destroy(),
      serveZip(new TextEncoder().encode('garbage garbage')),
      serveZip(zipOf(miniSchedule({ 'agency.txt': null }))),
      serveZip(zipOf(miniSchedule({ 'routes.txt': 'route_id\n"open\n' }))),
      serveZip(
        zipOf(miniSchedule({ 'agency.txt': 'agency_name,agency_timezone\nA,Nowhere/Land\n' })),
      ),
    ];
    const statuses: string[] = [];
    for (const handler of failures) {
      host.route('/schedule.zip', (_req, res) => handler(res));
      loader.discard();
      loader.start();
      await untilState('failed');
      statuses.push(JSON.stringify(loader.status()));
    }
    const tight = makeLoader({ SCHEDULE_MEMORY_LIMIT_BYTES: '10000' });
    host.route('/schedule.zip', (_req, res) => serveZip()(res));
    tight.start();
    await vi.waitFor(() => expect(tight.status().state).toBe('failed'));
    statuses.push(JSON.stringify(tight.status()));
    tight.discard();

    const output = [...statuses, ...logs].join('\n');
    expect(logs.length).toBeGreaterThanOrEqual(failures.length);
    for (const secret of [host.origin, '127.0.0.1', 'SUPERSECRET123', 'api_key', 'schedule.zip']) {
      expect(output).not.toContain(secret);
    }
  });
});

describe('discard', () => {
  it('aborts the in-flight download and ignores whatever the host sends later', async () => {
    let respond: (() => void) | undefined;
    let connectionClosed = false;
    host.route('/schedule.zip', (_req, res) => {
      res.on('close', () => (connectionClosed = true));
      respond = () => serveZip()(res);
    });
    loader.start();
    await vi.waitFor(() => expect(respond).toBeDefined());
    loader.discard();
    expect(loader.status()).toEqual({ state: 'idle', loadedAt: null, error: null });
    await vi.waitFor(() => expect(connectionClosed).toBe(true));
    respond?.();
    await clock.advanceAsync(RETRY_DELAY_MS * 2);
    expect(loader.status().state).toBe('idle');
    expect(loader.store).toBeNull();
    expect(downloads()).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('drops the loaded schedule and goes idle', async () => {
    loader.start();
    await untilState('ready');
    expect(loader.store).not.toBeNull();
    loader.discard();
    expect(loader.store).toBeNull();
    expect(loader.status()).toEqual({ state: 'idle', loadedAt: null, error: null });
  });

  it('leaves nothing holding the loaded schedule, so its memory can be freed', async () => {
    loader.start();
    await untilState('ready');
    const weak = new WeakRef(loader.store!);
    loader.discard();
    await vi.waitFor(() => {
      collectGarbage();
      expect(weak.deref() === undefined).toBe(true);
    });
  });

  it('cancels the pending automatic retry', async () => {
    host.route('/schedule.zip', (_req, res) => void res.writeHead(404).end());
    loader.start();
    await untilState('failed');
    loader.discard();
    expect(clock.pendingTimers()).toBe(0);
    await clock.advanceAsync(RETRY_DELAY_MS * 2);
    expect(downloads()).toHaveLength(1);
    expect(state()).toBe('idle');
  });

  describe('a load that completes after the discard anyway', () => {
    const emptyStore = (): ScheduleStore => ({}) as ScheduleStore;

    it('does not repopulate the loader', async () => {
      let finish!: (store: ScheduleStore) => void;
      loader = makeLoader(
        {},
        () => new Promise<ScheduleStore>((resolve) => void (finish = resolve)),
      );
      loader.start();
      loader.discard();
      finish(emptyStore());
      await clock.advanceAsync(RETRY_DELAY_MS * 2);
      expect(loader.status()).toEqual({ state: 'idle', loadedAt: null, error: null });
      expect(loader.store).toBeNull();
    });

    it('does not fail the loader or schedule a retry when it fails late', async () => {
      let fail!: (error: Error) => void;
      loader = makeLoader(
        {},
        () => new Promise<ScheduleStore>((_, reject) => void (fail = reject)),
      );
      loader.start();
      loader.discard();
      fail(new Error('boom'));
      await clock.advanceAsync(RETRY_DELAY_MS * 2);
      expect(loader.status().state).toBe('idle');
      expect(clock.pendingTimers()).toBe(0);
      expect(logs.join('')).not.toContain('boom');
    });

    it('does not override the next activation load', async () => {
      const finishers: Array<(store: ScheduleStore) => void> = [];
      loader = makeLoader(
        {},
        () => new Promise<ScheduleStore>((resolve) => void finishers.push(resolve)),
      );
      loader.start();
      loader.discard();
      loader.start();
      const second = { counts: () => ({}) } as ScheduleStore;
      finishers[0]!(emptyStore());
      await clock.advanceAsync(1);
      expect(loader.status().state).toBe('loading');
      finishers[1]!(second);
      await untilState('ready');
      expect(loader.store).toBe(second);
    });
  });
});

describe('unexpected failures', () => {
  it('reports a crash in the load as a generic internal_error and retries as for any failure', async () => {
    let calls = 0;
    loader = makeLoader({}, async () => {
      calls++;
      throw new TypeError(`cannot read ${host.origin}${SECRET_PATH}`);
    });
    loader.start();
    await untilState('failed');
    expect(loader.status().error?.code).toBe('internal_error');
    expect(JSON.stringify(loader.status())).not.toContain('SUPERSECRET123');
    await clock.advanceAsync(RETRY_DELAY_MS);
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it('survives a load that throws synchronously', async () => {
    loader = makeLoader({}, () => {
      throw new Error('sync');
    });
    loader.start();
    await untilState('failed');
  });
});
