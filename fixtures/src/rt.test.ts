import { describe, expect, it } from 'vitest';
import bindings from 'gtfs-realtime-bindings';
import { TIMEZONE, sortedShapePoints, shapeRowsInFileOrder } from './catalog.js';
import { distanceMeters } from './geo.js';
import { decodeFeed, toSeconds, type FeedMessage } from './rt.js';
import { scenario } from './scenario.js';
import { agencyInstant } from './time.js';

const { transit_realtime: pb } = bindings;
const now = agencyInstant('20261014', '12:07:42', TIMEZONE);
const sc = scenario(now);
const nowSec = now.getTime() / 1000;
const shapes = sortedShapePoints(shapeRowsInFileOrder());

function vehicles(feed: FeedMessage) {
  return feed.entity.filter((e) => e.vehicle).map((e) => e.vehicle!);
}

describe('encoded feeds', () => {
  const vp = decodeFeed(sc.vehiclePositions);
  const tu = decodeFeed(sc.tripUpdates);

  it('decode to the entity counts in the expectation', () => {
    expect(vehicles(vp)).toHaveLength(sc.expected.stats.vehicles);
    expect(vp.entity).toHaveLength(sc.expected.stats.vehicles);
    expect(tu.entity.filter((e) => e.tripUpdate)).toHaveLength(sc.expected.stats.tripUpdates);
    expect(vehicles(vp).filter((v) => v.trip?.tripId).length).toBe(
      sc.expected.stats.vehiclesWithTripId,
    );
  });

  it('survive decode and re-encode unchanged', () => {
    expect(pb.FeedMessage.encode(vp).finish()).toEqual(sc.vehiclePositions);
    expect(pb.FeedMessage.encode(tu).finish()).toEqual(sc.tripUpdates);
  });

  it('carry a header timestamp in whole seconds: now, and now minus 3 s for trip updates', () => {
    expect(vp.header.gtfsRealtimeVersion).toBe('2.0');
    expect(toSeconds(vp.header.timestamp)).toBe(nowSec);
    expect(toSeconds(tu.header.timestamp)).toBe(nowSec - 3);
  });

  it('give every vehicle position realistic fields', () => {
    const seenIds = new Set<string>();
    for (const v of vehicles(vp)) {
      expect(v.vehicle?.id).toMatch(/^bus-\d+$/);
      expect(seenIds.has(v.vehicle!.id!)).toBe(false);
      seenIds.add(v.vehicle!.id!);
      expect(v.vehicle?.label).toMatch(/^Bus \d+$/);
      const timestamp = toSeconds(v.timestamp)!;
      // two vehicles deliberately carry no timestamp, and a zero one (see scenario.ts)
      if (Object.hasOwn(v, 'timestamp') && timestamp !== 0) {
        expect(nowSec - timestamp).toBeGreaterThanOrEqual(2);
        expect(nowSec - timestamp).toBeLessThanOrEqual(8);
      }
      expect(v.position!.latitude).toBeGreaterThan(37.7);
      expect(v.position!.latitude).toBeLessThan(37.82);
      expect(v.position!.longitude).toBeGreaterThan(-122.5);
      expect(v.position!.longitude).toBeLessThan(-122.38);
      expect(v.position!.bearing).toBeGreaterThanOrEqual(0);
      expect(v.position!.bearing).toBeLessThan(360);
      expect(v.position!.speed).toBeGreaterThanOrEqual(0);
      expect(v.currentStopSequence).toBeGreaterThanOrEqual(1);
      expect(v.currentStopSequence).toBeLessThanOrEqual(5);
      expect(v.currentStatus).toBeTypeOf('number');
      expect(v.occupancyStatus).toBeTypeOf('number');
      expect(v.occupancyPercentage).toBeGreaterThanOrEqual(0);
    }
    expect(vehicles(vp).some((v) => (v.position!.speed ?? 0) > 0)).toBe(true);
  });

  it('place every vehicle on one of the shapes', () => {
    for (const v of vehicles(vp)) {
      const nearest = Math.min(
        ...[...shapes.values()].flatMap((points) =>
          points.map((p) => distanceMeters(p, [v.position!.latitude, v.position!.longitude])),
        ),
      );
      expect(nearest).toBeLessThan(250);
    }
  });

  it('include a vehicle with no trip descriptor and one with an empty trip id', () => {
    const noTrip = vehicles(vp).filter((v) => !v.trip?.tripId);
    expect(noTrip).toHaveLength(2);
    expect(noTrip.filter((v) => v.trip === null || v.trip === undefined)).toHaveLength(1);
    expect(noTrip.filter((v) => v.trip?.tripId === '')).toHaveLength(1);
  });

  it('give every trip update a stop_time_update and a delay, as a SCHEDULED update needs', () => {
    const updates = tu.entity.map((e) => e.tripUpdate!);
    expect(updates).toHaveLength(sc.expected.stats.tripUpdates);
    for (const u of updates) {
      expect(u.stopTimeUpdate?.length ?? 0, u.trip.tripId ?? '').toBeGreaterThan(0);
      expect(typeof u.delay).toBe('number');
    }
  });

  it('name vehicles in trip updates that no vehicle position carries', () => {
    const positionIds = new Set(vehicles(vp).map((v) => v.vehicle!.id));
    const updateIds = tu.entity.flatMap((e) =>
      e.tripUpdate!.vehicle?.id ? [e.tripUpdate!.vehicle.id] : [],
    );
    expect(updateIds).toContain('tu-unit-1');
    expect(updateIds.filter((id) => !positionIds.has(id)).length).toBeGreaterThanOrEqual(2);
  });

  it('use start_date for some references and omit it for others', () => {
    const dates = vehicles(vp).map((v) => v.trip?.startDate ?? null);
    expect(dates).toContain('20261014');
    expect(dates).toContain(null);
  });
});

describe('advance', () => {
  it('is pure and starts from the scenario instant', () => {
    expect(sc.advance(0).vehiclePositions).toEqual(sc.vehiclePositions);
    expect(sc.advance(30).vehiclePositions).toEqual(sc.advance(30).vehiclePositions);
    expect(sc.advance(30).now.getTime()).toBe(now.getTime() + 30_000);
  });

  it('moves vehicles along their shapes with newer timestamps', () => {
    const before = vehicles(decodeFeed(sc.vehiclePositions));
    const later = sc.advance(60);
    const after = vehicles(decodeFeed(later.vehiclePositions));
    expect(toSeconds(decodeFeed(later.vehiclePositions).header.timestamp)).toBe(nowSec + 60);
    expect(after).toHaveLength(before.length);
    const moved = before.filter((v, i) => {
      const w = after[i]!;
      expect(w.vehicle!.id).toBe(v.vehicle!.id);
      const timestamp = toSeconds(v.timestamp)!;
      // a vehicle with no timestamp, or a zero one, keeps it
      expect(toSeconds(w.timestamp)).toBe(
        Object.hasOwn(v, 'timestamp') && timestamp !== 0 ? timestamp + 60 : timestamp,
      );
      return (
        distanceMeters(
          [v.position!.latitude, v.position!.longitude],
          [w.position!.latitude, w.position!.longitude],
        ) > 20
      );
    });
    // everything on an active trip moves; parked vehicles (future and past trips) do not
    expect(moved.length).toBeGreaterThanOrEqual(8);
    const parked = before.find((v) => v.trip?.tripId === 'plain-future')!;
    const parkedAfter = after.find((v) => v.trip?.tripId === 'plain-future')!;
    expect(parkedAfter.position!.latitude).toBe(parked.position!.latitude);
    expect(parkedAfter.position!.longitude).toBe(parked.position!.longitude);
  });

  it('keeps references fixed, so pings from successive polls are distinct observations', () => {
    const triples = new Set<string>();
    for (let step = 0; step < 4; step++) {
      const feed = decodeFeed(sc.advance(step * 10).vehiclePositions);
      for (const v of vehicles(feed)) {
        triples.add(`${v.trip?.tripId}|${v.vehicle!.id}|${String(toSeconds(v.timestamp))}`);
      }
    }
    // the vehicles without a timestamp, and with a zero one, repeat the same triple every poll
    expect(triples.size).toBe(4 * (sc.expected.stats.vehicles - 2) + 2);
    const trips = (seconds: number): (string | null | undefined)[] =>
      vehicles(decodeFeed(sc.advance(seconds).vehiclePositions)).map((v) => v.trip?.tripId);
    expect(trips(600)).toEqual(trips(0));
  });

  it('can look backwards', () => {
    const header = decodeFeed(sc.advance(-3600).tripUpdates).header;
    expect(toSeconds(header.timestamp)).toBe(nowSec - 3603);
  });
});
