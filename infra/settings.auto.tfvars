# Operator settings for gtfs-rt-debugger. Terraform loads this file automatically, locally and in
# CI, so both always plan the same thing. It is committed: it must contain NO secrets (feed URLs
# live in Secret Manager, never here).
#
# Everything in infra/variables.tf can be overridden here except the four values bootstrap
# supplies (project_id, region, github_repository, wif_pool). Uncomment and edit, for example:
#
# manage_budget             = false   # when the billing roles could not be granted
# budget_amount             = 25
# billing_account           = "012345-6789AB-CDEF01"   # default: the project's linked account
# vehicle_positions_enabled = true
# trip_updates_enabled      = true
# tile_host                 = "https://tiles.openfreemap.org"
# idle_timeout_ms           = 900000
# registry_keep_count       = 10
