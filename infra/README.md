# Terraform infrastructure

One root module, one environment, in one dedicated GCP project. It creates what the app runs
on; `scripts/bootstrap.sh` creates what Terraform needs in order to run (state bucket,
Workload Identity pool, the `tf-plan` and `tf-apply` identities). The desired behavior is in
[`specs/infrastructure.md`](../specs/infrastructure.md) and
[`specs/deployment.md`](../specs/deployment.md#identities).

## What it creates

| Resource                     | Name                                                                             | Notes                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run service            | `gtfs-rt-debugger`                                                               | Max 1 / min 0 instances, CPU always allocated, 1 vCPU, 2 GiB, concurrency 80, port 8080, public. Starts on a placeholder image.                         |
| Runtime service account      | `runtime@<project>.iam.gserviceaccount.com`                                      | No project roles. `secretmanager.secretAccessor` on each feed secret only.                                                                              |
| Secret Manager secrets       | `schedule-url`, `vehicle-positions-url`, `trip-updates-url`                      | Automatic replication. Each holds a placeholder first version only; the operator adds the real URL.                                                     |
| Artifact Registry repository | `gtfs-rt-debugger` (Docker)                                                      | Keeps the 10 most recent versions; deletes anything else older than 7 days.                                                                             |
| Deploy service account       | `deploy@<project>.iam.gserviceaccount.com`                                       | `artifactregistry.writer` on the repository, `run.developer` on the service, `iam.serviceAccountUser` on the runtime account. Nothing at project level. |
| Workload Identity binding    | `…/attribute.target/<owner>/<repo>/.github/workflows/deploy.yml:refs/heads/main` | `roles/iam.workloadIdentityUser` on the deploy account: only `deploy.yml` on `main` can impersonate it.                                                 |
| Billing budget (optional)    | `gtfs-rt-debugger monthly`                                                       | Alerts at 50 %, 90 % and 100 % of `budget_amount` USD to billing administrators. Skipped unless `manage_budget` and `billing_account` are both set.     |

APIs are not enabled here: bootstrap enables them. Terraform never creates a service account
key, and no feed URL ever enters its state.

## Operator runbook

1. **Create the project and link billing** (a billing account dedicated to this project is
   best; see [scripts/README.md](../scripts/README.md#what-tf-plan-can-see-on-the-billing-account)).

   ```bash
   gcloud projects create <project-id>
   gcloud billing projects link <project-id> --billing-account=<ACCOUNT_ID>
   ```

2. **Bootstrap** as a project owner, and set the four GitHub repository variables it prints:

   ```bash
   scripts/bootstrap.sh --project <project-id> --repo <owner>/<repo>
   ```

3. **First apply, locally**, with your own credentials. CI cannot do this one: the pipelines
   need the identities and the service this apply creates.

   ```bash
   gcloud auth application-default login
   cd infra
   terraform init -backend-config=bucket=<project-id>-tfstate
   terraform apply \
     -var=project_id=<project-id> \
     -var=github_repository=<owner>/<repo> \
     -var=wif_pool=projects/<project-number>/locations/global/workloadIdentityPools/github \
     -var=billing_account=<ACCOUNT_ID>
   ```

   `<project-number>` is `gcloud projects describe <project-id> --format='value(projectNumber)'`.
   Leave out `billing_account` (or pass `-var=manage_budget=false`) to skip the budget, for
   example when bootstrap could not grant the billing roles. Once the roles exist, apply again
   with the budget on. The service starts on Google's placeholder hello image; the first deploy
   from `main` replaces it.

4. **Add the real feed URLs** as new secret versions. Terraform never sees them. Read each
   value without echoing it or writing it to shell history:

   ```bash
   read -rs URL && printf '%s' "$URL" | gcloud secrets versions add schedule-url --project=<project-id> --data-file=- ; unset URL
   read -rs URL && printf '%s' "$URL" | gcloud secrets versions add vehicle-positions-url --project=<project-id> --data-file=- ; unset URL
   read -rs URL && printf '%s' "$URL" | gcloud secrets versions add trip-updates-url --project=<project-id> --data-file=- ; unset URL
   ```

   Put credentials in the query string, not before the host. The service reads the `latest`
   version when an instance starts, so a running instance picks the new value up after it
   exits on idle (or when the next deploy replaces it). Leave version 1, the placeholder, in
   place (see [Gotchas](#gotchas)).

5. **Check the service.** `terraform output service_url` prints the URL. Until the first deploy
   it serves the hello image. After it, open the URL, or
   `curl -X POST "$(terraform output -raw service_url)/api/v1/session/start"`, and watch the
   schedule load.

6. **From here on CI applies.** A pull request that changes `infra/` runs `fmt -check`,
   `validate` and `plan` as `tf-plan`; a push to `main` runs `plan` and `apply` as `tf-apply`
   (see [`specs/deployment.md`](../specs/deployment.md#infrastructure-changes-under-infra-or-the-infra-workflow)).
   The pipeline passes the same variables, taken from the repository variables. Applying locally
   stays possible; it uses the same state.

## Variables

Set with `-var`, `TF_VAR_*` or a `*.tfvars` file (git-ignored). The first five are the ones
`scripts/teardown.sh` passes to `terraform destroy`; every other variable has a default, so
destroy needs nothing else.

| Variable                      | Default                                      | Meaning                                                                                               |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `project_id`                  | required                                     | The dedicated GCP project.                                                                            |
| `region`                      | `us-west1`                                   | Cloud Run and Artifact Registry region.                                                               |
| `github_repository`           | required                                     | `owner/repo`, exact case.                                                                             |
| `wif_pool`                    | required                                     | Full pool name, `projects/<number>/locations/global/workloadIdentityPools/github`.                    |
| `billing_account`             | `""`                                         | Billing account ID. Empty skips the budget.                                                           |
| `manage_budget`               | `true`                                       | `false` leaves the budget out.                                                                        |
| `budget_amount`               | `25`                                         | Monthly budget in whole USD.                                                                          |
| `container_image`             | `us-docker.pkg.dev/cloudrun/container/hello` | Image for the first creation only; ignored afterwards (the deploy pipeline owns it).                  |
| `registry_keep_count`         | `10`                                         | Most recent image versions always kept.                                                               |
| `vehicle_positions_enabled`   | `true`                                       | `false` omits the feed's variable and secret reference: the server treats the feed as not configured. |
| `trip_updates_enabled`        | `true`                                       | As above. At least one of the two must stay enabled.                                                  |
| `tile_host`                   | `https://tiles.openfreemap.org`              | Map tile origin the Content-Security-Policy allows (`TILE_HOST`).                                     |
| `poll_interval_ms`            | `10000`                                      | `POLL_INTERVAL_MS`                                                                                    |
| `rt_timeout_ms`               | `8000`                                       | `RT_TIMEOUT_MS`                                                                                       |
| `rt_max_bytes`                | `26214400`                                   | `RT_MAX_BYTES`                                                                                        |
| `schedule_timeout_ms`         | `120000`                                     | `SCHEDULE_TIMEOUT_MS`                                                                                 |
| `schedule_max_bytes`          | `104857600`                                  | `SCHEDULE_MAX_BYTES`                                                                                  |
| `schedule_memory_limit_bytes` | `805306368`                                  | `SCHEDULE_MEMORY_LIMIT_BYTES`                                                                         |
| `idle_timeout_ms`             | `900000`                                     | `IDLE_TIMEOUT_MS`                                                                                     |
| `max_activation_ms`           | `7200000`                                    | `MAX_ACTIVATION_MS`                                                                                   |
| `retention_ms`                | `3600000`                                    | `RETENTION_MS`; at most 60 minutes, which is also the server's ceiling.                               |
| `history_memory_limit_bytes`  | `536870912`                                  | `HISTORY_MEMORY_LIMIT_BYTES`; at least 2 x `rt_max_bytes`.                                            |
| `rate_limit_per_min`          | `120`                                        | `RATE_LIMIT_PER_MIN`                                                                                  |

The tunable defaults must equal the server's defaults ([`server/README.md`](../server/README.md#environment));
the server is the source of truth and refuses to start on a value it cannot use, so the
variables repeat its rules (durations 1000 to 2147483647 ms, the history limit, the tile
origin) to fail at plan time instead. `EXIT_ON_IDLE=true` is always passed; `PORT` is injected
by Cloud Run.

## Outputs

`service_url`, `service_name`, `registry_path` (`<region>-docker.pkg.dev/<project>/gtfs-rt-debugger`),
`deploy_service_account`, `runtime_service_account`, and `github_variables` (the four repository
variables `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `TF_STATE_BUCKET`).

## What the deploy pipeline owns

The deploy workflow runs `gcloud run deploy --image`, so Terraform ignores the attributes it
rewrites: the container image, and `client` / `client_version` (gcloud stamps itself there).
Everything else gcloud touches is either not managed here (annotations, labels and revision
names are non-authoritative or computed in provider 6) or untouched by `--image` (environment
variables, secrets, scaling, resources). An apply therefore never rolls the app back, and a
deploy never changes infrastructure settings.

## Destroying

```bash
scripts/teardown.sh --project <project-id> --repo <owner>/<repo>
```

Teardown runs `terraform destroy` first (passing `project_id`, `region`, `github_repository`,
`wif_pool` and `billing_account`), then removes what bootstrap created. Destroy works with
only those inputs: the Cloud Run service has `deletion_protection = false`, nothing has
`prevent_destroy`, and the placeholder secret versions are destroyed with their secrets. Add
`--dry-run` first to see what it would remove.

## Cost notes

The configuration is the cost ceiling ([`specs/infrastructure.md`](../specs/infrastructure.md#cost-guards)):
one instance, scale to zero, exit 15 minutes after the last browser ping, 2 hours per
activation. Always-on CPU is billed only while an instance exists. The worst case is one
instance running all month (about one vCPU and 2 GiB, tens of dollars). The budget alerts at
50 %, 90 % and 100 % of `budget_amount`; it does not stop spending. Image cleanup, three
secrets and one small state bucket are negligible.

## Importing what already exists

If an apply fails with "already exists" (an interrupted first apply, or a resource created by
hand), import it into state and re-apply. With the same `-var` flags as the apply:

```bash
terraform import google_service_account.runtime projects/<project-id>/serviceAccounts/runtime@<project-id>.iam.gserviceaccount.com
terraform import google_service_account.deploy projects/<project-id>/serviceAccounts/deploy@<project-id>.iam.gserviceaccount.com
terraform import google_artifact_registry_repository.images projects/<project-id>/locations/<region>/repositories/gtfs-rt-debugger
terraform import 'google_secret_manager_secret.feed["SCHEDULE_URL"]' projects/<project-id>/secrets/schedule-url
terraform import google_cloud_run_v2_service.app projects/<project-id>/locations/<region>/services/gtfs-rt-debugger
terraform import 'google_billing_budget.monthly[0]' billingAccounts/<ACCOUNT_ID>/budgets/<budget-id>
```

`terraform state list` shows the addresses of everything else. IAM members, secret versions and
the other secrets import the same way (see the provider documentation for each ID format).
Never import or manage a real secret version: that would put a feed URL in state.

If a bootstrap-created resource is missing or wrong, fix it by re-running `scripts/bootstrap.sh`,
not here.

## Gotchas

- **Do not destroy the placeholder version.** Terraform keeps each secret's version 1 (the
  placeholder) and ignores its data. If version 1 is destroyed by hand, the next apply
  recreates it as the newest version and the service would read the placeholder again. Disable
  it instead if you must, then add a fresh real version.
- **Public access and organization policy.** The service is public through an `allUsers`
  `roles/run.invoker` grant. An organization policy such as domain restricted sharing
  (`iam.allowedPolicyMemberDomains`) blocks that grant and the apply fails on
  `public_invoker`. Use a project outside such a policy, or have the policy relaxed for this
  project.
- **Budget access.** Planning the budget needs `roles/billing.viewer` on the billing account for
  `tf-plan` and applying it needs `roles/billing.costsManager` for `tf-apply`; bootstrap grants
  both if it can (see [scripts/README.md](../scripts/README.md#what-tf-plan-can-see-on-the-billing-account)).
  The budget uses a second provider configuration with `user_project_override`, so calls for
  that one resource are billed to this project's quota (required when you apply with your own
  user credentials).
- **Provider version.** `hashicorp/google` is pinned to `~> 6.0`; `.terraform.lock.hcl` is
  committed with checksums for linux, macOS and Windows. Run `terraform init -upgrade` and commit
  the lock file to move to a newer 6.x.
