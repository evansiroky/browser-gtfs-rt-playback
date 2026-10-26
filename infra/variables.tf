# ---- Identity of the deployment (scripts/teardown.sh sets the first five as TF_VAR_*) ----

variable "project_id" {
  description = "The dedicated GCP project that holds everything."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry. Must match the state bucket's region."
  type        = string
  default     = "us-west1"
}

variable "github_repository" {
  description = "The GitHub repository as owner/repo, with the exact case GitHub uses."
  type        = string

  validation {
    condition     = can(regex("^[^/\\s]+/[^/\\s]+$", var.github_repository))
    error_message = "github_repository must be a full owner/repo."
  }
}

variable "wif_pool" {
  description = "Full resource name of the Workload Identity pool created by bootstrap: projects/<number>/locations/global/workloadIdentityPools/github."
  type        = string

  validation {
    condition     = can(regex("^projects/[0-9]+/locations/global/workloadIdentityPools/[^/]+$", var.wif_pool))
    error_message = "wif_pool must look like projects/<project-number>/locations/global/workloadIdentityPools/<pool-id>."
  }
}

variable "container_image" {
  description = "Image for the first creation of the service. The deploy pipeline owns the image afterwards; changes to this variable never roll a running service."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# ---- Cost guards ----

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX) the budget is created on. Empty skips the budget."
  type        = string
  default     = ""

  validation {
    condition     = var.billing_account == "" || can(regex("^[0-9A-Za-z]{6}-[0-9A-Za-z]{6}-[0-9A-Za-z]{6}$", var.billing_account))
    error_message = "billing_account must be empty or an ID like 012345-6789AB-CDEF01 (without the billingAccounts/ prefix)."
  }
}

variable "manage_budget" {
  description = "Set false to leave the billing budget out (for example when the operator cannot grant the billing roles)."
  type        = bool
  default     = true
}

variable "budget_amount" {
  description = "Monthly budget in whole US dollars. Alerts go to billing administrators at 50%, 90% and 100%."
  type        = number
  default     = 25

  validation {
    condition     = var.budget_amount > 0 && var.budget_amount == floor(var.budget_amount)
    error_message = "budget_amount must be a positive whole number of US dollars."
  }
}

variable "registry_keep_count" {
  description = "How many of the most recent image versions Artifact Registry always keeps."
  type        = number
  default     = 10

  validation {
    condition     = var.registry_keep_count >= 1 && var.registry_keep_count == floor(var.registry_keep_count)
    error_message = "registry_keep_count must be a positive whole number."
  }
}

# ---- Feeds ----
# The feed URLs themselves are never Terraform inputs: they are Secret Manager secrets whose
# real versions the operator adds out of band (infra/README.md).

variable "vehicle_positions_enabled" {
  description = "Whether the service watches a VehiclePositions feed. False omits the secret reference, so the server treats the feed as not configured."
  type        = bool
  default     = true
}

variable "trip_updates_enabled" {
  description = "Whether the service watches a TripUpdates feed. False omits the secret reference, so the server treats the feed as not configured."
  type        = bool
  default     = true
}

# ---- Tunables ----
# Each default below must equal the server's default (server/README.md, specs/behaviors/configuration.md);
# the server is the source of truth, and it refuses to start on a value it cannot use.
# Durations are milliseconds (1000..2147483647), sizes are bytes.

variable "poll_interval_ms" {
  description = "Realtime poll interval (POLL_INTERVAL_MS)."
  type        = number
  default     = 10000

  validation {
    condition     = var.poll_interval_ms >= 1000 && var.poll_interval_ms <= 2147483647 && var.poll_interval_ms == floor(var.poll_interval_ms)
    error_message = "poll_interval_ms must be a whole number between 1000 and 2147483647."
  }
}

variable "rt_timeout_ms" {
  description = "Realtime fetch timeout (RT_TIMEOUT_MS)."
  type        = number
  default     = 8000

  validation {
    condition     = var.rt_timeout_ms >= 1000 && var.rt_timeout_ms <= 2147483647 && var.rt_timeout_ms == floor(var.rt_timeout_ms)
    error_message = "rt_timeout_ms must be a whole number between 1000 and 2147483647."
  }
}

variable "rt_max_bytes" {
  description = "Realtime response size limit (RT_MAX_BYTES), 25 MiB."
  type        = number
  default     = 26214400

  validation {
    condition     = var.rt_max_bytes > 0 && var.rt_max_bytes == floor(var.rt_max_bytes)
    error_message = "rt_max_bytes must be a positive whole number."
  }
}

variable "schedule_timeout_ms" {
  description = "Schedule fetch timeout (SCHEDULE_TIMEOUT_MS)."
  type        = number
  default     = 120000

  validation {
    condition     = var.schedule_timeout_ms >= 1000 && var.schedule_timeout_ms <= 2147483647 && var.schedule_timeout_ms == floor(var.schedule_timeout_ms)
    error_message = "schedule_timeout_ms must be a whole number between 1000 and 2147483647."
  }
}

variable "schedule_max_bytes" {
  description = "Schedule download size limit (SCHEDULE_MAX_BYTES), 100 MiB."
  type        = number
  default     = 104857600

  validation {
    condition     = var.schedule_max_bytes > 0 && var.schedule_max_bytes == floor(var.schedule_max_bytes)
    error_message = "schedule_max_bytes must be a positive whole number."
  }
}

variable "schedule_memory_limit_bytes" {
  description = "Schedule memory limit (SCHEDULE_MEMORY_LIMIT_BYTES), 768 MiB."
  type        = number
  default     = 805306368

  validation {
    condition     = var.schedule_memory_limit_bytes > 0 && var.schedule_memory_limit_bytes == floor(var.schedule_memory_limit_bytes)
    error_message = "schedule_memory_limit_bytes must be a positive whole number."
  }
}

variable "idle_timeout_ms" {
  description = "Idle timeout (IDLE_TIMEOUT_MS), 15 minutes: the process exits this long after the last browser ping."
  type        = number
  default     = 900000

  validation {
    condition     = var.idle_timeout_ms >= 1000 && var.idle_timeout_ms <= 2147483647 && var.idle_timeout_ms == floor(var.idle_timeout_ms)
    error_message = "idle_timeout_ms must be a whole number between 1000 and 2147483647."
  }
}

variable "max_activation_ms" {
  description = "Maximum activation duration (MAX_ACTIVATION_MS), 2 hours."
  type        = number
  default     = 7200000

  validation {
    condition     = var.max_activation_ms >= 1000 && var.max_activation_ms <= 2147483647 && var.max_activation_ms == floor(var.max_activation_ms)
    error_message = "max_activation_ms must be a whole number between 1000 and 2147483647."
  }
}

variable "retention_ms" {
  description = "Realtime retention (RETENTION_MS), 60 minutes. A ceiling: the server clamps larger values to 60 minutes, so this is limited to that here."
  type        = number
  default     = 3600000

  validation {
    condition     = var.retention_ms >= 1000 && var.retention_ms <= 3600000 && var.retention_ms == floor(var.retention_ms)
    error_message = "retention_ms must be a whole number between 1000 and 3600000 (60 minutes)."
  }
}

variable "history_memory_limit_bytes" {
  description = "Realtime history memory limit (HISTORY_MEMORY_LIMIT_BYTES), 512 MiB. Must be at least 2 x rt_max_bytes."
  type        = number
  default     = 536870912

  validation {
    condition     = var.history_memory_limit_bytes > 0 && var.history_memory_limit_bytes == floor(var.history_memory_limit_bytes)
    error_message = "history_memory_limit_bytes must be a positive whole number."
  }
}

variable "rate_limit_per_min" {
  description = "API requests per minute per client address (RATE_LIMIT_PER_MIN)."
  type        = number
  default     = 120

  validation {
    condition     = var.rate_limit_per_min > 0 && var.rate_limit_per_min == floor(var.rate_limit_per_min)
    error_message = "rate_limit_per_min must be a positive whole number."
  }
}

variable "tile_host" {
  description = "Map tile origin the Content-Security-Policy allows (TILE_HOST). Must match the web app's map style."
  type        = string
  default     = "https://tiles.openfreemap.org"

  validation {
    condition     = can(regex("^https?://[^/?#@\\s]+$", var.tile_host))
    error_message = "tile_host must be an http or https origin: no path, query or credentials."
  }
}
