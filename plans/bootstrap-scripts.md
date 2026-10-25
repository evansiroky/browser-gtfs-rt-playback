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
| State bucket | `<project-id>-tfstate`, versioned, uniform bucket-level access, public access prevention, label `gtfs-rt-debugger-bootstrap=true`. Bootstrap labels it only when it creates it or finds it empty (an interrupted run); a non-empty unlabeled bucket is refused |
| WIF pool / provider id | `github` / `github` |
| Provider attribute mapping | `google.subject=assertion.sub`, `attribute.repository=assertion.repository`, `attribute.target=assertion.job_workflow_ref.split('@')[0] + ':' + (assertion.event_name == 'pull_request' ? 'pr' : assertion.ref)` |
| Provider attribute condition | `assertion.repository == '<owner>/<repo>'`. An existing provider whose condition, mapping or issuer differs is refused, never reused |
| Plan identity | SA `tf-plan`; WIF principalSet member `…/attribute.target/<owner/repo>/.github/workflows/infra.yml:pr`; roles: project viewer, `iam.securityReviewer`; on the state bucket only, `storage.objectViewer` plus `storage.objectUser` conditioned on `resource.name.endsWith(".tflock")` (title `terraform-lock-objects`), so its only write access is to lock objects |
| Apply identity | SA `tf-apply`; member `…/attribute.target/<owner/repo>/.github/workflows/infra.yml:refs/heads/main`; roles sufficient for infrastructure.md's resources (Cloud Run admin, Artifact Registry admin, Secret Manager admin, service-account admin, service-account user (`actAs` on the runtime SA), service usage consumer, `storage.objectAdmin` on the state bucket) |
| Billing | `roles/billing.costsManager` for `tf-apply` and `roles/billing.viewer` for `tf-plan` (to plan the budget; exposes the billing account's spend, an accepted trade-off) on the billing account, only if the caller can grant them; otherwise print the exact commands for an operator who can |
| GitHub repository variables | `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `TF_STATE_BUCKET` |

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
- [x] `tf-plan` holds no unconditional write role on the state bucket; its only write grant is
      the lock-object conditional binding.
- [x] Bootstrap refuses a non-empty unlabeled state bucket and a provider that does not match
      the contract, making no changes; it adopts an empty unlabeled bucket.
- [x] Teardown fails closed: a describe error other than NOT_FOUND aborts it (non-zero exit,
      state bucket not deleted), and Terraform never runs against an unlabeled bucket.
- [ ] Live run of `bootstrap.sh` then `teardown.sh` against a throwaway real GCP project
      (cannot be verified in this environment; operator step).

## Risks / unknowns
- **Unverified against real GCP** — only stubs here; flag syntax for `gcloud iam
  workload-identity-pools` must be checked against `gcloud` help (gcloud 570 is installed, so
  `--help` output is the reference).
- **Role sets** — `tf-apply` may need an extra role the first `terraform apply` reveals; the
  README should say how to add one.

## Notes
- **Verification.**
  - shellcheck 0.11.0 (`pip install shellcheck-py`) and `bash -n` are clean on
    `scripts/*.sh` and on the harness files.
  - `scripts/test/run-tests.sh` passes 38 tests in about 33 s on bash 5.2.
  - The repo-root toolchain passes on the combined tree after rebasing onto the PR branch:
    `npm ci`, `lint`, `typecheck`, `test`, `build`, `format:check`. `scripts/README.md` is
    formatted with the repo's prettier config.
  - The live-run box stays open: there is no real GCP project here.
- **Fix round after adversarial review.** Each item follows `specs/infrastructure.md`
  at dcd8dba.
  - *Adoption rule.* Bootstrap labels an existing unlabeled state bucket only if
    `gcloud storage ls --all-versions` shows it empty, which is what an interrupted run
    leaves. A non-empty one is refused before any change, and bootstrap prints the
    deliberate-adoption command. A preflight runs the refusal checks before the APIs are
    enabled, so a refused run makes zero changes. No role is ever granted on a refused
    bucket.
  - *Lock-only tf-plan.* On the state bucket, `tf-plan` gets `roles/storage.objectViewer`
    plus `roles/storage.objectUser` conditioned on `resource.name.endsWith(".tflock")`
    (title `terraform-lock-objects`). `tf-apply` keeps `objectAdmin`.
  - *Provider conformance.* An existing provider, active or soft-deleted, is compared on
    three things: the exact attribute condition, the issuer, and the attribute mapping (as
    a sorted key=value set, parsed from `json(attributeMapping)`). Any mismatch, including
    an empty condition, is refused with the `update-oidc` command. A soft-deleted provider
    that does not match is not undeleted.
  - *Fail-closed probes.* Only `NOT_FOUND` / `not found: 404` / `HTTPError 404` on gcloud's
    stderr counts as absent. Any other error stops the script with gcloud's message. Pool,
    provider and service-account states are set as globals, not read through `$(...)`,
    where a `die` would only end the subshell.
  - *Disabled APIs.* Under `--dry-run`, probes are skipped for APIs the run would enable.
    Teardown skips identities and pool when the IAM API is disabled, and the bucket when
    Cloud Storage is disabled.
  - *Teardown.*
    - Terraform runs only against the labeled bucket.
    - Project bindings are removed with `--all`, once per role, including
      `deleted:serviceAccount:<email>?uid=...` leftovers. Other principals are never
      touched; this is tested with look-alike names.
    - A billing binding that is already gone is skipped; any other billing failure stops
      teardown.
    - The bucket is deleted last, only after every earlier step succeeded.
    - The final message notes any warnings.
  - *Harness.*
    - Each test now runs with errexit truly active, plus an ERR trap. Previously
      `if ( ... )` disabled it.
    - The fake models conditional bindings, `--all`, object listings, buckets in other
      projects, `SERVICE_DISABLED`, injected `PERMISSION_DENIED`, and stale billing rows.
- **Mutation testing, run on the final code.**
  - The reviewer's `mutate.py` gives: M4 survived; M5-M7, M9, M11, M13-M16, M19 and M20
    killed. Its other patterns no longer match the rewritten code.
  - An adapted copy with the same mutants re-targeted, plus 13 new ones (N1-N13) for this
    round's code, kills all 35 mutants except M4.
  - **M4 is equivalent.** In `[[ $answer == $PROJECT_ID ]]` the unquoted side is the
    project ID, which validation restricts to `[a-z0-9-]`, so it never contains a glob
    character. The non-equivalent swap, M4b `[[ $PROJECT_ID == $answer ]]`, is killed by
    the `*` / `?` / `[...]` answers.
- **Accepted contract additions.** All are reflected in the Approach table (amended in
  its own commit):
  - `roles/iam.serviceAccountUser` for `tf-apply`, for `actAs` on the runtime SA;
  - `roles/billing.viewer` for `tf-plan`, to plan the budget. It exposes the billing
    account's spend; this is documented, and a dedicated billing account is recommended;
  - public access prevention on the state bucket;
  - the GitHub variables `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`,
    `TF_STATE_BUCKET`.
- **gcloud facts checked against gcloud 570 `--help`, its bundled source, and local
  formatter runs:**
  - `storage buckets create` has no labels or versioning flags, so creation is a create
    followed by an update.
  - `storage rm --recursive gs://b` deletes every object version and then the bucket, and
    does not fail on an empty bucket.
  - `storage ls gs://b` on an empty bucket lists nothing rather than failing.
  - Dict flags split each item at the first `=`.
  - `--condition=expression=...,title=...` is the syntax for conditional bindings.
  - `projects remove-iam-policy-binding --all` removes a member+role whatever its
    condition.
  - Bucket `get-iam-policy` requests policy version 3, so conditions are returned.
  - Display fields: `config.name` for services, `labels` and `versioning_enabled` for
    buckets.
  - `value()` prints a trailing tab for an empty last column. The json printer uses a
    two-space indent and sorted keys.
- **Behavior choices.**
  - All value flags are passed as `--flag=value`.
  - `CLOUDSDK_CORE_DISABLE_PROMPTS=1` is set.
  - Pools and providers soft-delete for 30 days: bootstrap undeletes a matching one, and
    teardown treats `DELETED` as gone.
  - Teardown passes Terraform inputs as `TF_VAR_*`.
  - `--repo` is required by teardown only when Terraform runs.
  - `--dry-run` needs no confirmation.
- **Not confirmed (needs the operator's first live run):**
  - that principalSet attribute values may contain `:` and `/`;
  - that the attribute-mapping CEL supports `.split('@')[0]` (fallback
    `assertion.job_workflow_ref.extract('{w}@')`, documented in the README);
  - the exact NOT_FOUND wording of each API's describe errors;
  - that the GCS IAM condition `resource.name.endsWith(".tflock")` admits Terraform's lock
    create and delete;
  - the `billing projects describe` value output form.
- **bash 3.2:** the scripts avoid bash 4 features but were run only on bash 5.2. No 3.2
  binary was reachable here.

## Follow-ups
- Wiring `shellcheck` and `scripts/test/run-tests.sh` into CI is
  [`ci-cd`](ci-cd.md)'s job (its Approach already mentions it).
- [`ci-cd`](ci-cd.md) and [`terraform-infra`](terraform-infra.md) must use the contract in
  `scripts/README.md`. Tracked as: those plans' Validation boxes on byte-for-byte contract
  matching.
