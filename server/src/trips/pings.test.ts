import { describe, expect, it } from 'vitest';
import { harness, vehicle } from '../test-support/trips.js';

const NOW = '2026-10-14T19:07:42Z';
const MINUTE = 60_000;

const bus = (
  entity: string,
  trip: string,
  vehicleId: string | null,
  timestamp: number | null,
  more: object = {},
) =>
  vehicle(entity, {
    trip: { tripId: trip },
    ...(vehicleId === null ? {} : { vehicle: { id: vehicleId } }),
    ...(timestamp === null ? {} : { timestamp }),
    ...more,
  });

const sequences = (h: ReturnType<typeof harness>, trip: string) =>
  h.pings.forTrip(trip).map((p) => [p.sequence, p.vehicleId, p.timestamp]);

describe('PingStore', () => {
  it('records a ping once however many snapshots repeat it, identified by (trip, vehicle, timestamp)', () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [bus('e', 'T', 'v1', 1000)]);
    h.clock.advance(10_000);
    h.push('vehiclePositions', [bus('e', 'T', 'v1', 1000), bus('f', 'T', 'v1', 1010)]);
    h.clock.advance(10_000);
    h.push('vehiclePositions', [bus('e', 'T', 'v1', 1000), bus('f', 'T', 'v1', 1010)]);
    expect(sequences(h, 'T')).toEqual([
      [1, 'v1', 1000],
      [2, 'v1', 1010],
    ]);
  });

  it('the same vehicle and timestamp on another trip ID is another ping', () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [bus('a', 'T1', 'v', 1000), bus('b', 'T2', 'v', 1000)]);
    expect(sequences(h, 'T1')).toEqual([[1, 'v', 1000]]);
    expect(sequences(h, 'T2')).toEqual([[1, 'v', 1000]]);
  });

  it('numbers pings per trip ID in order of first receipt, whatever the order of the vehicles', () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [
      bus('a', 'T', 'v2', 50),
      bus('b', 'U', 'v1', 5),
      bus('c', 'T', 'v1', 10),
    ]);
    h.push('vehiclePositions', [bus('d', 'T', 'v3', 1), bus('b', 'U', 'v1', 6)]);
    expect(sequences(h, 'T')).toEqual([
      [1, 'v2', 50],
      [2, 'v1', 10],
      [3, 'v3', 1],
    ]);
    expect(sequences(h, 'U')).toEqual([
      [1, 'v1', 5],
      [2, 'v1', 6],
    ]);
  });

  it('pings across frequency instances and vehicles on one trip ID stay distinct and keep their start', () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [
      vehicle('1', {
        trip: { tripId: 'F', startDate: '20261014', startTime: '12:00:00' },
        vehicle: { id: 'a' },
        timestamp: 100,
      }),
      vehicle('2', {
        trip: { tripId: 'F', startDate: '20261014', startTime: '12:10:00' },
        vehicle: { id: 'b' },
        timestamp: 100,
      }),
      vehicle('3', {
        trip: { tripId: 'F', startDate: '20261014', startTime: '12:10:00' },
        vehicle: { id: 'a' },
        timestamp: 160,
      }),
    ]);
    expect(
      h.pings.forTrip('F').map((p) => [p.sequence, p.vehicleId, p.startTime, p.startDate]),
    ).toEqual([
      [1, 'a', '12:00:00', '20261014'],
      [2, 'b', '12:10:00', '20261014'],
      [3, 'a', '12:10:00', '20261014'],
    ]);
  });

  describe('fallbacks', () => {
    it('without a vehicle timestamp, the feed header timestamp stands in', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [bus('e', 'T', 'v', null)], 777);
      h.push('vehiclePositions', [bus('e', 'T', 'v', null)], 777); // the same triple
      h.push('vehiclePositions', [bus('e', 'T', 'v', null)], 888);
      expect(sequences(h, 'T')).toEqual([
        [1, 'v', 777],
        [2, 'v', 888],
      ]);
    });

    it('without either, the receive time stands in', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [bus('e', 'T', 'v', null)], null);
      expect(h.pings.forTrip('T')[0]!.timestamp).toBe(Math.floor(Date.parse(NOW) / 1000));
    });

    it('without a vehicle ID, the entity ID stands in', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [
        bus('entity-9', 'T', null, 100),
        bus('entity-8', 'T', null, 100),
      ]);
      expect(h.pings.forTrip('T').map((p) => p.vehicleId)).toEqual(['entity-9', 'entity-8']);
    });

    it('an empty vehicle ID counts as none', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [bus('entity-9', 'T', '', 100)]);
      expect(h.pings.forTrip('T')[0]!.vehicleId).toBe('entity-9');
    });

    it('a vehicle position without a trip ID has no ping', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [
        vehicle('1', { vehicle: { id: 'v' }, timestamp: 1 }),
        vehicle('2', { trip: { tripId: '' }, vehicle: { id: 'v' }, timestamp: 1 }),
        vehicle('3', { trip: { routeId: 'R' }, vehicle: { id: 'v' }, timestamp: 1 }),
      ]);
      expect(h.pings.retainedBytes()).toBe(0);
      expect(h.pings.hasTrip('')).toBe(false);
    });
  });

  it('records when the server first received a ping', () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [bus('e', 'T', 'v', 100)]);
    h.clock.advance(25_000);
    h.push('vehiclePositions', [bus('e', 'T', 'v', 100)]);
    expect(h.pings.forTrip('T')[0]!.receivedAt).toBe(Math.floor(Date.parse(NOW) / 1000));
  });

  it('ignores trip update snapshots', () => {
    const h = harness({ now: NOW });
    h.push('tripUpdates', [{ id: 'u', tripUpdate: { trip: { tripId: 'T' } } }]);
    expect(h.pings.hasTrip('T')).toBe(false);
  });

  describe('passes every vehicle position field through', () => {
    it('the typed fields', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [
        vehicle('e', {
          trip: {
            tripId: 'T',
            routeId: 'R7',
            directionId: 1,
            startTime: '12:00:00',
            startDate: '20261014',
            scheduleRelationship: 0,
          },
          vehicle: { id: 'bus-1', label: 'Bus One', licensePlate: 'ABC-123' },
          position: {
            latitude: 37.5,
            longitude: -122.25,
            bearing: 90,
            odometer: 12345.5,
            speed: 7.5,
          },
          currentStopSequence: 4,
          stopId: 'S4',
          currentStatus: 2,
          timestamp: 1_700_000_123,
          congestionLevel: 1,
          occupancyStatus: 1,
          occupancyPercentage: 55,
        }),
      ]);
      expect(h.pings.forTrip('T')[0]).toEqual({
        sequence: 1,
        receivedAt: Math.floor(Date.parse(NOW) / 1000),
        timestamp: 1_700_000_123,
        vehicleId: 'bus-1',
        vehicleLabel: 'Bus One',
        licensePlate: 'ABC-123',
        latitude: 37.5,
        longitude: -122.25,
        bearing: 90,
        odometer: 12345.5,
        speed: 7.5,
        currentStopSequence: 4,
        stopId: 'S4',
        currentStatus: 'IN_TRANSIT_TO',
        congestionLevel: 'RUNNING_SMOOTHLY',
        occupancyStatus: 'MANY_SEATS_AVAILABLE',
        occupancyPercentage: 55,
        scheduleRelationship: 'SCHEDULED',
        routeId: 'R7',
        directionId: 1,
        startTime: '12:00:00',
        startDate: '20261014',
      });
    });

    it('absent fields are null, not defaults', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [bus('e', 'T', 'v', 100)]);
      expect(h.pings.forTrip('T')[0]).toEqual({
        sequence: 1,
        receivedAt: Math.floor(Date.parse(NOW) / 1000),
        timestamp: 100,
        vehicleId: 'v',
        vehicleLabel: null,
        licensePlate: null,
        latitude: null,
        longitude: null,
        bearing: null,
        odometer: null,
        speed: null,
        currentStopSequence: null,
        stopId: null,
        currentStatus: null,
        congestionLevel: null,
        occupancyStatus: null,
        occupancyPercentage: null,
        scheduleRelationship: null,
        routeId: null,
        directionId: null,
        startTime: null,
        startDate: null,
      });
    });

    it('zero values are values', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [
        bus('e', 'T', 'v', 100, {
          position: { latitude: 0, longitude: 0, bearing: 0, speed: 0 },
          currentStopSequence: 0,
          occupancyPercentage: 0,
        }),
      ]);
      expect(h.pings.forTrip('T')[0]).toMatchObject({
        latitude: 0,
        longitude: 0,
        bearing: 0,
        speed: 0,
        currentStopSequence: 0,
        occupancyPercentage: 0,
      });
    });

    it('the other fields, under their camelCase names', () => {
      const h = harness({ now: NOW });
      h.push('vehiclePositions', [
        bus('e', 'T', 'v', 100, {
          vehicle: { id: 'v', wheelchairAccessible: 2 },
          multiCarriageDetails: [
            { id: 'car-1', label: 'Front', occupancyStatus: 1, carriageSequence: 1 },
          ],
        }),
      ]);
      const ping = h.pings.forTrip('T')[0]!;
      expect(ping['multiCarriageDetails']).toEqual([
        {
          id: 'car-1',
          label: 'Front',
          occupancyStatus: 'MANY_SEATS_AVAILABLE',
          carriageSequence: 1,
        },
      ]);
      expect(ping['vehicle']).toEqual({ wheelchairAccessible: 'WHEELCHAIR_ACCESSIBLE' });
      expect(ping['trip']).toBeUndefined();
    });
  });

  describe('retention', () => {
    it('a ping expires with the snapshot window and never renumbers the others', () => {
      const h = harness({ now: NOW, retentionMs: 60 * MINUTE });
      h.push('vehiclePositions', [bus('a', 'T', 'v', 1)]);
      h.clock.advance(30 * MINUTE);
      h.push('vehiclePositions', [bus('b', 'T', 'v', 2)]);
      h.clock.advance(31 * MINUTE); // the first snapshot is 61 minutes old
      h.snapshots.prune();
      expect(sequences(h, 'T')).toEqual([[2, 'v', 2]]);
      h.push('vehiclePositions', [bus('c', 'T', 'v', 3)]);
      expect(sequences(h, 'T')).toEqual([
        [2, 'v', 2],
        [3, 'v', 3],
      ]);
    });

    it('a number is not reused after the whole trip has expired', () => {
      const h = harness({ now: NOW, retentionMs: 60 * MINUTE });
      h.push('vehiclePositions', [bus('a', 'T', 'v', 1)]);
      h.clock.advance(61 * MINUTE);
      h.push('vehiclePositions', []);
      expect(h.pings.hasTrip('T')).toBe(false);
      expect(h.pings.retainedBytes()).toBe(0);
      h.push('vehiclePositions', [bus('a', 'T', 'v', 1)]); // the same triple, long forgotten
      expect(sequences(h, 'T')).toEqual([[2, 'v', 1]]);
    });

    it('a ping the latest snapshot still contains lives on after the snapshot that first held it expires', () => {
      const h = harness({ now: NOW, retentionMs: 60 * MINUTE });
      h.push('vehiclePositions', [bus('a', 'T', 'parked', 1)]);
      h.clock.advance(40 * MINUTE);
      h.push('vehiclePositions', [bus('a', 'T', 'parked', 1), bus('b', 'T', 'moving', 2)]);
      h.clock.advance(30 * MINUTE);
      h.snapshots.prune();
      expect(sequences(h, 'T')).toEqual([
        [1, 'parked', 1],
        [2, 'moving', 2],
      ]);
    });

    it('a ping expires with a snapshot evicted by the memory limit, and the sequence goes on', () => {
      const h = harness({ now: NOW, memoryLimitBytes: 4_000 });
      const filler = 'x'.repeat(300);
      for (let i = 1; i <= 5; i++) {
        h.push('vehiclePositions', [
          bus(`e${i}`, 'T', 'v', i, { vehicle: { id: 'v', label: filler } }),
        ]);
        h.clock.advance(10_000);
      }
      const kept = h.pings.forTrip('T');
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(5);
      expect(kept.map((p) => p.sequence)).toEqual(
        Array.from({ length: kept.length }, (_, i) => 5 - kept.length + 1 + i),
      );
      expect(h.snapshots.all('vehiclePositions').length).toBe(kept.length);
      h.push('vehiclePositions', [bus('e6', 'T', 'v', 6)]);
      expect(h.pings.forTrip('T').at(-1)!.sequence).toBe(6);
    });

    it('counts its pings against the memory limit of the history', () => {
      const limit = 20_000;
      const h = harness({ now: NOW, memoryLimitBytes: limit });
      let evicted = false;
      for (let i = 0; i < 30; i++) {
        h.push(
          'vehiclePositions',
          Array.from({ length: 5 }, (_, j) => bus(`e${j}`, 'T', `v${j}`, i * 10 + j)),
        );
        h.clock.advance(10_000);
        const total = h.snapshots.retainedBytes() + h.pings.retainedBytes();
        // the history fits, or only the latest snapshot is left
        expect(total <= limit || h.snapshots.all('vehiclePositions').length === 1).toBe(true);
        evicted ||= h.snapshots.all('vehiclePositions').length < i + 1;
      }
      // the snapshots alone are a few hundred bytes each: only their pings forced the eviction
      expect(h.snapshots.retainedBytes()).toBeLessThan(limit / 2);
      expect(evicted).toBe(true);
      expect(h.pings.forTrip('T').length).toBe(h.snapshots.all('vehiclePositions').length * 5);
    });
  });

  it('is forgotten at dormancy, sequences included', () => {
    const h = harness({ now: NOW });
    h.push('vehiclePositions', [bus('a', 'T', 'v', 1), bus('b', 'T', 'v', 2)]);
    expect(h.pings.forTrip('T')).toHaveLength(2);
    h.snapshots.clear();
    expect(h.pings.hasTrip('T')).toBe(false);
    expect(h.pings.forTrip('T')).toEqual([]);
    expect(h.pings.retainedBytes()).toBe(0);
    h.push('vehiclePositions', [bus('a', 'T', 'v', 1)]);
    expect(sequences(h, 'T')).toEqual([[1, 'v', 1]]);
  });

  it('stops listening once disposed', () => {
    const h = harness({ now: NOW });
    h.pings.dispose();
    h.push('vehiclePositions', [bus('a', 'T', 'v', 1)]);
    expect(h.pings.hasTrip('T')).toBe(false);
  });
});
