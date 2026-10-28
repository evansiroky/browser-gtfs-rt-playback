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
  `calendar_dates.txt`; `frequencies.txt` (all columns); `shapes.txt` reduced to one encoded polyline per
  shape ([data-model](../data-model.md#shape)); and from
  `stop_times.txt` only each trip's first and last stop time
  ([data-model](../data-model.md#scheduled-trip)). All other files and columns are
  discarded while streaming.
- Shapes are **encoded while streaming**: each shape's points are ordered by
  `shape_pt_sequence` and encoded to a precision-6 polyline, and the raw points are discarded
  as soon as their shape is encoded, so only a single shape's raw points are ever held (a
  file grouped by `shape_id` streams straight through; an ungrouped file is buffered per
  shape, which counts toward the schedule memory limit). A point whose latitude or longitude
  is not a number in range is skipped.
- Decoded schedule data is bounded by the schedule memory limit; exceeding it aborts the
  load with a `too_large` error.
- Missing required files (`agency.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, and at
  least one of `calendar.txt` / `calendar_dates.txt`) fail the load with a descriptive,
  feed-URL-free error. `frequencies.txt` and `shapes.txt` are optional; without them there
  are no frequency trips and no shapes.
- The archive is bounded beyond the download limit: inflating more than 8 × `SCHEDULE_MAX_BYTES`
  fails the load as `too_large`, parsing longer than 4 × `SCHEDULE_TIMEOUT_MS` as `timeout`, and an
  archive of more than 10,000 entries as `bad_zip`. Only files at the archive's top level are read.
  Rows the loader cannot use (a repeated `trip_id`/`route_id` after the first, malformed dates or
  times, a non-numeric `stop_sequence`) are skipped or treated as absent.
- On failure, one automatic retry follows after 30 s. If that also fails, the schedule
  stays `failed` until a start retries it. Realtime polling continues regardless.
- While the schedule is not ready, realtime snapshots are still collected; only
  schedule-dependent figures are unavailable.
- When the load completes, trips whose `frequencies.txt` rows have mixed `exact_times` values
  (`mixed_exact_times`), trips whose first and last stop times are unusable
  (`unusable_stop_times`: no `stop_times.txt` rows, or no departure or arrival at the first
  stop, or no arrival or departure at the last) and trips with a row that could have too many
  instances running at once (`frequency_too_dense`) are recorded as configuration errors
  ([trip-activity](trip-activity.md#schedule-entries)), in `trips.txt` order. A trip with several
  problems is recorded under each code, in the order listed here. They do not fail the load.
- A trip listed in `frequencies.txt` keeps its first and last stop time as a template
  ([trip-activity](trip-activity.md#schedule-entries)); `trips.txt` rows referencing a
  `shape_id` absent from `shapes.txt` are kept and simply have no geometry.

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
- Redirects are followed up to 3 hops, to `http`/`https` only, and never away from the
  configured URL's origin to an internal host: `localhost`, a `.internal` name (such as the
  cloud metadata server), or a literal loopback, link-local, private-range or unspecified IP
  address. The configured URL itself is the operator's choice and is not restricted.
  Responses may be gzip-encoded.

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
  stop times are reduced to first/last per trip and shapes to one encoded polyline each while
  streaming.
