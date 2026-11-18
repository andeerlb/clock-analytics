locals {
  firebase_project_id = var.firebase_project_id != "" ? var.firebase_project_id : var.project_id
  domain              = "${var.duckdns_subdomain}.duckdns.org"
  backup_bucket       = "${var.project_id}-pontoscan-backups"
  cors_origins = concat(
    ["https://${local.firebase_project_id}.web.app", "https://${local.firebase_project_id}.firebaseapp.com"],
    var.extra_cors_origins,
  )
}

# --- APIs -------------------------------------------------------------------

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "iap.googleapis.com", # SSH through IAP, so port 22 is never open to the internet
    "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# --- Network ------------------------------------------------------------------
# A dedicated network instead of "default": the default network ships with
# rules that open SSH and RDP to the whole internet.

resource "google_compute_network" "main" {
  name                    = "pontoscan"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  name          = "pontoscan-${var.region}"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

# HTTPS for the API, plus HTTP so Caddy can answer Let's Encrypt and
# redirect plain-HTTP visitors.
resource "google_compute_firewall" "web" {
  name          = "pontoscan-allow-web"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["pontoscan-web"]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# SSH only from Google's IAP range (gcloud compute ssh --tunnel-through-iap).
resource "google_compute_firewall" "iap_ssh" {
  name          = "pontoscan-allow-iap-ssh"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["pontoscan-web"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# --- Backups ------------------------------------------------------------------
# Litestream streams every SQLite change here. Regional storage in us-east1
# is inside the 5 GB Always Free allowance.

resource "google_storage_bucket" "backups" {
  name                        = local.backup_bucket
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Litestream already keeps its own history; soft-deleted copies would only
  # add billed storage.
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

# --- VM -----------------------------------------------------------------------

resource "google_service_account" "vm" {
  account_id   = "pontoscan-vm"
  display_name = "PontoScan VM"
}

resource "google_storage_bucket_iam_member" "vm_backups" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_compute_instance" "server" {
  name         = "pontoscan"
  machine_type = "e2-micro" # Always Free
  zone         = var.zone
  tags         = ["pontoscan-web"]

  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      type  = "pd-standard" # Always Free covers 30 GB of standard disk
      size  = 30
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    # Ephemeral public IP. If it changes, the DuckDNS timer on the VM
    # updates the name within 5 minutes.
    access_config {}
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  metadata = {
    enable-oslogin = "TRUE"
    # Runs on every boot. `metadata` (not `metadata_startup_script`) so a
    # change updates the VM in place instead of recreating it.
    startup-script = templatefile("${path.module}/startup.sh.tftpl", {
      domain              = local.domain
      duckdns_subdomain   = var.duckdns_subdomain
      duckdns_token       = var.duckdns_token
      firebase_project_id = local.firebase_project_id
      allowed_emails      = join(",", var.allowed_emails)
      cors_origins        = join(",", local.cors_origins)
      backup_bucket       = google_storage_bucket.backups.name
    })
  }

  depends_on = [google_storage_bucket_iam_member.vm_backups]
}
