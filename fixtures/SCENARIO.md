# The fixture scenario and its ground truth

`scenario(now)` builds a schedule and two realtime feeds around an instant, and `expected` says what
the app must report for them. This file explains every case: what rule it exercises, and why the
spec ([trip-activity](../specs/behaviors/trip-activity.md)) puts it where `expected` puts it. If
`expected` and an implementation disagree, decide against the spec, not against either of them.

How `expected` is produced: `src/expected.ts` evaluates the spec's rules over the scenario's own
data, written for clarity rather than speed (it is not the engine, shares no code with it, and
throws if a scenario would hit a case the spec leaves open). The tests in `src/scenario.test.ts`
pin its output for two instants against literals derived by hand from the tables below.

## Conventions

- The agency is `America/Los_Angeles`. `now` is any instant; **m** is the start of its minute.
- "Offsets" below are seconds relative to **m**. Every trip is placed relative to **m** on today's
  service date, so the same cases appear whatever `now` is; times are GTFS offsets from noon minus
  12 h of the service date.
- Worked example, the "canonical" instant: **Wed 2026-10-14 12:07:42 PDT**, so **m = 12:07:00**,
  today = `20261014`, yesterday = `20261013`. The span of a trip is `[start, end]`; it is active when
  `start < m + 60 s` (before 12:08:00) **and** `end >= m` (at or after 12:07:00).
- A start before the service day begins is clamped to `00:00:00`, a frequency window's start moves to
  the next point of its headway grid at or after `00:00:00`, and cases that would end before the day
  starts are left out. This only matters in the first two hours of the service day (see
  [After midnight](#after-midnight)).

## Services

| service_id      | calendar.txt                                                    | calendar_dates.txt      | operates yesterday / today          |
| --------------- | --------------------------------------------------------------- | ----------------------- | ----------------------------------- |
| `DAILY`         | all seven weekdays, today-30 d to today+30 d                    | none                    | yes / yes                           |
| `REMOVED_TODAY` | same as `DAILY`                                                 | today: type 2 (removed) | yes / **no**                        |
| `ADDED_TODAY`   | **absent**                                                      | today: type 1 (added)   | no / **yes** (only dates of type 1) |
| `OFFDAY`        | every weekday except today's (Wed) and yesterday's (Tue)        | none                    | no / no                             |
| `NIGHT`         | all seven weekdays, today-30 d to **yesterday** (inclusive end) | none                    | yes / no                            |

## Plain trips

| trip_id                      | Service, shape                                             | Span at the canonical instant                                                                              | Realtime                      | Result and why                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain-active-vp-tu`         | `DAILY`, `shape-market`                                    | 11:37-12:37 (-30/+30 min)                                                                                  | VP and TU, `start_date` today | **List 1.** Overlaps the minute. A plain entry is matched by trip ID and service date alone.                                                                                                                                                                                                            |
| `plain-active-vp`            | `DAILY`, `shape-vanness`                                   | 11:47-12:47. First stop: arrival 11:45, **departure 11:47**; last stop: **arrival 12:47**, departure 12:49 | VP, no `start_date`           | **List 1.** Start is the first departure and end the last arrival. With no date the reference takes the candidate date on which the trip has an active entry: today.                                                                                                                                    |
| `plain-active-tu`            | `DAILY`, `shape-mission`                                   | 11:57-12:22. First stop has an arrival only, last stop a departure only                                    | TU only, no vehicle           | **List 1**, `vehicleIds` empty, `hasTripUpdate` only. Start falls back to the arrival, end to the departure.                                                                                                                                                                                            |
| `plain-active-no-rt`         | `DAILY`, `shape-embarcadero`                               | 11:27-12:12                                                                                                | none                          | **List 2.**                                                                                                                                                                                                                                                                                             |
| `plain-active-missing-shape` | `DAILY`, `shape_id` **`shape-gone`** (not in `shapes.txt`) | 12:02-12:57                                                                                                | none                          | **List 2.** The trip is kept and has no geometry.                                                                                                                                                                                                                                                       |
| `plain-future`               | `DAILY`, `shape-market`                                    | 13:07-14:07                                                                                                | VP, no `start_date`           | **List 3, `outside_scheduled_time`.** Counted in "scheduled today", not active. No date and no active entry, and the trip operates on both candidate dates: the later wins (the spec edit made with this fixture), so today; today's entry starts after the minute. Span `13:07-14:07`.                 |
| `plain-past`                 | `DAILY`, `shape-vanness`                                   | 10:27-11:27                                                                                                | VP and TU, `start_date` today | **List 3, `outside_scheduled_time`**, both flags set. Ended before the minute.                                                                                                                                                                                                                          |
| `edge-ends-this-minute`      | `DAILY`                                                    | 11:37-**12:07:00**                                                                                         | none                          | **List 2.** `end >= m` includes an end exactly at the start of the minute.                                                                                                                                                                                                                              |
| `edge-ended-last-second`     | `DAILY`                                                    | 11:37-**12:06:59**                                                                                         | none                          | Not active (end before `m`). Scheduled today only.                                                                                                                                                                                                                                                      |
| `edge-starts-this-minute`    | `DAILY`                                                    | **12:07:59**-12:37                                                                                         | none                          | **List 2.** `start < m + 60` holds.                                                                                                                                                                                                                                                                     |
| `edge-starts-next-minute`    | `DAILY`                                                    | **12:08:00**-12:37                                                                                         | none                          | Not active (`start` equals `m + 60`, not before). Scheduled today only.                                                                                                                                                                                                                                 |
| `plain-active-added-service` | `ADDED_TODAY`, `shape-market`                              | 11:52-12:32                                                                                                | VP, `start_date` today        | **List 1.** A service that exists only in `calendar_dates.txt` operates exactly on its type 1 dates.                                                                                                                                                                                                    |
| `plain-nis-removed-today`    | `REMOVED_TODAY`, `shape-mission`                           | 11:52-12:22 (would be active)                                                                              | VP, `start_date` today        | **List 3, `not_in_service`.** The type 2 exception removes today. Not counted, not active.                                                                                                                                                                                                              |
| `plain-nis-off-weekday`      | `OFFDAY`, `shape-embarcadero`                              | 11:52-12:22 (would be active)                                                                              | VP, no `start_date`           | **List 3, `not_in_service`.** The weekday flag is off. Neither candidate date has an active entry or operates, so the reference's date is today, on which the trip does not operate.                                                                                                                    |
| `overnight-from-yesterday`   | `NIGHT`, `shape-vanness`                                   | Fixed times `23:30:00` to `25:30:00`                                                                       | VP, no `start_date`           | At 12:07: **List 3, `outside_scheduled_time`**, service date **`20261013`**, span Tue 23:30 - Wed 01:30. No active entry; the trip operates only yesterday (inclusive `end_date`), so the reference takes yesterday. Not counted in "scheduled today" (it does not operate today). At 00:20: see below. |

## Frequency trips

A frequency trip's `stop_times.txt` rows are only a template: the first stop time is 06:00:00 or
12:00:00 or 09:00:00 and means nothing but its distance from the last. Instances are always nominal
(`S, S+H, ...` while `< E`), `exact_times` never changes that.

| trip_id        | Template D                                          | Rows (at 12:07)                                                                                                         | Instances                                                                                              | Active at 12:07                                                                                                                     |
| -------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `freq-exact`   | 20 min (`06:00:00`-`06:20:00`), `shape-market`      | one row, `exact_times=1`, H = 10 min, window 11:32:00-13:22:00                                                          | 11:32, 11:42, ..., 13:12 = **11** (13:22 is the exclusive end)                                         | start in `[m-D, m+60)` = `[11:47, 12:08)`: **11:52** (ends 12:12) and **12:02** (ends 12:22). 11:42 ended 12:02, before the minute. |
| `freq-nominal` | 30 min (`12:00:00`-`12:30:00`), `shape-mission`     | row A: `exact_times=0`, H = 15 min, window 11:17-12:17; row B: `exact_times` **absent**, H = 10 min, window 12:27-12:57 | A: 11:17, 11:32, 11:47, 12:02 (12:17 excluded) = 4; B: 12:27, 12:37, 12:47 (12:57 excluded) = 3; **7** | start in `[11:37, 12:08)`: **11:47** and **12:02**.                                                                                 |
| `freq-mixed`   | 15 min (`09:00:00`-`09:15:00`), `shape-embarcadero` | row 1 `exact_times=1`, H = 5 min; row 2 `exact_times` **absent** (= 0)                                                  | **none**                                                                                               | none                                                                                                                                |

`freq-nominal`'s rows are `0` and absent, which are equal: not an error. `freq-mixed`'s are `1` and
absent (`0`): a **configuration error**, so it has no entries; it is not counted, not active, not in
lists 1 or 2.

| Realtime on a frequency trip                                                                    | Result and why                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freq-exact` VP, start_time `11:52:00`, no `start_date`                                         | **List 1**, instance 11:52-12:12. Date inferred: the trip has an active entry today. Start equals the instance start exactly.                                                                                 |
| `freq-exact` TU, start_time `12:02:00`, `start_date` today, no vehicle                          | **List 1**, instance 12:02-12:22, `hasTripUpdate` only.                                                                                                                                                       |
| `freq-exact` VP, start_time `11:53:30` (the 11:52 instance reporting an actual start 90 s late) | **List 3, `unmatched_start_time`.** Equals no instance start; never matched loosely. `frequency` is the row whose window contains the start.                                                                  |
| `freq-exact` VP, start_time `12:12:00`                                                          | **List 3, `outside_scheduled_time`**, span 12:12-12:32. An instance exists, but starts after the minute. The same trip is in list 1 (two instances) and list 3 (two groups): a frequency trip may be in both. |
| `freq-nominal` VP, start_time `11:47:00`, `start_date` today                                    | **List 1**, instance 11:47-12:17, `frequency` = row A (900 s, `exactTimes` false).                                                                                                                            |
| `freq-nominal` instance 12:02                                                                   | **List 2**: active, no reference matches it.                                                                                                                                                                  |
| `freq-nominal` VP and TU, **no** start_time                                                     | **List 3, `missing_start_time`**, one row with both flags set (grouped by trip, and start, which is absent).                                                                                                  |
| `freq-mixed` VP, start_time `12:07:00`                                                          | **List 3, `configuration_error`**, `frequency` null. Beats every later reason.                                                                                                                                |

## Realtime without a schedule explanation

| Entity                                                            | Result and why                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| VP `ghost-vp-trip`, `start_date` today, start_time `12:02:00`     | **List 3, `unknown_trip`**, route fields null.                  |
| TU `ghost-tu-trip`, `start_date` today                            | **List 3, `unknown_trip`**.                                     |
| VP with no trip descriptor                                        | Counted in `vehicles`, not in `vehiclesWithTripId`; in no list. |
| VP with a trip descriptor whose `trip_id` is `""` (route_id `R2`) | Same: a trip ID is "present and non-empty".                     |

## Ground truth at the canonical instant (12:07:42 PDT)

Counts

- **tripsToday = 30**: plain trips operating today and each counted once: `plain-active-vp-tu`,
  `plain-active-vp`, `plain-active-tu`, `plain-active-no-rt`, `plain-active-missing-shape`,
  `plain-future`, `plain-past`, the four `edge-*`, `plain-active-added-service` = 12; plus
  `freq-exact` 11 and `freq-nominal` 7 = **30**. Not counted: `plain-nis-*` (do not operate),
  `overnight-from-yesterday` (operates only yesterday), `freq-mixed` (no entries).
- **tripsActiveNow = 12**: list 1 has 7, list 2 has 5.
- **vehicles = 17**, **vehiclesWithTripId = 15** (all but the two without a trip ID), **tripUpdates =
  6** (`plain-active-vp-tu`, `plain-active-tu`, `plain-past`, `freq-exact` 12:02, `freq-nominal`,
  `ghost-tu-trip`), **activeTripsWithRealtime = 7**.

Lists, in the spec's order (by start then trip ID; reason, then trip ID, then start)

1. `plain-active-vp-tu` 11:37; `freq-nominal` 11:47; `plain-active-vp` 11:47; `freq-exact` 11:52;
   `plain-active-added-service` 11:52; `plain-active-tu` 11:57; `freq-exact` 12:02.
2. `plain-active-no-rt` 11:27; `edge-ends-this-minute` 11:37; `freq-nominal` 12:02;
   `plain-active-missing-shape` 12:02; `edge-starts-this-minute` 12:07:59.
3. `unknown_trip`: `ghost-tu-trip`, `ghost-vp-trip` / `configuration_error`: `freq-mixed` /
   `not_in_service`: `plain-nis-off-weekday`, `plain-nis-removed-today` / `missing_start_time`:
   `freq-nominal` / `unmatched_start_time`: `freq-exact` (11:53:30) / `outside_scheduled_time`:
   `freq-exact` (12:12:00), `overnight-from-yesterday`, `plain-future`, `plain-past`.

Configuration errors: `freq-mixed` (`mixed_exact_times`).

## After midnight

`scenario(agencyInstant('20261014', '00:20:00', 'America/Los_Angeles'))` (m = 00:20:00, so 20 minutes
into the service day): yesterday's `overnight-from-yesterday` (Tue 23:30 - Wed 01:30) overlaps the
minute, so it is **active on service date `20261013`** and, having a VP with no `start_date`, in
**list 1** (the reference infers yesterday, the date with an active entry). It is not in "scheduled
today". Everything else shifts to fit the 20 minutes of today that exist:

- Active-now plain trips start at `00:00:00` instead of earlier; `plain-past` does not fit and is
  absent (so its VP and TU are absent too: vehicles 16, trip updates 5).
- `freq-exact` windows begin on the 10-minute grid at 00:05 (instances 00:05, 00:15 are active;
  `unmatched` start is 00:06:30; the `outside` instance is 00:25). `freq-nominal` row A starts at
  00:00 (instances 00:00, 00:15 active), `freq-mixed` row 1 starts at 00:00.
- tripsToday = 25, tripsActiveNow = 13 (list 1: 8, list 2: 5), list 3 has 9 rows (no
  `overnight-from-yesterday`, no `plain-past`).

The test file pins both lists in full. Between 01:30 and 02:00 (the overnight trip over, today's
trips still clamped) is covered by the invariant sweep. Daylight-saving days work because every
offset is from noon minus 12 h: on 2026-03-08 and 2026-11-01 the lists read the same on the wall
clock as on an ordinary day.

## What `expected` does not pin

The spec leaves these open; do not assert on them from this scenario:

- the order of `realtime.vehicleIds` (sorted here); a trip update's vehicle ID appears only where a
  vehicle position of the same trip carries the same ID, so whether trip updates contribute is moot;
- `lastSeenAt`, and `scheduledStart` / `scheduledEnd` of list 3 rows other than
  `outside_scheduled_time` (`scheduledSpan` is present only for those);
- vehicle IDs and entity IDs: they are assigned in creation order and shift when a case is left out.

## Spec amendment made for this fixture

"Realtime trip references" said an unspecified-date reference takes "one on which the trip
operates", which has two answers for a daily trip. It now says the later date wins, the same
tie-break the entry service date already used. `plain-future` is the case that needed it.
