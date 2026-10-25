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
