# One secret per feed URL. Cloud Run cannot create a service whose secret has no version, so
# each secret gets a placeholder first version. The operator adds the real URL as a new
# version (`gcloud secrets versions add`, see README.md); the service reads `latest`.
# Terraform never sees a real value, so feed URLs and keys stay out of state, variables and CI logs.
# Never import a placeholder version: an imported version has no secret_data_wo_version, so the next
# apply would replace it, and the new placeholder would become `latest` and hide the real URL.

resource "google_secret_manager_secret" "feed" {
  for_each  = local.feed_secrets
  secret_id = each.value

  replication {
    auto {}
  }
}

# The placeholder uses the write-only argument, so Terraform never stores it and never reads a
# version's payload back. A plain secret_data would make every refresh call versions/N:access,
# a permission the read-only plan identity must never hold (the real versions hold feed URLs).
# Bump secret_data_wo_version only to deliberately replace the placeholder.
resource "google_secret_manager_secret_version" "placeholder" {
  for_each               = google_secret_manager_secret.feed
  secret                 = each.value.id
  secret_data_wo         = "https://placeholder.invalid/set-me"
  secret_data_wo_version = 1
}

# The runtime service account may read these secrets and nothing else.
resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.feed
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
