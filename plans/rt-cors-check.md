---
status: done
depends: [schedule-loader-poc]
specs:
  - specs/architecture.md
  - specs/screens/schedule-loader.md
issues: []
pr: 2
---

# Plan: GTFS-RT CORS access check

## Scope
In: probing each entered GTFS-RT URL for cross-origin readability when the form is submitted,
with one warning per failing feed. Out: reading or decoding feed bodies, distinguishing CORS
from other network failures (the browser does not expose that), HTTP-status warnings.

## Implements
- `specs/screens/schedule-loader.md` — "Realtime access check", the Realtime feeds display
  rule, and the Submit action.
- `specs/architecture.md` — RT URLs are probed, not decoded.

## Approach
- `src/feeds.js` — `checkFeedAccess(url)`: GET with an `AbortController`; resolves true when
  headers arrive (any status), false on a network error or a 10 s timeout; aborts after headers
  so the body is not downloaded. `fetchImpl`/`timeoutMs` are injectable for tests.
- `src/main.js` — start checks for non-empty RT fields concurrently with the schedule download;
  render one `.warning` under each failing feed's row; blank fields are skipped entirely.

## Validation
- [x] `npm test` passes, including pass-on-any-status, fail-on-network-error, fail-on-timeout,
      and abort-after-headers cases.
- [x] In a real browser, with one host sending CORS headers and one not: three failing feeds
      give three separate warnings; one OK and two failing give exactly two; a single failing
      feed with two blanks gives one; all OK gives none.
- [x] A CORS-enabled feed that returns 404 gives no warning; all fields blank omits the
      Realtime section; a failing schedule shows only its error and no RT warnings.
- [x] A visual check shows each warning directly under its own feed row.

## Risks / unknowns
- **Warning can't name the cause** — a missing CORS header, a bad URL and no network all look
  alike to `fetch`, so the message lists CORS as the likely cause and the others as possible.
- **Probe cost** — a GET on a large feed may start a transfer before the abort lands; the
  abort limits it to roughly the headers plus whatever is already in flight.

## Notes

- Checks run concurrently with the schedule download, so a slow feed adds at most the 10 s
  timeout to the wait, and only when it is slower than the schedule download.

## Follow-ups

None.
