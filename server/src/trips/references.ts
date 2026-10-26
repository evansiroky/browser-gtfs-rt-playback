import {
  transit_realtime,
  type FeedKind,
  type FeedMessage,
  type Snapshot,
} from '../realtime/snapshot-store.js';
import { parseGtfsTime } from '../schedule/time.js';
import { isServiceDate } from './time.js';

type LongLike = number | { toNumber(): number } | null | undefined;

/**
 * An optional numeric field of a decoded message, or null when the feed did not send it: the
 * decoder answers a missing field with its default (0) from the prototype, so presence is the
 * own property.
 */
export function optionalNumber(message: object | null | undefined, field: string): number | null {
  if (!message || !Object.hasOwn(message, field)) return null;
  const value = (message as Record<string, LongLike>)[field];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

/** What a trip update says about a trip, for the trip detail. */
export interface TripUpdateFacts {
  timestamp: number | null;
  delay: number | null;
  stopTimeUpdateCount: number;
  scheduleRelationship: string | null;
}

/** A realtime trip reference with a trip ID, from the latest snapshot of a feed. */
export interface TripReference {
  readonly source: FeedKind;
  readonly tripId: string;
  readonly vehicleId: string | null;
  /** Vehicle position timestamp, epoch seconds. */
  readonly timestamp: number | null;
  /** Header timestamp of the snapshot the reference is in, epoch seconds. */
  readonly feedTimestamp: number | null;
  readonly routeId: string | null;
  /** The descriptor's `start_time`, as sent; null when absent or empty. */
  readonly startTime: string | null;
  /** The seconds it names from the service day start; null when absent or not a time. */
  readonly startOffset: number | null;
  /** The descriptor's `start_date` when it is a calendar date `YYYYMMDD`, else null. */
  readonly startDate: string | null;
  readonly scheduleRelationship: string | null;
  readonly tripUpdate: TripUpdateFacts | null;
}

/** The references of the latest snapshot of one feed, and the counts the statistics need. */
export interface FeedReferences {
  readonly feed: FeedKind;
  /** Entities carrying a vehicle position (or a trip update, for that feed). */
  readonly entities: number;
  /** Of those, the ones whose trip reference has a trip ID. */
  readonly withTripId: number;
  readonly references: readonly TripReference[];
}

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value;

function relationship(descriptor: object | null | undefined): string | null {
  const value = optionalNumber(descriptor, 'scheduleRelationship');
  return value === null
    ? null
    : (transit_realtime.TripDescriptor.ScheduleRelationship[value] ?? null);
}

/** Reads the trip references out of a decoded snapshot (trip-activity.md "Realtime trip references"). */
export function readReferences(snapshot: Snapshot, message: FeedMessage): FeedReferences {
  const references: TripReference[] = [];
  let entities = 0;
  const feedTimestamp = snapshot.feedTimestamp;
  for (const entity of message.entity) {
    const vehicle = snapshot.feed === 'vehiclePositions' ? entity.vehicle : entity.tripUpdate;
    if (!vehicle) continue;
    entities++;
    const trip = vehicle.trip;
    const tripId = text(trip?.tripId);
    if (tripId === null) continue;
    const startTime = text(trip?.startTime);
    const startDate = text(trip?.startDate);
    const update = snapshot.feed === 'tripUpdates' ? entity.tripUpdate : null;
    const position = snapshot.feed === 'vehiclePositions' ? entity.vehicle : null;
    references.push({
      source: snapshot.feed,
      tripId,
      vehicleId: text(vehicle.vehicle?.id),
      // a timestamp of 0 is no timestamp
      timestamp: optionalNumber(position, 'timestamp') || null,
      feedTimestamp,
      routeId: text(trip?.routeId),
      startTime,
      startOffset: startTime === null ? null : parseGtfsTime(startTime),
      startDate: isServiceDate(startDate) ? startDate : null,
      scheduleRelationship: relationship(trip),
      tripUpdate: update
        ? {
            timestamp: optionalNumber(update, 'timestamp'),
            delay: optionalNumber(update, 'delay'),
            stopTimeUpdateCount: update.stopTimeUpdate?.length ?? 0,
            scheduleRelationship: relationship(trip),
          }
        : null,
    });
  }
  return { feed: snapshot.feed, entities, withTripId: references.length, references };
}

/** Decodes the latest snapshot of a feed; null before the first success. */
export function latestReferences(
  latest: Snapshot | null,
): { snapshot: Snapshot; feed: FeedReferences } | null {
  if (!latest) return null;
  return { snapshot: latest, feed: readReferences(latest, latest.decode()) };
}
