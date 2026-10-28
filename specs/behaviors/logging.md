# Behavior: Logging

## Rule

The server writes one structured JSON line (to stdout) for each event below, so an operator
reading the log can reconstruct what the server fetched, what it parsed, and what its clients
asked of it. Every line carries a short fixed message (the **Event** column), a level, and the
listed fields in addition to pino's standard ones (time, level, `component`).

No line includes a feed URL or its query string
([never exposed](feed-ingest.md#never-exposed)). Feeds are identified by name — `feed` is
`vehiclePositions`, `tripUpdates` or `schedule` — and failures by their error code, never by a
message that could echo the URL.

## Events

### Fetches

Every contact with a feed host, realtime or schedule, is logged at its start and at its end.

| Event             | Level                                                      | Fields                                                                                  |
| ----------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `fetch started`   | info                                                       | `feed`                                                                                  |
| `fetch completed` | info                                                       | `feed`, `status` (final HTTP status), `bytes` (decoded body), `redirects`, `durationMs` |
| `fetch failed`    | warn (info when `code` is `aborted`: the activation ended) | `feed`, `code` (as in [feed-ingest](feed-ingest.md)), `durationMs`                      |

A fetch is **completed** only once the whole body has been read within the limits; a status
error, timeout, size violation or network failure is **failed**.

### Parsing

| Event                          | Level                                | Fields                                                               |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------------- |
| `realtime parse started`       | info                                 | `feed`, `bytes`                                                      |
| `realtime parse succeeded`     | info                                 | `feed`, `entities`, `feedTimestamp`                                  |
| `realtime parse failed`        | warn                                 | `feed`, `code`                                                       |
| `schedule parse started`       | info                                 | `bytes`                                                              |
| `schedule archive opened`      | info                                 | `files` (the schedule files present in the archive that are read)    |
| `schedule file read started`   | info                                 | `file`                                                               |
| `schedule file read succeeded` | info                                 | `file`, `rows`, `durationMs`                                         |
| `schedule file read failed`    | warn (info when `code` is `aborted`) | `file`, `code`, `durationMs`                                         |
| `schedule file read stopped`   | info                                 | `file`, `durationMs` — the reader stopped before the end of the file |
| `schedule parse succeeded`     | info                                 | `durationMs`, plus the counts logged by `schedule loaded`            |
| `schedule parse failed`        | warn (info when `code` is `aborted`) | `code`, `durationMs`                                                 |

Each file of the schedule that is read gets its own started/outcome pair, in the order
the files are read; files that are not read (absent optional files, every other archive entry)
get no lines. A parse that fails because one file failed logs that file's failure first. A file
whose reader stops before its end — because it reads the file again (`shapes.txt` that is not
grouped by shape) or fails for its own reason (the memory limit) — gets `stopped` in place of
succeeded or failed; a file read again gets a second pair, and the parse's failure, if any,
names the cause.

### Client requests

Only `/api` requests are logged; static files (the web app and its assets) are not.

| Event                    | Level                 | Fields                                                                |
| ------------------------ | --------------------- | --------------------------------------------------------------------- |
| `api request received`   | info                  | `method`, `path` (no query string)                                    |
| `api response sent`      | info (warn for a 5xx) | `method`, `path`, `statusCode`, `durationMs`                          |
| `api request aborted`    | info                  | `method`, `path` — the client went away before the response completed |
| `session ping received`  | info                  | `state` (`active` or `dormant` when it arrived)                       |
| `session start received` | info                  | `state` (as above)                                                    |

`api request received` is logged before the rate limiter and every other check, so a rejected
request (rate limited, unknown endpoint, malformed query) is still seen coming in. A request line
and its response line share a request id (`reqId`), so they can be paired. `api response sent` is
logged once the response has been fully handed to the client, whatever its status; the status
tells the operator whether it was a success.

The session lines are in addition to the request lines: the request lines say a client called,
the session lines say what the session was when it did (a ping that woke the server shows
`dormant`).

## Applies To

The schedule download and parse, the realtime pollers, the session endpoints and every other
`/api/v1` endpoint.

## Details

- Request and ping lines are the bulk of the volume: a viewer's browser pings every 10 seconds
  and polls its data endpoints. Volume is bounded the same way everything else is: lines are
  only produced while someone is viewing, and an activation ends at the activation cap
  ([session-lifecycle](session-lifecycle.md)).
- The client's address and request headers are not logged.

## Principles

**Inherited**

- [The server fetches](../principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts)
  — the log is where the operator sees those fetches, so it names the feed and the error code but
  never the URL.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — more lines
  mean more billed log storage, so every event is bounded by activity (one per fetch, file,
  request) and none carries a payload.
