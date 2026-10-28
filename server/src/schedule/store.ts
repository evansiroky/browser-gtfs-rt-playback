import type { ConfigurationErrorCode } from '@gtfs-rt-debugger/shared';

/** One CSV row: every column of the file, as the feed wrote it (a column the row lacks is absent). */
export type Row = Readonly<Record<string, string>>;

/**
 * A trip's first and last stop time, in seconds from the service day's "noon minus 12 hours"
 * (values past 86 400 are trips running past midnight). `startSecs` is the first stop's
 * departure, else its arrival; `endSecs` is the last stop's arrival, else its departure
 * ([data-model](../../../specs/data-model.md#scheduled-trip)). For a frequency trip this is the
 * template: only the difference is meaningful.
 */
export interface TripTemplate {
  readonly startSecs: number;
  readonly endSecs: number;
}

export interface ScheduleTrip {
  readonly id: string;
  /** The whole `trips.txt` row. */
  readonly row: Row;
  /**
   * Null when the trip has no usable template: no `stop_times.txt` rows (with a numeric
   * `stop_sequence`), or its first stop has neither a departure nor an arrival time, or its last
   * stop has neither an arrival nor a departure time (missing or malformed). Such a trip is also
   * listed in {@link ScheduleStore.configurationErrors} as `unusable_stop_times`.
   */
  readonly template: TripTemplate | null;
  /** The trip's `frequencies.txt` rows, whole, in file order; empty for a plain trip. */
  readonly frequencies: readonly Row[];
}

export interface ScheduleConfigurationError {
  readonly code: ConfigurationErrorCode;
  readonly tripId: string;
}

export interface ScheduleCounts {
  readonly trips: number;
  readonly routes: number;
  readonly shapes: number;
  /** The load's own estimate of the heap the schedule holds (what the memory limit is checked against). */
  readonly estimatedBytes: number;
}

/**
 * The reduced, in-memory GTFS Schedule (data-model.md, feed-ingest.md "Schedule"): what the trip
 * engine and the trips API read. Immutable once loaded; the loader drops it at dormancy.
 */
export interface ScheduleStore {
  /** Every `agency.txt` row's `agency_name`, and the first row's `agency_timezone` (IANA). */
  agency(): { readonly names: readonly string[]; readonly timezone: string };
  /** The whole `trips.txt` row, or undefined for an unknown trip. */
  trip(tripId: string): Row | undefined;
  /** The whole `routes.txt` row, or undefined for an unknown route. */
  route(routeId: string): Row | undefined;
  /** The trip's `frequencies.txt` rows, whole; empty for a plain or unknown trip. */
  frequencies(tripId: string): readonly Row[];
  /** The trip's template; null for an unknown trip and for a trip without a usable one. */
  template(tripId: string): TripTemplate | null;
  /** Every trip, in `trips.txt` order. */
  trips(): IterableIterator<ScheduleTrip>;
  /** Whether the service runs on a service date (`YYYYMMDD`): `calendar.txt`, then exceptions. */
  operatesOn(serviceId: string, serviceDate: string): boolean;
  /** The shape's precision-6 polyline, or null for an unknown shape. */
  shape(shapeId: string): string | null;
  /**
   * The configuration errors found at load, in `trips.txt` order (trip-activity.md): trips whose
   * `frequencies.txt` rows do not all share one `exact_times` (absent counts as 0), as
   * `mixed_exact_times`; trips whose `template` is null, as `unusable_stop_times`; and trips with a
   * readable frequency row that could have more than `MAX_CONCURRENT_INSTANCES` instances running
   * at once, as `frequency_too_dense`. A trip with several is listed under each code, in that order.
   */
  configurationErrors(): readonly ScheduleConfigurationError[];
  counts(): ScheduleCounts;
}
