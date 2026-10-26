import { describe, expectTypeOf, it } from 'vitest';
import type {
  API_ERROR_CODES,
  ApiErrorBody,
  ApiErrorCode,
  CONFIGURATION_ERROR_CODES,
  DashboardResponse,
  EpochSeconds,
  FeedStatus,
  LIST_NAMES,
  ListName,
  Ping,
  ServiceDate,
  SessionStatus,
  ShapeResponse,
  StatusError,
  TRIP_REASONS,
  TripClassification,
  TripDetailResponse,
  TripFrequencyDetail,
  TripListFrequency,
  TripListItem,
  TripListResponse,
  TripReason,
  TripScheduleDetail,
  TripUpdateSummary,
} from './api.js';

// Each shape is pinned as a whole object literal, so a changed type, a changed nullability, an
// optional field, or an added or removed field all fail. Keep these in step with specs/api/*.md.

type Row = { [column: string]: string };

describe('primitives', () => {
  it('pins the scalar aliases', () => {
    expectTypeOf<EpochSeconds>().toEqualTypeOf<number>();
    expectTypeOf<ServiceDate>().toEqualTypeOf<string>();
  });
});

describe('error envelope (conventions.md)', () => {
  it('pins the codes and the envelope', () => {
    expectTypeOf<ApiErrorCode>().toEqualTypeOf<
      | 'bad_request'
      | 'not_found'
      | 'trip_not_found'
      | 'shape_not_found'
      | 'session_not_active'
      | 'schedule_not_ready'
      | 'rate_limited'
      | 'internal_error'
    >();
    expectTypeOf<typeof API_ERROR_CODES>().toEqualTypeOf<
      readonly [
        'bad_request',
        'not_found',
        'trip_not_found',
        'shape_not_found',
        'session_not_active',
        'schedule_not_ready',
        'rate_limited',
        'internal_error',
      ]
    >();
    expectTypeOf<ApiErrorBody>().toEqualTypeOf<{
      error: { code: ApiErrorCode; message: string };
    }>();
  });
});

describe('session.md', () => {
  it('pins StatusError and FeedStatus', () => {
    expectTypeOf<StatusError>().toEqualTypeOf<{ code: string; message: string }>();
    expectTypeOf<FeedStatus>().toEqualTypeOf<{
      lastAttemptAt: number | null;
      lastSuccessAt: number | null;
      feedTimestamp: number | null;
      stale: boolean;
      error: { code: string; message: string } | null;
    }>();
  });

  it('pins SessionStatus', () => {
    expectTypeOf<SessionStatus>().toEqualTypeOf<{
      state: 'dormant' | 'active';
      endedReason: 'idle' | 'max-duration' | null;
      activatedAt: number | null;
      expiresAt: number | null;
      historyStartsAt: number | null;
      schedule: {
        state: 'idle' | 'loading' | 'ready' | 'failed';
        loadedAt: number | null;
        error: { code: string; message: string } | null;
      };
      realtime: {
        vehiclePositions: FeedStatus | null;
        tripUpdates: FeedStatus | null;
      };
    }>();
  });
});

describe('dashboard.md', () => {
  it('pins DashboardResponse', () => {
    expectTypeOf<DashboardResponse>().toEqualTypeOf<{
      now: number;
      agency: { names: string[]; timezone: string } | null;
      schedule: { tripsToday: number; tripsActiveNow: number } | null;
      realtime: {
        vehicles: number | null;
        vehiclesWithTripId: number | null;
        tripUpdates: number | null;
        activeTripsWithRealtime: number | null;
      };
      lists: {
        activeWithRealtime: number;
        activeWithoutRealtime: number;
        unscheduledWithRealtime: number;
      } | null;
      configurationErrors: {
        total: number;
        items: {
          code: 'mixed_exact_times' | 'unusable_stop_times';
          tripId: string;
          message: string;
        }[];
      } | null;
    }>();
    expectTypeOf<typeof CONFIGURATION_ERROR_CODES>().toEqualTypeOf<
      readonly ['mixed_exact_times', 'unusable_stop_times']
    >();
  });
});

describe('trips.md: list', () => {
  it('pins the enums', () => {
    expectTypeOf<ListName>().toEqualTypeOf<
      'active-with-realtime' | 'active-without-realtime' | 'unscheduled-with-realtime'
    >();
    expectTypeOf<typeof LIST_NAMES>().toEqualTypeOf<
      readonly ['active-with-realtime', 'active-without-realtime', 'unscheduled-with-realtime']
    >();
    expectTypeOf<TripReason>().toEqualTypeOf<
      | 'unknown_trip'
      | 'configuration_error'
      | 'not_in_service'
      | 'missing_start_time'
      | 'unmatched_start_time'
      | 'outside_scheduled_time'
    >();
    expectTypeOf<typeof TRIP_REASONS>().toEqualTypeOf<
      readonly [
        'unknown_trip',
        'configuration_error',
        'not_in_service',
        'missing_start_time',
        'unmatched_start_time',
        'outside_scheduled_time',
      ]
    >();
  });

  it('pins TripListFrequency and TripListItem', () => {
    expectTypeOf<TripListFrequency>().toEqualTypeOf<{
      exactTimes: boolean;
      headwaySecs: number;
      windowStart: number;
      windowEnd: number;
    }>();
    expectTypeOf<TripListItem>().toEqualTypeOf<{
      tripId: string;
      serviceDate: string;
      routeId: string | null;
      routeShortName: string | null;
      routeLongName: string | null;
      headsign: string | null;
      scheduledStart: number | null;
      scheduledEnd: number | null;
      frequency: TripListFrequency | null;
      realtime: {
        vehicleIds: string[];
        hasVehiclePosition: boolean;
        hasTripUpdate: boolean;
        startTime: string | null;
        lastSeenAt: number | null;
      } | null;
      reason: TripReason | null;
    }>();
  });

  it('pins TripListResponse', () => {
    expectTypeOf<TripListResponse>().toEqualTypeOf<{
      list: ListName;
      generatedAt: number;
      trips: TripListItem[];
    }>();
  });
});

describe('trips.md: detail', () => {
  it('pins TripClassification', () => {
    expectTypeOf<TripClassification>().toEqualTypeOf<{
      list: ListName;
      reason: TripReason | null;
      start: number | null;
      end: number | null;
    }>();
  });

  it('pins TripFrequencyDetail', () => {
    expectTypeOf<TripFrequencyDetail>().toEqualTypeOf<{
      row: Row;
      exactTimes: boolean;
      headwaySecs: number;
      windowStart: number;
      windowEnd: number;
      templateDurationSecs: number;
      activeNow: boolean;
      activeInstanceStarts: number[];
    }>();
  });

  it('pins TripScheduleDetail', () => {
    expectTypeOf<TripScheduleDetail>().toEqualTypeOf<{
      trip: Row;
      route: Row | null;
      operatesOnServiceDate: boolean;
      start: number | null;
      end: number | null;
      activeNow: boolean;
      shapeId: string | null;
      frequencies: TripFrequencyDetail[] | null;
      configurationErrors: { code: 'mixed_exact_times' | 'unusable_stop_times'; message: string }[];
    }>();
  });

  it('pins Ping', () => {
    expectTypeOf<Ping>().toEqualTypeOf<{
      sequence: number;
      receivedAt: number;
      timestamp: number;
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
      currentStatus: string | null;
      congestionLevel: string | null;
      occupancyStatus: string | null;
      occupancyPercentage: number | null;
      scheduleRelationship: string | null;
      routeId: string | null;
      directionId: number | null;
      startTime: string | null;
      startDate: string | null;
    }>();
  });

  it('pins TripUpdateSummary', () => {
    expectTypeOf<TripUpdateSummary>().toEqualTypeOf<{
      feedTimestamp: number | null;
      timestamp: number | null;
      delay: number | null;
      vehicleId: string | null;
      startTime: string | null;
      scheduleRelationship: string | null;
      stopTimeUpdateCount: number;
    }>();
  });

  it('pins TripDetailResponse', () => {
    expectTypeOf<TripDetailResponse>().toEqualTypeOf<{
      tripId: string;
      serviceDate: string;
      classification: TripClassification[];
      scheduled: TripScheduleDetail | null;
      realtime: {
        pings: Ping[];
        tripUpdate: TripUpdateSummary | null;
      };
    }>();
  });
});

describe('shapes.md', () => {
  it('pins ShapeResponse', () => {
    expectTypeOf<ShapeResponse>().toEqualTypeOf<{
      shapeId: string;
      encoding: 'polyline6';
      polyline: string;
    }>();
  });
});
