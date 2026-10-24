# Architecture

Foundational technical decisions for browser-gtfs-rt-playback.

## Purpose

A browser-based tool for playing back GTFS Realtime (GTFS-RT) data.

## Stack

- A static single-page site with **no build step**: the files in the repository root are
  served exactly as committed. There is no server component of our own; everything
  (download, unzip, parse, summarize) runs in the user's browser.
- Vanilla JavaScript (ES modules loaded directly by the browser; no bundler, no transpiler).
- The one third-party library, `fflate` (for unzipping the GTFS Schedule archive), is vendored
  into the repository as a single ES module with its license, so the site has no install step
  and no runtime network dependency beyond the user's feeds.
- The site must be served over HTTP(S), including during local development: browsers refuse
  to load ES modules from `file://`, so opening `index.html` directly from the filesystem is
  not supported. The repository provides a zero-dependency local server (needing only Node,
  which the tests already require), documented in the README.
- GTFS CSV parsing is done in-house; the proof of concept needs only a small, RFC 4180
  compatible subset (quoted fields, escaped quotes, CRLF/LF, UTF-8 BOM).

## Feed access

- Feeds are fetched directly from the browser with `fetch`. There is no proxy, so a feed host
  that does not send CORS headers cannot be loaded; the UI reports this plainly (see
  [schedule-loader](screens/schedule-loader.md)).
- The GTFS-RT URLs are optional. Each one entered is only *probed* to learn whether the
  browser may read it cross-origin (see [schedule-loader](screens/schedule-loader.md)); the
  feed body is neither downloaded in full nor decoded. Decoding and playing back realtime data
  is future work.

## Hosting and deployment

- Hosted on GitHub Pages, deployed from the root (`/`) of the `main` branch. Merging to `main`
  is the deploy.
- The site is served from a project subpath (`/<repo>/`); all asset URLs are relative so it
  works at any base path.
- A GitHub Actions workflow runs the unit tests on pushes and pull requests. It does not
  deploy.

## Not yet decided

Playback model (how time, speed, and seeking map to feed snapshots) and how recorded feed
data is stored. Do not infer a requirement from their absence.
