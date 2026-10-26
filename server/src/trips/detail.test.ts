import { agencyInstant } from '@gtfs-rt-debugger/fixtures';
import { describe, expect, it } from 'vitest';
import {
  harness,
  loadSchedule,
  update,
  vehicle,
  type ScheduleSpec,
} from '../test-support/trips.js';

const NOW = '2026-10-14T19:07:42Z';
const MINUTE = 60_000;
const local = (hms: string, date = '20261014'): number =>
  agencyInstant(date, hms, 'America/Los_Angeles').getTime() / 1000;

async function setup(spec: ScheduleSpec, now = NOW) {
  return harness({ now, store: await loadSchedule(spec) });
}

describe('trip detail', () => {
  it('is null when the trip ID is in neither the schedule nor the retained realtime data', async () => {
    const h = await setup({ trips: [{ id: 'A', start: '12:00:00', end: '13:00:00' }] });
    h.push('vehiclePositions', [vehicle('v', { trip: { tripId: 'B' } })]);
    expect(h.engine.detail('nope')).toBeNull();
    expect(h.engine.detail('A')).not.toBeNull();
    expect(h.engine.detail('B')).not.toBeNull();
  });

  it('a trip that only retained pings know is found, though the latest snapshot no longer has it', async () => {
    const h = await setup({ trips: [] });
    h.push('vehiclePositions', [
      vehicle('v', { trip: { tripId: 'gone' }, vehicle: { id: 'a' }, timestamp: 5 }),
    ]);
    h.clock.advance(10_000);
    h.push('vehiclePositions', []);
    const detail = h.engine.detail('gone')!;
    expect(detail.scheduled).toBeNull();
    expect(detail.classification).toEqual([]);
    expect(detail.realtime.pings.map((p) => [p.sequence, p.vehicleId])).toEqual([[1, 'a']]);
    expect(detail.realtime.tripUpdate).toBeNull();
    expect(detail.serviceDate).toBe('20261014');
  });

  it('a realtime-only unknown trip is classified unknown_trip with no span', async () => {
    const h = await setup({ trips: [] });
    h.push('vehiclePositions', [
      vehicle('v', { trip: { tripId: 'ghost', startDate: '20261013' } }),
    ]);
    expect(h.engine.detail('ghost')).toMatchObject({
      tripId: 'ghost',
      serviceDate: '20261013',
      scheduled: null,
      classification: [
        { list: 'unscheduled-with-realtime', reason: 'unknown_trip', start: null, end: null },
      ],
    });
  });

  describe('classification: one per active entry or unmatched reference', () => {
    const spec: ScheduleSpec = {
      trips: [
        { id: 'plain', start: '12:00:00', end: '13:00:00' },
        {
          id: 'freq',
          start: '06:00:00',
          end: '06:20:00',
          freq: [['11:50:00', '12:50:00', 600, '0']],
        },
      ],
    };

    it('is empty for a trip in no list', async () => {
      const h = await setup(spec, '2026-10-14T21:00:00Z');
      expect(h.engine.detail('plain')!.classification).toEqual([]);
    });

    it('a plain active trip', async () => {
      const h = await setup(spec);
      expect(h.engine.detail('plain')!.classification).toEqual([
        {
          list: 'active-without-realtime',
          reason: null,
          start: local('12:00:00'),
          end: local('13:00:00'),
        },
      ]);
      h.push('tripUpdates', [update('u', { trip: { tripId: 'plain' } })]);
      expect(h.engine.detail('plain')!.classification).toEqual([
        {
          list: 'active-with-realtime',
          reason: null,
          start: local('12:00:00'),
          end: local('13:00:00'),
        },
      ]);
    });

    it('a frequency trip appears once per active instance and per unmatched reference, in list order', async () => {
      const h = await setup(spec);
      h.push('vehiclePositions', [
        vehicle('a', { trip: { tripId: 'freq', startTime: '12:00:00' } }),
        vehicle('b', { trip: { tripId: 'freq', startTime: '12:30:00' } }),
        vehicle('c', { trip: { tripId: 'freq' } }),
      ]);
      expect(h.engine.detail('freq')!.classification).toEqual([
        {
          list: 'active-with-realtime',
          reason: null,
          start: local('12:00:00'),
          end: local('12:20:00'),
        },
        {
          list: 'active-without-realtime',
          reason: null,
          start: local('11:50:00'),
          end: local('12:10:00'),
        },
        { list: 'unscheduled-with-realtime', reason: 'missing_start_time', start: null, end: null },
        {
          list: 'unscheduled-with-realtime',
          reason: 'outside_scheduled_time',
          start: local('12:30:00'),
          end: local('12:50:00'),
        },
      ]);
    });
  });

  describe('serviceDate: the latest reference start_date, else per trip-activity', () => {
    const spec: ScheduleSpec = {
      calendar: { DAILY: {}, NIGHT: { end: '20261013' } },
      trips: [
        { id: 'plain', start: '12:00:00', end: '13:00:00' },
        { id: 'owl', service: 'NIGHT', start: '23:30:00', end: '25:30:00' },
      ],
    };

    it('the greatest start_date among the references', async () => {
      const h = await setup(spec);
      h.push('vehiclePositions', [
        vehicle('a', { trip: { tripId: 'plain', startDate: '20261013' } }),
        vehicle('b', { trip: { tripId: 'plain', startDate: '20261015' } }),
        vehicle('c', { trip: { tripId: 'plain' } }),
      ]);
      h.push('tripUpdates', [update('u', { trip: { tripId: 'plain', startDate: '20261012' } })]);
      expect(h.engine.detail('plain')!.serviceDate).toBe('20261015');
    });

    it('else the date inferred for the references', async () => {
      const h = await setup(spec, '2026-10-14T07:20:00Z');
      h.push('vehiclePositions', [vehicle('a', { trip: { tripId: 'owl' } })]);
      expect(h.engine.detail('owl')!.serviceDate).toBe('20261013');
    });

    it('with no references, the date with an active entry, else the one it operates, else today', async () => {
      const night = await setup(spec, '2026-10-14T07:20:00Z');
      expect(night.engine.detail('owl')!.serviceDate).toBe('20261013'); // active then
      expect(night.engine.detail('plain')!.serviceDate).toBe('20261014');
      const noon = await setup(spec);
      expect(noon.engine.detail('owl')!.serviceDate).toBe('20261013'); // operates only yesterday
      expect(noon.engine.detail('plain')!.serviceDate).toBe('20261014');
    });
  });

  describe('scheduled', () => {
    it('carries every column of the trips.txt and routes.txt rows, as text', async () => {
      const h = await setup({
        trips: [
          {
            id: 'A',
            start: '12:00:00',
            end: '13:00:00',
            headsign: 'Downtown',
            route: 'R2',
            shape: 'sh1',
          },
        ],
      });
      const { scheduled } = h.engine.detail('A')!;
      expect(scheduled?.trip).toEqual({
        route_id: 'R2',
        service_id: 'DAILY',
        trip_id: 'A',
        trip_headsign: 'Downtown',
        shape_id: 'sh1',
      });
      expect(scheduled?.route).toEqual({
        route_id: 'R2',
        route_short_name: '2',
        route_long_name: 'Two',
        route_type: '3',
      });
      expect(scheduled?.shapeId).toBe('sh1');
    });

    it('route is null when the row is missing, shapeId when the trip has none', async () => {
      const h = await setup({
        trips: [{ id: 'A', route: 'R-GONE', start: '12:00:00', end: '13:00:00' }],
      });
      expect(h.engine.detail('A')!.scheduled).toMatchObject({ route: null, shapeId: null });
    });

    it('a plain trip: span, operating on the service date, active now', async () => {
      const h = await setup({
        trips: [
          { id: 'A', start: '12:00:00', end: '13:00:00' },
          { id: 'B', start: '14:00:00', end: '15:00:00' },
        ],
      });
      expect(h.engine.detail('A')!.scheduled).toMatchObject({
        operatesOnServiceDate: true,
        start: local('12:00:00'),
        end: local('13:00:00'),
        activeNow: true,
        frequencies: null,
        configurationErrors: [],
      });
      expect(h.engine.detail('B')!.scheduled).toMatchObject({
        activeNow: false,
        start: local('14:00:00'),
      });
    });

    it('start and end are null when the trip does not operate on the service date', async () => {
      const h = await setup({
        calendar: { DAILY: {}, NEVER: { days: '0000000' } },
        trips: [{ id: 'A', service: 'NEVER', start: '12:00:00', end: '13:00:00' }],
      });
      expect(h.engine.detail('A')!.scheduled).toMatchObject({
        operatesOnServiceDate: false,
        start: null,
        end: null,
        activeNow: false,
      });
    });

    it('operatesOnServiceDate is about the derived service date', async () => {
      const h = await setup({
        calendar: { DAILY: {}, TUE: { days: '0100000' } },
        trips: [{ id: 'A', service: 'TUE', start: '12:00:00', end: '13:00:00' }],
      });
      h.push('vehiclePositions', [vehicle('a', { trip: { tripId: 'A', startDate: '20261013' } })]); // a Tuesday
      expect(h.engine.detail('A')!.scheduled).toMatchObject({
        operatesOnServiceDate: true,
        start: local('12:00:00', '20261013'),
        activeNow: false,
      });
    });

    describe('a frequency trip', () => {
      const spec: ScheduleSpec = {
        trips: [
          {
            id: 'F',
            start: '06:00:00',
            end: '06:20:00',
            freq: [
              ['11:50:00', '12:30:00', 600, '1'],
              ['13:00:00', '14:00:00', 1800, '1'],
              ['09:00:00', '09:15:00', 600, '1'],
            ],
          },
        ],
      };

      it('lists its rows with window, template duration and the instances active now', async () => {
        const h = await setup(spec);
        const { scheduled } = h.engine.detail('F')!;
        expect(scheduled).toMatchObject({
          // first instance start 09:00:00, last end 13:30:00 + 20 minutes
          start: local('09:00:00'),
          end: local('13:50:00'),
          activeNow: true,
        });
        expect(scheduled!.frequencies).toEqual([
          {
            row: {
              trip_id: 'F',
              start_time: '11:50:00',
              end_time: '12:30:00',
              headway_secs: '600',
              exact_times: '1',
            },
            exactTimes: true,
            headwaySecs: 600,
            windowStart: local('11:50:00'),
            windowEnd: local('12:30:00'),
            templateDurationSecs: 1200,
            activeNow: true,
            activeInstanceStarts: [local('11:50:00'), local('12:00:00')],
          },
          {
            row: {
              trip_id: 'F',
              start_time: '13:00:00',
              end_time: '14:00:00',
              headway_secs: '1800',
              exact_times: '1',
            },
            exactTimes: true,
            headwaySecs: 1800,
            windowStart: local('13:00:00'),
            windowEnd: local('14:00:00'),
            templateDurationSecs: 1200,
            activeNow: false,
            activeInstanceStarts: [],
          },
          {
            row: {
              trip_id: 'F',
              start_time: '09:00:00',
              end_time: '09:15:00',
              headway_secs: '600',
              exact_times: '1',
            },
            exactTimes: true,
            headwaySecs: 600,
            windowStart: local('09:00:00'),
            windowEnd: local('09:15:00'),
            templateDurationSecs: 1200,
            activeNow: false,
            activeInstanceStarts: [],
          },
        ]);
      });

      it('lists the instances active now from both candidate service dates', async () => {
        const h = await setup(
          {
            trips: [
              {
                id: 'F',
                start: '06:00:00',
                end: '06:30:00',
                freq: [['00:00:00', '26:00:00', 1200, '0']],
              },
            ],
          },
          '2026-10-14T07:20:00Z', // 00:20: yesterday's 24:00 and 24:20 instances, today's 00:00 and 00:20
        );
        const { scheduled } = h.engine.detail('F')!;
        // yesterday's 24:00:00 and 24:20:00 instances start at the instants of today's 00:00:00 and
        // 00:20:00 ones, and are the same entries
        expect(scheduled!.frequencies![0]!.activeInstanceStarts).toEqual([
          local('00:00:00'),
          local('00:20:00'),
        ]);
      });
    });

    it('keeps a frequency row it cannot read, with its columns and nulls for the values it cannot give', async () => {
      const h = await setup({
        trips: [
          {
            id: 'F',
            start: '06:00:00',
            end: '06:20:00',
            freq: [
              ['12:00:00', '12:30:00', 600, '0'],
              ['noon', '13:00:00', 600, '0'],
              ['12:00:00', '13:00:00', 'often', '0'],
              ['13:00:00', '', 0, '0'],
            ],
          },
        ],
      });
      const rows = h.engine.detail('F')!.scheduled!.frequencies!;
      expect(
        rows.map((r) => [r.row['start_time'], r.windowStart, r.windowEnd, r.headwaySecs]),
      ).toEqual([
        ['12:00:00', local('12:00:00'), local('12:30:00'), 600],
        ['noon', null, local('13:00:00'), 600],
        ['12:00:00', local('12:00:00'), local('13:00:00'), null],
        ['13:00:00', local('13:00:00'), null, null],
      ]);
      expect(
        rows.slice(1).map((r) => [r.activeNow, r.activeInstanceStarts, r.templateDurationSecs]),
      ).toEqual([
        [false, [], 1200],
        [false, [], 1200],
        [false, [], 1200],
      ]);
      expect(rows[0]!.activeNow).toBe(true);
    });

    it('lists active instances of both candidate service dates, each at its own instant', async () => {
      // 10-hour template, an instance an hour from 00:00:00 to 30:00:00: at 00:20 the instances
      // that started yesterday at 15:00 to 23:00 are running, and 24:00:00 yesterday is 00:00 today
      const h = await setup(
        {
          trips: [
            {
              id: 'F',
              start: '06:00:00',
              end: '16:00:00',
              freq: [['00:00:00', '30:00:00', 3600, '0']],
            },
          ],
        },
        '2026-10-14T07:20:00Z',
      );
      const yesterday = (hour: number) => local(`${hour}:00:00`, '20261013');
      const expected = [15, 16, 17, 18, 19, 20, 21, 22, 23]
        .map(yesterday)
        .concat(local('00:00:00'));
      expect(h.engine.detail('F')!.scheduled!.frequencies![0]!.activeInstanceStarts).toEqual(
        expected,
      );
      expect(h.engine.dashboard().schedule?.tripsActiveNow).toBe(10);
    });

    describe('configuration errors', () => {
      it('mixed_exact_times: shown as in the feed, no entries, no span, no active instances', async () => {
        const h = await setup({
          trips: [
            {
              id: 'M',
              start: '06:00:00',
              end: '06:20:00',
              freq: [
                ['11:50:00', '12:30:00', 600, '1'],
                ['12:30:00', '13:00:00', 600, ''],
              ],
            },
          ],
        });
        h.push('vehiclePositions', [
          vehicle('a', { trip: { tripId: 'M', startTime: '12:00:00' } }),
        ]);
        const detail = h.engine.detail('M')!;
        expect(detail.classification).toEqual([
          {
            list: 'unscheduled-with-realtime',
            reason: 'configuration_error',
            start: null,
            end: null,
          },
        ]);
        expect(detail.scheduled).toMatchObject({
          start: null,
          end: null,
          activeNow: false,
          configurationErrors: [
            { code: 'mixed_exact_times', message: expect.stringContaining('exact_times') },
          ],
        });
        expect(
          detail.scheduled!.frequencies!.map((f) => [
            f.templateDurationSecs,
            f.activeNow,
            f.activeInstanceStarts,
          ]),
        ).toEqual([
          [1200, false, []],
          [1200, false, []],
        ]);
      });

      it('unusable_stop_times: no span, no template duration', async () => {
        const h = await setup({
          trips: [
            { id: 'P', stops: [] },
            {
              id: 'F',
              stops: [
                ['', ''],
                ['12:00:00', '12:00:00'],
              ],
              freq: [['11:50:00', '12:30:00', 600, '0']],
            },
          ],
        });
        expect(h.engine.detail('P')!.scheduled).toMatchObject({
          start: null,
          end: null,
          activeNow: false,
          frequencies: null,
          configurationErrors: [
            { code: 'unusable_stop_times', message: expect.stringContaining('stop_times') },
          ],
        });
        const freq = h.engine.detail('F')!.scheduled!;
        expect(freq).toMatchObject({ start: null, end: null, activeNow: false });
        expect(freq.frequencies).toHaveLength(1);
        expect(freq.frequencies![0]).toMatchObject({
          templateDurationSecs: null,
          activeNow: false,
          activeInstanceStarts: [],
          windowStart: local('11:50:00'),
        });
      });

      it('a trip with both lists both, mixed first', async () => {
        const h = await setup({
          trips: [
            {
              id: 'B',
              stops: [],
              freq: [
                ['11:50:00', '12:30:00', 600, '1'],
                ['12:30:00', '13:00:00', 600, '0'],
              ],
            },
          ],
        });
        expect(h.engine.detail('B')!.scheduled!.configurationErrors.map((e) => e.code)).toEqual([
          'mixed_exact_times',
          'unusable_stop_times',
        ]);
      });
    });
  });

  describe('realtime', () => {
    it('has every retained ping of every vehicle, ascending by sequence, though some stopped reporting', async () => {
      const h = await setup({ trips: [{ id: 'A', start: '12:00:00', end: '13:00:00' }] });
      h.push('vehiclePositions', [
        vehicle('1', { trip: { tripId: 'A' }, vehicle: { id: 'old' }, timestamp: 100 }),
        vehicle('2', { trip: { tripId: 'B' }, vehicle: { id: 'other' }, timestamp: 100 }),
      ]);
      h.clock.advance(10_000);
      h.push('vehiclePositions', [
        vehicle('3', { trip: { tripId: 'A' }, vehicle: { id: 'new' }, timestamp: 200 }),
        vehicle('4', { trip: { tripId: 'A' }, vehicle: { id: 'new' }, timestamp: 210 }),
      ]);
      expect(
        h.engine.detail('A')!.realtime.pings.map((p) => [p.sequence, p.vehicleId, p.timestamp]),
      ).toEqual([
        [1, 'old', 100],
        [2, 'new', 200],
        [3, 'new', 210],
      ]);
    });

    it('drops pings older than the retention window', async () => {
      const h = await setup({ trips: [{ id: 'A', start: '12:00:00', end: '13:00:00' }] });
      h.push('vehiclePositions', [vehicle('1', { trip: { tripId: 'A' }, timestamp: 1 })]);
      h.clock.advance(61 * MINUTE);
      h.push('vehiclePositions', [vehicle('1', { trip: { tripId: 'A' }, timestamp: 2 })]);
      expect(h.engine.detail('A')!.realtime.pings.map((p) => p.sequence)).toEqual([2]);
    });

    describe('tripUpdate: the latest snapshot’s update for the trip', () => {
      const spec: ScheduleSpec = { trips: [{ id: 'A', start: '12:00:00', end: '13:00:00' }] };

      it('is null without one, and when only an older snapshot had it', async () => {
        const h = await setup(spec);
        expect(h.engine.detail('A')!.realtime.tripUpdate).toBeNull();
        h.push('tripUpdates', [update('u', { trip: { tripId: 'A' } })]);
        h.clock.advance(10_000);
        h.push('tripUpdates', [update('u', { trip: { tripId: 'B' } })]);
        expect(h.engine.detail('A')!.realtime.tripUpdate).toBeNull();
      });

      it('summarizes it', async () => {
        const h = await setup(spec);
        h.push(
          'tripUpdates',
          [
            update('u', {
              trip: { tripId: 'A', startTime: '12:00:00', scheduleRelationship: 3 },
              vehicle: { id: 'bus-9' },
              timestamp: 1_700_000_050,
              delay: -45,
              stopTimeUpdate: [{ stopSequence: 1 }, { stopSequence: 2 }, { stopSequence: 3 }],
            }),
          ],
          1_700_000_100,
        );
        expect(h.engine.detail('A')!.realtime.tripUpdate).toEqual({
          feedTimestamp: 1_700_000_100,
          timestamp: 1_700_000_050,
          delay: -45,
          vehicleId: 'bus-9',
          startTime: '12:00:00',
          scheduleRelationship: 'CANCELED',
          stopTimeUpdateCount: 3,
        });
      });

      it('nulls what the update does not carry', async () => {
        const h = await setup(spec);
        h.push('tripUpdates', [update('u', { trip: { tripId: 'A' } })], null);
        expect(h.engine.detail('A')!.realtime.tripUpdate).toEqual({
          feedTimestamp: null,
          timestamp: null,
          delay: null,
          vehicleId: null,
          startTime: null,
          scheduleRelationship: null,
          stopTimeUpdateCount: 0,
        });
      });

      it('a delay of zero is a delay', async () => {
        const h = await setup(spec);
        h.push('tripUpdates', [update('u', { trip: { tripId: 'A' }, delay: 0, timestamp: 0 })]);
        expect(h.engine.detail('A')!.realtime.tripUpdate).toMatchObject({ delay: 0, timestamp: 0 });
      });

      it('with several updates (instances) the newest by timestamp wins', async () => {
        const h = await setup(spec);
        h.push('tripUpdates', [
          update('1', { trip: { tripId: 'A', startTime: '12:00:00' }, timestamp: 300, delay: 1 }),
          update('2', { trip: { tripId: 'A', startTime: '12:10:00' }, timestamp: 500, delay: 2 }),
          update('3', { trip: { tripId: 'A', startTime: '12:20:00' }, timestamp: 400, delay: 3 }),
          update('4', { trip: { tripId: 'A', startTime: '12:30:00' }, delay: 4 }),
        ]);
        expect(h.engine.detail('A')!.realtime.tripUpdate).toMatchObject({
          startTime: '12:10:00',
          delay: 2,
        });
      });
    });
  });
});
