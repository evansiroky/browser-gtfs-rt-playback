locals {
  service_name  = "gtfs-rt-debugger"
  repository_id = "gtfs-rt-debugger"

  # Feed-URL secrets, keyed by the environment variable the server reads them from.
  # Terraform creates the secrets and a placeholder first version only (secrets.tf).
  feed_secrets = {
    SCHEDULE_URL          = "schedule-url"
    VEHICLE_POSITIONS_URL = "vehicle-positions-url"
    TRIP_UPDATES_URL      = "trip-updates-url"
  }

  # The schedule is always configured; a realtime feed is configured unless disabled.
  configured_feed_secrets = {
    for env_name, secret_id in local.feed_secrets : env_name => secret_id
    if(env_name != "VEHICLE_POSITIONS_URL" || var.vehicle_positions_enabled) && (env_name != "TRIP_UPDATES_URL" || var.trip_updates_enabled)
  }

  # Non-secret configuration, passed as environment variables. Names are the server's
  # (server/README.md). PORT is injected by Cloud Run, WEB_DIST_DIR is the image's concern.
  tunables = {
    POLL_INTERVAL_MS            = var.poll_interval_ms
    RT_TIMEOUT_MS               = var.rt_timeout_ms
    RT_MAX_BYTES                = var.rt_max_bytes
    SCHEDULE_TIMEOUT_MS         = var.schedule_timeout_ms
    SCHEDULE_MAX_BYTES          = var.schedule_max_bytes
    SCHEDULE_MEMORY_LIMIT_BYTES = var.schedule_memory_limit_bytes
    IDLE_TIMEOUT_MS             = var.idle_timeout_ms
    MAX_ACTIVATION_MS           = var.max_activation_ms
    RETENTION_MS                = var.retention_ms
    HISTORY_MEMORY_LIMIT_BYTES  = var.history_memory_limit_bytes
    RATE_LIMIT_PER_MIN          = var.rate_limit_per_min
  }

  environment = merge(
    { for name, value in local.tunables : name => tostring(value) },
    {
      EXIT_ON_IDLE = "true"
      TILE_HOST    = var.tile_host
    },
  )

  budget_enabled = var.manage_budget && var.billing_account != ""
}

data "google_project" "this" {
  project_id = var.project_id
}
