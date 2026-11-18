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
  value       = "gcloud compute ssh tapago --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "backup_bucket" {
  value = google_storage_bucket.backups.name
}

# The deploy workflow reads every project-specific value from the variables
# of the `production` environment on GitHub. After an apply, paste these
# commands (they create the environment if needed). The Firebase values
# (FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_APP_ID) come from the
# Firebase console: Configurações do projeto → Seus apps → app Web.
output "github_variables_commands" {
  description = "Comandos para gravar as variáveis do deploy no environment production do GitHub."
  value       = <<-EOT
    gh api -X PUT repos/${var.github_repository}/environments/production >/dev/null
    gh variable set GCP_PROJECT     --env production --repo ${var.github_repository} --body "${var.project_id}"
    gh variable set WIF_PROVIDER    --env production --repo ${var.github_repository} --body "${google_iam_workload_identity_pool_provider.github.name}"
    gh variable set DEPLOY_SA       --env production --repo ${var.github_repository} --body "${google_service_account.deploy.email}"
    gh variable set RELEASES_BUCKET --env production --repo ${var.github_repository} --body "${google_storage_bucket.releases.name}"
    gh variable set API_URL         --env production --repo ${var.github_repository} --body "https://${local.domain}"
  EOT
}
