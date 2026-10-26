# One secret per feed URL. Cloud Run cannot create a service whose secret has no version, so
# each secret gets a placeholder first version. The operator adds the real URL as a new
# version (`gcloud secrets versions add`, see README.md); the service reads `latest`.
# Terraform never sees a real value, so feed URLs and keys stay out of state, variables and CI logs.

resource "google_secret_manager_secret" "feed" {
  for_each  = local.feed_secrets
  secret_id = each.value

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "placeholder" {
  for_each    = google_secret_manager_secret.feed
  secret      = each.value.id
  secret_data = "https://placeholder.invalid/set-me"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# The runtime service account may read these secrets and nothing else.
resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.feed
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
