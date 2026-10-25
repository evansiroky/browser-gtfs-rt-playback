# Screen: Trip detail

## Route
`/trips/:tripId` with optional query `serviceDate=YYYYMMDD`. `tripId` is percent-encoded in
the path.

## Data Requirements
- Session pings exactly as on the [dashboard](dashboard.md#data-requirements) (this screen
  keeps the session alive only while engaged,
  [client-activity](../behaviors/client-activity.md)). If the page is loaded directly, it
  calls start first.
- `GET /trips/{tripId}?serviceDate=…` every 10 s while engaged
  ([api/trips.md](../api/trips.md#detail)).

## Display Rules
Times are agency-local ([Agency-local time](../principles.md#agency-local-time)); the
timezone comes from the dashboard endpoint.

**Header** — trip ID, service date, and which list the trip is currently in (as a label),
with the reason when it is in the unscheduled list. A link back to the dashboard.

**Scheduled trip** — present when `scheduled` is not null:
- A table of every column of the trip's `trips.txt` row (column name and value), plus
  scheduled start and end, whether it operates on the service date, and whether it is active
  now.
- A table of every column of the associated `routes.txt` row, headed by the route's short
  and long names. When the route row is missing, it says the route ID is not in `routes.txt`.
When `scheduled` is null the section says the trip ID is not in the schedule.

**Trip update** — when the latest trip updates snapshot has an update for this trip: its
timestamp, delay, vehicle ID, schedule relationship, and the number of stop time updates.
Otherwise it says no trip update is currently present.

**Map** — shown when at least one ping has coordinates. One round marker per ping with
coordinates, labeled with the ping's `sequence` number in small type. The map opens fitted
to all markers and does not refit on later refreshes once the user has moved or zoomed it.
Newly received pings appear as markers on refresh. Clicking a marker selects that ping
(see Actions). With no pings, no map is shown; the page says no vehicle positions have been
received for this trip in the retained history, and states when history begins
(`historyStartsAt`) if it is shorter than an hour.

**Pings list** — a collapsible section, collapsed by default, headed "Vehicle positions
(N)". Expanded, it lists every ping in sequence order (newest last), each row showing: the
sequence number; local time of the vehicle timestamp (with seconds); vehicle ID (and label
when present); and, as available, latitude/longitude, bearing, speed, current status, current
stop sequence and stop ID, occupancy, congestion level, license plate, and any other
passed-through field. Fields that are absent are omitted rather than shown empty. Pings
without coordinates appear in the list and have no marker.

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
