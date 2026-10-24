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
In: a Vite site with a form for a GTFS Schedule URL and three GTFS-RT URLs; in-browser
download, unzip, and parse of the schedule; display of agency info, route count, stop count,
and service date range; unit tests for the parser/summary; a GitHub Actions workflow that
deploys to GitHub Pages.

Out: fetching or playing back the GTFS-RT feeds (the URLs are only collected and echoed), CORS
proxying, `frequencies`/`feed_info` handling, large-feed streaming optimizations.

## Implements
- `specs/architecture.md` — stack, feed access, hosting and deployment.
- `specs/screens/schedule-loader.md` — form, status, result, errors.
- `specs/behaviors/gtfs-schedule-summary.md` — CSV parsing, counts, service date range.

## Approach
- `src/csv.js` — small RFC 4180 parser returning row objects keyed by header.
- `src/gtfs.js` — `summarizeGtfs(zipBytes)`: `fflate.unzipSync`, parse the needed files,
  compute the summary; throws typed errors for bad zip / missing files.
- `src/main.js` — form handling, `fetch`, status/error/result rendering.
- `index.html`, `src/style.css` — minimal markup and styling.
- `vite.config.js` with `base: './'` for subpath hosting.
- `.github/workflows/deploy.yml` — build on push/PR, deploy to Pages from the default branch
  via `actions/deploy-pages`.
- Tests with `node --test` against `csv.js` and `gtfs.js` (zip built in-test with `fflate`).

## Validation
- [x] `npm test` passes, covering quoted CSV fields, BOM/CRLF, calendar + calendar_dates
      range, unknown range, and missing required file.
- [x] `npm run build` succeeds and the built site works from a subpath.
- [x] In a real browser, submitting a locally served GTFS zip shows agency, route count, stop
      count, and date range matching the fixture.
- [x] A cross-origin URL without CORS headers shows the CORS-flavored error; a 404 shows the
      HTTP status; a non-zip response shows the invalid-archive error.
- [x] The deploy workflow is valid YAML and builds on pull requests but deploys only from the
      default branch.

## Risks / unknowns
- **CORS** — many agency feeds block cross-origin requests; the PoC can't load those. Surfaced
  in the UI rather than worked around.
- **Pages must be enabled** — the repo's Pages source needs to be set to "GitHub Actions" once
  by a repo admin; the workflow can't do that itself.

## Notes

- Verified with headless Chromium (Playwright) against the built `dist/` served under `/repo/`:
  success, no-CORS, 404, non-zip, and empty-field validation cases all matched the spec.
- The deploy workflow's YAML was parsed locally but has not run on GitHub; the first real
  deploy happens after merge to the default branch and Pages is enabled.
- No PR existed at closeout, so `pr:` is unset; add it when the PR is opened.
- Only the needed files are inflated from the zip (`filter`), so large `stop_times.txt` files
  cost nothing.

## Follow-ups

- Issue (to file) — fetch and decode the GTFS-RT feeds, then design the playback model
  (architecture.md "Not yet decided").
- Tracked as: repo admin must set Pages source to "GitHub Actions" before the first deploy.
