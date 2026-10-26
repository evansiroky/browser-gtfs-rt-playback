import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { TIMEZONE } from './catalog.js';
import { startFakeFeeds, type FakeFeeds, type FakeFeedsOptions } from './fake-server.js';
import { decodeFeed, toSeconds } from './rt.js';
import { agencyInstant } from './time.js';

const NOW = agencyInstant('20261014', '12:07:42', TIMEZONE);
const running: FakeFeeds[] = [];

async function start(options: FakeFeedsOptions = {}): Promise<FakeFeeds> {
  const feeds = await startFakeFeeds({ now: NOW, ...options });
  running.push(feeds);
  return feeds;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((f) => f.close()));
});

const control = (feeds: FakeFeeds, body: unknown) =>
  fetch(feeds.urls.control, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const bytes = async (url: string): Promise<Uint8Array> =>
  new Uint8Array(await (await fetch(url)).arrayBuffer());
const headerTime = async (url: string): Promise<number | null> =>
  toSeconds(decodeFeed(await bytes(url)).header.timestamp);

describe('fake feeds, healthy', () => {
  it('serves the scenario at three URLs', async () => {
    const feeds = await start();
    const { urls } = feeds;
    const scenario = feeds.scenario();

    const zip = await fetch(urls.schedule);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const zipBytes = new Uint8Array(await zip.arrayBuffer());
    expect(zipBytes).toEqual(scenario.scheduleZip);
    expect(Object.keys(unzipSync(zipBytes))).toContain('trips.txt');

    const vp = await fetch(urls.vehiclePositions);
    expect(vp.headers.get('content-type')).toBe('application/x-protobuf');
    expect(decodeFeed(new Uint8Array(await vp.arrayBuffer())).entity).toHaveLength(
      scenario.expected.stats.vehicles,
    );
    expect(decodeFeed(await bytes(urls.tripUpdates)).entity).toHaveLength(
      scenario.expected.stats.tripUpdates,
    );
  });

  it('serves the ground truth for the scenario it is serving', async () => {
    const feeds = await start();
    const url = feeds.urls.control.replace('__control', '__scenario');
    const read = async () =>
      (await (await fetch(url)).json()) as { now: string; scenarioNow: string; expected: unknown };
    const body = await read();
    expect(body.now).toBe(NOW.toISOString());
    expect(body.scenarioNow).toBe(NOW.toISOString());
    expect(body.expected).toEqual(JSON.parse(JSON.stringify(feeds.scenario().expected)));

    // after the clock moves, `now` follows it while `expected` and `scenarioNow` stay at the build
    await control(feeds, { advance: 300 });
    const later = await read();
    expect(later.now).toBe(new Date(NOW.getTime() + 300_000).toISOString());
    expect(later.scenarioNow).toBe(NOW.toISOString());
    expect(later.expected).toEqual(body.expected);
  });

  it('answers unknown paths with 404', async () => {
    const feeds = await start();
    expect((await fetch(feeds.urls.schedule.replace('schedule.zip', 'nope'))).status).toBe(404);
  });

  it('follows the wall clock when no instant is frozen', async () => {
    const feeds = await start({ now: undefined });
    const before = Math.floor(Date.now() / 1000);
    const stamp = await headerTime(feeds.urls.vehiclePositions);
    expect(stamp).toBeGreaterThanOrEqual(before - 1);
    expect(stamp).toBeLessThanOrEqual(before + 5);
  });
});

describe('control: clock', () => {
  it('freezes at the given instant, and advance moves vehicles forward', async () => {
    const feeds = await start();
    const nowSec = NOW.getTime() / 1000;
    expect(await headerTime(feeds.urls.vehiclePositions)).toBe(nowSec);
    const res = await control(feeds, { advance: 120 });
    expect(await res.json()).toMatchObject({
      frozen: true,
      now: new Date(NOW.getTime() + 120_000).toISOString(),
    });
    expect(await headerTime(feeds.urls.vehiclePositions)).toBe(nowSec + 120);
    expect(await headerTime(feeds.urls.tripUpdates)).toBe(nowSec + 120 - 3); // trails by 3 s
  });

  it('rebuilds the scenario around a new instant', async () => {
    const feeds = await start();
    const next = agencyInstant('20261014', '00:20:00', TIMEZONE);
    await control(feeds, { now: next.toISOString() });
    expect(feeds.scenario().now).toEqual(next);
    expect(feeds.scenario().expected.lists.activeWithRealtime.map((r) => r.tripId)).toContain(
      'overnight-from-yesterday',
    );
    expect(await headerTime(feeds.urls.vehiclePositions)).toBe(next.getTime() / 1000);
    const live = await control(feeds, { now: null });
    expect(await live.json()).toMatchObject({ frozen: false });
  });
});

describe('control: failure modes', () => {
  it('reports and validates the state', async () => {
    const feeds = await start();
    expect(await (await fetch(feeds.urls.control)).json()).toMatchObject({
      modes: { vp: 'ok', tu: 'ok', schedule: 'ok' },
      frozen: true,
    });
    for (const bad of [
      { feed: 'vp' },
      { mode: 'ok' },
      { feed: 'nope', mode: 'ok' },
      { feed: 'vp', mode: 'nope' },
      { now: 'yesterday-ish' },
      { advance: 'soon' },
      { slowMs: -1 },
      [],
    ]) {
      expect((await control(feeds, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const json = { 'content-type': 'application/json' };
    expect(
      (await fetch(feeds.urls.control, { method: 'POST', headers: json, body: 'not json' })).status,
    ).toBe(400);
    expect((await fetch(feeds.urls.control, { method: 'DELETE' })).status).toBe(405);
    // charset parameters are fine
    const withCharset = { 'content-type': 'application/json; charset=utf-8' };
    expect(
      (
        await fetch(feeds.urls.control, {
          method: 'PUT',
          headers: withCharset,
          body: '{"slowMs": 10}',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a control request that is not JSON, so a web page cannot flip modes', async () => {
    const feeds = await start();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await fetch(feeds.urls.control, {
        method: 'POST',
        headers: { 'content-type': type },
        body: JSON.stringify({ feed: 'vp', mode: 'http500' }),
      });
      expect(res.status, type).toBe(415);
    }
    const noType = await fetch(feeds.urls.control, {
      method: 'POST',
      body: JSON.stringify({ feed: 'vp', mode: 'http500' }),
    });
    expect(noType.status).toBe(415);
    expect((await fetch(feeds.urls.vehiclePositions)).status).toBe(200);
  });

  it('listens on the loopback interface', async () => {
    const feeds = await start();
    expect(new URL(feeds.urls.control).hostname).toBe('127.0.0.1');
  });

  it.each([
    ['vp', 'vehiclePositions'],
    ['tu', 'tripUpdates'],
    ['schedule', 'schedule'],
  ] as const)('http500 on %s affects only that feed', async (feed, key) => {
    const feeds = await start();
    await control(feeds, { feed, mode: 'http500' });
    expect((await fetch(feeds.urls[key])).status).toBe(500);
    for (const other of ['vehiclePositions', 'tripUpdates', 'schedule'] as const) {
      if (other !== key) expect((await fetch(feeds.urls[other])).status).toBe(200);
    }
    await control(feeds, { feed, mode: 'ok' });
    expect((await fetch(feeds.urls[key])).status).toBe(200);
  });

  it('garbage answers 200 with a body that is neither a feed nor a zip', async () => {
    const feeds = await start();
    await control(feeds, { feed: 'vp', mode: 'garbage' });
    await control(feeds, { feed: 'schedule', mode: 'garbage' });
    const vp = await fetch(feeds.urls.vehiclePositions);
    expect(vp.status).toBe(200);
    const garbage = new Uint8Array(await vp.arrayBuffer());
    expect(() => decodeFeed(garbage)).toThrow();
    const zip = await bytes(feeds.urls.schedule);
    expect(() => unzipSync(zip)).toThrow();
  });

  it('timeout never answers', async () => {
    const feeds = await start();
    await control(feeds, { feed: 'tu', mode: 'timeout' });
    await expect(
      fetch(feeds.urls.tripUpdates, { signal: AbortSignal.timeout(300) }),
    ).rejects.toThrow();
    // a hung request does not block the others
    expect((await fetch(feeds.urls.vehiclePositions)).status).toBe(200);
  });

  it('slow delays the response by at least slowMs, then serves it', async () => {
    const feeds = await start({ slowMs: 250 });
    await control(feeds, { feed: 'vp', mode: 'slow' });
    const started = performance.now();
    const res = await fetch(feeds.urls.vehiclePositions);
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
    expect(decodeFeed(new Uint8Array(await res.arrayBuffer())).entity.length).toBeGreaterThan(0);
    const fast = performance.now();
    await fetch(feeds.urls.tripUpdates);
    expect(performance.now() - fast).toBeLessThan(200);
  });

  it('old-data serves the same one-hour-old feed every time, until the mode is cleared', async () => {
    const feeds = await start();
    const nowSec = NOW.getTime() / 1000;
    await control(feeds, { feed: 'vp', mode: 'old-data' });
    const first = await bytes(feeds.urls.vehiclePositions);
    await control(feeds, { advance: 90 });
    const second = await bytes(feeds.urls.vehiclePositions);
    expect(second).toEqual(first);
    expect(toSeconds(decodeFeed(first).header.timestamp)).toBe(nowSec - 3600);
    const decoded = decodeFeed(first);
    for (const e of decoded.entity)
      expect(toSeconds(e.vehicle!.timestamp)!).toBeLessThan(nowSec - 3590);
    // the other feed keeps moving
    expect(await headerTime(feeds.urls.tripUpdates)).toBe(nowSec + 90 - 3);
    await control(feeds, { feed: 'vp', mode: 'ok' });
    expect(await headerTime(feeds.urls.vehiclePositions)).toBe(nowSec + 90);
  });
});

describe('the fake-feeds command', () => {
  it('binds the loopback interface and ignores $HOST', async () => {
    const script = fileURLToPath(new URL('../dist/server.js', import.meta.url));
    const child = spawn(process.execPath, [script, '--port=0'], {
      env: { ...process.env, HOST: '0.0.0.0', PORT: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const match = /schedule\s+(http:\/\/\S+)/.exec(out);
          if (match) resolve(match[1]!);
        });
        child.once('exit', () => reject(new Error(`exited early: ${out}`)));
      });
      const address = new URL(url);
      expect(address.hostname).toBe('127.0.0.1');
      expect((await fetch(url)).status).toBe(200);
      // the same port on any other local address must refuse the connection
      const other = Object.values(networkInterfaces())
        .flat()
        .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
      if (other) {
        await expect(fetch(`http://${other}:${address.port}/schedule.zip`)).rejects.toThrow();
      }
    } finally {
      child.kill();
    }
  });
});
