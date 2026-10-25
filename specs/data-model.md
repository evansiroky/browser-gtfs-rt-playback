# Data model

The concepts the behaviors, API, and screens share. All of it lives in process memory and is
discarded on dormancy ([behaviors/data-retention.md](behaviors/data-retention.md)).

## Agency
From `agency.txt`: every row's `agency_name`, and the `agency_timezone` (GTFS requires one
timezone across agencies; the first row's value is used). The agency timezone is the clock
for every rule and display ([Agency-local time](principles.md#agency-local-time)).

## Service date
A calendar date in the agency timezone, written `YYYYMMDD`, on which a trip's service is
defined to run. GTFS times are offsets from "noon minus 12 hours" on the service date and
may exceed 24:00:00, so a trip on yesterday's service date can still be running after
midnight today.

## Scheduled trip
A row of `trips.txt` plus the service dates on which its `service_id` operates (from
`calendar.txt` and `calendar_dates.txt`, exceptions applied), plus two derived instants per
service date: **start** (first stop time's departure, or arrival if no departure) and
**end** (last stop time's arrival, or departure if no arrival). The full `trips.txt` row and
its `routes.txt` row are retained as-is (all columns).

## Trip key
A trip is identified by **(trip_id, service date)**.

## Realtime snapshot
One successful fetch of one realtime feed (vehicle positions or trip updates): the decoded
entities, the feed header timestamp, and the time the server received it. Snapshots are
kept in time order per feed. The **latest snapshot** of a feed is its most recent
successful one.

## Trip reference
The `TripDescriptor` carried by a vehicle position or trip update. A reference **has a trip
ID** when `trip_id` is present and non-empty. References without a trip ID are counted in
vehicle statistics but cannot be keyed, listed, or linked.

## Ping
One observation of a vehicle on a trip, taken from a `VehiclePosition` entity. A ping is
identified by (trip key, vehicle ID, vehicle `timestamp`); the same triple seen in later
snapshots is the same ping and is recorded once. When a vehicle position has no `timestamp`,
the snapshot's feed header timestamp stands in for it. When a vehicle position has no vehicle
ID, the entity ID stands in.

Each trip key has a **ping sequence**: integers assigned 1, 2, 3… in order of first receipt
since the activation began. Numbers are never reassigned when old pings expire
([behaviors/data-retention.md](behaviors/data-retention.md)), so a ping keeps the same number
for as long as it is shown.

## Trip classification
Every trip key that is either (a) scheduled and active in the current minute or (b) carried
by a trip reference in a latest snapshot falls into exactly one list; see
[behaviors/trip-activity.md](behaviors/trip-activity.md).
