---
status: done
depends: []
specs:
  - specs/architecture.md
  - specs/screens/schedule-loader.md
  - specs/behaviors/gtfs-schedule-summary.md
issues: []
---

# Plan: Schedule loader proof of concept

## Scope
In: a buildless static site with a form for a GTFS Schedule URL and three GTFS-RT URLs; in-browser
download, unzip, and parse of the schedule; display of agency info, route count, stop count,
and service date range; unit tests for the parser/summary; a GitHub Actions workflow that
runs the tests. Deployment is GitHub Pages from the `main` root, so there is no deploy workflow.

Out: fetching or playing back the GTFS-RT feeds (the URLs are only collected and echoed), CORS
proxying, `frequencies`/`feed_info` handling, large-feed streaming optimizations.

## Implements
- `specs/architecture.md` — stack, feed access, hosting and deployment.
- `specs/screens/schedule-loader.md` — form, status, result, errors.
- `specs/behaviors/gtfs-schedule-summary.md` — CSV parsing, counts, service date range.

## Approach
- `src/vendor/fflate.js` — vendored `fflate` browser ES module (+ license), imported by relative
  path; no npm dependencies remain.
- `src/csv.js` — small RFC 4180 parser returning row objects keyed by header.
- `src/gtfs.js` — `summarizeGtfs(zipBytes)`: `unzipSync`, parse the needed files, compute the
  summary; throws typed errors for bad zip / missing files.
- `src/main.js` — form handling, `fetch`, status/error/result rendering.
- Root `index.html` and `src/style.css`, all with relative URLs.
- `.github/workflows/test.yml` — run `npm test` on push and pull request.
- Tests with `node --test` against `csv.js` and `gtfs.js` (zips built in-test with the vendored
  `fflate`).

## Validation
- [x] `npm test` passes, covering quoted CSV fields, BOM/CRLF, calendar + calendar_dates
      range, unknown range, and missing required file.
- [x] The repo root, served by a plain static file server from a subpath with no build step,
      works in a real browser.
- [x] In a real browser, submitting a locally served GTFS zip shows agency, route count, stop
      count, and date range matching the fixture.
- [x] A cross-origin URL without CORS headers shows the CORS-flavored error; a 404 shows the
      HTTP status; a non-zip response shows the invalid-archive error.
- [x] The test workflow is valid YAML, triggers on push and pull request, and does not deploy.

## Risks / unknowns
- **CORS** — many agency feeds block cross-origin requests; the PoC can't load those. Surfaced
  in the UI rather than worked around.
- **Pages source** — the repo's Pages is configured to deploy from the `main` root, so the
  site only goes live once this work is on `main`.

## Notes

- Originally built with Vite + a Pages Actions deploy; reworked once the repo was configured to
  deploy from the `main` root, which cannot serve bundler-style bare imports. The spec change
  is in the `docs(specs):` commit ahead of the rework.
- Verified with headless Chromium (Playwright) serving the raw repo root under `/repo/`:
  success, no-CORS, 404, non-zip, and empty-field validation cases matched the spec.
- The test workflow's YAML was parsed locally but has not run on GitHub.
- No PR existed at closeout, so `pr:` is unset; add it when the PR is opened.
- Only the needed files are inflated from the zip (`filter`), so large `stop_times.txt` files
  cost nothing.
- Vendored fflate is 0.8.3; update by re-copying `esm/browser.js` from the npm package.

## Follow-ups

- Issue (to file) — fetch and decode the GTFS-RT feeds, then design the playback model
  (architecture.md "Not yet decided").
