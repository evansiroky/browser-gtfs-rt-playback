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
  Node 22.22, Vitest 5.0.5: 77 tests in 5 files, about 6 s (the sweep over ~1,500 real instants
  dominates; a scenario builds in about 2.6 ms).
- **Fake host runs compiled, not through `tsx`.** `npm run fake-feeds -w fixtures` is
  `tsc -b && node dist/server.js`: no extra runtime dependency, nothing to configure for
  NodeNext, and `fixtures/tsconfig.json` references `shared`, so `tsc -b` builds `shared` first.
  Default port 4200 (`PORT`, `--port=`); `--now=ISO` freezes the clock. It binds `127.0.0.1` and
  only an explicit `--host=` changes that (`$HOST` is ignored). Verified by hand on ports 4201 and
  4202: `curl` of the three URLs returns a valid zip (`unzip -l` lists nine files) and decodable
  feeds, and `http500`, `garbage` and `timeout` behaved as documented.
- **`expected` is computed, then pinned by hand.** `src/expected.ts` evaluates the spec rules over
  the scenario's data (a plain transcription of trip-activity, sharing nothing with the engine) so
  the scenario can be a function of any `now`, including midnight rollover where trips are
  clamped to the service day. `src/scenario.test.ts` pins the complete lists at 12:07:42 and
  00:20:00 against literals derived by hand from `fixtures/SCENARIO.md`. The evaluator throws rather
  than guess when a scenario would depend on something the spec leaves open.
- **Review round (an adversarial reviewer's independent Python evaluator).** It agreed with
  `expected` field for field at about 1,950 instants, but found: (1) `scenario()` threw for the hour
  00:00-00:59 PDT on 2026-11-01, where noon minus 12 h is 01:00 and the seconds into the service
  day are negative (fixed: starts clamp, empty windows drop, anchors stay non-negative, so it never
  throws; the sweep now steps through real UTC instants, every 397 s from 2026-03-06T20:00Z to
  03-10T08:00Z and 2026-10-30T20:00Z to 11-03T08:00Z, plus every minute of the hours around three
  service day starts); (2) service-date inference step 1 was never exercised (`overnight-daily`,
  `freq-overnight`); (3) nominal matching was only tested on an exact row (`freq-nominal` now has
  adjacent `exact_times=0` and absent rows, each with an active instance, a 90 s-late reference
  and, on the second, an exact one); (4) reason precedence (`freq-nis`, `freq-mixed-removed-today`);
  plus smaller gaps (route ID of unknown trips, null spans, `lastSeenAt`, references dated
  yesterday/tomorrow, several vehicles per trip, trip-update vehicles no position carries, a start
  equal to the window end), realism fixes (block overlaps, empty windows, `stop_time_update` on every
  update) and fake-host fixes (below).
- **Mutants.** The reviewer's evaluator with 24 injected rule mutations (`mutsweep.py`) was re-run
  against the fixed fixtures: every mutant, including the six that survived (`skip_step1`,
  `loose_nonexact`, `nis_before_cfg`, `freq_before_nis`, `tu_no_vid`, `win_incl`), differs from
  `expected` at one or more of the three instants the tests pin (12:07:42, 00:20:00 and the
  fall-back day at 01:15 PDT) and over the sweeps; one added mutant (`step1_any_instance`, step 1
  ignoring the start_time) is killed at 00:20. The evaluator copy used here is the reviewer's
  with my edits for the refined inference rule, the route-ID fallback, `lastSeenAt` and null spans;
  it still matched `expected` at 3,557 sampled instants (the three pinned ones and sweeps of the DST days), so the independence is weaker than in the
  review.
- **Spec state.** An earlier commit of this branch amended the service-date inference tie-break;
  the PR base now has that amendment and a refinement (a frequency reference's `start_time` selects
  the active instance), so the commit was dropped and `expected` follows the base's text.
- **Fake host changes from the review.** `stale` is now `old-data`: it answers 200 forever with
  one-hour-old timestamps, so it can never make the app's stale state (latest successful fetch
  older than three poll intervals) appear; use `http500`, `timeout` or `garbage` for that. `POST
  /__control` requires `Content-Type: application/json` (415 otherwise, so a cross-origin form or
  `text/plain` post cannot flip modes). `/__scenario` returns `{ now, scenarioNow, expected }`: the
  current clock and the build instant separately. `GET /__scenario` and `/__control` are the
  additions beyond the plan, as are `advance` and `slowMs` in the control body.
- **Choices beyond the plan.** `agencyInstant(date, 'HH:MM:SS')` aims a scenario at a moment such
  as 00:20 without timezone arithmetic. `advance(seconds)` is pure (seconds since `now`, negative
  allowed). `agency.txt` has two agencies so `names: string[]` is observable. Not pinned by
  `expected` (the spec leaves them open): the order of `vehicleIds` (compare as a set),
  `scheduledSpan` of list 3 rows with the reasons `not_in_service`, `missing_start_time`,
  `unmatched_start_time`, and vehicle and entity IDs (assigned in creation order).
- **Lockfile.** `chore: update lockfile` adds the fixtures workspace and fflate (the other
  dependencies were already locked by the server workspace).
- **Docs checked against `expected`.** The figures and enumerated rows in `SCENARIO.md` were
  regenerated from `expected` with a throwaway script and diffed against the text after the review
  round (it had left 21/17 list 3 rows and 29/27, 28/26 vehicle counts where the data says 22/18 and
  30/28, 29/27, and omitted the `freq-overnight` 23:10:00 reference). Canonical 12:07:42: tripsToday
  46, active 15 (8 + 7), vehicles 30 (28 with a trip ID), trip updates 6, list 3 22 rows; 00:20:00:
  41, 20 (11 + 9), 29 (27), 5, 18 rows.
- **Combined tree.** Rebased onto the PR base with `shared`, `server` and `web` merged: lint,
  typecheck, test (37 + 77 + 164 + 118, three runs), build, `format:check` and
  `npm audit --omit=dev` (0 vulnerabilities) all pass.
- **Not verified.** The mutant table was produced against the reviewer's kit as extended here, not
  against a real engine (none exists yet).

## Follow-ups
None.
