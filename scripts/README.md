# Bootstrap and teardown scripts

`bootstrap.sh` does the one-time setup Terraform cannot do for itself; `teardown.sh`
undoes it (and, first, everything Terraform created). The desired behavior is specified in
[`specs/infrastructure.md`](../specs/infrastructure.md#bootstrap-and-teardown-scripts);
this file is the operator runbook and the naming contract that `infra/` and
`.github/workflows/` depend on.

Both scripts are bash (written to run on bash 3.2, the macOS default) with strict error handling, need
only `gcloud` (plus `terraform` for teardown's destroy step), take every input as a flag
with an environment-variable fallback, print each change before making it, and support
`--dry-run`. Run either with `--help` for the full flag list.

| Flag | Env fallback | Default | Used by |
|---|---|---|---|
| `--project <project-id>` | `PROJECT_ID` | none (required) | both |
| `--repo <owner/repo>` | `GITHUB_REPO` | none (required; for teardown only when Terraform runs) | both |
| `--region <region>` | `REGION` | `us-west1` | both |
| `--dry-run` | | off | both |
| `--confirm-project <project-id>` | | prompt on stdin | teardown |
| `--skip-terraform` | | off | teardown |
| `--delete-project` | | off | teardown |
| `--confirm-delete-project <project-id>` | | prompt on stdin | teardown |

Flags win over environment variables. `--repo` must be the full `owner/repo` with the exact
case GitHub uses, because the Workload Identity provider compares it verbatim.

## Order of operations

1. Create the project (`gcloud projects create <project-id>`) and link billing
   (`gcloud billing projects link <project-id> --billing-account=<ACCOUNT_ID>`).
2. Authenticate as a project owner (`gcloud auth login`) and run
   `scripts/bootstrap.sh --project <project-id> --repo <owner>/<repo>`.
   Try `--dry-run` first to see every change it would make.
3. Set the four GitHub repository variables it prints (see below).
4. First `terraform apply`, locally, with your own credentials
   (`gcloud auth application-default login`), using the commands bootstrap prints. See
   `infra/README.md` for the full variable list.
5. Add the three feed-URL secret values (`gcloud secrets versions add`; `infra/README.md`).
6. Merge to `main`; the pipelines deploy from then on.

To undo: `scripts/teardown.sh --project <project-id> --repo <owner>/<repo>`.

## bootstrap.sh

Idempotent: every step checks first and creates only what is missing, so re-running after a
partial failure finishes the job and a full re-run makes no changes. It never creates a
service-account key. It never adopts what it did not create. In order, it:

1. Verifies the project exists and is active, billing is linked (otherwise it prints the
   `gcloud billing projects link` command and stops), and `--repo` is a full `owner/repo`.
   Then, before changing anything, it refuses the two things it must never adopt (below).
2. Enables the APIs listed in the contract below (not Cloud Build: images are built in CI).
3. Creates the state bucket in `--region` with uniform bucket-level access and public access
   prevention, then turns on versioning and adds the bootstrap label. If the bucket already
   exists in the project:
   - **labeled**: it only gets versioning if it lacks it;
   - **unlabeled and empty** (what an interrupted run leaves): it is adopted (versioned and
     labeled);
   - **unlabeled and not empty**: bootstrap refuses it and stops, because the label is what
     lets teardown delete the bucket with every version. It prints the
     `gcloud storage buckets update ... --update-labels=...` command to adopt it deliberately,
     if it really is this app's state bucket. No role is granted on a refused bucket.
4. Creates the Workload Identity pool and GitHub OIDC provider. A pool or provider deleted
   in the last 30 days (still soft-deleted, so its ID cannot be reused) is undeleted. An
   existing provider (active or soft-deleted) whose attribute condition, attribute mapping
   or issuer differs from the contract is refused, never reused or undeleted. Bootstrap
   stops and prints the `update-oidc` command that would make it conform.
5. Creates the `tf-plan` and `tf-apply` service accounts, then adds their project, state
   bucket and Workload Identity bindings.
6. Grants the billing roles on the project's billing account. If you cannot (you are not
   a billing account administrator), it prints the exact commands for someone who can;
   until they run them, apply Terraform with `-var=manage_budget=false`.
7. Prints the GitHub repository variables and the next steps. It never touches GitHub.

A binding that fails right after its service account was created (IAM is eventually
consistent) is fixed by re-running the script.

Every check fails closed. Only an explicit `NOT_FOUND` (or 404) from gcloud counts as
"absent". Any other error stops the script with gcloud's message: permission denied, a
disabled API, a network failure. Under `--dry-run`, resources behind an API the run would
enable are assumed absent.

## teardown.sh

The escape hatch, and the way to remove the app entirely. In order, it:

1. Checks the project exists (a project already shut down is reported and left alone),
   then asks you to type the project ID, or takes it from `--confirm-project`. Anything
   else stops it before it changes anything. `--dry-run` skips the prompt and prints what
   it would delete.
2. Unless `--skip-terraform`, runs `terraform init` and `terraform destroy` in `infra/`
   against the state bucket, passing `TF_VAR_project_id`, `TF_VAR_region`,
   `TF_VAR_github_repository`, `TF_VAR_wif_pool` and `TF_VAR_billing_account`. If the
   destroy fails, teardown stops, keeping the state and the identities so you can fix the
   problem and re-run. If the state bucket is gone, or lacks the bootstrap label (so it is
   not bootstrap's), the step is skipped with a warning: anything Terraform created must
   then be removed by hand, or with `--delete-project`.
3. Removes every project-level and billing-account binding of `tf-plan` and `tf-apply`:
   - any role or condition, including roles added by hand. Project bindings are removed with
     `--all`, and `deleted:serviceAccount:<email>?uid=...` leftovers are removed too.
   - Bindings of any other principal are left alone.
   - A billing binding that is already gone is skipped. Any other failure stops teardown.

   It then deletes both service accounts, and the provider and then the pool (both
   soft-delete for 30 days; bootstrap undeletes them). Last, it deletes the state bucket with
   every object version, **only if the bucket carries the bootstrap label**. A bucket without
   the label is left untouched, with a warning.
4. With `--delete-project`, asks for the project ID a second time (or
   `--confirm-delete-project`), then shuts down the whole project as the last step.
   Without it, the project and its billing link are left alone.

Everything is found by the fixed names below. A resource that gcloud reports as `NOT_FOUND`
is skipped, so teardown can be re-run after a partial failure. Any other error stops it with
a non-zero exit, before the state bucket is deleted: permission denied, a network failure.
The bucket is deleted only after every earlier step has succeeded, so its state is never
lost while the resources it describes remain. Cloud Storage keeps deleted objects for its
soft-delete period (7 days by default); this costs next to nothing.

## Naming contract

Terraform (`infra/`) and the workflows (`.github/workflows/`) hardcode these values. They
are the constants in [`lib.sh`](lib.sh); `scripts/test/run-tests.sh` fails if this table
and `lib.sh` disagree. In this table, `<owner>/<repo>` is `--repo` and `<project-number>`
is the project's number.

| Thing | Value |
|---|---|
| State bucket | `<project-id>-tfstate`: versioned, uniform bucket-level access, public access prevention, label `gtfs-rt-debugger-bootstrap=true`, location `--region`. Labeled only when bootstrap creates it or finds it empty; a non-empty unlabeled bucket is refused |
| Terraform state prefix | set by `infra/`'s backend block, not by bootstrap |
| WIF pool | `github`, location `global`: `projects/<project-number>/locations/global/workloadIdentityPools/github` |
| WIF provider | `github` (OIDC, issuer `https://token.actions.githubusercontent.com`, default audience): `projects/<project-number>/locations/global/workloadIdentityPools/github/providers/github` |
| Provider attribute mapping | `google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.target=assertion.job_workflow_ref.split('@')[0] + ':' + (assertion.event_name == 'pull_request' ? 'pr' : assertion.ref)` |
| Provider attribute condition | `assertion.repository == '<owner>/<repo>'` (an existing provider with any other condition, mapping or issuer is refused) |
| Infrastructure workflow | `.github/workflows/infra.yml` |
| Plan identity | `tf-plan@<project-id>.iam.gserviceaccount.com` (service account `tf-plan`) |
| Plan member (`roles/iam.workloadIdentityUser` on `tf-plan`) | `principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/github/attribute.target/<owner>/<repo>/.github/workflows/infra.yml:pr` |
| Plan roles, project | `roles/viewer`, `roles/iam.securityReviewer` |
| Plan roles, state bucket only | `roles/storage.objectViewer` (read state), plus `roles/storage.objectUser` with the IAM condition `resource.name.endsWith(".tflock")` (title `terraform-lock-objects`): its only write access is to Terraform lock objects |
| Plan roles, billing account | `roles/billing.viewer` (lets `terraform plan` read the budget; see below), if the operator can grant it |
| Apply identity | `tf-apply@<project-id>.iam.gserviceaccount.com` (service account `tf-apply`) |
| Apply member (`roles/iam.workloadIdentityUser` on `tf-apply`) | `principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/github/attribute.target/<owner>/<repo>/.github/workflows/infra.yml:refs/heads/main` |
| Apply roles, project | `roles/run.admin`, `roles/artifactregistry.admin`, `roles/secretmanager.admin`, `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountUser`, `roles/serviceusage.serviceUsageConsumer` |
| Apply roles, state bucket only | `roles/storage.objectAdmin` |
| Apply roles, billing account | `roles/billing.costsManager` (manage the budget), if the operator can grant it; otherwise bootstrap prints the command |
| Enabled APIs | `run.googleapis.com`, `artifactregistry.googleapis.com`, `secretmanager.googleapis.com`, `iam.googleapis.com`, `iamcredentials.googleapis.com`, `sts.googleapis.com`, `cloudresourcemanager.googleapis.com`, `serviceusage.googleapis.com`, `billingbudgets.googleapis.com`, `storage.googleapis.com` |
| Default region | `us-west1` |

The `attribute.target` attribute is `<owner>/<repo>/<workflow path>:<target>`, where
`<target>` is `pr` for `pull_request` events and the Git ref otherwise. So `tf-plan` can be
impersonated only by `infra.yml` running for a pull request, and `tf-apply` only by
`infra.yml` running on `refs/heads/main`. The **deploy** identity is created by Terraform
(`infra/`), with the member `…/attribute.target/<owner>/<repo>/.github/workflows/deploy.yml:refs/heads/main`.

### What tf-plan can see on the billing account

`terraform plan` must read the billing budget, and the only predefined role that allows it is
`roles/billing.viewer` on the whole billing account. It also exposes the spend and cost
information of **every project on that billing account** to anything running as `tf-plan`,
including the infrastructure workflow of any same-repository pull request. This is an
accepted trade-off ([`specs/infrastructure.md`](../specs/infrastructure.md#principles)).
Link the project to a **billing account dedicated to it**, so the exposure covers only this
app's own spend. If that is not possible, do not grant the role (bootstrap then prints the
command instead) and run Terraform with `-var=manage_budget=false`.

### Unconfirmed: the attribute mapping's `split`

The `attribute.target` mapping uses the CEL string function
`assertion.job_workflow_ref.split('@')[0]`. Google documents the attribute-mapping CEL
dialect separately from gcloud, and gcloud's help could not confirm that `split` is
supported. The first live bootstrap should confirm it: `create-oidc` fails if the expression
is rejected. If it is rejected, the fallback is `assertion.job_workflow_ref.extract('{w}@')`.
That fallback changes the contract here, in `lib.sh`, and in every consumer of the
member strings.

### GitHub repository variables

Bootstrap prints these, with `gh variable set` commands. No GitHub secrets are used.

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | the project ID |
| `GCP_PROJECT_NUMBER` | the project number (to build the Workload Identity provider path) |
| `GCP_REGION` | `--region` |
| `TF_STATE_BUCKET` | `<project-id>-tfstate` |

### Adding a role to tf-apply

If a `terraform apply` fails on a missing permission, add the role to `APPLY_PROJECT_ROLES`
in `lib.sh`, update the table above in the same commit, and re-run `bootstrap.sh`: it adds
only the new binding. Teardown removes every binding of the two identities, whatever the
role.

## Tests

`scripts/test/run-tests.sh` runs both scripts against a fake `gcloud`
(`scripts/test/fake-bin/gcloud`) and a fake `terraform` (`scripts/test/fake-tf/terraform`)
with a minimal `PATH`, so nothing real is ever called. The fake records every call as
read or mutating, simulates resources as files, and fails on any command it does not know.
The tests cover: step order, an idempotent re-run that makes no changes, completing a
partial run, `--dry-run` making no changes, the exact contract values above, teardown's
confirmations, refusing to delete an unlabeled bucket, tolerating already-deleted
resources, and that no key is ever created.

```bash
scripts/test/run-tests.sh
shellcheck scripts/*.sh scripts/test/*.sh scripts/test/fake-bin/gcloud scripts/test/fake-tf/terraform
```

If `shellcheck` is not installed: `pip install shellcheck-py`.
`scripts/.shellcheckrc` lets it follow `source lib.sh`.
