import type {
  TripClassification,
  TripConfigurationError,
  TripDetailResponse,
  TripFrequencyDetail,
  TripScheduleDetail,
  TripUpdateSummary,
} from '@gtfs-rt-debugger/shared';
import { classify, inferDate, resolveReferences } from './classify.js';
import {
  configurationErrorMessage,
  parseFrequencyRows,
  scheduledBounds,
  tripOf,
  type Entry,
  type Frame,
} from './entries.js';
import type { StoredPing } from './pings.js';
import type { TripReference } from './references.js';

/** The newest of the trip updates for a trip by `timestamp`; the first among equals. */
function latestTripUpdate(references: readonly TripReference[]): TripUpdateSummary | null {
  let best: TripReference | null = null;
  for (const reference of references) {
    const update = reference.tripUpdate;
    if (!update) continue;
    if (!best || (update.timestamp ?? -Infinity) > (best.tripUpdate!.timestamp ?? -Infinity)) {
      best = reference;
    }
  }
  if (!best?.tripUpdate) return null;
  return {
    feedTimestamp: best.feedTimestamp,
    timestamp: best.tripUpdate.timestamp,
    delay: best.tripUpdate.delay,
    vehicleId: best.vehicleId,
    startTime: best.startTime,
    scheduleRelationship: best.tripUpdate.scheduleRelationship,
    stopTimeUpdateCount: best.tripUpdate.stopTimeUpdateCount,
  };
}

/**
 * What `GET /trips/{tripId}` returns (api/trips.md "Detail"), or null when the trip ID is
 * neither in the schedule nor in the retained realtime data (the latest snapshots' references
 * and the pings).
 *
 * `references` are all the latest snapshots' references to the trip, vehicle positions first.
 */
export function buildDetail(
  frame: Frame,
  tripId: string,
  references: readonly TripReference[],
  pings: readonly StoredPing[],
): TripDetailResponse | null {
  const trip = tripOf(frame.store, tripId);
  if (!trip && references.length === 0 && pings.length === 0) return null;

  const entries = frame.tripEntries(tripId);
  const classification = classify(frame, entries, references);
  const entriesOf = (id: string): readonly Entry[] => (id === tripId ? entries : []);
  const dates = resolveReferences(frame, entriesOf, references);
  const stated = references.flatMap((r) => (r.startDate === null ? [] : [r.startDate]));
  const serviceDate =
    stated.length > 0
      ? stated.reduce((a, b) => (b > a ? b : a))
      : dates.length > 0
        ? dates.reduce((a, b) => (b.date > a ? b.date : a), dates[0]!.date)
        : inferDate(frame, entriesOf, { tripId, startTime: null, startOffset: null });

  const listed: TripClassification[] = [
    ...classification.withRealtime.map((row) => ({
      list: 'active-with-realtime' as const,
      reason: null,
      start: row.entry.start,
      end: row.entry.end,
    })),
    ...classification.withoutRealtime.map((row) => ({
      list: 'active-without-realtime' as const,
      reason: null,
      start: row.entry.start,
      end: row.entry.end,
    })),
    ...classification.unscheduled.map((row) => ({
      list: 'unscheduled-with-realtime' as const,
      reason: row.reason,
      start: row.named?.start ?? null,
      end: row.named?.end ?? null,
    })),
  ];

  return {
    tripId,
    serviceDate,
    classification: listed,
    scheduled: trip ? scheduledDetail(frame, trip.id, serviceDate, entries) : null,
    realtime: { pings: [...pings], tripUpdate: latestTripUpdate(references) },
  };
}

function scheduledDetail(
  frame: Frame,
  tripId: string,
  serviceDate: string,
  entries: readonly Entry[],
): TripScheduleDetail {
  const trip = tripOf(frame.store, tripId)!;
  const codes = frame.index.errors.get(tripId) ?? [];
  const operates = frame.operates(trip.row['service_id'], serviceDate);
  const bounds = operates ? scheduledBounds(frame, trip, serviceDate) : null;
  const routeId = trip.row['route_id'];
  const route = routeId ? frame.store.route(routeId) : undefined;
  const dayStart = frame.dayStart(serviceDate);
  const duration = trip.template ? trip.template.endSecs - trip.template.startSecs : null;

  const frequencies: TripFrequencyDetail[] | null =
    trip.frequencies.length === 0
      ? null
      : parseFrequencyRows(trip.frequencies).map((window) => {
          const starts = entries
            .filter((entry) => entry.window?.rowIndex === window.rowIndex)
            .map((entry) => entry.start)
            .sort((a, b) => a - b);
          return {
            row: { ...window.row },
            exactTimes: window.exactTimes,
            headwaySecs: window.headwaySecs,
            windowStart: window.startSecs === null ? null : dayStart + window.startSecs,
            windowEnd: window.endSecs === null ? null : dayStart + window.endSecs,
            templateDurationSecs: duration,
            activeNow: starts.length > 0,
            activeInstanceStarts: starts,
          };
        });

  const configurationErrors: TripConfigurationError[] = codes.map((code) => ({
    code,
    message: configurationErrorMessage(code),
  }));

  return {
    trip: { ...trip.row },
    route: route ? { ...route } : null,
    operatesOnServiceDate: operates,
    start: bounds?.start ?? null,
    end: bounds?.end ?? null,
    activeNow: entries.length > 0,
    shapeId: trip.row['shape_id'] || null,
    frequencies,
    configurationErrors,
  };
}
