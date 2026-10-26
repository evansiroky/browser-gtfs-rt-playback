# ---- Runtime service account: no project roles, only secret access (secrets.tf) ----

resource "google_service_account" "runtime" {
  account_id   = "runtime"
  display_name = "gtfs-rt-debugger runtime"
  description  = "Identity of the Cloud Run service. Its only grant is reading the feed-URL secrets."
}

# ---- Deploy service account: push images, update the one service, act as the runtime SA ----
# Nothing at project level. It is impersonable only by the deploy workflow on main, through
# the Workload Identity pool bootstrap created (scripts/README.md, "Naming contract").

resource "google_service_account" "deploy" {
  account_id   = "deploy"
  display_name = "gtfs-rt-debugger deploy"
  description  = "Used by .github/workflows/deploy.yml on main to push images and roll out the Cloud Run service."
}

resource "google_artifact_registry_repository_iam_member" "deploy_writer" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_cloud_run_v2_service_iam_member" "deploy_developer" {
  location = google_cloud_run_v2_service.app.location
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account_iam_member" "deploy_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account_iam_member" "deploy_workload_identity" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${var.wif_pool}/attribute.target/${var.github_repository}/.github/workflows/deploy.yml:refs/heads/main"
}

# ---- Public access: the site is public by design ----

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  location = google_cloud_run_v2_service.app.location
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
