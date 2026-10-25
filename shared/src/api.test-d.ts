import { describe, expectTypeOf, it } from 'vitest';
import type {
  ApiErrorBody,
  ApiErrorCode,
  DashboardResponse,
  FeedStatus,
  ListName,
  Ping,
  SessionStatus,
  ShapeResponse,
  TripDetailResponse,
  TripListItem,
  TripListResponse,
  TripReason,
} from './api.js';

describe('error envelope', () => {
  it('pins the codes of conventions.md', () => {
    expectTypeOf<ApiErrorCode>().toEqualTypeOf<
      | 'bad_request'
      | 'trip_not_found'
      | 'shape_not_found'
      | 'session_not_active'
      | 'schedule_not_ready'
      | 'rate_limited'
      | 'internal_error'
    >();
    expectTypeOf<ApiErrorBody>().toEqualTypeOf<{
      error: { code: ApiErrorCode; message: string };
    }>();
  });
});

describe('session', () => {
  it('pins SessionStatus', () => {
    expectTypeOf<SessionStatus['state']>().toEqualTypeOf<'dormant' | 'active'>();
    expectTypeOf<SessionStatus['endedReason']>().toEqualTypeOf<'idle' | 'max-duration' | null>();
    expectTypeOf<SessionStatus['activatedAt']>().toEqualTypeOf<number | null>();
    expectTypeOf<SessionStatus['expiresAt']>().toEqualTypeOf<number | null>();
    expectTypeOf<SessionStatus['historyStartsAt']>().toEqualTypeOf<number | null>();
    expectTypeOf<SessionStatus['schedule']['state']>().toEqualTypeOf<
      'idle' | 'loading' | 'ready' | 'failed'
    >();
    expectTypeOf<SessionStatus['schedule']['error']>().toEqualTypeOf<{
      code: string;
      message: string;
    } | null>();
    expectTypeOf<
      SessionStatus['realtime']['vehiclePositions']
    >().toEqualTypeOf<FeedStatus | null>();
    expectTypeOf<SessionStatus['realtime']['tripUpdates']>().toEqualTypeOf<FeedStatus | null>();
    expectTypeOf<keyof SessionStatus>().toEqualTypeOf<
      | 'state'
      | 'endedReason'
      | 'activatedAt'
      | 'expiresAt'
      | 'historyStartsAt'
      | 'schedule'
      | 'realtime'
    >();
  });

  it('pins FeedStatus', () => {
    expectTypeOf<keyof FeedStatus>().toEqualTypeOf<
      'lastAttemptAt' | 'lastSuccessAt' | 'feedTimestamp' | 'stale' | 'error'
    >();
    expectTypeOf<FeedStatus['stale']>().toEqualTypeOf<boolean>();
    expectTypeOf<FeedStatus['lastSuccessAt']>().toEqualTypeOf<number | null>();
  });
});

describe('dashboard', () => {
  it('pins DashboardResponse', () => {
    expectTypeOf<keyof DashboardResponse>().toEqualTypeOf<
      'now' | 'agency' | 'schedule' | 'realtime' | 'lists' | 'configurationErrors'
    >();
    expectTypeOf<DashboardResponse['agency']>().toEqualTypeOf<{
      names: string[];
      timezone: string;
    } | null>();
    expectTypeOf<DashboardResponse['schedule']>().toEqualTypeOf<{
      tripsToday: number;
      tripsActiveNow: number;
    } | null>();
    expectTypeOf<DashboardResponse['realtime']>().toEqualTypeOf<{
      vehicles: number | null;
      vehiclesWithTripId: number | null;
      tripUpdates: number | null;
      activeTripsWithRealtime: number | null;
    }>();
    expectTypeOf<DashboardResponse['lists']>().toEqualTypeOf<{
      activeWithRealtime: number;
      activeWithoutRealtime: number;
      unscheduledWithRealtime: number;
    } | null>();
    expectTypeOf<DashboardResponse['configurationErrors']>().toEqualTypeOf<{
      total: number;
      items: { code: 'mixed_exact_times'; tripId: string; message: string }[];
    } | null>();
  });
});

describe('trip list', () => {
  it('pins the enums', () => {
    expectTypeOf<ListName>().toEqualTypeOf<
      'active-with-realtime' | 'active-without-realtime' | 'unscheduled-with-realtime'
    >();
    expectTypeOf<TripReason>().toEqualTypeOf<
      | 'unknown_trip'
      | 'configuration_error'
      | 'not_in_service'
      | 'missing_start_time'
      | 'unmatched_start_time'
      | 'outside_scheduled_time'
    >();
  });

  it('pins TripListResponse and TripListItem', () => {
    expectTypeOf<keyof TripListResponse>().toEqualTypeOf<'list' | 'generatedAt' | 'trips'>();
    expectTypeOf<TripListResponse['trips']>().toEqualTypeOf<TripListItem[]>();
    expectTypeOf<keyof TripListItem>().toEqualTypeOf<
      | 'tripId'
      | 'serviceDate'
      | 'routeId'
      | 'routeShortName'
      | 'routeLongName'
      | 'headsign'
      | 'scheduledStart'
      | 'scheduledEnd'
      | 'frequency'
      | 'realtime'
      | 'reason'
    >();
    expectTypeOf<TripListItem['routeId']>().toEqualTypeOf<string | null>();
    expectTypeOf<TripListItem['scheduledStart']>().toEqualTypeOf<number | null>();
    expectTypeOf<TripListItem['reason']>().toEqualTypeOf<TripReason | null>();
    expectTypeOf<TripListItem['frequency']>().toEqualTypeOf<{
      exactTimes: boolean;
      headwaySecs: number;
      windowStart: number;
      windowEnd: number;
    } | null>();
    expectTypeOf<TripListItem['realtime']>().toEqualTypeOf<{
      vehicleIds: string[];
      hasVehiclePosition: boolean;
      hasTripUpdate: boolean;
      startTime: string | null;
      lastSeenAt: number | null;
    } | null>();
  });
});

describe('trip detail', () => {
  it('pins TripDetailResponse', () => {
    expectTypeOf<keyof TripDetailResponse>().toEqualTypeOf<
      'tripId' | 'serviceDate' | 'classification' | 'scheduled' | 'realtime'
    >();
    expectTypeOf<TripDetailResponse['classification'][number]>().toEqualTypeOf<{
      list: ListName;
      reason: TripReason | null;
      start: number | null;
      end: number | null;
    }>();

    type Scheduled = NonNullable<TripDetailResponse['scheduled']>;
    expectTypeOf<TripDetailResponse['scheduled']>().toEqualTypeOf<Scheduled | null>();
    expectTypeOf<keyof Scheduled>().toEqualTypeOf<
      | 'trip'
      | 'route'
      | 'operatesOnServiceDate'
      | 'start'
      | 'end'
      | 'activeNow'
      | 'shapeId'
      | 'frequencies'
      | 'configurationErrors'
    >();
    expectTypeOf<Scheduled['trip']>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<Scheduled['route']>().toEqualTypeOf<Record<string, string> | null>();
    expectTypeOf<Scheduled['shapeId']>().toEqualTypeOf<string | null>();
    expectTypeOf<Scheduled['configurationErrors']>().toEqualTypeOf<
      { code: 'mixed_exact_times'; message: string }[]
    >();
    expectTypeOf<NonNullable<Scheduled['frequencies']>[number]>().toEqualTypeOf<{
      row: Record<string, string>;
      exactTimes: boolean;
      headwaySecs: number;
      windowStart: number;
      windowEnd: number;
      templateDurationSecs: number;
      activeNow: boolean;
      activeInstanceStarts: number[];
    }>();
    expectTypeOf<Scheduled['frequencies']>().toEqualTypeOf<NonNullable<
      Scheduled['frequencies']
    > | null>();
  });

  it('pins Ping', () => {
    expectTypeOf<keyof Ping>().toEqualTypeOf<
      | 'sequence'
      | 'receivedAt'
      | 'timestamp'
      | 'vehicleId'
      | 'vehicleLabel'
      | 'licensePlate'
      | 'latitude'
      | 'longitude'
      | 'bearing'
      | 'odometer'
      | 'speed'
      | 'currentStopSequence'
      | 'stopId'
      | 'currentStatus'
      | 'congestionLevel'
      | 'occupancyStatus'
      | 'occupancyPercentage'
      | 'scheduleRelationship'
      | 'routeId'
      | 'directionId'
      | 'startTime'
      | 'startDate'
    >();
    expectTypeOf<Ping['sequence']>().toEqualTypeOf<number>();
    expectTypeOf<Ping['vehicleId']>().toEqualTypeOf<string>();
    expectTypeOf<Ping['latitude']>().toEqualTypeOf<number | null>();
    expectTypeOf<Ping['directionId']>().toEqualTypeOf<number | null>();
    expectTypeOf<Ping['startDate']>().toEqualTypeOf<string | null>();
  });

  it('pins the realtime block', () => {
    type Realtime = TripDetailResponse['realtime'];
    expectTypeOf<keyof Realtime>().toEqualTypeOf<'pings' | 'tripUpdate'>();
    expectTypeOf<Realtime['pings']>().toEqualTypeOf<Ping[]>();
    expectTypeOf<Realtime['tripUpdate']>().toEqualTypeOf<{
      feedTimestamp: number | null;
      timestamp: number | null;
      delay: number | null;
      vehicleId: string | null;
      startTime: string | null;
      scheduleRelationship: string | null;
      stopTimeUpdateCount: number;
    } | null>();
  });
});

describe('shapes', () => {
  it('pins ShapeResponse', () => {
    expectTypeOf<ShapeResponse>().toEqualTypeOf<{
      shapeId: string;
      encoding: 'polyline6';
      polyline: string;
    }>();
  });
});
