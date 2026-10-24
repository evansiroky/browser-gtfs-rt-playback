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
running: downloading, then parsing, then (only while any realtime check is still outstanding)
checking realtime feeds. A schedule failure shows an error message naming the cause (see
Errors) as soon as it happens, without waiting for the realtime checks. Submitting again
clears the previous result and error.

**Result.** The result has two independent parts. The schedule summary appears only after a
successful load. The realtime feeds section appears whenever any realtime URL was entered,
whether or not the schedule loaded. The summary contains:
- **Agency** — one entry per row of `agency.txt`: name, URL, timezone (omit fields that are
  empty).
- **Routes** — count of routes.
- **Stops** — count of stops.
- **Service dates** — first and last date of service, formatted `YYYY-MM-DD`, as defined in
  the behavior spec; or "unknown" when the feed defines no service dates.

The realtime feeds section lists the GTFS-RT URLs that were entered, labeled by feed type, noting
their contents are not read yet. Feeds left empty are not listed and not checked; when none
were entered, this section is omitted. A feed whose access check failed shows its own
warning directly under its entry (see Realtime access check); feeds that passed show no
message. When the schedule failed, the error appears first and this section follows it.

## Actions
- **Submit** — validates the fields (native browser validation is sufficient), then downloads
  and parses the schedule in the browser and renders the summary or an error. Each entered
  realtime URL is access-checked at the same time as the schedule download, and its outcome is
  shown whether or not the schedule loads.

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
  affect another's.
- The schedule and the realtime feeds are independent. A schedule failure of any kind (CORS
  included) never suppresses the realtime checks or their warnings, and a realtime failure
  never suppresses the schedule summary. A user whose schedule host blocks CORS should still
  learn which of their realtime hosts do too.

## Navigation
None; single screen.

## Principles

**Local**
- Show the real cause of a failure over a generic "something went wrong". The commonest
  failure (CORS) is not the user's mistake and must not look like one.
