---
status: planned
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
instance starts; prominent configuration-error alert; trip update block; map shown when there is
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
- [ ] `npm run lint`, `typecheck`, `test`, `build` pass; `npm run e2e` passes including the new scenarios.
- [ ] The shape line is drawn from the decoded polyline (assert source data vs. the server's polyline); markers carry exactly the ping `sequence` numbers and update on refresh without renumbering.
- [ ] Marker click and row click interactions behave exactly as the Actions section states.
- [ ] The map does not refit after the user pans/zooms; it does fit on first load to shape + markers.
- [ ] Shape is requested once per page view (asserted by counting requests across several refreshes).
- [ ] All tables show every column from the API response; absent ping fields are omitted; times use the agency timezone.
- [ ] Screenshots at desktop and phone widths reviewed; no horizontal page scroll.

## Risks / unknowns
- **WebGL in headless Chromium** — may need flags; if the map cannot render in CI-like
  environments, unit-test the map component logic and keep the e2e screenshot as local evidence (note in closeout).
- **Many overlapping markers** — no clustering in v1 (spec); selected marker is drawn on top.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
