---
status: planned
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
- [ ] Dockerfile lints clean (hadolint or equivalent); `.dockerignore` excludes the listed paths.
- [ ] Native emulation of both stages in a clean directory succeeds: production install has no
      devDependencies, `node server/dist/main.js` (or the chosen entry) starts on `$PORT`,
      `curl /` returns the app HTML, `/trips/x` returns the same, `POST /api/v1/session/start` returns a `SessionStatus`.
- [ ] Process exits 0 on `SIGTERM` and on idle shutdown with `EXIT_ON_IDLE=true`.
- [ ] Image contents reviewed: non-root user, no `.git`, no secrets, no dev tooling.
- [ ] `docker build` and `docker run` succeed (cannot be verified here — no daemon; run in CI/locally).

## Risks / unknowns
- **Unverifiable build** — mitigated by native emulation + lint; the first CI run is the real test.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
