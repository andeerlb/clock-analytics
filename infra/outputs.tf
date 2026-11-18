output "api_url" {
  description = "URL da API. Vai em VITE_API_URL no build do frontend."
  value       = "https://${local.domain}"
}

output "external_ip" {
  description = "IP público atual da VM (o DuckDNS acompanha sozinho se mudar)."
  value       = google_compute_instance.server.network_interface[0].access_config[0].nat_ip
}

output "ssh_command" {
  description = "Como entrar na VM (pelo IAP; a porta 22 não está aberta para a internet)."
  value       = "gcloud compute ssh pontoscan --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "backup_bucket" {
  value = google_storage_bucket.backups.name
}
