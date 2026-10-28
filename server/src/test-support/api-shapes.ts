import { LIST_NAMES, TRIP_REASONS } from '@gtfs-rt-debugger/shared';
import { array, nullable, object, oneOf, type Shape } from './shape.js';

/** The response shapes of api/dashboard.md and api/trips.md, field for field. */
const CODES = ['mixed_exact_times', 'unusable_stop_times', 'frequency_too_dense'] as const;
const column = { record: 'string' } as const;
const reason = nullable(oneOf(...TRIP_REASONS));

export const DASHBOARD: Shape = object({
  now: 'integer',
  agency: nullable(object({ names: array('string'), timezone: 'string' })),
  schedule: nullable(object({ tripsToday: 'integer', tripsActiveNow: 'integer' })),
  realtime: object({
    vehicles: nullable('integer'),
    vehiclesWithTripId: nullable('integer'),
    tripUpdates: nullable('integer'),
    activeTripsWithRealtime: nullable('integer'),
  }),
  lists: nullable(
    object({
      activeWithRealtime: 'integer',
      activeWithoutRealtime: 'integer',
      unscheduledWithRealtime: 'integer',
    }),
  ),
  configurationErrors: nullable(
    object({
      total: 'integer',
      items: array(object({ code: oneOf(...CODES), tripId: 'string', message: 'string' })),
    }),
  ),
});

export const TRIP_LIST: Shape = object({
  list: oneOf(...LIST_NAMES),
  generatedAt: 'integer',
  trips: array(
    object({
      tripId: 'string',
      serviceDate: 'string',
      routeId: nullable('string'),
      routeShortName: nullable('string'),
      routeLongName: nullable('string'),
      headsign: nullable('string'),
      scheduledStart: nullable('integer'),
      scheduledEnd: nullable('integer'),
      frequency: nullable(
        object({
          exactTimes: 'boolean',
          headwaySecs: 'integer',
          windowStart: 'integer',
          windowEnd: 'integer',
        }),
      ),
      realtime: nullable(
        object({
          vehicleIds: array('string'),
          hasVehiclePosition: 'boolean',
          hasTripUpdate: 'boolean',
          startTime: nullable('string'),
          lastSeenAt: nullable('integer'),
        }),
      ),
      reason,
    }),
  ),
});

/** Pings carry the typed fields and may carry others, under their GTFS-RT names. */
const PING: Shape = object(
  {
    sequence: 'integer',
    receivedAt: 'integer',
    timestamp: 'integer',
    vehicleId: 'string',
    vehicleLabel: nullable('string'),
    licensePlate: nullable('string'),
    latitude: nullable('number'),
    longitude: nullable('number'),
    bearing: nullable('number'),
    odometer: nullable('number'),
    speed: nullable('number'),
    currentStopSequence: nullable('integer'),
    stopId: nullable('string'),
    currentStatus: nullable('string'),
    congestionLevel: nullable('string'),
    occupancyStatus: nullable('string'),
    occupancyPercentage: nullable('integer'),
    scheduleRelationship: nullable('string'),
    routeId: nullable('string'),
    directionId: nullable('integer'),
    startTime: nullable('string'),
    startDate: nullable('string'),
  },
  true,
);

export const TRIP_DETAIL: Shape = object({
  tripId: 'string',
  serviceDate: 'string',
  classification: array(
    object({
      list: oneOf(...LIST_NAMES),
      reason,
      start: nullable('integer'),
      end: nullable('integer'),
    }),
  ),
  scheduled: nullable(
    object({
      trip: column,
      route: nullable(column),
      operatesOnServiceDate: 'boolean',
      start: nullable('integer'),
      end: nullable('integer'),
      activeNow: 'boolean',
      shapeId: nullable('string'),
      frequencies: nullable(
        array(
          object({
            row: column,
            exactTimes: 'boolean',
            headwaySecs: nullable('integer'),
            windowStart: nullable('integer'),
            windowEnd: nullable('integer'),
            templateDurationSecs: nullable('integer'),
            activeNow: 'boolean',
            activeInstanceStarts: array('integer'),
          }),
        ),
      ),
      configurationErrors: array(object({ code: oneOf(...CODES), message: 'string' })),
    }),
  ),
  realtime: object({
    pings: array(PING),
    tripUpdate: nullable(
      object({
        feedTimestamp: nullable('integer'),
        timestamp: nullable('integer'),
        delay: nullable('integer'),
        vehicleId: nullable('string'),
        startTime: nullable('string'),
        scheduleRelationship: nullable('string'),
        stopTimeUpdateCount: 'integer',
      }),
    ),
  }),
});
