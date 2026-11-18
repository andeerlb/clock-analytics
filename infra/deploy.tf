# Automatic deploy from GitHub Actions (.github/workflows/deploy-web.yml).
#
# Keyless: GitHub proves who it is with a short-lived OIDC token and Google
# trades it for credentials of the `github-deploy` service account
# (Workload Identity Federation). No JSON key is ever created or stored in
# GitHub. Only pushes to the branches in `deploy_refs` of this repository
# are accepted.
#
# What the deploy account can do, and nothing else:
#   - write the server binary to the releases bucket (the VM pulls it);
#   - publish the frontend to Firebase Hosting.

variable "github_repository" {
  description = "Repositório (dono/nome) cujo GitHub Actions pode fazer deploy."
  type        = string
  default     = "andeerlb/tapago"
}

variable "deploy_refs" {
  description = "Branches que podem fazer deploy."
  type        = list(string)
  default     = ["refs/heads/web", "refs/heads/master"]
}

resource "google_project_service" "deploy_apis" {
  for_each = toset([
    "iamcredentials.googleapis.com", # short-lived credentials for the deploy account
    "sts.googleapis.com",            # token exchange for Workload Identity Federation
    "firebasehosting.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# `project` is explicit on the pool and its provider: without it, moving to
# another project kept the pool recorded in the state under the old one.
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.deploy_apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Anything else (forks, other repos, pull requests, other branches) is
  # rejected before it can impersonate anyone.
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref in ${jsonencode(var.deploy_refs)}"
}

resource "google_service_account" "deploy" {
  account_id   = "github-deploy"
  display_name = "GitHub Actions deploy"
}

resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_project_iam_member" "deploy_roles" {
  for_each = toset([
    "roles/firebasehosting.admin",
    # Lets the deploy account's API calls be billed to / counted against this project.
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# --- Releases: CI drops the server binary here; the VM pulls it ---------------

resource "google_storage_bucket" "releases" {
  name                        = "${var.project_id}-tapago-releases"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "deploy_releases" {
  bucket = google_storage_bucket.releases.name
  role   = "roles/storage.objectAdmin" # overwriting an object needs delete, which objectCreator lacks
  member = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_storage_bucket_iam_member" "vm_releases" {
  bucket = google_storage_bucket.releases.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.vm.email}"
}

output "github_workload_identity_provider" {
  description = "Vai no workflow (WIF_PROVIDER)."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_deploy_service_account" {
  description = "Vai no workflow (DEPLOY_SA)."
  value       = google_service_account.deploy.email
}

output "releases_bucket" {
  value = google_storage_bucket.releases.name
}
