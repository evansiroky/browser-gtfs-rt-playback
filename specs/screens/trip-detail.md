# Screen: Trip detail

## Route
`/trips/:tripId`. `tripId` is percent-encoded in the path. The route takes no query
parameters: the page always shows the trip as it is now and over the retained window (at
most the last hour); there is no way to select a date.

## Data Requirements
- Session pings exactly as on the [dashboard](dashboard.md#data-requirements) (this screen
  keeps the session alive only while engaged,
  [client-activity](../behaviors/client-activity.md)). If the page is loaded directly, it
  calls start first.
- `GET /trips/{tripId}` every 10 s while engaged ([api/trips.md](../api/trips.md#detail)).
- `GET /shapes/{shapeId}` once per page view for the trip's `shapeId` (and again only if
  the session's `activatedAt` changes or the trip's `shapeId` changes)
  ([api/shapes.md](../api/shapes.md)).

## Display Rules
Times are agency-local ([Agency-local time](../principles.md#agency-local-time)); the
timezone comes from the dashboard endpoint.

**Header** — trip ID, the derived service date, and a label for each entry in
`classification` (which list, and the reason for the unscheduled list; a trip can carry
several labels, and none if it is in no list). A link back to the dashboard.

**Scheduled trip** — present when `scheduled` is not null:
- A table of every column of the trip's `trips.txt` row (column name and value), plus
  scheduled start and end, whether it operates on the service date, and whether it is active
  now.
- A table of every column of the associated `routes.txt` row, headed by the route's short
  and long names. When the route row is missing, it says the route ID is not in `routes.txt`.
- For a frequency trip, a table of its `frequencies.txt` rows (every column), each with its
  window (agency-local), its template duration, whether it is active now, and the start times
  of its nominal instances active now. Rows with `exact_times` absent or `0` carry a note that
  departures are assumed to be exactly on the headway.
- Each entry of `scheduled.configurationErrors` is shown as a prominent error stating the
  problem ("This trip's frequencies.txt rows mix exact_times values, so its activity cannot be
  determined and it is excluded from schedule counts") above the tables, which still show the
  rows as they are in the feed.
When `scheduled` is null the section says the trip ID is not in the schedule.

**Trip update** — when the latest trip updates snapshot has an update for this trip: its
timestamp, delay, vehicle ID, schedule relationship, and the number of stop time updates.
Otherwise it says no trip update is currently present.

**Map** — shown when the trip has a shape or at least one ping with coordinates.
- The trip's **shape**, when it has one and the schedule contains it, is decoded in the
  browser from its encoded polyline and drawn as a line under the markers. A trip with no `shape_id`, or whose shape is not in `shapes.txt`, has
  no line, and the page says which of the two applies.
- One round marker per ping with coordinates, labeled with the ping's `sequence` number in
  small type. Pings of different vehicles remain individually identifiable by their popup
  and list row (vehicle ID, and start time for frequency instances).
- The map opens fitted to the shape and all markers, and does not refit on later refreshes
  once the user has moved or zoomed it. Newly received pings appear as markers on refresh.
  Clicking a marker selects that ping (see Actions).
- With no pings, the map shows the shape alone (if any) and the page says no vehicle
  positions have been received for this trip in the retained history, and states when
  history begins (`historyStartsAt`) if it is shorter than an hour. With neither shape nor
  pings, no map is shown.

**Pings list** — a collapsible section, collapsed by default, headed "Vehicle positions
(N)". Expanded, it lists every ping in sequence order (newest last), each row showing: the
sequence number; local time of the vehicle timestamp (with seconds); vehicle ID (and label
when present); and, as available, latitude/longitude, bearing, speed, current status, current
stop sequence and stop ID, occupancy, congestion level, license plate, and any other
passed-through field, including the trip descriptor's start date and start time. Fields that
are absent are omitted rather than shown empty. Pings without coordinates appear in the list
and have no marker.

While paused ([client-activity](../behaviors/client-activity.md#paused)) the page keeps its
last data, shows the same paused notice as the dashboard, and resumes on any interaction.
If a refresh fails the page keeps its last data and shows its age
([Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking)). A
`404 trip_not_found` shows a not-found message with a link to the dashboard; a session that
is not active shows the same banners as the dashboard.

## Actions
- Click a marker — selects its ping: the pings list expands if collapsed, scrolls to the row
  and highlights it, and a popup on the marker shows the ping's time and vehicle.
- Click a ping row — selects it: highlights the row and its marker, and pans the map to it.
- Expand/collapse the pings list.

## Navigation
From the dashboard's lists. Back to the dashboard.

## Principles
**Inherited**
- [Show the feed as it is](../principles.md#show-the-feed-as-it-is) — schedule rows are
  displayed column for column and every received vehicle field is shown, including pings
  whose data is incomplete.
- [Agency-local time](../principles.md#agency-local-time) — ping times use the agency clock.

**Local**
- **A ping keeps its number.** Marker and row numbers are the server-assigned ping sequence
  and are never recomputed in the browser, so a number a user noted down still points at the
  same observation after refreshes and after older pings expire.
