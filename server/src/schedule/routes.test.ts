import type { ServerResponse } from 'node:http';
import { scenario } from '@gtfs-rt-debugger/fixtures';
import type { SessionStatus, ShapeResponse } from '@gtfs-rt-debugger/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClock } from '../clock.js';
import { testApp } from '../test-support/app.js';
import { startFeedHost, type FeedHost } from '../test-support/feeds.js';
import { miniSchedule, zipOf } from '../test-support/zip.js';
import { ScheduleLoader } from './loader.js';
import { shapesRoutes, type ScheduleServices } from './routes.js';

const SECRET_PATH = '/schedule.zip?api_key=SUPERSECRET123';
const sc = scenario(new Date('2026-10-14T19:07:42Z'));

let host: FeedHost;
let app: FastifyInstance | undefined;
let clock: FakeClock;
let logs: string[];

const serve = (bytes: Uint8Array) => (res: ServerResponse) =>
  void res.writeHead(200, { 'content-type': 'application/zip' }).end(bytes);
const downloads = () => host.requests.filter((url) => url.startsWith('/schedule.zip'));

/** The real composition of `main.ts`, with a fake clock and captured logs. */
async function build(
  zip: Uint8Array | null = sc.scheduleZip,
  env: Record<string, string> = {},
  crash?: (url: string) => never,
) {
  if (zip) host.route('/schedule.zip', (_req, res) => serve(zip)(res));
  const built = await testApp<ScheduleServices>(
    { SCHEDULE_URL: `${host.origin}${SECRET_PATH}`, ...env },
    {
      services: ({ config, clock, logger }) => ({
        loader: new ScheduleLoader({
          config,
          clock,
          logger,
          load: crash && (async () => crash(config.scheduleUrl.reveal().href)),
        }),
      }),
      schedule: ({ services }) => services.loader,
      routes: [shapesRoutes],
    },
  );
  app = built.app;
  clock = built.clock;
  logs = built.logs;
  return built;
}

const call = (method: 'GET' | 'POST', url: string) => app!.inject({ method, url });
const start = async () => (await call('POST', '/api/v1/session/start')).json<SessionStatus>();
const scheduleState = async () =>
  (await call('POST', '/api/v1/session/ping')).json<SessionStatus>().schedule.state;
const untilReady = () => vi.waitFor(async () => expect(await scheduleState()).toBe('ready'));
const shape = (id: string) => call('GET', `/api/v1/shapes/${id}`);

beforeEach(async () => {
  host = await startFeedHost();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await host.close();
});

describe('GET /api/v1/shapes/{shapeId}', () => {
  it('serves { shapeId, encoding, polyline } with the stored string, unchanged', async () => {
    const { context } = await build();
    await start();
    await untilReady();
    for (const [shapeId, polyline] of Object.entries(sc.expected.schedule.shapes)) {
      const response = await shape(shapeId);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toMatch(/^application\/json; charset=utf-8/);
      expect(response.json<ShapeResponse>()).toEqual({ shapeId, encoding: 'polyline6', polyline });
      expect(response.json<ShapeResponse>().polyline).toBe(
        context.services.loader.store?.shape(shapeId),
      );
    }
  });

  it('answers 404 shape_not_found for a shape the schedule does not have', async () => {
    await build();
    await start();
    await untilReady();
    for (const id of ['shape-gone', 'SHAPE-MARKET', '', '%20']) {
      const response = await shape(id);
      expect([404], id).toContain(response.statusCode);
    }
    expect((await shape('shape-gone')).json()).toEqual({
      error: { code: 'shape_not_found', message: 'No such shape.' },
    });
  });

  it('decodes percent-encoded shape ids and serves 500-character ones', async () => {
    const ids = ['route 66/north', 'a%b?c#d', 'Ångström-東京', 'x'.repeat(500), 'y/'.repeat(250)];
    const lines = ids.map((id, i) => `"${id}",4${i}.0,-87.0,1\n"${id}",4${i}.5,-87.5,2`);
    await build(
      zipOf(
        miniSchedule({
          'shapes.txt': `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n${lines.join('\n')}\n`,
        }),
      ),
    );
    await start();
    await untilReady();
    for (const id of ids) {
      const response = await shape(encodeURIComponent(id));
      expect(response.statusCode, id.slice(0, 20)).toBe(200);
      expect(response.json<ShapeResponse>().shapeId).toBe(id);
      expect(response.json<ShapeResponse>().polyline.length).toBeGreaterThan(0);
    }
  });

  it('rejects any query parameter with 400 bad_request, before the state checks', async () => {
    await build();
    for (const query of ['?x=1', '?shapeId=a', '?polyline=1&x=2']) {
      const dormant = await shape(`shape-market${query}`);
      expect(dormant.statusCode, query).toBe(400);
      expect(dormant.json().error.code).toBe('bad_request');
    }
    await start();
    await untilReady();
    const response = await shape('shape-market?x=1');
    expect(response.statusCode).toBe(400);
    expect((await shape('shape-market')).statusCode).toBe(200);
  });

  it('answers 409 session_not_active while dormant, and never wakes the server', async () => {
    await build();
    const response = await shape('shape-market');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('session_not_active');
    expect(downloads()).toHaveLength(0);
    expect((await call('POST', '/api/v1/session/ping')).json<SessionStatus>().state).toBe('active');
  });

  it('answers 409 schedule_not_ready while the schedule loads and after it failed', async () => {
    await build(null);
    let release: (() => void) | undefined;
    host.route('/schedule.zip', (_req, res) => void (release = () => serve(sc.scheduleZip)(res)));
    await start();
    await vi.waitFor(() => expect(release).toBeDefined());
    const loading = await shape('shape-market');
    expect(loading.statusCode).toBe(409);
    expect(loading.json().error.code).toBe('schedule_not_ready');
    release?.();
    await untilReady();
    expect((await shape('shape-market')).statusCode).toBe(200);

    await app!.close();
    host.route('/schedule.zip', (_req, res) => void res.writeHead(404).end());
    await build(null);
    await start();
    await vi.waitFor(async () => expect(await scheduleState()).toBe('failed'));
    const failed = await shape('shape-market');
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('schedule_not_ready');
  });

  it('is data: it does not reset the inactivity timer', async () => {
    await build();
    await start();
    await untilReady();
    const minute = 60_000;
    clock.advance(14 * minute);
    expect((await shape('shape-market')).statusCode).toBe(200);
    clock.advance(minute / 2);
    expect((await shape('shape-market')).statusCode).toBe(200);
    clock.advance(minute / 2);
    // 15 minutes after the start (the last session request): dormant, schedule forgotten.
    const response = await shape('shape-market');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('session_not_active');
  });
});

describe('the schedule through the session', () => {
  it('downloads at the first start only: later starts and pings do not download again', async () => {
    await build();
    const first = await start();
    expect(first.schedule.state).toBe('loading');
    await untilReady();
    await start();
    await call('POST', '/api/v1/session/ping');
    clock.advance(5 * 60_000);
    await start();
    await call('POST', '/api/v1/session/ping');
    expect(downloads()).toHaveLength(1);
    expect((await start()).schedule).toMatchObject({ state: 'ready', error: null });
  });

  it('a start retries a failed load; a later activation downloads again', async () => {
    await build(null);
    host.route('/schedule.zip', (_req, res) => void res.writeHead(500).end());
    await start();
    await vi.waitFor(async () => expect(await scheduleState()).toBe('failed'));
    const failed = (await start()).schedule;
    expect(failed.state).toBe('loading'); // the start retried it
    await vi.waitFor(async () => expect(await scheduleState()).toBe('failed'));
    expect(downloads()).toHaveLength(2);

    host.route('/schedule.zip', (_req, res) => serve(sc.scheduleZip)(res));
    await start();
    await untilReady();
    expect(downloads()).toHaveLength(3);

    // Idle shutdown forgets the schedule; the next activation loads it again.
    clock.advance(15 * 60_000);
    expect((await call('POST', '/api/v1/session/ping')).json<SessionStatus>().state).toBe('active');
    await untilReady();
    expect(downloads()).toHaveLength(4);
  });

  it('keeps feed URLs out of the status and out of every log line, even for a crash', async () => {
    await build(null);
    host.route('/schedule.zip', (_req, res) => void res.writeHead(404).end());
    await start();
    await vi.waitFor(async () => expect(await scheduleState()).toBe('failed'));
    const notFound = JSON.stringify(
      (await call('POST', '/api/v1/session/ping')).json<SessionStatus>().schedule,
    );
    expect(notFound).not.toMatch(/SUPERSECRET|127\.0\.0\.1|schedule\.zip/);
    expect(logs.join('\n')).toContain('schedule load failed');

    // A bug whose error text names the URL: described generically, and scrubbed from the log.
    await app!.close();
    await build(null, {}, (url) => {
      throw new TypeError(`unexpected response from ${url}`);
    });
    await start();
    await vi.waitFor(async () => expect(await scheduleState()).toBe('failed'));
    const crashed = (await call('POST', '/api/v1/session/ping')).json<SessionStatus>().schedule;
    expect(crashed.error?.code).toBe('internal_error');
    const output = [...logs, JSON.stringify(crashed), notFound].join('\n');
    expect(logs.join('\n')).toContain('schedule load crashed');
    for (const secret of ['SUPERSECRET123', 'api_key', host.origin]) {
      expect(output).not.toContain(secret);
    }
  });
});
