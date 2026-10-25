---
status: done
pr: 3
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
- [x] `npm run lint`, `typecheck`, `test`, `build` pass.
- [x] Scenario covers each rule: plain active/future/past/overnight, exact and non-exact
      frequency instances, mixed-`exact_times` error, not-in-service, unknown trip, missing
      start_time, unmatched start_time, vehicle without trip_id, missing shape, ungrouped shape.
- [x] `npm run fake-feeds` starts, and `curl` of each endpoint returns a valid zip / decodable
      protobuf; failure modes change responses as documented.
- [x] Decoding the built feeds with `gtfs-realtime-bindings` yields the entity counts in `expected`.
- [x] README section documents the scenario table so other plans can reference it.

## Risks / unknowns
- **Ground truth bugs** — `expected` is hand-derived from the spec; if it disagrees with the
  engine ([`trip-engine`](trip-engine.md)), decide against the spec, not the code.
- **Timezone/DST** — avoid choosing a `now` near a DST change unless a test targets it.

## Notes
- **Versions.** `gtfs-realtime-bindings ^2.2.0` (CommonJS, protobufjs 8: imported as a default
  import and destructured; `uint64` fields decode to a number or a `Long`, hence `toSeconds`),
  `fflate ^0.8.3`; the only other dependency is `@gtfs-rt-debugger/shared` for `encodePolyline6`.
  Node 22.22, Vitest 5.0.5: 199 tests in 5 files, about 1.3 s.
- **Fake host runs compiled, not through `tsx`.** `npm run fake-feeds -w fixtures` is
  `tsc -b && node dist/server.js`: no extra runtime dependency, nothing to configure for
  NodeNext, and `fixtures/tsconfig.json` references `shared`, so `tsc -b` builds `shared` first.
  Default port 4200 (`PORT`, `--port=`), host 127.0.0.1, `--now=ISO` freezes the clock. Verified by
  hand on ports 4201 and 4202: `curl` of the three URLs returns a valid zip (`unzip -l` lists nine
  files) and decodable feeds, and `http500`, `garbage` and `timeout` (curl `-m 2` gave no response)
  behaved as documented.
- **`expected` is computed, then pinned by hand.** The brief asked for hand-derived values. Because
  the scenario is a function of any `now` (including midnight rollover, where trips are clamped
  to the service day), `src/expected.ts` evaluates the spec rules over the scenario's data
  (a plain transcription of trip-activity, sharing nothing with the engine), and
  `src/scenario.test.ts` pins its complete output for 12:07:42 and 00:20:00 against literals
  derived by hand from the tables in `fixtures/SCENARIO.md`. The evaluator throws rather than
  guess when a scenario would depend on something the spec leaves open (a trip active on both
  candidate dates, references to one trip on two dates, references in one group that disagree on
  `start_time`). A sweep of 137 instants (three days including both 2026 DST changes) checks the
  list/count invariants and that the decoded feeds carry the counts in `expected`.
- **Spec amendment (own commit `docs(specs): break the tie...`).** The service date of a reference
  with no `start_date` was "the candidate date on which the trip has an active entry, then one on
  which the trip operates, else today", which gives two answers for a daily trip. Now: "when both
  candidate dates qualify at a step, the later one wins", the tie-break the entry service date
  already used. The fixture's `plain-future` (a daily trip, not active, VP without date) needed it;
  its `outside_scheduled_time` row has service date today.
- **Choices beyond the plan.** `scenario(now, options)` takes the options object the brief named
  (`includeMisconfiguredTrip`); `agencyInstant(date, 'HH:MM:SS')` aims it at a moment such as 00:20
  without timezone arithmetic. `advance(seconds)` is pure (seconds since `now`, negative allowed),
  not a stateful cursor. The server also serves `GET /__scenario` (the ground truth of the scenario
  being served) and `/__control` accepts `advance` and `slowMs`; `now` freezes the clock and
  rebuilds the scenario. `stale` serves the feed as of one hour earlier, frozen. `agency.txt` has two
  agencies so `names: string[]` is observable. Not pinned by `expected` (spec open): `vehicleIds`
  order, `lastSeenAt`, list 3 spans for reasons other than `outside_scheduled_time`.
- **Lockfile.** `package-lock.json` changes (fflate, gtfs-realtime-bindings, protobufjs and
  friends) are left uncommitted for the orchestrator to regenerate, as instructed.
- **Not verified.** Nothing from the plan; the in-process server and the CLI were both exercised.

## Follow-ups
None.
