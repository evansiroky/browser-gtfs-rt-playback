---
status: done
depends: [rt-cors-check]
specs:
  - specs/screens/schedule-loader.md
issues: []
pr: 2
---

# Plan: Realtime checks independent of schedule failures

## Scope
In: showing the GTFS-RT access results whether or not the schedule loads, including when the
schedule host blocks CORS. Out: any change to how a feed is checked (see
[`rt-cors-check`](rt-cors-check.md)).

## Implements
- `specs/screens/schedule-loader.md` — Status stages, the two independent parts of Result, the
  Submit action, and the independence rule in "Realtime access check".

## Approach
- `src/main.js` — start the realtime checks before the schedule download; run the schedule in
  its own try/catch that shows the error and no summary on failure; then always await the checks
  and append the Realtime feeds section. Split the old `renderResult` into `renderSummary` and
  `renderRealtime`. The submit button re-enables in a `finally`.

## Validation
- [x] With a CORS-blocked schedule host, every failing RT feed still gets its own warning, OK
      feeds get none, and the schedule error is shown above the realtime section.
- [x] Any schedule failure behaves the same: HTTP 404 and a non-zip response also keep the
      realtime section.
- [x] With a schedule failure and all RT fields blank, only the error shows.
- [x] A working schedule is unchanged: summary plus warnings, and summary alone when RT fields
      are blank. Resubmitting clears the previous error, summary and warnings.
- [x] `npm test` passes.

## Risks / unknowns
- **Button stays disabled until RT checks finish** — after a schedule failure the error shows
  immediately but the form is locked for up to the 10 s check timeout; accepted, since
  resubmitting mid-check would race two sets of results.

## Notes

- Generalized from "schedule CORS issue" to any schedule failure: the checks don't depend on
  the schedule, and special-casing CORS would have meant guessing a cause the browser doesn't
  expose.
- A stale dev server from an earlier session was serving port 8000 during verification; it
  serves the working tree uncached, so the results were valid.

## Follow-ups

None.
