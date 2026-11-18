variable "project_id" {
  description = "ID do projeto Google Cloud (o mesmo do Firebase)."
  type        = string
}

# The Always Free e2-micro only exists in us-west1, us-central1 and us-east1.
# us-east1 (South Carolina) is the closest of the three to Brazil.
variable "region" {
  description = "Região. Mantenha numa das regiões do Always Free (us-west1, us-central1, us-east1)."
  type        = string
  default     = "us-east1"

  validation {
    condition     = contains(["us-west1", "us-central1", "us-east1"], var.region)
    error_message = "Fora de us-west1/us-central1/us-east1 a VM e2-micro é cobrada."
  }
}

variable "zone" {
  description = "Zona dentro da região."
  type        = string
  default     = "us-east1-b"
}

variable "duckdns_subdomain" {
  description = "Só o nome, sem .duckdns.org (ex.: \"tapago\")."
  type        = string
}

variable "duckdns_token" {
  description = "Token mostrado no topo de duckdns.org depois do login. Funciona como senha."
  type        = string
  sensitive   = true
}

variable "firebase_project_id" {
  description = "Projeto Firebase cujos logins o servidor aceita. Vazio = o mesmo que project_id."
  type        = string
  default     = ""
}

variable "allowed_emails" {
  description = "Admins iniciais: sempre Admin no sistema. As demais pessoas são cadastradas pela tela Usuários e perfis."
  type        = list(string)

  validation {
    condition     = length(var.allowed_emails) > 0
    error_message = "Informe pelo menos um e-mail; sem nenhum admin inicial, ninguém consegue cadastrar os outros."
  }
}

variable "extra_cors_origins" {
  description = "Origens extras que podem chamar a API (além de <firebase>.web.app e <firebase>.firebaseapp.com), ex. um domínio próprio."
  type        = list(string)
  default     = []
}
