import type {
  ListName,
  TripClassification,
  TripListItem,
  TripReason,
} from '@gtfs-rt-debugger/shared';
import { formatAgencyTime, type AgencyTimeOptions } from './time';

/** The plain-words reasons of [dashboard](../../../specs/screens/dashboard.md#display-rules). */
export const REASON_TEXT: Record<TripReason, string> = {
  unknown_trip: 'Trip ID not in schedule',
  not_in_service: 'Not in service on this date',
  configuration_error: 'Schedule configuration error (see trip)',
  missing_start_time: 'Frequency trip, but the feed sent no start time',
  unmatched_start_time: 'Start time matches no scheduled departure',
  outside_scheduled_time: 'Outside its scheduled time',
};

/** Route short name, else long name, else route ID; null when the row has none. */
export function routeLabel(
  item: Pick<TripListItem, 'routeShortName' | 'routeLongName' | 'routeId'>,
): string | null {
  return item.routeShortName || item.routeLongName || item.routeId || null;
}

/** "10 min" for whole minutes, otherwise "1 min 30 s" / "45 s". */
export function formatHeadway(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** "08:15–08:55" on the agency clock; null until the timezone is known or without a span. */
export function formatSpan(
  item: Pick<TripListItem, 'scheduledStart' | 'scheduledEnd'>,
  timezone: string | null,
): string | null {
  if (timezone === null || item.scheduledStart === null || item.scheduledEnd === null) return null;
  return `${formatAgencyTime(item.scheduledStart, timezone)}–${formatAgencyTime(item.scheduledEnd, timezone)}`;
}

/** Case-insensitive match over the trip ID and the route fields; blank matches everything. */
export function matchesSearch(item: TripListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [item.tripId, item.routeId, item.routeShortName, item.routeLongName].some(
    (field) => field?.toLowerCase().includes(needle) === true,
  );
}

/**
 * One stable key per row. Frequency instances share a trip ID, and list 3 can hold several
 * references to one trip, so the key adds the scheduled start and reference start time, plus an
 * occurrence count for rows that still coincide.
 */
export function rowKeys(items: readonly TripListItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = [
      item.tripId,
      item.scheduledStart ?? '',
      item.realtime?.startTime ?? '',
      item.reason ?? '',
    ].join('|');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

export function tripPath(tripId: string): string {
  return `/trips/${encodeURIComponent(tripId)}`;
}

/** "2027-01-15" for the API's `YYYYMMDD` service date. */
export function formatServiceDate(serviceDate: string): string {
  return /^\d{8}$/.test(serviceDate)
    ? `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6)}`
    : serviceDate;
}

/**
 * An instant on the agency clock, or null until the timezone is known (no clock time is guessed)
 * or when it is unusable.
 */
export function agencyTime(
  epochSeconds: number,
  timezone: string | null,
  options?: AgencyTimeOptions,
): string | null {
  if (timezone === null) return null;
  try {
    return formatAgencyTime(epochSeconds, timezone, options);
  } catch {
    return null;
  }
}

const LIST_TEXT: Record<ListName, string> = {
  'active-with-realtime': 'Active now, with realtime data',
  'active-without-realtime': 'Active now, without realtime data',
  'unscheduled-with-realtime': 'Not scheduled this minute, with realtime data',
};

/**
 * One label per classification entry: which list, the reason for the unscheduled list, and the
 * entry's span when it has one (it tells frequency instances apart).
 */
export function classificationLabel(
  entry: TripClassification,
  timezone: string | null,
): { text: string; detail: string | null } {
  const start = entry.start === null ? null : agencyTime(entry.start, timezone);
  const end = entry.end === null ? null : agencyTime(entry.end, timezone);
  const parts = [
    entry.reason ? REASON_TEXT[entry.reason] : null,
    start !== null && end !== null ? `${start}–${end}` : null,
  ].filter((part): part is string => part !== null);
  return { text: LIST_TEXT[entry.list], detail: parts.length > 0 ? parts.join(' · ') : null };
}
