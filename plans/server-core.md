---
status: done
pr: 3
depends: [workspace]
specs:
  - specs/architecture.md
  - specs/behaviors/configuration.md
  - specs/behaviors/session-lifecycle.md
  - specs/behaviors/feed-ingest.md
  - specs/behaviors/data-retention.md
  - specs/api/conventions.md
  - specs/api/session.md
issues: []
---

# Plan: Server core

## Scope
In: the `server` package — HTTP app, configuration, session lifecycle (start/ping/idle
shutdown/max duration), realtime feed polling, the retained-snapshot store with retention and
memory limits, the session API, API conventions (envelope, rate limit, headers), static
serving of the web build, and the extension points later plans plug into.

Out: schedule download/parsing and shapes ([`schedule-loader`](schedule-loader.md)); trip logic
and ping extraction ([`trip-engine`](trip-engine.md)); dashboard/trips endpoints
([`trips-api`](trips-api.md)); the web app ([`web-shell`](web-shell.md)).

## Implements
- `behaviors/configuration.md`: all settings, validation, startup refusal, retention clamp.
- `behaviors/session-lifecycle.md`: dormant/active, start vs ping, inactivity timer, 15-minute
  shutdown with exit-on-idle, 2-hour max duration with the no-auto-rewake lock, concurrent
  visitors share one activation.
- `behaviors/feed-ingest.md` "Realtime" and "Never exposed".
- `behaviors/data-retention.md` "Realtime history" and "Forgetting".
- `api/conventions.md` (envelope, error codes, rate limit, `no-store`) and `api/session.md`.
- `architecture.md`: Fastify-style single process, same-origin static serving + SPA fallback,
  CSP header allowing own origin and the configured tile host, secrets never logged.

## Approach
- Fastify, TypeScript, ESM. `server/src`: `config.ts` (env → validated `Config`, redacting
  `toString`/logger serializers for URLs), `clock.ts` (injectable `Clock` with `now()` and
  `setTimeout`-style scheduler so lifecycle tests use fake time), `session/` (state machine),
  `realtime/` (`FeedPoller`, `fetchFeed` with timeout, size cap, ≤3 redirects, http/https only,
  gzip; `SnapshotStore`), `http/` (error envelope, rate-limit hook, security headers, static +
  SPA fallback serving `web/dist` when present), `app.ts` (composition), `main.ts`.
- Env contract (document in the server README): `SCHEDULE_URL`, `VEHICLE_POSITIONS_URL`,
  `TRIP_UPDATES_URL`, `PORT`, and tunables `POLL_INTERVAL_MS`, `RT_TIMEOUT_MS`,
  `RT_MAX_BYTES`, `IDLE_TIMEOUT_MS`, `MAX_ACTIVATION_MS`, `RETENTION_MS`,
  `HISTORY_MEMORY_LIMIT_BYTES`, `RATE_LIMIT_PER_MIN`, `EXIT_ON_IDLE`, `TILE_HOST`; defaults
  from configuration.md.
- `SnapshotStore`: per-feed time-ordered snapshots holding raw protobuf bytes + header
  timestamp + receive time; decode on demand; prune by retention window then by memory limit
  (oldest first); expose `latest(feed)`, `all(feed)`, `historyStartsAt()`, and an
  `onSnapshot`/`onEvict` listener API (used by [`trip-engine`](trip-engine.md)).
- **Extension points** (define interfaces now, ship no-op defaults): `ScheduleProvider`
  (`start()`, `retry()`, `discard()`, `status()` → `schedule` block of `SessionStatus`;
  default reports `state: "idle"`), and a `DataEndpointGuard` helper returning `409
  session_not_active` / `409 schedule_not_ready` for later plans' routes.
- Session manager: single activation; `start` vs `ping` semantics exactly per spec; timers via
  `Clock`; on idle shutdown discard everything and, if `EXIT_ON_IDLE`, call an injected `exit()`
  after in-flight responses drain (graceful); max-duration → dormant + `endedReason:
  "max-duration"` lock, process stays up; ping resets the inactivity timer in every state.
- Pollers: one per configured feed, fixed cadence from wake, skip-not-queue while in flight,
  record `FeedStatus` (attempt/success/feedTimestamp/error code, `stale` after 3 intervals),
  abandon in-flight fetch at dormancy. Errors carry a code (`http_status_404`, `timeout`,
  `too_large`, `decode_failed`) and never a URL.
- Rate limiting per forwarded client address; unknown route → envelope 404; unexpected error →
  `internal_error` with no internals.

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` pass.
- [x] Config tests: each missing/invalid setting refuses start; retention above 60 min clamps to 60;
      only-one-RT-feed works; URLs never appear in `String(config)`, logs, or errors.
- [x] Lifecycle tests with a fake clock: wake on start; ping wakes unless `max-duration`; start
      clears the lock; 15 min without ping → forget everything (+ exit when enabled, not when
      disabled); pings reset the timer in dormant state too; max-duration ends the activation
      while pings continue and subsequent pings do **not** rewake; concurrent callers share one activation.
- [x] Poller tests against an in-test HTTP server: cadence, skip-not-queue, timeout, oversize,
      redirects (≤3, scheme restricted), gzip, garbage body → `decode_failed`, last-good retained,
      `stale` after 3 intervals, nothing polled while dormant.
- [x] Store tests: retention pruning by receive time, memory-limit eviction oldest-first,
      `historyStartsAt`, everything discarded on dormancy.
- [x] API tests: `POST /api/v1/session/start|ping` return a `SessionStatus` matching `shared` types for
      dormant and active; `no-store`; error envelope; 429 with `Retry-After`; CSP header.
- [x] Static serving: `GET /` and `/trips/abc` return `index.html` when a build exists; `/api/*`
      never falls through to it.

## Risks / unknowns
- **Timer correctness** — drive everything through the injectable clock; no raw `setTimeout`
  outside it.
- **Exit-on-idle race** — a request arriving as the process exits is served by a new instance on
  Cloud Run; document, don't fight it.
- **Memory accounting** — approximate by buffer bytes; document the approximation.

## Notes
- **Spec amendments (own `docs(specs):` commits, before the code).** (1) `api/conventions.md` gains
  `404 not_found` for unknown endpoints/methods: the plan asks for an envelope 404 on unknown routes
  but the code table had no code for it. `shared` gains `'not_found'` in `API_ERROR_CODES` (type test
  updated). (2) `behaviors/configuration.md` now states that tunables must be positive whole numbers
  (or on/off), that the history memory limit must be at least twice the realtime response limit (so
  each feed's latest snapshot always fits under eviction), and that error messages name settings,
  never values.
- **Env contract.** The plan's list plus `SCHEDULE_TIMEOUT_MS`, `SCHEDULE_MAX_BYTES`,
  `SCHEDULE_MEMORY_LIMIT_BYTES` (configuration.md "all settings"; read by the schedule loader from
  `Config`) and `WEB_DIST_DIR`. `EXIT_ON_IDLE` defaults to `false` (local); the deployment sets
  `true`. `TILE_HOST` has no default. Full table in `server/README.md`.
- **Session decisions.** Waking clears `endedReason`, so an active status reports `null`. The
  inactivity timer also runs from process start (a process that never gets a session request
  still exits). Once an idle exit begins, start/ping no longer wake (no schedule download in a dying
  process); a racing request gets a dormant status or Fastify's `503` while draining (documented,
  not fought). With exit-on-idle off, an idle timeout during a `max-duration` lock clears the lock
  to `null`, matching what a fresh process would report.
- **Realtime decisions.** Error codes beyond the spec's examples: `too_many_redirects`,
  `redirect_not_allowed`, `network_error`. A feed that has never succeeded is `stale` once polling
  has run for more than 3 intervals. Redirect limits (≤ 3 hops, `http`/`https` only) are tested on
  `boundedFetch`, which the pollers use, plus a redirect loop in the API leak test. The size cap is enforced on the decoded (post-gzip) stream
  while reading (a never-ending response test and a gzip-bomb test prove it). Memory is approximated
  by raw protobuf byte length; decoded messages are never retained. `SnapshotStore` adds an
  `onClear` listener beside `onSnapshot`/`onEvict` so activation-scoped state (the trip engine's
  ping sequences) can reset at dormancy; `onSnapshot` passes the already-decoded message.
- **Rate limiting** keys on the last `X-Forwarded-For` entry (Fastify `trustProxy` trusting one
  hop), so a client-supplied leading entry cannot dodge the limit. This assumes Cloud Run appends
  the client address last; unverified here.
- **Logging.** Feed URLs are `SecretUrl`s (private field; `String`/JSON/`inspect` give
  `[redacted]`), and the pino stream additionally scrubs every URL fragment (URL, path, query,
  credentials, query values of 4+ chars). Request logging is disabled (log volume).
- **Versions.** `fastify ^5.12.7`, `@fastify/static ^10.1.7`, `gtfs-realtime-bindings ^2.2.0`
  (it depends on `protobufjs-cli` at runtime, which accounts for most of the ~1.5k-line lockfile
  growth). `npm audit`: 0 vulnerabilities.
- **Evidence.** From a fresh clone of the branch: `npm ci`, `npm run lint`, `typecheck`, `test`
  (shared 37, server 87 tests), `build`, `format:check` all pass; server tests ran 10x without a
  flake. Mutation checks each fail the suite: ping ignoring the `max-duration` lock (4 tests),
  queueing instead of skipping in-flight ticks (1), removing the streaming size cap (5), allowing a
  4th redirect (1). Process smoke test of `node server/dist/main.js` against a local fake feed:
  start/ping return `SessionStatus` with live feed statuses, `/trips/abc` returns `index.html` with
  the CSP, `SIGTERM` exits 0, `EXIT_ON_IDLE=true IDLE_TIMEOUT_MS=1500` exits 0 by itself after
  logging the idle shutdown, a missing `SCHEDULE_URL` exits 1 naming the variable, and the API-key
  query value never appears in the logs.

## Follow-ups
- Tracked as: (not filed; builders cannot file issues) `TILE_HOST` must be set in the deployment to
  the web app's tile provider origin, or the CSP blocks map tiles. The
  [`terraform-infra`](terraform-infra.md) plan lists the tunables it passes but not `TILE_HOST`, and
  the tile provider constant is chosen by the web plans.
- Tracked as: (not filed) confirm on the first deploy that Cloud Run's `X-Forwarded-For` puts the
  client address last; if it appends more hops, adjust the trusted hop count in `server/src/app.ts`.
