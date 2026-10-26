---
status: planned
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
(`projects/<number>/locations/global/workloadIdentityPools/github`), `billing_account`,
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
   `lifecycle { ignore_changes = [template[0].containers[0].image, client, client_version] }`.
2. `google_cloud_run_v2_service_iam_member` `allUsers` → `roles/run.invoker`.
3. Runtime SA with **no project roles**; `secretmanager.secretAccessor` on each secret only.
4. Three `google_secret_manager_secret` (schedule, vehicle positions, trip updates), each with a
   `google_secret_manager_secret_version` holding only the PLACEHOLDER (`https://placeholder.invalid/set-me`;
   Cloud Run cannot create a service whose secret has no version). Real URLs are added by the operator
   as new versions out-of-band so they never enter state; Terraform must not manage or replace them
   (`lifecycle { ignore_changes }` on the placeholder version's data). Document
   `gcloud secrets versions add …` in the README.
5. `google_artifact_registry_repository` (docker, same region) with a cleanup policy keeping
   the most recent N (default 10) versions and deleting untagged older than 7 days.
6. `google_billing_budget` (thresholds 0.5/0.9/1.0, default IAM recipients = billing admins),
   gated on `manage_budget`.
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
- [ ] `terraform fmt -check -recursive infra` clean.
- [ ] `terraform init -backend=false` (via the local provider mirror) and `terraform validate` pass.
- [ ] A `terraform plan`-free review shows: max instances 1, min 0, CPU always allocated,
      concurrency 80, 1 vCPU / 2 GiB, `ignore_changes` on the image, public invoker, runtime SA
      without project roles, three secrets each holding only a write-only placeholder version,
      registry cleanup policy, budget thresholds.
- [ ] No secret value, feed URL, or service-account key resource appears anywhere in `infra/`.
- [ ] Deploy SA grants are the three scoped roles and nothing broader; its WIF member matches
      the bootstrap naming contract exactly.
- [ ] Variable defaults match `specs/behaviors/configuration.md` and `specs/infrastructure.md`.
- [ ] `terraform plan`/`apply` against a real project (cannot be verified here; operator step).

## Risks / unknowns
- **Unverified apply** — validate catches schema errors, not IAM/API-enablement problems.
- **Budget permissions** — `manage_budget=false` must cleanly omit the resource.
- **Provider version drift** — pin `~> 6`; record the mirrored version in Notes.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
