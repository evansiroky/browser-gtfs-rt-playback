---
status: done
pr: 3
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
- [x] `npm run lint`, `typecheck`, `test`, `build` pass.
- [x] Parsing the fixture zip yields exactly the agency, route/trip columns, frequency rows,
      template start/end and polylines the fixture says it should (incl. > 24:00 times, ungrouped
      shape, missing-shape trip, mixed-`exact_times` configuration error).
- [x] Calendar semantics: weekday flags, date range inclusive, exceptions add/remove,
      `calendar_dates`-only services.
- [x] Failure paths: missing required file, optional files absent, oversize body, memory limit →
      `too_large`, timeout, 404 — each gives the documented code, never a URL; retry after 30 s with fake
      clock; `start` retries a failed load; download happens **once** per activation.
- [x] Dormancy aborts an in-flight load and drops all schedule data (heap measurement or
      structural assertion).
- [x] `GET /shapes/:id` returns `{shapeId, encoding:"polyline6", polyline}` equal to the stored
      string; `shape_not_found`; `409`s; query parameters → `400`.
- [x] Memory: loading a synthetic 100k-trip / 2M-shape-point schedule keeps retained heap under
      the 768 MiB limit and shapes held only as strings (document the measured number in Notes).

## Risks / unknowns
- **Peak memory while parsing** — streaming discipline matters more than final size; measure.
- **Hand-rolled CSV edge cases** — prefer a maintained streaming CSV parser.
- **Zip64 / unusual compression** — pick a streaming zip reader that handles real agency feeds.

## Notes
- **Layout** (`server/src/schedule/`): `download.ts` (chunked body), `zip.ts` (yauzl over the chunks),
  `csv.ts` (csv-parse rows, inflated-stream limits), `guard.ts` (`LoadGuard`: byte cap, deadline,
  abort), `parse.ts` (per-file reducers), `shapes.ts`, `calendar.ts`, `time.ts`,
  `memory.ts` (budget and estimates), `store.ts` (the `ScheduleStore` interface), `memory-store.ts`,
  `loader.ts` (`ScheduleLoader`), `routes.ts` (`shapesRoutes`, `ScheduleServices`). `main.ts` composes
  them: `services: { loader }`, `schedule: services.loader`, `routes: [shapesRoutes]`. Documented in
  `server/README.md` ("Schedule store", "Benchmark", behavior notes).
- **Versions.** `@gtfs-rt-debugger/shared` is now a declared runtime dependency of the server (it
  was imported through the workspace link only). `yauzl 3.4.0` and `csv-parse 7.0.3` (exact pins, runtime; `npm audit` clean, Node >= 12 /
  no engine limit), dev: `@types/yauzl 3.4.0`, `fflate ^0.8.3` (same as fixtures, to build zips in tests),
  `@gtfs-rt-debugger/fixtures` (workspace; tests only, so it is not in the production install). The
  server's `test` and `typecheck` scripts now run `tsc -b . ../fixtures` so a lone `npm test -w server`
  has fixtures built; `build` is unchanged and does not build fixtures. Vitest 5.0.5.
- **Why yauzl over a streaming (local-header) reader.** The zip is only readable reliably from its
  central directory (entries written with data descriptors have no sizes in the local header), so the
  downloaded body is kept as its chunks (<= `SCHEDULE_MAX_BYTES`, never one contiguous copy: a custom
  `RandomAccessReader` reads ranges across chunks) and each needed entry is inflated as a stream. Tests
  cover single-byte chunking and zips with data descriptors (deflated and stored). Nothing touches disk.
- **Shapes.** Grouped files stream through holding one shape's raw points. The first `shape_id` that
  returns after another shape's rows proves the file ungrouped; the file is then read a second time
  buffering per shape (counted toward the memory limit), instead of keeping everything buffered "just in
  case". Points are `number[]` triples; sequences sort stably (ties keep file order).
- **Memory accounting** is an estimate charged to a `MemoryBudget` as the load goes. Everything retained is
  charged by the size of its text (rows, agency names, trip and service ids, shape ids, polylines, map and
  array slots), however long a cell is; values that are only parsed are kept as numbers (stop times, calendar
  dates, sequences) and their text is dropped, and calendar rows with dates that are not `YYYYMMDD` are ignored.
  Shape points are charged while buffered and released when encoded; the limit applies to the peak, so
  `counts().estimatedBytes` (retained at the end) is lower than what the limit saw. Strings count one byte per
  character, two if any character is beyond Latin-1. Tests pin the charges (a 1 MiB limit is crossed by 20
  frequency rows of 100 KiB, by 5 service ids of 300 KiB, and so on) and a mutation that removes any charge fails.
- **Bounded reading (review round).** The download limit and fetch timeout only cover the download, so the
  inflated stream is guarded as well: a counting `Transform` between each entry stream and the CSV parser
  enforces a cap of 8 x `SCHEDULE_MAX_BYTES` inflated bytes over the whole load (`too_large`), a deadline of
  4 x `SCHEDULE_TIMEOUT_MS` from the end of the download (`timeout`, on the injected clock) and the abort
  signal, per chunk and (every 256 rows) per row; an abort listener destroys the parser at once, so `discard()`
  no longer waits for a row (a file of blank lines yields none). The factors are constants (`DECOMPRESSION_FACTOR`,
  `PARSE_TIMEOUT_FACTOR`), not settings: no spec names them, so they are a decision to review. An archive with
  more than 10 000 entries is `bad_zip`; only the eight GTFS files are indexed. `frequencies.txt` rows are
  pushed to a per-trip array (copying per row took 64 s for 100 000 rows). Tests use small injected limits
  (a few MiB of inflated blank lines), not multi-GB fixtures.
- **Measured** (`node --expose-gc server/scripts/bench-schedule.mjs`, Node 22.22, after the review round;
  100 000 trips, 2 000 000 stop times, 4 000 shapes x 500 points = 2 000 000 points, 400 routes, 100 000
  `trips.txt` rows with 10 columns):

  | Run                       | Zip      | Load time | Peak RSS | Peak heapUsed | Retained heap after GC | Loader estimate |
  | ------------------------- | -------- | --------- | -------- | ------------- | ---------------------- | --------------- |
  | grouped `shapes.txt`      | 37.2 MiB | 26.6 s    | 206 MiB  | 86 MiB        | 52.4 MiB               | 74.1 MiB        |
  | ungrouped (interleaved)   | 31.5 MiB | 26.9 s    | 303 MiB  | 184 MiB       | 52.5 MiB               | 74.1 MiB        |

  Retained heap is 7% of the 768 MiB limit; the estimate sits 1.4x above the measurement. Shapes are strings
  (sampled in the script; the unit tests assert only the polylines stay charged once their raw points are
  encoded). Worst event-loop stall while loading: 22-31 ms. `--limit 31457280` aborts with `too_large`.
  Throughput is about 150 000 CSV rows/s, half of it spent building row objects. The earlier "ungrouped" row
  of this table was not ungrouped (the script did not forward `--ungrouped` to the generator); fixed and
  remeasured above.
- **Process smoke** (`npm run fake-feeds -w fixtures` on port 4810, built server on 4811): `POST
  /session/start` -> `loading`, `ready` 80 ms later; three more pings and `GET /shapes/shape-market`
  returned the fixture polyline; unknown shape -> 404 `shape_not_found`; SIGTERM exited cleanly; the log
  line `schedule loaded` carries counts only. The same flow runs in CI as `schedule/process.test.ts`
  against the built `dist/main.js` with a request-counting host (one download across start, ping, start).
- **Mutation checks** (each applied alone, `npx vitest run src/schedule` must fail; all 40 killed): start
  always loading (once per activation); late-completion guard removed (success and failure paths); discard
  keeping the store / not aborting; retry delay 20 s; calendar type 1 ignored / type 2 ignored / end date
  exclusive; ungrouped shapes not re-read; the shapes budget not released after the re-read; shape sequence
  sort off; out-of-range points kept; last-seen instead of max `stop_sequence` and first-seen instead of min;
  template start/end preferring the other time; absent `exact_times` not read as 0; shapes route without
  `rejectUnknownQuery` / without the schedule guard; download cap removed; memory budget never throwing; the
  trip, route, frequency-row, agency-name, calendar-id and calendar_dates-id charges removed one by one;
  `stop_sequence` read with `Number()`; clock minutes `\d\d` instead of `[0-5]\d`; inflated bytes not
  counted / no check per chunk / no abort listener / no row-count check; the decompression cap off at the
  loader; `frequencies` copied per row; no entry-count cap; all entries indexed; `unusable_stop_times` never
  listed / listed before `mixed_exact_times`. The retry-delay mutation survived once (the test advanced by the
  exported constant) and now advances by the literal 29 999 ms + 1 ms. Not covered: the `PARSE_TIMEOUT_FACTOR`
  wiring at the loader (the deadline itself is tested on the guard).
- **Decisions the specs leave open** (all in `server/README.md`): a trip whose first or last stop has no
  usable time, or with no usable `stop_times.txt` rows, is kept with `template: null` and listed as an
  `unusable_stop_times` configuration error (spec: trip-activity.md; a trip with both problems is listed
  under both codes, `mixed_exact_times` first, in `trips.txt` order: the specs say "either" and the trip
  detail's `configurationErrors` is a list, but not whether the dashboard `total` counts trips or errors);
  `stop_times.txt` rows whose `stop_sequence` is not plain digits are skipped; an
  `agency.txt` without rows or with an empty or unknown first-row timezone fails the load
  (`invalid_schedule`), as does a required column missing from a header (`invalid_schedule`, naming file
  and column); `shapes.txt` points with a non-numeric `shape_pt_sequence` are skipped like invalid
  coordinates, and a shape without a valid point does not exist; a repeated `route_id`/`trip_id` keeps
  the first row; a date both added and removed counts as added (as the fixture's evaluator does); rows of
  unknown trips in `stop_times.txt`/`frequencies.txt` are dropped; only top-level archive files are read;
  a time that is not `H:MM:SS` counts as missing; the status shows no error while a retry is loading;
  a load started by `retry()` gets its own automatic retry; nested single-folder archives stay rejected
  (`missing_file`: the spec reads top-level files). Spec amendments: `docs(specs):` in
  `feed-ingest.md` ("When the load completes") now names both configuration error codes, and
  `shared` gained `unusable_stop_times` in `CONFIGURATION_ERROR_CODES`.
- **Gotchas.** `vi.waitFor` keeps the last failed assertion, whose "actual" value is retained: the heap
  release test compares a boolean, not the object, or the WeakRef never clears. `csv-parse` needs
  `relax_quotes` for feeds with stray quotes and `max_record_size` so an unterminated quote cannot
  buffer the rest of a file. A `/* global */` comment keeps the benchmark `.mjs` lint-clean (the eslint
  config sets no Node globals).

## Follow-ups
- **trip-engine** consumes `configurationErrors()` (both codes) and must give trips with a null template no
  entries ([trip-activity](../specs/behaviors/trip-activity.md#schedule-entries)); open point for it and
  `trips-api`: the dashboard `configurationErrors.total` and `items` for a trip with both problems (two
  items, one trip). Not filed: no issue tracker access.
- **Speed.** Reading `stop_times.txt` and `shapes.txt` as arrays instead of keyed objects would roughly
  halve the load time of very large feeds (csv-parse measured 5.3 s vs 11.1 s for 2 M rows); not done to
  keep one row shape. Not filed.
- **Folder-nested archives.** A feed zipped inside a single top-level folder is rejected with `missing_file`;
  accepting it would be a spec change (the spec reads top-level files). Not filed.
- **container-image / ci-cd.** The production install must be `npm ci --omit=dev` (fixtures and
  `fflate` are devDependencies of the server; `@gtfs-rt-debugger/shared` is a dependency);
  `npm run build -w server` does not build fixtures.
