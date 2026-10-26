output "service_url" {
  description = "Public URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.app.uri
}

output "service_name" {
  description = "Cloud Run service name, for the deploy workflow."
  value       = google_cloud_run_v2_service.app.name
}

output "registry_path" {
  description = "Artifact Registry path images are pushed to: <region>-docker.pkg.dev/<project>/<repository>."
  value       = "${google_artifact_registry_repository.images.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "deploy_service_account" {
  description = "Email of the service account the deploy workflow impersonates."
  value       = google_service_account.deploy.email
}

output "runtime_service_account" {
  description = "Email of the service account the Cloud Run service runs as."
  value       = google_service_account.runtime.email
}

output "github_variables" {
  description = "The GitHub repository variables the workflows read (the values bootstrap prints)."
  value = {
    GCP_PROJECT_ID     = var.project_id
    GCP_PROJECT_NUMBER = data.google_project.this.number
    GCP_REGION         = var.region
    TF_STATE_BUCKET    = "${var.project_id}-tfstate"
  }
}
