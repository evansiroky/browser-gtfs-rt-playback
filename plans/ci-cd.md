---
status: planned
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
  service settings/secrets/env; a manually triggered **rollback** run taking a commit SHA.
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
- [ ] `actionlint` is clean on all workflows.
- [ ] Walk-through table in Notes mapping each `deployment.md` sentence to the workflow lines that implement it.
- [ ] No workflow can obtain deploy or apply credentials from a `pull_request` event (reviewed and stated explicitly).
- [ ] Identity names, WIF member strings, and variables match `bootstrap-scripts` and `terraform-infra` byte-for-byte (script-checked or reviewed line by line).
- [ ] Deploy does not set env vars/secrets/scaling on the service; rollback workflow requires a SHA input.
- [ ] A real run of CI, Infrastructure and Deploy on GitHub (cannot be verified before operator
      bootstrap; first run after merge).

## Risks / unknowns
- **Unrunnable until bootstrap** — Deploy/Infra need real GCP; CI alone can run on the PR.
- **Action pinning** — record chosen versions in Notes.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
