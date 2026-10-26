resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.repository_id
  format        = "DOCKER"
  description   = "Container images for gtfs-rt-debugger, tagged with the commit SHA."

  cleanup_policy_dry_run = false

  # Keep the most recent images (rollback candidates, and always the one that is live) ...
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.registry_keep_count
    }
  }

  # ... and delete everything else once it is a week old (tagged or not), so storage stays flat.
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "604800s"
    }
  }
}
