---
status: done
pr: 3
depends: [trip-engine]
specs:
  - specs/api/dashboard.md
  - specs/api/trips.md
  - specs/api/conventions.md
issues: []
---

# Plan: Dashboard and trips API

## Scope
In: `GET /api/v1/dashboard`, `GET /api/v1/trips?list=…`, `GET /api/v1/trips/{tripId}` — routing,
validation, state guards, and serialization of the [`trip-engine`](trip-engine.md) results to the
`shared` API types.

Out: engine logic (done); shapes endpoint (done in [`schedule-loader`](schedule-loader.md)); UI.

## Implements
- `api/dashboard.md`: every field, null-until-ready rules, `configurationErrors` (first 100 +
  total), succeeds while the schedule is loading with schedule-dependent fields null.
- `api/trips.md`: list (three names; missing/unknown `list` or **any other query parameter** →
  `400`), detail (**no query parameters accepted**, `serviceDate` included → `400`; percent-encoded
  trip IDs; `404 trip_not_found`), `409 session_not_active` / `409 schedule_not_ready`, ordering,
  complete lists (no pagination), pass-through of VehiclePosition fields.
- `api/conventions.md`: envelope, `no-store`, camelCase, epoch seconds, service dates informational.
- The amendments the [`trip-engine`](trip-engine.md) review made to these specs, which the endpoints
  must serve: `configurationErrors.total` counts errors (a trip with two codes counts twice) and the
  code enum has `frequency_too_dense`; `realtime.activeTripsWithRealtime` is null until every
  configured feed has a snapshot (so equals `lists.activeWithRealtime` only when not null);
  `templateDurationSecs`, and `headwaySecs`, `windowStart`, `windowEnd` of a frequency row that
  cannot be read, are nullable; a ping `timestamp` falls back to the header timestamp, then the
  receive time; the `404` is: not in the schedule, the latest snapshots or any retained ping.
  `TripEngine` (`server/src/trips/engine.ts`) already returns the `shared` types: create it (and the
  `PingStore`, before the first snapshot) in `buildApp` with `feeds` from the configured URLs.

## Approach
- `server/src/api/{dashboard,trips}.ts` registering routes; strict query validation helper
  that rejects unknown keys; trip-ID decoding edge cases (slashes, spaces, unicode, `%2F`).
- Serializers typed against `shared`; a conformance test per endpoint that validates responses
  against the shared types (and a JSON-shape snapshot against the fixture scenario).
- Integration tests through the real HTTP app with: fake clock, [`test-fixtures`](test-fixtures.md)
  scenario served by an in-test HTTP server, session started via the real session API, schedule
  loaded for real, a few poll ticks so pings accumulate.
- Confirm data endpoints never reset the inactivity timer and never wake a dormant server.

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` pass.
- [x] A trip with `frequency_too_dense` (and one with an unreadable frequency row) is served by the
      dashboard items and the detail as specified, over HTTP.
- [x] End-to-end API tests over HTTP match the scenario's `expected` for dashboard, all three
      lists, and detail (classification entries, scheduled block incl. frequencies and active
      instance starts, configuration errors, pings with stable sequence numbers, latest trip update).
- [x] `serviceDate` (or any query param) on the detail endpoint → `400 bad_request`; same for
      unknown params on the list; `list` validation.
- [x] Dormant → `409 session_not_active`; schedule loading/failed → lists/detail `409
      schedule_not_ready` while dashboard still `200` with nulls.
- [x] Trip IDs with `/`, `%`, spaces, non-ASCII round-trip through the detail route.
- [x] 404 for a trip in neither schedule nor retained realtime data; a realtime-only unknown
      trip returns `scheduled: null` with pings.
- [x] Reading data endpoints does not reset the inactivity timer (fake-clock test).

## Risks / unknowns
- **Payload size** — lists are unpaginated by spec; check a 5k-row list serializes quickly and
  note the byte size in Notes.

## Notes
- **Layout.** `server/src/api/dashboard.ts` and `trips.ts` only route, validate and serialize; the
  engine returns the `shared` types, so handlers are typed `Promise<DashboardResponse>` etc. Both are
  `ApiRoutes<unknown>` (the engine is `context.trips`, built by `buildApp`) and are mounted in `main.ts`
  next to the shapes route. `buildApp` creates the `PingStore` right after the `SnapshotStore`, so every
  ping is indexed; it forgets with the store's clear on dormancy, and is disposed on close. The engine
  gets `feeds` from the configured URLs and its schedule from the provider.
- **`ScheduleProvider.store`.** The interface gained `readonly store: ScheduleStore | null` (the loader
  already had it; the no-op provider has `null`), so `buildApp` can hand the engine the loaded schedule
  without knowing the loader type. Four test stand-ins got `store = null`.
- **Order of checks.** Query validation (unknown or repeated parameters, then a missing or unknown `list`)
  runs before the state guards, as for shapes: a malformed request is `400` whatever the state. The specs
  do not order the two; no test pins it for the new endpoints.
- **Data endpoints never wake or touch the timer.** They only use `guard.requireActive` /
  `requireSchedule`, which read state. The fake-clock test advances to 30 s into a 60 s window, reads
  four data endpoints, and the server is dormant at 45 s (replacing the reads with a session ping makes it
  fail); a dormant server stays dormant after reads; a new activation starts pings at sequence 1.
- **Unreadable frequency row.** The engine nulls each unreadable value, not the whole row (a row with a
  bad start time keeps its readable end); the HTTP test uses a row with no readable value, which is null
  throughout either way. The spec's wording ("its unreadable values null") allows both.
- **Conformance.** `test-support/shape.ts` and `api-shapes.ts` describe each response field for field
  (exact key sets, nullability, enums; pings are open for pass-through fields) and the HTTP tests check
  every dashboard, list and detail response they fetch against them, instead of a stored snapshot. The
  scenario comparison (`expectScenario` in `test-support/expected-rows.ts`) is shared with the engine
  tests, so the engine and the HTTP API are held to the same `expected`.
- **Test harness.** `test-support/scenario-app.ts` runs the real app on a `FakeClock` against the fake
  feeds server: the clock and the feeds start three poll intervals before the scenario instant and move
  together, so the final responses are at the instant `expected` describes, with three snapshots of pings
  behind them (expected pings are derived from the published feeds, independent of `PingStore`). The rate
  limit is raised there (hundreds of requests on a clock that never moves).
- **Payload size.** 5,000 active trips in one `active-without-realtime` list: 1,115,069 bytes (about
  223 bytes a row), computed and serialized through the HTTP app in about 50 ms (three runs: 46-56 ms).
  Fast enough that the unpaginated spec needs no mitigation at that size.
- **No spec changes.**

## Follow-ups
None.
