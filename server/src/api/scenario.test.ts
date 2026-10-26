import {
  decodeFeed,
  serviceDayStart,
  TIMEZONE,
  toSeconds,
  type FeedMessage,
} from '@gtfs-rt-debugger/fixtures';
import type {
  DashboardResponse,
  ListName,
  TripDetailResponse,
  TripListResponse,
} from '@gtfs-rt-debugger/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DASHBOARD, TRIP_DETAIL, TRIP_LIST } from '../test-support/api-shapes.js';
import { expectScenario, type ScenarioSource } from '../test-support/expected-rows.js';
import { scenarioApp, type ScenarioApp } from '../test-support/scenario-app.js';
import { violations } from '../test-support/shape.js';

let h: ScenarioApp;

/** A 200 response body, after the conventions every response follows. */
async function ok<T>(url: string): Promise<T> {
  const response = await h.get(`/api/v1${url}`);
  expect(response.status, url).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-type']).toMatch(/^application\/json; charset=utf-8/);
  return response.json as T;
}

const source: ScenarioSource = {
  dashboard: () => ok<DashboardResponse>('/dashboard'),
  list: (name: ListName) => ok<TripListResponse>(`/trips?list=${name}`),
  async detail(tripId) {
    const response = await h.get(`/api/v1/trips/${encodeURIComponent(tripId)}`);
    if (response.status !== 200 && response.status !== 404)
      throw new Error(`${tripId}: ${response.status}`);
    return response.status === 404 ? null : (response.json as TripDetailResponse);
  },
};
const detail = async (tripId: string) => {
  const trip = await source.detail(tripId);
  if (!trip) throw new Error(`no detail for ${tripId}`);
  return trip;
};

beforeAll(async () => {
  h = await scenarioApp({ polls: 3 });
  await h.start();
});
afterAll(() => h.close());

describe('the fixture scenario over HTTP', () => {
  it('the dashboard and the three lists equal the ground truth, in the specified shapes', async () => {
    await expectScenario(h.scenario, source, 'http');
    expect(violations(await source.dashboard(), DASHBOARD)).toEqual([]);
    for (const list of [
      'active-with-realtime',
      'active-without-realtime',
      'unscheduled-with-realtime',
    ] as const) {
      expect(violations(await source.list(list), TRIP_LIST), list).toEqual([]);
    }
  });

  it('serves a trip with frequency_too_dense in the dashboard and the detail', async () => {
    const dashboard = await source.dashboard();
    const dense = dashboard.configurationErrors!.items.find(
      (item) => item.tripId === 'cfg-too-dense',
    );
    expect(dense).toMatchObject({
      code: 'frequency_too_dense',
      message: expect.stringContaining('2,000'),
    });
    const trip = await detail('cfg-too-dense');
    expect(trip.scheduled!.configurationErrors).toEqual([
      { code: 'frequency_too_dense', message: dense!.message },
    ]);
    expect(trip.scheduled!.frequencies).toEqual([
      expect.objectContaining({ headwaySecs: 1, activeNow: false, activeInstanceStarts: [] }),
    ]);
    expect(trip.classification).toEqual([
      { list: 'unscheduled-with-realtime', reason: 'configuration_error', start: null, end: null },
    ]);
  });

  describe('trip detail', () => {
    it('describes every scheduled trip as the schedule and the lists do', async () => {
      const { expected: truth } = h.scenario;
      const { schedule } = truth;
      const active = [...truth.lists.activeWithRealtime, ...truth.lists.activeWithoutRealtime];
      for (const row of schedule.trips) {
        const id = row['trip_id']!;
        const trip = await detail(id);
        expect(violations(trip, TRIP_DETAIL), id).toEqual([]);
        const scheduled = trip.scheduled!;
        expect(scheduled.trip, id).toEqual(row);
        expect(scheduled.route, id).toEqual(
          schedule.routes.find((route) => route['route_id'] === row['route_id']) ?? null,
        );
        expect(scheduled.shapeId, id).toBe(row['shape_id'] || null);
        expect(scheduled.configurationErrors.map((e) => e.code).sort(), id).toEqual(
          truth.configurationErrors
            .filter((e) => e.tripId === id)
            .map((e) => e.code)
            .sort(),
        );

        const entries = active.filter((r) => r.tripId === id);
        expect(scheduled.activeNow, id).toBe(entries.length > 0);
        const rows = schedule.frequencies.filter((f) => f['trip_id'] === id);
        if (rows.length === 0) {
          expect(scheduled.frequencies, id).toBeNull();
        } else {
          expect(
            scheduled.frequencies!.map((f) => f.row),
            id,
          ).toEqual(rows);
          for (const f of scheduled.frequencies!) {
            const starts = entries
              .filter((e) => f.windowStart !== null && e.frequency?.windowStart === f.windowStart)
              .map((e) => e.scheduledStart)
              .sort((a, b) => a - b);
            expect(f.activeInstanceStarts, id).toEqual(starts);
            expect(f.activeNow, id).toBe(starts.length > 0);
          }
        }

        const operates = schedule.operates[row['service_id']!]!;
        const known =
          trip.serviceDate === truth.today
            ? operates.today
            : trip.serviceDate === truth.yesterday
              ? operates.yesterday
              : undefined;
        if (known !== undefined) expect(scheduled.operatesOnServiceDate, id).toBe(known);
        const times = schedule.tripTimes[id];
        if (rows.length === 0 && known !== undefined) {
          const dayStart = serviceDayStart(trip.serviceDate, TIMEZONE).getTime() / 1000;
          expect([scheduled.start, scheduled.end], id).toEqual(
            known && times ? [dayStart + times.startSecs, dayStart + times.endSecs] : [null, null],
          );
        }
      }
    });

    it('describes a trip only the realtime feeds know, without a scheduled block', async () => {
      const unknown = h.scenario.expected.lists.unscheduledWithRealtime.filter(
        (row) => row.reason === 'unknown_trip',
      );
      expect(unknown.length).toBeGreaterThan(0);
      for (const row of unknown) {
        const trip = await detail(row.tripId);
        expect(violations(trip, TRIP_DETAIL), row.tripId).toEqual([]);
        expect(trip.scheduled).toBeNull();
        expect(trip.classification).toEqual([
          { list: 'unscheduled-with-realtime', reason: 'unknown_trip', start: null, end: null },
        ]);
        expect(
          trip.realtime.pings.length > 0 || trip.realtime.tripUpdate !== null,
          row.tripId,
        ).toBe(true);
      }
    });

    it('returns every ping of the retained snapshots with sequence numbers in first-receipt order', async () => {
      const expectedPings = pingsOf(h);
      expect(expectedPings.size).toBeGreaterThan(10);
      for (const [tripId, pings] of expectedPings) {
        const { realtime } = await detail(tripId);
        expect(
          realtime.pings.map((p) => ({
            sequence: p.sequence,
            receivedAt: p.receivedAt,
            timestamp: p.timestamp,
            vehicleId: p.vehicleId,
            latitude: p.latitude,
            longitude: p.longitude,
            stopId: p.stopId,
            startTime: p.startTime,
            startDate: p.startDate,
          })),
          tripId,
        ).toEqual(pings);
      }
      // each of the three polls added its own pings for the moving vehicles
      expect([...expectedPings.values()].some((pings) => pings.length === 3)).toBe(true);
    });

    it('returns the newest trip update of the latest snapshot, or none', async () => {
      const latest = latestUpdates(decodeFeed(h.published.at(-1)!.tripUpdates));
      expect(latest.size).toBeGreaterThan(0);
      for (const [tripId, update] of latest) {
        expect((await detail(tripId)).realtime.tripUpdate, tripId).toEqual(update);
      }
      const noUpdate = [...pingsOf(h).keys()].find((tripId) => !latest.has(tripId))!;
      expect((await detail(noUpdate)).realtime.tripUpdate).toBeNull();
    });
  });
});

interface ExpectedPing {
  sequence: number;
  receivedAt: number;
  timestamp: number;
  vehicleId: string;
  latitude: number | null;
  longitude: number | null;
  stopId: string | null;
  startTime: string | null;
  startDate: string | null;
}

/** The pings the published vehicle position feeds carry, numbered in order of first receipt. */
function pingsOf(app: ScenarioApp): Map<string, ExpectedPing[]> {
  const byTrip = new Map<string, Map<string, ExpectedPing>>();
  app.published.forEach((feeds, index) => {
    const message = decodeFeed(feeds.vehiclePositions);
    const receivedAt =
      app.scenario.now.getTime() / 1000 + (index - (app.published.length - 1)) * 10;
    for (const entity of message.entity) {
      const position = entity.vehicle;
      const tripId = position?.trip?.tripId;
      if (!position || !tripId) continue;
      const vehicleId = position.vehicle?.id || entity.id;
      const timestamp = toSeconds(position.timestamp) || toSeconds(message.header.timestamp)!;
      const pings = byTrip.get(tripId) ?? new Map<string, ExpectedPing>();
      byTrip.set(tripId, pings);
      const key = `${vehicleId}\0${timestamp}`;
      if (pings.has(key)) continue;
      pings.set(key, {
        sequence: pings.size + 1,
        receivedAt,
        timestamp,
        vehicleId,
        latitude: position.position?.latitude ?? null,
        longitude: position.position?.longitude ?? null,
        stopId: position.stopId || null,
        startTime: position.trip?.startTime || null,
        startDate: position.trip?.startDate || null,
      });
    }
  });
  return new Map([...byTrip].map(([tripId, pings]) => [tripId, [...pings.values()]]));
}

/** What the detail reports for each trip with an update: the newest by timestamp, else the first. */
function latestUpdates(message: FeedMessage) {
  const best = new Map<string, NonNullable<FeedMessage['entity'][number]['tripUpdate']>>();
  for (const entity of message.entity) {
    const update = entity.tripUpdate;
    const tripId = update?.trip?.tripId;
    if (!update || !tripId) continue;
    const known = best.get(tripId);
    if (!known || (toSeconds(update.timestamp) ?? 0) > (toSeconds(known.timestamp) ?? 0)) {
      best.set(tripId, update);
    }
  }
  return new Map(
    [...best].map(([tripId, update]) => [
      tripId,
      {
        feedTimestamp: toSeconds(message.header.timestamp),
        timestamp: toSeconds(update.timestamp),
        delay: update.delay ?? null,
        vehicleId: update.vehicle?.id || null,
        startTime: update.trip?.startTime || null,
        scheduleRelationship: expect.any(String) as unknown as string | null,
        stopTimeUpdateCount: update.stopTimeUpdate?.length ?? 0,
      },
    ]),
  );
}
