# Architecture

Foundational technical decisions for gtfs-rt-debugger.

## Purpose

A public web app for debugging a single transit agency's GTFS Realtime feeds against its
GTFS Schedule. The operator configures which feeds to watch; visitors cannot change them.
While someone is viewing the site, a backend downloads the schedule once and polls the
realtime feeds every 10 seconds, holding at most one hour of realtime history in memory.
When nobody is viewing, the backend goes dormant and forgets everything.

Governing principles: [Cost ceiling beats convenience](principles.md#cost-ceiling-beats-convenience),
[Forget by default](principles.md#forget-by-default),
[The server fetches](principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts).

## Shape

One deployable: a single container running one Node.js server process that

1. serves the built web app as static files, and
2. serves the JSON API under `/api/v1` (see [api/conventions.md](api/conventions.md)), and
3. runs the feed ingestion (schedule download, realtime polling) in the same process.

The web app and API share an origin, so the browser needs no CORS. There is exactly one
server process holding all state; the platform is configured so a second instance can never
run (see [infrastructure.md](infrastructure.md)). State is process memory only — see
[behaviors/data-retention.md](behaviors/data-retention.md).

## Stack

- **Language:** TypeScript end to end (Node.js LTS on the server), one repository, shared
  type definitions for the API between server and web app. npm as package manager.
- **Server:** a Node HTTP framework of the implementer's choice; GTFS-RT decoded with the
  official `gtfs-realtime-bindings`; GTFS Schedule read as a streamed zip + streamed CSV so
  peak memory stays bounded.
- **Web app:** React + Vite + TypeScript, **shadcn/ui** (with Tailwind CSS) for all UI
  components. Server state fetched with a data-fetching library that supports interval
  refetch and pausing when the tab is hidden.
- **Map:** MapLibre GL JS with a keyless public vector-tile provider. Trip shapes arrive as
  precision-6 encoded polylines and are decoded in the browser. The tile provider is a
  single configuration constant. Tiles are the only third-party request the browser makes.
- **Tests:** Vitest for server and web logic; behaviors with a numeric or temporal rule
  (service-date resolution, active-trip window, dormancy timers) are unit-tested with an
  injectable clock.
- **Packaging:** multi-stage Dockerfile producing one image; the server serves `web` build
  output from the image.

## Repository structure

```
/            package manifest(s), Dockerfile, CLAUDE.md
server/      API + ingestion
web/         React app
scripts/     bootstrap.sh, teardown.sh (see infrastructure.md)
infra/       Terraform
specs/ plans/ .github/
```

Exact internal layout of `server/` and `web/` is an implementation decision.

## Security posture

- Public, unauthenticated site; no user accounts, no user input that reaches a feed host.
- Feed URLs are secrets (they may embed API keys): supplied to the process via
  environment from Secret Manager, never returned by the API, never logged.
- The server only fetches the configured URLs; request redirects, response sizes, and
  timeouts are bounded ([behaviors/feed-ingest.md](behaviors/feed-ingest.md)).
- The API is rate-limited per client address ([api/conventions.md](api/conventions.md)).
- Responses carry a Content-Security-Policy that allows only the app's own origin and the
  configured tile host.

## Out of scope (v1)

Persisting any data; user-configurable feeds; multiple agencies or multiple simultaneous
configurations; alerts feeds; stop-level map layers (stops, stop times); authentication;
any view of data older than the retained hour or of any date other than now.
