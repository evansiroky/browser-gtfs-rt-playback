import { startFakeFeeds, type FakeFeeds, type Scenario } from '@gtfs-rt-debugger/fixtures';
import type { ScenarioOptions } from '@gtfs-rt-debugger/fixtures';
import type { SessionStatus } from '@gtfs-rt-debugger/shared';
import { vi } from 'vitest';
import { dashboardRoutes } from '../api/dashboard.js';
import { tripsRoutes } from '../api/trips.js';
import { FakeClock, toEpochSeconds } from '../clock.js';
import { ScheduleLoader } from '../schedule/loader.js';
import { shapesRoutes, type ScheduleServices } from '../schedule/routes.js';
import { testApp } from './app.js';

/** Wed 2026-10-14 12:07:42 PDT, the instant the canonical scenario is described at. */
export const NOW = new Date('2026-10-14T19:07:42Z');
const POLL_SECS = 10;
/** The real routes of `main.ts`. */
export const ROUTES = [shapesRoutes, dashboardRoutes, tripsRoutes];

export interface ScenarioApp extends Awaited<ReturnType<typeof testApp<ScheduleServices>>> {
  readonly feeds: FakeFeeds;
  readonly scenario: Scenario;
  /** The scenario's feeds as published at each poll, oldest first (the last is `scenario.now`). */
  readonly published: ReturnType<Scenario['advance']>[];
  get(url: string): Promise<{ status: number; headers: Record<string, unknown>; json: unknown }>;
  status(): SessionStatus;
  /** The fake feeds' control endpoint: `{ feed, mode }` or `{ advance }`. */
  control(body: object): Promise<Response>;
  /** Starts a session through the HTTP API, without waiting for anything. */
  begin(): Promise<void>;
  /** Starts a session, waits for the schedule to load and polls up to the scenario's instant. */
  start(): Promise<void>;
  /** Resolves once both feeds have been polled at the clock's current instant. */
  polled(): Promise<void>;
  /** Moves both the app's clock and the fake feeds on by one poll interval, then polls. */
  poll(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The real app on a fake clock, reading the fixture scenario from the fake feeds server over
 * HTTP. The clock starts `polls` intervals before the scenario's instant; {@link ScenarioApp.start}
 * then polls once per interval up to it, so every response is evaluated at the instant `expected`
 * describes, with `polls` snapshots of each feed behind it and the pings they carry.
 */
export async function scenarioApp(
  options: { polls?: number; scenario?: ScenarioOptions; env?: Record<string, string> } = {},
): Promise<ScenarioApp> {
  const polls = options.polls ?? 3;
  const feeds = await startFakeFeeds({ now: NOW, scenario: options.scenario });
  const scenario = feeds.scenario();
  const control = (body: object) =>
    fetch(feeds.urls.control, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const offsets = Array.from({ length: polls }, (_, i) => (i + 1 - polls) * POLL_SECS);
  await control({ advance: offsets[0] });
  const built = await testApp<ScheduleServices>(
    {
      SCHEDULE_URL: feeds.urls.schedule,
      VEHICLE_POSITIONS_URL: feeds.urls.vehiclePositions,
      TRIP_UPDATES_URL: feeds.urls.tripUpdates,
      // the tests make hundreds of requests on a clock that never moves
      RATE_LIMIT_PER_MIN: '1000000',
      ...options.env,
    },
    {
      clock: new FakeClock(NOW.getTime() + offsets[0]! * 1000),
      services: ({ config, clock, logger }) => ({
        loader: new ScheduleLoader({ config, clock, logger }),
      }),
      schedule: ({ services }) => services.loader,
      routes: ROUTES,
    },
  );
  const { app, clock, context } = built;
  const published = offsets.map((offset) => scenario.advance(offset));

  const polled = () =>
    vi.waitFor(() => {
      const { realtime } = context.session.status();
      for (const feed of [realtime.vehiclePositions, realtime.tripUpdates]) {
        if (feed?.lastSuccessAt !== toEpochSeconds(clock.now())) throw new Error('not polled yet');
      }
    });
  let polledCount = 0;
  const poll = async () => {
    if (polledCount++ > 0) {
      await control({ advance: POLL_SECS });
      await clock.advanceAsync(POLL_SECS * 1000);
    }
    await polled();
  };

  return {
    ...built,
    feeds,
    scenario,
    published,
    status: () => context.session.status(),
    async get(url) {
      const response = await app.inject({ method: 'GET', url });
      return { status: response.statusCode, headers: response.headers, json: response.json() };
    },
    control,
    polled,
    async begin() {
      await app.inject({ method: 'POST', url: '/api/v1/session/start' });
    },
    async start() {
      await app.inject({ method: 'POST', url: '/api/v1/session/start' });
      await vi.waitFor(() => {
        if (context.session.status().schedule.state !== 'ready') throw new Error('loading');
      });
      for (let i = 0; i < polls; i++) await poll();
    },
    poll,
    async close() {
      await app.close();
      await feeds.close();
    },
  };
}
