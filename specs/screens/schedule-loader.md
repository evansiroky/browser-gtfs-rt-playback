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
- **Realtime feeds** — the GTFS-RT URLs that were entered, labeled by feed type, noting
  their contents are not read yet. Feeds left empty are not listed and not checked; when none
  were entered, this section is omitted. A feed whose access check failed shows its own
  warning directly under its entry (see Realtime access check); feeds that passed show no
  message.

## Actions
- **Submit** — validates the fields (native browser validation is sufficient), then downloads
  and parses the schedule in the browser and renders the result or an error. Each entered
  realtime URL is access-checked at the same time as the schedule download.

## Errors
Failures are shown as a single message, distinguishing at least:
- the download failed at the network level — most commonly because the host does not allow
  cross-origin requests (CORS); the message says so as a likely cause;
- the server answered with a non-success HTTP status (include the status);
- the response is not a valid zip archive;
- a required file (`agency.txt`, `routes.txt`, `stops.txt`) is missing from the archive.

## Realtime access check
Each non-empty realtime URL is checked on its own for whether this page is allowed to read a
response from it:
- **Passes** when response headers arrive and are readable by the page, whatever the HTTP
  status. The body is not read and not downloaded in full.
- **Fails** when the request errors at the network level (the signature of a missing CORS
  header, a bad URL, or no connection) or no response headers arrive within 10 seconds.
- A failure produces exactly one warning for that feed, naming the feed type and giving the
  most likely cause (the host does not allow cross-origin requests, CORS) and the other
  possible causes (bad URL, timeout, no network). Two failing feeds produce two warnings.
- Empty fields are never checked and never warn.
- A warning is not an error: the schedule summary still shows, and one feed's result does not
  affect another's. If the schedule itself fails to load, its error replaces the result and
  no realtime warnings are shown.

## Navigation
None; single screen.

## Principles

**Local**
- Show the real cause of a failure over a generic "something went wrong". The commonest
  failure (CORS) is not the user's mistake and must not look like one.
