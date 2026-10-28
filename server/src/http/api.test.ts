import type { ApiErrorBody, FeedStatus, SessionStatus } from '@gtfs-rt-debugger/shared';
import { API_ERROR_CODES } from '@gtfs-rt-debugger/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { testApp } from '../test-support/app.js';
import { encodeFeed, startFeedHost, type FeedHost } from '../test-support/feeds.js';
import type { ScheduleStatus } from '../session/schedule-provider.js';
import { rejectUnknownQuery } from './guards.js';
import { ApiError } from './errors.js';

const MINUTE = 60_000;
let app: FastifyInstance | undefined;
let host: FeedHost | undefined;

afterEach(async () => {
  await app?.close();
  await host?.close();
  app = undefined;
  host = undefined;
});

async function setup(...args: Parameters<typeof testApp>) {
  const built = await testApp(...args);
  app = built.app;
  return built;
}

const post = (path: string, headers: Record<string, string> = {}) =>
  app!.inject({ method: 'POST', url: `/api/v1${path}`, headers });

const nullableInt = (value: unknown) => value === null || Number.isInteger(value);
const statusError = (value: unknown) =>
  value === null ||
  (typeof value === 'object' &&
    Object.keys(value as object)
      .sort()
      .join() === 'code,message' &&
    typeof (value as { code: unknown }).code === 'string' &&
    typeof (value as { message: unknown }).message === 'string');

function expectFeedStatus(value: FeedStatus | null) {
  if (value === null) return;
  expect(Object.keys(value).sort()).toEqual([
    'error',
    'feedTimestamp',
    'lastAttemptAt',
    'lastSuccessAt',
    'stale',
  ]);
  expect(
    nullableInt(value.lastAttemptAt) &&
      nullableInt(value.lastSuccessAt) &&
      nullableInt(value.feedTimestamp),
  ).toBe(true);
  expect(typeof value.stale).toBe('boolean');
  expect(statusError(value.error)).toBe(true);
}

/** Runtime check that a body has exactly the `SessionStatus` shape from `shared`. */
function expectSessionStatus(res: LightMyRequestResponse): SessionStatus {
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(res.headers['cache-control']).toBe('no-store');
  const body = res.json<SessionStatus>();
  expect(Object.keys(body).sort()).toEqual(
    [
      'activatedAt',
      'endedReason',
      'expiresAt',
      'historyStartsAt',
      'realtime',
      'schedule',
      'state',
    ].sort(),
  );
  expect(['dormant', 'active']).toContain(body.state);
  expect([null, 'idle', 'max-duration']).toContain(body.endedReason);
  expect(
    nullableInt(body.activatedAt) &&
      nullableInt(body.expiresAt) &&
      nullableInt(body.historyStartsAt),
  ).toBe(true);
  expect(Object.keys(body.schedule).sort()).toEqual(['error', 'loadedAt', 'state']);
  expect(['idle', 'loading', 'ready', 'failed']).toContain(body.schedule.state);
  expect(nullableInt(body.schedule.loadedAt) && statusError(body.schedule.error)).toBe(true);
  expect(Object.keys(body.realtime).sort()).toEqual(['tripUpdates', 'vehiclePositions']);
  expectFeedStatus(body.realtime.vehiclePositions);
  expectFeedStatus(body.realtime.tripUpdates);
  return body;
}

function expectError(
  res: LightMyRequestResponse,
  status: number,
  code: ApiErrorBody['error']['code'],
) {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  const body = res.json<ApiErrorBody>();
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  expect(API_ERROR_CODES).toContain(body.error.code);
  expect(body.error.code).toBe(code);
  expect(body.error.message).not.toMatch(/https?:|\bat \S+:\d+|Error:/);
  return body;
}

describe('session API', () => {
  it('start wakes a dormant server and returns an active SessionStatus', async () => {
    const { clock } = await setup();
    const body = expectSessionStatus(await post('/session/start'));
    const now = Math.floor(clock.now() / 1000);
    expect(body).toMatchObject({
      state: 'active',
      endedReason: null,
      activatedAt: now,
      expiresAt: now + 7200,
    });
    expect(body.schedule).toEqual({ state: 'idle', loadedAt: null, error: null });
  });

  it('ping returns 200 with a dormant SessionStatus when it does not wake the server', async () => {
    const { clock } = await setup({ MAX_ACTIVATION_MS: String(MINUTE) });
    expectSessionStatus(await post('/session/start'));
    clock.advance(MINUTE);
    const body = expectSessionStatus(await post('/session/ping'));
    expect(body).toEqual({
      state: 'dormant',
      endedReason: 'max-duration',
      activatedAt: null,
      expiresAt: null,
      historyStartsAt: null,
      schedule: { state: 'idle', loadedAt: null, error: null },
      realtime: { vehiclePositions: null, tripUpdates: null },
    });
  });

  it('reports an unconfigured realtime feed as null while active', async () => {
    host = await startFeedHost();
    host.route('/vp', (_req, res) => void res.writeHead(200).end(encodeFeed()));
    const { context } = await setup({
      VEHICLE_POSITIONS_URL: `${host.origin}/vp`,
      TRIP_UPDATES_URL: '',
    });
    expectSessionStatus(await post('/session/start'));
    await vi.waitFor(() => expect(context.store.latest('vehiclePositions')).not.toBeNull());
    const body = expectSessionStatus(await post('/session/ping'));
    expect(body.realtime.tripUpdates).toBeNull();
    expect(body.realtime.vehiclePositions).toMatchObject({ error: null, stale: false });
    expect(body.historyStartsAt).toBe(body.activatedAt);
  });

  it('shares one activation between simultaneous starts', async () => {
    const calls: string[] = [];
    const schedule = () => ({
      store: null,
      start: () => void calls.push('start'),
      retry: () => void calls.push('retry'),
      discard: () => void calls.push('discard'),
      status: (): ScheduleStatus => ({ state: 'loading', loadedAt: null, error: null }),
    });
    await setup({}, { schedule });
    const [a, b] = await Promise.all([post('/session/start'), post('/session/start')]);
    expect(expectSessionStatus(a).activatedAt).toBe(expectSessionStatus(b).activatedAt);
    expect(calls).toEqual(['start']);
  });

  it('rejects query parameters and malformed bodies with bad_request', async () => {
    await setup();
    expectError(await post('/session/start?serviceDate=20260101'), 400, 'bad_request');
    expectError(await post('/session/ping?x'), 400, 'bad_request');
    const res = await app!.inject({
      method: 'POST',
      url: '/api/v1/session/ping',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expectError(res, 400, 'bad_request');
    expect(res.headers['cache-control']).toBe('no-store');
    const empty = await app!.inject({
      method: 'POST',
      url: '/api/v1/session/ping',
      headers: { 'content-type': 'application/json' },
    });
    expectError(empty, 400, 'bad_request');
  });
});

describe('API conventions', () => {
  it('answers unknown endpoints and methods with a not_found envelope', async () => {
    await setup();
    for (const res of [
      await app!.inject({ method: 'GET', url: '/api/v1/nope' }),
      await app!.inject({ method: 'GET', url: '/api/v1/session/start' }),
      await app!.inject({ method: 'GET', url: '/api/v2/session/start' }),
      await app!.inject({ method: 'GET', url: '/api' }),
    ]) {
      expectError(res, 404, 'not_found');
    }
    expect(
      (await app!.inject({ method: 'GET', url: '/api/v1/nope' })).headers['cache-control'],
    ).toBe('no-store');
  });

  it('rate-limits per forwarded client address with 429 and Retry-After', async () => {
    const { clock } = await setup({ RATE_LIMIT_PER_MIN: '3' });
    const from = (address: string) => ({ 'x-forwarded-for': address });
    for (let i = 0; i < 3; i++)
      expectSessionStatus(await post('/session/ping', from('203.0.113.1')));
    clock.advance(20_000);
    const limited = await post('/session/ping', from('203.0.113.1'));
    expectError(limited, 429, 'rate_limited');
    expect(limited.headers['retry-after']).toBe('40');
    expect(limited.headers['cache-control']).toBe('no-store');
    // Unknown endpoints count too.
    expectError(
      await app!.inject({ url: '/api/v1/nope', headers: from('203.0.113.1') }),
      429,
      'rate_limited',
    );
    // Another address is unaffected; the platform appends the real address last, so a spoofed
    // leading entry does not dodge the limit.
    expectSessionStatus(await post('/session/ping', from('198.51.100.7')));
    expectError(
      await post('/session/ping', from('198.51.100.7, 203.0.113.1')),
      429,
      'rate_limited',
    );
    clock.advance(40_000);
    expectSessionStatus(await post('/session/ping', from('203.0.113.1')));
  });

  it('turns unexpected errors into internal_error without leaking internals or feed URLs', async () => {
    const { logs } = await setup(
      { VEHICLE_POSITIONS_URL: 'https://rt.example.test/vp?api_key=SUPERSECRET123' },
      {
        routes: [
          (api) => {
            api.get('/boom', async () => {
              throw new Error(
                'exploded fetching https://rt.example.test/vp?api_key=SUPERSECRET123',
              );
            });
          },
        ],
      },
    );
    const res = await app!.inject({ url: '/api/v1/boom' });
    const body = expectError(res, 500, 'internal_error');
    expect(JSON.stringify(body)).not.toMatch(/exploded|SUPERSECRET123|stack/);
    expect(res.headers['cache-control']).toBe('no-store');
    const logged = logs.join('\n');
    expect(logged).toContain('exploded');
    expect(logged).not.toContain('SUPERSECRET123');
    expect(logged).not.toContain('rt.example.test/vp');
  });

  it('sets the exact CSP, allowing the default map tile host, and security headers', async () => {
    await setup();
    const res = await post('/session/ping');
    expect(res.headers['content-security-policy']).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://tiles.openfreemap.org",
        "font-src 'self'",
        "connect-src 'self' https://tiles.openfreemap.org",
        "worker-src 'self'",
        'child-src blob:',
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('uses a configured tile host instead of the default', async () => {
    await setup({ TILE_HOST: 'https://tiles.example.test/' });
    const csp = String((await post('/session/ping')).headers['content-security-policy']);
    expect(csp).toContain("connect-src 'self' https://tiles.example.test;");
    expect(csp).toContain("img-src 'self' data: blob: https://tiles.example.test;");
    expect(csp).not.toContain('openfreemap');
  });

  it('answers router failures with the envelope, no-store and security headers', async () => {
    await setup();
    for (const url of ['/api/v1/session/%zz', '/api/v1/%E0%A4%A']) {
      const res = await app!.inject({ url });
      expectError(res, 400, 'bad_request');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    }
  });

  it('accepts route parameters of up to 1000 characters', async () => {
    await setup(
      {},
      {
        routes: [
          (api) => {
            api.get('/echo/:id', async (request) => ({
              id: (request.params as { id: string }).id,
            }));
          },
        ],
      },
    );
    const long = 'x'.repeat(500);
    const res = await app!.inject({ url: `/api/v1/echo/${long}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: long });
    const tooLong = await app!.inject({ url: `/api/v1/echo/${'x'.repeat(1001)}` });
    expectError(tooLong, 400, 'bad_request');
    expect(tooLong.headers['cache-control']).toBe('no-store');
  });

  it('answers requests that arrive while closing normally, in the envelope conventions', async () => {
    await setup();
    const closing = app!.close();
    const [ping, missing] = await Promise.all([
      app!.inject({ method: 'POST', url: '/api/v1/session/ping' }),
      app!.inject({ url: '/api/v1/nope' }),
    ]);
    await closing;
    app = undefined;
    expect(ping.statusCode).toBe(200);
    expect(ping.json<SessionStatus>().state).toBe('dormant');
    expect(ping.headers['cache-control']).toBe('no-store');
    expectError(missing, 404, 'not_found');
  });
});

describe('data endpoint helpers', () => {
  async function withDataRoutes(scheduleState: { current: ScheduleStatus['state'] }) {
    return setup(
      {},
      {
        schedule: () => ({
          store: null,
          start() {},
          retry() {},
          discard() {},
          status: () => ({ state: scheduleState.current, loadedAt: null, error: null }),
        }),
        routes: [
          (api, { guard }) => {
            api.get(
              '/live',
              { preHandler: [rejectUnknownQuery(['list']), guard.requireActive] },
              async () => ({
                ok: true,
              }),
            );
            api.get(
              '/scheduled',
              { preHandler: [rejectUnknownQuery([]), guard.requireSchedule] },
              async () => ({
                ok: true,
              }),
            );
            api.get('/missing', async () => {
              throw new ApiError(404, 'trip_not_found', 'No such trip.');
            });
          },
        ],
      },
    );
  }

  it('guards return 409 session_not_active / schedule_not_ready and never wake the server', async () => {
    const scheduleState = { current: 'idle' as ScheduleStatus['state'] };
    const { context, clock, exit } = await withDataRoutes(scheduleState);
    expectError(await app!.inject({ url: '/api/v1/live' }), 409, 'session_not_active');
    expectError(await app!.inject({ url: '/api/v1/scheduled' }), 409, 'session_not_active');
    expect(context.session.active).toBe(false);

    await post('/session/start');
    expect((await app!.inject({ url: '/api/v1/live?list=x' })).json()).toEqual({ ok: true });
    scheduleState.current = 'loading';
    expectError(await app!.inject({ url: '/api/v1/scheduled' }), 409, 'schedule_not_ready');
    scheduleState.current = 'failed';
    expectError(await app!.inject({ url: '/api/v1/scheduled' }), 409, 'schedule_not_ready');
    scheduleState.current = 'ready';
    const ok = await app!.inject({ url: '/api/v1/scheduled' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expectError(await app!.inject({ url: '/api/v1/missing' }), 404, 'trip_not_found');

    // Reading data endpoints does not reset the inactivity timer.
    clock.advance(14 * MINUTE);
    await app!.inject({ url: '/api/v1/live' });
    clock.advance(MINUTE);
    expect(context.session.active).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('rejectUnknownQuery refuses unknown and repeated parameters', async () => {
    await withDataRoutes({ current: 'ready' });
    await post('/session/start');
    expectError(await app!.inject({ url: '/api/v1/live?other=1' }), 400, 'bad_request');
    expectError(await app!.inject({ url: '/api/v1/live?list=a&list=b' }), 400, 'bad_request');
    expectError(
      await app!.inject({ url: '/api/v1/scheduled?serviceDate=20260101' }),
      400,
      'bad_request',
    );
    expect((await app!.inject({ url: '/api/v1/scheduled?' })).statusCode).toBe(200);
  });
});

describe('idle shutdown', () => {
  it('drains and calls exit when EXIT_ON_IDLE is on', async () => {
    const { clock, exit } = await setup({ EXIT_ON_IDLE: 'true' });
    let closed = false;
    app!.addHook('onClose', async () => void (closed = true));
    await post('/session/start');
    clock.advance(15 * MINUTE);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(closed).toBe(true);
    app = undefined;
  });

  it('does not exit when EXIT_ON_IDLE is off', async () => {
    const { clock, exit, context } = await setup({ EXIT_ON_IDLE: 'false' });
    await post('/session/start');
    clock.advance(15 * MINUTE);
    expect(context.session.status()).toMatchObject({ state: 'dormant', endedReason: 'idle' });
    expectSessionStatus(await post('/session/ping'));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('feed URLs never leak', () => {
  it('keeps the feed URL and API key out of responses and logs for every failure mode', async () => {
    host = await startFeedHost();
    const modes = ['/404', '/garbage', '/redirect-loop', '/big'];
    host.route('/404', (_req, res) => void res.writeHead(404).end());
    host.route('/garbage', (_req, res) => void res.writeHead(200).end('not protobuf at all'));
    host.route(
      '/redirect-loop',
      (_req, res) =>
        void res.writeHead(302, { location: '/redirect-loop?api_key=SUPERSECRET123' }).end(),
    );
    host.route('/big', (_req, res) => void res.writeHead(200).end(new Uint8Array(3_000)));
    const bodies: string[] = [];
    for (const mode of modes) {
      const { context, logs } = await setup({
        VEHICLE_POSITIONS_URL: `${host.origin}${mode}?api_key=SUPERSECRET123`,
        TRIP_UPDATES_URL: `${host.origin}${mode}?key=OTHERSECRET456`,
        RT_MAX_BYTES: '1000',
        HISTORY_MEMORY_LIMIT_BYTES: '10000',
      });
      bodies.push((await post('/session/start')).body);
      await vi.waitFor(() => {
        const status = context.session.status().realtime;
        expect(status.vehiclePositions?.error).not.toBeNull();
        expect(status.tripUpdates?.error).not.toBeNull();
      });
      bodies.push((await post('/session/ping')).body, JSON.stringify(context.config), ...logs);
      await app!.close();
      app = undefined;
    }
    const output = bodies.join('\n');
    for (const code of ['http_status_404', 'decode_failed', 'too_many_redirects', 'too_large']) {
      expect(output).toContain(code);
    }
    for (const secret of [
      host.origin,
      '127.0.0.1',
      'SUPERSECRET123',
      'OTHERSECRET456',
      'api_key',
      ...modes.map((m) => `${m}?`),
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
