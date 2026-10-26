# API: Trips

Neither endpoint accepts a date. The service date of a trip is derived by the server
([trip-activity](../behaviors/trip-activity.md)) and only ever returned, never supplied: the
app shows the present and the retained window (at most the last hour), and there is no way
to ask about another day.

## List
`GET /api/v1/trips?list=<name>` where `<name>` is `active-with-realtime`,
`active-without-realtime`, or `unscheduled-with-realtime` — the three lists defined in
[trip-activity](../behaviors/trip-activity.md#the-three-lists). Missing or unknown `list`, or
any other query parameter → `400 bad_request`. `409 session_not_active` while dormant;
`409 schedule_not_ready` until the schedule has loaded.

The response contains the complete list (no pagination), in the order defined by
trip-activity:

```
list:        string                                  // echo of the parameter
generatedAt: epoch seconds
trips: [{
  tripId:       string
  serviceDate:  "YYYYMMDD"                           // derived, informational
  routeId:      string | null                        // from trips.txt (empty counts as none), else the realtime reference
  routeShortName: string | null                      // from the routes.txt row for routeId, even when the
                                                     // trip is unknown; null if routeId is null or not in routes.txt
  routeLongName:  string | null
  headsign:     string | null                        // trips.txt trip_headsign
  scheduledStart: epoch seconds | null               // the entry's span; null when the trip is unknown
  scheduledEnd:   epoch seconds | null
  frequency: {                                       // null for plain trips
    exactTimes:  boolean                             // as sent (absent = false); informational only
    headwaySecs: integer
    windowStart: epoch seconds                       // frequencies.txt start_time on the service date
    windowEnd:   epoch seconds
  } | null                                           // the entry is a nominal instance of this row
  realtime: {                                        // null for active-without-realtime
    vehicleIds:      string[]                        // distinct, from the latest snapshots
    hasVehiclePosition: boolean
    hasTripUpdate:      boolean
    startTime:       string | null                   // the reference's start_time, as sent
    lastSeenAt:      epoch seconds | null            // newest vehicle timestamp (0 counts as none), else the header timestamp of the feed of the first reference (vehicle positions first)
  } | null
  reason: "unknown_trip" | "configuration_error" | "not_in_service" | "missing_start_time"
        | "unmatched_start_time" | "outside_scheduled_time" | null   // list 3 only
}]
```
Rows for different instances of one frequency trip share a `tripId` and differ in
`scheduledStart`. For a list 3 row of a frequency trip, `frequency` describes the row whose
window contains the reference's start, else null. A trip with a configuration error produces no
active entries; its list 3 rows have `scheduledStart` and `scheduledEnd` null and `frequency`
null. A list 3 row has `scheduledStart` and `scheduledEnd` only for the reason
`outside_scheduled_time`, where it is the span of the entry the reference names. When several
references behind a row carry a `start_time`, `realtime.startTime` is the first, vehicle
positions before trip updates, in feed order.

## Detail
`GET /api/v1/trips/{tripId}` — `tripId` is percent-encoded. **No query parameters are
accepted**; any query parameter, `serviceDate` included, → `400 bad_request`. `409` statuses
as for the list. `404 trip_not_found` when the trip ID is neither in the schedule nor in the latest
snapshots nor in any retained ping.

The response describes the trip as it stands now, over everything retained for the trip ID:
all its pings in the window (every vehicle, every frequency instance), whichever lists it is
in, and its schedule data.

```
tripId:      string
serviceDate: "YYYYMMDD"                              // derived: latest reference start_date, else per trip-activity
classification: [{                                   // one per active entry or unmatched reference
  list:   "active-with-realtime" | "active-without-realtime" | "unscheduled-with-realtime"
  reason: same enum as the list | null
  start:  epoch seconds | null                       // the entry's start, when it has one
  end:    epoch seconds | null
}]                                                   // empty: in no list
scheduled: {                                         // null when the trip ID is not in trips.txt
  trip:        { [column: string]: string }          // every column of the trips.txt row, as text
  route:       { [column: string]: string } | null   // every column of the routes.txt row; null if missing
  operatesOnServiceDate: boolean
  start:       epoch seconds | null                  // plain: span start; frequency: first instance start; null if not operating or misconfigured
  end:         epoch seconds | null                  // plain: span end; frequency: last instance end; null likewise
  activeNow:   boolean                               // any entry overlaps the current minute
  shapeId:     string | null                         // trips.txt shape_id; fetch via shapes.md
  frequencies: [{                                    // null for plain trips
    row:         { [column: string]: string }        // every column of the frequencies.txt row
    exactTimes:  boolean                             // as sent (absent = false); informational only
    headwaySecs: integer | null                     // null (with the window) when the row cannot be read
    windowStart: epoch seconds | null
    windowEnd:   epoch seconds | null
    templateDurationSecs: integer | null            // null when the trip has unusable_stop_times
    activeNow:   boolean
    activeInstanceStarts: epoch seconds[]            // nominal instances overlapping now; empty if misconfigured
  }] | null
  configurationErrors: [{ code: "mixed_exact_times" | "unusable_stop_times" | "frequency_too_dense", message: string }]   // empty when none
} | null
realtime: {
  pings: [{                                         // ascending by sequence; retained window only
    sequence:    integer                            // see data-model: ping sequence
    receivedAt:  epoch seconds                      // when the server first received it
    timestamp:   epoch seconds                      // vehicle timestamp (0 counts as none), else feed header timestamp, else receive time
    vehicleId:   string
    vehicleLabel: string | null
    licensePlate: string | null
    latitude:    number | null
    longitude:   number | null
    bearing:     number | null
    odometer:    number | null
    speed:       number | null
    currentStopSequence: integer | null
    stopId:      string | null
    currentStatus: string | null                    // INCOMING_AT | STOPPED_AT | IN_TRANSIT_TO
    congestionLevel: string | null
    occupancyStatus: string | null
    occupancyPercentage: integer | null
    scheduleRelationship: string | null             // trip descriptor's relationship
    routeId:     string | null                      // as carried in the trip descriptor
    directionId: integer | null
    startTime:   string | null                      // trip descriptor, as sent
    startDate:   string | null
  }]
  tripUpdate: {                                     // latest snapshot's update for this trip, or null
    feedTimestamp: epoch seconds | null
    timestamp:     epoch seconds | null
    delay:         integer | null                   // seconds
    vehicleId:     string | null
    startTime:     string | null
    scheduleRelationship: string | null
    stopTimeUpdateCount:  integer
  } | null
}
```
A frequency row that cannot be read ([trip-activity](../behaviors/trip-activity.md#schedule-entries))
is listed with its columns, `activeNow` false and no active instances, and its unreadable values null.
Other `VehiclePosition` fields present in the feed are passed through under their GTFS-RT
names in camelCase so the screen can show "other info as available". Pings include every
retained ping for the trip ID, including pings from vehicles no longer reporting. When the
latest snapshots hold several trip updates for the trip ID (different instances), the
newest by `timestamp` is returned.

## Principles
**Inherited**
- [Show the feed as it is](../principles.md#show-the-feed-as-it-is) — schedule rows
  (trip, route, frequency) are returned column-for-column and realtime fields pass through
  untouched.
- [Retain only what a screen shows](../principles.md#retain-only-what-a-screen-shows) —
  stop-level trip-update data is summarized by a count, not returned.
- [Forget by default](../principles.md#forget-by-default) — no date parameter exists because
  nothing older than the retained window does.
