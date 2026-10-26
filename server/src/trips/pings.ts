import type { Ping } from '@gtfs-rt-debugger/shared';
import {
  transit_realtime,
  type EvictListener,
  type FeedMessage,
  type Snapshot,
  type SnapshotStore,
} from '../realtime/snapshot-store.js';
import { optionalNumber } from './references.js';

/**
 * A ping as the trip detail returns it: the typed fields of the API, plus the other
 * `VehiclePosition` fields the feed carried, under their camelCase GTFS-RT names.
 */
export type StoredPing = Ping & Record<string, unknown>;

type Fields = Record<string, unknown>;

/** Where a ping can be read: a retained snapshot, and the byte range of its entity in it. */
interface Source {
  readonly record: SnapshotRecord;
  readonly offset: number;
  readonly length: number;
  /** The entity re-encoded, for a snapshot whose entities could not be located in its bytes. */
  readonly own: Uint8Array | null;
}

/** The index entry of a ping: identity, number and source, never its decoded fields. */
interface Observation {
  readonly trip: TripPings;
  /** `vehicle ID, timestamp`: the rest of the ping's identity within its trip. */
  readonly key: string;
  readonly sequence: number;
  /** Epoch seconds the server first received the ping. */
  readonly receivedAt: number;
  /** The resolved ping timestamp. */
  readonly timestamp: number;
  /** The newest retained snapshot that contains the ping. */
  source: Source;
  readonly bytes: number;
}

interface TripPings {
  readonly tripId: string;
  /** In order of first receipt, so ascending by sequence. */
  readonly byKey: Map<string, Observation>;
}

interface SnapshotRecord {
  readonly snapshot: Snapshot;
  /** Pings last seen here; an entry is stale once the ping has been seen in a newer snapshot. */
  readonly observations: Observation[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** What an observation costs: its record, its two table slots and its key. */
const OBSERVATION_BYTES = 200;

/**
 * The byte ranges of the `entity` fields of a serialized `FeedMessage`, in order, or null when
 * the message cannot be walked (the caller then keeps each entity's own bytes).
 */
export function entityRanges(bytes: Uint8Array): { offset: number; length: number }[] | null {
  const ranges: { offset: number; length: number }[] = [];
  let pos = 0;
  const varint = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (pos >= bytes.length) return null;
      const byte = bytes[pos++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  while (pos < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    switch (tag & 7) {
      case 0:
        if (varint() === null) return null;
        break;
      case 1:
        pos += 8;
        break;
      case 5:
        pos += 4;
        break;
      case 2: {
        const length = varint();
        if (length === null || pos + length > bytes.length) return null;
        if (tag >>> 3 === 2) ranges.push({ offset: pos, length });
        pos += length;
        break;
      }
      default:
        return null;
    }
  }
  return pos === bytes.length ? ranges : null;
}

/**
 * The pings of the retained vehicle position snapshots (data-model.md "Ping"), by trip ID.
 *
 * - A ping is identified by (trip ID, vehicle ID, timestamp) and recorded once, however many
 *   snapshots repeat it; the trip's ping sequence counts first receipts since the activation
 *   began, and an expired ping's number is never reused.
 * - Only an index is kept: identity, sequence number, first receipt and where the entity lies in
 *   a retained snapshot. A ping's fields are read from that snapshot when they are asked for
 *   ({@link forTrip}), so a ping lasts exactly as long as a retained snapshot contains it: the
 *   snapshot store's retention window and memory limit decide (data-retention.md), through its
 *   eviction events. The index's estimated size counts against the store's memory limit.
 * - Dormancy (the store's clear) forgets the index and the sequences.
 */
export class PingStore {
  readonly #records: SnapshotRecord[] = [];
  readonly #trips = new Map<string, TripPings>();
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

  /** The retained pings of a trip ID, ascending by sequence, with their fields. */
  forTrip(tripId: string): StoredPing[] {
    const trip = this.#trips.get(tripId);
    if (!trip) return [];
    const pings: StoredPing[] = [];
    for (const observation of trip.byKey.values()) {
      const ping = materialize(observation);
      if (ping) pings.push(ping);
    }
    return pings;
  }

  hasTrip(tripId: string): boolean {
    return this.#trips.has(tripId);
  }

  /** Estimated heap held by the index. */
  retainedBytes(): number {
    return this.#bytes;
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#clear();
  }

  #add(snapshot: Snapshot, message: FeedMessage): void {
    if (snapshot.feed !== 'vehiclePositions') return;
    const record: SnapshotRecord = { snapshot, observations: [] };
    this.#records.push(record);
    const fallbackTimestamp = snapshot.feedTimestamp ?? Math.floor(snapshot.receivedAt / 1000);
    const ranges = entityRanges(snapshot.bytes);
    const walked = ranges !== null && ranges.length === message.entity.length;
    message.entity.forEach((entity, index) => {
      const position = entity.vehicle;
      if (!position) return;
      const tripId = text(position.trip?.tripId);
      if (tripId === null) return;
      const vehicleId = text(position.vehicle?.id) ?? entity.id;
      // a timestamp of 0 is no timestamp
      const timestamp = optionalNumber(position, 'timestamp') || fallbackTimestamp;
      const range = walked ? ranges[index]! : null;
      const source: Source = range
        ? { record, offset: range.offset, length: range.length, own: null }
        : { record, offset: 0, length: 0, own: encodeEntity(entity) };
      this.#observe(record, tripId, `${vehicleId}\0${timestamp}`, timestamp, source);
    });
    // The new pings may push the history over its memory limit.
    this.#snapshots.prune();
  }

  #observe(
    record: SnapshotRecord,
    tripId: string,
    key: string,
    timestamp: number,
    source: Source,
  ): void {
    let trip = this.#trips.get(tripId);
    const known = trip?.byKey.get(key);
    if (known) {
      known.source = source;
      record.observations.push(known);
      return;
    }
    if (!trip) {
      trip = { tripId, byKey: new Map() };
      this.#trips.set(tripId, trip);
    }
    const sequence = (this.#sequences.get(tripId) ?? 0) + 1;
    this.#sequences.set(tripId, sequence);
    const observation: Observation = {
      trip,
      key,
      sequence,
      receivedAt: Math.floor(record.snapshot.receivedAt / 1000),
      timestamp,
      source,
      bytes: OBSERVATION_BYTES + 2 * key.length + (source.own?.length ?? 0),
    };
    this.#bytes += observation.bytes;
    trip.byKey.set(key, observation);
    record.observations.push(observation);
  }

  #expire(snapshot: Snapshot): void {
    const at = this.#records.findIndex((record) => record.snapshot === snapshot);
    if (at < 0) return;
    const [record] = this.#records.splice(at, 1);
    for (const observation of record!.observations) {
      // seen in a newer snapshot since: that one keeps it
      if (observation.source.record !== record) continue;
      this.#bytes -= observation.bytes;
      observation.trip.byKey.delete(observation.key);
      if (observation.trip.byKey.size === 0) this.#trips.delete(observation.trip.tripId);
    }
  }

  #clear(): void {
    this.#records.length = 0;
    this.#trips.clear();
    this.#sequences.clear();
    this.#bytes = 0;
  }
}

function encodeEntity(entity: FeedMessage['entity'][number]): Uint8Array {
  return transit_realtime.FeedEntity.encode(entity).finish();
}

/** Reads a ping's fields from the snapshot that contains it. */
function materialize(observation: Observation): StoredPing | null {
  const { source } = observation;
  const bytes =
    source.own ??
    source.record.snapshot.bytes.subarray(source.offset, source.offset + source.length);
  const entity = transit_realtime.FeedEntity.decode(bytes);
  if (!entity.vehicle) return null;
  const fields = transit_realtime.VehiclePosition.toObject(
    entity.vehicle as InstanceType<typeof transit_realtime.VehiclePosition>,
    { enums: String, longs: Number, defaults: false },
  ) as Fields;
  const { trip, vehicle, position, ...rest } = fields as {
    trip?: Fields;
    vehicle?: Fields;
    position?: Fields;
  } & Fields;
  const { routeId, directionId, startTime, startDate, scheduleRelationship, ...tripExtra } =
    trip ?? {};
  const { id, label, licensePlate, ...vehicleExtra } = vehicle ?? {};
  const { latitude, longitude, bearing, odometer, speed, ...positionExtra } = position ?? {};
  const {
    currentStopSequence,
    stopId,
    currentStatus,
    congestionLevel,
    occupancyStatus,
    occupancyPercentage,
    ...extra
  } = rest;
  delete tripExtra['tripId'];
  delete extra['timestamp'];
  for (const [name, leftover] of [
    ['trip', tripExtra],
    ['vehicle', vehicleExtra],
    ['position', positionExtra],
  ] as const) {
    if (Object.keys(leftover).length > 0) extra[name] = leftover;
  }
  return {
    ...extra,
    sequence: observation.sequence,
    receivedAt: observation.receivedAt,
    timestamp: observation.timestamp,
    vehicleId: text(id) ?? entity.id,
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
}
