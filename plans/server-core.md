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
- **Spec amendments (each its own `docs(specs):` commit, ahead of the code).**
  `api/conventions.md`: `404 not_found` for unknown endpoints/methods (the plan wanted an envelope
  404 but the table had no code; `shared` gained `'not_found'` in `API_ERROR_CODES`), and IPv6
  clients are rate-limited by /64. `behaviors/configuration.md`: the server refuses durations
  outside 1 s..2,147,483,647 ms (Node timers wrap above that), a tile host that is not an http(s)
  origin, feed URLs with userinfo (fetch cannot use them; credentials go in the query string), and
  a history limit below 2 × the realtime response limit. `behaviors/feed-ingest.md`: redirects
  never leave the configured origin for an internal host (`localhost`, `*.internal`, literal
  loopback/link-local/private/unspecified IPs).
- **Env contract.** The plan's list plus `SCHEDULE_TIMEOUT_MS`, `SCHEDULE_MAX_BYTES`,
  `SCHEDULE_MEMORY_LIMIT_BYTES` (read by the schedule loader from `Config`) and `WEB_DIST_DIR`.
  `PORT` defaults to 8080 (the web dev proxy's target), `EXIT_ON_IDLE` to `false`, `TILE_HOST` to
  `https://tiles.openfreemap.org`. Full table in `server/README.md`.
- **Extension points for later plans.** `buildApp<S>({ services, schedule, init, routes })`:
  `services(deps)` is built first and reaches `init` and every route as a typed
  `context.services`; `schedule({ ...deps, services })` picks the provider (e.g. the loader);
  `init(context)` runs once before routes (store subscriptions). Guards, `rejectUnknownQuery`,
  `ApiError`, `boundedFetch` and `runHook` are documented with a worked example in the README.
- **Failure containment.** Store listeners and schedule provider calls run through `runHook`
  (logged, contained). The store prunes before announcing a snapshot and never evicts a feed's
  latest snapshot for memory; the session sets its state before calling hooks and starts pollers
  independently of `schedule.start()`; a throwing provider reads as schedule `failed`
  (`internal_error`) until a later call succeeds. `main.ts` exits 1 on any unhandled rejection or
  exception.
- **Bounded shutdown.** Idle exit and SIGTERM drain with a hard 5 s deadline (a real unref'd timer,
  deliberately not the injected clock). Node cuts off slow headers at 10 s and whole requests at
  15 s, checked every second. I kept `forceCloseConnections` at its `'idle'` default rather than
  `true`, so in-flight responses still get to finish; the deadline is what bounds the drain.
  `return503OnClosing: false` means requests that arrive while closing get normal answers with our
  envelope and headers. Router failures (malformed URL, a parameter over 1000 characters) return
  the envelope with `no-store` and the CSP.
- **Session decisions.** Waking clears `endedReason`. The inactivity timer also runs from process
  start. Once an idle exit begins, nothing wakes the session. With exit-on-idle off, an idle
  timeout during a `max-duration` lock clears the lock.
- **Realtime decisions.** Error codes beyond the spec's examples: `too_many_redirects`,
  `redirect_not_allowed`, `network_error`. A feed that has never succeeded is `stale` after 3
  intervals. Size caps apply to the decoded stream (gzip, stacked gzip and brotli bombs are
  tested). Memory is approximated by raw protobuf bytes. The soak run found a real leak: the
  snapshot's `decode` closure shared a scope with the listener closure, so every decoded
  FeedMessage stayed alive. Fixed, and a `--expose-gc` regression test covers it.
- **Rate limiting** keys on the last `X-Forwarded-For` entry, and IPv6 by /64. Up to 10 000 live
  windows are tracked; expired windows are swept oldest-first in amortized O(1). When every slot
  is live, new clients share one overflow window, so a flood can't reset an already-limited client.
- **Static.** A missing file (under `/assets/`, or a top-level name with an extension) gets a
  plain 404. Deeper client routes (`/trips/a.b`) and `HEAD` get `index.html`.
- **Versions.** `fastify ^5.12.7`, `@fastify/static ^10.1.7`, `gtfs-realtime-bindings ^2.2.0`
  (which pulls in `protobufjs-cli` at runtime; most of the lockfile growth). `npm audit --omit=dev`: 0.
- **Evidence (rebased tree: shared + web + server).** `npm install`, `lint`, `typecheck`, `test`
  (shared 37, server 164, web 118), `build` and `format:check` all pass. 5 consecutive server
  runs were green. All 17 mutations of the new rules fail tests (listed in the PR report).
  Reviewer scripts: `fetchattack.mjs` gives `too_large` for the gzip, stacked-gzip, brotli and
  endless bodies, `timeout` for the drip, `too_many_redirects` for the loop, and
  `redirect_not_allowed` for the metadata and loopback-port redirects. No error text or stack
  contains the URL or key.
  `soak.mjs` (6 simulated hours, about 1 MiB snapshots on both feeds): retained bytes plateau at
  511 MB; heapUsed is flat at 14–15 MB (783 MB before the leak fix); RSS is about 711 MB (about
  1.7 GB before); after clear, arrayBuffers drop to 0. Process smoke test: start/ping statuses,
  CSP with the default tile host, a plain 404 for a missing asset, an envelope for a malformed
  URL, SIGTERM with a slow client attached exits 0 after 5.0 s, `EXIT_ON_IDLE` with a slow client
  exits 0 at about 7.3 s (2 s idle + 5 s deadline), and no secret appears in the logs.
- **Not verified by an automated test:** that Node cuts off a slow request with 408 at about 15 s
  (that would be a 16 s test). The drain bound does not depend on it, and that bound is tested.

## Follow-ups
- Tracked as: (not filed; builders cannot file issues) confirm on the first Cloud Run deploy that
  `X-Forwarded-For` puts the client address last; if the platform appends more hops, adjust the
  trusted hop count in `server/src/app.ts`.
