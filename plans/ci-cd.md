---
status: done
pr: 3
depends: [terraform-infra, container-image]
specs:
  - specs/deployment.md
  - specs/infrastructure.md
issues: []
---

# Plan: CI/CD pipelines

## Scope
In: `.github/workflows/` — CI, Deploy, Infrastructure — and any composite actions they share.

Out: Terraform resources ([`terraform-infra`](terraform-infra.md)), the bootstrap scripts
([`bootstrap-scripts`](bootstrap-scripts.md)), the image ([`container-image`](container-image.md)).
Configuring GitHub repository variables and running the pipelines for real is an operator step.

## Implements
`specs/deployment.md`:
- **CI** on every PR and push to `main`: lint, typecheck, unit tests, build, container image
  build (not pushed); doc-only changes (`specs/`, `plans/`, markdown, agent config) do not
  trigger Deploy.
- **Deploy** on push to `main` with app changes, after CI: build, tag with commit SHA, push to
  Artifact Registry, `gcloud run deploy --image`; serialized, never cancelled; never touches
  service settings/secrets/env; a manually triggered **rollback** run taking a commit SHA, which
  deploys the existing image for that SHA if the registry still has it and otherwise rebuilds it
  from that commit (or fails with a clear message).
- The deploy job must live in `deploy.yml` itself (not in a reusable workflow defined in another
  file): the deploy identity's Workload Identity member matches `job_workflow_ref` of
  `deploy.yml@refs/heads/main` only. Calling `ci.yml` from `deploy.yml` is fine.
- **Infrastructure**: PR → `fmt -check`, `validate`, `plan` as the read-only **plan** identity
  with a single updating PR comment; push to `main` → plan then apply as the **apply** identity;
  serialized.
- **Identities**: Workload Identity Federation only, no keys; plan/apply/deploy are each
  reachable only from one workflow file on the ref named in the spec; repo variables only
  (project ID, project number, region, state bucket).

## Approach
- `ci.yml` (reusable via `workflow_call` + `pull_request` + `push: main`), `deploy.yml`,
  `infra.yml`; pinned third-party action versions (full SHA or major with a comment); least
  `permissions:` per job (`id-token: write` only where needed); `concurrency` groups.
- The repository variables are named exactly `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`,
  `GCP_REGION` and `TF_STATE_BUCKET` (chosen by [`bootstrap-scripts`](bootstrap-scripts.md), which
  prints them).
- Derive the WIF provider path and service-account emails from the variables exactly per the
  bootstrap naming contract in [`bootstrap-scripts`](bootstrap-scripts.md) and the deploy SA in
  [`terraform-infra`](terraform-infra.md); a mismatch is a bug in this plan.
- Since pull-request workflow files are attacker-controlled on same-repo PRs, the PR path must
  only ever authenticate as the read-only plan identity; Deploy must not run on `pull_request`.
- Environment notes: `actionlint` binary is not downloadable here (GitHub releases 403) — use
  `pip install actionlint-py` (PyPI reachable). Optionally wire the bootstrap script tests and
  `shellcheck` into CI.

## Validation
- [x] `actionlint` is clean on all workflows.
- [x] Walk-through table in Notes mapping each `deployment.md` sentence to the workflow lines that implement it.
- [x] No workflow can obtain deploy or apply credentials from a `pull_request` event (reviewed and stated explicitly).
- [x] Identity names, WIF member strings, and variables match `bootstrap-scripts` and `terraform-infra` byte-for-byte (script-checked or reviewed line by line).
- [x] Deploy does not set env vars/secrets/scaling on the service; rollback workflow requires a SHA input.
- [ ] A real run of CI, Infrastructure and Deploy on GitHub (cannot be verified before operator
      bootstrap; first run after merge).

## Risks / unknowns
- **Unrunnable until bootstrap** — Deploy/Infra need real GCP; CI alone can run on the PR.
- **Action pinning** — record chosen versions in Notes.

## Notes

**Files.** `.github/workflows/{ci,deploy,infra}.yml`, `.github/dependabot.yml`, `scripts/test/workflow-invariants.py`
(Python + PyYAML, run by the `workflows` job of `ci.yml`), a README "CI/CD" section, and one sentence of
`infra/README.md`. No composite or local actions (the checker forbids them): the shell that matters lives in `run:`
blocks, all shellchecked through actionlint.

**Action versions (all pinned by full commit SHA, version in a trailing comment; looked up with `git ls-remote --tags`,
each tag shallow-cloned and its `action.yml` read; all run on `node24`).**

| Action | Version | Commit |
|---|---|---|
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| actions/upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| actions/download-artifact | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |
| actions/github-script | v9.0.0 (annotated tag, peeled commit) | `3a2844b7e9c422d3c10d287c895573f7108da1b3` |
| google-github-actions/auth | v3.0.0 | `7c6bc770dae815cd3e89ee6cdf493a5fab2cc093` |
| google-github-actions/setup-gcloud | v3.0.1 | `aa5489c8933f4cc7a4f7d45035b3b1440c9c10db` |
| hashicorp/setup-terraform | v4.0.1 | `dfe3c3f87815947d99a8997f908cb6525fc44e9e` |

Input names used were checked against each `action.yml` (no renames needed): checkout `fetch-depth`,
`persist-credentials` (v7 adds `allow-unsafe-pr-checkout`, irrelevant without `pull_request_target`); setup-node
`node-version-file`, `cache`; upload-artifact `name`, `path`, `if-no-files-found`, `retention-days`, `overwrite`;
download-artifact `name`, `path`; github-script `script` (v9 only breaks `require('@actions/github')`; the script uses
`require('fs')`); auth `workload_identity_provider`, `service_account`; setup-terraform `terraform_version`,
`terraform_wrapper`. Terraform `1.16.7` in all three workflows (enforced equal by the checker). Docker actions are gone:
the image is built with plain `docker build --platform linux/amd64 --build-arg GIT_SHA=...` and `docker push`
(BuildKit is built into the daemon) in both `ci.yml` and `deploy.yml`, so no builder image is pulled and no third-party
action runs in a job that can mint the deploy token. `pip` pins (`actionlint-py==1.7.12.25`, `shellcheck-py==0.11.0.1`,
`pyyaml==6.0.3`) have no hashes and are updated by hand; they run only in jobs without credentials.

**Adversarial-review fixes (round 2).**
1. *An apply could silently undo a concurrent deploy* (confirmed by the reviewer): `terraform apply tfplan` sends the whole
   Cloud Run template, so the image read at plan time is written back. The apply job now holds only its own group
   (`infra-apply`; a shared group with `deploy` would let GitHub's replace-the-waiting-run rule cancel a waiting deploy in
   favour of an apply), checks staleness *inside* the job after it holds the group, reads the service (generation and image
   via `gcloud run services describe`) before planning and again right before applying and re-plans (3 attempts, then a clear
   failure) if it moved, and after the apply fails loudly if the generation advanced by 2 or more while the image is still the
   one read before the apply (a deploy landed in the window and was overwritten), telling the operator to re-run Deploy; a
   deploy that lands after the apply wins and is logged. Proof, with Terraform 1.16.7 + real gcloud 570 against a stateful mock
   of the Cloud Run v2 (Terraform) and v1 (gcloud) APIs (`race-proof.log`, mock `mock-race.py` derived from the reviewer's
   `mockv2.py`/the terraform-infra `mockv1.py`; the "Plan and apply" step extracted from the YAML and run as is, with a
   `terraform` shim that lets `gcloud run deploy` land at a chosen point):

   | scenario | service before | result |
   |---|---|---|
   | old behaviour: `plan -out`, deploy lands, `apply tfplan` | image A | image A (**deploy reverted**), exit 0 |
   | guarded, no concurrent deploy | image A | image A, exit 0 |
   | guarded, deploy lands after the plan | image A | re-plans ("planning again (1 of 3)"), image B, exit 0 |
   | guarded, deploy lands right before the apply | image A | apply overwrites it, **job fails** with the re-run-Deploy message, image A |
   | guarded, deploy lands after the apply | image A | image B, notice only, exit 0 |

   The generation semantics (`metadata.generation` +1 per spec change) are Knative's and are modelled by the mock, not
   observed on a real service. `infra/README.md`'s sentence "an apply never rolls the app back" now points at these checks.
2. *`npm audit` gated deploys* (it reads a live advisory database, contradicting "a merge cannot fail checks that passed on
   the PR"): it is its own job `audit`, `continue-on-error` on the audit step, a warning annotation plus job summary on
   failure, and `ci.yml` takes a `deploy_gate` input that `deploy.yml` passes as `true`, which skips `audit` (and the `image`
   job, fix 9). `npm audit --omit=dev --audit-level=high` is kept for the informational run.
3. *Every step of an `id-token: write` job can mint the token*: every `uses:` is SHA-pinned (table above); the deploy job builds
   with plain docker; the checker allowlists, for the three token jobs, only checkout, upload-artifact, auth, setup-gcloud and
   setup-terraform, forbids containers/services/local actions/`docker://` there, and allowlists the `gcloud` sub-commands
   (`run services describe`, `run deploy`, `artifacts docker images describe`, `auth configure-docker`).
4. *Checker gaps* (29 reviewer mutations): `*.yml` and `*.yaml` are read, any other file under `.github/` that is an action is
   flagged; job-level `uses` may only be `./.github/workflows/ci.yml` from `deploy.yml`; the `if:` of `plan`, `skip-plan`,
   `apply`, `comment`, `deploy`, `ci` and the CI jobs are parsed (tokenizer, `&&`, `||`, `!`, `==`, `!=`, status functions) and
   evaluated over events x refs x fork/Dependabot x CI result x cancelled; the deploy command and the plan command are pinned to
   their exact line shape (so `$EXTRA`-style smuggling fails) and the rest of the vocabulary is banned in those jobs;
   `persist-credentials: false` on every checkout; `${{ }}` banned in `run`, `shell`, `working-directory`, script source and
   action args; non-string `run:` values are reported instead of crashing. `--self-test` now has 72 mutations (all old plus
   every reviewer mutation that still applies), each required to fail for the stated reason: 72/72 killed. The reviewer's
   `mut.py` against the new workflows: 20 killed, 2 anchors no longer exist (the `needs.fresh` job was folded into `apply`, and the
   apply `if` changed; my self-test has the equivalents), the new-`.yaml`-file case is not built by that harness and is covered by my
   self-test, and 1 survivor that is not a defect (a JS
   template literal `${process.env.X}` inside the github-script source is not a workflow expression). `mut2.py`'s anchors
   (old action tags) no longer exist; its three mutations are in the self-test (third-party action in the deploy job, in the apply
   job, non-string `run`). **What the checker is:** a regression net for the repository's own workflows. It does not parse
   shell in general, and a pull request can edit it, so the real boundary is the Workload Identity bindings plus branch
   protection (README says so; the earlier claim that it "forbids every settings/secrets/IAM flag" is withdrawn).
5. *Rollback rebuild* runs `$RUNNER_TEMP/src/scripts/container-smoke.sh` (the commit's own) when it exists, else the current one.
6. README: operator step 5 now says a merge touching only ignored paths deploys nothing (run Deploy manually for the first
   deploy), the one-waiting-run-per-group behaviour in both directions (a rollback replaces a waiting push deploy and vice
   versa), SHA pins, the apply/deploy checks, the Environments recommendation (documented, not added to the workflows), and the
   audit job is not a required check.
7. Registry check matches `NOT_FOUND|[Ii]mage not found` only (was `not.?found|404`, which classified a `PERMISSION_DENIED`
   that merely contained "404", e.g. project `proj-404x`, as a missing image). Tested with the reviewer's `armock.py` and real
   gcloud 570: not found -> rebuild; `PERMISSION_DENIED` with project `proj-404x` and with `proj-x` -> fail closed.
8. Dependabot: the `skip-plan` job (renamed from `skip-fork`) and the `plan` condition skip Dependabot PRs (read-only token and
   no OIDC) with a notice; CI still runs. `upload-artifact` uses `overwrite: true` so re-running the plan job works. All actions
   run on node24.
9. `deploy.yml` calls CI with `deploy_gate: true`, so an app push no longer builds the image three times (CI's own push run builds
   it once; the deploy job builds the one it ships). The remaining duplication (CI runs twice on an app push, once without
   audit/image) is accepted so docs-only pushes to `main` still get a CI run. GitHub Environments with a branch policy or
   reviewers for `deploy`/`apply` are recommended in the README, not added (`environment:` would widen the scope).

**Verification (what ran here).**
- actionlint 1.7.12 with shellcheck 0.11.0 on PATH: clean (an earlier planted SC2086 confirmed the integration). `prettier --check` covers
  `.github/` and the README (the Python checker is outside its languages).
- `scripts/test/workflow-invariants.py` passes; `--self-test` 72/72.
- Extracted `run:` blocks run against a scratch git repo and a fake `gcloud` ("Resolve the commit", "Inspect the registry and
  the service": every case in the earlier round plus `Image not found`), the `armock` check above with real gcloud, the race
  proof above, and the github-script comment body under Node with a mocked client (create vs update, spoofed marker ignored,
  60 000-character truncation notice, backtick fence, failed run without a plan file).
- From a clean `npm ci`: `lint`, `typecheck`, `test`, `build`, `format:check`, `npm audit --omit=dev --audit-level=high` (0
  vulnerabilities); shellcheck over scripts and fakes; `scripts/test/run-tests.sh` 38 passed; `container-smoke-tests.sh` 19 passed.
- Terraform 1.16.7 with the local provider mirror: `fmt -check -recursive`, `init -backend=false`, `validate` clean in the first
  round (`infra/` is unchanged since apart from one README sentence). `docker build --platform linux/amd64 --build-arg
  GIT_SHA=<HEAD>` plus `scripts/container-smoke.sh` 13/13 and the base-digest lookup (`docker buildx imagetools inspect` + awk) were
  run against a real daemon in the first round; this round only swapped the build action for the same plain `docker build`
  command, which was not re-run (cost), so the evidence is the first round and `container-image`'s notes.

**Not verified (cannot be here): the live run.** No GitHub Actions runner, no GCP. First-run risks, in order: (1)
`google-github-actions/auth` against the real pool, which also exercises the unconfirmed CEL `split('@')` in the bootstrap
attribute mapping (`scripts/README.md`); (2) `-p 127.0.0.1:N:8080` smoke on a real bridge (CI only); (3) whether Dependabot-triggered
runs really lack OIDC (assumed from GitHub's documentation; if they can mint it, the skip is merely conservative); (4) `if:`
expressions are evaluated by the checker's own evaluator and actionlint, never by GitHub; (5) gcloud `--format` field paths
(`metadata.generation`, `spec.template.spec.containers[0].image`, `status.url`, `image_summary.digest`) were exercised against
mocks (generation/image/url) or documented output only (`image_summary.digest`); (6) Knative generation semantics on a real
service, and that Terraform's single PATCH advances it by exactly one; (7) the newest majors of the actions (checkout v7, setup-node
v7, upload v7, download v8, github-script v9, auth v3, setup-gcloud v3, setup-terraform v4) were read, not run.

**Walk-through: `specs/deployment.md` -> workflow lines** (line numbers at the closeout commit).

| Spec sentence | Implemented by |
|---|---|
| One environment from `main`, no previews, so a PR never creates billable infrastructure | No deploy trigger but `push: main` and manual (`deploy.yml:11-40`); `ci.yml` builds the image but never pushes (`ci.yml:139-152`); the only PR cloud path is read-only `tf-plan` (`infra.yml:52-126`) |
| CI on every PR and push to `main`: lint, typecheck, unit tests, build, container image build (not pushed) | `ci.yml:13-23` triggers; `check` 35-54; `image` 139-152 (plain `docker build`, no push, smoke) |
| The same checks run for PRs and `main` | One file, no path filters, same jobs for both triggers; `deploy.yml` calls it (`deploy.yml:48-54`) minus the advisory audit and the image job |
| Doc-only changes do not trigger Deploy | `deploy.yml:17-34` `paths-ignore` (specs, plans, markdown, agent config; plus `infra/`, `scripts/`, `.github/`, fixtures/e2e and lint configs, which cannot change the image) |
| Deploy: after CI passes | `deploy.yml:48-54` `ci` job; `deploy` `needs: ci` and requires `needs.ci.result == 'success'` for pushes (56-59) |
| Build, tag with the commit SHA, push to Artifact Registry | resolve (106-129, image path at 128), worktree (175-185), `docker build` (197-204), smoke (206-213), `docker push` (215-219) |
| `gcloud run deploy` that image | `deploy.yml:223-227`, only `--image --region --project --quiet` (checker pins the exact line) |
| Serialized, never cancelled mid-flight | `deploy.yml:69-71` `group: deploy`, `cancel-in-progress: false`; infra apply `infra.yml:214-216` |
| A deploy never changes settings, secrets, env vars | the one deploy command; the service is never created (`deploy.yml:143-153` requires it); the checker forbids settings/secrets/IAM vocabulary in the workflows; Terraform ignores the image and gcloud's marks (`infra/README.md`); the apply job's checks keep an apply from undoing a deploy (`infra.yml:284-`) |
| Rollback = manually triggered run taking a commit SHA | `workflow_dispatch` with required `sha` (`deploy.yml:35-40`), validated, on `main`, ancestor of `origin/main` (106-129) |
| A rollback to an older commit rebuilds the image first, or fails with a clear message | registry check (`deploy.yml:160-172`; `NOT_FOUND` builds, any other registry error stops) -> build from a worktree of that SHA (175-185: clear error if it has no Dockerfile), unknown/off-main SHA errors at 106-129 |
| Infra PR: `fmt -check`, `validate`, `plan` with the read-only plan identity, one updating comment | `infra.yml:52-126` (`plan` job), `comment` job 128-203 (one comment found by marker and author, created once, updated after) |
| Infra push to `main`: plan then apply with the apply identity, serialized | `infra.yml:205-` (`apply`: stale check 246, init, validate, `Plan and apply` 284-; group `infra-apply`) |
| Identities via WIF only, no keys | no `credentials_json`, no secrets context (checker); `auth` steps `deploy.yml:131-134`, `infra.yml:97-100, 266-269` |
| plan/apply/deploy each reachable from one workflow file on one ref | `tf-plan` only in `infra.yml` `plan` (PR only: `if` at 54), `tf-apply` only in `infra.yml` `apply` (push on main: `if` at 207), `deploy` only in `deploy.yml` `deploy` (main guard 82-88, WIF member `deploy.yml:refs/heads/main`); `id-token: write` only on those three jobs |
| Same-repo PR runs the PR's workflow file, so the PR identity is read-only | the PR path can only mint `tf-plan` (WIF member `infra.yml:pr`; `tf-apply`/`deploy` members need `refs/heads/main`); the `comment` job with `pull-requests: write` has no `id-token` |
| Repository variables only (project ID, number, region, bucket) | `vars.GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `TF_STATE_BUCKET` and nothing else (the checker pins the set to `lib.sh`'s `GH_VAR_*`); every identity job fails early with a message if one is unset |
| Project number forms the WIF provider path, everything else derived | `projects/${{ vars.GCP_PROJECT_NUMBER }}/locations/global/workloadIdentityPools/github/providers/github`, SAs `<id>@${{ vars.GCP_PROJECT_ID }}.iam.gserviceaccount.com`, `TF_VAR_wif_pool` (derived; `billing_account` not passed) |

**No workflow can obtain deploy or apply credentials from a `pull_request` event.** Reviewed (twice, the second time by an
adversarial reviewer who verified the reachability matrix) and enforced: (1) `deploy.yml` has no `pull_request` trigger and its
WIF member requires `deploy.yml:refs/heads/main`; (2) `infra.yml`'s `apply` job needs `github.event_name == 'push' && github.ref
== 'refs/heads/main'` and its WIF member requires the same ref, so even a PR-edited `infra.yml` that removes the `if` is
rejected by Google because the token's `attribute.target` ends in `:pr`; (3) no `pull_request_target`, no `workflow_dispatch` on
`infra.yml`; (4) a PR that edits `ci.yml` can only mint a token that maps to `ci.yml:pr`, which no service account trusts; (5) a
`workflow_dispatch` of an edited `deploy.yml` from a branch carries `refs/heads/<branch>`, not `main`. The checker fails the build
on a regression of the repository's own workflows; it cannot stop a PR that edits the checker itself, which is why branch
protection matters.

**Decisions and deviations from the brief.**
- *Deploy job gating.* A job-level `if` on the ref would skip rather than fail, so the first step of `deploy` fails with an error
  annotation when the ref is not main and every later step is unreachable. The job's own `if` ties it to a green `ci` (pushes) or
  a dispatch.
- *Rollback skips CI* (`ci` runs for pushes only): it must work when `main` is broken; the commit passed CI when it merged.
- *Stale-run guards*: a push deploy stands down when the live image's commit is a descendant of the commit being deployed (a slow
  older run, or a re-run of one, would otherwise roll the app back); the apply stands down when a newer commit on `main` changed
  `infra/` or `infra.yml`, decided inside the job after it holds the group.
- *PR plans have no `-out`*: the text goes to a file and an artifact for the `comment` job; nothing applies it. The comment job has
  `pull-requests: write` and no cloud credentials; the plan jobs have credentials and no write access to the PR.
- *`paths-ignore`* also covers `.github/**`: a workflow edit should not replace the running instance. Exercise `deploy.yml` after
  editing it with a manual run at the current `main` SHA (reuses the image, so only a new Cloud Run revision results).
- *Smoke script on a rebuild* comes from the rebuilt commit's tree when present, which runs a script from an older commit on
  `main` inside the token job; accepted, since that code was reviewed into `main`.
- *Dependabot and the base image.* `dependabot.yml` (weekly, grouped: actions, docker, npm, terraform; Node majors ignored) owns the
  `container-image` follow-up "base image digest pinning has no owner": it bumps `node:22-bookworm-slim` and keeps a digest fresh
  *once the Dockerfile pins one*. The one-time pin is still a Dockerfile edit (below). Each build that rebuilds records the base
  image's index digest, looked up immediately before the build, in the job summary; a rebuilt older commit may get a newer base.
- *Fork pull requests* and Dependabot's: `skip-plan` emits a notice; CI still runs.

## Follow-ups
Tracked as: none filed.
- `container-image`/Dockerfile: pin the base image by digest (`FROM node:22-bookworm-slim@sha256:...`); Dependabot (docker) then
  maintains it.
- When the `e2e` workspace lands (`dashboard-screen`), `npm test` or a new CI job must install Playwright browsers
  (`npx playwright install --with-deps chromium`) and cache them; CI has no such step today.
- After the first live run: confirm the CEL `split('@')` mapping, the `-p` smoke on a real bridge, Dependabot's OIDC behaviour, the
  Knative generation behaviour the apply guard relies on, and consider GitHub Environments for `deploy` and `apply`.
