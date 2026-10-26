import type { Ping } from '@gtfs-rt-debugger/shared';
import {
  transit_realtime,
  type EvictListener,
  type FeedMessage,
  type Snapshot,
  type SnapshotStore,
} from '../realtime/snapshot-store.js';

/**
 * A ping as the trip detail returns it: the typed fields of the API, plus the other
 * `VehiclePosition` fields the feed carried, under their camelCase GTFS-RT names.
 */
export type StoredPing = Ping & Record<string, unknown>;

type Fields = Record<string, unknown>;

interface Observation {
  readonly tripId: string;
  readonly key: string;
  readonly ping: StoredPing;
  readonly bytes: number;
  /** The newest retained snapshot that contains the ping. */
  seenIn: SnapshotRecord;
}

interface SnapshotRecord {
  readonly snapshot: Snapshot;
  /** The pings whose newest retained snapshot this is. */
  readonly pings: Set<Observation>;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** A rough count of what a ping holds on the heap: the object, its strings and extra fields. */
function estimateBytes(ping: StoredPing, extra: Fields): number {
  let bytes = 448;
  for (const value of Object.values(ping)) if (typeof value === 'string') bytes += 2 * value.length;
  if (Object.keys(extra).length > 0) bytes += 2 * JSON.stringify(extra).length + 64;
  return bytes;
}

/**
 * The pings of the retained vehicle position snapshots (data-model.md "Ping"), by trip ID.
 *
 * - A ping is identified by (trip ID, vehicle ID, timestamp) and recorded once, however many
 *   snapshots repeat it; the trip's ping sequence counts first receipts since the activation
 *   began, and an expired ping's number is never reused.
 * - A ping lives as long as a retained snapshot contains it: the snapshot store's retention
 *   window and memory limit decide (data-retention.md), through its eviction events. The
 *   pings' estimated size counts against the store's memory limit.
 * - Dormancy (the store's clear) forgets the pings and the sequences.
 */
export class PingStore {
  readonly #records: SnapshotRecord[] = [];
  readonly #pings = new Map<string, Map<string, Observation>>();
  readonly #sequences = new Map<string, number>();
  readonly #snapshots: SnapshotStore;
  readonly #unsubscribe: (() => void)[];
  #bytes = 0;

  constructor(snapshots: SnapshotStore) {
    this.#snapshots = snapshots;
    const onEvict: EvictListener = (snapshot) => this.#expire(snapshot);
    this.#unsubscribe = [
      snapshots.onSnapshot((snapshot, message) => this.#add(snapshot, message)),
      snapshots.onEvict(onEvict),
      snapshots.onClear(() => this.#clear()),
      snapshots.reserveMemory(() => this.#bytes),
    ];
  }

  /** The retained pings of a trip ID, ascending by sequence. */
  forTrip(tripId: string): StoredPing[] {
    return [...(this.#pings.get(tripId)?.values() ?? [])].map((o) => o.ping);
  }

  hasTrip(tripId: string): boolean {
    return this.#pings.has(tripId);
  }

  /** Estimated heap held by the retained pings. */
  retainedBytes(): number {
    return this.#bytes;
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#clear();
  }

  #add(snapshot: Snapshot, message: FeedMessage): void {
    if (snapshot.feed !== 'vehiclePositions') return;
    const record: SnapshotRecord = { snapshot, pings: new Set() };
    this.#records.push(record);
    const fallbackTimestamp = snapshot.feedTimestamp ?? Math.floor(snapshot.receivedAt / 1000);
    for (const entity of message.entity) {
      if (!entity.vehicle) continue;
      const fields = transit_realtime.VehiclePosition.toObject(
        entity.vehicle as InstanceType<typeof transit_realtime.VehiclePosition>,
        {
          enums: String,
          longs: Number,
          defaults: false,
        },
      ) as Fields;
      this.#observe(record, entity.id, fields, fallbackTimestamp);
    }
    // The new pings may push the history over its memory limit.
    this.#snapshots.prune();
  }

  #observe(record: SnapshotRecord, entityId: string, fields: Fields, fallbackTimestamp: number) {
    const { snapshot } = record;
    const { trip, vehicle, position, ...rest } = fields as {
      trip?: Fields;
      vehicle?: Fields;
      position?: Fields;
    } & Fields;
    const {
      tripId: tripIdField,
      routeId,
      directionId,
      startTime,
      startDate,
      ...tripRest
    } = trip ?? {};
    const tripId = text(tripIdField);
    if (tripId === null) return;
    const { id, label, licensePlate, ...vehicleRest } = vehicle ?? {};
    const { latitude, longitude, bearing, odometer, speed, ...positionRest } = position ?? {};
    const {
      currentStopSequence,
      stopId,
      currentStatus,
      timestamp,
      congestionLevel,
      occupancyStatus,
      occupancyPercentage,
      ...extra
    } = rest;
    const { scheduleRelationship, ...tripExtra } = tripRest;
    for (const [name, leftover] of [
      ['trip', tripExtra],
      ['vehicle', vehicleRest],
      ['position', positionRest],
    ] as const) {
      if (Object.keys(leftover).length > 0) extra[name] = leftover;
    }

    const vehicleId = text(id) ?? entityId;
    const pingTimestamp = number(timestamp) ?? fallbackTimestamp;
    const key = JSON.stringify([vehicleId, pingTimestamp]);

    const known = this.#pings.get(tripId)?.get(key);
    if (known) {
      known.seenIn.pings.delete(known);
      known.seenIn = record;
      record.pings.add(known);
      return;
    }

    const sequence = (this.#sequences.get(tripId) ?? 0) + 1;
    this.#sequences.set(tripId, sequence);
    const ping: StoredPing = {
      ...extra,
      sequence,
      receivedAt: Math.floor(snapshot.receivedAt / 1000),
      timestamp: pingTimestamp,
      vehicleId,
      vehicleLabel: text(label),
      licensePlate: text(licensePlate),
      latitude: number(latitude),
      longitude: number(longitude),
      bearing: number(bearing),
      odometer: number(odometer),
      speed: number(speed),
      currentStopSequence: number(currentStopSequence),
      stopId: text(stopId),
      currentStatus: text(currentStatus),
      congestionLevel: text(congestionLevel),
      occupancyStatus: text(occupancyStatus),
      occupancyPercentage: number(occupancyPercentage),
      scheduleRelationship: text(scheduleRelationship),
      routeId: text(routeId),
      directionId: number(directionId),
      startTime: text(startTime),
      startDate: text(startDate),
    };
    const observation: Observation = {
      tripId,
      key,
      ping,
      bytes: estimateBytes(ping, extra),
      seenIn: record,
    };
    record.pings.add(observation);
    this.#bytes += observation.bytes;
    let byKey = this.#pings.get(tripId);
    if (!byKey) {
      byKey = new Map();
      this.#pings.set(tripId, byKey);
    }
    byKey.set(key, observation);
  }

  #expire(snapshot: Snapshot): void {
    const at = this.#records.findIndex((record) => record.snapshot === snapshot);
    if (at < 0) return;
    const [record] = this.#records.splice(at, 1);
    for (const observation of record!.pings) {
      this.#bytes -= observation.bytes;
      const byKey = this.#pings.get(observation.tripId);
      byKey?.delete(observation.key);
      if (byKey?.size === 0) this.#pings.delete(observation.tripId);
    }
  }

  #clear(): void {
    this.#records.length = 0;
    this.#pings.clear();
    this.#sequences.clear();
    this.#bytes = 0;
  }
}
