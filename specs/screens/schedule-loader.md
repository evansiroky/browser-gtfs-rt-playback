# Screen: Schedule Loader

## Route
The site root (`/`). It is the only screen.

## Data Requirements
- User input: one GTFS Schedule URL and three GTFS-RT URLs.
- The schedule archive fetched from the schedule URL, summarized per
  [gtfs-schedule-summary](../behaviors/gtfs-schedule-summary.md).

## Display Rules

**Form.** Four labeled URL fields, in this order, all of type `url`:
1. GTFS Schedule URL (a `.zip`)
2. GTFS-RT Trip Updates URL
3. GTFS-RT Vehicle Positions URL
4. GTFS-RT Service Alerts URL

and a submit button. Every field is required.

**Status.** While loading, the submit button is disabled and a status line says what stage is
running: downloading, then parsing. On failure, an error message replaces the status line
and names the cause (see Errors). Submitting again clears the previous result and error.

**Result.** After a successful load, show a summary with:
- **Agency** — one entry per row of `agency.txt`: name, URL, timezone (omit fields that are
  empty).
- **Routes** — count of routes.
- **Stops** — count of stops.
- **Service dates** — first and last date of service, formatted `YYYY-MM-DD`, as defined in
  the behavior spec; or "unknown" when the feed defines no service dates.
- **Realtime feeds** — the three GTFS-RT URLs as entered, labeled by feed type, noting they
  are not fetched yet.

## Actions
- **Submit** — validates the fields (native browser validation is sufficient), then downloads
  and parses the schedule in the browser and renders the result or an error.

## Errors
Failures are shown as a single message, distinguishing at least:
- the download failed at the network level — most commonly because the host does not allow
  cross-origin requests (CORS); the message says so as a likely cause;
- the server answered with a non-success HTTP status (include the status);
- the response is not a valid zip archive;
- a required file (`agency.txt`, `routes.txt`, `stops.txt`) is missing from the archive.

## Navigation
None; single screen.

## Principles

**Local**
- Show the real cause of a failure over a generic "something went wrong". The commonest
  failure (CORS) is not the user's mistake and must not look like one.
