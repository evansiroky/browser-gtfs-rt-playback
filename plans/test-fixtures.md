---
status: planned
depends: [workspace]
specs:
  - specs/behaviors/trip-activity.md
  - specs/behaviors/feed-ingest.md
  - specs/data-model.md
issues: []
---

# Plan: Test fixtures and fake feed server

## Scope
In: a `fixtures` workspace package that builds a synthetic GTFS Schedule zip and GTFS-RT
VehiclePositions/TripUpdates protobuf feeds relative to a given instant, with a **ground-truth
description** of what the app should report, plus a runnable fake feed HTTP server
(`npm run fake-feeds`) for development and end-to-end tests.

Out: any server/web code; the end-to-end test harness itself ([`dashboard-screen`](dashboard-screen.md)).

## Implements
No product behavior — it exists so behaviors in `trip-activity.md`, `feed-ingest.md`, and
`data-model.md` can be verified against known data. Its scenario must exercise every rule there.

## Approach
`fixtures/src`:
1. `buildScheduleZip(opts)` → `Uint8Array` (use `fflate`): agency "Fixture Transit"
   (`America/Los_Angeles`), routes, `calendar.txt` covering all weekdays plus a
   `calendar_dates.txt` exception (one service removed today, one added), `trips.txt`,
   `stop_times.txt` (times > 24:00:00 for an overnight trip), `shapes.txt` (≥ 3 shapes of ≥ 20
   points near San Francisco, deliberately **ungrouped/out of order** in one shape), and
   `frequencies.txt`.
2. `scenario(now: Date)` → `{ scheduleZip, vehiclePositions: Uint8Array, tripUpdates: Uint8Array, expected }`
   where trips are placed relative to `now` in the agency timezone: plain trips active now / not
   yet started / already ended / running past midnight from yesterday's service date; a
   frequency trip (headway 10 min, window covering now) with `exact_times=1`, another with
   `exact_times=0` (nominal departures still apply); a **mixed-`exact_times`** trip (toggle
   via option `includeMisconfiguredTrip`, default true); a trip in `trips.txt` whose service
   isn't running today; a trip with a `shape_id` missing from `shapes.txt`.
   RT: vehicle positions moving along shapes for some active trips (several pings over time via
   `advance(seconds)`), a vehicle with **no trip_id**, a vehicle with an **unknown** trip_id, a
   not-in-service trip, a scheduled trip running outside its window, frequency instances
   with `start_time` (matching, mismatching, and missing), trip updates for a subset.
   `expected` lists, for that `now`: tripsToday, tripsActiveNow, vehicle/vehicles-with-trip-id/
   trip-update counts, the three lists (entries + reasons), configuration errors.
3. Feed encoders using `gtfs-realtime-bindings`.
4. `fake-feeds` CLI (`src/server.ts`): serves `/schedule.zip`, `/vehicle-positions.pb`,
   `/trip-updates.pb`, regenerating RT from the wall clock so vehicles advance; control endpoint
   `/__control` (JSON) to set failure modes (`http500`, `timeout`, `garbage`, `stale`,
   `slow`) per feed, and a `now` override for deterministic runs. Prints the three URLs.
5. Unit tests that the encoders round-trip and that `expected` is internally consistent (e.g.
   list sizes equal counts).

## Validation
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass.
- [ ] Scenario covers each rule: plain active/future/past/overnight, exact and non-exact
      frequency instances, mixed-`exact_times` error, not-in-service, unknown trip, missing
      start_time, unmatched start_time, vehicle without trip_id, missing shape, ungrouped shape.
- [ ] `npm run fake-feeds` starts, and `curl` of each endpoint returns a valid zip / decodable
      protobuf; failure modes change responses as documented.
- [ ] Decoding the built feeds with `gtfs-realtime-bindings` yields the entity counts in `expected`.
- [ ] README section documents the scenario table so other plans can reference it.

## Risks / unknowns
- **Ground truth bugs** — `expected` is hand-derived from the spec; if it disagrees with the
  engine ([`trip-engine`](trip-engine.md)), decide against the spec, not the code.
- **Timezone/DST** — avoid choosing a `now` near a DST change unless a test targets it.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
