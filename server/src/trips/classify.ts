import type { TripListItem, TripReason } from '@gtfs-rt-debugger/shared';
import type { ScheduleTrip } from '../schedule/store.js';
import {
  entryOn,
  parseFrequencyRows,
  tripOf,
  type Entry,
  type FrequencyWindow,
  type Frame,
} from './entries.js';
import type { TripReference } from './references.js';

/** A realtime trip reference with its service date and start (trip-activity.md). */
export interface ResolvedReference extends TripReference {
  readonly date: string;
  /** The reference's `start_time` on its service date, epoch seconds. */
  readonly start: number | null;
}

/** The reasons in the order list 3 sorts by. */
export const REASONS: readonly TripReason[] = [
  'unknown_trip',
  'configuration_error',
  'not_in_service',
  'missing_start_time',
  'unmatched_start_time',
  'outside_scheduled_time',
];

/** An active entry with the references that match it (list 1 when there are any, else list 2). */
export interface ActiveRow {
  readonly entry: Entry;
  readonly references: readonly ResolvedReference[];
}

/** A list 3 row: the references of one trip (or instance) that match no active entry. */
export interface UnscheduledRow {
  readonly tripId: string;
  readonly date: string;
  readonly reason: TripReason;
  /** The entry the reference names: only for outside_scheduled_time, the one reason that has it. */
  readonly named: Entry | null;
  /** For a frequency trip, the row whose window contains the reference's start. */
  readonly window: FrequencyWindow | null;
  readonly references: readonly ResolvedReference[];
  /** Sort key: the start of the references, absent first. */
  readonly start: number | null;
}

export interface Classification {
  readonly withRealtime: readonly ActiveRow[];
  readonly withoutRealtime: readonly ActiveRow[];
  readonly unscheduled: readonly UnscheduledRow[];
}

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Earliest first; no start sorts before any. */
function byStart(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

/** Gives each reference its service date and start (trip-activity.md "Realtime trip references"). */
export function resolveReferences(
  frame: Frame,
  active: ReadonlyMap<string, readonly Entry[]>,
  references: readonly TripReference[],
): ResolvedReference[] {
  return references.map((reference) => {
    const date = reference.startDate ?? inferDate(frame, active, reference);
    return {
      ...reference,
      date,
      start: reference.startOffset === null ? null : frame.dayStart(date) + reference.startOffset,
    };
  });
}

/** The service date of a reference with no `start_date`; the later candidate wins each step. */
export function inferDate(
  frame: Frame,
  active: ReadonlyMap<string, readonly Entry[]>,
  reference: Pick<TripReference, 'tripId' | 'startTime' | 'startOffset'>,
): string {
  const later = [...frame.candidates].reverse();
  const entries = active.get(reference.tripId) ?? [];
  for (const date of later) {
    const has = entries.some(
      (entry) =>
        entry.date === date &&
        (entry.window === null ||
          reference.startTime === null ||
          (reference.startOffset !== null &&
            entry.start === frame.dayStart(date) + reference.startOffset)),
    );
    if (has) return date;
  }
  const serviceId = frame.tripFacts(reference.tripId)?.serviceId;
  return later.find((date) => frame.operates(serviceId, date)) ?? frame.today;
}

function matches(entry: Entry, reference: ResolvedReference): boolean {
  return (
    entry.tripId === reference.tripId &&
    entry.date === reference.date &&
    (entry.window === null || entry.start === reference.start)
  );
}

export function groupByTrip<T extends { tripId: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.tripId);
    if (group) group.push(item);
    else groups.set(item.tripId, [item]);
  }
  return groups;
}

/**
 * Splits the active entries and the references into the three lists (trip-activity.md "The
 * three lists"), in list order.
 */
export function classify(
  frame: Frame,
  entries: readonly Entry[],
  references: readonly TripReference[],
): Classification {
  const byTrip = groupByTrip(entries);
  const resolved = resolveReferences(frame, byTrip, references);
  const matched = new Map<Entry, ResolvedReference[]>();
  const unmatched: ResolvedReference[] = [];
  const referencesByTrip = groupByTrip(resolved);
  for (const [tripId, group] of referencesByTrip) {
    const tripEntries = byTrip.get(tripId) ?? [];
    for (const reference of group) {
      const hits = tripEntries.filter((entry) => matches(entry, reference));
      for (const entry of hits) {
        const list = matched.get(entry);
        if (list) list.push(reference);
        else matched.set(entry, [reference]);
      }
      if (hits.length === 0) unmatched.push(reference);
    }
  }

  const rows = entries
    .map((entry): ActiveRow => ({ entry, references: matched.get(entry) ?? [] }))
    .sort((a, b) => a.entry.start - b.entry.start || byCode(a.entry.tripId, b.entry.tripId));

  return {
    withRealtime: rows.filter((row) => row.references.length > 0),
    withoutRealtime: rows.filter((row) => row.references.length === 0),
    unscheduled: unscheduledRows(frame, unmatched),
  };
}

/** Groups the unmatched references by trip, and by start for frequency trips, and gives reasons. */
function unscheduledRows(frame: Frame, unmatched: readonly ResolvedReference[]): UnscheduledRow[] {
  const groups = new Map<string, ResolvedReference[]>();
  for (const reference of unmatched) {
    const frequency = frame.tripFacts(reference.tripId)?.frequency ?? false;
    const start = frequency ? (reference.start ?? `raw:${reference.startTime}`) : '';
    const key = JSON.stringify([reference.tripId, start]);
    const group = groups.get(key);
    if (group) group.push(reference);
    else groups.set(key, [reference]);
  }
  const rows = [...groups.values()].map((group) => unscheduledRow(frame, group));
  return rows.sort(
    (a, b) =>
      REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason) ||
      byCode(a.tripId, b.tripId) ||
      byStart(a.start, b.start),
  );
}

function unscheduledRow(frame: Frame, group: readonly ResolvedReference[]): UnscheduledRow {
  const latest = group.reduce((best, next) => (next.date > best.date ? next : best));
  const { tripId, date } = latest;
  const base = { tripId, date, references: group, start: latest.start };
  const trip = tripOf(frame.store, tripId);
  if (!trip) return { ...base, reason: 'unknown_trip', named: null, window: null };
  if (frame.index.errors.has(tripId)) {
    return { ...base, reason: 'configuration_error', named: null, window: null };
  }
  if (!frame.operates(trip.row['service_id'], date)) {
    return { ...base, reason: 'not_in_service', named: null, window: windowAt(trip, latest) };
  }
  const window = windowAt(trip, latest);
  if (trip.frequencies.length === 0) {
    return {
      ...base,
      reason: 'outside_scheduled_time',
      named: entryOn(frame, trip, date, null),
      window,
    };
  }
  if (latest.startTime === null) {
    return { ...base, reason: 'missing_start_time', named: null, window };
  }
  const named = entryOn(frame, trip, date, latest.startOffset);
  if (!named) return { ...base, reason: 'unmatched_start_time', named: null, window };
  return { ...base, reason: 'outside_scheduled_time', named, window };
}

/** The frequency row whose window contains the reference's start. */
function windowAt(trip: ScheduleTrip, reference: ResolvedReference): FrequencyWindow | null {
  const offset = reference.startOffset;
  if (offset === null) return null;
  return (
    parseFrequencyRows(trip.frequencies).find(
      (window) => window.startSecs <= offset && offset < window.endSecs,
    ) ?? null
  );
}

// --- rows of the API ------------------------------------------------------------------------

type Realtime = NonNullable<TripListItem['realtime']>;

/** What the references behind a row say (api/trips.md `realtime`). */
export function realtimeOf(references: readonly ResolvedReference[]): Realtime {
  const timestamps = references.flatMap((r) => (r.timestamp === null ? [] : [r.timestamp]));
  const feedTimestamp = references.find((r) => r.feedTimestamp !== null)?.feedTimestamp ?? null;
  return {
    vehicleIds: [
      ...new Set(references.flatMap((r) => (r.vehicleId === null ? [] : [r.vehicleId]))),
    ],
    hasVehiclePosition: references.some((r) => r.source === 'vehiclePositions'),
    hasTripUpdate: references.some((r) => r.source === 'tripUpdates'),
    startTime: references.find((r) => r.startTime !== null)?.startTime ?? null,
    lastSeenAt: timestamps.length > 0 ? Math.max(...timestamps) : feedTimestamp,
  };
}

function frequencyOf(window: FrequencyWindow | null, dayStart: number): TripListItem['frequency'] {
  return window
    ? {
        exactTimes: window.exactTimes,
        headwaySecs: window.headwaySecs,
        windowStart: dayStart + window.startSecs,
        windowEnd: dayStart + window.endSecs,
      }
    : null;
}

/** Route and headsign fields (api/trips.md); an empty cell is no value. */
function tripFields(
  frame: Frame,
  tripId: string,
  referenceRouteId: string | null,
): Pick<TripListItem, 'routeId' | 'routeShortName' | 'routeLongName' | 'headsign'> {
  const row = frame.store.trip(tripId);
  const routeId = row ? row['route_id'] || null : referenceRouteId;
  const route = routeId ? frame.store.route(routeId) : undefined;
  return {
    routeId,
    routeShortName: route?.['route_short_name'] || null,
    routeLongName: route?.['route_long_name'] || null,
    headsign: row?.['trip_headsign'] || null,
  };
}

export function activeItem(frame: Frame, row: ActiveRow): TripListItem {
  const { entry } = row;
  return {
    tripId: entry.tripId,
    serviceDate: entry.date,
    ...tripFields(frame, entry.tripId, null),
    scheduledStart: entry.start,
    scheduledEnd: entry.end,
    frequency: frequencyOf(entry.window, entry.dayStart),
    realtime: row.references.length > 0 ? realtimeOf(row.references) : null,
    reason: null,
  };
}

export function unscheduledItem(frame: Frame, row: UnscheduledRow): TripListItem {
  return {
    tripId: row.tripId,
    serviceDate: row.date,
    ...tripFields(
      frame,
      row.tripId,
      row.references.find((r) => r.routeId !== null)?.routeId ?? null,
    ),
    scheduledStart: row.named?.start ?? null,
    scheduledEnd: row.named?.end ?? null,
    frequency: frequencyOf(row.window, frame.dayStart(row.date)),
    realtime: realtimeOf(row.references),
    reason: row.reason,
  };
}
