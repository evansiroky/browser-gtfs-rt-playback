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
midnight today. A service date is always **derived** by the app
([behaviors/trip-activity.md](behaviors/trip-activity.md)); no API accepts one.

## Scheduled trip
A row of `trips.txt` plus the service dates on which its `service_id` operates (from
`calendar.txt` and `calendar_dates.txt`, exceptions applied), plus two derived instants per
service date: **start** (first stop time's departure, or arrival if no departure) and
**end** (last stop time's arrival, or departure if no arrival; a trip for which either does not
exist is a configuration error, [trip-activity](behaviors/trip-activity.md#schedule-entries)). The
full `trips.txt` row and
its `routes.txt` row are retained as-is (all columns), as are the trip's `frequencies.txt`
rows. A trip's `shape_id` links to its shape.

For a trip with `frequencies.txt` rows, the start/end derived from `stop_times.txt` are a
*template* (only their difference, the duration, is used), not instants on a service date.

## Schedule entry
The unit the dashboard counts and lists: one per plain trip, and one per frequency instance
(a nominal departure of a `frequencies.txt` row). A frequency trip with the mixed-`exact_times`
configuration error has none. Defined in
[behaviors/trip-activity.md](behaviors/trip-activity.md#schedule-entries).

## Shape
From `shapes.txt`: for each `shape_id`, the points ordered by `shape_pt_sequence`, held
**only as one encoded polyline** — the Google encoded polyline algorithm at precision 6
(six decimal places, about 0.1 m). The raw coordinates are not retained after encoding, and the
encoded string is exactly what the API sends. Other `shapes.txt` columns are not retained.

## Trip identity
Everywhere the user sees, a trip is identified by its **trip ID** alone. Because the app
holds at most one hour of realtime history, one trip ID refers to one service date at a
time; the date, and for frequency trips the instance start, are attributes the app derives
or reads from the feed, not part of the identity.

## Realtime snapshot
One successful fetch of one realtime feed (vehicle positions or trip updates): the decoded
entities, the feed header timestamp, and the time the server received it. Snapshots are
kept in time order per feed. The **latest snapshot** of a feed is its most recent
successful one.

## Trip reference
The `TripDescriptor` carried by a vehicle position or trip update. A reference **has a trip
ID** when `trip_id` is present and non-empty. References without a trip ID are counted in
vehicle statistics but cannot be listed or linked.

## Ping
One observation of a vehicle on a trip, taken from a `VehiclePosition` entity. A ping is
identified by (trip ID, vehicle ID, vehicle `timestamp`); the same triple seen in later
snapshots is the same ping and is recorded once. When a vehicle position has no `timestamp`,
the snapshot's feed header timestamp stands in for it. When a vehicle position has no vehicle
ID, the entity ID stands in. A ping keeps the `start_date` and `start_time` of its trip
reference, so pings of different frequency instances or vehicles on the same trip ID stay
distinguishable.

Each trip ID has a **ping sequence**: integers assigned 1, 2, 3… in order of first receipt
since the activation began. Numbers are never reassigned when old pings expire
([behaviors/data-retention.md](behaviors/data-retention.md)), so a ping keeps the same number
for as long as it is shown.

## Trip classification
Every schedule entry that is active in the current minute, and every realtime trip
reference in a latest snapshot, is placed in the lists defined in
[behaviors/trip-activity.md](behaviors/trip-activity.md#the-three-lists).
