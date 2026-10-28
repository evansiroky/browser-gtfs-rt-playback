terraform {
  # 1.11 for write-only arguments: the placeholder secret versions use secret_data_wo (secrets.tf).
  required_version = ">= 1.11"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # The bucket is created by scripts/bootstrap.sh and supplied at init time:
  #   terraform init -backend-config=bucket=<project-id>-tfstate
  backend "gcs" {
    prefix = "gtfs-rt-debugger"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Used only by the billing budget. The Cloud Billing Budget API needs a quota project when
# called with user credentials (the operator's first local apply), so requests for that one
# resource are billed to the project. Every other resource uses the plain provider above.
provider "google" {
  alias                 = "billing"
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}
