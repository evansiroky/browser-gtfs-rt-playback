import { agencyInstant } from '@gtfs-rt-debugger/fixtures';
import type { TripListItem } from '@gtfs-rt-debugger/shared';
import { describe, expect, it } from 'vitest';
import {
  harness,
  loadSchedule,
  update,
  vehicle,
  type ScheduleSpec,
} from '../test-support/trips.js';

/** Wed 2026-10-14 12:07:42 PDT; the current minute starts at 12:07:00. */
const NOW = '2026-10-14T19:07:42Z';
const local = (hms: string, date = '20261014'): number =>
  agencyInstant(date, hms, 'America/Los_Angeles').getTime() / 1000;

const SCHEDULE: ScheduleSpec = {
  calendar: { DAILY: {}, NEVER: { days: '0000000' } },
  trips: [
    { id: 'plain', start: '12:00:00', end: '13:00:00', headsign: 'Downtown', route: 'R2' },
    { id: 'future', start: '14:00:00', end: '15:00:00' },
    { id: 'past', start: '10:00:00', end: '11:00:00' },
    { id: 'never', service: 'NEVER', start: '12:00:00', end: '13:00:00' },
    {
      id: 'freq',
      start: '06:00:00',
      end: '06:20:00',
      freq: [['11:50:00', '12:50:00', 600, '0']],
    },
    {
      id: 'freq-never',
      service: 'NEVER',
      start: '06:00:00',
      end: '06:20:00',
      freq: [['11:50:00', '12:50:00', 600, '0']],
    },
    {
      id: 'mixed',
      start: '06:00:00',
      end: '06:20:00',
      freq: [
        ['11:50:00', '12:50:00', 600, '1'],
        ['12:50:00', '13:50:00', 600, ''],
      ],
    },
    {
      id: 'mixed-never',
      service: 'NEVER',
      start: '06:00:00',
      end: '06:20:00',
      freq: [
        ['11:50:00', '12:50:00', 600, '1'],
        ['12:50:00', '13:50:00', 600, ''],
      ],
    },
    { id: 'no-stops', stops: [] },
  ],
};

async function setup(spec: ScheduleSpec = SCHEDULE, now = NOW) {
  return harness({ now, store: await loadSchedule(spec) });
}

const lists = (h: Awaited<ReturnType<typeof setup>>) => ({
  withRealtime: h.engine.list('active-with-realtime').trips,
  without: h.engine.list('active-without-realtime').trips,
  unscheduled: h.engine.list('unscheduled-with-realtime').trips,
});

const summary = (rows: TripListItem[]) => rows.map((r) => [r.tripId, r.reason, r.scheduledStart]);

describe('matching', () => {
  it('a plain entry is matched by trip ID and service date alone', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'plain', startTime: '03:00:00' } }), // start_time is ignored
    ]);
    const { withRealtime, unscheduled } = lists(h);
    expect(withRealtime.map((r) => r.tripId)).toEqual(['plain']);
    expect(withRealtime[0]!.realtime?.startTime).toBe('03:00:00');
    expect(unscheduled).toEqual([]);
  });

  it('a reference with the right trip but another service date does not match', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'plain', startDate: '20261013' } }),
    ]);
    const { withRealtime, without, unscheduled } = lists(h);
    expect(withRealtime).toEqual([]);
    expect(without.map((r) => r.tripId)).toContain('plain');
    expect(summary(unscheduled)).toEqual([
      ['plain', 'outside_scheduled_time', local('12:00:00', '20261013')],
    ]);
    expect(unscheduled[0]!.serviceDate).toBe('20261013');
  });

  it('a frequency instance is matched only by its exact start', async () => {
    const h = await setup();
    // instances 11:50, 12:00, 12:10 ... ; active at 12:07: 11:50 (ends 12:10), 12:00, 12:10? no: 12:10 starts after the minute
    h.push('vehiclePositions', [
      vehicle('exact', { trip: { tripId: 'freq', startTime: '12:00:00' } }),
      vehicle('late', { trip: { tripId: 'freq', startTime: '12:00:01' } }),
      vehicle('early', { trip: { tripId: 'freq', startTime: '11:59:59' } }),
    ]);
    const { withRealtime, without, unscheduled } = lists(h);
    expect(withRealtime.map((r) => [r.tripId, r.scheduledStart])).toEqual([
      ['freq', local('12:00:00')],
    ]);
    expect(without.map((r) => [r.tripId, r.scheduledStart])).toEqual([
      ['freq', local('11:50:00')],
      ['plain', local('12:00:00')],
    ]);
    expect(summary(unscheduled)).toEqual([
      ['freq', 'unmatched_start_time', null],
      ['freq', 'unmatched_start_time', null],
    ]);
  });

  it('start_time 6:00:00 and 06:00:00 name the same instant', async () => {
    const h = await setup(
      {
        trips: [
          {
            id: 'f',
            start: '01:00:00',
            end: '01:30:00',
            freq: [['06:00:00', '08:00:00', 3600, '0']],
          },
        ],
      },
      '2026-10-14T13:10:00Z',
    );
    h.push('vehiclePositions', [vehicle('a', { trip: { tripId: 'f', startTime: '6:00:00' } })]);
    expect(lists(h).withRealtime.map((r) => r.tripId)).toEqual(['f']);
  });

  it('an entry has realtime data when at least one reference matches, from either feed', async () => {
    const h = await setup();
    h.push('tripUpdates', [update('u', { trip: { tripId: 'plain' } })]);
    expect(
      lists(h).withRealtime.map((r) => [
        r.tripId,
        r.realtime?.hasTripUpdate,
        r.realtime?.hasVehiclePosition,
      ]),
    ).toEqual([['plain', true, false]]);
  });

  it('a frequency trip is in lists 1 or 2 for its active instances and in list 3 for the rest at once', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('a', { trip: { tripId: 'freq', startTime: '12:00:00' } }),
      vehicle('b', { trip: { tripId: 'freq', startTime: '12:30:00' } }), // an instance, not active
    ]);
    const { withRealtime, without, unscheduled } = lists(h);
    expect(withRealtime.map((r) => r.tripId)).toEqual(['freq']);
    expect(without.map((r) => r.tripId)).toEqual(['freq', 'plain']);
    expect(summary(unscheduled)).toEqual([['freq', 'outside_scheduled_time', local('12:30:00')]]);
  });
});

describe('the reasons of list 3, in precedence order', () => {
  const reasonOf = async (descriptor: object, now = NOW) => {
    const h = await setup(SCHEDULE, now);
    h.push('vehiclePositions', [vehicle('v', { trip: descriptor })]);
    return lists(h).unscheduled.map((r) => r.reason);
  };

  it('unknown_trip: the trip ID is not in trips.txt', async () => {
    expect(
      await reasonOf({ tripId: 'ghost', startDate: '20261014', startTime: '12:00:00' }),
    ).toEqual(['unknown_trip']);
  });

  it.each(['mixed', 'mixed-never', 'no-stops'])(
    'configuration_error: %s, before every later reason',
    async (tripId) => {
      expect(await reasonOf({ tripId })).toEqual(['configuration_error']);
      expect(await reasonOf({ tripId, startTime: '12:00:00' })).toEqual(['configuration_error']);
    },
  );

  it('not_in_service: the trip does not operate on the reference date, before the start_time reasons', async () => {
    expect(await reasonOf({ tripId: 'never' })).toEqual(['not_in_service']);
    expect(await reasonOf({ tripId: 'freq-never' })).toEqual(['not_in_service']); // no start_time
    expect(await reasonOf({ tripId: 'freq-never', startTime: '03:33:33' })).toEqual([
      'not_in_service',
    ]);
    expect(await reasonOf({ tripId: 'plain', startDate: '20301231' })).toEqual([
      'outside_scheduled_time',
    ]);
  });

  it('missing_start_time: a frequency trip and no start_time (absent or empty)', async () => {
    expect(await reasonOf({ tripId: 'freq' })).toEqual(['missing_start_time']);
    expect(await reasonOf({ tripId: 'freq', startTime: '' })).toEqual(['missing_start_time']);
  });

  it('unmatched_start_time: a start that equals no instance, including one that is not a time', async () => {
    expect(await reasonOf({ tripId: 'freq', startTime: '12:00:30' })).toEqual([
      'unmatched_start_time',
    ]);
    expect(await reasonOf({ tripId: 'freq', startTime: '12:50:00' })).toEqual([
      'unmatched_start_time',
    ]); // the end
    expect(await reasonOf({ tripId: 'freq', startTime: '11:40:00' })).toEqual([
      'unmatched_start_time',
    ]); // before the window
    expect(await reasonOf({ tripId: 'freq', startTime: 'noon' })).toEqual(['unmatched_start_time']);
    expect(await reasonOf({ tripId: 'freq', startTime: '12:0:00' })).toEqual([
      'unmatched_start_time',
    ]);
  });

  it('outside_scheduled_time: operates that day but the named entry does not overlap the minute', async () => {
    expect(await reasonOf({ tripId: 'future' })).toEqual(['outside_scheduled_time']);
    expect(await reasonOf({ tripId: 'past' })).toEqual(['outside_scheduled_time']);
    expect(await reasonOf({ tripId: 'freq', startTime: '12:30:00' })).toEqual([
      'outside_scheduled_time',
    ]);
    expect(
      await reasonOf({ tripId: 'freq', startTime: '11:50:00' }, '2026-10-14T19:21:00Z'),
    ).toEqual(['outside_scheduled_time']);
  });

  it('carries the span of the named entry only for outside_scheduled_time', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'future' } }),
      vehicle('2', { trip: { tripId: 'never' } }),
      vehicle('3', { trip: { tripId: 'mixed', startTime: '12:00:00' } }),
      vehicle('4', { trip: { tripId: 'freq' } }),
      vehicle('5', { trip: { tripId: 'freq', startTime: '12:00:30' } }),
      vehicle('6', { trip: { tripId: 'ghost' } }),
    ]);
    expect(
      lists(h).unscheduled.map((r) => [r.tripId, r.reason, r.scheduledStart, r.scheduledEnd]),
    ).toEqual([
      ['ghost', 'unknown_trip', null, null],
      ['mixed', 'configuration_error', null, null],
      ['never', 'not_in_service', null, null],
      ['freq', 'missing_start_time', null, null],
      ['freq', 'unmatched_start_time', null, null],
      ['future', 'outside_scheduled_time', local('14:00:00'), local('15:00:00')],
    ]);
  });
});

describe('grouping of list 3', () => {
  it('references to one trip ID from both feeds and several vehicles are one row', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'future' }, vehicle: { id: 'bus-1' }, timestamp: 1000 }),
      vehicle('2', { trip: { tripId: 'future' }, vehicle: { id: 'bus-2' }, timestamp: 2000 }),
      vehicle('3', { trip: { tripId: 'future' }, vehicle: { id: 'bus-1' }, timestamp: 1500 }),
    ]);
    h.push('tripUpdates', [update('u', { trip: { tripId: 'future' }, vehicle: { id: 'bus-3' } })]);
    const rows = lists(h).unscheduled;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.realtime).toEqual({
      vehicleIds: ['bus-1', 'bus-2', 'bus-3'],
      hasVehiclePosition: true,
      hasTripUpdate: true,
      startTime: null,
      lastSeenAt: 2000,
    });
  });

  it('frequency trips are also grouped by start', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'freq', startTime: '12:30:00' }, vehicle: { id: 'a' } }),
      vehicle('2', { trip: { tripId: 'freq', startTime: '12:30:00' }, vehicle: { id: 'b' } }),
      vehicle('3', { trip: { tripId: 'freq', startTime: '12:40:00' }, vehicle: { id: 'c' } }),
      vehicle('4', { trip: { tripId: 'freq', startTime: '12:40:30' }, vehicle: { id: 'd' } }),
      vehicle('5', { trip: { tripId: 'freq' }, vehicle: { id: 'e' } }),
    ]);
    expect(
      lists(h).unscheduled.map((r) => [r.reason, r.realtime?.startTime, r.realtime?.vehicleIds]),
    ).toEqual([
      ['missing_start_time', null, ['e']],
      ['unmatched_start_time', '12:40:30', ['d']],
      ['outside_scheduled_time', '12:30:00', ['a', 'b']],
      ['outside_scheduled_time', '12:40:00', ['c']],
    ]);
  });

  it('a group naming several service dates takes the latest', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'future', startDate: '20261014' } }),
      vehicle('2', { trip: { tripId: 'future', startDate: '20261013' } }),
      vehicle('3', { trip: { tripId: 'future', startDate: '20261015' } }),
    ]);
    const rows = lists(h).unscheduled;
    expect(rows.map((r) => [r.serviceDate, r.scheduledStart])).toEqual([
      ['20261015', local('14:00:00', '20261015')],
    ]);
  });

  it('a matched reference does not appear in list 3 even when the trip also has unmatched ones', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'plain', startDate: '20261014' } }),
      vehicle('2', { trip: { tripId: 'plain', startDate: '20261013' } }),
    ]);
    const { withRealtime, unscheduled } = lists(h);
    expect(withRealtime[0]!.realtime?.vehicleIds).toEqual([]);
    expect(unscheduled.map((r) => r.serviceDate)).toEqual(['20261013']);
  });
});

describe('row fields', () => {
  it('route and headsign come from trips.txt and routes.txt; empty cells are nulls', async () => {
    const h = await setup();
    const { without } = lists(h);
    expect(without.find((r) => r.tripId === 'plain')).toMatchObject({
      routeId: 'R2',
      routeShortName: '2',
      routeLongName: 'Two',
      headsign: 'Downtown',
    });
    expect(without.find((r) => r.tripId === 'freq')).toMatchObject({
      headsign: null,
      routeId: 'R1',
    });
  });

  it('an unknown trip takes the route ID of its reference and looks the names up in routes.txt', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'ghost-known', routeId: 'R2' } }),
      vehicle('2', { trip: { tripId: 'ghost-unknown', routeId: 'R-GHOST' } }),
      vehicle('3', { trip: { tripId: 'ghost-none' } }),
    ]);
    h.push('tripUpdates', [update('4', { trip: { tripId: 'ghost-tu', routeId: 'R1' } })]);
    expect(
      lists(h).unscheduled.map((r) => [
        r.tripId,
        r.routeId,
        r.routeShortName,
        r.routeLongName,
        r.headsign,
      ]),
    ).toEqual([
      ['ghost-known', 'R2', '2', 'Two', null],
      ['ghost-none', null, null, null, null],
      ['ghost-tu', 'R1', '1', 'One', null],
      ['ghost-unknown', 'R-GHOST', null, null, null],
    ]);
  });

  it('a known trip ignores the route ID of the reference', async () => {
    const h = await setup();
    h.push('vehiclePositions', [vehicle('1', { trip: { tripId: 'future', routeId: 'R2' } })]);
    expect(lists(h).unscheduled[0]).toMatchObject({ routeId: 'R1', routeShortName: '1' });
  });

  it('a frequency list-3 row describes the row whose window contains the start, else null', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'freq', startTime: '12:30:00' } }),
      vehicle('2', { trip: { tripId: 'freq', startTime: '13:30:00' } }),
      vehicle('3', { trip: { tripId: 'freq' } }),
    ]);
    expect(lists(h).unscheduled.map((r) => [r.reason, r.frequency])).toEqual([
      ['missing_start_time', null],
      ['unmatched_start_time', null],
      [
        'outside_scheduled_time',
        {
          exactTimes: false,
          headwaySecs: 600,
          windowStart: local('11:50:00'),
          windowEnd: local('12:50:00'),
        },
      ],
    ]);
  });

  it('realtime: distinct vehicle IDs, flags, the first start_time, newest vehicle timestamp else feed timestamp', async () => {
    const h = await setup();
    h.push(
      'vehiclePositions',
      [
        vehicle('1', { trip: { tripId: 'plain' }, vehicle: { id: 'a' }, timestamp: 1700000100 }),
        vehicle('2', {
          trip: { tripId: 'plain', startTime: '12:00:00' },
          vehicle: { id: 'b' },
          timestamp: 1700000300,
        }),
        vehicle('3', {
          trip: { tripId: 'plain', startTime: '12:01:00' },
          vehicle: { id: 'a' },
          timestamp: 1700000200,
        }),
        vehicle('4', { trip: { tripId: 'plain' } }), // no vehicle ID, no timestamp: adds nothing
      ],
      1_700_000_999,
    );
    h.push(
      'tripUpdates',
      [update('u', { trip: { tripId: 'plain' }, vehicle: { id: 'c' } })],
      1_700_000_555,
    );
    expect(lists(h).withRealtime[0]!.realtime).toEqual({
      vehicleIds: ['a', 'b', 'c'],
      hasVehiclePosition: true,
      hasTripUpdate: true,
      startTime: '12:00:00',
      lastSeenAt: 1700000300,
    });
  });

  it('lastSeenAt is the feed timestamp when no vehicle position gives one', async () => {
    const h = await setup();
    h.push('tripUpdates', [update('u', { trip: { tripId: 'plain' } })], 1_700_000_555);
    expect(lists(h).withRealtime[0]!.realtime?.lastSeenAt).toBe(1_700_000_555);
    const g = await setup();
    g.push('vehiclePositions', [vehicle('v', { trip: { tripId: 'plain' } })], 1_700_000_777);
    expect(lists(g).withRealtime[0]!.realtime?.lastSeenAt).toBe(1_700_000_777);
    const none = await setup();
    none.push('tripUpdates', [update('u', { trip: { tripId: 'plain' } })], null);
    expect(lists(none).withRealtime[0]!.realtime?.lastSeenAt).toBeNull();
  });
});

describe('ordering', () => {
  it('lists 1 and 2: by start, earliest first, then trip ID', async () => {
    const h = await setup({
      trips: [
        { id: 'b', start: '12:00:00', end: '13:00:00' },
        { id: 'a', start: '12:00:00', end: '13:00:00' },
        { id: 'c', start: '11:00:00', end: '13:00:00' },
        { id: 'B', start: '12:05:00', end: '13:00:00' },
        { id: 'late', start: '12:07:30', end: '13:00:00' },
      ],
    });
    expect(lists(h).without.map((r) => r.tripId)).toEqual(['c', 'a', 'b', 'B', 'late']);
    h.push(
      'vehiclePositions',
      ['late', 'b', 'c', 'a', 'B'].map((id) => vehicle(id, { trip: { tripId: id } })),
    );
    expect(lists(h).withRealtime.map((r) => r.tripId)).toEqual(['c', 'a', 'b', 'B', 'late']);
  });

  it('list 3: by reason in the order listed, then trip ID, then start', async () => {
    const h = await setup();
    h.push('vehiclePositions', [
      vehicle('1', { trip: { tripId: 'plain', startDate: '20261013' } }),
      vehicle('2', { trip: { tripId: 'past' } }),
      vehicle('3', { trip: { tripId: 'freq', startTime: '12:40:00' } }),
      vehicle('4', { trip: { tripId: 'freq', startTime: '12:20:00' } }),
      vehicle('5', { trip: { tripId: 'freq', startTime: '12:30:30' } }),
      vehicle('6', { trip: { tripId: 'freq' } }),
      vehicle('7', { trip: { tripId: 'never' } }),
      vehicle('8', { trip: { tripId: 'mixed' } }),
      vehicle('9', { trip: { tripId: 'zzz' } }),
      vehicle('10', { trip: { tripId: 'aaa' } }),
    ]);
    expect(lists(h).unscheduled.map((r) => [r.reason, r.tripId, r.realtime?.startTime])).toEqual([
      ['unknown_trip', 'aaa', null],
      ['unknown_trip', 'zzz', null],
      ['configuration_error', 'mixed', null],
      ['not_in_service', 'never', null],
      ['missing_start_time', 'freq', null],
      ['unmatched_start_time', 'freq', '12:30:30'],
      ['outside_scheduled_time', 'freq', '12:20:00'],
      ['outside_scheduled_time', 'freq', '12:40:00'],
      ['outside_scheduled_time', 'past', null],
      ['outside_scheduled_time', 'plain', null],
    ]);
  });
});
