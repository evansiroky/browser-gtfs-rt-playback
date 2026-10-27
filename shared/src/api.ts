/**
 * The JSON contract of `/api/v1`, exactly as specified in `specs/api/`.
 * Instants are Unix epoch seconds; service dates are `YYYYMMDD` strings.
 */

/** Unix epoch seconds (UTC). */
export type EpochSeconds = number;

/** A calendar date in the agency timezone, `YYYYMMDD`. */
export type ServiceDate = string;

/** A GTFS text row, every column as text (`trips.txt`, `routes.txt`, `frequencies.txt`). */
export type GtfsRow = Record<string, string>;

// --- conventions.md: errors -------------------------------------------------------------------

export const API_ERROR_CODES = [
  'bad_request',
  'not_found',
  'trip_not_found',
  'shape_not_found',
  'session_not_active',
  'schedule_not_ready',
  'rate_limited',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The envelope of every non-2xx response. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

// --- session.md ---------------------------------------------------------------------------------

export type SessionState = 'dormant' | 'active';

/** Why the last activation ended. */
export type EndedReason = 'idle' | 'max-duration';

/** `idle` only while dormant. */
export type ScheduleState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * A feed or schedule failure: a generic code (for example `http_status_404`, `timeout`,
 * `too_large`, `decode_failed`) and a URL-free message. Not an {@link ApiErrorCode}.
 */
export interface StatusError {
  code: string;
  message: string;
}

export interface FeedStatus {
  lastAttemptAt: EpochSeconds | null;
  lastSuccessAt: EpochSeconds | null;
  /** Header timestamp of the latest snapshot. */
  feedTimestamp: EpochSeconds | null;
  stale: boolean;
  /** Most recent failure, cleared on success. */
  error: StatusError | null;
}

/** Response of `POST /api/v1/session/start` and `POST /api/v1/session/ping`. */
export interface SessionStatus {
  state: SessionState;
  /** A restarted process reports null. */
  endedReason: EndedReason | null;
  /** Start of the current activation. */
  activatedAt: EpochSeconds | null;
  /** `activatedAt` plus the maximum duration. */
  expiresAt: EpochSeconds | null;
  /** Oldest retained realtime snapshot. */
  historyStartsAt: EpochSeconds | null;
  schedule: {
    state: ScheduleState;
    loadedAt: EpochSeconds | null;
    error: StatusError | null;
  };
  realtime: {
    /** Null when not configured. */
    vehiclePositions: FeedStatus | null;
    tripUpdates: FeedStatus | null;
  };
}

// --- dashboard.md -------------------------------------------------------------------------------

export const CONFIGURATION_ERROR_CODES = [
  'mixed_exact_times',
  'unusable_stop_times',
  'frequency_too_dense',
] as const;

export type ConfigurationErrorCode = (typeof CONFIGURATION_ERROR_CODES)[number];

export interface DashboardConfigurationError {
  code: ConfigurationErrorCode;
  tripId: string;
  message: string;
}

/** Response of `GET /api/v1/dashboard`. */
export interface DashboardResponse {
  /** Server clock at computation. */
  now: EpochSeconds;
  /** Null until the schedule is ready. */
  agency: {
    names: string[];
    /** IANA timezone name. */
    timezone: string;
  } | null;
  /** Null until the schedule is ready. */
  schedule: {
    tripsToday: number;
    tripsActiveNow: number;
  } | null;
  realtime: {
    /** Null: feed unconfigured or no snapshot yet. */
    vehicles: number | null;
    vehiclesWithTripId: number | null;
    tripUpdates: number | null;
    /** Also null while the schedule is not ready. */
    activeTripsWithRealtime: number | null;
  };
  /** Null until the schedule is ready. */
  lists: {
    activeWithRealtime: number;
    activeWithoutRealtime: number;
    unscheduledWithRealtime: number;
  } | null;
  /** Null until the schedule is ready. */
  configurationErrors: {
    total: number;
    /** The first 100. */
    items: DashboardConfigurationError[];
  } | null;
}

// --- trips.md: list -----------------------------------------------------------------------------

export const LIST_NAMES = [
  'active-with-realtime',
  'active-without-realtime',
  'unscheduled-with-realtime',
] as const;

export type ListName = (typeof LIST_NAMES)[number];

/** Why a reference is in the unscheduled list. Only present on list 3 rows. */
export const TRIP_REASONS = [
  'unknown_trip',
  'configuration_error',
  'not_in_service',
  'missing_start_time',
  'unmatched_start_time',
  'outside_scheduled_time',
] as const;

export type TripReason = (typeof TRIP_REASONS)[number];

/** The `frequencies.txt` row a list entry is a nominal instance of. */
export interface TripListFrequency {
  /** As sent (absent = false); informational only. */
  exactTimes: boolean;
  headwaySecs: number;
  /** `start_time` on the service date. */
  windowStart: EpochSeconds;
  windowEnd: EpochSeconds;
}

export interface TripListItem {
  tripId: string;
  /** Derived, informational. */
  serviceDate: ServiceDate;
  /** From trips.txt, else the realtime reference. */
  routeId: string | null;
  /** From routes.txt; null if the route is unknown. */
  routeShortName: string | null;
  routeLongName: string | null;
  /** trips.txt `trip_headsign`. */
  headsign: string | null;
  /** The entry's span; null when the trip is unknown. */
  scheduledStart: EpochSeconds | null;
  scheduledEnd: EpochSeconds | null;
  /** Null for plain trips. */
  frequency: TripListFrequency | null;
  /** Null for `active-without-realtime`. */
  realtime: {
    /** Distinct, from the latest snapshots. */
    vehicleIds: string[];
    hasVehiclePosition: boolean;
    hasTripUpdate: boolean;
    /** The reference's `start_time`, as sent. */
    startTime: string | null;
    /** Newest vehicle timestamp, else feed timestamp. */
    lastSeenAt: EpochSeconds | null;
  } | null;
  /** List 3 only; null elsewhere. */
  reason: TripReason | null;
}

/** Response of `GET /api/v1/trips?list=<name>`. */
export interface TripListResponse {
  /** Echo of the parameter. */
  list: ListName;
  generatedAt: EpochSeconds;
  trips: TripListItem[];
}

// --- trips.md: detail ---------------------------------------------------------------------------

export interface TripClassification {
  list: ListName;
  reason: TripReason | null;
  /** The entry's start, when it has one. */
  start: EpochSeconds | null;
  end: EpochSeconds | null;
}

export interface TripConfigurationError {
  code: ConfigurationErrorCode;
  message: string;
}

export interface TripFrequencyDetail {
  /** Every column of the frequencies.txt row. */
  row: GtfsRow;
  /** As sent (absent = false); informational only. */
  exactTimes: boolean;
  /** Null when this value cannot be read (each of headway, window start and end is nulled independently); a row with any null has no instances. */
  headwaySecs: number | null;
  windowStart: EpochSeconds | null;
  windowEnd: EpochSeconds | null;
  /** Null when the trip has `unusable_stop_times`: no template exists. */
  templateDurationSecs: number | null;
  activeNow: boolean;
  /** Nominal instances overlapping now; empty if misconfigured. */
  activeInstanceStarts: EpochSeconds[];
}

/** Null in {@link TripDetailResponse} when the trip ID is not in trips.txt. */
export interface TripScheduleDetail {
  /** Every column of the trips.txt row, as text. */
  trip: GtfsRow;
  /** Every column of the routes.txt row; null if missing. */
  route: GtfsRow | null;
  operatesOnServiceDate: boolean;
  /** Plain: span start; frequency: first instance start; null if not operating or misconfigured. */
  start: EpochSeconds | null;
  /** Plain: span end; frequency: last instance end; null likewise. */
  end: EpochSeconds | null;
  /** Any entry overlaps the current minute. */
  activeNow: boolean;
  /** trips.txt `shape_id`; fetch via `GET /api/v1/shapes/{shapeId}`. */
  shapeId: string | null;
  /** Null for plain trips. */
  frequencies: TripFrequencyDetail[] | null;
  /** Empty when none. */
  configurationErrors: TripConfigurationError[];
}

/**
 * One observation of a vehicle on a trip. The server also passes other `VehiclePosition`
 * fields through under their GTFS-RT names in camelCase; they are not typed here, and clients
 * ignore unknown fields ([conventions](../../specs/api/conventions.md)).
 */
export interface Ping {
  /** Ping sequence: 1, 2, 3... in order of first receipt this activation. */
  sequence: number;
  /** When the server first received it. */
  receivedAt: EpochSeconds;
  /** Vehicle timestamp (or the feed header timestamp as fallback). */
  timestamp: EpochSeconds;
  vehicleId: string;
  vehicleLabel: string | null;
  licensePlate: string | null;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  odometer: number | null;
  speed: number | null;
  currentStopSequence: number | null;
  stopId: string | null;
  /** INCOMING_AT | STOPPED_AT | IN_TRANSIT_TO */
  currentStatus: string | null;
  congestionLevel: string | null;
  occupancyStatus: string | null;
  occupancyPercentage: number | null;
  /** The trip descriptor's relationship. */
  scheduleRelationship: string | null;
  /** As carried in the trip descriptor. */
  routeId: string | null;
  directionId: number | null;
  /** Trip descriptor, as sent. */
  startTime: string | null;
  startDate: string | null;
}

export interface TripUpdateSummary {
  feedTimestamp: EpochSeconds | null;
  timestamp: EpochSeconds | null;
  /** Seconds. */
  delay: number | null;
  vehicleId: string | null;
  startTime: string | null;
  scheduleRelationship: string | null;
  stopTimeUpdateCount: number;
}

/** Response of `GET /api/v1/trips/{tripId}`. */
export interface TripDetailResponse {
  tripId: string;
  /** Derived: latest reference `start_date`, else per trip-activity. */
  serviceDate: ServiceDate;
  /** One per active entry or unmatched reference; empty: in no list. */
  classification: TripClassification[];
  /** Null when the trip ID is not in trips.txt. */
  scheduled: TripScheduleDetail | null;
  realtime: {
    /** Ascending by sequence; retained window only. */
    pings: Ping[];
    /** The latest snapshot's update for this trip, or null. */
    tripUpdate: TripUpdateSummary | null;
  };
}

// --- shapes.md ----------------------------------------------------------------------------------

/** Response of `GET /api/v1/shapes/{shapeId}`. */
export interface ShapeResponse {
  shapeId: string;
  /** Google encoded polyline algorithm, 6 decimal places. */
  encoding: 'polyline6';
  /** Points ordered by `shape_pt_sequence`. */
  polyline: string;
}
