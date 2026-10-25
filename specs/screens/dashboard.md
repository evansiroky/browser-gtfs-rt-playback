# Screen: Dashboard

## Route
`/`

## Data Requirements
- Session: `POST /session/start` once on page load, then `POST /session/ping` every 10 s
  while the page is engaged ([api/session.md](../api/session.md)). Pings and polling pause
  when the tab is hidden or after 60 s without interaction, and resume with an immediate ping
  on the next engagement ([behaviors/client-activity.md](../behaviors/client-activity.md)).
- `GET /dashboard` every 10 s while engaged and the session is active
  ([api/dashboard.md](../api/dashboard.md)).
- `GET /trips?list=…` for each of the three lists, every 10 s while engaged, once the
  schedule is ready ([api/trips.md](../api/trips.md)).

## Display Rules
Times are rendered in the agency timezone ([Agency-local time](../principles.md#agency-local-time));
until the timezone is known, no clock time is shown.

**Session banner** (at most one, above everything else):
| Condition | Banner |
|---|---|
| Page paused (hidden tab or 60 s without interaction) | "Paused — …" naming the reason; any interaction resumes ([client-activity](../behaviors/client-activity.md#paused)) |
| Session `dormant` with `endedReason = max-duration` | "Session ended after the maximum running time." with a **Restart** action (calls start) |
| Request to the API fails entirely (network/5xx) | "Can't reach the server." — last data stays visible |
| `schedule.state = loading` | "Downloading the schedule…" (realtime statistics already update) |
| `schedule.state = failed` | the schedule error and a **Retry** action (calls start) |
| Any configured realtime feed `stale` | which feed is stale and the age of its last successful update |

**Agency** — agency name(s) (comma-separated if several), the IANA timezone, and the
current agency-local date and time.

**Schedule statistics** — "Trips scheduled today" and "Trips active this minute".

**Realtime statistics** — "Vehicles", "Vehicles with trip IDs", "Trip updates", and "Active
trips with realtime data". Each shows the last known number. A statistic whose feed is not
configured shows "Not configured"; one awaiting its first snapshot or the schedule shows a
loading placeholder. The time of the latest successful update of each feed is shown beside
the statistics, as an age ("12 s ago").

**Three lists**, each titled with its count:
1. *Active trips with realtime data*
2. *Active trips without realtime data* — these are the scheduled trips that have no
   realtime data
3. *Trips not scheduled this minute, with realtime data*

Columns — lists 1 and 2: trip ID, route (short name, else long name, else route ID),
headsign, scheduled start–end (agency-local, 24-hour). List 1 adds vehicle ID(s) and the
age of the latest sighting. List 3: trip ID, route (as available), vehicle ID(s), age of the
latest sighting, and the reason in plain words:

| Reason | Text |
|---|---|
| `unknown_trip` | "Trip ID not in schedule" |
| `not_in_service` | "Not in service on this date" |
| `missing_start_time` | "Frequency trip, but the feed sent no start time" |
| `unmatched_start_time` | "Start time matches no scheduled departure" |
| `outside_scheduled_time` | "Outside its scheduled time" |

Frequency-based trips are marked in the row. An `exact_times = 1` instance shows its own
start–end and a "departs every N min" note, so the same trip ID may appear on several rows
(one per active instance). A headway-based trip (`exact_times = 0`) is one row, showing its
operating window, "runs every N min", and the vehicles currently on it; its start–end is
the window, not a departure. Order is as returned by the API. An empty list shows an
explanatory empty state, not a blank area.

Every row is a link to the [trip detail](trip-detail.md) of that trip ID. Rows that share a
trip ID share a detail page.

Lists are filterable by a text search over trip ID and route, per list.

## Actions
- **Restart** / **Retry** — start the session / retry the schedule load.
- Click a row — navigate to the trip detail.
- Search within a list.

## Navigation
Entry point of the app. Rows lead to `/trips/{tripId}`.

## Principles
**Inherited**
- [Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking) — when a
  fetch fails the page keeps its last data and shows ages; it never blanks.
- [Show the feed as it is](../principles.md#show-the-feed-as-it-is) — unknown and
  out-of-window trips are listed with a reason, not omitted.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — a
  hidden or untouched page neither pings nor polls, and the page never restarts an expired
  session by itself.
