import type { ScheduleStatus } from '../session/schedule-provider.js';
import type {
  DashboardResponse,
  TripDetailResponse,
  TripListResponse,
} from '@gtfs-rt-debugger/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScheduleLoader } from '../schedule/loader.js';
import type { ScheduleServices } from '../schedule/routes.js';
import { testApp } from '../test-support/app.js';
import { encodeFeed, serveBytes, startFeedHost, type FeedHost } from '../test-support/feeds.js';
import { ROUTES, scenarioApp, type ScenarioApp } from '../test-support/scenario-app.js';
import { miniSchedule, zipOf } from '../test-support/zip.js';

const LISTS = ['active-with-realtime', 'active-without-realtime', 'unscheduled-with-realtime'];
const ENDPOINTS = ['/dashboard', ...LISTS.map((l) => `/trips?list=${l}`), '/trips/any-trip'];

const error = (code: string) =>
  expect.objectContaining({ error: expect.objectContaining({ code }) });

let h: ScenarioApp | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const api = (url: string) => h!.get(`/api/v1${url}`);

describe('query validation', () => {
  let started: ScenarioApp;
  beforeAll(async () => {
    started = await scenarioApp();
    await started.start();
  });
  afterAll(() => started.close());
  const get = (url: string) => started.get(`/api/v1${url}`);

  it.each([
    ['a missing list', '/trips'],
    ['an empty list', '/trips?list='],
    ['an unknown list', '/trips?list=active'],
    ['a list in the wrong case', '/trips?list=Active-With-Realtime'],
    ['a repeated list', '/trips?list=active-with-realtime&list=active-without-realtime'],
    ['a date on a list', '/trips?list=active-with-realtime&serviceDate=20261014'],
    ['another parameter on a list', '/trips?list=active-with-realtime&x=1'],
    ['a parameter without the list', '/trips?serviceDate=20261014'],
    ['a service date on a detail', '/trips/plain-active-vp-tu?serviceDate=20261014'],
    ['any parameter on a detail', '/trips/plain-active-vp-tu?x'],
    ['a list on a detail', '/trips/plain-active-vp-tu?list=active-with-realtime'],
    ['any parameter on the dashboard', '/dashboard?x=1'],
  ])('%s is 400 bad_request', async (_name, url) => {
    const response = await get(url);
    expect(response.status).toBe(400);
    expect(response.json).toEqual(error('bad_request'));
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('accepts the three list names and a detail without parameters', async () => {
    for (const list of LISTS) expect((await get(`/trips?list=${list}`)).status).toBe(200);
    expect((await get('/trips/plain-active-vp-tu')).status).toBe(200);
  });
});

describe('state guards', () => {
  it('answers 409 session_not_active while dormant, and does not wake the server', async () => {
    h = await scenarioApp();
    for (const url of ENDPOINTS) {
      const response = await api(url);
      expect(response.status, url).toBe(409);
      expect(response.json).toEqual(error('session_not_active'));
    }
    expect(h.status().state).toBe('dormant');
    expect(h.status().endedReason).toBeNull();
  });

  const unready = (mode: 'timeout' | 'http500', state: ScheduleStatus['state']) => async () => {
    h = await scenarioApp();
    await h.control({ feed: 'schedule', mode });
    await h.begin();
    await h.polled();
    await vi.waitFor(() => expect(h!.status().schedule.state).toBe(state));

    const dashboard = (await api('/dashboard')).json as DashboardResponse;
    expect(dashboard).toMatchObject({
      agency: null,
      schedule: null,
      lists: null,
      configurationErrors: null,
      realtime: {
        vehicles: expect.any(Number),
        vehiclesWithTripId: expect.any(Number),
        tripUpdates: expect.any(Number),
        activeTripsWithRealtime: null,
      },
    });
    for (const url of ENDPOINTS.slice(1)) {
      const response = await api(url);
      expect(response.status, url).toBe(409);
      expect(response.json).toEqual(error('schedule_not_ready'));
    }
    return h;
  };

  it('serves the dashboard but 409 schedule_not_ready for the rest while the schedule loads', async () => {
    const app = await unready('timeout', 'loading')();
    expect((await api('/dashboard')).status).toBe(200);
    expect(app.status().schedule.state).toBe('loading');
  });

  it('does the same when the schedule failed, and recovers when a start retries it', async () => {
    const app = await unready('http500', 'failed')();
    await app.control({ feed: 'schedule', mode: 'ok' });
    await app.begin();
    await vi.waitFor(() => expect(app.status().schedule.state).toBe('ready'));
    const dashboard = (await api('/dashboard')).json as DashboardResponse;
    expect(dashboard.schedule).not.toBeNull();
    expect((await api(`/trips?list=${LISTS[0]}`)).status).toBe(200);
  });
});

describe('trips that are not there', () => {
  it('404 trip_not_found for a trip in neither the schedule nor the retained realtime data', async () => {
    h = await scenarioApp();
    await h.start();
    for (const id of ['no-such-trip', 'PLAIN-ACTIVE-VP-TU', 'plain-active-vp-tu%20']) {
      const response = await api(`/trips/${id}`);
      expect(response.status, id).toBe(404);
      expect(response.json).toEqual({
        error: { code: 'trip_not_found', message: 'No such trip.' },
      });
    }
  });

  it('serves a trip only the realtime feeds know, with its pings and no scheduled block', async () => {
    h = await scenarioApp();
    await h.start();
    const row = h.scenario.expected.lists.unscheduledWithRealtime.find(
      (r) => r.reason === 'unknown_trip' && r.realtime.hasVehiclePosition,
    )!;
    const detail = (await api(`/trips/${encodeURIComponent(row.tripId)}`))
      .json as TripDetailResponse;
    expect(detail.scheduled).toBeNull();
    expect(detail.realtime.pings.length).toBeGreaterThan(0);
    expect(detail.realtime.pings.map((p) => p.sequence)).toEqual(
      detail.realtime.pings.map((_, i) => i + 1),
    );
  });
});

describe('pings and the inactivity timer', () => {
  it('keeps the sequence numbers of earlier pings as polls add new ones', async () => {
    h = await scenarioApp();
    await h.start();
    const tripId = h.scenario.expected.lists.activeWithRealtime[0]!.tripId;
    const pings = async () =>
      ((await api(`/trips/${tripId}`)).json as TripDetailResponse).realtime.pings;
    const before = await pings();
    expect(before.map((p) => p.sequence)).toEqual([1, 2, 3]);

    await h.poll();
    const after = await pings();
    expect(after.slice(0, 3)).toEqual(before);
    expect(after.map((p) => p.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('data endpoints never reset the inactivity timer, wake a dormant server, or keep pings', async () => {
    h = await scenarioApp({ env: { IDLE_TIMEOUT_MS: '60000' } });
    const app = h;
    await app.start();
    const tripId = app.scenario.expected.lists.activeWithRealtime[0]!.tripId;
    const pings = async () =>
      ((await api(`/trips/${tripId}`)).json as TripDetailResponse).realtime.pings;
    expect((await pings()).length).toBe(3);

    // the last session request was 20 s before the scenario's instant: idle at +40 s
    await app.clock.advanceAsync(30_000);
    for (const url of ENDPOINTS.slice(0, 4)) expect((await api(url)).status, url).toBe(200);
    expect(app.status().state).toBe('active');
    await app.clock.advanceAsync(15_000);
    expect(app.status()).toMatchObject({ state: 'dormant', endedReason: 'idle' });

    for (const url of ENDPOINTS) expect((await api(url)).status, url).toBe(409);
    expect(app.status().state).toBe('dormant');

    // a new activation forgets the old one: the schedule reloads and the pings start over
    await app.begin();
    await vi.waitFor(() => expect(app.status().schedule.state).toBe('ready'));
    await vi.waitFor(async () => expect((await pings()).length).toBe(1));
    expect((await pings()).map((p) => p.sequence)).toEqual([1]);
  });
});

describe('a schedule read from a feed host', () => {
  let host: FeedHost;
  let app: FastifyInstance;

  async function serve(files: Record<string, string | null>) {
    host = await startFeedHost();
    host.route(
      '/schedule.zip',
      serveBytes(zipOf(miniSchedule(files)), { 'content-type': 'application/zip' }),
    );
    host.route('/vp', serveBytes(encodeFeed({ vehicles: 0 })));
    host.route('/tu', serveBytes(encodeFeed({ vehicles: 0 })));
    const built = await testApp<ScheduleServices>(
      {
        SCHEDULE_URL: `${host.origin}/schedule.zip`,
        VEHICLE_POSITIONS_URL: `${host.origin}/vp`,
        TRIP_UPDATES_URL: `${host.origin}/tu`,
        RATE_LIMIT_PER_MIN: '1000000',
      },
      {
        services: ({ config, clock, logger }) => ({
          loader: new ScheduleLoader({ config, clock, logger }),
        }),
        schedule: ({ services }) => services.loader,
        routes: ROUTES,
      },
    );
    app = built.app;
    await app.inject({ method: 'POST', url: '/api/v1/session/start' });
    await vi.waitFor(() => expect(built.context.session.scheduleStatus().state).toBe('ready'));
    return built;
  }
  const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });

  afterEach(async () => {
    await app?.close();
    await host?.close();
  });

  it('round-trips trip IDs with slashes, percent signs, spaces and non-ASCII characters', async () => {
    const ids = [
      'route 66/north',
      'a%b?c#d',
      'a%2Fb',
      '100%',
      'Ångström-東京-🚌',
      'semi;colon&eq=sign',
      'with  two  spaces',
      'x'.repeat(500),
      'y/'.repeat(250),
    ];
    const quoted = (id: string) => `"${id.replaceAll('"', '""')}"`;
    await serve({
      'trips.txt': `route_id,service_id,trip_id,shape_id\n${ids.map((id) => `R1,WK,${quoted(id)},S1`).join('\n')}\n`,
      'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${ids
        .flatMap((id) => [
          `${quoted(id)},05:00:00,05:00:00,A,1`,
          `${quoted(id)},07:00:00,07:00:00,B,2`,
        ])
        .join('\n')}\n`,
    });
    for (const id of ids) {
      const response = await get(`/trips/${encodeURIComponent(id)}`);
      expect(response.statusCode, id.slice(0, 20)).toBe(200);
      const detail = response.json<TripDetailResponse>();
      expect(detail.tripId).toBe(id);
      expect(detail.scheduled?.trip['trip_id']).toBe(id);
    }
    const list = (await get('/trips?list=active-without-realtime')).json<TripListResponse>();
    expect(list.trips.map((t) => t.tripId).sort()).toEqual([...ids].sort());
  });

  it('serves a frequency row that cannot be read with its columns and null values', async () => {
    await serve({
      'trips.txt': 'route_id,service_id,trip_id,shape_id\nR1,WK,FREQ,S1\n',
      'stop_times.txt':
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nFREQ,05:00:00,05:00:00,A,1\nFREQ,05:30:00,05:30:00,B,2\n',
      'frequencies.txt':
        'trip_id,start_time,end_time,headway_secs,exact_times\nFREQ,06:00:00,07:00:00,600,0\nFREQ,noon,later,abc,0\n',
    });
    // 06:00 in Chicago: the first row has an instance starting now
    const start = Date.UTC(2026, 0, 15, 12) / 1000;
    const { scheduled } = (await get('/trips/FREQ')).json<TripDetailResponse>();
    expect(scheduled!.frequencies).toEqual([
      {
        row: {
          trip_id: 'FREQ',
          start_time: '06:00:00',
          end_time: '07:00:00',
          headway_secs: '600',
          exact_times: '0',
        },
        exactTimes: false,
        headwaySecs: 600,
        windowStart: start,
        windowEnd: start + 3600,
        templateDurationSecs: 1800,
        activeNow: true,
        activeInstanceStarts: [start],
      },
      {
        row: {
          trip_id: 'FREQ',
          start_time: 'noon',
          end_time: 'later',
          headway_secs: 'abc',
          exact_times: '0',
        },
        exactTimes: false,
        headwaySecs: null,
        windowStart: null,
        windowEnd: null,
        templateDurationSecs: 1800,
        activeNow: false,
        activeInstanceStarts: [],
      },
    ]);
  });

  it('serves a complete 5,000-row list in one response', async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `trip-${String(i).padStart(5, '0')}`);
    await serve({
      'trips.txt': `route_id,service_id,trip_id,shape_id\n${ids.map((id) => `R1,WK,${id},S1`).join('\n')}\n`,
      'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${ids
        .flatMap((id) => [`${id},05:00:00,05:00:00,A,1`, `${id},07:00:00,07:00:00,B,2`])
        .join('\n')}\n`,
    });
    const response = await get('/trips?list=active-without-realtime');
    expect(response.statusCode).toBe(200);
    expect(response.json<TripListResponse>().trips.map((t) => t.tripId)).toEqual(ids);
  });
});
