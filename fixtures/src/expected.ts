/**
 * The ground truth: what the app must report for a scenario. Everything here is a direct
 * transcription of specs/behaviors/trip-activity.md, written for clarity rather than speed, and
 * pinned by hand-derived literals in the tests (see SCENARIO.md for the derivations).
 */
import type { Row } from './csv.js';
import type { ScheduleData, TripData } from './schedule.js';
import { WEEKDAY_COLUMNS } from './schedule.js';
import type { TripRef } from './rt.js';
import {
  addDays,
  instantSeconds as instantOf,
  parseHms,
  serviceDateOf,
  weekdayOf,
} from './time.js';

export type Reason =
  | 'unknown_trip'
  | 'configuration_error'
  | 'not_in_service'
  | 'missing_start_time'
  | 'unmatched_start_time'
  | 'outside_scheduled_time';

/** The order list 3 is sorted by. */
export const REASON_ORDER: readonly Reason[] = [
  'unknown_trip',
  'configuration_error',
  'not_in_service',
  'missing_start_time',
  'unmatched_start_time',
  'outside_scheduled_time',
];

export interface FrequencyInfo {
  /** As sent (absent = false); informational only. */
  exactTimes: boolean;
  headwaySecs: number;
  /** Epoch seconds of the frequency row's window on the service date. */
  windowStart: number;
  windowEnd: number;
}

export interface RealtimeInfo {
  /** Distinct vehicle ids, sorted here; the spec does not order them. */
  vehicleIds: string[];
  hasVehiclePosition: boolean;
  hasTripUpdate: boolean;
  /** The reference's start_time, as sent. */
  startTime: string | null;
  /**
   * Epoch seconds of the newest vehicle position timestamp among the references, else the feed
   * timestamp. As of the instant the scenario was built for.
   */
  lastSeenAt: number;
}

interface RowBase {
  tripId: string;
  /** `YYYYMMDD`. */
  serviceDate: string;
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  headsign: string | null;
  frequency: FrequencyInfo | null;
}

/** A row of list 1 (`realtime` set) or list 2 (`realtime` null). */
export interface ExpectedActiveRow extends RowBase {
  /** Epoch seconds of the entry's span. */
  scheduledStart: number;
  scheduledEnd: number;
  realtime: RealtimeInfo | null;
}

/** A row of list 3. */
export interface ExpectedUnscheduledRow extends RowBase {
  reason: Reason;
  /**
   * `scheduledStart` / `scheduledEnd` of the API row. null where the spec says they are null (an
   * unknown trip, a trip with the configuration error); the span of the entry the reference names
   * for `outside_scheduled_time`; absent for the other reasons, which the spec leaves open.
   */
  scheduledSpan?: { start: number; end: number } | null;
  realtime: RealtimeInfo;
}

export interface ExpectedStats {
  tripsToday: number;
  tripsActiveNow: number;
  vehicles: number;
  vehiclesWithTripId: number;
  tripUpdates: number;
  activeTripsWithRealtime: number;
}

export interface ExpectedConfigurationError {
  code: 'mixed_exact_times';
  tripId: string;
}

export interface Expected {
  /** `YYYYMMDD` of the agency-local day containing `now`, and the day before. */
  today: string;
  yesterday: string;
  stats: ExpectedStats;
  lists: {
    activeWithRealtime: ExpectedActiveRow[];
    activeWithoutRealtime: ExpectedActiveRow[];
    unscheduledWithRealtime: ExpectedUnscheduledRow[];
  };
  configurationErrors: ExpectedConfigurationError[];
}

export interface RefSource {
  vehicleId: string | null;
  /** Vehicle position timestamp, epoch seconds; absent for trip updates. */
  timestamp?: number;
  /** null: the entity has no trip descriptor. */
  ref: TripRef | null;
}

export interface EvaluationInput {
  data: ScheduleData;
  timeZone: string;
  nowMs: number;
  /** Header timestamp of both feeds, epoch seconds. */
  feedTimestamp: number;
  vehicles: readonly RefSource[];
  tripUpdates: readonly RefSource[];
}

interface FrequencyRow {
  startSecs: number;
  endSecs: number;
  headwaySecs: number;
  exactTimes: boolean;
  /** `exact_times` with an absent value read as 0, the form the mixed-value check compares. */
  exactNormalized: string;
}

interface TripInfo {
  trip: TripData;
  tripId: string;
  serviceId: string;
  startSecs: number;
  endSecs: number;
  frequencyRows: FrequencyRow[];
  mixed: boolean;
}

interface Entry {
  tripId: string;
  date: string;
  start: number;
  end: number;
  frequency: FrequencyInfo | null;
}

interface Reference {
  isVehicle: boolean;
  tripId: string;
  vehicleId: string | null;
  timestamp: number | null;
  routeId: string | null;
  startTime: string | null;
  date: string;
  /** Epoch seconds of `startTime` on `date`. */
  start: number | null;
}

function tripInfo(trip: TripData): TripInfo {
  const first = trip.stopTimes[0]!;
  const last = trip.stopTimes[trip.stopTimes.length - 1]!;
  const frequencyRows = trip.frequencies.map((f): FrequencyRow => {
    const exact = f.exact_times ?? '';
    return {
      startSecs: parseHms(f.start_time!),
      endSecs: parseHms(f.end_time!),
      headwaySecs: Number(f.headway_secs),
      exactTimes: exact === '1',
      exactNormalized: exact === '' ? '0' : exact,
    };
  });
  return {
    trip,
    tripId: trip.row.trip_id!,
    serviceId: trip.row.service_id!,
    // start = first departure, else arrival; end = last arrival, else departure.
    startSecs: (first.departure ?? first.arrival)!,
    endSecs: (last.arrival ?? last.departure)!,
    frequencyRows,
    mixed: new Set(frequencyRows.map((r) => r.exactNormalized)).size > 1,
  };
}

export function operatesOn(data: ScheduleData, serviceId: string, date: string): boolean {
  const exceptions = data.calendarDates.filter(
    (r) => r.service_id === serviceId && r.date === date,
  );
  if (exceptions.some((r) => r.exception_type === '1')) return true;
  if (exceptions.some((r) => r.exception_type === '2')) return false;
  const calendar = data.calendar.find((r) => r.service_id === serviceId);
  if (!calendar) return false;
  const flag = calendar[WEEKDAY_COLUMNS[(weekdayOf(date) + 6) % 7]!];
  return flag === '1' && calendar.start_date! <= date && date <= calendar.end_date!;
}

export function evaluate(input: EvaluationInput): Expected {
  const { data, timeZone } = input;
  const dayStarts = new Map<string, number>();
  /** Epoch seconds of a GTFS time on a service date (day starts are looked up once per date). */
  const instantSeconds = (date: string, secs: number): number => {
    if (!dayStarts.has(date)) dayStarts.set(date, instantOf(date, 0, timeZone));
    return dayStarts.get(date)! + secs;
  };
  const today = serviceDateOf(new Date(input.nowMs), timeZone);
  const yesterday = addDays(today, -1);
  const candidateDates = [yesterday, today];
  const minute = Math.floor(input.nowMs / 60_000) * 60;
  const otherDate = (date: string): string => (date === today ? yesterday : today);
  const overlapsMinute = (e: { start: number; end: number }): boolean =>
    e.start < minute + 60 && e.end >= minute;

  const trips = new Map(data.trips.map((t) => [t.row.trip_id!, tripInfo(t)]));
  const routes = new Map<string, Row>(data.routes.map((r) => [r.route_id!, r]));

  const entriesOn = (info: TripInfo, date: string): Entry[] => {
    if (!operatesOn(data, info.serviceId, date)) return [];
    const at = (secs: number): number => instantSeconds(date, secs);
    if (info.frequencyRows.length === 0) {
      return [
        {
          tripId: info.tripId,
          date,
          start: at(info.startSecs),
          end: at(info.endSecs),
          frequency: null,
        },
      ];
    }
    if (info.mixed) return [];
    const duration = info.endSecs - info.startSecs;
    return info.frequencyRows.flatMap((row) => {
      const frequency: FrequencyInfo = {
        exactTimes: row.exactTimes,
        headwaySecs: row.headwaySecs,
        windowStart: at(row.startSecs),
        windowEnd: at(row.endSecs),
      };
      const out: Entry[] = [];
      for (let s = row.startSecs; s < row.endSecs; s += row.headwaySecs) {
        out.push({ tripId: info.tripId, date, start: at(s), end: at(s + duration), frequency });
      }
      return out;
    });
  };

  const tripsToday = [...trips.values()].reduce((n, t) => n + entriesOn(t, today).length, 0);

  const active: Entry[] = [];
  for (const info of trips.values()) {
    const byOffset = new Map<number, Entry>();
    for (const date of candidateDates) {
      for (const e of entriesOn(info, date).filter(overlapsMinute)) {
        const offset = e.start - instantSeconds(date, 0);
        if (byOffset.get(offset)?.date === otherDate(date)) {
          throw new Error(
            `scenario is ambiguous: ${info.tripId} is active on both candidate dates`,
          );
        }
        byOffset.set(offset, e);
        active.push(e);
      }
    }
  }
  /**
   * Step 1 of the service-date inference: the candidate dates on which the trip has an active entry
   * (for a frequency trip whose reference has a start_time, an active instance starting at exactly
   * that time on that date).
   */
  const datesWithActiveEntry = (
    info: TripInfo | undefined,
    tripId: string,
    startTime: string | null,
  ): string[] =>
    candidateDates.filter((date) =>
      active.some(
        (e) =>
          e.tripId === tripId &&
          e.date === date &&
          (!info || info.frequencyRows.length === 0 || startTime === null
            ? true
            : e.start === instantSeconds(date, parseHms(startTime))),
      ),
    );

  // Each step prefers the later candidate date when both qualify.
  const inferDate = (tripId: string, startTime: string | null): string => {
    const info = trips.get(tripId);
    const withActive = datesWithActiveEntry(info, tripId, startTime);
    if (withActive.length > 0) return withActive[withActive.length - 1]!;
    const operating = info ? candidateDates.filter((d) => operatesOn(data, info.serviceId, d)) : [];
    return operating.length > 0 ? operating[operating.length - 1]! : today;
  };

  const references: Reference[] = [];
  const collect = (sources: readonly RefSource[], isVehicle: boolean): void => {
    for (const { ref, vehicleId, timestamp } of sources) {
      if (!ref?.tripId) continue;
      const date = ref.startDate ?? inferDate(ref.tripId, ref.startTime ?? null);
      references.push({
        isVehicle,
        tripId: ref.tripId,
        vehicleId,
        timestamp: timestamp ?? null,
        routeId: ref.routeId ?? null,
        startTime: ref.startTime ?? null,
        date,
        start: ref.startTime === undefined ? null : instantSeconds(date, parseHms(ref.startTime)),
      });
    }
  };
  collect(input.vehicles, true);
  collect(input.tripUpdates, false);

  const matches = (e: Entry, r: Reference): boolean =>
    e.tripId === r.tripId && e.date === r.date && (e.frequency === null || e.start === r.start);

  /** Route and headsign of a row; the route ID falls back to the reference's for an unknown trip. */
  const routeFields = (
    tripId: string,
    referenceRouteId: string | null = null,
  ): Pick<RowBase, 'routeId' | 'routeShortName' | 'routeLongName' | 'headsign'> => {
    const row = trips.get(tripId)?.trip.row;
    const route = row ? routes.get(row.route_id!) : undefined;
    return {
      routeId: row?.route_id ?? referenceRouteId,
      routeShortName: route?.route_short_name ?? null,
      routeLongName: route?.route_long_name ?? null,
      headsign: row?.trip_headsign ?? null,
    };
  };

  const realtimeInfo = (refs: Reference[]): RealtimeInfo => {
    const startTimes = new Set(refs.map((r) => r.startTime));
    if (startTimes.size > 1)
      throw new Error('scenario is ambiguous: references disagree on start_time');
    return {
      vehicleIds: [
        ...new Set(refs.flatMap((r) => (r.vehicleId === null ? [] : [r.vehicleId]))),
      ].sort(),
      hasVehiclePosition: refs.some((r) => r.isVehicle),
      hasTripUpdate: refs.some((r) => !r.isVehicle),
      startTime: refs[0]!.startTime,
      lastSeenAt: Math.max(
        ...refs.flatMap((r) => (r.isVehicle && r.timestamp !== null ? [r.timestamp] : [])),
        ...(refs.some((r) => r.isVehicle) ? [] : [input.feedTimestamp]),
      ),
    };
  };

  const activeRows = active
    .map((e) => {
      const refs = references.filter((r) => matches(e, r));
      const row: ExpectedActiveRow = {
        tripId: e.tripId,
        serviceDate: e.date,
        ...routeFields(e.tripId),
        scheduledStart: e.start,
        scheduledEnd: e.end,
        frequency: e.frequency,
        realtime: refs.length > 0 ? realtimeInfo(refs) : null,
      };
      return row;
    })
    .sort((a, b) => a.scheduledStart - b.scheduledStart || compare(a.tripId, b.tripId));

  const unmatched = references.filter((r) => !active.some((e) => matches(e, r)));
  const groups = new Map<string, Reference[]>();
  for (const r of unmatched) {
    const isFrequencyTrip = (trips.get(r.tripId)?.frequencyRows.length ?? 0) > 0;
    const key = JSON.stringify([r.tripId, isFrequencyTrip ? r.start : null]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const unscheduled = [...groups.values()].map(
    (refs): { row: ExpectedUnscheduledRow; sortStart: number } => {
      const ref = refs[0]!;
      if (refs.some((r) => r.date !== ref.date)) {
        throw new Error(`scenario is ambiguous: ${ref.tripId} is referenced on two service dates`);
      }
      const info = trips.get(ref.tripId);
      const instances = info ? entriesOn(info, ref.date) : [];
      const named = instances.find((e) => matches(e, ref));
      let reason: Reason;
      if (!info) reason = 'unknown_trip';
      else if (info.mixed) reason = 'configuration_error';
      else if (!operatesOn(data, info.serviceId, ref.date)) reason = 'not_in_service';
      else if (info.frequencyRows.length > 0 && ref.start === null) reason = 'missing_start_time';
      else if (info.frequencyRows.length > 0 && !named) reason = 'unmatched_start_time';
      else reason = 'outside_scheduled_time';
      const window =
        info && !info.mixed && ref.start !== null
          ? info.frequencyRows
              .map((row) => ({
                row,
                s: instantSeconds(ref.date, row.startSecs),
                e: instantSeconds(ref.date, row.endSecs),
              }))
              .find(({ s, e }) => s <= ref.start! && ref.start! < e)
          : undefined;
      const row: ExpectedUnscheduledRow = {
        tripId: ref.tripId,
        serviceDate: ref.date,
        reason,
        ...routeFields(ref.tripId, ref.routeId),
        frequency: window
          ? {
              exactTimes: window.row.exactTimes,
              headwaySecs: window.row.headwaySecs,
              windowStart: window.s,
              windowEnd: window.e,
            }
          : null,
        ...(reason === 'outside_scheduled_time' &&
          named && { scheduledSpan: { start: named.start, end: named.end } }),
        ...((reason === 'unknown_trip' || reason === 'configuration_error') && {
          scheduledSpan: null,
        }),
        realtime: realtimeInfo(refs),
      };
      return { row, sortStart: ref.start ?? -Infinity };
    },
  );
  unscheduled.sort(
    (a, b) =>
      REASON_ORDER.indexOf(a.row.reason) - REASON_ORDER.indexOf(b.row.reason) ||
      compare(a.row.tripId, b.row.tripId) ||
      a.sortStart - b.sortStart,
  );

  const withRealtime = activeRows.filter((r) => r.realtime !== null);
  return {
    today,
    yesterday,
    stats: {
      tripsToday,
      tripsActiveNow: activeRows.length,
      vehicles: input.vehicles.length,
      vehiclesWithTripId: input.vehicles.filter((v) => v.ref?.tripId).length,
      tripUpdates: input.tripUpdates.length,
      activeTripsWithRealtime: withRealtime.length,
    },
    lists: {
      activeWithRealtime: withRealtime,
      activeWithoutRealtime: activeRows.filter((r) => r.realtime === null),
      unscheduledWithRealtime: unscheduled.map(({ row }) => row),
    },
    configurationErrors: [...trips.values()]
      .filter((t) => t.mixed)
      .map((t): ExpectedConfigurationError => ({ code: 'mixed_exact_times', tripId: t.tripId }))
      .sort((a, b) => compare(a.tripId, b.tripId)),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
