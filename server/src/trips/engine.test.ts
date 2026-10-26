import { agencyInstant } from '@gtfs-rt-debugger/fixtures';
import type { ListName } from '@gtfs-rt-debugger/shared';
import { describe, expect, it } from 'vitest';
import {
  harness,
  loadSchedule,
  update,
  vehicle,
  type ScheduleSpec,
} from '../test-support/trips.js';
import { ScheduleNotReadyError, TripEngine } from './engine.js';

const ZONE = 'America/Los_Angeles';
/** Wed 2026-10-14 12:07:42 PDT; the current minute starts at 12:07:00. */
const NOW = '2026-10-14T19:07:42Z';

/** Epoch seconds of a GTFS time on a service date (local noon minus 12 h is 00:00 on these days). */
const local = (hms: string, date = '20261014'): number =>
  agencyInstant(date, hms, ZONE).getTime() / 1000;

async function setup(spec: ScheduleSpec, now = NOW) {
  const store = await loadSchedule(spec);
  return harness({ now, store });
}

const LISTS: ListName[] = [
  'active-with-realtime',
  'active-without-realtime',
  'unscheduled-with-realtime',
];

describe('schedule entries and counts', () => {
  it('a plain trip is one entry spanning its first and last stop time', async () => {
    const h = await setup({ trips: [{ id: 'A', start: '12:00:00', end: '13:00:00' }] });
    const d = h.engine.dashboard();
    expect(d.schedule).toEqual({ tripsToday: 1, tripsActiveNow: 1 });
    expect(h.engine.list('active-without-realtime').trips[0]).toMatchObject({
      tripId: 'A',
      scheduledStart: local('12:00:00'),
      scheduledEnd: local('13:00:00'),
      frequency: null,
    });
  });

  it('the span starts at the first departure, else arrival; ends at the last arrival, else departure', async () => {
    const h = await setup({
      trips: [
        {
          id: 'dwell',
          stops: [
            ['11:58:00', '12:00:00'],
            ['12:30:00', '12:32:00'],
          ],
        },
        {
          id: 'arrivals',
          stops: [
            ['12:01:00', ''],
            ['12:40:00', ''],
          ],
        },
        {
          id: 'departures',
          stops: [
            ['', '12:02:00'],
            ['', '12:50:00'],
          ],
        },
      ],
    });
    expect(
      h.engine
        .list('active-without-realtime')
        .trips.map((t) => [t.tripId, t.scheduledStart, t.scheduledEnd]),
    ).toEqual([
      ['dwell', local('12:00:00'), local('12:30:00')],
      ['arrivals', local('12:01:00'), local('12:40:00')],
      ['departures', local('12:02:00'), local('12:50:00')],
    ]);
  });

  it('a frequency trip has one entry per nominal instance: S, S+H, ... before E, each lasting the template duration', async () => {
    const h = await setup({
      trips: [
        { id: 'F', start: '06:00:00', end: '06:20:00', freq: [['12:00:00', '13:00:00', 900, '1']] },
      ],
    });
    // instances 12:00, 12:15, 12:30, 12:45 (13:00 is the exclusive end); 20 minutes each
    expect(h.engine.dashboard().schedule?.tripsToday).toBe(4);
    expect(
      h.engine.list('active-without-realtime').trips.map((t) => [t.scheduledStart, t.scheduledEnd]),
    ).toEqual([[local('12:00:00'), local('12:20:00')]]);
  });

  it.each(['0', '1', ''])('exact_times %j does not change the interpretation', async (exact) => {
    const h = await setup({
      trips: [
        {
          id: 'F',
          start: '06:00:00',
          end: '06:10:00',
          freq: [['12:00:00', '12:30:00', 600, exact]],
        },
      ],
    });
    expect(h.engine.dashboard().schedule).toEqual({ tripsToday: 3, tripsActiveNow: 1 });
    expect(h.engine.list('active-without-realtime').trips[0]!.frequency).toEqual({
      exactTimes: exact === '1',
      headwaySecs: 600,
      windowStart: local('12:00:00'),
      windowEnd: local('12:30:00'),
    });
  });

  it('every row produces its own instances', async () => {
    const h = await setup({
      trips: [
        {
          id: 'F',
          start: '06:00:00',
          end: '06:10:00',
          freq: [
            ['11:00:00', '11:30:00', 1200, '0'],
            ['12:00:00', '12:20:00', 600, ''],
          ],
        },
      ],
    });
    // 11:00, 11:20 and 12:00, 12:10
    expect(h.engine.dashboard().schedule?.tripsToday).toBe(4);
    expect(h.engine.list('active-without-realtime').trips.map((t) => t.scheduledStart)).toEqual([
      local('12:00:00'),
    ]);
  });

  it('a window may cross midnight; its instances after midnight belong to the earlier service day', async () => {
    const midnight = '2026-10-14T07:20:00Z'; // 00:20 PDT
    const window: [string, string, number, string][] = [['23:00:00', '25:00:00', 1800, '0']];
    // instances 23:00, 23:30, 24:00, 24:30 on each service date; a 10-minute template: the 24:00
    // instance of yesterday ended at 00:10, the 24:30 one has not started
    const short = await setup(
      { trips: [{ id: 'F', start: '06:00:00', end: '06:10:00', freq: window }] },
      midnight,
    );
    expect(short.engine.dashboard().schedule).toEqual({ tripsToday: 4, tripsActiveNow: 0 });
    // with a 30-minute template the 24:00 instance of yesterday (00:00-00:30) is active
    const long = await setup(
      { trips: [{ id: 'F', start: '06:00:00', end: '06:30:00', freq: window }] },
      midnight,
    );
    expect(
      long.engine
        .list('active-without-realtime')
        .trips.map((t) => [t.serviceDate, t.scheduledStart, t.scheduledEnd]),
    ).toEqual([['20261013', local('00:00:00'), local('00:30:00')]]);
    expect(long.engine.dashboard().schedule?.tripsToday).toBe(4);
  });

  it('rows that cannot be read produce no instances and cannot hang the engine', async () => {
    const h = await setup({
      trips: [
        {
          id: 'F',
          start: '06:00:00',
          end: '06:30:00',
          freq: [
            ['12:00:00', '13:00:00', 0],
            ['12:00:00', '13:00:00', 'soon'],
            ['12:00:00', '13:00:00', -60],
            ['noon', '13:00:00', 600],
            ['12:00:00', '', 600],
            ['13:00:00', '12:00:00', 600],
            ['12:00:00', '12:10:00', 600, '0'],
          ],
        },
      ],
    });
    expect(h.engine.dashboard().schedule).toEqual({ tripsToday: 1, tripsActiveNow: 1 });
  });

  it('an entry on a service that does not operate today is not counted or listed', async () => {
    const h = await setup({
      calendar: { DAILY: {}, NEVER: { days: '0000000' } },
      trips: [
        { id: 'on', start: '12:00:00', end: '13:00:00' },
        { id: 'off', service: 'NEVER', start: '12:00:00', end: '13:00:00' },
      ],
    });
    expect(h.engine.dashboard().schedule).toEqual({ tripsToday: 1, tripsActiveNow: 1 });
    expect(h.ids('active-without-realtime')).toEqual([`on@${local('12:00:00')}`]);
  });

  it('operates-on: weekday flag within the inclusive date range, then exceptions (type 1 adds, type 2 removes)', async () => {
    const trip = (id: string, service: string) => ({
      id,
      service,
      start: '12:00:00',
      end: '13:00:00',
    });
    const h = await setup({
      // 2026-10-14 is a Wednesday
      calendar: {
        DAILY: {},
        WED: { days: '0010000' },
        TUE: { days: '0100000' },
        ENDS_TODAY: { end: '20261014' },
        STARTS_TODAY: { start: '20261014' },
        ENDED: { end: '20261013' },
        STARTS_TOMORROW: { start: '20261015' },
        REMOVED: {},
        ADDED_TUE: { days: '0100000' },
      },
      calendarDates: [
        ['REMOVED', '20261014', '2'],
        ['ADDED_TUE', '20261014', '1'],
        ['ONLY_DATES', '20261014', '1'],
        ['ONLY_DATES_OTHER', '20261015', '1'],
      ],
      trips: [
        trip('wed', 'WED'),
        trip('tue', 'TUE'),
        trip('ends-today', 'ENDS_TODAY'),
        trip('starts-today', 'STARTS_TODAY'),
        trip('ended', 'ENDED'),
        trip('starts-tomorrow', 'STARTS_TOMORROW'),
        trip('removed', 'REMOVED'),
        trip('added', 'ADDED_TUE'),
        trip('only-dates', 'ONLY_DATES'),
        trip('only-dates-other', 'ONLY_DATES_OTHER'),
      ],
    });
    expect(h.engine.list('active-without-realtime').trips.map((t) => t.tripId)).toEqual([
      'added',
      'ends-today',
      'only-dates',
      'starts-today',
      'wed',
    ]);
    expect(h.engine.dashboard().schedule?.tripsToday).toBe(5);
  });

  describe('overlaps the current minute: start before m + 60 s and end at or after m', () => {
    it.each([
      ['ends exactly at m', '11:30:00', '12:07:00', true],
      ['ended a second before m', '11:30:00', '12:06:59', false],
      ['starts in the last second of the minute', '12:07:59', '12:30:00', true],
      ['starts exactly at m + 60', '12:08:00', '12:30:00', false],
      ['starts and ends within the minute', '12:07:10', '12:07:20', true],
      ['starts at m', '12:07:00', '12:30:00', true],
    ])('%s', async (_name, start, end, active) => {
      const h = await setup({ trips: [{ id: 'T', start, end }] });
      expect(h.engine.dashboard().schedule?.tripsActiveNow).toBe(active ? 1 : 0);
      expect(h.engine.dashboard().schedule?.tripsToday).toBe(1);
    });

    it('uses the start of the current minute, however late in it the clock is', async () => {
      const h = await setup(
        { trips: [{ id: 'T', start: '11:00:00', end: '12:07:00' }] },
        '2026-10-14T19:07:59.900Z',
      );
      expect(h.engine.dashboard().schedule?.tripsActiveNow).toBe(1);
      const next = await setup(
        { trips: [{ id: 'T', start: '11:00:00', end: '12:07:00' }] },
        '2026-10-14T19:08:00Z',
      );
      expect(next.engine.dashboard().schedule?.tripsActiveNow).toBe(0);
    });
  });

  describe('yesterday is a candidate service date', () => {
    const overnight: ScheduleSpec = {
      calendar: { DAILY: {}, NIGHT: { end: '20261013' } },
      trips: [
        { id: 'owl', service: 'NIGHT', start: '23:30:00', end: '25:30:00' },
        { id: 'today', start: '00:10:00', end: '00:40:00' },
      ],
    };

    it("a trip of yesterday's service date still running after midnight is active, on yesterday's date, and not scheduled today", async () => {
      const h = await setup(overnight, '2026-10-14T07:20:00Z'); // 00:20 PDT
      const d = h.engine.dashboard();
      expect(d.schedule).toEqual({ tripsToday: 1, tripsActiveNow: 2 });
      expect(
        h.engine
          .list('active-without-realtime')
          .trips.map((t) => [t.tripId, t.serviceDate, t.scheduledStart]),
      ).toEqual([
        ['owl', '20261013', local('23:30:00', '20261013')],
        ['today', '20261014', local('00:10:00')],
      ]);
    });

    it('is no longer active once it has ended', async () => {
      const h = await setup(overnight, '2026-10-14T08:31:00Z'); // 01:31 PDT
      expect(h.engine.dashboard().schedule?.tripsActiveNow).toBe(0);
    });

    it('uses the agency timezone for today, not the server or UTC', async () => {
      // 23:30 PDT on the 14th is already the 15th in UTC
      const h = await setup(
        {
          calendarDates: [['ONLY14', '20261014', '1']],
          calendar: {},
          trips: [{ id: 'only14', service: 'ONLY14', start: '23:00:00', end: '24:30:00' }],
        },
        '2026-10-15T06:30:00Z',
      );
      expect(h.engine.dashboard().schedule).toEqual({ tripsToday: 1, tripsActiveNow: 1 });
      expect(h.engine.list('active-without-realtime').trips[0]!.serviceDate).toBe('20261014');
    });

    it('a trip active on both candidate dates is one entry, on the later date', async () => {
      // a 40-hour span: at 10:00 both yesterday's run (to 16:00 today) and today's are running
      const h = await setup(
        { trips: [{ id: 'long', start: '00:00:00', end: '40:00:00' }] },
        '2026-10-14T17:00:00Z', // 10:00 PDT
      );
      expect(h.engine.dashboard().schedule?.tripsActiveNow).toBe(1);
      expect(h.engine.list('active-without-realtime').trips.map((t) => t.serviceDate)).toEqual([
        '20261014',
      ]);
    });
  });

  it('a configuration error excludes the trip from entries and counts', async () => {
    const h = await setup({
      trips: [
        { id: 'ok', start: '12:00:00', end: '13:00:00' },
        {
          id: 'mixed',
          start: '06:00:00',
          end: '06:10:00',
          freq: [
            ['12:00:00', '13:00:00', 600, '1'],
            ['12:00:00', '13:00:00', 600, ''],
          ],
        },
        { id: 'norows', stops: [] },
        {
          id: 'lastless',
          stops: [
            ['12:00:00', '12:00:00'],
            ['', ''],
          ],
        },
        {
          id: 'firstless',
          stops: [
            ['', ''],
            ['12:30:00', '12:30:00'],
          ],
        },
        {
          id: 'freqlast',
          stops: [
            ['06:00:00', '06:00:00'],
            ['', ''],
          ],
          freq: [['12:00:00', '13:00:00', 600, '0']],
        },
      ],
    });
    expect(h.engine.dashboard().schedule).toEqual({ tripsToday: 1, tripsActiveNow: 1 });
    expect(h.ids('active-without-realtime')).toEqual([`ok@${local('12:00:00')}`]);
    expect(h.engine.dashboard().configurationErrors).toMatchObject({
      total: 5,
      items: [
        { code: 'mixed_exact_times', tripId: 'mixed' },
        { code: 'unusable_stop_times', tripId: 'norows' },
        { code: 'unusable_stop_times', tripId: 'lastless' },
        { code: 'unusable_stop_times', tripId: 'firstless' },
        { code: 'unusable_stop_times', tripId: 'freqlast' },
      ],
    });
  });

  it('exact_times 0 and absent are the same value, so not a configuration error', async () => {
    const h = await setup({
      trips: [
        {
          id: 'F',
          start: '06:00:00',
          end: '06:10:00',
          freq: [
            ['12:00:00', '12:30:00', 600, '0'],
            ['13:00:00', '13:30:00', 600, ''],
          ],
        },
      ],
    });
    expect(h.engine.dashboard().configurationErrors).toEqual({ total: 0, items: [] });
    expect(h.engine.dashboard().schedule?.tripsToday).toBe(6);
  });

  it('uses the zone of the agency: a half-hour zone and one east of UTC', async () => {
    const kolkata = await setup(
      { timezone: 'Asia/Kolkata', trips: [{ id: 'T', start: '12:00:00', end: '12:30:00' }] },
      '2026-10-14T06:45:00Z', // 12:15 IST
    );
    expect(kolkata.engine.dashboard().schedule).toEqual({ tripsToday: 1, tripsActiveNow: 1 });
    expect(kolkata.engine.list('active-without-realtime').trips[0]!.scheduledStart).toBe(
      Date.parse('2026-10-14T06:30:00Z') / 1000,
    );
    const auckland = await setup(
      { timezone: 'Pacific/Auckland', trips: [{ id: 'T', start: '12:00:00', end: '12:30:00' }] },
      '2026-10-14T23:15:00Z', // 12:15 NZDT on the 15th
    );
    expect(auckland.engine.list('active-without-realtime').trips[0]).toMatchObject({
      serviceDate: '20261015',
    });
  });
});

describe('daylight-saving days, with the instants worked out by hand (America/Los_Angeles)', () => {
  const trips: ScheduleSpec['trips'] = [
    { id: 'first', start: '00:00:00', end: '00:15:00' },
    { id: 'second', start: '00:30:00', end: '01:00:00' },
    { id: 'late', start: '02:30:00', end: '02:45:00' },
    { id: 'owl', start: '24:10:00', end: '24:30:00' },
    { id: 'day', start: '03:00:00', end: '04:00:00' },
  ];
  const active = (h: Awaited<ReturnType<typeof setup>>) =>
    h.engine
      .list('active-without-realtime')
      .trips.map((t) => [t.tripId, t.serviceDate, t.scheduledStart]);
  const Z = (iso: string) => Date.parse(iso) / 1000;

  it('fall back (2026-11-01): the service day starts at 01:00 PDT = 08:00Z and has 25 hours', async () => {
    // 08:40Z is 01:40 PDT, the first time the clock reads that
    const h = await setup({ trips }, '2026-11-01T08:40:00Z');
    expect(active(h)).toEqual([['second', '20261101', Z('2026-11-01T08:30:00Z')]]);
    expect(h.engine.dashboard().schedule).toEqual({ tripsToday: 5, tripsActiveNow: 1 });
    // 24:00:00-25:00:00 is 08:00Z-09:00Z on the 2nd, 00:00-01:00 PST; the 1st is a 25-hour day
    const night = { trips: [{ id: 'long', start: '24:00:00', end: '25:00:00' }] };
    const later = await setup(night, '2026-11-02T08:30:00Z');
    expect(active(later)).toEqual([['long', '20261101', Z('2026-11-02T08:00:00Z')]]);
    expect(active(await setup(night, '2026-11-02T09:01:00Z'))).toEqual([]);
  });

  it('fall back, just after midnight PDT: today is the 1st but its day has not started; the 31st is running', async () => {
    const h = await setup({ trips }, '2026-11-01T07:20:00Z'); // 00:20 PDT
    // the 31st starts at 07:00Z, so 24:10:00-24:30:00 is 07:10Z-07:30Z; the 1st's trips start at 08:00Z
    expect(active(h)).toEqual([['owl', '20261031', Z('2026-11-01T07:10:00Z')]]);
    expect(h.engine.dashboard().schedule?.tripsToday).toBe(5);
  });

  it('spring forward (2026-03-08): the service day starts at 23:00 PST the evening before = 07:00Z and has 23 hours', async () => {
    // 10:30Z is 03:30 PDT; 03:00:00-04:00:00 is 10:00Z-11:00Z, and 02:30:00-02:45:00 (09:30Z) is over
    const h = await setup({ trips }, '2026-03-08T10:30:00Z');
    expect(active(h)).toEqual([['day', '20260308', Z('2026-03-08T10:00:00Z')]]);
    // the owl of the 7th (24:10:00-24:30:00 from 08:00Z on the 7th) runs 08:10Z-08:30Z on the 8th
    // = 00:10-00:30 PST; the trips of the 8th (from 07:00Z) are over or not started
    const owl = await setup({ trips }, '2026-03-08T08:20:00Z');
    expect(active(owl)).toEqual([['owl', '20260307', Z('2026-03-08T08:10:00Z')]]);
  });

  it('only today and yesterday are candidate service dates', async () => {
    // 07:30Z on 2026-03-08 is 23:30 PST on the 7th: the service day of the 8th has started
    // (07:00Z), but today is still the 7th, and the 8th's trips are not looked at
    const h = await setup({ trips }, '2026-03-08T07:10:00Z');
    expect(h.engine.list('active-without-realtime').trips.map((t) => t.serviceDate)).not.toContain(
      '20260308',
    );
    expect(h.engine.dashboard().schedule?.tripsToday).toBe(5);
  });
});

describe('schedule not ready', () => {
  it('has null schedule-dependent figures but still counts the feeds', async () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [vehicle('v1', { trip: { tripId: 'A' } })]);
    expect(h.engine.dashboard()).toEqual({
      now: Math.floor(Date.parse(NOW) / 1000),
      agency: null,
      schedule: null,
      realtime: {
        vehicles: 1,
        vehiclesWithTripId: 1,
        tripUpdates: null,
        activeTripsWithRealtime: null,
      },
      lists: null,
      configurationErrors: null,
    });
    expect(() => h.engine.list('active-with-realtime')).toThrow(ScheduleNotReadyError);
    expect(() => h.engine.detail('A')).toThrow(ScheduleNotReadyError);
  });
});

describe('the engine remembers nothing between calls', () => {
  it('follows the clock, the snapshots and the schedule on every call', async () => {
    const h = await setup({ trips: [{ id: 'A', start: '12:00:00', end: '12:30:00' }] });
    expect(h.ids('active-with-realtime')).toEqual([]);
    h.push('vehiclePositions', [vehicle('v', { trip: { tripId: 'A' } })]);
    expect(h.ids('active-with-realtime')).toEqual([`A@${local('12:00:00')}`]);
    h.clock.advance(31 * 60_000); // 12:38, A has ended
    expect(h.ids('active-with-realtime')).toEqual([]);
    expect(h.ids('unscheduled-with-realtime')).toEqual([
      `A@${local('12:00:00')}:outside_scheduled_time`,
    ]);
    h.push('vehiclePositions', []);
    expect(h.ids('unscheduled-with-realtime')).toEqual([]);
    h.setSchedule(await loadSchedule({ trips: [{ id: 'A', start: '12:35:00', end: '12:50:00' }] }));
    expect(h.ids('active-without-realtime')).toEqual([`A@${local('12:35:00')}`]);
  });
});

describe('statistics', () => {
  it('are null before a feed has a snapshot, and zero after an empty one', async () => {
    const h = await setup({ trips: [] });
    expect(h.engine.dashboard().realtime).toEqual({
      vehicles: null,
      vehiclesWithTripId: null,
      tripUpdates: null,
      activeTripsWithRealtime: null,
    });
    h.push('vehiclePositions', []);
    expect(h.engine.dashboard().realtime).toEqual({
      vehicles: 0,
      vehiclesWithTripId: 0,
      tripUpdates: null,
      activeTripsWithRealtime: null, // the trip updates feed has no snapshot yet
    });
    h.push('tripUpdates', []);
    expect(h.engine.dashboard().realtime).toEqual({
      vehicles: 0,
      vehiclesWithTripId: 0,
      tripUpdates: 0,
      activeTripsWithRealtime: 0,
    });
  });

  it('does not wait for a feed that is not configured', async () => {
    const store = await loadSchedule({ trips: [{ id: 'A', start: '12:00:00', end: '12:30:00' }] });
    const h = harness({ now: NOW, store });
    const single = new TripEngine({
      clock: h.clock,
      snapshots: h.snapshots,
      pings: h.pings,
      schedule: () => store,
      feeds: ['vehiclePositions'],
    });
    expect(single.dashboard().realtime.activeTripsWithRealtime).toBeNull();
    h.push('vehiclePositions', [vehicle('v', { trip: { tripId: 'A' } })]);
    const d = single.dashboard();
    expect(d.realtime).toEqual({
      vehicles: 1,
      vehiclesWithTripId: 1,
      tripUpdates: null,
      activeTripsWithRealtime: 1,
    });
  });

  it('counts vehicles and trip updates by entity, and those with a trip ID separately', async () => {
    const h = await setup({ trips: [] });
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'A' } }),
      vehicle('2', { trip: { tripId: '' } }),
      vehicle('3', { trip: { routeId: 'R1' } }),
      vehicle('4', {}),
      { id: 'not-a-vehicle', tripUpdate: { trip: { tripId: 'A' } } },
    ]);
    h.push('tripUpdates', [
      update('1', { trip: { tripId: 'A' } }),
      update('2', { trip: {} }),
      { id: 'not-an-update', vehicle: { trip: { tripId: 'A' } } },
    ]);
    expect(h.engine.dashboard().realtime).toMatchObject({
      vehicles: 4,
      vehiclesWithTripId: 1,
      tripUpdates: 2,
    });
  });

  it('size of list 1 equals the active trips with realtime, and the lists counts equal the lists', async () => {
    const h = await setup({
      trips: [
        { id: 'a', start: '12:00:00', end: '13:00:00' },
        { id: 'b', start: '12:00:00', end: '13:00:00' },
        { id: 'c', start: '14:00:00', end: '15:00:00' },
      ],
    });
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'a' } }),
      vehicle('2', { trip: { tripId: 'c' } }),
      vehicle('3', { trip: { tripId: 'zzz' } }),
    ]);
    h.push('tripUpdates', []);
    const d = h.engine.dashboard();
    expect(d.lists).toEqual({
      activeWithRealtime: 1,
      activeWithoutRealtime: 1,
      unscheduledWithRealtime: 2,
    });
    expect(d.realtime.activeTripsWithRealtime).toBe(1);
    expect(d.schedule?.tripsActiveNow).toBe(2);
    for (const [list, count] of [
      ['active-with-realtime', 1],
      ['active-without-realtime', 1],
      ['unscheduled-with-realtime', 2],
    ] as const) {
      expect(h.engine.list(list).trips).toHaveLength(count);
    }
  });

  it('reports the first 100 configuration errors in trips.txt order, with the total and a message each', async () => {
    const trips = Array.from({ length: 130 }, (_, i) => ({
      id: `bad-${String(i).padStart(3, '0')}`,
      stops: [],
    }));
    const h = await setup({ trips: [{ id: 'ok', start: '12:00:00', end: '13:00:00' }, ...trips] });
    const errors = h.engine.dashboard().configurationErrors!;
    expect(errors.total).toBe(130);
    expect(errors.items).toHaveLength(100);
    expect(errors.items.map((i) => i.tripId)).toEqual(trips.slice(0, 100).map((t) => t.id));
    expect(errors.items[0]!.message).toMatch(/stop_times/);
  });

  it('counts a trip with both problems once per code', async () => {
    const h = await setup({
      trips: [
        {
          id: 'both',
          stops: [],
          freq: [
            ['12:00:00', '13:00:00', 600, '1'],
            ['13:00:00', '14:00:00', 600, '0'],
          ],
        },
      ],
    });
    const errors = h.engine.dashboard().configurationErrors!;
    expect(errors.total).toBe(2);
    expect(errors.items.map((i) => [i.tripId, i.code])).toEqual([
      ['both', 'mixed_exact_times'],
      ['both', 'unusable_stop_times'],
    ]);
    expect(errors.items[0]!.message).not.toBe(errors.items[1]!.message);
  });
});

describe('realtime trip references', () => {
  const trips: ScheduleSpec['trips'] = [
    { id: 'plain', start: '12:00:00', end: '13:00:00' },
    { id: 'freq', start: '06:00:00', end: '06:20:00', freq: [['11:30:00', '13:00:00', 600, '0']] },
  ];

  it('come from the latest snapshot of each feed only', async () => {
    const h = await setup({ trips });
    h.push('vehiclePositions', [vehicle('v', { trip: { tripId: 'plain' } })]);
    h.clock.advance(10_000);
    h.push('vehiclePositions', [vehicle('v', { trip: { tripId: 'other' } })]);
    expect(h.ids('active-with-realtime')).toEqual([]);
    expect(h.engine.list('unscheduled-with-realtime').trips.map((t) => t.tripId)).toEqual([
      'other',
    ]);
  });

  it('a reference without a trip ID is listed nowhere', async () => {
    const h = await setup({ trips });
    h.push('vehiclePositions', [
      vehicle('a', {}),
      vehicle('b', { trip: { routeId: 'R1' } }),
      vehicle('c', { trip: { tripId: '' } }),
    ]);
    for (const list of LISTS)
      expect(h.engine.list(list).trips.filter((t) => t.realtime)).toEqual([]);
    expect(h.engine.dashboard().realtime.vehicles).toBe(3);
  });

  describe('service date', () => {
    it('is the start_date when present, used as sent', async () => {
      const h = await setup({ trips });
      h.push('vehiclePositions', [
        vehicle('a', { trip: { tripId: 'plain', startDate: '20261013' } }),
        vehicle('b', { trip: { tripId: 'freq', startDate: '20271231', startTime: '11:30:00' } }),
      ]);
      expect(
        h.engine
          .list('unscheduled-with-realtime')
          .trips.map((t) => [t.tripId, t.serviceDate, t.reason]),
      ).toEqual([
        ['freq', '20271231', 'outside_scheduled_time'],
        ['plain', '20261013', 'outside_scheduled_time'],
      ]);
    });

    it.each(['2026-10-13', '202610', 'tomorrow', '20261313', '20260230', '2026101'])(
      'a start_date that is not a calendar date (%j) counts as absent',
      async (startDate) => {
        const h = await setup({ trips });
        h.push('vehiclePositions', [vehicle('a', { trip: { tripId: 'plain', startDate } })]);
        // inferred: the trip is active today
        expect(
          h.engine.list('active-with-realtime').trips.map((t) => [t.tripId, t.serviceDate]),
        ).toEqual([['plain', '20261014']]);
      },
    );

    describe('inferred from the schedule', () => {
      const overnight: ScheduleSpec = {
        calendar: {
          DAILY: {},
          NIGHT: { end: '20261013' },
          TODAY_ONLY: { start: '20261014', end: '20261014' },
          YESTERDAY_ONLY: { start: '20261013', end: '20261013' },
        },
        trips: [
          { id: 'owl', service: 'NIGHT', start: '23:30:00', end: '25:30:00' },
          { id: 'both-days', start: '23:30:00', end: '25:30:00' },
          { id: 'today-only', service: 'TODAY_ONLY', start: '03:00:00', end: '04:00:00' },
          { id: 'yesterday-only', service: 'YESTERDAY_ONLY', start: '03:00:00', end: '04:00:00' },
          {
            id: 'freq-owl',
            service: 'NIGHT',
            start: '08:00:00',
            end: '08:20:00',
            freq: [['23:00:00', '25:00:00', 600, '0']],
          },
          {
            id: 'freq-both',
            start: '08:00:00',
            end: '08:20:00',
            freq: [['23:00:00', '25:00:00', 600, '0']],
          },
        ],
      };
      const NIGHT = '2026-10-14T07:20:00Z'; // 00:20 PDT on the 14th

      it('step 1: the candidate date on which the trip has an active entry', async () => {
        const h = await setup(overnight, NIGHT);
        h.push('vehiclePositions', [vehicle('a', { trip: { tripId: 'owl' } })]);
        // active on yesterday's date: matched, so in list 1 and not in list 3
        expect(
          h.engine.list('active-with-realtime').trips.map((t) => [t.tripId, t.serviceDate]),
        ).toEqual([['owl', '20261013']]);
        expect(h.ids('unscheduled-with-realtime')).toEqual([]);
      });

      it('step 2: else the candidate date on which the trip operates, the later if both', async () => {
        const h = await setup(overnight, NIGHT);
        h.push('vehiclePositions', [
          vehicle('a', { trip: { tripId: 'today-only' } }),
          vehicle('b', { trip: { tripId: 'yesterday-only' } }),
          vehicle('c', { trip: { tripId: 'both-days' } }), // 23:30 yesterday is active at 00:20
        ]);
        const rows = h.engine.list('unscheduled-with-realtime').trips;
        expect(rows.map((t) => [t.tripId, t.serviceDate, t.reason])).toEqual([
          ['today-only', '20261014', 'outside_scheduled_time'],
          ['yesterday-only', '20261013', 'outside_scheduled_time'],
        ]);
        expect(
          h.engine.list('active-with-realtime').trips.map((t) => [t.tripId, t.serviceDate]),
        ).toEqual([['both-days', '20261013']]);
      });

      it('step 2 with no active entry: both dates operate, the later wins', async () => {
        const h = await setup(overnight); // midday
        h.push('vehiclePositions', [vehicle('a', { trip: { tripId: 'both-days' } })]);
        expect(
          h.engine.list('unscheduled-with-realtime').trips.map((t) => [t.tripId, t.serviceDate]),
        ).toEqual([['both-days', '20261014']]);
      });

      it('step 3: else today', async () => {
        const h = await setup(overnight);
        h.push('vehiclePositions', [
          vehicle('a', { trip: { tripId: 'unknown-trip' } }),
          vehicle('b', { trip: { tripId: 'yesterday-only' } }), // midday: yesterday-only operates yesterday only
        ]);
        h.push('tripUpdates', []);
        const rows = h.engine.list('unscheduled-with-realtime').trips;
        expect(rows.find((t) => t.tripId === 'unknown-trip')!.serviceDate).toBe('20261014');
        expect(rows.find((t) => t.tripId === 'yesterday-only')!.serviceDate).toBe('20261013');
      });

      it('a frequency reference with a start_time prefers the date with an active instance starting then', async () => {
        const h = await setup(overnight, NIGHT);
        // 00:20 on the 14th: yesterday's instances starting 24:00, 24:10 and 24:20 are active,
        // today's first instance starts at 23:00
        h.push('vehiclePositions', [
          vehicle('a', { trip: { tripId: 'freq-both', startTime: '24:10:00' } }), // an active instance
          vehicle('b', { trip: { tripId: 'freq-both', startTime: '23:10:00' } }), // names no active instance
          vehicle('c', { trip: { tripId: 'freq-both' } }), // no start_time: any active entry will do
        ]);
        expect(
          h.engine
            .list('active-with-realtime')
            .trips.map((t) => [t.serviceDate, t.scheduledStart, t.realtime?.startTime]),
        ).toEqual([['20261013', local('00:10:00'), '24:10:00']]);
        expect(
          h.engine
            .list('unscheduled-with-realtime')
            .trips.map((t) => [t.serviceDate, t.reason, t.realtime?.startTime]),
        ).toEqual([
          ['20261013', 'missing_start_time', null],
          ['20261014', 'outside_scheduled_time', '23:10:00'],
        ]);
      });
    });
  });
});
