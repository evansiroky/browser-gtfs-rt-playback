# The fixture scenario and its ground truth

`scenario(now)` builds a schedule and two realtime feeds around an instant, and `expected` says what
the app must report for them. This file explains every case: what rule it exercises, and why the
spec ([trip-activity](../specs/behaviors/trip-activity.md)) puts it where `expected` puts it. If
`expected` and an implementation disagree, decide against the spec, not against either of them.

How `expected` is produced: `src/expected.ts` evaluates the spec's rules over the scenario's own
data, written for clarity rather than speed (it is not the engine, shares no code with it, and
throws if a scenario would hit a case the spec leaves open). The tests in `src/scenario.test.ts`
pin its output for two instants against literals derived by hand from the tables below, and a
second, independent evaluator (written in Python during review) agreed with it field for field at
thousands of instants, including both 2026 daylight-saving changes.

## Conventions

- The agency is `America/Los_Angeles`. `now` is any instant; **m** is the start of its minute.
- "Offsets" below are seconds relative to **m**. Every trip is placed relative to **m** on today's
  service date, so the same cases appear whatever `now` is; times are GTFS offsets from noon minus
  12 h of the service date.
- Worked example, the "canonical" instant: **Wed 2026-10-14 12:07:42 PDT**, so **m = 12:07:00**,
  today = `20261014`, yesterday = `20261013`, tomorrow = `20261015`. The span of a trip is
  `[start, end]`; it is active when `start < m + 60 s` (before 12:08:00) **and** `end >= m` (at or
  after 12:07:00).
- A start before the service day begins is clamped to `00:00:00`, a frequency window's start moves to
  the next point of its headway grid at or after `00:00:00`, windows that become empty and cases that
  would end before the day starts are left out. This only matters in the first two hours of the
  service day (see [After midnight](#after-midnight)).

## Services

| service_id      | calendar.txt                                                    | calendar_dates.txt      | operates yesterday / today          |
| --------------- | --------------------------------------------------------------- | ----------------------- | ----------------------------------- |
| `DAILY`         | all seven weekdays, today-30 d to today+30 d                    | none                    | yes / yes                           |
| `REMOVED_TODAY` | same as `DAILY`                                                 | today: type 2 (removed) | yes / **no**                        |
| `ADDED_TODAY`   | **absent**                                                      | today: type 1 (added)   | no / **yes** (only dates of type 1) |
| `OFFDAY`        | every weekday except today's (Wed) and yesterday's (Tue)        | none                    | no / no                             |
| `NIGHT`         | all seven weekdays, today-30 d to **yesterday** (inclusive end) | none                    | yes / no                            |

## Plain trips

Realtime `VP` is a vehicle position, `TU` a trip update; "no date" means no `start_date`.

| trip_id                      | Service, shape                                             | Span at the canonical instant                                                                                                                   | Realtime                                                                        | Result and why                                                                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain-active-vp-tu`         | `DAILY`, `shape-market`                                    | 11:37-12:37 (-30/+30 min)                                                                                                                       | two VPs (`bus-101`, `bus-102`) and a TU naming vehicle `tu-unit-1`, dated today | **List 1.** Overlaps the minute. A plain entry is matched by trip ID and service date alone. `vehicleIds` is the distinct union over both feeds: `bus-101`, `bus-102`, `tu-unit-1`. `lastSeenAt` is the newest of the two VP timestamps.                                            |
| `plain-active-vp`            | `DAILY`, `shape-vanness`                                   | 11:47-12:47. First stop: arrival 11:45, **departure 11:47**; last stop: **arrival 12:47**, departure 12:49                                      | VP, no date                                                                     | **List 1.** Start is the first departure and end the last arrival. With no date the reference takes the candidate date on which the trip has an active entry: today.                                                                                                                |
| `plain-active-tu`            | `DAILY`, `shape-mission`                                   | 11:57-12:22. First stop has an arrival only, last stop a departure only (**deliberately not conformant GTFS**, to pin the data-model fallbacks) | TU only, vehicle `tu-unit-2`                                                    | **List 1**, `hasTripUpdate` only, `vehicleIds` `["tu-unit-2"]` (a vehicle no VP carries), `lastSeenAt` = the feed timestamp. Start falls back to the arrival, end to the departure.                                                                                                 |
| `plain-active-no-rt`         | `DAILY`, `shape-embarcadero`                               | 11:27-12:12                                                                                                                                     | none                                                                            | **List 2.**                                                                                                                                                                                                                                                                         |
| `plain-active-missing-shape` | `DAILY`, `shape_id` **`shape-gone`** (not in `shapes.txt`) | 12:02-12:57                                                                                                                                     | none                                                                            | **List 2.** The trip is kept and has no geometry.                                                                                                                                                                                                                                   |
| `plain-future`               | `DAILY`, `shape-market`                                    | 13:07-14:07                                                                                                                                     | VP, no date                                                                     | **List 3, `outside_scheduled_time`.** Counted in "scheduled today", not active. No date and no active entry, and the trip operates on both candidate dates: the later wins, so today; today's entry starts after the minute. Span `13:07-14:07`.                                    |
| `plain-past`                 | `DAILY`, `shape-vanness`                                   | 10:27-11:27                                                                                                                                     | VP and TU, dated today                                                          | **List 3, `outside_scheduled_time`**, both flags set. Ended before the minute.                                                                                                                                                                                                      |
| `edge-ends-this-minute`      | `DAILY`                                                    | 11:37-**12:07:00**                                                                                                                              | none                                                                            | **List 2.** `end >= m` includes an end exactly at the start of the minute.                                                                                                                                                                                                          |
| `edge-ended-last-second`     | `DAILY`                                                    | 11:37-**12:06:59**                                                                                                                              | none                                                                            | Not active (end before `m`). Scheduled today only.                                                                                                                                                                                                                                  |
| `edge-starts-this-minute`    | `DAILY`                                                    | **12:07:59**-12:37                                                                                                                              | none                                                                            | **List 2.** `start < m + 60` holds.                                                                                                                                                                                                                                                 |
| `edge-starts-next-minute`    | `DAILY`                                                    | **12:08:00**-12:37                                                                                                                              | none                                                                            | Not active (`start` equals `m + 60`, not before). Scheduled today only.                                                                                                                                                                                                             |
| `plain-ref-yesterday`        | `DAILY`, `shape-mission`                                   | 11:57-12:27 (active)                                                                                                                            | VP dated **yesterday**                                                          | **List 2** (no reference carries today's date) **and list 3, `outside_scheduled_time`**, service date `20261013`, span 11:57-12:27 on the 13th: the reference names yesterday's entry, which is not running.                                                                        |
| `plain-ref-tomorrow`         | `DAILY`, `shape-market`                                    | 12:02-12:32 (active)                                                                                                                            | VP dated **tomorrow**                                                           | **List 2 and list 3, `outside_scheduled_time`**, service date `20261015`, span 12:02-12:32 on the 15th. A date outside the candidate dates is used as sent; the trip operates then (the calendar runs 30 days on).                                                                  |
| `plain-active-added-service` | `ADDED_TODAY`, `shape-market`                              | 11:52-12:32                                                                                                                                     | VP, dated today                                                                 | **List 1.** A service that exists only in `calendar_dates.txt` operates exactly on its type 1 dates.                                                                                                                                                                                |
| `plain-nis-removed-today`    | `REMOVED_TODAY`, `shape-mission`                           | 11:52-12:22 (would be active)                                                                                                                   | VP, dated today                                                                 | **List 3, `not_in_service`.** The type 2 exception removes today. Not counted, not active.                                                                                                                                                                                          |
| `plain-nis-off-weekday`      | `OFFDAY`, `shape-embarcadero`                              | 11:52-12:22 (would be active)                                                                                                                   | VP, no date                                                                     | **List 3, `not_in_service`.** The weekday flag is off. Neither candidate date has an active entry or operates, so the reference's date is today, on which the trip does not operate.                                                                                                |
| `overnight-from-yesterday`   | `NIGHT`, `shape-vanness`                                   | Fixed times `23:30:00` to `25:30:00`                                                                                                            | VP, no date                                                                     | At 12:07: **List 3, `outside_scheduled_time`**, service date **`20261013`**, span Tue 23:30 - Wed 01:30. No active entry; the trip operates only yesterday (inclusive `end_date`), so the reference takes yesterday. Not counted in "scheduled today". At 00:20: see below.         |
| `overnight-daily`            | `DAILY`, `shape-mission`                                   | Fixed times `23:30:00` to `25:30:00`                                                                                                            | VP, no date                                                                     | At 12:07: **List 3, `outside_scheduled_time`**, service date **`20261014`** (it operates on both dates, so the later wins), span Wed 23:30 - Thu 01:30; counted in "scheduled today" once. At 00:20 it is **active on yesterday's date**, found by step 1 of the inference (below). |

## Frequency trips

A frequency trip's `stop_times.txt` rows are only a template: the first stop time is 06:00:00,
08:00:00, 09:00:00, 10:00:00 or 12:00:00 and means nothing but its distance from the last. Instances
are always nominal (`S, S+H, ...` while `< E`), `exact_times` never changes that.

| trip_id                    | Template D                  | Rows (at 12:07)                                                                                                                    | Instances                                                                                                           | Active at 12:07                                                                                                                     |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `freq-exact`               | 20 min, `shape-market`      | one row, `exact_times=1`, H = 10 min, window 11:32:00-13:22:00                                                                     | 11:32, 11:42, ..., 13:12 = **11**. 13:22 is on the headway grid but is the exclusive end: **no instance**           | start in `[m-D, m+60)` = `[11:47, 12:08)`: **11:52** (ends 12:12) and **12:02** (ends 12:22). 11:42 ended 12:02, before the minute. |
| `freq-nominal`             | 30 min, `shape-mission`     | row A: `exact_times=0`, H = 15 min, window 11:17-11:57; row B (adjacent): `exact_times` **absent**, H = 10 min, window 11:57-12:47 | A: 11:17, 11:32, 11:47 (12:02 is past the end); B: 11:57, 12:07, 12:17, 12:27, 12:37 (12:47 = end, excluded); **8** | start in `[11:37, 12:08)`: **11:47** (A), **11:57** (B), **12:07** (B).                                                             |
| `freq-overnight`           | 20 min, `shape-embarcadero` | one row, `exact_times=0`, H = 10 min, window **23:00:00-25:00:00** (crosses midnight)                                              | 23:00, 23:10, ..., 24:50 = **12**                                                                                   | none at 12:07. At 00:20: yesterday's instances 24:00, 24:10, 24:20 (clock 00:00, 00:10, 00:20).                                     |
| `freq-mixed`               | 15 min                      | row 1 `exact_times=1`, row 2 `exact_times` **absent** (= 0)                                                                        | **none** (configuration error)                                                                                      | none                                                                                                                                |
| `freq-mixed-removed-today` | 15 min                      | on `REMOVED_TODAY`: row 1 `exact_times=1`, row 2 absent                                                                            | **none** (configuration error)                                                                                      | none                                                                                                                                |
| `freq-nis`                 | 15 min                      | on `OFFDAY`: one valid row, 06:00-08:00, H = 15 min                                                                                | none (does not operate today)                                                                                       | none                                                                                                                                |

`freq-nominal`'s rows are `0` and absent, which are equal: not an error. The mixed trips' are `1` and
absent (`0`): a **configuration error**, so they have no entries; they are not counted, not active,
not in lists 1 or 2.

| Realtime on a frequency trip                                                                               | Result and why                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freq-exact` VP, start_time `11:52:00`, no date                                                            | **List 1**, instance 11:52-12:12. Date inferred: the trip has an active instance starting at exactly that time today. Start equals the instance start exactly.                                                                                             |
| `freq-exact` TU, start_time `12:02:00`, dated today, no vehicle                                            | **List 1**, instance 12:02-12:22, `hasTripUpdate` only.                                                                                                                                                                                                    |
| `freq-exact` VP, start_time `11:53:30` (the 11:52 instance reporting an actual start 90 s late)            | **List 3, `unmatched_start_time`.** Equals no instance start; never matched loosely. `frequency` is the row whose window contains the start.                                                                                                               |
| `freq-exact` VP, start_time `13:22:00` (the window end)                                                    | **List 3, `unmatched_start_time`**, `frequency` **null**: no instance starts at the exclusive end, and the window `[S, E)` does not contain it.                                                                                                            |
| `freq-exact` VP, start_time `12:12:00`                                                                     | **List 3, `outside_scheduled_time`**, span 12:12-12:32. An instance exists, but starts after the minute. The same trip is in list 1 (two instances) and list 3 (three groups): a frequency trip may be in both.                                            |
| `freq-nominal` VP, start_time `11:47:00` (A), dated today                                                  | **List 1**, instance 11:47-12:17, `frequency` = row A (900 s, `exactTimes` false).                                                                                                                                                                         |
| `freq-nominal` VP, start_time `12:07:00` (B), dated today                                                  | **List 1**, instance 12:07-12:37, `frequency` = row B (600 s). An exact match on a row whose `exact_times` is absent.                                                                                                                                      |
| `freq-nominal` instance 11:57 (B)                                                                          | **List 2**: active, no reference matches it exactly.                                                                                                                                                                                                       |
| `freq-nominal` VP, start_time `11:48:30` (A's 11:47 + 90 s) and `11:58:30` (B's 11:57 + 90 s), dated today | **List 3, `unmatched_start_time`**, two rows, `frequency` = row A (900 s) and row B (600 s). Rows with `exact_times` `0` and absent are matched as exactly as `1`; a reference inside an active instance's span is not matched loosely.                    |
| `freq-nominal` VP and TU, **no** start_time                                                                | **List 3, `missing_start_time`**, one row with both flags set (grouped by trip, and start, which is absent).                                                                                                                                               |
| `freq-overnight` VP, start_time `24:10:00`, no date                                                        | At 12:07: **List 3, `outside_scheduled_time`**, service date today, span 24:10-24:30 (clock 00:10-00:30 on the 15th): step 1 finds no active instance starting then, so the later operating date wins. At 00:20: see below.                                |
| `freq-mixed` VP, start_time `12:07:00`, no date                                                            | **List 3, `configuration_error`**, `frequency` and span null.                                                                                                                                                                                              |
| `freq-mixed-removed-today` VP, dated today                                                                 | **List 3, `configuration_error`**, not `not_in_service`: the trip's service is removed today, but the configuration error is checked first.                                                                                                                |
| `freq-nis` VP, no start_time, and VP start_time `03:33:33`, no date                                        | **List 3, `not_in_service`**, two rows (one per start). The trip is a frequency trip with no start_time on one reference and a start matching no instance on the other, but `not_in_service` comes before `missing_start_time` and `unmatched_start_time`. |

## Realtime without a schedule explanation

| Entity                                                                       | Result and why                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VP `ghost-vp-trip`, dated today, start_time `12:02:00`, `route_id` `R-GHOST` | **List 3, `unknown_trip`**; `routeId` is the reference's (`R-GHOST`, a route that is not in `routes.txt`), the other route fields, `headsign`, the span and `frequency` are null. |
| TU `ghost-tu-trip`, dated today                                              | **List 3, `unknown_trip`**; all route fields null.                                                                                                                                |
| VP with no trip descriptor                                                   | Counted in `vehicles`, not in `vehiclesWithTripId`; in no list.                                                                                                                   |
| VP with a trip descriptor whose `trip_id` is `""` (route_id `R2`)            | Same: a trip ID is "present and non-empty".                                                                                                                                       |

## Ground truth at the canonical instant (12:07:42 PDT)

Counts

- **tripsToday = 46**: plain trips operating today, each once: `plain-active-vp-tu`, `plain-active-vp`,
  `plain-active-tu`, `plain-active-no-rt`, `plain-active-missing-shape`, `plain-future`, `plain-past`
  (7), the four `edge-*` (11), `plain-ref-yesterday`, `plain-ref-tomorrow` (13),
  `plain-active-added-service` (14), `overnight-daily` (15); plus `freq-exact` 11, `freq-nominal` 8 and
  `freq-overnight` 12 = **46**. Not counted: `plain-nis-*` and `freq-nis` (do not operate),
  `overnight-from-yesterday` (operates only yesterday), the two mixed trips (no entries).
- **tripsActiveNow = 15**: list 1 has 8, list 2 has 7.
- **vehicles = 29**, **vehiclesWithTripId = 27** (all but the two without a trip ID), **tripUpdates = 6**
  (`plain-active-vp-tu`, `plain-active-tu`, `plain-past`, `freq-exact` 12:02, `freq-nominal`,
  `ghost-tu-trip`), **activeTripsWithRealtime = 8**.
- Configuration errors: `freq-mixed`, `freq-mixed-removed-today`.

Lists, in the spec's order (by start then trip ID; by reason, then trip ID, then start); list 3 has
21 rows.

1. `plain-active-vp-tu` 11:37; `freq-nominal` 11:47; `plain-active-vp` 11:47; `freq-exact` 11:52;
   `plain-active-added-service` 11:52; `plain-active-tu` 11:57; `freq-exact` 12:02; `freq-nominal` 12:07.
2. `plain-active-no-rt` 11:27; `edge-ends-this-minute` 11:37; `freq-nominal` 11:57;
   `plain-ref-yesterday` 11:57; `plain-active-missing-shape` 12:02; `plain-ref-tomorrow` 12:02;
   `edge-starts-this-minute` 12:07:59.
3. `unknown_trip`: `ghost-tu-trip`, `ghost-vp-trip` / `configuration_error`: `freq-mixed`,
   `freq-mixed-removed-today` / `not_in_service`: `freq-nis` (no start), `freq-nis` (03:33:33),
   `plain-nis-off-weekday`, `plain-nis-removed-today` / `missing_start_time`: `freq-nominal` /
   `unmatched_start_time`: `freq-exact` (11:53:30), `freq-exact` (13:22:00), `freq-nominal`
   (11:48:30), `freq-nominal` (11:58:30) / `outside_scheduled_time`: `freq-exact` (12:12:00),
   `freq-overnight`, `overnight-daily`, `overnight-from-yesterday`, `plain-future`, `plain-past`,
   `plain-ref-tomorrow`, `plain-ref-yesterday`.

## After midnight

`scenario(agencyInstant('20261014', '00:20:00', 'America/Los_Angeles'))` (m = 00:20:00, so 20 minutes
into the service day): yesterday's runs overlap the minute, so they are **active on service date
`20261013`**. Three cases exercise step 1 of the service-date inference ("prefer a candidate date on
which the trip has an active entry"), none of them carrying a `start_date`:

- `overnight-from-yesterday` (operates only yesterday) and `overnight-daily` (operates on both
  days): the VP has no date; yesterday has the active entry, so yesterday it is, and both are in
  **list 1** on `20261013`. Without step 1, `overnight-daily` would take the later operating date,
  today, and be in list 3. `overnight-daily` is also counted in "scheduled today" (today's 23:30 run
  exists); `overnight-from-yesterday` is not.
- `freq-overnight`, VP start_time `24:10:00` (the spec's rule for a frequency trip with a start_time:
  an active instance starting at **exactly** that time): yesterday's instance 24:10 (clock 00:10 today,
  ending 00:30) is active, so the reference is in **list 1** on `20261013`, not
  `outside_scheduled_time`. Yesterday's other active instances, 24:00 and 24:20, are in list 2.

Everything else shifts to fit the 20 minutes of today that exist:

- Active-now plain trips start at `00:00:00` instead of earlier; `plain-past` does not fit and is
  absent (so its VP and TU are absent too).
- `freq-exact` windows begin on the 10-minute grid at 00:05 (instances 00:05, 00:15 are active; the
  late-start reference is 00:06:30; the `outside` instance is 00:25; the window end is 01:35).
  `freq-nominal` row A covers 00:00-00:10 (one instance, 00:00); row B 00:10-01:00 (00:10 and 00:20
  are active); `freq-mixed` anchors at 00:30.
- tripsToday = 41, tripsActiveNow = 20 (list 1: 11, list 2: 9), vehicles 28, vehiclesWithTripId 26,
  tripUpdates 5; list 3 has 17 rows (no `overnight-*`, no `freq-overnight`, no `plain-past`).

The test file pins all three lists. Between 01:30 and 02:00 (the overnight trips over, today's trips
still clamped) is covered by the invariant sweep.

### Daylight-saving days

GTFS times count from noon minus 12 h, which is local midnight except on the two DST days: on
2026-03-08 the service day starts at 23:00 the evening before, on 2026-11-01 at **01:00** (so the
calendar hours 00:00-00:59 of 1 November precede the day's first second: there, `m` is before the
service day and today's `s` is negative; "now" is 24:00-24:59 on yesterday's service day, and the
scenario places nothing active on today's date, only yesterday's overnight runs). The scenario never
throws for any instant; the tests sweep both days and their neighbours every 397 s.

At **midday** the lists on those two days read the same on the wall clock as on an ordinary day. Near
the start of the service day they do not, because the clamping works in service-day seconds and that
day starts at a different wall-clock time.

## What `expected` pins, and what it leaves open

Pinned (and therefore safe to assert):

- everything in the lists above, including `lastSeenAt` (the newest vehicle position timestamp among
  the row's references, else the feed header timestamp, as of the instant the scenario was built;
  both feeds carry the same header timestamp), a TU-only vehicle ID, several vehicle IDs on one trip
  ID, `routeId` of an unknown trip taken from the reference, and `scheduledSpan` / `frequency` being
  null for unknown trips and for configuration errors (`api/trips.md`);
- `vehicleIds` is the distinct union over both feeds; its order is not specified (sorted here), compare
  as a set.

Left open by the spec, so not pinned (`scheduledSpan` is absent for these list 3 rows):

- `scheduledStart` / `scheduledEnd` of list 3 rows with the reasons `not_in_service`,
  `missing_start_time` and `unmatched_start_time`;
- vehicle IDs and entity IDs: they are assigned in creation order and shift when a case is left out.

`expected` describes the instant the scenario was built for. After `advance(seconds)` the references
stay, but the timestamps (and so `lastSeenAt`), and what is active, move on.
