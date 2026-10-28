# Deployment

How code and infrastructure reach the single environment. GitHub Actions is the only path
to the environment after bootstrap ([infrastructure.md](infrastructure.md)); there is no
manual deploy step.

## Environment

One environment, deployed from `main`. There are no preview or staging deployments, so a
pull request can never create billable infrastructure.

## Pipelines

### CI (every pull request and every push to `main`)

Lint, type-check, unit tests, and a production build of the web app and server, and a
container image build (not pushed). The same checks run for pull requests and `main`, so a
merge cannot fail checks that passed on the PR. CI also checks formatting, runs the script and
workflow test suites and Terraform `fmt`/`validate`, smoke-tests the built image, and reports
(advisory) `npm audit`. The Playwright suite (`npm run e2e`) is run manually, not by CI. Changes that only touch documentation
(`specs/`, `plans/`, markdown, agent config) do not trigger the deploy pipeline.

### Deploy (push to `main`, app code changed)

After CI passes: build the image, tag it with the commit SHA, push it to Artifact
Registry, and deploy that image to the Cloud Run service. Deploys are serialized (one at a
time, never cancelled mid-flight). A deploy never changes the service's infrastructure
settings, secrets, or environment variables — those belong to Terraform. Rolling back means
deploying an earlier commit's image, available as a manually triggered run that takes a
commit SHA. The registry keeps only the 10 most recent image versions and nothing older than
7 days beyond them ([infrastructure.md](infrastructure.md)), so a rollback to an older commit
rebuilds that commit's image first (or fails with a clear message if it cannot).

### Infrastructure (changes under `infra/` or the infra workflow)

- **Pull request:** `terraform fmt -check`, `validate`, and `plan`, using the read-only plan
  identity; the plan is posted to the PR as a single comment that is updated on each push.
- **Push to `main`:** `plan` then `apply` with the apply identity. Infrastructure applies
  are serialized.

## Identities

All authentication uses Workload Identity Federation ([infrastructure.md](infrastructure.md#bootstrap-and-teardown-scripts));
no keys are stored in GitHub.

| Identity | Created by | Capability                                                                                                           | Reachable from                |
| -------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| plan     | bootstrap  | read project state and the billing budget; write Terraform lock objects only                                         | infra workflow, pull requests |
| apply    | bootstrap  | manage the resources in infrastructure.md                                                                            | infra workflow, `main`        |
| deploy   | Terraform  | push images to the one registry; update the one Cloud Run service; act as the runtime service account — nothing else | deploy workflow, `main`       |

A same-repo pull request runs the workflow file from the PR, so the pull-request identity
stays read-only: it must not be able to deploy or change anything.

## Configuration in GitHub

Repository variables only — project ID, project number, region, state bucket — as printed
by bootstrap. No secrets are stored in GitHub. The pipelines read the project number to
form the Workload Identity provider path; everything else is derived.

## Principles

**Inherited**

- [Cost ceiling beats convenience](principles.md#cost-ceiling-beats-convenience) — no
  previews, no extra environments, serialized deploys, image cleanup.
- Local principles of [infrastructure.md](infrastructure.md#principles) (no long-lived
  credentials; least privilege per workflow) govern the identities above.
