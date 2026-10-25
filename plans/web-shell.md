---
status: done
pr: 3
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
- [x] `npm run lint`, `typecheck`, `test`, `build` pass (root and `web`).
- [x] Controller tests: start on load; ping every 10 s only while engaged; hidden tab pauses
      immediately; 60 s without interaction pauses; interaction/visibility resumes with a single
      ping + refetch; `max-duration` never auto-restarts; Restart calls start; ping failures keep last state.
- [x] Banner component renders each state from `SessionStatus` fixtures (paused-hidden,
      paused-idle, ended, schedule loading/failed, stale feed) with correct text and actions.
- [x] `formatAgencyTime` is correct for a non-browser zone and across DST; tests set the process
      TZ differently to prove independence.
- [ ] `npm run dev -w web` serves the app against a running server; a screenshot (Playwright
      chromium at `/opt/pw-browsers`) of `/` shows the shell with a working banner.
- [x] shadcn components present as source files under `web/src/components/ui` and used by the shell.

## Risks / unknowns
- **No shadcn CLI** — hand-written components must match upstream behavior/accessibility; keep
  them small and Radix-based.
- **Interaction events** — passive listeners, throttled; map drag/zoom counts as interaction.

## Notes
- **Validation item 5 is left unchecked.** `npm run dev -w web` was exercised (Vite dev server, `/api` proxied to a throwaway mock API in the scratchpad) and screenshots
  at 1280 px and 390 px (light and dark) show the shell, with no horizontal scroll, and working
  banners: schedule loading, schedule failed with Retry, stale feed, paused-idle, and ended with
  Restart (which restarts the session and clears the banner). The real server was not available,
  so "against a running server" is unverified.
- **Versions** (resolved at build time, ranges in `web/package.json`): Vite 8, React 19,
  react-router 7 (`BrowserRouter`/`Routes`), TanStack Query 5, Tailwind 4 (`@tailwindcss/vite`,
  `tw-animate-css`), unified `radix-ui` 1.8, lucide-react 1, Vitest 5, Testing Library 16.
  **Node floor stays >=22.12** (root `engines`, floating `.nvmrc`). That is why **react-router is
  pinned to ^7** (v8 needs Node >=22.22) and **jsdom to ^28** (29/30 need >=22.13 / >=22.22.2).
  Checked by walking `engines.node` of every package installed from a clean `npm install`
  against Node 22.12.0: the only package that does not allow it is the transitive
  `eslint-visitor-keys@5.0.1` (>=22.13) under typescript-eslint, which comes from the base
  lockfile, not from `web`. (Tests now run on jsdom 28 from a clean install; an earlier stale
  `node_modules` had hoisted jsdom 30.) `maplibre-gl` ^6 is declared and unused (the map is a later plan).
- **shadcn/ui** is hand-written in the `new-york` style (Tailwind v4 flavour, `data-slot`
  attributes, `radix-ui` package). Dark mode follows `prefers-color-scheme` through
  `@custom-variant dark (@media (prefers-color-scheme: dark))` with the variables redefined in a
  media query; there is no theme toggle. Only the components the shell uses were added: button,
  alert, badge, card, skeleton, separator, tooltip. The plan's list also named collapsible,
  table, input, tabs and scroll-area; they are unused by the shell, so the screen plans that need
  them should add them.
- **Controller design.** `ActivityController` is framework-free with an injected `Clock`
  (`FakeClock` in tests); its phases are `starting | engaged | paused-hidden | paused-idle |
  ended`. `ended` is derived from the latest status (`dormant` + `max-duration`) and outranks the
  pauses; while ended nothing is sent, not even on resume, until `restart()` (a start). Ticks
  never stack on an in-flight request; pausing aborts it and ignores a late answer. Interaction
  events are passive, capturing and throttled to one per second (`bindDomActivity`).
- **Spec clarifications** (commit `docs(specs): clarify client-activity ...`): a page loaded in a
  hidden tab starts only once visible; becoming visible counts as an interaction; the resume
  refetch fires when the resume ping is answered (the snapshot's `resuming` flag gates polling,
  so a server the ping just woke is ready); until a start has succeeded, the resume request and
  each cadence tick are starts, so a failed first start is retried; nothing is sent while ended.
- **Data polling.** `useEngagedQuery`/`pollWhileEngaged` enable a query only when engaged,
  not resuming, and the server `active`, with `refetchInterval` 10 s; the `enabled` false-to-true
  flip is the immediate refetch on resume. Failures keep the last `data`/`dataUpdatedAt`
  (React Query default), and `retry` is off because the cadence is the retry.
- **Banner.** One banner, precedence: ended, paused, unreachable (network error, 5xx, timeout, or
  a 2xx that is not a `SessionStatus`), schedule failed, schedule loading, stale feed. Other
  session errors (for example 429) show no banner. Errors (ended, unreachable, schedule failed)
  use `role="alert"`; paused, loading and stale use `role="status"`. Ended counts as an error
  because the session stopped and needs the person to act. Stale-feed ages use the browser clock against server instants.
- **Review fixes (second pass).** (1) A cadence tick that fires late (slept machine, throttled
  tab) now checks the clock and pauses instead of pinging before the idle timer has run.
  (2/3) react-router 7 and the corrected engines statement above. (4) The header badge is
  focusable (`tabIndex=0`), so its tooltip opens from the keyboard. (5) Live-region roles as
  above, the conflicting `aria-live` removed. (6) Session start/ping bodies are validated
  (object with `state` in dormant/active and `schedule`/`realtime` objects); anything else is a
  `parse` error that counts as unreachable. (7) The request timeout and caller-abort signals are
  built with a plain `AbortController` and `setTimeout` (cleaned up when the request ends)
  instead of a feature-detected `AbortSignal.any`/`timeout`: one code path that works everywhere,
  tested with and without those statics. (8) After a failed Restart the ended banner keeps its
  precedence and adds "Restart failed — can't reach the server. Try again."; the note clears on
  the next attempt (`restartFailed` in the controller snapshot).
- **Network check.** The production build served through `vite preview` made requests only to
  its own origin while loading `/` and `/trips/:tripId`.
- **Dev note.** React StrictMode runs the provider effect twice in development, so the dev server
  receives two start requests on load (the first is aborted); production sends one.
- **Time.** `formatAgencyTime` formats with `Intl.DateTimeFormat` and an explicit `timeZone`,
  `hourCycle: 'h23'`; tests flip `process.env.TZ` between zones (and also pass under an external
  `TZ=`) and cover both 2026 New York DST transitions. It throws `RangeError` on an unknown zone.
- **Lockfile.** `web`'s dependencies change `package-lock.json`; that change is not committed
  here (the orchestrator regenerates it when merging).
- Measured: production build is about 390 kB JS (125 kB gzip) and 25 kB CSS.

## Follow-ups
None.
