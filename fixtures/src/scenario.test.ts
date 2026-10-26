import { describe, expect, it } from 'vitest';
import { TIMEZONE } from './catalog.js';
import {
  REASON_ORDER,
  type Expected,
  type ExpectedActiveRow,
  type ExpectedUnscheduledRow,
  type RealtimeInfo,
} from './expected.js';
import { decodeFeed, toSeconds } from './rt.js';
import { scenario } from './scenario.js';
import { agencyInstant, parseHms } from './time.js';

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
  `${r.scheduledSpan === null ? ' span=null' : ''}` +
  `${r.scheduledSpan ? ` span=${clock(r.scheduledSpan.start)}-${clock(r.scheduledSpan.end)}` : ''}` +
  `${r.frequency ? ` ~${r.frequency.headwaySecs}` : ''}${rt(r.realtime)}`;

const at = (date: string, hms: string, options = {}) =>
  scenario(agencyInstant(date, hms, TIMEZONE), options);

/*
 * Hand-derived ground truth. Wednesday 2026-10-14, 12:07:42 PDT, so the current minute starts at
 * 12:07:00. Each line below is explained in SCENARIO.md.
 */
describe('scenario at 2026-10-14 12:07:42 (midday)', () => {
  const sc = at('20261014', '12:07:42');
  const { expected } = sc;

  it('counts', () => {
    expect(expected.today).toBe('20261014');
    expect(expected.yesterday).toBe('20261013');
    expect(expected.stats).toEqual({
      tripsToday: 136,
      tripsActiveNow: 24,
      vehicles: 45,
      vehiclesWithTripId: 43,
      tripUpdates: 10,
      activeTripsWithRealtime: 13,
    });
  });

  it('list 1: active with realtime, by start then trip id', () => {
    expect(expected.lists.activeWithRealtime.map(active)).toEqual([
      'plain-spans-two-days 20261014 00:00:00-16:00:00 VP/--',
      'plain-active-vp-tu 20261014 11:37:00-12:37:00 VP/TU',
      'freq-nominal 20261014 11:47:00-12:17:00 ~900 VP/--',
      'plain-active-vp 20261014 11:47:00-12:47:00 VP/--',
      'freq-exact 20261014 11:52:00-12:12:00 ~600x VP/--',
      'plain-active-added-service 20261014 11:52:00-12:32:00 VP/--',
      'plain-active-start-times 20261014 11:52:00-12:42:00 VP/TU',
      'plain-active-zero-timestamp 20261014 11:53:40-12:37:00 VP/TU',
      'plain-active-no-timestamp 20261014 11:55:20-12:35:20 VP/--',
      'plain-active-tu 20261014 11:57:00-12:22:00 --/TU',
      'plain-active-empty-route 20261014 11:58:40-12:38:40 VP/--',
      'freq-exact 20261014 12:02:00-12:22:00 ~600x --/TU',
      'freq-nominal 20261014 12:07:00-12:37:00 ~600 VP/--',
    ]);
  });

  it('list 2: active without realtime', () => {
    expect(expected.lists.activeWithoutRealtime.map(active)).toEqual([
      'plain-active-no-rt 20261014 11:27:00-12:12:00',
      'edge-ends-this-minute 20261014 11:37:00-12:07:00',
      'freq-overlapping-rows 20261014 11:50:00-12:10:00 ~600',
      'freq-nominal 20261014 11:57:00-12:27:00 ~600',
      'plain-ref-yesterday 20261014 11:57:00-12:27:00',
      'freq-long-window 20261014 12:00:00-12:30:00 ~3600',
      'freq-overlapping-rows 20261014 12:00:00-12:20:00 ~600',
      'plain-active-missing-shape 20261014 12:02:00-12:57:00',
      'plain-ref-tomorrow 20261014 12:02:00-12:32:00',
      'plain-ref-two-dates 20261014 12:02:00-12:32:00',
      'edge-starts-this-minute 20261014 12:07:59-12:37:00',
    ]);
  });

  it('list 3: unscheduled with realtime, by reason then trip id then start', () => {
    expect(expected.lists.unscheduledWithRealtime.map(unscheduled)).toEqual([
      'unknown_trip ghost-known-route-tu-trip 20261014 span=null --/TU',
      'unknown_trip ghost-known-route-vp-trip 20261014 span=null VP/--',
      'unknown_trip ghost-tu-trip 20261014 span=null --/TU',
      'unknown_trip ghost-vp-trip 20261014 start=12:02:00 span=null VP/--',
      'configuration_error cfg-freq-first-stop-untimed 20261014 start=12:00:00 span=null VP/--',
      'configuration_error cfg-last-stop-untimed 20261014 span=null VP/TU',
      'configuration_error cfg-mixed-and-no-stop-times 20261014 span=null VP/--',
      'configuration_error cfg-no-stop-times 20261014 span=null VP/--',
      'configuration_error cfg-too-dense 20261014 start=12:07:00 span=null VP/--',
      'configuration_error freq-mixed 20261014 start=12:07:00 span=null VP/--',
      'configuration_error freq-mixed-removed-today 20261014 span=null VP/--',
      'not_in_service freq-nis 20261014 VP/--',
      'not_in_service freq-nis 20261014 start=03:33:33 VP/--',
      'not_in_service plain-nis-off-weekday 20261014 VP/--',
      'not_in_service plain-nis-removed-today 20261014 VP/--',
      'missing_start_time freq-nominal 20261014 VP/TU',
      'unmatched_start_time freq-exact 20261014 start=11:53:30 ~600 VP/--',
      'unmatched_start_time freq-exact 20261014 start=13:22:00 VP/--',
      'unmatched_start_time freq-nominal 20261014 start=11:48:30 ~900 VP/--',
      'unmatched_start_time freq-nominal 20261014 start=11:58:30 ~600 VP/--',
      'outside_scheduled_time freq-exact 20261014 start=12:12:00 span=12:12:00-12:32:00 ~600 VP/--',
      // the instance both rows produce, described by the first row
      'outside_scheduled_time freq-overlapping-rows 20261014 start=09:00:00 span=09:00:00-09:20:00 ~600 VP/--',
      'outside_scheduled_time freq-overnight 20261014 start=23:10:00 span=23:10:00-23:30:00 ~600 VP/--',
      'outside_scheduled_time freq-overnight 20261014 start=24:10:00 span=00:10:00-00:30:00 ~600 VP/--',
      'outside_scheduled_time overnight-daily 20261014 span=23:30:00-01:30:00 VP/--',
      'outside_scheduled_time overnight-from-yesterday 20261013 span=23:30:00-01:30:00 VP/--',
      'outside_scheduled_time plain-future 20261014 span=13:07:00-14:07:00 VP/--',
      'outside_scheduled_time plain-past 20261014 span=10:27:00-11:27:00 VP/TU',
      'outside_scheduled_time plain-ref-tomorrow 20261015 span=12:02:00-12:32:00 VP/--',
      // two references, to yesterday and to tomorrow: one row, on the later date
      'outside_scheduled_time plain-ref-two-dates 20261015 span=12:02:00-12:32:00 VP/--',
      'outside_scheduled_time plain-ref-yesterday 20261013 span=11:57:00-12:27:00 VP/--',
    ]);
  });

  it('configuration errors', () => {
    // trips.txt order; a trip with both problems is listed under both codes, mixed first
    expect(expected.configurationErrors).toEqual([
      { code: 'mixed_exact_times', tripId: 'freq-mixed' },
      { code: 'mixed_exact_times', tripId: 'freq-mixed-removed-today' },
      { code: 'unusable_stop_times', tripId: 'cfg-no-stop-times' },
      { code: 'unusable_stop_times', tripId: 'cfg-last-stop-untimed' },
      { code: 'unusable_stop_times', tripId: 'cfg-freq-first-stop-untimed' },
      { code: 'mixed_exact_times', tripId: 'cfg-mixed-and-no-stop-times' },
      { code: 'unusable_stop_times', tripId: 'cfg-mixed-and-no-stop-times' },
      { code: 'frequency_too_dense', tripId: 'cfg-too-dense' },
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
        // two vehicles on one trip ID, plus the vehicle only the trip update names
        vehicleIds: ['bus-101', 'bus-102', 'tu-unit-1'],
        hasVehiclePosition: true,
        hasTripUpdate: true,
        startTime: null,
        // the newer of the two vehicle timestamps, not the feed timestamp
        lastSeenAt: Date.parse('2026-10-14T19:07:42Z') / 1000 - 5,
      },
    });
    const instance = expected.lists.activeWithoutRealtime.find((r) => r.tripId === 'freq-nominal');
    expect(instance?.frequency).toEqual({
      exactTimes: false,
      headwaySecs: 600,
      windowStart: Date.parse('2026-10-14T18:57:00Z') / 1000,
      windowEnd: Date.parse('2026-10-14T19:47:00Z') / 1000,
    });
  });

  it('looks the route of an unknown trip up in routes.txt, and leaves the names null when the route is unknown', () => {
    const names = (id: string) => {
      const r = expected.lists.unscheduledWithRealtime.find((x) => x.tripId === id)!;
      return [r.reason, r.routeId, r.routeShortName, r.routeLongName, r.headsign];
    };
    // R2 and R3 are in routes.txt; R-GHOST is not; a reference without a route has none
    expect(names('ghost-known-route-vp-trip')).toEqual([
      'unknown_trip',
      'R2',
      '14',
      'Mission',
      null,
    ]);
    expect(names('ghost-known-route-tu-trip')).toEqual([
      'unknown_trip',
      'R3',
      'NX',
      'Embarcadero "Night" Express',
      null,
    ]);
    expect(names('ghost-vp-trip')).toEqual(['unknown_trip', 'R-GHOST', null, null, null]);
    expect(names('ghost-tu-trip')).toEqual(['unknown_trip', null, null, null, null]);
  });

  it('gives the trips without usable stop times no entries and the reason configuration_error', () => {
    const cfg = expected.lists.unscheduledWithRealtime.filter((r) => r.tripId.startsWith('cfg-'));
    expect(cfg.map((r) => [r.tripId, r.reason, r.frequency, r.scheduledSpan])).toEqual([
      // its reference names 12:00:00, in the window of its only row: still no frequency
      ['cfg-freq-first-stop-untimed', 'configuration_error', null, null],
      ['cfg-last-stop-untimed', 'configuration_error', null, null],
      ['cfg-mixed-and-no-stop-times', 'configuration_error', null, null],
      ['cfg-no-stop-times', 'configuration_error', null, null],
      // a row of one-second headways over a two-hour template: refused, not enumerated
      ['cfg-too-dense', 'configuration_error', null, null],
    ]);
    const listed = [
      ...expected.lists.activeWithRealtime,
      ...expected.lists.activeWithoutRealtime,
    ].map((r) => r.tripId);
    expect(listed.filter((id) => id.startsWith('cfg-'))).toEqual([]);
    // each of them would otherwise be active or scheduled today, so the counts leave them out
    expect(expected.stats.tripsToday).toBe(
      at('20261014', '12:07:42', { includeMisconfiguredTrip: false }).expected.stats.tripsToday,
    );
  });

  it('identifies entries by trip, and for an instance by its start instant', () => {
    const rows = [...expected.lists.activeWithRealtime, ...expected.lists.activeWithoutRealtime];
    const of = (id: string) => rows.filter((r) => r.tripId === id);
    // a 40 h plain trip runs on both candidate dates: one entry, on today's
    expect(of('plain-spans-two-days').map((r) => r.serviceDate)).toEqual(['20261014']);
    // two rows on one headway grid, windows 06:00-13:00 and 09:00-15:00: the instants 11:50 and
    // 12:00 are each produced by both rows, and are one entry each
    expect(of('freq-overlapping-rows').map((r) => r.scheduledStart)).toEqual([
      Date.parse('2026-10-14T18:50:00Z') / 1000,
      Date.parse('2026-10-14T19:00:00Z') / 1000,
    ]);
    // a window to 30:00:00: only today's 12:00 instance is running at midday
    expect(of('freq-long-window')).toHaveLength(1);
  });

  it('shows the first start_time of the references behind a row, vehicle positions first', () => {
    const row = expected.lists.activeWithRealtime.find(
      (r) => r.tripId === 'plain-active-start-times',
    )!;
    expect(row.realtime).toMatchObject({
      startTime: '10:00:00',
      hasVehiclePosition: true,
      hasTripUpdate: true,
    });
    expect(row.realtime!.vehicleIds).toHaveLength(2);
  });

  it('takes the route of the reference when trips.txt has an empty route_id', () => {
    const row = expected.lists.activeWithRealtime.find(
      (r) => r.tripId === 'plain-active-empty-route',
    )!;
    expect([row.routeId, row.routeShortName, row.routeLongName, row.headsign]).toEqual([
      'R2',
      '14',
      'Mission',
      'Daly City',
    ]);
  });

  it('puts two references to other days than the active entry in one row, on the later date', () => {
    const rows = expected.lists.unscheduledWithRealtime.filter(
      (r) => r.tripId === 'plain-ref-two-dates',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serviceDate: '20261015',
      reason: 'outside_scheduled_time',
      scheduledSpan: {
        start: Date.parse('2026-10-15T19:02:00Z') / 1000,
        end: Date.parse('2026-10-15T19:32:00Z') / 1000,
      },
    });
    expect(rows[0]!.realtime.vehicleIds).toHaveLength(2);
  });

  it('pins what the spec says is null: unknown trips and configuration errors', () => {
    const rows = expected.lists.unscheduledWithRealtime;
    for (const r of rows.filter(
      (r) => r.reason === 'unknown_trip' || r.reason === 'configuration_error',
    )) {
      expect(r.scheduledSpan, r.tripId).toBeNull();
      expect(r.frequency, r.tripId).toBeNull();
    }
    expect(
      rows.filter((r) => r.reason === 'not_in_service').every((r) => !('scheduledSpan' in r)),
    ).toBe(true);
  });

  it('takes the route ID of an unknown trip from the reference, and nothing else', () => {
    const ghost = expected.lists.unscheduledWithRealtime.find((r) => r.tripId === 'ghost-vp-trip');
    expect(ghost).toMatchObject({
      routeId: 'R-GHOST',
      routeShortName: null,
      routeLongName: null,
      headsign: null,
    });
    const other = expected.lists.unscheduledWithRealtime.find((r) => r.tripId === 'ghost-tu-trip');
    expect(other?.routeId).toBeNull();
  });

  it('puts the newest vehicle timestamp, else the feed timestamp, in lastSeenAt', () => {
    const feed = sc.now.getTime() / 1000;
    const vp = decodeFeed(sc.vehiclePositions).entity.map((e) => e.vehicle!);
    const stamp = (id: string): number =>
      toSeconds(vp.find((v) => v.vehicle?.id === id)!.timestamp)!;
    const row = (tripId: string, startTime: string | null) =>
      [...expected.lists.activeWithRealtime, ...expected.lists.unscheduledWithRealtime].find(
        (r) => r.tripId === tripId && r.realtime!.startTime === startTime,
      )!.realtime!;
    expect(row('plain-active-vp-tu', null).lastSeenAt).toBe(
      Math.max(stamp('bus-101'), stamp('bus-102')),
    );
    expect(row('plain-active-vp', null).lastSeenAt).toBe(stamp('bus-103'));
    // trip update only: the trip updates header, which trails the vehicle positions one by 3 s
    expect(row('plain-active-tu', null).lastSeenAt).toBe(feed - 3);
    expect(row('freq-exact', '12:02:00').lastSeenAt).toBe(feed - 3);
    // a vehicle position with no timestamp, or a zero one, counts as having none: the vehicle
    // positions header (the first reference's feed)
    expect(row('plain-active-no-timestamp', null).lastSeenAt).toBe(feed);
    expect(row('plain-active-zero-timestamp', null).lastSeenAt).toBe(feed);
    expect(feed - row('plain-active-vp', null).lastSeenAt).toBeGreaterThan(0);
  });

  it('names a date the reference does not share with the active entry', () => {
    const rows = expected.lists.unscheduledWithRealtime;
    // active today, so in list 2; the reference is for another day, so it is also in list 3
    for (const [id, date] of [
      ['plain-ref-yesterday', '20261013'],
      ['plain-ref-tomorrow', '20261015'],
    ] as const) {
      expect(expected.lists.activeWithoutRealtime.map((r) => r.tripId)).toContain(id);
      expect(rows.find((r) => r.tripId === id)).toMatchObject({
        serviceDate: date,
        reason: 'outside_scheduled_time',
      });
    }
  });
});

/*
 * 00:20 on the same day: the current minute starts at 00:20:00 and yesterday's 23:30-25:30 trips
 * are still running. Trips placed "before now" are clamped to start at 00:00:00 and the past trip
 * does not fit before midnight, so it is absent.
 */
describe('scenario at 2026-10-14 00:20:00 (after midnight)', () => {
  const { expected } = at('20261014', '00:20:00');

  it('counts', () => {
    expect(expected.stats).toEqual({
      tripsToday: 131,
      tripsActiveNow: 27,
      vehicles: 44,
      vehiclesWithTripId: 42,
      tripUpdates: 9,
      activeTripsWithRealtime: 16,
    });
  });

  it("lists yesterday's runs as active on yesterday's service date, found by inference", () => {
    expect(expected.lists.activeWithRealtime.map(active)).toEqual([
      // no start_date on either vehicle: step 1 of the inference picks the date with an active entry
      'overnight-daily 20261013 23:30:00-01:30:00 VP/--',
      'overnight-from-yesterday 20261013 23:30:00-01:30:00 VP/--',
      'freq-nominal 20261014 00:00:00-00:30:00 ~900 VP/--',
      'plain-active-vp 20261014 00:00:00-01:00:00 VP/--',
      'plain-active-vp-tu 20261014 00:00:00-00:50:00 VP/TU',
      'plain-spans-two-days 20261014 00:00:00-16:00:00 VP/--',
      'freq-exact 20261014 00:05:00-00:25:00 ~600x VP/--',
      'plain-active-added-service 20261014 00:05:00-00:45:00 VP/--',
      'plain-active-start-times 20261014 00:05:00-00:55:00 VP/TU',
      'plain-active-zero-timestamp 20261014 00:06:40-00:50:00 VP/TU',
      'plain-active-no-timestamp 20261014 00:08:20-00:48:20 VP/--',
      // start_time "24:10:00", no start_date: the instance of YESTERDAY that starts at 00:10 today
      'freq-overnight 20261013 00:10:00-00:30:00 ~600 VP/--',
      'plain-active-tu 20261014 00:10:00-00:35:00 --/TU',
      'plain-active-empty-route 20261014 00:11:40-00:51:40 VP/--',
      'freq-exact 20261014 00:15:00-00:35:00 ~600x --/TU',
      'freq-nominal 20261014 00:20:00-00:50:00 ~600 VP/--',
    ]);
    expect(expected.lists.activeWithoutRealtime.map(active)).toEqual([
      'edge-ends-this-minute 20261014 00:00:00-00:20:00',
      // yesterday's 24:00:00 instance and today's 00:00:00 one are the same instant: one entry, today's
      'freq-long-window 20261014 00:00:00-00:30:00 ~3600',
      'freq-overnight 20261013 00:00:00-00:20:00 ~600',
      'plain-active-no-rt 20261014 00:00:00-00:25:00',
      'freq-nominal 20261014 00:10:00-00:40:00 ~600',
      'plain-ref-yesterday 20261014 00:10:00-00:40:00',
      'plain-active-missing-shape 20261014 00:15:00-01:10:00',
      'plain-ref-tomorrow 20261014 00:15:00-00:45:00',
      'plain-ref-two-dates 20261014 00:15:00-00:45:00',
      'freq-overnight 20261013 00:20:00-00:40:00 ~600',
      'edge-starts-this-minute 20261014 00:20:59-00:50:00',
    ]);
  });

  it('list 3 loses the overnight and past trips, and keeps the day-named references', () => {
    expect(expected.lists.unscheduledWithRealtime.map(unscheduled)).toEqual([
      'unknown_trip ghost-known-route-tu-trip 20261014 span=null --/TU',
      'unknown_trip ghost-known-route-vp-trip 20261014 span=null VP/--',
      'unknown_trip ghost-tu-trip 20261014 span=null --/TU',
      'unknown_trip ghost-vp-trip 20261014 start=00:15:00 span=null VP/--',
      'configuration_error cfg-freq-first-stop-untimed 20261014 start=00:20:00 span=null VP/--',
      'configuration_error cfg-last-stop-untimed 20261014 span=null VP/TU',
      'configuration_error cfg-mixed-and-no-stop-times 20261014 span=null VP/--',
      'configuration_error cfg-no-stop-times 20261014 span=null VP/--',
      'configuration_error cfg-too-dense 20261014 start=00:20:00 span=null VP/--',
      'configuration_error freq-mixed 20261014 start=00:30:00 span=null VP/--',
      'configuration_error freq-mixed-removed-today 20261014 span=null VP/--',
      'not_in_service freq-nis 20261014 VP/--',
      'not_in_service freq-nis 20261014 start=03:33:33 VP/--',
      'not_in_service plain-nis-off-weekday 20261014 VP/--',
      'not_in_service plain-nis-removed-today 20261014 VP/--',
      'missing_start_time freq-nominal 20261014 VP/TU',
      'unmatched_start_time freq-exact 20261014 start=00:06:30 ~600 VP/--',
      'unmatched_start_time freq-exact 20261014 start=01:35:00 VP/--',
      'unmatched_start_time freq-nominal 20261014 start=00:01:30 ~900 VP/--',
      'unmatched_start_time freq-nominal 20261014 start=00:11:30 ~600 VP/--',
      'outside_scheduled_time freq-exact 20261014 start=00:25:00 span=00:25:00-00:45:00 ~600 VP/--',
      'outside_scheduled_time freq-overlapping-rows 20261014 start=09:00:00 span=09:00:00-09:20:00 ~600 VP/--',
      // 23:10 names no instance that is active on either date: the later operating date, today
      'outside_scheduled_time freq-overnight 20261014 start=23:10:00 span=23:10:00-23:30:00 ~600 VP/--',
      'outside_scheduled_time plain-future 20261014 span=01:20:00-02:20:00 VP/--',
      'outside_scheduled_time plain-ref-tomorrow 20261015 span=00:15:00-00:45:00 VP/--',
      'outside_scheduled_time plain-ref-two-dates 20261015 span=00:15:00-00:45:00 VP/--',
      'outside_scheduled_time plain-ref-yesterday 20261013 span=00:10:00-00:40:00 VP/--',
    ]);
  });
});

/*
 * 2026-11-01 is the fall-back day: noon minus 12 h is 01:00 PDT, so for the first hour of the
 * calendar day (00:00-00:59 PDT) the service day has not started and "now" is still on
 * yesterday's service day (it is 24:00-24:59 there).
 */
describe('scenario in the hour before the fall-back day starts', () => {
  const { expected } = scenario(new Date('2026-11-01T07:30:00Z'));

  it('has no entry on the new service day and runs the trips of 31 October', () => {
    expect(expected.today).toBe('20261101');
    expect(expected.yesterday).toBe('20261031');
    expect(expected.lists.activeWithRealtime.map(active)).toEqual(
      expect.arrayContaining([
        'overnight-daily 20261031 23:30:00-01:30:00 VP/--',
        'overnight-from-yesterday 20261031 23:30:00-01:30:00 VP/--',
      ]),
    );
    for (const row of [
      ...expected.lists.activeWithRealtime,
      ...expected.lists.activeWithoutRealtime,
    ]) {
      expect(row.serviceDate, row.tripId).toBe('20261031');
    }
  });
});

describe('the fall-back service day', () => {
  it('starts at 01:00 PDT, noon minus 12 h, not at local midnight', () => {
    // 01:15 PDT: a quarter of an hour into the service day, so starts are clamped to its first second
    const { expected } = scenario(new Date('2026-11-01T08:15:00Z'));
    const row = expected.lists.activeWithRealtime.find((r) => r.tripId === 'plain-active-vp')!;
    expect(row.serviceDate).toBe('20261101');
    expect(row.scheduledStart).toBe(Date.parse('2026-11-01T08:00:00Z') / 1000);
  });
});

describe('daylight saving days', () => {
  // GTFS times count from noon minus 12 h, so at midday a service day that changes length still
  // places the same trips around "now" and the lists read the same on the wall clock. (Near the
  // start of the service day they do not: that day begins at 23:00 or 01:00 wall-clock time.)
  const reference = at('20261014', '12:07:42').expected;
  it.each([
    ['20260308', 'spring forward'],
    ['20261101', 'fall back'],
  ])('%s (%s) lists the same trips at the same wall-clock times at midday', (date) => {
    const { expected } = at(date, '12:07:42');
    const normalize = (rows: string[], from: string, to: string): string[] =>
      rows.map((r) => r.replaceAll(from, to));
    expect(expected.stats).toEqual(reference.stats);
    for (const list of ['activeWithRealtime', 'activeWithoutRealtime'] as const) {
      // plain-spans-two-days starts at the service day base, which is not midnight on these days
      const rows = (e: Expected) =>
        e.lists[list].filter((r) => r.tripId !== 'plain-spans-two-days');
      expect(normalize(rows(expected).map(active), expected.today, 'D')).toEqual(
        normalize(rows(reference).map(active), reference.today, 'D'),
      );
    }
  });
});

describe('options', () => {
  it('leaves out the misconfigured trips, their vehicles and their configuration errors', () => {
    const full = at('20261014', '12:07:42');
    const without = at('20261014', '12:07:42', { includeMisconfiguredTrip: false });
    expect(without.expected.configurationErrors).toEqual([]);
    expect(without.expected.stats.vehicles).toBe(full.expected.stats.vehicles - 7);
    expect(without.expected.lists.unscheduledWithRealtime.map((r) => r.reason)).not.toContain(
      'configuration_error',
    );
    const ids = without.schedule.trips.map((t) => t.row.trip_id);
    for (const id of [
      'freq-mixed',
      'freq-mixed-removed-today',
      'cfg-no-stop-times',
      'cfg-too-dense',
    ])
      expect(ids).not.toContain(id);
    expect(ids.some((id) => id!.startsWith('cfg-'))).toBe(false);
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

  it('depends on the current minute for the schedule, the trips and the lists', () => {
    // Feed headers and vehicle timestamps are in whole seconds, so the feeds and lastSeenAt differ.
    const a = at('20261014', '12:07:00');
    const b = at('20261014', '12:07:59');
    expect(b.scheduleZip).toEqual(a.scheduleZip);
    expect(b.vehiclePositions).not.toEqual(a.vehiclePositions);
    const withoutSeen = (e: unknown): unknown =>
      JSON.parse(JSON.stringify(e, (k, v: unknown) => (k === 'lastSeenAt' ? undefined : v)));
    expect(withoutSeen(b.expected)).toEqual(withoutSeen(a.expected));
  });
});

/** Checks everything that must hold for any instant. Returns a description of the first failure. */
function violation(now: Date): string | null {
  const sc = scenario(now);
  const { lists, stats } = sc.expected;
  const active = [...lists.activeWithRealtime, ...lists.activeWithoutRealtime];
  const keys = active.map((r) => `${r.tripId}@${r.scheduledStart}`);
  const reasons = lists.unscheduledWithRealtime.map((r) => REASON_ORDER.indexOf(r.reason));
  const checks: [string, boolean][] = [
    ['active = list 1 + list 2', stats.tripsActiveNow === active.length],
    [
      'activeTripsWithRealtime = list 1',
      stats.activeTripsWithRealtime === lists.activeWithRealtime.length,
    ],
    ['list 1 rows have realtime', lists.activeWithRealtime.every((r) => r.realtime !== null)],
    ['list 2 rows have none', lists.activeWithoutRealtime.every((r) => r.realtime === null)],
    ['no duplicate entry', new Set(keys).size === keys.length],
    ['list 3 in reason order', reasons.every((r, i) => i === 0 || reasons[i - 1]! <= r)],
    [
      'list 3 has the reasons that never depend on the clock',
      ['unknown_trip', 'configuration_error', 'not_in_service'].every((r) =>
        lists.unscheduledWithRealtime.some((x) => x.reason === r),
      ),
    ],
    [
      'frequency windows are non-empty and stop times never decrease',
      sc.schedule.trips.every(
        (t) =>
          t.frequencies.every((f) => parseHms(f.start_time!) < parseHms(f.end_time!)) &&
          t.stopTimes.every((st, i, all) => {
            const time = st.departure ?? st.arrival;
            const previous = all[i - 1];
            return (
              time === null || i === 0 || time >= (previous?.departure ?? previous?.arrival ?? 0)
            );
          }),
      ),
    ],
    ['vehicles decode', decodeFeed(sc.vehiclePositions).entity.length === stats.vehicles],
    ['trip updates decode', decodeFeed(sc.tripUpdates).entity.length === stats.tripUpdates],
  ];
  const failed = checks.find(([, ok]) => !ok);
  return failed ? `${now.toISOString()}: ${failed[0]}` : null;
}

describe('scenario over real instants', () => {
  // Every 397 s (a stride coprime with the minute, so seconds vary) across both daylight-saving
  // changes of 2026 and the days around them, from before the earlier service day to after the later.
  const ranges: [string, string][] = [
    ['2026-03-06T20:00:00Z', '2026-03-10T08:00:00Z'],
    ['2026-10-30T20:00:00Z', '2026-11-03T08:00:00Z'],
  ];

  it('never throws and keeps its invariants', () => {
    const failures: string[] = [];
    let count = 0;
    for (const [from, to] of ranges) {
      for (let t = Date.parse(from); t < Date.parse(to); t += 397_000) {
        count++;
        try {
          const failure = violation(new Date(t));
          if (failure) failures.push(failure);
        } catch (error) {
          failures.push(`${new Date(t).toISOString()}: threw ${String(error)}`);
        }
      }
    }
    expect(count).toBeGreaterThan(1400);
    expect(failures).toEqual([]);
  }, 120_000);

  it('survives every minute of the hours around each service day start', () => {
    const failures: string[] = [];
    // 2026-11-01 00:00-01:59 PDT/PST (07:00Z-09:59Z) and 2026-03-08 22:00-00:59 (06:00Z-08:59Z)
    for (const [from, minutes] of [
      ['2026-11-01T06:30:00Z', 210],
      ['2026-03-08T05:30:00Z', 210],
      ['2026-10-14T06:30:00Z', 210],
    ] as const) {
      for (let i = 0; i < minutes; i++) {
        const now = new Date(Date.parse(from) + i * 60_000 + 17_000);
        try {
          const failure = violation(now);
          if (failure) failures.push(failure);
        } catch (error) {
          failures.push(`${now.toISOString()}: threw ${String(error)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('survives the boundaries of the overnight trips on an ordinary day', () => {
    for (const hms of [
      '00:00:00',
      '00:00:30',
      '01:29:59',
      '01:30:00',
      '01:30:30',
      '02:00:00',
      '23:59:59',
    ]) {
      expect(violation(agencyInstant('20261014', hms, TIMEZONE)), hms).toBeNull();
    }
  });
});
