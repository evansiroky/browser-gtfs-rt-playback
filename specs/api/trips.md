# API: Trips

## List
`GET /api/v1/trips?list=<name>` where `<name>` is `active-with-realtime`,
`active-without-realtime`, or `unscheduled-with-realtime` — the three lists defined in
[trip-activity](../behaviors/trip-activity.md#the-three-lists). Missing or unknown `list`
→ `400 bad_request`. `409 session_not_active` while dormant; `409 schedule_not_ready` until
the schedule has loaded.

The response contains the complete list (no pagination), in the order defined by
trip-activity:

```
list:        string                                  // echo of the parameter
generatedAt: epoch seconds
trips: [{
  tripId:       string
  serviceDate:  "YYYYMMDD"
  routeId:      string | null                        // from trips.txt, else the realtime reference
  routeShortName: string | null                      // from routes.txt; null if route unknown
  routeLongName:  string | null
  headsign:     string | null                        // trips.txt trip_headsign
  scheduledStart: epoch seconds | null               // null when the trip is unknown
  scheduledEnd:   epoch seconds | null
  realtime: {                                        // null for active-without-realtime
    vehicleIds:      string[]                        // distinct, from the latest snapshots
    hasVehiclePosition: boolean
    hasTripUpdate:      boolean
    lastSeenAt:      epoch seconds | null            // newest vehicle timestamp, else feed timestamp
  } | null
  reason: "unknown_trip" | "not_in_service" | "outside_scheduled_time" | null   // list 3 only
}]
```

## Detail
`GET /api/v1/trips/{tripId}?serviceDate=YYYYMMDD` — `tripId` is percent-encoded.
`serviceDate` is optional; when omitted it is inferred as in
[trip-activity](../behaviors/trip-activity.md#definitions) (active, else operating, else
today). `409` statuses as for the list. `404 trip_not_found` when the trip is neither in the
schedule nor present in any retained realtime data.

```
tripId:      string
serviceDate: "YYYYMMDD"
list:        "active-with-realtime" | "active-without-realtime" | "unscheduled-with-realtime" | null
reason:      same enum as above | null              // when list is unscheduled-with-realtime
scheduled: {                                        // null when the trip ID is not in trips.txt
  trip:        { [column: string]: string }         // every column of the trips.txt row, as text
  route:       { [column: string]: string } | null  // every column of the routes.txt row; null if missing
  operatesOnServiceDate: boolean
  start:       epoch seconds                        // for serviceDate
  end:         epoch seconds
  activeNow:   boolean
} | null
realtime: {
  pings: [{                                         // ascending by sequence; retained window only
    sequence:    integer                            // see data-model: ping sequence
    receivedAt:  epoch seconds                      // when the server first received it
    timestamp:   epoch seconds                      // vehicle timestamp (or feed header fallback)
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
    startTime:   string | null
    startDate:   string | null
  }]
  tripUpdate: {                                     // latest snapshot's update for this trip, or null
    feedTimestamp: epoch seconds | null
    timestamp:     epoch seconds | null
    delay:         integer | null                   // seconds
    vehicleId:     string | null
    scheduleRelationship: string | null
    stopTimeUpdateCount:  integer
  } | null
}
```
Other `VehiclePosition` fields present in the feed are passed through under their GTFS-RT
names in camelCase so the screen can show "other info as available". Pings include every
retained ping for the trip key, including pings from vehicles no longer reporting.

## Principles
**Inherited**
- [Show the feed as it is](../principles.md#show-the-feed-as-it-is) — schedule rows are
  returned column-for-column and realtime fields pass through untouched.
- [Retain only what a screen shows](../principles.md#retain-only-what-a-screen-shows) —
  stop-level trip-update data is summarized by a count, not returned.
