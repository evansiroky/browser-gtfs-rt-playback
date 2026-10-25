# Behavior: Trip activity and classification

## Rule
Every figure and list on the dashboard derives from the same definitions of "scheduled
today", "active this minute", "has realtime data", and the three trip lists. They are
recomputed on every request from the retained schedule, the latest snapshots, and the
server clock; nothing is cached across requests.

All dates and times here are in the agency timezone
([Agency-local time](../principles.md#agency-local-time)).

The app only ever shows what is happening now and what happened in the retained window
(at most the last hour, [data-retention](data-retention.md)). Nothing in the API accepts a
date: the service date of a trip is always derived by the rules below, never supplied.

## Definitions

**Today** — the current calendar date in the agency timezone. **Candidate service dates**
are today and yesterday (a trip on yesterday's service date may run past midnight).

**Operates on a service date** — the trip's `service_id` is in service on that date:
`calendar.txt` weekday flag within `start_date`..`end_date` (inclusive), then
`calendar_dates.txt` exceptions applied (type 1 adds, type 2 removes). A `service_id` that
appears only in `calendar_dates.txt` is in service exactly on its type 1 dates.

**Overlaps the current minute** — with *m* the start of the current minute, a span
[*start*, *end*] overlaps it when *start* is before *m* + 60 s **and** *end* is at or after *m*.

## Schedule entries
A **schedule entry** is the unit that the lists, counts, and statistics count. Which entries
a trip produces on a service date depends on `frequencies.txt`:

**Plain trip** (no rows in `frequencies.txt`) — one entry whose span is the trip's start to
end ([data-model](../data-model.md#scheduled-trip)).

**Frequency trip** (one or more rows in `frequencies.txt`) — its `stop_times.txt` rows are a
*template*: only their relative offsets matter. The template's **duration** *D* is the last
stop time minus the first. Each frequency row has a window [*S*, *E*) (`start_time`,
`end_time`) and a `headway_secs` *H*. Departures are **always assumed nominal**: the trip
produces one entry per **instance**, with instance starts *S*, *S* + *H*, *S* + 2*H*, … while
the start is before *E*, for every row, and an instance's span is [start, start + *D*]. The
row's `exact_times` value is shown to the user as sent but does not change this
interpretation: headway-based service is treated as if it ran exactly on the headway. An
instance is identified by its trip ID and start.

**Configuration error: mixed `exact_times`** — a trip whose `frequencies.txt` rows do not all
have the same `exact_times` (an absent value counts as `0`) is a **configuration error** in
the schedule. Such a trip produces **no schedule entries**: it is not counted, not active, and
not listed in lists 1 or 2. The error is reported to the user
([api/dashboard.md](../api/dashboard.md), [api/trips.md](../api/trips.md#detail),
[screens](../screens/dashboard.md)), and realtime references to the trip are listed in list 3
with the reason `configuration_error`. The trip's schedule rows are still shown as they are in
the feed ([Show the feed as it is](../principles.md#show-the-feed-as-it-is)).

An entry has a **service date** (the candidate service date on which the trip operates and
the entry's span overlaps the current minute; the later one if both; else today's if it
operates today, else yesterday's).

## Counts
**Scheduled today** — entries produced on today's service date by trips that operate on it
(every plain trip once; every frequency instance individually). The dashboard's "trips
scheduled today" is the count of those entries. (Entries that only run past midnight from
yesterday's service date are not counted as scheduled today.)

**Active this minute** — an entry whose span overlaps the current minute on a candidate
service date on which its trip operates. The dashboard's "trips active this minute" is the
count of active entries.

## Realtime trip references
A **realtime trip reference** is a trip reference with a trip ID
([data-model](../data-model.md#trip-reference)) in the **latest snapshot** of the vehicle
positions feed or the trip updates feed. Its **service date** is its `start_date` when
present; otherwise it is inferred: prefer a candidate service date on which the trip has an
active entry, then one on which the trip operates, else today. Its **start** is its
`start_time` interpreted on that service date, when present.

A reference **matches** an entry when it has the same trip ID, the same service date, and:

- for a plain entry — nothing more;
- for a frequency instance — its start equals the instance's start exactly. (A feed that
  reports the actual start of a headway-based trip rather than the nominal one will not match;
  it is shown with the reason `unmatched_start_time` instead of being matched loosely.)

An entry **has realtime data** when at least one reference matches it.

## The three lists
Lists 1 and 2 hold active entries; list 3 holds references.

1. **Active with realtime** — active entries that have realtime data.
2. **Active without realtime** — active entries that do not.
3. **Unscheduled with realtime** — realtime trip references that match **no active entry**.
   References are grouped by trip ID, and additionally by start for frequency trips, so each
   row stands for one trip (or instance) as the feed describes it. Each carries a **reason**,
   the first that applies:
   - `unknown_trip` — the trip ID does not exist in `trips.txt`;
   - `configuration_error` — the trip has the mixed-`exact_times` configuration error;
   - `not_in_service` — the trip exists but does not operate on the reference's service date;
   - `missing_start_time` — the trip is a frequency trip and the reference has no
     `start_time`, so no instance can be identified;
   - `unmatched_start_time` — the trip is a frequency trip and the reference's start equals no
     instance start of the trip on that service date;
   - `outside_scheduled_time` — the trip operates that day but the entry matching the
     reference (the plain trip, or the instance whose start the reference names) does not
     overlap the current minute — it is running before its start or after its end.

A frequency trip can therefore appear in lists 1 or 2 (for its active instances) and in
list 3 (for references matching no active instance) at once.

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
Lists 1 and 2: by start (earliest first), then trip ID. List 3: by reason in the order listed
above, then trip ID, then start.

## Principles
**Inherited**
- [Show the feed as it is](../principles.md#show-the-feed-as-it-is) — odd realtime trips
  (unknown, missing a start time, out of window) and a misconfigured schedule are labeled with
  a reason, never discarded or force-matched.
- [Agency-local time](../principles.md#agency-local-time) — "today" and "this minute" are
  agency-local, including across midnight and DST changes.

**Local**
- **Nominal departures over guessing.** Where the schedule does not pin down when a vehicle
  leaves (headway-based frequencies), assume it leaves on the headway rather than inventing a
  fuzzy matching rule. Simple and predictable beats clever; mismatches are reported, not
  hidden.
