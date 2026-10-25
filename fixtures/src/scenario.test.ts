import { describe, expect, it } from 'vitest';
import { TIMEZONE } from './catalog.js';
import {
  REASON_ORDER,
  type ExpectedActiveRow,
  type ExpectedUnscheduledRow,
  type RealtimeInfo,
} from './expected.js';
import { decodeFeed } from './rt.js';
import { scenario } from './scenario.js';
import { agencyInstant } from './time.js';

const clock = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleTimeString('en-GB', {
    timeZone: TIMEZONE,
    hourCycle: 'h23',
  });

const rt = (info: RealtimeInfo | null): string =>
  info === null
    ? ''
    : ` ${info.hasVehiclePosition ? 'VP' : '--'}/${info.hasTripUpdate ? 'TU' : '--'}`;

/** `tripId serviceDate start-end [VP/TU]`, with a frequency row's headway appended as `~600`. */
const active = (r: ExpectedActiveRow): string =>
  `${r.tripId} ${r.serviceDate} ${clock(r.scheduledStart)}-${clock(r.scheduledEnd)}` +
  `${r.frequency ? ` ~${r.frequency.headwaySecs}${r.frequency.exactTimes ? 'x' : ''}` : ''}${rt(r.realtime)}`;

const unscheduled = (r: ExpectedUnscheduledRow): string =>
  `${r.reason} ${r.tripId} ${r.serviceDate}` +
  `${r.realtime.startTime ? ` start=${r.realtime.startTime}` : ''}` +
  `${r.scheduledSpan ? ` span=${clock(r.scheduledSpan.start)}-${clock(r.scheduledSpan.end)}` : ''}` +
  `${r.frequency ? ` ~${r.frequency.headwaySecs}` : ''}${rt(r.realtime)}`;

const at = (date: string, hms: string, options = {}) =>
  scenario(agencyInstant(date, hms, TIMEZONE), options);

/*
 * Hand-derived ground truth. Wednesday 2026-10-14, 12:07:42 PDT, so the current minute starts at
 * 12:07:00. Each line below is explained in SCENARIO.md.
 */
describe('scenario at 2026-10-14 12:07:42 (midday)', () => {
  const { expected } = at('20261014', '12:07:42');

  it('counts', () => {
    expect(expected.today).toBe('20261014');
    expect(expected.yesterday).toBe('20261013');
    expect(expected.stats).toEqual({
      tripsToday: 30,
      tripsActiveNow: 12,
      vehicles: 17,
      vehiclesWithTripId: 15,
      tripUpdates: 6,
      activeTripsWithRealtime: 7,
    });
  });

  it('list 1: active with realtime, by start then trip id', () => {
    expect(expected.lists.activeWithRealtime.map(active)).toEqual([
      'plain-active-vp-tu 20261014 11:37:00-12:37:00 VP/TU',
      'freq-nominal 20261014 11:47:00-12:17:00 ~900 VP/--',
      'plain-active-vp 20261014 11:47:00-12:47:00 VP/--',
      'freq-exact 20261014 11:52:00-12:12:00 ~600x VP/--',
      'plain-active-added-service 20261014 11:52:00-12:32:00 VP/--',
      'plain-active-tu 20261014 11:57:00-12:22:00 --/TU',
      'freq-exact 20261014 12:02:00-12:22:00 ~600x --/TU',
    ]);
  });

  it('list 2: active without realtime', () => {
    expect(expected.lists.activeWithoutRealtime.map(active)).toEqual([
      'plain-active-no-rt 20261014 11:27:00-12:12:00',
      'edge-ends-this-minute 20261014 11:37:00-12:07:00',
      'freq-nominal 20261014 12:02:00-12:32:00 ~900',
      'plain-active-missing-shape 20261014 12:02:00-12:57:00',
      'edge-starts-this-minute 20261014 12:07:59-12:37:00',
    ]);
  });

  it('list 3: unscheduled with realtime, by reason then trip id then start', () => {
    expect(expected.lists.unscheduledWithRealtime.map(unscheduled)).toEqual([
      'unknown_trip ghost-tu-trip 20261014 --/TU',
      'unknown_trip ghost-vp-trip 20261014 start=12:02:00 VP/--',
      'configuration_error freq-mixed 20261014 start=12:07:00 VP/--',
      'not_in_service plain-nis-off-weekday 20261014 VP/--',
      'not_in_service plain-nis-removed-today 20261014 VP/--',
      'missing_start_time freq-nominal 20261014 VP/TU',
      'unmatched_start_time freq-exact 20261014 start=11:53:30 ~600 VP/--',
      'outside_scheduled_time freq-exact 20261014 start=12:12:00 span=12:12:00-12:32:00 ~600 VP/--',
      'outside_scheduled_time overnight-from-yesterday 20261013 span=23:30:00-01:30:00 VP/--',
      'outside_scheduled_time plain-future 20261014 span=13:07:00-14:07:00 VP/--',
      'outside_scheduled_time plain-past 20261014 span=10:27:00-11:27:00 VP/TU',
    ]);
  });

  it('configuration errors', () => {
    expect(expected.configurationErrors).toEqual([
      { code: 'mixed_exact_times', tripId: 'freq-mixed' },
    ]);
  });

  it('pins one complete row', () => {
    const row = expected.lists.activeWithRealtime.find((r) => r.tripId === 'plain-active-vp-tu');
    expect(row).toEqual({
      tripId: 'plain-active-vp-tu',
      serviceDate: '20261014',
      routeId: 'R1',
      routeShortName: '1',
      routeLongName: 'Market & Van Ness, Eastbound',
      headsign: 'Downtown, via Market',
      scheduledStart: Date.parse('2026-10-14T18:37:00Z') / 1000,
      scheduledEnd: Date.parse('2026-10-14T19:37:00Z') / 1000,
      frequency: null,
      realtime: {
        vehicleIds: ['bus-101'],
        hasVehiclePosition: true,
        hasTripUpdate: true,
        startTime: null,
      },
    });
    const instance = expected.lists.activeWithoutRealtime.find((r) => r.tripId === 'freq-nominal');
    expect(instance?.frequency).toEqual({
      exactTimes: false,
      headwaySecs: 900,
      windowStart: Date.parse('2026-10-14T18:17:00Z') / 1000,
      windowEnd: Date.parse('2026-10-14T19:17:00Z') / 1000,
    });
  });
});

/*
 * 00:20 on the same day: the current minute starts at 00:20:00 and yesterday's 23:30-25:30 trip is
 * still running. Trips placed "before now" are clamped to start at 00:00:00 and the past trip does
 * not fit before midnight, so it is absent.
 */
describe('scenario at 2026-10-14 00:20:00 (after midnight)', () => {
  const { expected } = at('20261014', '00:20:00');

  it('counts', () => {
    expect(expected.stats).toEqual({
      tripsToday: 25,
      tripsActiveNow: 13,
      vehicles: 16,
      vehiclesWithTripId: 14,
      tripUpdates: 5,
      activeTripsWithRealtime: 8,
    });
  });

  it("lists yesterday's overnight trip as active, on yesterday's service date, and not as scheduled today", () => {
    expect(expected.lists.activeWithRealtime.map(active)).toEqual([
      'overnight-from-yesterday 20261013 23:30:00-01:30:00 VP/--',
      'freq-nominal 20261014 00:00:00-00:30:00 ~900 VP/--',
      'plain-active-vp 20261014 00:00:00-01:00:00 VP/--',
      'plain-active-vp-tu 20261014 00:00:00-00:50:00 VP/TU',
      'freq-exact 20261014 00:05:00-00:25:00 ~600x VP/--',
      'plain-active-added-service 20261014 00:05:00-00:45:00 VP/--',
      'plain-active-tu 20261014 00:10:00-00:35:00 --/TU',
      'freq-exact 20261014 00:15:00-00:35:00 ~600x --/TU',
    ]);
    expect(expected.lists.activeWithoutRealtime.map(active)).toEqual([
      'edge-ends-this-minute 20261014 00:00:00-00:20:00',
      'plain-active-no-rt 20261014 00:00:00-00:25:00',
      'freq-nominal 20261014 00:15:00-00:45:00 ~900',
      'plain-active-missing-shape 20261014 00:15:00-01:10:00',
      'edge-starts-this-minute 20261014 00:20:59-00:50:00',
    ]);
  });

  it('list 3 loses the overnight and past trips', () => {
    expect(expected.lists.unscheduledWithRealtime.map(unscheduled)).toEqual([
      'unknown_trip ghost-tu-trip 20261014 --/TU',
      'unknown_trip ghost-vp-trip 20261014 start=00:15:00 VP/--',
      'configuration_error freq-mixed 20261014 start=00:20:00 VP/--',
      'not_in_service plain-nis-off-weekday 20261014 VP/--',
      'not_in_service plain-nis-removed-today 20261014 VP/--',
      'missing_start_time freq-nominal 20261014 VP/TU',
      'unmatched_start_time freq-exact 20261014 start=00:06:30 ~600 VP/--',
      'outside_scheduled_time freq-exact 20261014 start=00:25:00 span=00:25:00-00:45:00 ~600 VP/--',
      'outside_scheduled_time plain-future 20261014 span=01:20:00-02:20:00 VP/--',
    ]);
  });
});

describe('daylight saving days', () => {
  // GTFS times count from noon minus 12 h, so a service day that changes length still places the
  // same trips around "now" and the lists read the same on the wall clock.
  const reference = at('20261014', '12:07:42').expected;
  it.each([
    ['20260308', 'spring forward'],
    ['20261101', 'fall back'],
  ])('%s (%s) lists the same trips at the same wall-clock times', (date) => {
    const { expected } = at(date, '12:07:42');
    const normalize = (rows: string[], from: string, to: string): string[] =>
      rows.map((r) => r.replaceAll(from, to));
    expect(expected.stats).toEqual(reference.stats);
    for (const list of ['activeWithRealtime', 'activeWithoutRealtime'] as const) {
      expect(normalize(expected.lists[list].map(active), expected.today, 'D')).toEqual(
        normalize(reference.lists[list].map(active), reference.today, 'D'),
      );
    }
  });
});

describe('options', () => {
  it('leaves out the misconfigured trip, its vehicle and its configuration error', () => {
    const full = at('20261014', '12:07:42');
    const without = at('20261014', '12:07:42', { includeMisconfiguredTrip: false });
    expect(without.expected.configurationErrors).toEqual([]);
    expect(without.expected.stats.vehicles).toBe(full.expected.stats.vehicles - 1);
    expect(without.expected.lists.unscheduledWithRealtime.map((r) => r.reason)).not.toContain(
      'configuration_error',
    );
    expect(without.schedule.trips.map((t) => t.row.trip_id)).not.toContain('freq-mixed');
    expect(without.expected.stats.tripsToday).toBe(full.expected.stats.tripsToday);
  });

  it('is deterministic', () => {
    const a = at('20261014', '12:07:42');
    const b = at('20261014', '12:07:42');
    expect(b.scheduleZip).toEqual(a.scheduleZip);
    expect(b.vehiclePositions).toEqual(a.vehiclePositions);
    expect(b.tripUpdates).toEqual(a.tripUpdates);
    expect(b.expected).toEqual(a.expected);
  });

  it('depends on the current minute, not on the seconds', () => {
    const a = at('20261014', '12:07:00');
    const b = at('20261014', '12:07:59');
    expect(b.expected).toEqual(a.expected);
    expect(b.scheduleZip).toEqual(a.scheduleZip);
  });
});

describe('scenario invariants over many instants', () => {
  /** Midnight, the overnight trip's end, DST changes, and a stride across ordinary days. */
  const instants: Date[] = [];
  for (const date of ['20261014', '20260308', '20261101']) {
    for (let minutes = 0; minutes < 26 * 60; minutes += 37) {
      instants.push(
        agencyInstant(
          date,
          `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, '0')}:13`,
          TIMEZONE,
        ),
      );
    }
  }
  for (const hms of [
    '00:00:00',
    '00:00:30',
    '01:29:59',
    '01:30:00',
    '01:30:30',
    '01:31:00',
    '02:00:00',
    '23:59:59',
  ]) {
    instants.push(agencyInstant('20261014', hms, TIMEZONE));
  }

  it.each(instants.map((d) => [d.toISOString(), d] as const))('%s', (_label, now) => {
    const sc = scenario(now);
    const { expected } = sc;
    const { lists, stats } = expected;
    expect(stats.tripsActiveNow).toBe(
      lists.activeWithRealtime.length + lists.activeWithoutRealtime.length,
    );
    expect(stats.activeTripsWithRealtime).toBe(lists.activeWithRealtime.length);
    expect(lists.activeWithRealtime.every((r) => r.realtime !== null)).toBe(true);
    expect(lists.activeWithoutRealtime.every((r) => r.realtime === null)).toBe(true);
    expect(stats.tripsToday).toBeGreaterThanOrEqual(
      [...lists.activeWithRealtime, ...lists.activeWithoutRealtime].filter(
        (r) => r.serviceDate === expected.today,
      ).length,
    );

    const keys = [...lists.activeWithRealtime, ...lists.activeWithoutRealtime].map(
      (r) => `${r.tripId}@${r.scheduledStart}`,
    );
    expect(new Set(keys).size).toBe(keys.length);

    const reasons = lists.unscheduledWithRealtime.map((r) => REASON_ORDER.indexOf(r.reason));
    expect(reasons).toEqual([...reasons].sort((a, b) => a - b));
    expect(lists.unscheduledWithRealtime.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['unknown_trip', 'configuration_error', 'not_in_service']),
    );

    expect(decodeFeed(sc.vehiclePositions).entity).toHaveLength(stats.vehicles);
    expect(decodeFeed(sc.tripUpdates).entity).toHaveLength(stats.tripUpdates);
  });
});
