# Alerts only: a budget does not disable billing. Thresholds 50 / 90 / 100 % of the monthly
# amount, delivered to billing administrators (the default recipients, no notification channel).
# Skipped when manage_budget is false or no billing account is given.

resource "google_billing_budget" "monthly" {
  count    = local.budget_enabled ? 1 : 0
  provider = google.billing

  billing_account = var.billing_account
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
}
