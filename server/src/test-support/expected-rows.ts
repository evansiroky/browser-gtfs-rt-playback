import type {
  Expected,
  ExpectedActiveRow,
  ExpectedUnscheduledRow,
  RealtimeInfo,
  Scenario,
} from '@gtfs-rt-debugger/fixtures';
import type {
  DashboardResponse,
  ListName,
  TripClassification,
  TripDetailResponse,
  TripListItem,
  TripListResponse,
} from '@gtfs-rt-debugger/shared';
import { expect } from 'vitest';

const TIMEZONE = 'America/Los_Angeles';

/** The scenario's ground truth as the API's list rows (the spec leaves vehicle ID order open). */
const realtimeOf = (info: RealtimeInfo | null) =>
  info && { ...info, vehicleIds: [...info.vehicleIds].sort() };

export const sorted = (item: TripListItem['realtime']) =>
  item && { ...item, vehicleIds: [...item.vehicleIds].sort() };

export function activeRow(row: ExpectedActiveRow): TripListItem {
  return {
    tripId: row.tripId,
    serviceDate: row.serviceDate,
    routeId: row.routeId,
    routeShortName: row.routeShortName,
    routeLongName: row.routeLongName,
    headsign: row.headsign,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    frequency: row.frequency,
    realtime: realtimeOf(row.realtime),
    reason: null,
  };
}

export function unscheduledRow(row: ExpectedUnscheduledRow): TripListItem {
  return {
    tripId: row.tripId,
    serviceDate: row.serviceDate,
    routeId: row.routeId,
    routeShortName: row.routeShortName,
    routeLongName: row.routeLongName,
    headsign: row.headsign,
    // The span is only known for outside_scheduled_time (api/trips.md).
    scheduledStart: row.scheduledSpan?.start ?? null,
    scheduledEnd: row.scheduledSpan?.end ?? null,
    frequency: row.frequency,
    realtime: realtimeOf(row.realtime),
    reason: row.reason,
  };
}

/** Where the responses come from: the engine itself, or the HTTP API in front of it. */
export interface ScenarioSource {
  dashboard(): DashboardResponse | Promise<DashboardResponse>;
  list(name: ListName): TripListResponse | Promise<TripListResponse>;
  detail(tripId: string): TripDetailResponse | null | Promise<TripDetailResponse | null>;
}

/** Everything the scenario's `expected` says, against what `source` reports. */
export async function expectScenario(
  sc: Scenario,
  source: ScenarioSource,
  label: string,
): Promise<void> {
  const expected: Expected = sc.expected;
  const dashboard = await source.dashboard();

  expect(dashboard.now, label).toBe(Math.floor(sc.now.getTime() / 1000));
  expect(dashboard.agency, label).toEqual({
    names: sc.expected.schedule.agency.names,
    timezone: TIMEZONE,
  });
  expect(dashboard.schedule, label).toEqual({
    tripsToday: expected.stats.tripsToday,
    tripsActiveNow: expected.stats.tripsActiveNow,
  });
  expect(dashboard.realtime, label).toEqual({
    vehicles: expected.stats.vehicles,
    vehiclesWithTripId: expected.stats.vehiclesWithTripId,
    tripUpdates: expected.stats.tripUpdates,
    activeTripsWithRealtime: expected.stats.activeTripsWithRealtime,
  });
  expect(dashboard.lists, label).toEqual({
    activeWithRealtime: expected.lists.activeWithRealtime.length,
    activeWithoutRealtime: expected.lists.activeWithoutRealtime.length,
    unscheduledWithRealtime: expected.lists.unscheduledWithRealtime.length,
  });
  expect(dashboard.configurationErrors?.total, label).toBe(expected.configurationErrors.length);
  expect(
    dashboard.configurationErrors?.items.map(({ code, tripId }) => ({ code, tripId })),
    label,
  ).toEqual(expected.configurationErrors);

  const lists = [
    ['active-with-realtime', expected.lists.activeWithRealtime.map(activeRow)],
    ['active-without-realtime', expected.lists.activeWithoutRealtime.map(activeRow)],
    ['unscheduled-with-realtime', expected.lists.unscheduledWithRealtime.map(unscheduledRow)],
  ] as const;
  const classification = new Map<string, TripClassification[]>();
  for (const [name, rows] of lists) {
    const response = await source.list(name);
    for (const item of response.trips) {
      const entries = classification.get(item.tripId) ?? [];
      entries.push({
        list: name,
        reason: item.reason,
        start: item.scheduledStart,
        end: item.scheduledEnd,
      });
      classification.set(item.tripId, entries);
    }
    expect(response.list).toBe(name);
    expect(response.generatedAt).toBe(dashboard.now);
    expect(
      response.trips.map((t) => ({ ...t, realtime: sorted(t.realtime) })),
      `${label} ${name}`,
    ).toEqual(rows);
  }

  // the detail of every listed trip classifies it exactly as the lists do
  for (const [tripId, entries] of classification) {
    expect((await source.detail(tripId))?.classification, `${label} ${tripId}`).toEqual(entries);
  }
}
