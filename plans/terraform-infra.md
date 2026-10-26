---
status: done
pr: 3
depends: [bootstrap-scripts]
specs:
  - specs/infrastructure.md
  - specs/deployment.md
  - specs/behaviors/configuration.md
issues: []
---

# Plan: Terraform infrastructure

## Scope
In: everything under `infra/` — the Cloud Run service, runtime service account, Secret Manager
secrets, Artifact Registry repository, billing budget, the **deploy** service account and its
Workload Identity binding, outputs, and `infra/README.md`.

Out: the bootstrap-created pieces (state bucket, WIF pool/provider, `tf-plan`/`tf-apply`) —
consumed here by name from [`bootstrap-scripts`](bootstrap-scripts.md); the pipelines that run
Terraform ([`ci-cd`](ci-cd.md)); the container image ([`container-image`](container-image.md)).

## Implements
- `specs/infrastructure.md` "Resources (managed by Terraform)", "Cost guards".
- `specs/deployment.md` "Identities" — the **deploy** identity row.
- `specs/behaviors/configuration.md` — tunables passed to the service as environment variables.

## Approach
Single root module in `infra/` (no environments), `backend "gcs" { prefix = "gtfs-rt-debugger" }`
with the bucket supplied at `init` time. Provider `hashicorp/google` `~> 6`.

Variables: `project_id`, `region` (default `us-west1`), `github_repository`, `wif_pool`
(`projects/<number>/locations/global/workloadIdentityPools/github`), `billing_account` (optional
override; default: the project's linked account, read through the Cloud Billing API),
`budget_amount` (default 25 USD), `manage_budget` (bool, default true), and the tunables from
configuration.md (poll interval, idle timeout, max activation, retention, memory limits, rate
limit) with the spec's defaults, plus `tile_host` (default `https://tiles.openfreemap.org`,
passed to the service as `TILE_HOST` so the Content-Security-Policy allows the map's origin).

Resources:
1. `google_cloud_run_v2_service`: max instances 1, min 0, CPU always allocated
   (`cpu_idle = false`), 1 vCPU / 2 GiB, concurrency 80, ingress all, runtime SA, env vars for
   the tunables plus `EXIT_ON_IDLE=true`, feed URLs from Secret Manager via
   `value_source.secret_key_ref`, placeholder image
   `us-docker.pkg.dev/cloudrun/container/hello`, and
   `lifecycle { ignore_changes }` on the image, `client`, `client_version`, and every other field a
   `gcloud run deploy --image` leaves behind (template labels and annotations, revision, container
   name, execution environment).
2. `google_cloud_run_v2_service_iam_member` `allUsers` → `roles/run.invoker`.
3. Runtime SA with **no project roles**; `secretmanager.secretAccessor` on each secret only.
4. Three `google_secret_manager_secret` (schedule, vehicle positions, trip updates), each with a
   `google_secret_manager_secret_version` holding only the PLACEHOLDER (`https://placeholder.invalid/set-me`;
   Cloud Run cannot create a service whose secret has no version). Real URLs are added by the operator
   as new versions out-of-band so they never enter state. The placeholder uses the write-only
   `secret_data_wo` (+ `secret_data_wo_version`), so Terraform never stores or reads it back
   (a refresh of a plain `secret_data` calls `versions/N:access`, which the plan identity must never
   hold); this needs Terraform >= 1.11. Document
   `gcloud secrets versions add …` in the README.
5. `google_artifact_registry_repository` (docker, same region) with a cleanup policy keeping
   the most recent N (default 10) versions and deleting untagged older than 7 days.
6. `google_billing_budget` (thresholds 0.5/0.9/1.0, default IAM recipients = billing admins),
   gated on `manage_budget` only. Its billing account is derived from the project (CI has no
   billing-account input); the plan fails loudly if none is found. Operator overrides live in the
   committed `infra/settings.auto.tfvars`.
7. Deploy SA `deploy`, with: `artifactregistry.writer` on the repo, `run.developer` on the
   service, `iam.serviceAccountUser` on the runtime SA, and `workloadIdentityUser` for the
   principalSet `…/attribute.target/<repo>/.github/workflows/deploy.yml:refs/heads/main`
   (attribute mapping defined by bootstrap — see its naming contract).
8. Outputs: service URL, registry path, deploy SA email, runtime SA email.

`infra/README.md`: first-apply steps (local, ADC), how to add secret values, variables,
how the pipeline applies thereafter, and the import/recovery path.

Environment notes: the Terraform CLI is not installed — download it from
`releases.hashicorp.com` (reachable) into the scratchpad. `registry.terraform.io` is **not**
reachable, but `releases.hashicorp.com/terraform-provider-google/<ver>/…` is: fetch the
provider zip into a local filesystem mirror and `terraform init -plugin-dir=<mirror>`
(or a CLI-config `filesystem_mirror`) so `terraform validate` can run.

## Validation
- [x] `terraform fmt -check -recursive infra` clean.
- [x] `terraform init -backend=false` (via the local provider mirror) and `terraform validate` pass.
- [x] A `terraform plan`-free review shows: max instances 1, min 0, CPU always allocated,
      concurrency 80, 1 vCPU / 2 GiB, `ignore_changes` on the image, public invoker, runtime SA
      without project roles, three secrets each holding only a write-only placeholder version,
      registry cleanup policy, budget thresholds.
- [x] No secret value, feed URL, or service-account key resource appears anywhere in `infra/`.
- [x] Deploy SA grants are the three scoped roles and nothing broader; its WIF member matches
      the bootstrap naming contract exactly.
- [x] Variable defaults match `specs/behaviors/configuration.md` and `specs/infrastructure.md`.
- [ ] `terraform plan`/`apply` against a real project (cannot be verified here; operator step).

## Risks / unknowns
- **Unverified apply** — validate catches schema errors, not IAM/API-enablement problems.
- **Budget permissions** — `manage_budget=false` must cleanly omit the resource.
- **Provider version drift** — pin `~> 6`; record the mirrored version in Notes.
- **Terraform >= 1.11** — write-only arguments; the `ci-cd` pipelines must install 1.11 or newer.
- **Plan identity vs. secret values (found in review)** — a refresh of a plain-`secret_data` version
  needs `secretmanager.versions.access`; fixed with `secret_data_wo`. A placeholder version must
  never be imported or destroyed by hand (it would be recreated as the newest version).
- **Settings must be committed (found in review)** — CI has no billing-account or other variable
  input, so anything not in a default or in `infra/settings.auto.tfvars` is reverted by CI's next
  apply; the budget's account is therefore derived, and a missing one fails the plan.
- **Quota-project header (found in review)** — the budget provider alias sends
  `X-Goog-User-Project`, so `tf-plan` needs `serviceusage.services.use`.
- **Deploy-written fields (found in review)** — `gcloud run deploy` changes the template label
  `client.knative.dev/nonce` and client annotations on every deploy; unignored, the next plan
  restarts the service.

## Notes
Terraform 1.16.7 and `hashicorp/google` 6.50.0 (constraint `~> 6.0`, `required_version >= 1.11`), fetched from
releases.hashicorp.com (checksums verified against the published SHA256SUMS) into a filesystem mirror.
`infra/.terraform.lock.hcl` is committed with h1 hashes for linux_amd64, linux_arm64, darwin_amd64,
darwin_arm64 and windows_amd64 (`terraform providers lock -fs-mirror` from the official zips; h1 hashes are
content hashes, so they equal what the registry yields).

**Adversarial review fixes.** A review of the first version found two blockers and two majors, all
reproduced with a mock Google API; each is fixed and re-proved with the same mock.
- **B1, plan identity reading secret payloads.** A plain `secret_data` makes every refresh call
  `versions/N:access`, which `tf-plan` must never hold. The placeholder versions now use
  `secret_data_wo` with `secret_data_wo_version = 1` (Terraform >= 1.11). Proof against the mock with `:access`
  answering 403: create succeeds (an `addVersion` POST, no `:access`); the next refreshing plan makes 21 calls,
  none to `:access`, and reports no changes; `grep placeholder.invalid terraform.tfstate` finds nothing, and
  `secret_data` / `secret_data_wo` are null in state. The README forbids importing a placeholder version and
  documents recovery from lost state.
- **B2, the budget disappearing in CI.** CI has no billing-account input, so a budget gated on
  `var.billing_account != ""` would be destroyed by the first apply on `main`. The account is now
  `local.billing_account`: `var.billing_account` if set, else the project's linked account from
  `data.google_project.this.billing_account` (Cloud Billing `getBillingInfo`). The budget is gated on
  `manage_budget` only and has a `precondition` that fails the plan, naming the fixes, when no account resolves
  (verified with an unlinked project, and with `cloudbilling.googleapis.com` disabled, which the provider
  reports as an empty account). The same CI-blindness applies to every other setting, so operator overrides
  now live in the committed, secret-free `infra/settings.auto.tfvars` (a `.gitignore` exception keeps other
  `*.tfvars` ignored). Because `*.auto.tfvars` outranks `TF_VAR_*`, `region` and the other bootstrap-supplied
  variables must not be put there; the README says so.
- **M1, quota-project header.** The budget provider alias sends `X-Goog-User-Project`, which needs
  `serviceusage.services.use`, which `tf-plan` lacked. Fixed in bootstrap, below.
- **M2, restart after a deploy.** A real `gcloud run deploy --image` (gcloud 570, against a Cloud Run v1 mock that
  records the PUT) changes only: the image; `client-name`/`client-version` annotations on the service and on
  the template; a random `client.knative.dev/nonce` template label; and an empty `nodeSelector`. In provider 6.50
  `template.labels` and `template.annotations` are plain optional, so the nonce showed up as a diff that creates
  a new revision. `ignore_changes` now also lists `template[0].labels`, `template[0].annotations`,
  `template[0].revision`, `template[0].containers[0].name` and `template[0].execution_environment` (the last
  three are values the API fills in; a plain `containers[0].name` and the revision name are not set by Terraform).
  Proof with the mock simulating the post-deploy response (nonce label, client annotations including
  `user-image`, revision, container name, GEN2, new image digest): the old ignore list plans an in-place update
  that removes the label, annotations, revision, name and execution environment; the new list plans
  "No changes". The server-side additions are a simulation, not a live observation.
- **Minor.** `tile_host` uses the server's exact origin pattern and every numeric variable the server's integer
  rules (whole numbers up to 9007199254740991, durations 1000 to 2147483647). Checked by feeding the planned env
  map into the real `loadConfig` (`server/dist/config.js`): the default, the maximum valid values, minimum values,
  a trailing-slash tile host, and an out-of-range port all load; `1e23`, a non-integer, `999` and `2147483648`
  ms, retention above 60 minutes, a history limit under 2 x `RT_MAX_BYTES`, `tiles_x`, a path, userinfo, IPv6 and
  a missing scheme are refused at plan time (the server refuses the same). README now states the real retention
  semantics, per-revision max instances, the first-apply `-var=region`, and the deploy member contract.

**Bootstrap contract amendments required by this plan** (made in `scripts/lib.sh`, `scripts/README.md` and
`scripts/test/run-tests.sh`; `bootstrap-scripts.md` is frozen and untouched):
1. `tf-plan` also holds `roles/serviceusage.serviceUsageConsumer` on the project (M1); it grants no data access.
   The harness asserts it, that `tf-plan` has exactly three project roles, no `secretmanager.*` role, and no
   unconditional write role on the state bucket. Removing the role from `lib.sh` fails the harness.
2. Bootstrap enables `cloudbilling.googleapis.com` (B2). The harness asserts it is enabled.
`specs/infrastructure.md` still lists the old API set and describes the plan identity without the quota-project
role; per instruction no spec was edited, so those two sentences need a spec follow-up.

**Verification** (all against the final tree):
- `terraform fmt -check -recursive infra`, `init -backend=false` (mirror) and `validate`: pass.
- Mock-API harness (local backend, all 19 resources imported or created): a refreshing plan makes 21 GET/POST
  read calls and reports no changes, without `:access` and with the committed (comment-only) settings file. Each
  call maps to a permission that `roles/viewer`, `roles/iam.securityReviewer`, `roles/serviceusage.serviceUsageConsumer`
  and `roles/billing.viewer` hold (checked against the IAM role dataset: projects.get, secrets.get/getIamPolicy,
  versions.get, serviceAccounts.get/getIamPolicy, run.services.get/getIamPolicy, artifactregistry.repositories.get/getIamPolicy,
  billing.budgets.get, and `serviceusage.services.use` for the budget's quota-project header). Without the
  `serviceUsageConsumer` role none of the three plan roles holds `serviceusage.services.use`.
- Plans: with and without the settings file; a settings file overriding `budget_amount`, `trip_updates_enabled`
  and `idle_timeout_ms` is picked up; `manage_budget=false` and an unlinked project give 18 resources and no budget;
  an unlinked project with the budget on fails with the precondition message; a destroy plan with only
  `TF_VAR_project_id/region/github_repository/wif_pool` plans 19 destroys, with `billing_account` unset, set,
  and on an unlinked project.
- Repo toolchain on the rebased tree: `npm ci`, `lint`, `typecheck`, `test`, `build`, `format:check` pass;
  `scripts/test/run-tests.sh` 38 passed; `shellcheck` clean.

**Static review checklist** (reading and grepping `infra/*.tf`):
- No secret value, feed URL or key: the only URLs are the `.invalid` placeholder (write-only, not in state) and
  the tile host default.
- No `google_service_account_key`, no `google_project_iam_*`, no `prevent_destroy`.
- No project-level grant to the runtime or deploy SA. Runtime: `secretAccessor` on each of the three secrets.
  Deploy: `artifactregistry.writer` on the repository, `run.developer` on the service, `iam.serviceAccountUser` on
  the runtime SA only, and `workloadIdentityUser` on itself for
  `principalSet://iam.googleapis.com/${wif_pool}/attribute.target/${github_repository}/.github/workflows/deploy.yml:refs/heads/main`.
- `allUsers` appears once, as `roles/run.invoker` on the service.
- Variables `project_id`, `region`, `github_repository`, `wif_pool`, `billing_account` equal the `TF_VAR_*` names in
  `scripts/teardown.sh`; all others have defaults. Destroy works with those inputs only: `deletion_protection = false`,
  nothing `prevent_destroy`, preconditions are not evaluated on destroy, placeholder versions go with their secrets.
- Defaults equal specs/configuration.md and `server/src/config.ts`; env var names equal server/README.md's.

**Decisions kept from the first round.** All eleven tunables plus `EXIT_ON_IDLE=true` and `TILE_HOST` are passed
(infrastructure.md says the tunables are passed). The registry DELETE policy is any image older than 7 days, not
only untagged, because SHA-tagged images would otherwise accumulate; KEEP (10 most recent versions) wins. The
cross-variable rules are `precondition`s on the service. The budget alias provider is kept for operators' user
credentials. All three secrets exist even when a feed is disabled. Names: secrets `schedule-url`,
`vehicle-positions-url`, `trip-updates-url`; service accounts `runtime`, `deploy`; service and repository
`gtfs-rt-debugger`.

**Criterion amended.** The validation box "A `terraform plan`-free review shows ..." originally said "three empty secrets", which predates the placeholder-version design; its wording was amended in its own commit (`docs(plans): terraform-infra criterion says secrets hold placeholder versions`) before this closeout, and it is checked on the strength of the real offline plans and the mock plans above. The live `terraform plan`/`apply` box is unchecked: no GCP project
was available. Unverified live: API enablement and IAM propagation; the `allUsers` org-policy caveat;
`getBillingInfo` with the plan identity's roles; the budget API's quota-project behavior; the server-side fields
the Cloud Run API adds after a deploy (simulated); and bootstrap's `split()` attribute mapping, which the deploy
member depends on.

## Follow-ups
Tracked as: none filed.
- `specs/infrastructure.md`: add `cloudbilling.googleapis.com` to the bootstrap API list and the quota-project
  role to the plan identity (spec edit, not made here).
- `ci-cd`: install Terraform >= 1.11; pass only `project_id`, `region`, `github_repository`, `wif_pool`; the
  deploy workflow must be `.github/workflows/deploy.yml` on `refs/heads/main`, use `gcloud run deploy --image`
  only, and take the names above.
- First live apply: check `terraform plan` shows no diff straight after the first `gcloud run deploy`, and that
  the first PR plan as `tf-plan` succeeds (budget and billing-account reads).

