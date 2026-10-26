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
docker build --platform linux/amd64 --build-arg GIT_SHA="$(git rev-parse HEAD)" -t gtfs-rt-debugger .
```

Cloud Run runs `linux/amd64` only and rejects an arm64 image, so build with `--platform linux/amd64`
on an Apple-silicon or other arm64 machine (CI on an amd64 Ubuntu runner needs no flag). `GIT_SHA`
is optional; it fills the `org.opencontainers.image.revision` label (default `unknown`).

Run it against the fake feeds (`fixtures`) on the host. The fake host runs in the foreground, so
start it in one terminal and `docker run` in a second. It listens on loopback by default, so pick
one of two ways to let the container reach it:

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
URLs (default host port 18080, published on 127.0.0.1 only); see [`scripts/README.md`](scripts/README.md#container-smoke-test). `npm start` (repo root)
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

## CI/CD

Three GitHub Actions workflows in [`.github/workflows/`](.github/workflows/) are the only path to the
environment after bootstrap ([`specs/deployment.md`](specs/deployment.md)). Authentication is Workload
Identity Federation only; no key and no GitHub secret exists.

| Workflow     | Runs on                                                                                      | Does                                                                                                                                                                                                                                                                              | Identity                                      |
| ------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `ci.yml`     | every pull request, every push to `main`, called by `deploy.yml`                             | lint, typecheck, tests, build, format check; shellcheck and the script tests; actionlint and the workflow invariants; Terraform fmt and validate; image build and smoke test (not pushed); `npm audit` (informational). `deploy.yml` calls it without the audit and the image job | none (read-only, no OIDC)                     |
| `infra.yml`  | pull requests and pushes to `main` that change `infra/` or the workflow                      | PR: `fmt -check`, `validate`, `plan`, one updating PR comment. `main`: `plan`, then `apply`                                                                                                                                                                                       | PR: `tf-plan` (read-only). `main`: `tf-apply` |
| `deploy.yml` | push to `main` that changes app code (not docs, `infra/`, `scripts/`, `.github/`), or manual | after `ci.yml`: build, smoke test, push `<region>-docker.pkg.dev/<project>/gtfs-rt-debugger/gtfs-rt-debugger:<sha>`, `gcloud run deploy --image` (nothing else). Manual run with a SHA is the rollback                                                                            | `deploy`, from `deploy.yml` on `main` only    |

### Repository variables

Settings > Secrets and variables > Actions > **Variables** (not secrets). `scripts/bootstrap.sh` prints
all four with ready-made `gh variable set` commands; `terraform output github_variables` prints them again.

| Variable             | Value                           |
| -------------------- | ------------------------------- |
| `GCP_PROJECT_ID`     | the project ID                  |
| `GCP_PROJECT_NUMBER` | the project number              |
| `GCP_REGION`         | the region (default `us-west1`) |
| `TF_STATE_BUCKET`    | `<project-id>-tfstate`          |

The workflows derive everything else: the provider
`projects/<number>/locations/global/workloadIdentityPools/github/providers/github` and the identities
`tf-plan@`, `tf-apply@` and `deploy@<project-id>.iam.gserviceaccount.com`. A job fails early with a message
if a variable is unset.

### Operator order

1. Create the project, link billing, run `scripts/bootstrap.sh` ([`scripts/README.md`](scripts/README.md)).
2. Set the four repository variables it prints.
3. Run the first `terraform apply` locally ([`infra/README.md`](infra/README.md)). CI cannot do this one: it
   creates the Cloud Run service and the deploy identity that the pipelines need. A deploy never creates the
   service and fails with a message if it is missing.
4. Add the three feed-URL secret versions.
5. Merge to `main`. A merge that changes app code runs CI, then Deploy builds, pushes and rolls out the image. A merge that touches only ignored paths (docs, `.github/`, `scripts/`, `infra/`, ...) deploys nothing, so for the first deploy (the service still runs the placeholder image) run Deploy manually: Actions > Deploy > Run workflow, branch `main`, `sha` = the current `main` SHA.

### Rollback

Actions > Deploy > **Run workflow**, branch `main`, input `sha` = the full 40-character SHA of a commit on
`main`. The run checks the SHA is on `main`, reuses the image tagged with it if Artifact Registry still has it
(the registry keeps the 10 most recent versions and anything younger than 7 days), and otherwise rebuilds that
commit, smoke tests the image and pushes it before deploying. It fails with a clear message if the SHA is
unknown, not on `main`, or has no `Dockerfile`. A rollback does not wait for CI: it must work while `main` is
broken. The next app change pushed to `main` deploys on top of the rollback, so revert the bad commit too.
Deploys share one concurrency group and GitHub keeps only one waiting run per group: a rollback started while a push
deploy is still waiting replaces it (that commit is then deployed by the next app push or a manual run), and a push
that arrives while a rollback is waiting replaces the rollback (start it again).
The same manual run with the current `main` SHA is how to exercise `deploy.yml` after editing it (changes under
`.github/` do not deploy by themselves, because a deploy replaces the running instance).

### Branch protection (recommended)

On `main`: require a pull request and the CI checks (`Lint, types, tests, build`, `Bootstrap and smoke-script tests`,
`Workflow lint and security invariants`, `Terraform fmt and validate`, `Container image (build only)`), forbid force
pushes and deletion, and restrict who can push. Do not require the Infrastructure checks (they run only when
`infra/` changes) or `Dependency advisories (informational)` (it reads a live advisory database, so it must never
gate a merge or a deploy; it raises a warning and a job summary). Never add a `pull_request_target` trigger or a
deploy path that is not `deploy.yml` on `main`.

Optional defence in depth: create GitHub Environments with a deployment branch policy (`main` only), and
optionally required reviewers, for `deploy` and `apply`, and reference them from those jobs. The workflows do not
use `environment:`, so the Workload Identity bindings above stay the boundary; an Environment adds a second gate
and an approval step.

### Security model and residual risks

- A same-repository pull request runs its own copy of the workflow files, so the author controls them. The
  identities are therefore bound to the workflow file and the ref (`infra.yml:pr` for `tf-plan`,
  `infra.yml:refs/heads/main` for `tf-apply`, `deploy.yml:refs/heads/main` for `deploy`), and `tf-plan` is
  read-only. A pull request can never obtain deploy or apply credentials. Fork and Dependabot pull requests get no
  OIDC token and skip the plan.
- `scripts/test/workflow-invariants.py` (a CI job) is a regression net for these workflows, not the boundary: a
  pull request can edit it. The boundary is the Workload Identity bindings plus branch protection. It parses the
  workflows and fails on an edit that, among other things: lets `id-token: write` appear outside `deploy`, `plan`
  and `apply`; lets a job other than the right one authenticate as `deploy@`, `tf-plan@` or `tf-apply@`; evaluates
  the `if:` of `plan`, `apply`, `deploy` and `comment` over a truth table of events, refs, forks and CI results;
  adds an action other than checkout, upload-artifact, `auth`, `setup-gcloud` and `setup-terraform` to a job that
  can mint a token, or leaves any action unpinned by commit SHA; uses `pull_request_target`, the `secrets` context or
  a local action; interpolates event data in `run`, `shell`, `working-directory` or script source; changes the
  one allowed `gcloud run deploy` command or the plan command; or disagrees with the bootstrap contract in
  `scripts/lib.sh` and `infra/`. It does not parse shell in general. `--self-test` breaks each invariant once (72
  mutations) and requires the right failure.
- Pull-request plans run with `-lock=false` so a pull request cannot hold the state lock and block an apply.
  `tf-plan` may still write lock objects, so a malicious workflow could leave a lock behind. Recover with
  `terraform -chdir=infra force-unlock <lock-id>` (the ID is in the blocked run's error).
- Every action is pinned by full commit SHA (with its version in a comment) and refreshed weekly by Dependabot
  ([`.github/dependabot.yml`](.github/dependabot.yml): actions, the Dockerfile base image, npm, Terraform). Any step
  of a job with `id-token: write` can request the OIDC token, so those three jobs (`deploy`, `plan`, `apply`) run
  only first-party Google, HashiCorp and GitHub actions; the deploy job builds with plain `docker`, with no builder
  action. The `pip install` pins in `ci.yml` have no hashes and are updated by hand; they run only in jobs without
  credentials.
- Apply and Deploy are separate concurrency groups, so a deploy can land while an apply runs, and an apply would
  carry the image it planned back into the service. The apply job therefore reads the service (generation and
  image) before planning and again before applying and plans again if it moved, and after the apply fails with a
  message telling you to re-run Deploy if the service changed twice and the image is the old one. A deploy that
  lands after the apply simply wins. The apply also stands down when a newer commit on `main` has changed `infra/`.
- The Terraform plan comment is visible to anyone who can see the pull request. It shows resource attributes
  such as the project ID, which are not secrets; secret values never enter Terraform.
- Deploys are serialized and never cancelled, but GitHub keeps one waiting run per group, so a waiting run is
  replaced by a newer one. A push deploy for a commit older than the one already live stands down, so a slow or
  re-run older run cannot roll the app back (a rollback is exempt on purpose). CI runs twice for an app push
  (its own push trigger, and the call from Deploy, which leaves out the audit and the image build); that is accepted
  so docs-only pushes to `main` still get a CI run.
