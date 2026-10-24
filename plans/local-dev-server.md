---
status: done
depends: [schedule-loader-poc]
specs:
  - specs/architecture.md
issues: []
pr: 2
---

# Plan: Local dev server

## Scope
In: a zero-dependency Node static server behind `npm start`, and README guidance that the site
must be served over HTTP. Out: live reload, bundling, any change to the deployed site.

## Implements
- `specs/architecture.md` — "must be served over HTTP(S), including during local development";
  zero-dependency local server needing only Node, documented in the README.

## Approach
- `scripts/serve.mjs` — static server rooted at the repo, correct MIME types for ES modules,
  `PORT` override, `no-store` caching, requests cannot leave the repo root.
- `npm start` runs it (replaces the earlier `python3 -m http.server`, which a fresh macOS may
  lack).
- README: explain why `file://` fails and how to run the server.

## Validation
- [x] Opening `index.html` via `file://` fails with the ES-module/CORS error (reproduces the
      report), confirming the server is required.
- [x] `npm start` serves `/`, JS modules (as `text/javascript`), and the vendored library with
      200s, returns 404 for unknown paths, and cannot serve files outside the repo.
- [x] The full app flow works in a real browser through the server (schedule only, one RT URL,
      malformed RT URL rejected, missing schedule URL rejected).
- [x] `npm test` still passes.

## Risks / unknowns
- **Port in use** — the server fails to start if the port is taken; `PORT=<n> npm start` is
  the workaround.

## Notes

- Raised by a user opening `index.html` by double-click on macOS. Making that work would mean
  abandoning ES modules (and the buildless design), so the decision was to require HTTP and
  make that easy; the constraint now lives in the architecture spec.

## Follow-ups

None.
