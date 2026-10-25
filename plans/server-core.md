---
status: planned
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
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass.
- [ ] Config tests: each missing/invalid setting refuses start; retention above 60 min clamps to 60;
      only-one-RT-feed works; URLs never appear in `String(config)`, logs, or errors.
- [ ] Lifecycle tests with a fake clock: wake on start; ping wakes unless `max-duration`; start
      clears the lock; 15 min without ping → forget everything (+ exit when enabled, not when
      disabled); pings reset the timer in dormant state too; max-duration ends the activation
      while pings continue and subsequent pings do **not** rewake; concurrent callers share one activation.
- [ ] Poller tests against an in-test HTTP server: cadence, skip-not-queue, timeout, oversize,
      redirects (≤3, scheme restricted), gzip, garbage body → `decode_failed`, last-good retained,
      `stale` after 3 intervals, nothing polled while dormant.
- [ ] Store tests: retention pruning by receive time, memory-limit eviction oldest-first,
      `historyStartsAt`, everything discarded on dormancy.
- [ ] API tests: `POST /api/v1/session/start|ping` return a `SessionStatus` matching `shared` types for
      dormant and active; `no-store`; error envelope; 429 with `Retry-After`; CSP header.
- [ ] Static serving: `GET /` and `/trips/abc` return `index.html` when a build exists; `/api/*`
      never falls through to it.

## Risks / unknowns
- **Timer correctness** — drive everything through the injectable clock; no raw `setTimeout`
  outside it.
- **Exit-on-idle race** — a request arriving as the process exits is served by a new instance on
  Cloud Run; document, don't fight it.
- **Memory accounting** — approximate by buffer bytes; document the approximation.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
