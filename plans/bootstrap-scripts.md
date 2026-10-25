---
status: done
depends: []
specs:
  - specs/infrastructure.md
issues: []
pr: 3
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
- [x] `shellcheck scripts/*.sh` is clean.
- [x] Test harness passes: ordering, idempotent re-run, `--dry-run` does nothing, confirmation
      required, unlabeled bucket never deleted, no key creation anywhere.
- [x] `bootstrap.sh --help` and `teardown.sh --help` document every flag and env fallback.
- [x] Naming contract table in `scripts/README.md` matches the constants in `lib.sh`.
- [x] Both scripts reject a malformed `owner/repo` and a missing project with a clear message.
- [ ] Live run of `bootstrap.sh` then `teardown.sh` against a throwaway real GCP project
      (cannot be verified in this environment; operator step).

## Risks / unknowns
- **Unverified against real GCP** — only stubs here; flag syntax for `gcloud iam
  workload-identity-pools` must be checked against `gcloud` help (gcloud 570 is installed, so
  `--help` output is the reference).
- **Role sets** — `tf-apply` may need an extra role the first `terraform apply` reveals; the
  README should say how to add one.

## Notes
- **Verification.** shellcheck 0.11.0 (`pip install shellcheck-py`) is clean on `scripts/*.sh`
  and on the harness files. `scripts/test/run-tests.sh` passes 29 tests in about 12 s on
  bash 5.2. The harness was mutation-checked: each of ten deliberate breakages (ignore the
  bucket label, skip a confirmation, ignore `--dry-run`, change the mapping or apply target,
  reorder steps, ...) makes at least one test fail. The live-run box stays open: there is no
  real GCP project here.
- **Deviations from the Approach table (flag for review):**
  - `tf-apply` also gets `roles/iam.serviceAccountUser`. Cloud Run needs `actAs` on the
    runtime service account to deploy a service that runs as it, and `serviceAccountAdmin`
    does not include `actAs`. It adds no real escalation, since `serviceAccountAdmin` can
    already change any service account's IAM policy.
  - `tf-plan` also gets `roles/billing.viewer` on the billing account, in the same
    "only if the caller can grant it" step as `costsManager`. Without it, `terraform plan`
    on a pull request cannot refresh the `google_billing_budget` resource.
  - The GitHub repository variable names were not in the plan, so they are fixed in the
    contract here: `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `TF_STATE_BUCKET`.
  - The state bucket also gets public access prevention.
- **gcloud facts checked against gcloud 570 `--help` and its bundled source:**
  - `storage buckets create` has no labels or versioning flags, so creation is a `create`
    followed by `update --versioning --update-labels=...`.
  - `storage rm --recursive gs://b` deletes every object version and then the bucket, and
    does not fail on an empty bucket.
  - Dict flags split each item at the first `=`, so the attribute mapping needs no `^DELIM^`
    escaping (its values contain `==` but no commas).
  - The GA `services list` format key is `config.name`.
  - The bucket describe display fields are `labels` and `versioning_enabled`.
  - `--condition=None` is accepted by project, service-account and bucket bindings. The
    billing binding commands take no condition.
- **Behavior choices.**
  - All value flags are passed as `--flag=value`.
  - `CLOUDSDK_CORE_DISABLE_PROMPTS=1` is set, so the script's own confirmation is the only
    gate.
  - Pools and providers soft-delete for 30 days. Bootstrap undeletes them; teardown treats
    `DELETED` as gone.
  - Bootstrap refuses to adopt a provider whose condition names another repo.
  - Teardown removes every project and billing binding of the two identities, whatever the
    role. It passes Terraform inputs as `TF_VAR_*` environment variables, which Terraform
    ignores when undeclared, so it does not depend on `infra/`'s exact variable set.
  - `--repo` is required by teardown only when Terraform runs.
  - `--dry-run` needs no confirmation.
- **Not confirmed from `--help` (needs the operator's first live run):**
  - whether a principalSet attribute value may contain `:` and `/`
    (`.../attribute.target/<owner>/<repo>/.github/workflows/infra.yml:pr`);
  - that the `billing projects describe` value output is `True`/`billingAccounts/<id>`;
  - that the bucket describe `json(labels)` output has the exact form
    `"gtfs-rt-debugger-bootstrap": "true"`;
  - that the flattened `get-iam-policy` value output for buckets and billing accounts is
    `role<TAB>member` rows.
- **bash 3.2:** the scripts avoid bash 4 features (no associative arrays, no bare
  expansion of possibly-empty arrays under `set -u`). They were not run on a real 3.2,
  because no 3.2 binary or source tarball was reachable here.

## Follow-ups
- Wiring `shellcheck` and `scripts/test/run-tests.sh` into CI is
  [`ci-cd`](ci-cd.md)'s job (its Approach already mentions it).
- [`ci-cd`](ci-cd.md) and [`terraform-infra`](terraform-infra.md) must use the variable
  names, `roles/billing.viewer` for `tf-plan`, and the member strings in
  `scripts/README.md`. Tracked as: those plans' Validation boxes on byte-for-byte
  contract matching.
