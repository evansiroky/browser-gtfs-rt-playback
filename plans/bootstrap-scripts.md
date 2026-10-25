---
status: planned
depends: []
specs:
  - specs/infrastructure.md
issues: []
---

# Plan: Bootstrap and teardown scripts

## Scope
In: `scripts/bootstrap.sh`, `scripts/teardown.sh`, a shared `scripts/lib.sh`, a stubbed-`gcloud`
test harness, and `scripts/README.md` (operator runbook + the naming contract below).

Out: Terraform itself ([`terraform-infra`](terraform-infra.md)); GitHub variables/workflows
([`ci-cd`](ci-cd.md)); creating the GCP project or linking billing (operator steps the script
only *verifies*). Running against a real project is an operator action, not part of this plan.

## Implements
`specs/infrastructure.md`:
- "Bootstrap and teardown scripts" — every numbered step of `bootstrap.sh` and `teardown.sh`.
- "Order of operations for the operator".
- Local principles: no long-lived credentials; least privilege per workflow.

## Approach
**Naming contract** (other plans depend on these exact values; document them in
`scripts/README.md` and `lib.sh` constants):

| Thing | Value |
|---|---|
| State bucket | `<project-id>-tfstate`, versioned, uniform bucket-level access, label `gtfs-rt-debugger-bootstrap=true` |
| WIF pool / provider id | `github` / `github` |
| Provider attribute mapping | `google.subject=assertion.sub`, `attribute.repository=assertion.repository`, `attribute.target=assertion.job_workflow_ref.split('@')[0] + ':' + (assertion.event_name == 'pull_request' ? 'pr' : assertion.ref)` |
| Provider attribute condition | `assertion.repository == '<owner>/<repo>'` |
| Plan identity | SA `tf-plan`; WIF principalSet member `…/attribute.target/<owner/repo>/.github/workflows/infra.yml:pr`; roles: project viewer, `iam.securityReviewer`, `storage.objectAdmin` on the state bucket only (state lock) |
| Apply identity | SA `tf-apply`; member `…/attribute.target/<owner/repo>/.github/workflows/infra.yml:refs/heads/main`; roles sufficient for infrastructure.md's resources (Cloud Run admin, Artifact Registry admin, Secret Manager admin, service-account admin, service usage consumer, `storage.objectAdmin` on the state bucket) |
| Billing | `roles/billing.costsManager` for `tf-apply` on the billing account, only if the caller can grant it; otherwise print the exact command for an operator who can |

Steps:
1. `scripts/lib.sh`: strict mode (`set -euo pipefail`), `run()` that prints the command before
   running it and honors `--dry-run`, `exists_*` probes (so every create is skip-if-present),
   flag/env parsing (`--project`, `--region`, `--repo`, with `PROJECT_ID`/`REGION`/`GITHUB_REPO`
   fallbacks), repo-format validation (`owner/repo`).
2. `bootstrap.sh`: verify project + billing linked (explain how to link if not) → enable APIs
   (Cloud Run, Artifact Registry, Secret Manager, IAM, IAM Credentials, STS, Cloud Resource
   Manager, Service Usage, Cloud Billing Budget, Cloud Storage; **not** Cloud Build) → state
   bucket → WIF pool + provider → the two identities and bindings → budget permission →
   print the GitHub repository variables (project ID, project number, region, state bucket)
   and next steps. Never creates a service-account key.
3. `teardown.sh`: require typing the project ID (or `--confirm-project <id>`); `--dry-run`;
   `terraform destroy` first unless `--skip-terraform`; remove bindings → identities → WIF
   provider and pool → state bucket (all versions; **only if it carries the bootstrap label**);
   `--delete-project` adds a second confirmation. Every step tolerates "already gone".
4. Tests (`scripts/test/`): a fake `gcloud` on `PATH` that records calls and simulates
   present/absent resources; assert: ordering, idempotent re-run makes no create calls, dry-run
   executes nothing, teardown refuses without confirmation, teardown refuses to delete an
   unlabeled bucket, no command contains `keys create`.
5. Document in `scripts/README.md` how to run `shellcheck` and the test harness. Wiring them
   into CI is [`ci-cd`](ci-cd.md)'s job; do not add root tooling here.

Environment notes: `shellcheck` is not installed; `pip install shellcheck-py` works (PyPI is
reachable). There is no real GCP project in this environment.

## Validation
- [ ] `shellcheck scripts/*.sh` is clean.
- [ ] Test harness passes: ordering, idempotent re-run, `--dry-run` does nothing, confirmation
      required, unlabeled bucket never deleted, no key creation anywhere.
- [ ] `bootstrap.sh --help` and `teardown.sh --help` document every flag and env fallback.
- [ ] Naming contract table in `scripts/README.md` matches the constants in `lib.sh`.
- [ ] Both scripts reject a malformed `owner/repo` and a missing project with a clear message.
- [ ] Live run of `bootstrap.sh` then `teardown.sh` against a throwaway real GCP project
      (cannot be verified in this environment; operator step).

## Risks / unknowns
- **Unverified against real GCP** — only stubs here; flag syntax for `gcloud iam
  workload-identity-pools` must be checked against `gcloud` help (gcloud 570 is installed, so
  `--help` output is the reference).
- **Role sets** — `tf-apply` may need an extra role the first `terraform apply` reveals; the
  README should say how to add one.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
