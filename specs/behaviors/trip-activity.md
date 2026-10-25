# Behavior: Trip activity and classification

## Rule
Every figure and list on the dashboard derives from the same definitions of "scheduled
today", "active this minute", "has realtime data", and the three trip lists. They are
recomputed on every request from the retained schedule, the latest snapshots, and the
server clock; nothing is cached across requests.

All dates and times here are in the agency timezone
([Agency-local time](../principles.md#agency-local-time)).

## Definitions

**Today** — the current calendar date in the agency timezone. **Candidate service dates**
are today and yesterday (a trip on yesterday's service date may run past midnight).

**Operates on a service date** — the trip's `service_id` is in service on that date:
`calendar.txt` weekday flag within `start_date`..`end_date` (inclusive), then
`calendar_dates.txt` exceptions applied (type 1 adds, type 2 removes). A `service_id` that
appears only in `calendar_dates.txt` is in service exactly on its type 1 dates.

**Scheduled today** — a trip that operates on today's service date. The dashboard figure
"trips scheduled today" is the count of such trips. (Trips that only run past midnight from
yesterday's service date are not counted as scheduled today.)

**Active this minute** — for a candidate service date on which the trip operates, with
*m* the start of the current minute: the trip's start for that service date is before
*m* + 60 s **and** its end is at or after *m*. A trip is active this minute if that holds on
at least one candidate service date; the service date on which it holds is the trip's
**active service date** (if it holds on both, the later one). The dashboard figure "trips
active this minute" is the count of such trips.

**Realtime trip reference** — a trip reference with a trip ID
([data-model](../data-model.md#trip-reference)) in the **latest snapshot** of the vehicle
positions feed or the trip updates feed. Its **service date** is its `start_date` when
present; otherwise it is inferred: prefer a candidate service date on which the trip is
active this minute, then one on which it operates, else today.

**Has realtime data** — a trip key matches a realtime trip reference (same trip ID and same
service date).

## The three lists
Every trip key that is active this minute, or has a realtime trip reference, belongs to
exactly one list:

1. **Active with realtime** — active this minute (on its active service date) **and** has
   realtime data.
2. **Active without realtime** — active this minute and does **not** have realtime data.
3. **Unscheduled with realtime** — has realtime data but is not in list 1. Each entry
   carries a **reason**:
   - `unknown_trip` — the trip ID does not exist in `trips.txt`;
   - `not_in_service` — the trip exists but does not operate on the reference's service date;
   - `outside_scheduled_time` — the trip operates that day but is not active this minute
     (running before its start or after its end).

Trip references without a trip ID appear in no list; they are visible only through the
"vehicles" statistic ([Show the feed as it is](../principles.md#show-the-feed-as-it-is):
they are counted, not hidden, just not linkable).

## Statistics
| Statistic | Definition |
|---|---|
| Trips scheduled today | count defined above |
| Trips active this minute | count defined above (= size of list 1 + list 2) |
| Vehicles | entities carrying a vehicle position in the latest vehicle positions snapshot |
| Vehicles with trip IDs | those whose trip reference has a trip ID |
| Trip updates | entities carrying a trip update in the latest trip updates snapshot |
| Active trips with realtime data | size of list 1 |

A statistic that depends on an unconfigured feed, a feed with no successful snapshot yet,
or a schedule that is not ready is unavailable (null) rather than zero.

## Ordering
Lists 1 and 2: by scheduled start (earliest first), then trip ID. List 3: by reason
(`unknown_trip`, `not_in_service`, `outside_scheduled_time`), then trip ID.

## Principles
**Inherited**
- [Show the feed as it is](../principles.md#show-the-feed-as-it-is) — odd realtime trips are
  classified with a reason, never discarded.
- [Agency-local time](../principles.md#agency-local-time) — "today" and "this minute" are
  agency-local, including across midnight and DST changes.
