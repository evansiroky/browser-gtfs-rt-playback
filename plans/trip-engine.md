---
status: done
pr: 3
depends: [schedule-loader]
specs:
  - specs/behaviors/trip-activity.md
  - specs/data-model.md
  - specs/behaviors/data-retention.md
issues: []
---

# Plan: Trip engine

## Scope
In: the pure logic that turns the retained schedule + latest realtime snapshots + a clock into
schedule entries, activity, realtime matching, the three lists, statistics, and the derived
trip detail; plus the **ping store** (extraction from vehicle-position snapshots, dedupe,
per-trip sequence numbers, retention). No HTTP.

Out: the HTTP endpoints that expose it ([`trips-api`](trips-api.md)).

## Implements
`behaviors/trip-activity.md` in full:
- Today / candidate service dates / operates-on, in the agency timezone (incl. across midnight
  and DST: service-day base is "noon minus 12 h" in the agency zone).
- Schedule entries: plain trips; frequency trips as **nominal instances** `S, S+H, …` per row,
  span `[start, start+D]` regardless of `exact_times`; mixed-`exact_times` trips produce **no
  entries** and are reported as configuration errors.
- Counts (scheduled today, active this minute), realtime trip references and service-date
  inference, matching (plain: trip + service date; instance: also exact start), "has realtime
  data", lists 1/2/3 with all five reasons in the specified precedence, grouping of list-3 rows,
  statistics, null-vs-zero rules, ordering.
`data-model.md`: Trip reference, Ping (identity, fallbacks for missing timestamp/vehicle ID,
per-trip-ID ping sequence that never renumbers), Trip identity.
`behaviors/data-retention.md`: pings expire with the snapshot window and with memory-limit
eviction (`historyStartsAt`), and are forgotten on dormancy.

## Approach
`server/src/trips/`:
1. `time.ts`: service-date arithmetic with `Intl.DateTimeFormat` for the agency zone; helper to
   get the absolute instant of `noon-12h` for a service date; `hms` offsets → epoch seconds.
2. `entries.ts`: given store + service date → entries (plain/instance) with spans; efficient
   active lookup for tens of thousands of trips (pre-index by start/end offsets; do not scan every
   trip every request without an index).
3. `references.ts`: extract refs from the latest VP/TU snapshots (trip id, start_date,
   start_time, vehicle id, route/direction, relationship, timestamps), service-date inference
   (step 1 uses the reference's `start_time` to pick the instance for frequency trips; ties go to
   the later date, per trip-activity.md).
4. `classify.ts`: matching and the lists/stats/reasons exactly as written.
5. `pings.ts`: `PingStore` subscribed to `SnapshotStore.onSnapshot/onEvict`; identity
   `(tripId, vehicleId, timestamp)`; fallbacks; sequence counters per trip ID that survive
   expiry within an activation; pass-through of all VehiclePosition fields; query by trip ID.
6. `detail.ts`: assembles what `GET /trips/{tripId}` returns (classification entries, scheduled
   block incl. frequency rows and active instance starts, pings, latest trip update, derived
   service date).
7. Tests with injectable clock and the [`test-fixtures`](test-fixtures.md) scenario's `expected`
   ground truth, plus focused unit tests for every rule and edge: yesterday's overnight trip,
   DST transition days, exact instance matching/mismatch/missing start_time, mixed
   configuration error (excluded + `configuration_error` reason), unknown/not-in-service/outside
   window, vehicle without trip id (counted, unlisted), null-vs-zero stats, ordering.
8. Pin route-name lookup for unknown trips: add to the [`test-fixtures`](test-fixtures.md)
   scenario (and its `expected`/oracle) an unknown-trip reference whose `route_id` DOES exist in
   `routes.txt`, expecting `routeShortName`/`routeLongName` looked up from it (the existing
   ghost trip uses a route that is not in `routes.txt`, expecting null names). The oracle's
   independent reviewer flagged that this case is currently unpinned.
9. Pin the `unusable_stop_times` configuration error (spec: trip-activity.md "Configuration
   errors"): add to the [`test-fixtures`](test-fixtures.md) scenario (and `expected`/oracle) a
   trip with no stop_times rows and a trip whose last stop has neither time, each producing no
   entries, listed in `configurationErrors`, and (when referenced) in list 3 as
   `configuration_error`; the independent oracle reviewer re-verifies the fixtures afterwards.
10. Performance test: 100k-trip synthetic schedule — lists computed in a few hundred ms.

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` pass.
- [x] The fixture scenario's `expected` matches engine output exactly (counts, list membership,
      reasons, order, configuration errors) at several `now` values, including just after
      midnight (yesterday's service date) and a DST-change day.
- [x] Every sentence-level rule in `trip-activity.md` has at least one test that fails if the rule is removed.
- [x] Ping store: dedupe by triple; timestamp and vehicle-ID fallbacks; sequence numbers stable
      after expiry and eviction; pings across frequency instances/vehicles on one trip ID stay distinct;
      all vehicle fields pass through; forgotten at dormancy.
- [x] Performance: 100k trips, p95 list computation under 300 ms on this machine (record number in Notes).
- [x] No cached derived state across requests (recomputed from store + clock each time).

## Risks / unknowns
- **Time arithmetic** — DST and >24:00 times are the likeliest source of silent bugs; test them
  explicitly and cross-check one case by hand in Notes.
- **Spec ambiguity** — if a case is unspecified, amend the spec first (`docs(specs):` commit)
  rather than choosing silently.

## Notes
- **Layout** (`server/src/trips/`): `time.ts` (agency date, `addDays`, `isServiceDate`, `serviceDayStart`),
  `entries.ts` (`ScheduleIndex`, `Frame`, entries, `activeEntries`, `countActive`, `scheduledToday`,
  `entryOn`, `scheduledBounds`), `references.ts` (references of a decoded snapshot, `optionalNumber`),
  `classify.ts` (service-date inference, matching, the three lists, the counts, grouping, reasons, API
  rows), `pings.ts` (`PingStore`), `detail.ts` (`buildDetail`), `engine.ts` (`TripEngine`: `dashboard()`,
  `list(name)`, `detail(tripId)`, returning the `shared` API types, so `trips-api` only routes and
  validates). `schedule/frequency.ts` reads a `frequencies.txt` row and holds `MAX_CONCURRENT_INSTANCES`
  (loader and engine share it). Service-date inference is in `classify.ts`, not `references.ts` as the plan
  sketched, because it needs the active entries. Test support: `src/test-support/trips.ts` (a compact
  schedule builder that goes through the real loader, feed entity helpers, `harness`).
  `server/README.md` has a "Trip engine" section and the benchmark.
- **Spec amendments** (`docs(specs):` commits ahead of the code; `shared` in its own commit). First round:
  (1) `configuration_error` is the reason for any code. (2) Dashboard `configurationErrors.total` counts
  errors (a trip with two codes counts twice), `items` the first 100 in `trips.txt` order; the dashboard
  screen states `total`. (3) `templateDurationSecs` is `integer | null`. (4) Unreadable input: a frequency
  row that is not readable produces no instances; a malformed `start_date` is absent; a malformed
  `start_time` equals no instance start; an empty one is absent. (5) A list 3 group naming several dates
  takes the latest. (6) A list 3 row has a span only for `outside_scheduled_time`; `realtime.startTime`
  is the first reference's, vehicle positions first. (7) A ping with no usable timestamp takes the header's,
  then the receive time. **Review round:** (8) new configuration error **`frequency_too_dense`**: a readable
  row with ceil((D + 60 s) / H) above 2,000 (D the template duration, 0 if negative) - recorded by the
  loader after the trip's other codes, in `shared` `CONFIGURATION_ERROR_CODES`, dashboard, trips,
  feed-ingest and both screens. (9) Entry identity: a plain trip is one entry, an instance is identified
  by trip ID and start instant; instants produced twice (overlapping rows, windows past 24:00:00 meeting
  the next day's) are one entry, the first row's, on the later date. (10) Times are GTFS times
  (`H:MM:SS` or `HH:MM:SS`, hours may exceed 23), not literal `HH:MM:SS`. (11) A frequency row that cannot be
  read stays in `scheduled.frequencies` with `headwaySecs`, `windowStart`, `windowEnd` null (`shared` and its
  type test follow); the screens say so. (12) A vehicle timestamp of 0 is none (pings, `lastSeenAt`); an
  empty `route_id` is none, so the reference's route is used for every row; `lastSeenAt`'s fallback is the
  header of the first reference's feed. (13) The 404 is: not in the schedule, the latest snapshots or any
  retained ping. (14) "Active trips with realtime data" depends on exactly the configured feeds and equals
  `lists.activeWithRealtime` only when not null. (15) The memory limit counts snapshot bytes plus the ping
  index; the latest snapshot of each feed and its pings are never discarded; pings are an index into
  retained snapshots (data-retention, configuration, data-model). The plans `trips-api`,
  `dashboard-screen` and `trip-detail-screen` carry the changes they serve or show (status unchanged).
- **The blocker and its fix.** A 100-trip schedule with a 23:59 template and one row `00:00:00-30:00:00`,
  headway 1 s made every request enumerate about 86,000 concurrent instances per trip (2.16 M entries
  for 20 trips; out of memory at 100). The bound is per row (the loader refuses the trip), and the engine
  no longer enumerates what it only counts: `countActive` counts plain items once and series by
  arithmetic, `scheduledToday` is precomputed per service, `classifyCounts` makes entries only for the
  trips the references name (memoized per computation); only trips whose instants can repeat (windows
  overlapping, or instances 23 h or more apart) are enumerated, with a de-duplicating key. A property test
  compares the index, `countActive` and `scheduledToday` with a naive scan on random schedules (four
  zones, rows on a shared grid, windows past 24 h, 66 instants each, asserting that repeats occurred).
  What stays unbounded: a list returns every active entry, so a schedule in which every trip has
  hundreds of concurrent instances still produces a list that long (the spec forbids truncating).
- **Pings.** The first design decoded each ping into a record (about 13 times its protobuf entity); the
  review showed it evicted history long before the limit. Now `PingStore` keeps an index: per ping its
  identity, sequence, first receipt and the byte range of its entity in the newest retained snapshot that
  holds it (`entityRanges` walks the snapshot's bytes once, with the entity re-encoded as the fallback for
  bytes it cannot walk), about 200 bytes plus the key, reserved through `SnapshotStore.reserveMemory`. For a
  realistic entity that is under 3 times the snapshot's bytes (a test bounds it); for tiny test entities
  it is more. `forTrip` decodes the entities on request (130,000 pings: fine). Deviation from the
  coordinator's wording: the index holds a byte range, not an entity index, because an index would mean
  decoding a whole snapshot per ping. With 20,000 vehicles a snapshot and a 2 MiB limit the history is
  down to the latest snapshot of each feed with its pings (never evicted); with a 40 MiB limit it holds as
  many as fit and the index goes with each evicted snapshot (`pings.test.ts`).
- **Decisions the specs still leave open**: `realtime.vehicleIds` is in order of appearance, vehicle
  positions first, and skips references with no vehicle ID (the entity-ID fallback is for pings only);
  empty `trip_headsign`, `route_short_name`, `route_long_name`, `route_id` and `shape_id` cells are null in
  the API (the rows themselves are whole); detail `serviceDate` is the greatest valid `start_date` among the
  trip's current references, else the greatest inferred date of them, else inference without a reference;
  `activeTripsWithRealtime` waits for every configured feed (the engine takes `feeds`, default both); the
  dedupe of an instant that two rows produce credits the first row (so a later row's `activeInstanceStarts`
  omits it); a reference dated to the earlier date of an instant that the later date owns is
  `outside_scheduled_time` even though that run overlaps the minute (a span of 24 h or more is needed).
- **Candidate dates are today and yesterday only, as written.** On the evening before a spring-forward day
  (23:00-24:00 PST on 2026-03-07) the service day of the 8th has already started (07:00Z) but "today" is
  still the 7th, so a trip of the 8th starting at `00:00:00` is not looked at until midnight (a test pins it).
- **Hand cross-check of a DST case**: LA, service date 2026-11-01 (fall back at 02:00 PDT). Local noon is
  PST (UTC-8) = 20:00Z, minus 12 h = 08:00Z = 01:00 PDT, so `00:30:00` is 08:30Z and `24:00:00` is 08:00Z on the
  2nd = 00:00 PST. At 08:40Z the trip `00:30:00-01:00:00` is active; at 07:20Z (00:20 PDT) today is the 1st
  whose day has not started, and yesterday's `24:10:00-24:30:00` (07:10Z-07:30Z) is active. Spring forward
  2026-03-08: noon PDT = 19:00Z, minus 12 h = 07:00Z = 23:00 PST on the 7th; `03:00:00` is 10:00Z. These are
  literals in `engine.test.ts`. `time.test.ts` checks `serviceDayStart` and `agencyDate` against a table
  generated by Python's `zoneinfo` (`server/scripts/zone-table.py` -> `zone-table.ts`: 15 zones, the days
  around every change of offset in 2026, and the instants around each), independent of `Intl`. Africa/Casablanca,
  Africa/Cairo and America/Asuncion are left out of the table: Node's ICU and the system database disagreed
  on them (Casablanca 2026-09-20), which says something about tzdata versions, not the arithmetic.
- **Ground truth and oracle.** The scenario has the route-lookup unknowns, the five `cfg-` trips
  (no rows; no time at the last stop; none at the first stop of a frequency trip; both mixed and no rows;
  too dense), and the entry-identity and disagreeing-reference trips: `plain-spans-two-days`,
  `freq-overlapping-rows`, `freq-long-window`, `plain-ref-two-dates`, `plain-active-start-times`,
  `plain-active-no-timestamp`, `plain-active-zero-timestamp`, `plain-active-empty-route`; the trip updates
  header trails the vehicle positions one by 3 s, so `lastSeenAt`'s fallback is pinned. The oracle
  (`fixtures/src/expected.ts`) still shares nothing with the engine and now covers all of them: instants
  identified by start, a group taking its latest date, the first `start_time`, a zero timestamp as none, an
  empty `route_id` as none, dense trips. (It no longer throws on the "active on both dates" and "two
  service dates" scenarios.) Canonical figures: 136 scheduled / 24 active (13 + 11) / 45 vehicles (43 with
  a trip ID) / 10 trip updates / 31 list 3 rows at 12:07:42, and 131 / 27 / 44 (42) / 9 / 27 at 00:20:00.
  The loader's parse test agrees with the oracle on the configuration errors (order and codes) without
  engine help. `server/src/trips/scenario.test.ts` compares dashboard, all three lists (every field, order) and
  the detail classification of every listed trip with `expected` at 8 ordinary and just-after-midnight
  instants, 10 daylight-saving instants by wall clock, 7 by UTC instant and a sweep every 53 minutes from
  36 h before to 36 h after both changes.
- **No caching.** Every call reads the schedule, decodes the latest snapshots again and reads the clock.
  The one thing kept is `ScheduleIndex`, a `WeakMap` entry per `ScheduleStore`: items ordered by start second,
  entries per service, errors per trip, the trips that can repeat. It is a pure function of the immutable
  store and disappears with it at dormancy.
- **Measured** (`node server/scripts/bench-trips.mjs`, after `npm run build -w server`, Node 22.22, this
  machine; 100 000 trips, by default 10% frequency trips of 1-3 rows, every 5 000th with unusable stop times; the
  store is built directly, not by parsing a zip). Default (5 000 vehicles, 3 000 trip updates; 852 / 11 446
  / 4 376 rows): first call, which builds the index, 368 ms; lists p50 75-79 ms, **p95 104-139 ms**; dashboard
  p95 90 ms; detail p95 12 ms. Extremes (p95 of 5-15 runs): 40 000 references (20 000 + 20 000): lists 262-373 ms, dashboard
  283 ms, detail 82 ms; **200 000 references to unknown trips** (100 000 + 100 000, every one a list 3 row): lists
  p50 1.2-1.3 s, p95 1.5-1.9 s, dashboard p95 2.0 s (decode, grouping, sort of 200 000 rows); **100 000 frequency
  trips** (99 167 active rows): index 1.2 s, dashboard p95 391 ms (was about 1.2 s before the arithmetic
  counts), lists p95 676-801 ms (sorting 99 000 rows). The target (p95 under 300 ms for 100 000 trips)
  holds for the default mix, and not for the extremes above, which are sized beyond any real feed.
- **Mutation checks** (each applied alone; `npx vitest run src/trips src/realtime src/schedule/parse.test.ts`
  must fail): 79 mutants of the rules - overlap
  bounds (plain and series), window end, later date and first row winning, instant identity (per row,
  not per instant), exactness of trips whose instants repeat (overlapping rows, long windows), the daily count
  with overlap, `countActive` (plain once, exact trips), the sizes `classifyCounts` returns, the dense
  threshold (off by one, ignoring the minute), the loader's dense check, inference steps, matching, reason
  order and precedence, the group's date, grouping by start, ordering keys, route fallback (reference and
  empty `route_id`), `lastSeenAt`, `startTime`, zero timestamps (pings and references), ping dedupe,
  fallbacks, expiry, sequences, a ping staying with its first snapshot, entity field number, reservation of
  the index, a latest snapshot being evictable, the feeds a statistic waits for, the 100 limit, `total`,
  detail date and trip update choice, null values of unreadable rows, active instances of both dates, and the
  three time rules. 77 were killed. The two survivors change nothing: a mutant of mine that adds zero to
  `serviceDayStart`, and removing `Math.max(D, 0)` from the dense test, which cannot cross the threshold
  (a negative D only lowers a value that is at most 60 for a one-second headway).
- **Not verified / limits.** There is no HTTP layer here, so nothing is checked through the real app or with
  real feeds (`trips-api` does that; `TripEngine` is not yet created in `buildApp`). Decoded snapshots are not
  cached, so each call decodes up to two feeds. A list is as long as the active entries (up to 2,000 per
  row). The oracle and the engine were written by the same hands: the independence is in the code (no shared
  module) and in hand-derived literals, not in a second author.

## Follow-ups
- **trips-api** wires the engine: create `PingStore` (before the first snapshot arrives; it subscribes in its
  constructor) and `TripEngine` with `feeds` from the configured URLs; map `ScheduleNotReadyError` and a null
  `detail()` to `schedule_not_ready` and `trip_not_found`; serve the amended shapes (see its plan). Not filed:
  no tracker access.
- **dashboard-screen / trip-detail-screen** render the amended shapes (see their plans). Not filed.
- **Speed at 200 000 references**: decode, group and sort are the floor without caching the references, which
  would break the "nothing cached" rule - a spec question first. Not filed.
