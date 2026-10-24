# Architecture

Foundational technical decisions for browser-gtfs-rt-playback.

## Purpose

A browser-based tool for playing back GTFS Realtime (GTFS-RT) data.

## Stack

- A static single-page site: no server component of our own. Everything (download, unzip,
  parse, summarize) runs in the user's browser.
- Vanilla JavaScript (ES modules), built and served with Vite. The only runtime dependency
  is `fflate` for unzipping the GTFS Schedule archive.
- GTFS CSV parsing is done in-house; the proof of concept needs only a small, RFC 4180
  compatible subset (quoted fields, escaped quotes, CRLF/LF, UTF-8 BOM).

## Feed access

- Feeds are fetched directly from the browser with `fetch`. There is no proxy, so a feed host
  that does not send CORS headers cannot be loaded; the UI reports this plainly (see
  [schedule-loader](screens/schedule-loader.md)).
- The three GTFS-RT URLs are collected and retained alongside the schedule URL but are **not
  fetched yet**. Fetching and playing back realtime data is future work.

## Hosting and deployment

- Hosted on GitHub Pages, served from a project subpath (`/<repo>/`); all asset URLs are
  relative so the site works at any base path.
- A GitHub Actions workflow builds the site and deploys it to Pages on every push to the
  default branch (and on manual dispatch). Pull requests and other branches build but do not
  deploy.

## Not yet decided

Playback model (how time, speed, and seeking map to feed snapshots) and how recorded feed
data is stored. Do not infer a requirement from their absence.
