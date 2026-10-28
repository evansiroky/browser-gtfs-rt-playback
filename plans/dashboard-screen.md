---
status: done
pr: 3
depends: [web-shell, trips-api, test-fixtures]
specs:
  - specs/screens/dashboard.md
issues: []
---

# Plan: Dashboard screen and end-to-end harness

## Scope
In: the `/` screen exactly as specified, and the `e2e` package: a Playwright-driven harness that
boots the fake feeds, the real server, and the built web app, then drives Chromium.

Out: the trip detail screen ([`trip-detail-screen`](trip-detail-screen.md)); production hosting.

## Implements
`specs/screens/dashboard.md`: session banner precedence table, agency block with the agency-local
clock, schedule statistics, realtime statistics (not-configured / loading placeholders, update
ages), **schedule configuration errors** notice (states `configurationErrors.total`, which counts
errors, so a trip with two codes counts twice; expandable trip IDs with the server's message,
including for the new code `frequency_too_dense`; hidden when none), "Active trips with realtime
data" shown as loading while null (no snapshot yet from a configured feed), the
three lists with their count titles, columns, reason texts, frequency-instance rows ("departs
every N min"), empty states, row links to `/trips/{tripId}` (no query), per-list text search,
10-second refresh only while engaged, restart/retry actions.

## Approach
- `web/src/pages/Dashboard.tsx` + components (`StatCard`, `TripTable`, `ReasonLabel`,
  `ConfigErrorsNotice`); data via the paused-aware polling from [`web-shell`](web-shell.md);
  use the `shared` types; keep last data on failures and show ages.
- Search filters client-side over trip ID and route fields; stable keys for duplicate trip IDs
  (instances share a trip ID — key on trip ID + scheduled start).
- `e2e/`: Node script/Playwright-core harness (`npm run e2e`): start `fixtures` fake feeds, start the
  built server with `EXIT_ON_IDLE=false` and short test tunables, serve `web/dist`, launch the
  preinstalled Chromium (`/opt/pw-browsers`). Stub map-tile/style requests (network to tile hosts
  is blocked here). Helper utilities reused by later plans.
- Scenarios: initial load (schedule loading banner → ready), all stats and three lists match the
  scenario's `expected`, reason texts, config-error notice, search, row navigation to
  `/trips/{id}`, flaky RT feed → stale banner with last data kept, pause after 60 s idle (with
  shortened timers) and resume on interaction, max-duration → Restart.
- Capture screenshots into the scratchpad for the review report (not committed).

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` pass.
- [x] `npm run e2e` passes against the fixtures scenario: every statistic equals `expected`.
- [x] Each spec statement in "Display Rules" and "Actions" is covered by a component test or an e2e check.
- [x] The configuration-error notice states `total` (an error count, not a trip count) and lists
      items of all three codes with their messages; "Active trips with realtime data" shows the
      loading placeholder while `activeTripsWithRealtime` is null.
- [x] Reasons use the exact texts from the spec table; duplicate trip IDs (frequency instances)
      render as separate rows without key warnings.
- [x] While paused (hidden or idle), no network requests are made (asserted in e2e).
- [x] Screenshots reviewed at desktop and phone widths: no horizontal page scroll; tables degrade
      gracefully (note any visual follow-ups).

## Risks / unknowns
- **Headless browser flakiness** — keep waits event-based; shorten timers via configuration, not sleeps.
- **Large lists** — thousands of rows; paginate or virtualize in the UI only if rendering is slow (spec forbids truncating the data).

## Notes
- **No spec changes.** The screen was built to `specs/screens/dashboard.md` as written.
- **Data flow.** `web/src/api/queries.ts` holds `useDashboard` and `useTripList`, both on
  `useEngagedQuery`, which gained an `enabled` condition (it can hold polling back, never force it).
  The three lists are fetched only while the session status says `schedule.state = ready`, so after a
  slow schedule load they appear on the ping that reports it (up to 10 s later), not on the dashboard
  response alone: the status is the authority and avoids `409 schedule_not_ready`.
- **Rows** are `<li><a>` grids rather than `<table>` rows so a whole row is one link and phones get
  stacked label/value pairs instead of horizontal scroll. Row keys are trip ID + scheduled start +
  reference start time + reason, plus an occurrence counter, so frequency instances never collide.
- **Not configured vs loading.** A feed counts as unconfigured only when the last status from an
  *active* server had `null` for it; a dormant status (session ended) carries no feeds, so the page
  keeps the last active status for that and for the feed ages.
- **Ages** use the browser clock, like the session banner (`formatAge(ageSeconds(now, t))`).
- **e2e harness** (`e2e/`, `playwright-core` 1.63.0, pinned to the preinstalled Chromium build, run by
  Vitest with files in sequence): `startStack()` starts the fixtures' fake feeds in-process and the
  built server as a child (`EXIT_ON_IDLE=false`, `POLL_INTERVAL_MS=1000`, no rate limit), which also
  serves `web/dist`. `openApp()` stubs every non-app host (map tiles) and logs the page's requests.
  Page timers are moved with Playwright's `page.clock` (`runFor`, `fastForward`), never with sleeps.
  `npm run e2e` builds first, then runs; it is not part of `npm test`. `E2E_PORT_BASE` keeps ports
  in a range, `E2E_SCREENSHOT_DIR` writes screenshots (nothing is committed).
- **Minute alignment.** The server judges "active" from its own wall clock to the minute, so the
  checks against the scenario's `expected` run in a stack started with at least 35 s of the current
  minute left (`alignToMinute`, at most ~25 s of waiting) and fail with a clear message if the minute
  changes mid-run. Whole run: about 70 s.
- **Visual review** (desktop 1280 and phone 390 px): no horizontal scroll (asserted); phone rows stack
  into label/value pairs. A frequency row's "Frequency / departs every N min" note sits under the
  start-end, which makes those rows taller than plain ones; acceptable.
- **Lists of thousands of rows** were not measured; the ages tick once a second and re-render the rows.
- Unverified: the "Can't reach the server" banner is driven by session requests (as in `web-shell`);
  a data endpoint failing alone with a 5xx while pings succeed keeps the last data but shows no banner.

## Follow-ups
- A data request that fails entirely while the session pings succeed does not raise the "Can't reach
  the server" banner (it comes from the session controller only). Tracked as: none filed (no issue access).
- Measure rendering with thousands of rows; paginate or virtualize only if slow. Tracked as: none filed.
