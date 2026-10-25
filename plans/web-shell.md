---
status: planned
depends: [workspace]
specs:
  - specs/architecture.md
  - specs/behaviors/client-activity.md
  - specs/api/session.md
  - specs/api/conventions.md
issues: []
---

# Plan: Web app shell

## Scope
In: the `web` package — Vite + React + TypeScript + Tailwind + **shadcn/ui**, routing, the typed
API client, the session/activity controller (start, ping, pause/resume), session banners,
agency-time formatting helpers, a dev proxy to the server, and placeholder pages for `/` and
`/trips/:tripId`.

Out: the dashboard content ([`dashboard-screen`](dashboard-screen.md)) and trip detail content
([`trip-detail-screen`](trip-detail-screen.md)); static serving from the server (done in
[`server-core`](server-core.md)); the Dockerfile ([`container-image`](container-image.md)).

## Implements
- `behaviors/client-activity.md`: engaged = visible **and** interaction within 60 s; start on
  page load, ping every 10 s while engaged; pause everything (pings and data polling) when
  hidden or after 60 s without interaction; immediate **ping** (not start) + refetch on
  resume; "Paused — …" notice with reason; `max-duration` → "session ended" with **Restart**.
- `api/session.md` / `api/conventions.md` client side: typed calls, error envelope handling.
- `architecture.md` Stack: React + Vite, shadcn/ui, a data-fetching library with interval
  refetch that can be paused, MapLibre dependency declared for later (not used yet).
- `principles.md`: Stale-with-age (keep last data, show ages) and Agency-local time (a
  `formatAgencyTime` helper that never uses the browser zone).

## Approach
- `web/`: Vite config (dev proxy `/api` → the server port), Tailwind, `components.json`,
  path aliases, router with the two routes, TanStack Query with a paused-aware polling wrapper.
- **shadcn/ui components are hand-added**: the shadcn registry (`ui.shadcn.com`) is not
  reachable from this environment, so write the needed components (button, card, badge, alert,
  collapsible, table, input, tabs, skeleton, tooltip, scroll-area, separator) by hand following the
  standard shadcn/ui source (Radix primitives + `class-variance-authority` + `tailwind-merge`
  + `clsx`, `cn()` helper, `new-york` style, CSS variables theme incl. dark mode).
- `src/session/`: a framework-free `ActivityController` (state: starting / engaged / paused-hidden /
  paused-idle / ended) driven by an injectable clock and event source, plus React bindings
  (`useSession`) and the `SessionBanner` component.
- `src/api/`: typed client using `shared` types, throwing a typed `ApiError`; helper `pollWhileEngaged`.
- `src/lib/time.ts`: `formatAgencyTime(epochSeconds, tz, opts)`, age formatting ("12 s ago").
- Tests: Vitest + Testing Library; the controller is tested exhaustively with fake timers.

## Validation
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass (root and `web`).
- [ ] Controller tests: start on load; ping every 10 s only while engaged; hidden tab pauses
      immediately; 60 s without interaction pauses; interaction/visibility resumes with a single
      ping + refetch; `max-duration` never auto-restarts; Restart calls start; ping failures keep last state.
- [ ] Banner component renders each state from `SessionStatus` fixtures (paused-hidden,
      paused-idle, ended, schedule loading/failed, stale feed) with correct text and actions.
- [ ] `formatAgencyTime` is correct for a non-browser zone and across DST; tests set the process
      TZ differently to prove independence.
- [ ] `npm run dev -w web` serves the app against a running server; a screenshot (Playwright
      chromium at `/opt/pw-browsers`) of `/` shows the shell with a working banner.
- [ ] shadcn components present as source files under `web/src/components/ui` and used by the shell.

## Risks / unknowns
- **No shadcn CLI** — hand-written components must match upstream behavior/accessibility; keep
  them small and Radix-based.
- **Interaction events** — passive listeners, throttled; map drag/zoom counts as interaction.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
