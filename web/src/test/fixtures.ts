import type {
  DashboardResponse,
  FeedStatus,
  Ping,
  SessionStatus,
  TripDetailResponse,
  TripFrequencyDetail,
  TripListItem,
  TripScheduleDetail,
} from '@gtfs-rt-debugger/shared';

export const NOW = 1_800_000_000;

export function feed(overrides: Partial<FeedStatus> = {}): FeedStatus {
  return {
    lastAttemptAt: NOW - 5,
    lastSuccessAt: NOW - 5,
    feedTimestamp: NOW - 6,
    stale: false,
    error: null,
    ...overrides,
  };
}

/** An active session with a ready schedule and healthy feeds. */
export function activeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'active',
    endedReason: null,
    activatedAt: NOW - 600,
    expiresAt: NOW + 6600,
    historyStartsAt: NOW - 590,
    schedule: { state: 'ready', loadedAt: NOW - 580, error: null },
    realtime: { vehiclePositions: feed(), tripUpdates: feed() },
    ...overrides,
  };
}

export function dormantStatus(endedReason: SessionStatus['endedReason']): SessionStatus {
  return {
    state: 'dormant',
    endedReason,
    activatedAt: null,
    expiresAt: null,
    historyStartsAt: null,
    schedule: { state: 'idle', loadedAt: null, error: null },
    realtime: { vehiclePositions: null, tripUpdates: null },
  };
}

export function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    now: NOW,
    agency: { names: ['Bay Transit'], timezone: 'America/Los_Angeles' },
    schedule: { tripsToday: 120, tripsActiveNow: 14 },
    realtime: { vehicles: 12, vehiclesWithTripId: 11, tripUpdates: 9, activeTripsWithRealtime: 8 },
    lists: { activeWithRealtime: 8, activeWithoutRealtime: 6, unscheduledWithRealtime: 3 },
    configurationErrors: { total: 0, items: [] },
    ...overrides,
  };
}

/** A plain active trip with realtime data; override what a test cares about. */
export function tripItem(overrides: Partial<TripListItem> = {}): TripListItem {
  return {
    tripId: 'trip-1',
    serviceDate: '20270115',
    routeId: 'r1',
    routeShortName: '38',
    routeLongName: 'Geary',
    headsign: 'Downtown',
    scheduledStart: NOW,
    scheduledEnd: NOW + 40 * 60,
    frequency: null,
    realtime: {
      vehicleIds: ['bus-7'],
      hasVehiclePosition: true,
      hasTripUpdate: true,
      startTime: null,
      lastSeenAt: NOW - 12,
    },
    reason: null,
    ...overrides,
  };
}

/** A ping with coordinates and only the always-present fields; override what a test cares about. */
export function ping(sequence: number, overrides: Partial<Ping> = {}): Ping {
  return {
    sequence,
    receivedAt: NOW - 100 + sequence,
    timestamp: NOW - 100 + sequence,
    vehicleId: 'bus-7',
    vehicleLabel: null,
    licensePlate: null,
    latitude: 37.78 + sequence / 1000,
    longitude: -122.41,
    bearing: null,
    odometer: null,
    speed: null,
    currentStopSequence: null,
    stopId: null,
    currentStatus: null,
    congestionLevel: null,
    occupancyStatus: null,
    occupancyPercentage: null,
    scheduleRelationship: null,
    routeId: null,
    directionId: null,
    startTime: null,
    startDate: null,
    ...overrides,
  };
}

export function frequency(overrides: Partial<TripFrequencyDetail> = {}): TripFrequencyDetail {
  return {
    row: {
      trip_id: 'trip-1',
      start_time: '08:00:00',
      end_time: '10:00:00',
      headway_secs: '600',
      exact_times: '1',
    },
    exactTimes: true,
    headwaySecs: 600,
    windowStart: NOW - 3600,
    windowEnd: NOW + 3600,
    templateDurationSecs: 1200,
    activeNow: true,
    activeInstanceStarts: [NOW - 300],
    ...overrides,
  };
}

/** A scheduled plain trip on a route; override what a test cares about. */
export function scheduled(overrides: Partial<TripScheduleDetail> = {}): TripScheduleDetail {
  return {
    trip: {
      route_id: 'r1',
      service_id: 'DAILY',
      trip_id: 'trip-1',
      trip_headsign: 'Downtown',
      block_id: '',
      shape_id: 'shape-1',
    },
    route: {
      route_id: 'r1',
      route_short_name: '38',
      route_long_name: 'Geary',
      route_type: '3',
    },
    operatesOnServiceDate: true,
    start: NOW - 600,
    end: NOW + 1800,
    activeNow: true,
    shapeId: 'shape-1',
    frequencies: null,
    configurationErrors: [],
    ...overrides,
  };
}

export function tripDetail(overrides: Partial<TripDetailResponse> = {}): TripDetailResponse {
  return {
    tripId: 'trip-1',
    serviceDate: '20270115',
    classification: [
      { list: 'active-with-realtime', reason: null, start: NOW - 600, end: NOW + 1800 },
    ],
    scheduled: scheduled(),
    realtime: { pings: [ping(1), ping(2, { vehicleId: 'bus-8' })], tripUpdate: null },
    ...overrides,
  };
}
