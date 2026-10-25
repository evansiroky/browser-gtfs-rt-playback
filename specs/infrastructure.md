# Infrastructure

The Google Cloud resources that run the app, how they are created, and how they are torn
down. There is exactly one environment, in one dedicated GCP project that the operator
creates and links to billing. Everything after bootstrap is Terraform ([deployment.md](deployment.md)
covers how CI applies it).

Governing principle: [Cost ceiling beats convenience](principles.md#cost-ceiling-beats-convenience).

## Resources (managed by Terraform)

| Resource | Rule |
|---|---|
| Cloud Run service | One service. **Max instances 1** (a second process must never run: all state is in one process's memory), **min instances 0**, **CPU always allocated** (the 10 s poller runs between requests), 1 vCPU and 2 GiB memory, request concurrency 80, the container port taken from the platform. Region default `us-west1`, a single variable. |
| Public access | The service is invokable by anyone without authentication (it is a public site). |
| Runtime service account | Dedicated; its only grant is access to the feed-URL secrets. No project-level roles. |
| Secret Manager secrets | One secret per feed URL (schedule, vehicle positions, trip updates). Terraform creates the empty secrets; the operator adds the values out-of-band, so feed URLs and any embedded keys never enter Terraform state, variables, or CI logs. The service reads them as environment variables. |
| Artifact Registry | One Docker repository in the same region, with a cleanup policy keeping only the most recent images. |
| Billing budget | A budget on the project with alert thresholds at 50 %, 90 %, and 100 % of a monthly amount (variable, default 25 USD), delivered to billing administrators. |
| Non-secret configuration | The tunables in [behaviors/configuration.md](behaviors/configuration.md#tunables-and-defaults) are Terraform variables passed to the service as environment variables, with exit-on-idle on. |

Terraform ignores changes to the service's container image: the image is owned by the
deploy pipeline ([deployment.md](deployment.md)), and an infrastructure apply must never roll
the app back. On first creation the service runs a placeholder image until the first deploy.

Terraform state lives in a versioned Cloud Storage bucket created by bootstrap, with a
fixed prefix for this project.

## Cost guards
The configuration above is the cost ceiling: one instance, scale to zero, the process exits
15 minutes after the last browser ping ([session-lifecycle](behaviors/session-lifecycle.md#shutting-down)),
and a 2-hour cap per activation. The worst case is one instance running continuously (about
one vCPU and 2 GiB, in the neighbourhood of tens of dollars a month); the budget alerts
before and at the point the operator chose. Budgets alert; they do not disable billing.
Everything else (Artifact Registry storage, Secret Manager, state bucket, logs) must be
negligible by design: image cleanup policy, 3 secrets, one small bucket, default log
retention.

## Bootstrap and teardown scripts
The scripts do exactly what Terraform cannot do for itself, so they are not Terraform. Both
are POSIX-friendly bash with strict error handling, take their inputs as flags with
environment-variable fallbacks (project ID, region, GitHub `owner/repo`), print every
action before running it, and need only `gcloud`.

### `scripts/bootstrap.sh`
Run once by the operator, authenticated as a project owner, on a project they created.
Idempotent — re-running after a partial failure completes what is missing and changes
nothing that exists. It:

1. Verifies the project exists, billing is linked (and says how to link it if not), and the
   GitHub repository value is a full `owner/repo`.
2. Enables the APIs Terraform and the pipeline need (Cloud Run, Artifact Registry, Secret
   Manager, IAM, IAM Credentials, STS, Cloud Resource Manager, Service Usage, Cloud Billing
   Budget, Cloud Storage). Cloud Build is not used: images are built in CI.
3. Creates the versioned Terraform state bucket.
4. Creates the Workload Identity Federation pool and GitHub OIDC provider, restricted to the
   one GitHub repository, with an attribute that combines the workflow file and the ref so
   each identity below can be impersonated only by one workflow on one ref (or by pull
   requests). No service account keys are ever created.
5. Creates two Terraform identities and binds them: a **plan** identity, read-only apart
   from the state lock — it can read project state and the billing budget, and its only write
   access in the state bucket is to Terraform lock objects — impersonable only by the
   infrastructure workflow on pull requests;
   and an **apply** identity with the roles to manage the resources above, impersonable only
   by the infrastructure workflow on `main`. The apply identity is also given the narrow
   permission to manage budgets on the project's billing account, if the operator running the
   script can grant it (otherwise the script says what to do by hand).
6. Prints the values to set as GitHub repository variables (project ID, project number,
   region, state bucket) — it does not need or touch GitHub credentials — and the next
   steps: first local `terraform apply`, then adding the three secret values.
7. Gives everything it creates a fixed, documented name, and labels the state bucket (the one
   resource that supports labels) so teardown can prove the bucket is bootstrap's own.

The deploy identity and its bindings are created by Terraform, not by the script
([deployment.md](deployment.md#identities)).

### `scripts/teardown.sh`
The escape hatch when something goes wrong, and the way to remove the app entirely. Safe to
re-run and tolerant of partial states: a resource that is already gone is skipped, not an
error. It:

1. Requires the operator to type the project ID to confirm (or pass the same ID via a
   confirm flag for non-interactive use); refuses otherwise. A `--dry-run` prints what it
   would delete.
2. Unless told to skip it, runs `terraform destroy` against the project's state first.
3. Removes what bootstrap created: the identity pool and provider, the plan and apply
   identities and their bindings, and finally the state bucket (including all versions).
   Resources are found by bootstrap's fixed names, and the state bucket is deleted only if it
   carries bootstrap's label.
4. With an explicit `--delete-project`, additionally shuts down the whole project (after a
   second confirmation). Without it, the project and billing link are left alone.
5. Never touches resources it did not create.

## Order of operations for the operator
`create project` → `link billing` → `scripts/bootstrap.sh` → set GitHub repository variables
→ first `terraform apply` (local, placeholder image) → add secret values → merge to `main`
(pipeline deploys). To undo: `scripts/teardown.sh`.

## Principles
**Inherited**
- [Cost ceiling beats convenience](principles.md#cost-ceiling-beats-convenience) — single
  instance, scale to zero, budget alerts, cleanup policies, and a teardown path.
- [The server fetches](principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts)
  — feed URLs are secrets and stay out of state, variables, and logs.

**Local**
- **Never adopt what you did not create.** Bootstrap labels the state bucket only when it
  creates it (or finds it empty, as after an interrupted run); a non-empty bucket without the
  label is someone else's and is refused, because the label is what authorizes teardown to
  delete it. Likewise an existing identity provider that does not match the contract is
  refused, never silently reused.
- **The plan identity can read the budget, and therefore the account's spend.** Planning
  the billing budget requires billing-account viewer access, which also exposes spend
  information for the whole billing account to anything running as the plan identity. This is
  accepted: a billing account dedicated to this project keeps the exposure harmless.
- **No long-lived credentials.** CI authenticates through Workload Identity Federation only;
  creating a service account key is never the answer, in scripts or Terraform.
- **Least privilege per workflow.** A pull request can only plan; only `main` can apply or
  deploy, and each identity is reachable from exactly one workflow file on one ref.
