# Screen: Schedule Loader

## Route
The site root (`/`). It is the only screen.

## Data Requirements
- User input: one GTFS Schedule URL and up to three optional GTFS-RT URLs.
- The schedule archive fetched from the schedule URL, summarized per
  [gtfs-schedule-summary](../behaviors/gtfs-schedule-summary.md).

## Display Rules

**Form.** Four labeled URL fields, in this order, all of type `url`:
1. GTFS Schedule URL (a `.zip`) — required
2. GTFS-RT Trip Updates URL — optional
3. GTFS-RT Vehicle Positions URL — optional
4. GTFS-RT Service Alerts URL — optional

and a submit button. Only the schedule URL is required; any combination of the three
realtime fields, including none, may be left empty. A realtime field that is filled in must
still be a valid URL.

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
- **Realtime feeds** — the GTFS-RT URLs that were entered, labeled by feed type, noting they
  are not fetched yet. Feeds left empty are not listed; when none were entered, this section
  is omitted.

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
