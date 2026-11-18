terraform {
  required_version = ">= 1.8"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.0"
    }
  }

  # State stays local (infra/terraform.tfstate, git-ignored). It contains the
  # DuckDNS token, so never commit it; keep a copy somewhere safe.
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
