---
status: planned
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
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass.
- [ ] End-to-end API tests over HTTP match the scenario's `expected` for dashboard, all three
      lists, and detail (classification entries, scheduled block incl. frequencies and active
      instance starts, configuration errors, pings with stable sequence numbers, latest trip update).
- [ ] `serviceDate` (or any query param) on the detail endpoint → `400 bad_request`; same for
      unknown params on the list; `list` validation.
- [ ] Dormant → `409 session_not_active`; schedule loading/failed → lists/detail `409
      schedule_not_ready` while dashboard still `200` with nulls.
- [ ] Trip IDs with `/`, `%`, spaces, non-ASCII round-trip through the detail route.
- [ ] 404 for a trip in neither schedule nor retained realtime data; a realtime-only unknown
      trip returns `scheduled: null` with pings.
- [ ] Reading data endpoints does not reset the inactivity timer (fake-clock test).

## Risks / unknowns
- **Payload size** — lists are unpaginated by spec; check a 5k-row list serializes quickly and
  note the byte size in Notes.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
