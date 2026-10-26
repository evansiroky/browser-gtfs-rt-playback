resource "google_cloud_run_v2_service" "app" {
  name     = local.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  # The provider defaults this to true, which would make `terraform destroy` (scripts/teardown.sh) fail.
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    # All state lives in one process's memory: a second instance must never run.
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    max_instance_request_concurrency = 80

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "2Gi"
        }
        # CPU always allocated: the poller runs between requests.
        cpu_idle = false
      }

      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.configured_feed_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.feed[env.key].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    # The deploy pipeline owns the image (`gcloud run deploy --image`); an apply must never roll
    # the app back. gcloud also stamps itself into client/client_version. Everything else it
    # writes (annotations, labels, revision names) is either not managed here or computed.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]

    precondition {
      condition     = var.vehicle_positions_enabled || var.trip_updates_enabled
      error_message = "At least one realtime feed (vehicle_positions_enabled, trip_updates_enabled) must be enabled."
    }

    precondition {
      condition     = var.history_memory_limit_bytes >= 2 * var.rt_max_bytes
      error_message = "history_memory_limit_bytes must be at least 2 x rt_max_bytes, or the server refuses to start."
    }
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.runtime_accessor,
  ]
}
