# Behavior: Feed ingest

## Rule
While active, the server downloads the GTFS Schedule once and polls each configured
realtime feed on a fixed cadence. Ingestion is bounded in time, size, and concurrency.

## Schedule
- Downloaded **once per activation**, at wake. Not refreshed during the activation.
- Fetched with the schedule fetch timeout; aborted if the body exceeds the download size
  limit. Streamed — the zip is never fully buffered as one contiguous allocation beyond
  what the limit permits.
- Only the data the rules need is kept ([Retain only what a screen shows](../principles.md#retain-only-what-a-screen-shows)):
  `agency.txt`; `routes.txt` (all columns); `trips.txt` (all columns); `calendar.txt` and
  `calendar_dates.txt`; and from `stop_times.txt` only each trip's start and end
  ([data-model](../data-model.md#scheduled-trip)). All other files and columns are
  discarded while streaming.
- Missing required files (`agency.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, and at
  least one of `calendar.txt` / `calendar_dates.txt`) fail the load with a descriptive,
  feed-URL-free error.
- On failure, one automatic retry follows after 30 s. If that also fails, the schedule
  stays `failed` until a start retries it. Realtime polling continues regardless.
- While the schedule is not ready, realtime snapshots are still collected; only
  schedule-dependent figures are unavailable.
- `frequencies.txt` is ignored; trips defined by it are treated as single trips running
  per their `stop_times.txt` rows as written.

## Realtime
- Each configured feed is fetched every poll interval (default 10 s), on its own timer,
  starting immediately at wake. Cadence is fixed: a slow or failed fetch does not shift the
  next tick, and a tick is skipped (not queued) while the previous fetch for that feed is
  still in flight.
- Each fetch has the realtime fetch timeout (8 s) and response size limit (25 MiB); a
  violation counts as a failed fetch.
- A successful, decodable response becomes a snapshot recorded with its feed header
  timestamp and the server receive time. An undecodable body is a failed fetch.
- A failed fetch records the error (feed-URL-free) and attempt time and leaves the previous
  snapshots untouched ([Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking)).
  A realtime feed is considered **stale** when its latest successful fetch is older than
  three poll intervals.
- Redirects are followed up to 3 hops, to `http`/`https` only. Responses may be gzip-encoded.

## Never exposed
No error message, status field, or log line includes a feed URL or its query string.
Errors are reported as a code and a generic message (for example `http_status_404`,
`timeout`, `too_large`, `decode_failed`).

## Principles
**Inherited**
- [The server fetches](../principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts)
  — this behavior is the only place feed hosts are contacted.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — one
  schedule download per activation, hard size and time limits, no queued fetches.
- [Retain only what a screen shows](../principles.md#retain-only-what-a-screen-shows) —
  stop times are reduced to start/end per trip while streaming.
