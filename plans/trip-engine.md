---
status: planned
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
9. Performance test: 100k-trip synthetic schedule — lists computed in a few hundred ms.

## Validation
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass.
- [ ] The fixture scenario's `expected` matches engine output exactly (counts, list membership,
      reasons, order, configuration errors) at several `now` values, including just after
      midnight (yesterday's service date) and a DST-change day.
- [ ] Every sentence-level rule in `trip-activity.md` has at least one test that fails if the rule is removed.
- [ ] Ping store: dedupe by triple; timestamp and vehicle-ID fallbacks; sequence numbers stable
      after expiry and eviction; pings across frequency instances/vehicles on one trip ID stay distinct;
      all vehicle fields pass through; forgotten at dormancy.
- [ ] Performance: 100k trips, p95 list computation under 300 ms on this machine (record number in Notes).
- [ ] No cached derived state across requests (recomputed from store + clock each time).

## Risks / unknowns
- **Time arithmetic** — DST and >24:00 times are the likeliest source of silent bugs; test them
  explicitly and cross-check one case by hand in Notes.
- **Spec ambiguity** — if a case is unspecified, amend the spec first (`docs(specs):` commit)
  rather than choosing silently.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
