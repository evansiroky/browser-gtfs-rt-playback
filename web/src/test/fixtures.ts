import type {
  DashboardResponse,
  FeedStatus,
  SessionStatus,
  TripListItem,
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
