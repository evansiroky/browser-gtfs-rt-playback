---
status: done
pr: 3
depends: [dashboard-screen]
specs:
  - specs/screens/trip-detail.md
  - specs/api/shapes.md
issues: []
---

# Plan: Trip detail screen

## Scope
In: the `/trips/:tripId` screen exactly as specified — scheduled trip/route/frequency tables,
configuration-error display, latest trip update, the MapLibre map with the trip's shape and the
numbered ping markers, and the collapsible pings list with marker↔row selection.

Out: anything not in the spec (stops, stop times, other layers).

## Implements
`specs/screens/trip-detail.md`: route without query parameters; 10 s refresh only while engaged
and the shape fetched **once per page view** (again only if `activatedAt` or `shapeId`
changes); header with a label per `classification` entry; every column of the trips.txt,
routes.txt and frequencies.txt rows; nominal-departure note for `exact_times` absent/0; active
instance starts; a template duration that can be null ("cannot be computed", for
`unusable_stop_times`) and frequency rows whose headway or window is null (shown with their columns
and a note that they cannot be read); prominent configuration-error alert for all three codes
(`mixed_exact_times`, `unusable_stop_times`, `frequency_too_dense`: a headway so short that more than
2,000 instances of a row could run at once); trip update block; map shown when there is
a shape or a ping with coordinates, shape drawn from the **decoded precision-6 polyline** under
round markers labeled with the server's `sequence`, fit-to-content that stops refitting once the
user moves the map, the "no pings / history begins" messages, the "no shape / shape not in
shapes.txt" messages; pings list collapsed by default "Vehicle positions (N)", rows with local
time (seconds), vehicle ID/label and all available fields (absent omitted); marker click expands
the list, scrolls and highlights the row and opens a popup; row click highlights the marker and
pans; paused notice, not-found and session banners.

## Approach
- `web/src/pages/TripDetail.tsx`, `TripMap.tsx` (MapLibre GL JS; style URL from a single constant
  that tests can override, defaulting to `https://tiles.openfreemap.org/styles/liberty` — the same
  origin as the server's `TILE_HOST` setting, which the CSP allows; keep them in agreement; shape as a GeoJSON line source; markers as DOM markers or a symbol layer
  — pick whichever keeps clicks and numbering accessible), `PingsList.tsx`, `ScheduledTripCard.tsx`,
  `FrequencyTable.tsx`, `KeyValueTable.tsx`.
- Use `decodePolyline6` from `shared`. Do not recompute ping numbers client-side.
- Extend the [`dashboard-screen`](dashboard-screen.md) e2e harness: scenarios for a plain trip with
  pings and a shape, a frequency instance, a mixed-`exact_times` trip (error alert), an unknown
  realtime-only trip (no schedule section, markers only), a trip with no shape, a trip with a
  shape missing from `shapes.txt`, marker/row selection, list expand/collapse, 404.
- MapLibre needs WebGL: run Chromium with software GL flags in e2e; stub the style/tiles with a
  minimal inline style (tile hosts are unreachable here).

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` pass; `npm run e2e` passes including the new scenarios.
- [x] The shape line is drawn from the decoded polyline (assert source data vs. the server's polyline); markers carry exactly the ping `sequence` numbers and update on refresh without renumbering.
- [x] Marker click and row click interactions behave exactly as the Actions section states.
- [x] The map does not refit after the user pans/zooms; it does fit on first load to shape + markers.
- [x] Shape is requested once per page view (asserted by counting requests across several refreshes).
- [x] A frequency trip with `unusable_stop_times` shows no template duration and an error; a row with a
      null headway or window shows its columns and the note; a `frequency_too_dense` trip shows its error.
- [x] All tables show every column from the API response; absent ping fields are omitted; times use the agency timezone.
- [x] Screenshots at desktop and phone widths reviewed; no horizontal page scroll.

## Risks / unknowns
- **WebGL in headless Chromium** — may need flags; if the map cannot render in CI-like
  environments, unit-test the map component logic and keep the e2e screenshot as local evidence (note in closeout).
- **Many overlapping markers** — no clustering in v1 (spec); selected marker is drawn on top.

## Notes
- **Map.** `maplibre-gl` 6.16.0 (already in the web workspace; no dependency change), loaded as a lazy chunk
  (`trip-map`, 1,087 kB / 295 kB gzip, plus a 519 kB worker file, as separate assets) so the dashboard bundle stays
  434 kB / 138 kB gzip. The style URL is `MAP_STYLE_URL` in `web/src/lib/map-style.ts`, derived from `MAP_TILE_HOST`
  (`https://tiles.openfreemap.org`, the server's `DEFAULT_TILE_HOST`); there is no per-instance override (the e2e
  intercepts that one URL instead). Markers are DOM `<button>`s (so they are
  focusable and have an accessible name); the shape is a GeoJSON line layer under them.
- **CSP change (server).** MapLibre 6 starts its worker from a module file (`setWorkerUrl` with the Vite `?url`
  asset), not a `blob:` URL, so the CSP's `worker-src blob:` blocked the map. It is now `worker-src 'self'`. No spec
  text names this directive; the spec's "only the app's own origin and the configured tile host" still holds. Found by
  the e2e run, which serves the built app with its real CSP.
- **Fit/refit.** The view fits the shape and markers, and refits only when their extent changes and the user has not
  moved the map. A user gesture (any `movestart` with an `originalEvent`, zoom buttons included) or a row click's pan
  counts as moving it.
- **Shape request.** `useShape` is a plain query (not polled), keyed by shape ID and the last known `activatedAt`,
  `staleTime: Infinity`; a `shape_not_found` answer is not retried, network failures are (3 times, 3 s apart).
- **Layout.** Order: header, configuration errors, map, vehicle positions, trip update, scheduled trip and route
  tables, frequencies. Empty feed values show as "(empty)"; computed values sit in a labelled second group of the
  trips table. Tailwind's `scale-*` on a MapLibre marker shifts it (the `scale` property composes with MapLibre's
  positioning), so the selected marker gets a ring instead.
- **Test seams.** The map region exposes `data-shape-points`, `data-shape-first`, `data-shape-last` and
  `data-style-loaded`; each marker has `data-sequence` and `data-selected`. The e2e checks the shape by point count and
  end points against the server's polyline decoded in the test; the exact GeoJSON coordinates are asserted in the
  component test (MapLibre mocked, as jsdom has no WebGL).
- **E2E harness.** Chromium runs with software WebGL (`--use-angle=swiftshader`), and the style request resolves to a
  one-layer local style, so the map really renders. Overlapping markers are not clustered (spec): the e2e clicks a
  marker no later marker covers.
- **Not covered end to end.** The scenario has no trip with an empty `shape_id` and no frequency row with an unreadable
  headway or window; both are covered by component tests (`trip-detail-page.test.tsx`) only.
- Measured (e2e, software GL): full `npm run e2e` (3 files, 30 tests) about 3 min.

## Follow-ups
None.
