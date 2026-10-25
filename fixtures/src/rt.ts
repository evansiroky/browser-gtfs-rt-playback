import bindings from 'gtfs-realtime-bindings';
import type { ShapePath } from './geo.js';

const { transit_realtime: rt } = bindings;
export type FeedMessage = bindings.transit_realtime.FeedMessage;

/** A trip descriptor as the feed carries it; only the fields present are encoded. */
export interface TripRef {
  tripId?: string;
  startDate?: string;
  startTime?: string;
  routeId?: string;
  directionId?: number;
}

export interface VehicleSpec {
  entityId: string;
  vehicleId: string;
  label: string;
  licensePlate: string | null;
  /** null: the entity has no trip descriptor at all. */
  ref: TripRef | null;
  /** The vehicle moves along this shape from its start (epoch seconds) over `durationSecs`. */
  shapeId: string;
  motionStart: number;
  durationSecs: number;
  /** Seconds the vehicle's own timestamp trails the feed timestamp. */
  lagSecs: number;
  occupancy: bindings.transit_realtime.VehiclePosition.OccupancyStatus;
  occupancyPercentage: number;
}

export interface TripUpdateSpec {
  entityId: string;
  ref: TripRef;
  vehicleId: string | null;
  delaySecs: number;
  /** Stop sequences the update predicts; empty for trips with no stop-level data. */
  stopSequences: number[];
  lagSecs: number;
}

export interface RealtimeSpec {
  vehicles: VehicleSpec[];
  tripUpdates: TripUpdateSpec[];
  paths: ReadonlyMap<string, ShapePath>;
}

export interface Feeds {
  vehiclePositions: Uint8Array;
  tripUpdates: Uint8Array;
}

const STOPS_PER_TRIP = 5;

function descriptor(ref: TripRef): bindings.transit_realtime.ITripDescriptor {
  return {
    ...(ref.tripId !== undefined && { tripId: ref.tripId }),
    ...(ref.startDate !== undefined && { startDate: ref.startDate }),
    ...(ref.startTime !== undefined && { startTime: ref.startTime }),
    ...(ref.routeId !== undefined && { routeId: ref.routeId }),
    ...(ref.directionId !== undefined && { directionId: ref.directionId }),
    scheduleRelationship: rt.TripDescriptor.ScheduleRelationship.SCHEDULED,
  };
}

function header(nowSec: number): bindings.transit_realtime.IFeedHeader {
  return {
    gtfsRealtimeVersion: '2.0',
    incrementality: rt.FeedHeader.Incrementality.FULL_DATASET,
    timestamp: nowSec,
  };
}

function vehicleEntity(
  spec: VehicleSpec,
  paths: ReadonlyMap<string, ShapePath>,
  nowSec: number,
): bindings.transit_realtime.IFeedEntity {
  const path = paths.get(spec.shapeId)!;
  const fraction = (nowSec - spec.motionStart) / spec.durationSecs;
  const moving = fraction > 0 && fraction < 1;
  const position = path.at(fraction);
  const status =
    fraction <= 0 || fraction >= 1
      ? rt.VehiclePosition.VehicleStopStatus.STOPPED_AT
      : rt.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO;
  const stopSequence =
    fraction <= 0
      ? 1
      : fraction >= 1
        ? STOPS_PER_TRIP
        : Math.min(STOPS_PER_TRIP, Math.floor(fraction * (STOPS_PER_TRIP - 1)) + 2);
  return {
    id: spec.entityId,
    vehicle: {
      ...(spec.ref && { trip: descriptor(spec.ref) }),
      vehicle: {
        id: spec.vehicleId,
        label: spec.label,
        ...(spec.licensePlate && { licensePlate: spec.licensePlate }),
      },
      position: {
        latitude: position.latitude,
        longitude: position.longitude,
        bearing: Math.round(position.bearing * 10) / 10,
        speed: moving ? Math.round((path.lengthMeters / spec.durationSecs) * 10) / 10 : 0,
      },
      currentStopSequence: stopSequence,
      stopId: `S${stopSequence}`,
      currentStatus: status,
      timestamp: nowSec - spec.lagSecs,
      congestionLevel: rt.VehiclePosition.CongestionLevel.RUNNING_SMOOTHLY,
      occupancyStatus: spec.occupancy,
      occupancyPercentage: spec.occupancyPercentage,
    },
  };
}

function tripUpdateEntity(
  spec: TripUpdateSpec,
  nowSec: number,
): bindings.transit_realtime.IFeedEntity {
  return {
    id: spec.entityId,
    tripUpdate: {
      trip: descriptor(spec.ref),
      ...(spec.vehicleId !== null && { vehicle: { id: spec.vehicleId } }),
      stopTimeUpdate: spec.stopSequences.map((stopSequence) => ({
        stopSequence,
        stopId: `S${stopSequence}`,
        arrival: { delay: spec.delaySecs },
        departure: { delay: spec.delaySecs },
        scheduleRelationship: rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
      })),
      timestamp: nowSec - spec.lagSecs,
      delay: spec.delaySecs,
    },
  };
}

function encode(message: bindings.transit_realtime.IFeedMessage): Uint8Array {
  return rt.FeedMessage.encode(message).finish();
}

/** Both feeds as the agency would publish them at `nowSec` (epoch seconds). */
export function encodeFeeds(spec: RealtimeSpec, nowSec: number): Feeds {
  return {
    vehiclePositions: encode({
      header: header(nowSec),
      entity: spec.vehicles.map((v) => vehicleEntity(v, spec.paths, nowSec)),
    }),
    tripUpdates: encode({
      header: header(nowSec),
      entity: spec.tripUpdates.map((u) => tripUpdateEntity(u, nowSec)),
    }),
  };
}

/** Throws on a body that is not a GTFS-RT feed. */
export function decodeFeed(bytes: Uint8Array): FeedMessage {
  return rt.FeedMessage.decode(bytes);
}

/** Epoch seconds of a protobuf `uint64` field, which decodes to a number or a `Long`. */
export function toSeconds(
  value: number | { toNumber(): number } | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}
