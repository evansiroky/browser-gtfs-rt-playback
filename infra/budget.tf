# Alerts only: a budget does not disable billing. Thresholds 50 / 90 / 100 % of the monthly
# amount, delivered to billing administrators (the default recipients, no notification channel).
# Skipped only when manage_budget is false. The billing account is the project's linked one
# unless var.billing_account overrides it; if neither exists the plan fails instead of planning
# to destroy a budget that the pipeline merely could not see.

resource "google_billing_budget" "monthly" {
  count    = var.manage_budget ? 1 : 0
  provider = google.billing

  billing_account = local.billing_account
  display_name    = "gtfs-rt-debugger monthly"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  lifecycle {
    precondition {
      condition     = local.billing_account != ""
      error_message = "No billing account found for the project. Link billing (gcloud billing projects link), make sure cloudbilling.googleapis.com is enabled (re-run scripts/bootstrap.sh), or set manage_budget = false in infra/settings.auto.tfvars."
    }
  }
}
