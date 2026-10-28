---
status: done
depends: [server-core, schedule-loader, trips-api]
specs:
  - specs/behaviors/logging.md
issues: []
---

# Plan: Server-side logging

## Scope
In: the log events of [`logging.md`](../specs/behaviors/logging.md) — fetch start/outcome,
realtime and schedule parse start/outcome, each schedule file read, session ping and start,
`/api` request received, response sent and request aborted.

Out: a configurable log level (`LOG_LEVEL`); logging of static-file requests; the client address;
metrics or tracing.

## Implements
- `behaviors/logging.md`: every row of the Fetches, Parsing and Client requests tables, with the
  listed levels and fields; the "no feed URL, no query string, no client address" rules.

## Approach
- `fetch/bounded-fetch.ts`: take a `logger` and a `feed` name; log started, then completed
  (status, bytes, redirects, duration) or failed (code, duration). Callers: the realtime poller
  and the schedule download, which pass their component logger.
- `realtime/feed-poller.ts`: log the realtime parse around `decodeFeed`.
- `schedule/parse.ts` and `schedule/csv.ts`: `parseSchedule` takes a logger and logs the parse
  and its outcome; `readCsv` takes the logger and logs each file's read: started, then succeeded,
  failed, or stopped (the reader left before the end).
- `session/session-manager.ts`: `ping()` and `start()` log the session state they arrived in.
- `http/request-log.ts`: root-level hooks (`onRequest`, `onResponse`, `onRequestAbort`) for paths
  under `/api`, using Fastify's per-request logger so lines share a `reqId`. Fastify's own
  request logging stays off, so static files remain unlogged.
- Update `server/README.md`'s "Logging" bullet.
- Tests with the capturing logger: each event is emitted with its fields; a failing fetch and a
  failing file log their failure; no line contains a feed URL, its query string or the secret
  fragment in an end-to-end run.

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` and `format:check` pass.
- [x] A realtime poll logs fetch started/completed and parse started/succeeded; a 404, a timeout
      and an undecodable body log the failure with its code.
- [x] A schedule load logs the fetch, the parse, and a started/succeeded pair for each of the
      files read, in order; a missing column or bad CSV logs that file's failure and the parse's.
- [x] `POST /session/ping` logs `api request received`, `session ping received` and
      `api response sent` with one shared `reqId`; a rate-limited and an unknown-path request
      still log their request and response; static-file requests log nothing.
- [x] No captured line contains a feed URL, its query string, or a client address.

## Risks / unknowns
- Log volume: a ping every 10 s per viewer now writes three lines per ping. Bounded by the
  activation cap, and recorded in the spec; revisit if the log bill matters.

## Notes
- A run against the fixture feeds showed `shapes.txt` being read twice (the fixture's shapes are
  not grouped, so `encodeShapes` reads the file again). The first read was logged as a failure;
  the spec gained a `schedule file read stopped` event for it, and the spec's `files` field moved
  from `schedule parse started` to its own `schedule archive opened` event, because the archive is
  not open yet when the parse starts. The aborted-request line dropped `durationMs`: Fastify
  exposes no elapsed time on a request, only on a reply.
- The poller's old `realtime fetch failed` line was removed: `fetch failed` and `realtime parse
  failed` now say the same thing with more detail.
- No PR exists yet, so `pr` is not set. `npm run e2e` was not run; the suite does not read the log.

## Follow-ups
None.
