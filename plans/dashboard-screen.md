---
status: planned
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
ages), **schedule configuration errors** notice (expandable trip IDs, hidden when none), the
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
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass.
- [ ] `npm run e2e` passes against the fixtures scenario: every statistic equals `expected`.
- [ ] Each spec statement in "Display Rules" and "Actions" is covered by a component test or an e2e check.
- [ ] Reasons use the exact texts from the spec table; duplicate trip IDs (frequency instances)
      render as separate rows without key warnings.
- [ ] While paused (hidden or idle), no network requests are made (asserted in e2e).
- [ ] Screenshots reviewed at desktop and phone widths: no horizontal page scroll; tables degrade
      gracefully (note any visual follow-ups).

## Risks / unknowns
- **Headless browser flakiness** — keep waits event-based; shorten timers via configuration, not sleeps.
- **Large lists** — thousands of rows; paginate or virtualize in the UI only if rendering is slow (spec forbids truncating the data).

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
