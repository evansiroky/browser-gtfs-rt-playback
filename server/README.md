# @gtfs-rt-debugger/server

The single Node.js process: JSON API under `/api/v1`, realtime feed polling, the in-memory
snapshot store, the session lifecycle, and static serving of the built web app. Behavior is
specified in [`specs/`](../specs/README.md); this file documents the implementation contract.

```bash
npm run build -w server && npm start -w server   # node server/dist/main.js
npm test -w server                               # Vitest (builds shared + server first)
```

## Environment

Read once at startup by `loadConfig(env)` (`src/config.ts`, a pure function of the env object).
Any problem refuses start with exit code 1 and a message that names the variable, never its
value. Empty values count as unset. Durations are milliseconds, sizes bytes.

| Variable                      | Default                 | Meaning                                                                                                                                                        |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEDULE_URL`                | required                | GTFS Schedule zip URL (`http`/`https`)                                                                                                                         |
| `VEHICLE_POSITIONS_URL`       | one of the two required | GTFS-RT VehiclePositions URL                                                                                                                                   |
| `TRIP_UPDATES_URL`            | one of the two required | GTFS-RT TripUpdates URL                                                                                                                                        |
| `PORT`                        | `8080`                  | Listen port (all interfaces)                                                                                                                                   |
| `POLL_INTERVAL_MS`            | `10000`                 | Realtime poll interval                                                                                                                                         |
| `RT_TIMEOUT_MS`               | `8000`                  | Realtime fetch timeout (whole exchange)                                                                                                                        |
| `RT_MAX_BYTES`                | `26214400` (25 MiB)     | Realtime body limit, after gzip decoding                                                                                                                       |
| `SCHEDULE_TIMEOUT_MS`         | `120000`                | Schedule fetch timeout (used by the schedule loader)                                                                                                           |
| `SCHEDULE_MAX_BYTES`          | `104857600` (100 MiB)   | Schedule download limit (schedule loader)                                                                                                                      |
| `SCHEDULE_MEMORY_LIMIT_BYTES` | `805306368` (768 MiB)   | Schedule memory limit (schedule loader)                                                                                                                        |
| `IDLE_TIMEOUT_MS`             | `900000` (15 min)       | Inactivity timeout                                                                                                                                             |
| `MAX_ACTIVATION_MS`           | `7200000` (2 h)         | Maximum activation duration                                                                                                                                    |
| `EXIT_ON_IDLE`                | `false`                 | `true`/`false` (or `1`/`0`); the deployment sets `true`                                                                                                        |
| `RETENTION_MS`                | `3600000` (60 min)      | Realtime retention; values above 60 min are clamped (with a warning)                                                                                           |
| `HISTORY_MEMORY_LIMIT_BYTES`  | `536870912` (512 MiB)   | Realtime history limit; must be ≥ 2 × `RT_MAX_BYTES`                                                                                                           |
| `RATE_LIMIT_PER_MIN`          | `120`                   | `/api/v1` requests per minute per client address                                                                                                               |
| `TILE_HOST`                   | none                    | Map tile origin added to the CSP, e.g. `https://tiles.example.com` (a leading `*.` host wildcard is allowed). Must match the web app's tile provider constant. |
| `WEB_DIST_DIR`                | `<repo>/web/dist`       | Built web app; resolved relative to the server module (`server/dist/../../web/dist`), or to the working directory when set                                     |

Every tunable is a positive integer (`PORT` may be 0). Feed URLs are held as `SecretUrl`s: only
the fetch code calls `reveal()`, and `String()`, `JSON.stringify`, `util.inspect` and loggers see
`[redacted]`. As a backstop, the log stream scrubs every fragment of every configured feed URL
(the URL, its path, query string, credentials and query values) before writing.

## Behavior notes

- **Clock.** All time and timers go through the injected `Clock`; internal instants are epoch
  **milliseconds**, converted to epoch seconds only in responses (`toEpochSeconds`).
- **Session.** `start` wakes unconditionally; `ping` wakes unless the last activation ended by
  `max-duration`. Both reset the inactivity timer in every state. The inactivity timer also runs
  from process start. On timeout: forget everything, then, with `EXIT_ON_IDLE`, close the server
  (in-flight requests drain) and call `exit()`; once that has begun, session requests no longer
  wake anything. A request racing the exit may get a dormant status or a Fastify `503`; the next
  one reaches a fresh instance (Cloud Run). With `EXIT_ON_IDLE` off the process stays up, dormant
  (`endedReason: "idle"`; an idle timeout during a `max-duration` lock clears the lock to `null`).
  Waking clears `endedReason`, so an active status always reports `null`.
- **Realtime.** One poller per configured feed: a fetch at wake, then a fixed-cadence interval;
  a tick is skipped while the previous fetch is in flight. Redirects are followed manually (≤ 3,
  `http`/`https` only); the size limit is enforced while the body streams. Error codes:
  `http_status_<n>`, `timeout`, `too_large`, `too_many_redirects`, `redirect_not_allowed`,
  `network_error`, `decode_failed`. A feed is `stale` when its last success (or, if none, the
  start of polling) is more than 3 intervals old.
- **History memory** is approximated as the sum of the raw protobuf byte lengths of retained
  snapshots (decoded messages are never retained). Eviction is oldest-first across both feeds;
  the ≥ 2 × `RT_MAX_BYTES` rule guarantees each feed's latest snapshot always fits.
- **Rate limit.** Fixed one-minute window per address, starting at its first request; the
  address is the last `X-Forwarded-For` entry (the one the platform's proxy appends), else the
  socket address. At most 10 000 addresses are tracked.
- **Logging.** JSON (pino) to stdout; per-request lines are disabled to keep log volume flat.
- **Static.** Files present in `WEB_DIST_DIR` at startup are served (`/assets/*` as immutable,
  everything else `no-cache`); any other `GET` outside `/api` returns `index.html`. `/api` and
  `/api/*` never fall through: unknown endpoints get a `404 not_found` envelope.
- **Headers.** Every response: `Content-Security-Policy` (self + `TILE_HOST`; `blob:` workers,
  `data:`/`blob:` images and inline styles for MapLibre), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`. Every `/api/v1` response: `Cache-Control: no-store`.
- Session endpoints take no body; send none (an empty body with `Content-Type: application/json`
  is a `400`).

## Extension points

Later plans plug in through `buildApp(options)` (`src/app.ts`) and wire their pieces in
`src/main.ts`:

```ts
const { app, context } = await buildApp({
  config,
  exit: () => process.exit(0),
  schedule: (deps) => new ScheduleLoader(deps), // deps: { config, clock, logger, store }
  routes: [shapesRoutes, dashboardRoutes, tripsRoutes],
});
```

| Export                                                               | Module                               | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Clock`, `systemClock`, `FakeClock`, `settle`, `toEpochSeconds`      | `src/clock.ts`                       | `now()` (epoch ms), `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`. `FakeClock.advance(ms)` fires due timers synchronously in due order; `advanceAsync(ms)` lets promises and local I/O settle around each timer.                                                                                                                                                                                                                                      |
| `ScheduleProvider`, `ScheduleStatus`, `noopScheduleProvider`         | `src/session/schedule-provider.ts`   | `start()` at wake; `retry()` when a session start arrives while `status().state` is `failed`; `discard()` at dormancy (abort and drop everything); `status()` → the `schedule` block of `SessionStatus`. The default always reports `idle`. Built by `options.schedule(deps)` before the session manager.                                                                                                                                                          |
| `SnapshotStore`, `Snapshot`, `FeedKind`, `FeedMessage`, `decodeFeed` | `src/realtime/snapshot-store.ts`     | `latest(feed)`, `all(feed)` (oldest first), `historyStartsAt()` (epoch ms or null). `Snapshot`: `feed`, `receivedAt` (epoch ms), `feedTimestamp` (header, epoch **s**, or null), `bytes`, `decode()` (fresh decode each call). Listeners (synchronous; each returns an unsubscribe function): `onSnapshot((snapshot, decodedMessage) => …)`, `onEvict((snapshot, 'retention' \| 'memory') => …)`, `onClear(() => …)` at dormancy (no `onEvict` per snapshot then). |
| `ApiRoutes`, `ServerContext`, `API_PREFIX`                           | `src/http/api.ts`                    | `ApiRoutes = (api, context) => void \| Promise<void>`, registered inside the `/api/v1` scope (register `/dashboard`, not `/api/v1/dashboard`). The scope provides rate limiting, `no-store`, the error envelope and `not_found`. `context`: `config`, `clock`, `logger`, `store`, `schedule`, `session`, `guard`.                                                                                                                                                  |
| `DataEndpointGuard` (`context.guard`), `rejectUnknownQuery(allowed)` | `src/http/guards.ts`                 | preHandler hooks: `guard.requireActive` → `409 session_not_active` while dormant; `guard.requireSchedule` → that, then `409 schedule_not_ready` unless the schedule is `ready`; `rejectUnknownQuery([...])` → `400 bad_request` for any other or repeated query parameter. Guards only read state (never wake, never reset the timer). Typical: `{ preHandler: [rejectUnknownQuery(['list']), context.guard.requireSchedule] }`.                                   |
| `ApiError`, `errorBody`                                              | `src/http/errors.ts`                 | `throw new ApiError(404, 'trip_not_found', 'No such trip.')` from any route or hook. Anything else thrown becomes `500 internal_error` (logged, not described).                                                                                                                                                                                                                                                                                                    |
| `boundedFetch`, `fetchAll`, `FetchError`                             | `src/fetch/bounded-fetch.ts`         | Fetch a `SecretUrl` with `{ clock, timeoutMs, maxBytes, signal? }`: chunks as an async generator (or one buffer), redirects ≤ 3 to `http`/`https`, size enforced while streaming, gzip decoded. Failures are `FetchError { code, message }` with no URL and no `cause`; `toStatusError()` gives the `{ code, message }` for status responses.                                                                                                                      |
| `Config`, `loadConfig`, `SecretUrl`                                  | `src/config.ts`, `src/secret-url.ts` | See [Environment](#environment).                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Test helpers (not built): `src/test-support/` — `testApp(env, options)` builds the real app with a
`FakeClock`, captured logs and a spy `exit`; `startFeedHost()` is a real localhost HTTP feed host;
`encodeFeed()` encodes a GTFS-RT message with `gtfs-realtime-bindings`.
