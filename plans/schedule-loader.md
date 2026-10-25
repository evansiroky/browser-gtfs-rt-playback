---
status: planned
depends: [server-core, test-fixtures]
specs:
  - specs/behaviors/feed-ingest.md
  - specs/behaviors/data-retention.md
  - specs/behaviors/trip-activity.md
  - specs/data-model.md
  - specs/api/shapes.md
issues: []
---

# Plan: Schedule loader and shapes

## Scope
In: the `ScheduleProvider` implementation — download the GTFS Schedule once per activation,
stream-parse it down to the retained data, hold it in memory behind a query interface, report
its state in the session status — and the `GET /api/v1/shapes/{shapeId}` endpoint.

Out: deciding what is "active" or classifying trips ([`trip-engine`](trip-engine.md)); the
dashboard/trips endpoints ([`trips-api`](trips-api.md)).

## Implements
- `behaviors/feed-ingest.md` "Schedule": once per activation, timeout, download-size and
  schedule-memory limits, streaming, retained-data reduction, required/optional files, one retry
  after 30 s then `failed` until a start retries, realtime unaffected, error codes without URLs.
- `behaviors/data-retention.md` "Schedule" and "Forgetting" for schedule data.
- `data-model.md`: Agency, Scheduled trip (template start/end), Shape (precision-6 polyline).
- `behaviors/trip-activity.md` "Schedule entries": detecting the mixed-`exact_times`
  configuration error at load time.
- `api/shapes.md`: the endpoint, its errors (`shape_not_found`, `409`s, no query parameters).

## Approach
`server/src/schedule/`:
1. `download.ts`: fetch with timeout and a hard byte cap on the (compressed) body, streamed to a
   temp buffer/stream — never an unbounded allocation.
2. `zip.ts` + `csv.ts`: streaming zip entry iteration and CSV row streaming (BOM, quoted fields,
   CRLF). Only the needed files are read; others skipped.
3. Per-file reducers: agency (names + first timezone), routes (all columns), trips (all
   columns), calendar/calendar_dates (into a `ServiceCalendar` with `operatesOn(serviceId,
   yyyymmdd)`), frequencies (all columns), stop_times (per-trip first/last times only — parse
   `HH:MM:SS` > 24h to seconds from "noon minus 12h"), shapes (**encode while streaming** to
   precision 6 using `shared`'s codec; group/sort per spec; discard raw points per shape; skip
   invalid points).
4. `ScheduleStore`: query interface for the engine — `agency()`, `trip(id)`, `route(id)`,
   `frequencies(tripId)`, `template(tripId)` (start/end seconds), `operatesOn(...)`, all trips
   iterator, `shape(id)` → polyline, `configurationErrors()` (trips with mixed `exact_times`;
   absent counts as 0), counts for memory accounting.
5. Memory limit: track estimated retained bytes; exceeding → abort with `too_large`.
6. `ScheduleLoader implements ScheduleProvider`: states `idle|loading|ready|failed`, `loadedAt`,
   error code+message, one automatic retry after 30 s (via the injected clock), `retry()` on
   start while failed, `discard()` on dormancy (abort in-flight, drop data).
7. Route `GET /api/v1/shapes/:shapeId` via the `DataEndpointGuard`.
8. Fixtures: use [`test-fixtures`](test-fixtures.md) zips; add a few edge-case zips locally (missing
   required file, bad CSV, oversize, huge-but-valid synthetic with many trips/shapes).

## Validation
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass.
- [ ] Parsing the fixture zip yields exactly the agency, route/trip columns, frequency rows,
      template start/end and polylines the fixture says it should (incl. > 24:00 times, ungrouped
      shape, missing-shape trip, mixed-`exact_times` configuration error).
- [ ] Calendar semantics: weekday flags, date range inclusive, exceptions add/remove,
      `calendar_dates`-only services.
- [ ] Failure paths: missing required file, optional files absent, oversize body, memory limit →
      `too_large`, timeout, 404 — each gives the documented code, never a URL; retry after 30 s with fake
      clock; `start` retries a failed load; download happens **once** per activation.
- [ ] Dormancy aborts an in-flight load and drops all schedule data (heap measurement or
      structural assertion).
- [ ] `GET /shapes/:id` returns `{shapeId, encoding:"polyline6", polyline}` equal to the stored
      string; `shape_not_found`; `409`s; query parameters → `400`.
- [ ] Memory: loading a synthetic 100k-trip / 2M-shape-point schedule keeps retained heap under
      the 768 MiB limit and shapes held only as strings (document the measured number in Notes).

## Risks / unknowns
- **Peak memory while parsing** — streaming discipline matters more than final size; measure.
- **Hand-rolled CSV edge cases** — prefer a maintained streaming CSV parser.
- **Zip64 / unusual compression** — pick a streaming zip reader that handles real agency feeds.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
