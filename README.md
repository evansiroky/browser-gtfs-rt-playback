# gtfs-rt-debugger

A public web app for debugging a single transit agency's GTFS Realtime feeds against its GTFS
Schedule. The operator configures which feeds to watch. While someone is viewing the site, a
backend downloads the schedule once and polls the realtime feeds every 10 seconds, holding at most
one hour of realtime history in memory; when nobody is viewing, it goes dormant and forgets
everything. The server is the only thing that talks to feed hosts.

## Specs and plans

This project is spec-driven. [`specs/`](specs/README.md) is the source of truth for what should be
true (architecture, data model, API, screens, behaviors, infrastructure); [`plans/`](plans/README.md)
is the work in flight. Start with [`specs/architecture.md`](specs/architecture.md). See
[`CLAUDE.md`](CLAUDE.md) for the workflow.

## Repository layout

An npm workspace; every package is TypeScript (ESM, strict).

```
shared/     API contract types and the precision-6 polyline codec (used by server and web)
fixtures/   deterministic test feeds and a fake feed host        (added by test-fixtures)
server/     HTTP API and feed ingestion                           (added by server-core)
web/        React app                                             (added by web-shell)
e2e/        Playwright end-to-end tests                           (added by dashboard-screen)
scripts/    bootstrap.sh, teardown.sh                             (added by bootstrap-scripts)
infra/      Terraform                                             (added by terraform-infra)
specs/ plans/ .github/
```

The `workspaces` array in the root `package.json` already lists every package, in build order:
`shared`, `fixtures`, `server`, `web`, `e2e`. Directories that do not exist yet are ignored by npm.
A plan that adds a package creates its directory; it must not reorder that array.

## Container image

One image runs everything: the Node server, which also serves the built web app (same origin).
The root [`Dockerfile`](Dockerfile) is multi-stage. The build stage runs `npm ci` and builds
`shared`, `server` and `web`; the runtime stage is `node:22-bookworm-slim` with production
dependencies of `server`/`shared` only, the compiled `server/dist`, `shared/dist` and `web/dist`,
`NODE_ENV=production`, and a non-root user (uid 1000). `node server/dist/main.js` is PID 1; the
server handles `SIGTERM` itself. There is no `HEALTHCHECK` (Cloud Run ignores it and probes the TCP
port). The image holds no secrets and no `.env`; configuration is environment only.

```bash
docker build -t gtfs-rt-debugger .
```

Run it against the fake feeds (`fixtures`) on the host. The fake host listens on loopback by
default, so pick one of two ways to let the container reach it:

```bash
# Linux, simplest: share the host network (the app is then on http://localhost:8080)
npm run fake-feeds -w fixtures                      # http://127.0.0.1:4200
docker run --rm --network host \
  -e SCHEDULE_URL=http://127.0.0.1:4200/schedule.zip \
  -e VEHICLE_POSITIONS_URL=http://127.0.0.1:4200/vehicle-positions.pb \
  -e TRIP_UPDATES_URL=http://127.0.0.1:4200/trip-updates.pb \
  gtfs-rt-debugger

# Docker Desktop (macOS/Windows) or a Linux bridge network: the fake host must listen beyond loopback
npm run fake-feeds -w fixtures -- --host=0.0.0.0
docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway \
  -e SCHEDULE_URL=http://host.docker.internal:4200/schedule.zip \
  -e VEHICLE_POSITIONS_URL=http://host.docker.internal:4200/vehicle-positions.pb \
  -e TRIP_UPDATES_URL=http://host.docker.internal:4200/trip-updates.pb \
  gtfs-rt-debugger
```

`SCHEDULE_URL` and at least one of `VEHICLE_POSITIONS_URL` / `TRIP_UPDATES_URL` are required; every
other variable is optional (see [`server/README.md`](server/README.md#environment)). Add
`-e EXIT_ON_IDLE=true -e IDLE_TIMEOUT_MS=30000` to watch the container exit by itself when idle.
Without `PORT` the server listens on 8080; Cloud Run injects `PORT` (8080 by default) and routes to
it, so the image needs no port configuration there. The deploy pipeline
([`ci-cd`](plans/ci-cd.md)) builds and pushes this image; nothing in this repository pushes it by
hand.

`scripts/container-smoke.sh <image> [--port N]` starts the image with placeholder feed URLs and
checks serving, the `/trips/x` fallback, the API, non-root, `SIGTERM` exit 0 and a log free of feed
URLs; see [`scripts/README.md`](scripts/README.md#container-smoke-test). `npm start` (repo root)
runs the built server outside Docker (`npm run build` first).

## Development

Requires Node 22 (see `.nvmrc`) and npm 10.

```bash
npm ci                # install all workspaces
npm run lint          # ESLint (flat config, typescript-eslint)
npm run typecheck     # tsc for every package; builds shared first so dependents see its output
npm test              # Vitest for every package (shared is built first)
npm run build         # production build of every package, in workspace order
npm run clean         # remove build output from every package
npm run format        # Prettier, write
npm run format:check  # Prettier, check only
```

Each root script runs the same-named script in every workspace (`--workspaces --if-present`), in
the `workspaces` order, so a package only needs to define the scripts that apply to it.

`shared` is consumed through its built output (`shared/dist`). Its `typecheck`, `test` and `build`
scripts all run `tsc -b` first, and it is first in the `workspaces` order, so by the time any other
package's scripts run, `shared` is built. Every package's tests and typecheck may rely on that.
After changing `shared`, run `npm run build -w shared` before running another package's scripts on
their own.
