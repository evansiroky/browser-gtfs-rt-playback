---
status: done
pr: 3
depends: [server-core, web-shell]
specs:
  - specs/architecture.md
  - specs/infrastructure.md
issues: []
---

# Plan: Container image

## Scope
In: a multi-stage `Dockerfile` and `.dockerignore` producing one image that runs the server and
serves the built web app; a production start script; README run instructions.

Out: pushing the image or deploying it ([`ci-cd`](ci-cd.md)); the Cloud Run service
([`terraform-infra`](terraform-infra.md)).

## Implements
- `architecture.md` "Shape" and "Stack/Packaging": one deployable, same-origin static serving,
  one image.
- `infrastructure.md`: the container listens on the platform-provided `PORT`, reads feed URLs and
  tunables from environment, exits cleanly on idle shutdown and on `SIGTERM`.

## Approach
- Stage 1 builds all workspaces (`npm ci`, `npm run build`); stage 2 is a slim Node 22 runtime
  with production dependencies only, the built `server` and `shared`, and `web/dist`; non-root
  user; `NODE_ENV=production`; `CMD` runs the server entry. Layer ordering for cache efficiency.
- Server entry reads `PORT`, serves `web/dist` from a path relative to the build output; add a
  `npm start` script.
- No secrets in the image; no `.env` copied; `.dockerignore` excludes `node_modules`, `dist`, `.git`, specs/plans.
- README: build/run commands with the fake feeds (`npm run fake-feeds`) for a local smoke test.
- **Environment note: there is no Docker daemon here**, so `docker build` cannot be run.
  Verify the same steps natively in a clean temp directory (copy the tree, `npm ci --omit=dev`
  for the runtime layer, run the built server against fake feeds and `curl` it), and lint the
  Dockerfile with `hadolint` (`pip install hadolint-py` if reachable) or equivalent.

## Validation
- [x] Dockerfile lints clean (hadolint or equivalent); `.dockerignore` excludes the listed paths.
- [x] Native emulation of both stages in a clean directory succeeds: production install has no
      devDependencies, `node server/dist/main.js` (or the chosen entry) starts on `$PORT`,
      `curl /` returns the app HTML, `/trips/x` returns the same, `POST /api/v1/session/start` returns a `SessionStatus`.
- [x] Process exits 0 on `SIGTERM` and on idle shutdown with `EXIT_ON_IDLE=true`.
- [x] Image contents reviewed: non-root user, no `.git`, no secrets, no dev tooling.
- [x] `docker build` and `docker run` succeed (cannot be verified here — no daemon; run in CI/locally).

## Risks / unknowns
- **Unverifiable build** — mitigated by native emulation + lint; the first CI run is the real test. (A daemon was later available; see Notes.)

## Notes
**Verification.** A Docker daemon turned out to work in the build environment (`dockerd` with the `vfs` storage
driver, `--bridge=none`, base image pulled through the agent proxy and retagged locally with the proxy CA). Evidence,
all against the committed `Dockerfile`/`.dockerignore`:
- `docker build` succeeds (about 51 s, base cached); `docker buildx build --check`: "Check complete, no warnings
  found"; hadolint 2.15.1 is clean.
- The image: `USER 1000:1000` (`node`), entrypoint `docker-entrypoint.sh` with `CMD ["node","server/dist/main.js"]`,
  PID 1 is `node server/dist/main.js`, OCI `source` and `revision` labels (`--build-arg GIT_SHA=...`). 267 MB on
  disk including the ~227 MB base. The `npm ci --omit=dev` layer is 38.7 MB, `web/dist` 415 kB, `server/dist` 199 kB,
  `shared/dist` 38 kB. `/app` holds only `node_modules`, `package*.json`, `server`, `shared`, `web`: no vite, react,
  typescript, vitest, tailwind, maplibre, eslint, prettier, no `fixtures`/`web` workspace link, no `.env*`, `.pem` or
  `.git`.
- `scripts/container-smoke.sh` passes 13/13 against the real image. `docker run --read-only` runs fine and `docker
  diff` is empty, so the image needs no writable path; with `EXIT_ON_IDLE=true IDLE_TIMEOUT_MS=4000` the container
  exited 0 by itself; `docker stop -t 10` exits 0 well inside the drain bound (under a second for an idle server).
- With `PORT` unset and `--network host`, the image answered on 8080 (the default), so Cloud Run's `PORT` injection
  and the default both work.
- **Not covered by the real daemon:** the `-p 127.0.0.1:N:8080` published-port mapping. The daemon here has no bridge
  (`--bridge=none`), so the smoke run went through a shim that turns `-p ip:host:container` into `--network host` with
  `PORT=host`. The mapping is covered only by `scripts/test/container-smoke-tests.sh`, whose fake docker models
  publishing (an app on 8080 is reachable only through a `-p` to container port 8080) and asserts the exact `-p`
  argument. Also not run: any Cloud Run behaviour (first deploy is the ci-cd plan).
- Native emulation of both stages (`.dockerignore` applied by script, then the Dockerfile's `npm ci`/build/runtime
  commands in clean directories) agrees with the real build: 101 files in the context, the same production tree,
  `/`, `/trips/x`, `POST /api/v1/session/start`, `SIGTERM` exit 0 and idle exit 0.

**`.dockerignore` is an allowlist** (`*`, then `!package.json`, `!package-lock.json`, `!tsconfig.base.json`, `!shared`,
`!server`, `!web`) with nested exclusions (`**/node_modules`, `**/dist`, `**/*.md`, `**/.env*`, `**/.npmrc`, `**/*.pem`,
`**/*.key`, `**/*.p12`, `**/credentials*.json`, `**/*.tfstate*`, `**/*.tfvars`). The first version excluded secrets only
at the context root, while the build copies `server/` and `web/` wholesale: a `web/.env.production` would have been
inlined by Vite into the public bundle. Checked with decoy files (`web/.env.production`, `web/.env.local`,
`server/.env`, `*.pem`, `*.key`, `.npmrc`, `credentials*.json` at several depths) by a real `COPY . /ctx` build: none
reached the context, which holds exactly the 101 files the build needs. Test files stay in (web's tsconfig includes them).

**Design.** Only the `shared`, `server` and `web` manifests are copied before `npm ci` (layer cache); `fixtures` and
`e2e` are not in the context and npm accepts their absence, also with a lockfile as `schedule-loader` leaves it
(server gains yauzl/csv-parse and `fixtures` as a devDependency): the build stage gets a dangling `fixtures` link
(harmless, server's `build` is `tsc -b` of non-test sources) and the runtime stage installs the new runtime deps and
no `fixtures`. The build stage needs `--include-workspace-root` (typescript is a root devDependency). The default
`WEB_DIST_DIR` is `server/dist/../../web/dist`, i.e. `/app/web/dist`. No `HEALTHCHECK` (Cloud Run probes the TCP
port), no tini (the base image's entrypoint script `exec`s node, so node is PID 1 and handles SIGTERM itself). The
`# syntax=` line was dropped (it forces a registry fetch per build and nothing needs the newer frontend). Base pinned to
`node:22-bookworm-slim` (major only; no digest invented). `GIT_SHA` is declared after the dependency and copy layers
so a new revision does not invalidate them. Root `package.json` gained `"start": "npm run start -w server"`.

**Memory.** No `NODE_OPTIONS` is set. Measured by the reviewer at `--memory 2g`: `process.constrainedMemory()` is
2048 MiB and V8's `heap_size_limit` is 1048 MiB; a synthetic 3M-trip schedule aborts cleanly with `too_large` at the
768 MiB estimate with a real heap of at most 600 MiB (about 1.75x margin), and the worst-case RSS sum is about 1.75 GiB,
under the 2 GiB instance limit.

**Size.** Production `node_modules` is 58 MB on disk (about 40 MB apparent); per the review about 15 MiB of it is `protobufjs-cli`
(jsdoc, babel, lodash, ...), a hard dependency of `gtfs-realtime-bindings` that is never loaded at runtime. The review measured the app layer
at about 8.9 MB gzipped against an ~80 MB base, so pruning it is not worth a lockfile-violating hack. `server/dist` also
ships `.tsbuildinfo`, `*.map` and `*.d.ts` (about 540 KB), harmless.

**Smoke script.** `scripts/container-smoke.sh <image> [--port N]` publishes on `127.0.0.1` only (default host port
18080), stops with a 10 s grace period and requires exit 0 within 8 s. It is tested by
`scripts/test/container-smoke-tests.sh` (19 tests: the real server passes; with the stub `scripts/test/fake-app.mjs`
each check fails on its own: status, HTML, CSP including an empty one, `/trips/x`, missing asset, session state,
root, unknown uid, `SIGTERM` exit code, a slow stop, a leak of the key, the path, either host and the full URL, an empty
log, a wrong container port; plus cleanup after failed runs and usage). 25 mutants of the script were run against that
suite: all killed (one, an empty-CSP-value regex, survived the first round and got its own test). Needs `npm run build`
first; not part of `run-tests.sh` (38 tests, still green). Shellcheck 0.11.0 is clean for every script and fake.

**Compatibility with `schedule-loader`.** `plan/schedule-loader` value-imports `@gtfs-rt-debugger/shared` at runtime
without declaring it in `server`'s `dependencies`. The image works because the runtime stage installs `shared`
explicitly (`--workspace=shared`; keep that line), but `schedule-loader` must declare the dependency. The review reports that a scratch merge of
that branch builds and serves `/api/v1/shapes/...` from this image.

## Follow-ups
Tracked as: none filed.
- Base image digest pinning has no owner (no Renovate config in the repo). `ci-cd` should record the base image digest
  used for every build in the job summary; note the rollback caveat: rebuilding an older commit may get a different base.
- `ci-cd`: build with `--build-arg GIT_SHA=$GITHUB_SHA`, run `scripts/container-smoke.sh <image>` after `docker build`
  (needs docker and curl; a normal CI daemon has a bridge, so `-p` should work as is, which is untested) and `scripts/test/container-smoke-tests.sh`
  after `npm run build`.
- `schedule-loader`: declare `@gtfs-rt-debugger/shared` in `server`'s `dependencies` (see Notes).
