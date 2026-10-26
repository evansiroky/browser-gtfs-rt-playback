# @gtfs-rt-debugger/server

The single Node.js process: JSON API under `/api/v1`, realtime feed polling, the in-memory
snapshot store, the session lifecycle, and static serving of the built web app. Behavior is
specified in [`specs/`](../specs/README.md); this file documents the implementation contract.

```bash
npm run build -w server && npm start -w server   # node server/dist/main.js, port 8080
npm test -w server                               # Vitest (builds shared, fixtures and server first)
```

The default port 8080 is what the web app's Vite dev proxy targets (`API_PROXY_TARGET`) and what
Cloud Run conventionally provides through `PORT`.

## Environment

Read once at startup by `loadConfig(env)` (`src/config.ts`, a pure function of the env object).
Any problem refuses start with exit code 1 and a message that names the variable, never its
value. Empty values count as unset. Durations are milliseconds, sizes bytes.

| Variable                      | Default                         | Meaning                                                            |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `SCHEDULE_URL`                | required                        | GTFS Schedule zip URL                                              |
| `VEHICLE_POSITIONS_URL`       | one of the two required         | GTFS-RT VehiclePositions URL                                       |
| `TRIP_UPDATES_URL`            | one of the two required         | GTFS-RT TripUpdates URL                                            |
| `PORT`                        | `8080`                          | Listen port (all interfaces); `0` picks a free port                |
| `POLL_INTERVAL_MS`            | `10000`                         | Realtime poll interval                                             |
| `RT_TIMEOUT_MS`               | `8000`                          | Realtime fetch timeout (whole exchange)                            |
| `RT_MAX_BYTES`                | `26214400` (25 MiB)             | Realtime body limit, after content decoding                        |
| `SCHEDULE_TIMEOUT_MS`         | `120000`                        | Schedule download timeout (whole exchange; parsing is not timed)   |
| `SCHEDULE_MAX_BYTES`          | `104857600` (100 MiB)           | Schedule download limit, on the body as received (after gzip)      |
| `SCHEDULE_MEMORY_LIMIT_BYTES` | `805306368` (768 MiB)           | Schedule memory limit: estimated peak of the decoded data          |
| `IDLE_TIMEOUT_MS`             | `900000` (15 min)               | Inactivity timeout                                                 |
| `MAX_ACTIVATION_MS`           | `7200000` (2 h)                 | Maximum activation duration                                        |
| `EXIT_ON_IDLE`                | `false`                         | `true`/`false` (or `1`/`0`); the deployment sets `true`            |
| `RETENTION_MS`                | `3600000` (60 min)              | Realtime retention; above 60 min is clamped to 60 (with a warning) |
| `HISTORY_MEMORY_LIMIT_BYTES`  | `536870912` (512 MiB)           | Realtime history limit; must be ≥ 2 × `RT_MAX_BYTES`               |
| `RATE_LIMIT_PER_MIN`          | `120`                           | `/api/v1` requests per minute per client                           |
| `TILE_HOST`                   | `https://tiles.openfreemap.org` | Map tile origin allowed by the CSP; must match the web app's style |
| `WEB_DIST_DIR`                | `<repo>/web/dist`               | Built web app (default is relative to the server module, else cwd) |

Rules (`specs/behaviors/configuration.md`):

- Sizes, the port and the rate limit are positive integers (`PORT` may be `0`).
- Every duration (`*_MS`) is between 1000 and 2147483647 (the longest Node timer; larger values
  would silently fire after 1 ms).
- Feed URLs are `http`/`https` and may not carry credentials before the host
  (`https://user:pass@…`); put keys in the query string.
- `TILE_HOST` is an `http`/`https` origin: no path, query or credentials (a leading `*.` host
  wildcard is allowed).

Feed URLs are held as `SecretUrl`s: only the fetch code calls `reveal()`, and `String()`,
`JSON.stringify`, `util.inspect` and loggers see `[redacted]`. As a backstop, the log stream
scrubs every fragment of every configured feed URL (the URL, its path, query string, credentials
and query values) before writing.

## Behavior notes

- **Clock.** All behavior timers go through the injected `Clock`; internal instants are epoch
  **milliseconds**, converted to epoch seconds only in responses (`toEpochSeconds`). The only
  raw timer is the process-level drain deadline below.
- **Session.** `start` wakes unconditionally; `ping` wakes unless the last activation ended by
  `max-duration`. Both reset the inactivity timer in every state. The inactivity timer also runs
  from process start. On timeout: forget everything, then, with `EXIT_ON_IDLE`, close the server
  and exit 0; once that has begun, session requests no longer wake anything. With `EXIT_ON_IDLE`
  off the process stays up, dormant (`endedReason: "idle"`; an idle timeout during a
  `max-duration` lock clears the lock to `null`). Waking clears `endedReason`, so an active status
  always reports `null`.
- **Shutdown is bounded.** On idle exit and on `SIGTERM`/`SIGINT` the server stops accepting
  connections and lets in-flight requests finish, but exits after at most 5 s
  (`DRAIN_DEADLINE_MS`) regardless. Requests that still arrive on open connections while closing
  are answered normally (dormant status, envelopes) rather than with a bare `503`; the next
  request reaches a fresh instance (Cloud Run). Slow clients are cut off by Node: headers within
  10 s, the whole request within 15 s (checked every second), so neither the drain nor the
  platform's request concurrency can be held by slow connections.
- **Crash policy.** `main.ts` logs any unhandled rejection or uncaught exception and exits 1 at
  once: a half-working process must not linger.
- **Extension hooks are isolated.** Store listeners and `ScheduleProvider` calls run through
  `runHook` (`src/hooks.ts`): a throw is logged and contained. The store prunes before it
  announces a snapshot; the session sets its own state before calling any hook; pollers start
  independently of `schedule.start()`. A throwing provider call makes the schedule report
  `failed` with code `internal_error` until a later call succeeds (a session start retries).
- **Schedule.** `ScheduleLoader` (`src/schedule/`) downloads the schedule once per activation
  and reduces it to a `ScheduleStore` (see [Schedule store](#schedule-store)). States
  `idle → loading → ready | failed`; `idle` only while dormant. A session start downloads at wake
  and never again for that activation, whatever later starts, pings and time do. If a load fails,
  one automatic retry follows 30 s later on the injected clock; if that fails too the schedule stays
  `failed` until a session `start` (`retry()`) loads it again, which gets its own single automatic
  retry. While `failed` the status carries the error; while loading (a retry included) it carries
  none. Dormancy (`discard()`) aborts the download or parse in flight, drops the store and cancels
  the retry timer; a load that still finishes afterwards is ignored. Realtime polling never waits
  for the schedule.
  The body is kept as the chunks it arrived in (at most `SCHEDULE_MAX_BYTES`, never one contiguous
  copy) and read with `yauzl` (zip64 and data descriptors included) and streamed through
  `csv-parse`; nothing is written to disk. Only top-level files of the archive are read
  (`agency.txt`, `routes.txt`, `trips.txt`, `calendar.txt`, `calendar_dates.txt`,
  `frequencies.txt`, `stop_times.txt`, `shapes.txt`); a feed zipped inside a folder fails with
  `missing_file`. Error codes (all URL-free): `http_status_<n>`, `timeout`, `too_large` (download
  limit or memory limit), `network_error`, `too_many_redirects`, `redirect_not_allowed`,
  `missing_file` (names the file), `bad_zip`, `bad_csv` (names the file), `invalid_schedule` (a
  required column or the agency timezone is missing or unusable) and `internal_error`.
- **Schedule memory limit** is checked against a running estimate of the heap the load holds at its
  peak. Everything kept is charged by the size of its text, however long: the rows of routes, trips and
  frequencies, agency names, service ids, trip ids, polylines and shape ids, and the raw points of the
  shape being encoded (every shape of an ungrouped `shapes.txt`). Values that are only parsed are kept
  as numbers (stop times, calendar dates) and their text is dropped. It is calibrated to sit above the
  measured heap (see the benchmark below). The downloaded body itself is not counted: it is bounded by
  `SCHEDULE_MAX_BYTES` and dropped once parsed.
- **Reading the archive is bounded too.** The download limit and timeout cover only the download, so
  the inflated bytes of the files that are read may not exceed `DECOMPRESSION_FACTOR` (8) x
  `SCHEDULE_MAX_BYTES` (`too_large`), and reading must finish within `PARSE_TIMEOUT_FACTOR` (4) x
  `SCHEDULE_TIMEOUT_MS` (`timeout`, measured on the injected clock from the end of the download).
  Both are checked on the inflated stream itself, so a file of blank lines or a zip bomb stops at the
  limit, and a `discard()` stops a parse at once, not at the next row. The factors are constants in
  `src/schedule/loader.ts`, not settings. An archive with more than 10 000 entries is `bad_zip`; only the
  eight GTFS files are indexed.
- **Unreadable cells are not repaired.** A `shapes.txt` point whose latitude or longitude is not a
  number in range, or whose `shape_pt_sequence` is not a number, is skipped; a shape without a valid
  point has no polyline. A `stop_times.txt` row whose `stop_sequence` is not plain digits (`0x10`, `1e1`,
  `-1` are not), and rows of trips absent from `trips.txt`, are skipped; `frequencies.txt` rows of
  unknown trips are dropped. A time that is not `H:MM:SS` (minutes and seconds 00-59) counts as missing.
  A `calendar.txt` row whose `start_date` or `end_date` is not `YYYYMMDD` is ignored, as is a
  `calendar_dates.txt` row whose date is not, or whose type is not 1 or 2. For a repeated `route_id` or
  `trip_id` the first row wins; for a service date both added and removed by `calendar_dates.txt` the
  addition wins.
- **Realtime.** One poller per configured feed: a fetch at wake, then a fixed-cadence interval;
  a tick is skipped while the previous fetch is in flight. Redirects are followed manually (≤ 3,
  `http`/`https` only, and never away from the configured origin to an internal host:
  `localhost`, `*.internal`, or a literal loopback, link-local, private or unspecified IP). The
  size limit is enforced on the decoded body while it streams (gzip, deflate, brotli). Error
  codes: `http_status_<n>`, `timeout`, `too_large`, `too_many_redirects`, `redirect_not_allowed`,
  `network_error`, `decode_failed`. A feed is `stale` when its last success (or, if none, the
  start of polling) is more than 3 intervals old.
- **History memory** is approximated as the sum of the raw protobuf byte lengths of retained
  snapshots (decoded messages are never retained). Eviction is oldest-first across both feeds
  but never takes a feed's latest snapshot; the ≥ 2 × `RT_MAX_BYTES` rule means that never
  breaks the limit.
- **Rate limit.** Fixed one-minute window per client, starting at its first request. The client
  is the last `X-Forwarded-For` entry (the one the platform's proxy appends), else the socket
  address; IPv6 clients are keyed by /64. At most 10 000 clients get their own window; expired
  ones are swept oldest-first in amortized O(1). When all slots are live, new clients share one
  overflow window, so a flood of fresh addresses can never reset an already-limited client.
- **Logging.** JSON (pino) to stdout; per-request lines are disabled to keep log volume flat.
- **Static.** Files present in `WEB_DIST_DIR` at startup are served (`/assets/*` as immutable,
  everything else `no-cache`). Any other `GET`/`HEAD` outside `/api` returns `index.html`, except
  a missing static file (anything under `/assets/`, or a top-level name with an extension such as
  `/favicon.ico`), which is a plain-text 404. Client routes deeper than one segment, like
  `/trips/a.b`, always get the app. `/api` and `/api/*` never fall through: unknown endpoints get
  a `404 not_found` envelope.
- **Headers.** Every response: `Content-Security-Policy` (self plus `TILE_HOST` in `connect-src`
  and `img-src`, `blob:` workers, `data:`/`blob:` images, inline styles), `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`. Every `/api/v1` response, including router failures
  such as a malformed URL (`400 bad_request`): `Cache-Control: no-store`. Route parameters may be
  up to 1000 characters (long GTFS trip IDs).
- Session endpoints take no body; send none (an empty body with `Content-Type: application/json`
  is a `400`).

## Schedule store

`ScheduleLoader.store` (`src/schedule/loader.ts`) is the loaded `ScheduleStore`
(`src/schedule/store.ts`), or `null` unless the loader is `ready`. The trip engine and the trips API
read it through the `services` slot (`services.loader.store`) and must treat `null` as "not ready"
(data endpoints get that from `guard.requireSchedule`). It is immutable and replaced wholesale by a
later activation, so do not keep a reference past a request.

```ts
interface ScheduleStore {
  agency(): { names: readonly string[]; timezone: string }; // every agency_name; first row's timezone
  trip(tripId): Row | undefined; // whole trips.txt row (Row = Readonly<Record<string, string>>)
  route(routeId): Row | undefined; // whole routes.txt row
  frequencies(tripId): readonly Row[]; // whole frequencies.txt rows, file order; [] if none
  template(tripId): TripTemplate | null; // { startSecs, endSecs } from the service day base
  trips(): IterableIterator<ScheduleTrip>; // { id, row, template, frequencies }, trips.txt order
  operatesOn(serviceId, serviceDate: 'YYYYMMDD'): boolean;
  shape(shapeId): string | null; // the precision-6 polyline, exactly as served
  configurationErrors(): readonly { code: ConfigurationErrorCode; tripId: string }[];
  counts(): { trips; routes; shapes; estimatedBytes };
}
```

- **Templates.** `startSecs` is the departure (else arrival) of the stop with the lowest
  `stop_sequence`; `endSecs` the arrival (else departure) of the one with the highest, in seconds from
  the service day's "noon minus 12 h" (values above 86 400 are normal). `stop_times.txt` need not be
  sorted. A trip with no usable template (no stop times at all, or a first stop with neither departure
  nor arrival, or a last stop with neither arrival nor departure, or only rows whose `stop_sequence`
  is unusable) has `template: null` and is listed as an `unusable_stop_times` configuration error.
- **`operatesOn`.** The weekday flag of `calendar.txt` within `start_date`..`end_date` inclusive, then
  `calendar_dates.txt`: type 1 adds a date, type 2 removes it. A service only in `calendar_dates.txt`
  operates exactly on its type 1 dates. Unknown services never operate.
- **Configuration errors** (trip-activity.md "Schedule entries"). Computed once at load, in
  `trips.txt` order: `mixed_exact_times` when the trip has more than one `frequencies.txt` row and their
  `exact_times` (absent or empty counting as `0`) are not all equal; `unusable_stop_times` when its
  `template` is null. A trip with both problems appears twice, `mixed_exact_times` first. They never
  fail the load.
- **Shapes** are held only as encoded strings. `shapes.txt` is encoded while it streams: a file
  grouped by `shape_id` holds one shape's raw points at a time; the first time a `shape_id` returns
  after other shapes' rows, the file is known to be ungrouped and is read again, buffering all shapes
  (counted toward the memory limit) and encoding each when the file ends.

## Trip engine

`TripEngine` (`src/trips/engine.ts`) is the pure logic behind the dashboard and the trips API
(trip-activity.md). `buildApp` creates it as `context.trips`, after the `PingStore` (which exists
before the first snapshot and forgets with the store on dormancy), with the clock, the
`SnapshotStore`, the provider's `store` and the configured feeds. Its three calls return the shared
API types:

- `dashboard()` - a `DashboardResponse` (schedule-dependent fields null while the schedule is not
  ready; `configurationErrors.total` counts errors, so a trip with two codes counts twice; the active
  entries are counted by arithmetic and entries are made only for the trips the references name).
- `list(name)` - a `TripListResponse`; throws `ScheduleNotReadyError` before the schedule is ready.
- `detail(tripId)` - a `TripDetailResponse`, or `null` when the trip ID is in neither the schedule nor
  the retained realtime data (a latest-snapshot reference or a retained ping).

The routes (`src/api/dashboard.ts`, `src/api/trips.ts`, mounted in `main.ts` beside the shapes route)
only validate and serialize: `GET /dashboard` needs an active server (`guard.requireActive`);
`GET /trips?list=` and `GET /trips/{tripId}` need the schedule (`guard.requireSchedule`). Unknown or
repeated query parameters and a missing or unknown `list` are `400 bad_request` before any state
check; a detail with no match is `404 trip_not_found`. Lists are unpaginated: 5,000 active rows are
about 1.1 MB of JSON, computed and serialized in about 50 ms.

Every call reads the schedule, the latest snapshots (decoded again from their bytes), the pings and the
clock afresh; nothing derived from time or from realtime data is kept. The one structure that outlives a
call is `ScheduleIndex` (`entries.ts`), the entries ordered by start second plus the entries per service
and the configuration errors per trip: a pure function of the immutable store, held in a `WeakMap` keyed
by it, so it goes with the store at dormancy. It makes "active this minute" and "scheduled today" cost
the active items and the services rather than every trip.

- **Time** (`time.ts`) is `Intl.DateTimeFormat` in the agency zone: the service day starts at local noon
  minus 12 hours of elapsed time, and the candidate dates are today and yesterday as the agency clock reads
  them. On the evening before a spring-forward day the next service day has already started (23:00) while
  "today" is still the day before, so its early trips are not looked at until midnight.
- **Entries.** A plain trip is one entry, identified by its trip ID. A frequency trip is one entry per
  nominal instance of each readable row (GTFS times, a positive whole `headway_secs`), identified by trip
  and start instant: instances are counted and found by arithmetic. A row that could have more than 2,000
  instances running at once (`MAX_CONCURRENT_INSTANCES`, `schedule/frequency.ts`) makes the trip a
  `frequency_too_dense` configuration error at load, with no entries, so no request enumerates more than
  2,000 instances per row. Only trips whose instants can repeat (rows with overlapping windows, or
  instances more than 23 h apart, which can meet the next date's own) are enumerated and de-duplicated:
  the first row in the file describes an instant, the later service date owns it, and a plain trip
  active on both candidate dates is one entry on the later. A trip with a configuration error has none.
  Rows that cannot be read produce no instances and stay in the trip detail with null values.
- **References** come from the latest snapshot of each feed; an absent optional field is null, never the
  decoder's default 0. `start_date` must be a real `YYYYMMDD` date; `start_time` is parsed with
  `parseGtfsTime` (hours may pass 24, a single digit is fine) and an unreadable one matches no instance;
  a vehicle timestamp of 0 is none.
- **Pings** (`pings.ts`): `PingStore` listens to the snapshot store and keeps an **index**, not decoded
  pings: per ping its identity (trip, vehicle, timestamp), sequence number, first receipt and the byte range
  of its entity in the newest retained snapshot that contains it (`entityRanges` walks the snapshot's
  bytes once; a snapshot it cannot walk keeps each entity's own bytes). `forTrip` decodes those entities
  and builds the fields then (ascending by sequence; fields beyond the typed ones pass through under their
  camelCase names, `vehicle`, `trip` and `position` holding the leftovers of those messages). A ping lasts
  as long as a retained snapshot contains it; the index (about 200 bytes plus the key per ping, about
  twice the entity's protobuf size for a realistic entity) is reserved against the history memory limit
  (`SnapshotStore.reserveMemory`), the latest snapshot of each feed is never evicted, and sequences per trip
  ID restart only at dormancy. A vehicle timestamp of 0 is none (the header's, then the receive time).
- **List 3 rows** are grouped by trip ID (and start for frequency trips); a group naming several service
  dates takes the latest and the reason is worked out from that reference. `realtime.vehicleIds` is in
  order of appearance (vehicle positions, then trip updates), without references that lack a vehicle ID.
- **Empty cells** in `trips.txt` and `routes.txt` (`trip_headsign`, `route_short_name`, `route_long_name`,
  `route_id`, `shape_id`) are reported as null (an empty `route_id` is no route, so the reference's is
  used); the trip and route rows themselves are returned whole. No array of unbounded length is spread into
  a call (130 000 references to one trip are fine).

## Benchmark

`scripts/bench-schedule.mjs` (not part of `npm test`; needs `npm run build -w server`) generates a
synthetic schedule with a streaming zip writer — by default 100 000 trips, 2 000 000 stop times and
4 000 shapes of 500 points (2 000 000 points) — in a temp directory, then loads it in a fresh
process with the real parser, in 64 KiB chunks like a download.

```bash
node --expose-gc server/scripts/bench-schedule.mjs [--dir DIR] [--trips N] [--stops N]
     [--shapes N] [--points N] [--limit BYTES] [--ungrouped] [--keep]
```

It prints peak RSS, peak and retained heap (after a forced GC), the loader's own estimate, the
worst event-loop stall, and checks that shapes are strings. `--ungrouped` interleaves the points of
all shapes to exercise the buffered path; `--limit` shows the `too_large` abort. The numbers measured
for this implementation are in [`plans/schedule-loader.md`](../plans/schedule-loader.md).

`scripts/bench-trips.mjs` (same rules) times the trip engine over a synthetic schedule built straight
into a `MemoryScheduleStore` (default 100 000 trips, 10% of them frequency trips) with a vehicle
positions and a trip updates snapshot (default 5 000 and 3 000 entities, mostly naming active trips):

```bash
node server/scripts/bench-trips.mjs [--trips N] [--vehicles N] [--updates N] [--runs N] [--zone TZ] [--now ISO]
     [--frequency SHARE] [--ghost SHARE]
```

It prints the first call (which builds the schedule index) and p50/p95/max of each list, the dashboard
and a trip detail. The numbers measured are in [`plans/trip-engine.md`](../plans/trip-engine.md).

## Threat model

The site is public and unauthenticated by design, so the API does not try to tell its own pages
from other clients (no `Origin`/`Sec-Fetch-Site` checks): anyone can call it with `curl`. Cost and
abuse are bounded instead by the per-client rate limit, the maximum activation duration, the
single instance, and the request size and time limits above. Feed URLs never leave the server.

## Extension points

Later plans plug in through `buildApp(options)` (`src/app.ts`) and wire their pieces in
`src/main.ts`. A worked example (`ScheduleLoader` and `shapesRoutes` are real, see `src/main.ts`; the
other names stand in for what `trip-engine` and `trips-api` add):

```ts
interface Services {
  loader: ScheduleLoader; // implements ScheduleProvider; `loader.store` is the query API
  pings: PingStore;
  engine: TripEngine;
}

const { app } = await buildApp<Services>({
  config,
  exit: () => process.exit(0),
  // Built once, first. deps: { config, clock, logger, store }.
  services: ({ config, clock, logger, store }) => {
    const loader = new ScheduleLoader({ config, clock, logger });
    const pings = new PingStore();
    return { loader, pings, engine: new TripEngine({ loader, pings, store, clock }) };
  },
  // deps plus the built services.
  schedule: ({ services }) => services.loader,
  // Called once with the full context, before routes are registered.
  init: ({ store, services }) => {
    store.onSnapshot((snapshot, message) => services.pings.record(snapshot, message));
    store.onEvict((snapshot) => services.pings.expire(snapshot));
    store.onClear(() => services.pings.clear());
  },
  routes: [shapesRoutes, dashboardRoutes, tripsRoutes],
});

// Each route plugin is typed against the same services.
export const shapesRoutes: ApiRoutes<Services> = (api, { services, guard }) => {
  api.get(
    '/shapes/:shapeId',
    { preHandler: [rejectUnknownQuery([]), guard.requireSchedule] },
    async (request) => {
      const { shapeId } = request.params as { shapeId: string };
      const polyline = services.loader.store?.shape(shapeId) ?? null;
      if (polyline === null) throw new ApiError(404, 'shape_not_found', 'No such shape.');
      return { shapeId, encoding: 'polyline6', polyline };
    },
  );
};
```

What each export guarantees:

- **`Clock`, `systemClock`, `FakeClock`, `settle`, `toEpochSeconds`** (`src/clock.ts`). `now()`
  (epoch ms), `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`. `FakeClock.advance(ms)`
  fires due timers synchronously in due order; `advanceAsync(ms)` lets promises and local I/O
  settle around each timer.
- **`ScheduleProvider`, `ScheduleStatus`, `noopScheduleProvider`**
  (`src/session/schedule-provider.ts`). `start()` at wake; `retry()` when a session start arrives
  while the schedule is `failed`; `discard()` at dormancy (abort and drop everything); `status()`
  → the `schedule` block of `SessionStatus`. The default always reports `idle`. A throw from any
  of them is contained (see above). Read the effective status with `session.scheduleStatus()`.
- **`SnapshotStore`, `Snapshot`, `FeedKind`, `FeedMessage`, `decodeFeed`**
  (`src/realtime/snapshot-store.ts`). `latest(feed)`, `all(feed)` (oldest first),
  `historyStartsAt()` (epoch ms or null). `Snapshot`: `feed`, `receivedAt` (epoch ms),
  `feedTimestamp` (header, epoch **s**, or null), `bytes`, `decode()` (fresh decode each call).
  Listeners are synchronous and each `on*` returns an unsubscribe function:
  `onSnapshot((snapshot, decodedMessage) => …)` after pruning,
  `onEvict((snapshot, 'retention' | 'memory') => …)`, and `onClear(() => …)` at dormancy (no
  `onEvict` per snapshot then).
- **`buildApp`, `AppOptions<S>`, `ServiceDeps`, `ScheduleDeps<S>`** (`src/app.ts`). Order:
  `services(deps)` → `schedule({ ...deps, services })` → session → `init(context)` → routes.
- **`ApiRoutes<S>`, `ServerContext<S>`, `API_PREFIX`** (`src/http/api.ts`). Route plugins are
  registered inside the `/api/v1` scope (register `/dashboard`, not `/api/v1/dashboard`), which
  provides rate limiting, `no-store`, the error envelope and `not_found`. `context`: `services`,
  `config`, `clock`, `logger`, `store`, `schedule`, `session`, `guard`.
- **`DataEndpointGuard` (`context.guard`), `rejectUnknownQuery(allowed)`** (`src/http/guards.ts`).
  preHandler hooks: `guard.requireActive` → `409 session_not_active` while dormant;
  `guard.requireSchedule` → that, then `409 schedule_not_ready` unless the schedule is `ready`;
  `rejectUnknownQuery([...])` → `400 bad_request` for any other or repeated query parameter.
  Guards only read state (never wake, never reset the timer).
- **`ApiError`, `errorBody`** (`src/http/errors.ts`). `throw new ApiError(404, 'trip_not_found',
'No such trip.')` from any route or hook. Anything else thrown becomes `500 internal_error`
  (logged, not described).
- **`boundedFetch`, `fetchAll`, `FetchError`** (`src/fetch/bounded-fetch.ts`). Fetch a
  `SecretUrl` with `{ clock, timeoutMs, maxBytes, signal? }`: chunks as an async generator (or one
  buffer), redirect rules as above, size enforced while streaming. Failures are
  `FetchError { code, message }` with no URL and no `cause`; `toStatusError()` gives the
  `{ code, message }` for status responses.
- **`runHook`** (`src/hooks.ts`) for any further extension calls; **`closeThenExit`,
  `installCrashPolicy`** (`src/shutdown.ts`).
- **`Config`, `loadConfig`, `SecretUrl`** (`src/config.ts`, `src/secret-url.ts`): see
  [Environment](#environment).

Test helpers (not built): `src/test-support/`. `testApp(env, options)` builds the real app with a
`FakeClock`, captured logs and a spy `exit`; `startFeedHost()` is a real localhost HTTP feed host;
`encodeFeed()` encodes a GTFS-RT message with `gtfs-realtime-bindings`.
