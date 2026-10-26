import {
  agencyInstant,
  scenario,
  type Expected,
  type ExpectedActiveRow,
  type ExpectedUnscheduledRow,
  type RealtimeInfo,
  type Scenario,
} from '@gtfs-rt-debugger/fixtures';
import type { TripClassification, TripListItem } from '@gtfs-rt-debugger/shared';
import { describe, expect, it } from 'vitest';
import { LoadGuard } from '../schedule/guard.js';
import { MemoryBudget } from '../schedule/memory.js';
import { parseSchedule } from '../schedule/parse.js';
import { chunked } from '../test-support/zip.js';
import { harness } from '../test-support/trips.js';
import { decodeFeed } from '../realtime/snapshot-store.js';

const TIMEZONE = 'America/Los_Angeles';

async function engineFor(sc: Scenario) {
  const store = await parseSchedule(
    chunked(sc.scheduleZip),
    new MemoryBudget(1 << 30),
    LoadGuard.unlimited(new AbortController().signal),
  );
  const h = harness({ now: sc.now, store });
  h.snapshots.add('vehiclePositions', sc.vehiclePositions, decodeFeed(sc.vehiclePositions));
  h.snapshots.add('tripUpdates', sc.tripUpdates, decodeFeed(sc.tripUpdates));
  return h;
}

const realtimeOf = (info: RealtimeInfo | null) =>
  info && { ...info, vehicleIds: [...info.vehicleIds].sort() };

const sorted = (item: TripListItem['realtime']) =>
  item && { ...item, vehicleIds: [...item.vehicleIds].sort() };

function activeRow(row: ExpectedActiveRow): TripListItem {
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

function unscheduledRow(row: ExpectedUnscheduledRow): TripListItem {
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

/** Everything the scenario's `expected` says, against what the engine reports. */
async function expectToMatch(sc: Scenario, label: string): Promise<void> {
  const h = await engineFor(sc);
  const expected: Expected = sc.expected;
  const dashboard = h.engine.dashboard();

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
    const response = h.engine.list(name);
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
    expect(h.engine.detail(tripId)?.classification, `${label} ${tripId}`).toEqual(entries);
  }
}

const at = (date: string, hms: string, options = {}) =>
  scenario(agencyInstant(date, hms, TIMEZONE), options);

describe('the fixture scenario: engine output equals the ground truth', () => {
  it.each([
    ['midday', '20261014', '12:07:42'],
    [
      'just after midnight (yesterday is the service date of the overnight trips)',
      '20261014',
      '00:20:00',
    ],
    ['the first second of the day', '20261014', '00:00:00'],
    ['the last minute of the day', '20261014', '23:59:30'],
    ['evening, when the 23:10 instance is active', '20261014', '23:15:10'],
    ['01:45, after the overnight trips ended', '20261014', '01:45:00'],
    ['a Saturday', '20261017', '09:30:00'],
  ] as const)('%s', async (label, date, hms) => {
    await expectToMatch(at(date, hms), label);
  });

  it('without the configuration errors', async () => {
    await expectToMatch(at('20261014', '12:07:42', { includeMisconfiguredTrip: false }), 'clean');
  });

  describe('daylight-saving changes (America/Los_Angeles)', () => {
    // GTFS times count from noon minus 12 h: the service day of 2026-03-08 starts at 23:00 PST
    // the evening before (a 23-hour day), and that of 2026-11-01 at 01:00 PDT (a 25-hour day).
    it.each([
      ['spring forward, just after midnight', '20260308', '00:20:00'],
      ['spring forward, 01:59 before the gap', '20260308', '01:59:30'],
      ['spring forward, 03:00 after the gap', '20260308', '03:00:30'],
      ['spring forward, midday', '20260308', '12:07:42'],
      ['spring forward, the evening before', '20260307', '23:30:00'],
      ['spring forward, the day after, just after midnight', '20260309', '00:20:00'],
      ['fall back, just after midnight (before the service day starts)', '20261101', '00:20:00'],
      ['fall back, the second after midnight', '20261101', '00:00:30'],
      ['fall back, midday', '20261101', '12:07:42'],
      ['fall back, the day after, just after midnight', '20261102', '00:20:00'],
    ] as const)('%s', async (label, date, hms) => {
      await expectToMatch(at(date, hms), label);
    });

    it.each([
      // 01:15 happens twice on 2026-11-01: first as PDT (08:15Z), then as PST (09:15Z)
      ['fall back, 01:15 PDT (first)', '2026-11-01T08:15:00Z'],
      ['fall back, 01:15 PST (second)', '2026-11-01T09:15:00Z'],
      ['fall back, 00:59 PDT, a minute before the service day starts', '2026-11-01T07:59:30Z'],
      ['fall back, 01:00 PDT, the service day starts', '2026-11-01T08:00:00Z'],
      ['spring forward, 23:00 PST, the service day starts', '2026-03-08T07:00:00Z'],
      ['spring forward, 01:59 PST', '2026-03-08T09:59:30Z'],
      ['spring forward, 03:00 PDT', '2026-03-08T10:00:00Z'],
    ] as const)('%s', async (label, iso) => {
      await expectToMatch(scenario(new Date(iso)), label);
    });
  });

  it('agrees at one instant a minute across the whole of both transition days', async () => {
    // every 53 minutes from 36 h before to 36 h after each change, in UTC
    const changes = ['2026-03-08T10:00:00Z', '2026-11-01T09:00:00Z'];
    for (const change of changes) {
      const base = Date.parse(change);
      for (let offset = -36 * 60; offset <= 36 * 60; offset += 53) {
        const now = new Date(base + offset * 60_000);
        await expectToMatch(scenario(now), now.toISOString());
      }
    }
  }, 120_000);
});
