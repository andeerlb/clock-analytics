# Infraestrutura (OpenTofu)

Cria no Google Cloud, tudo dentro do Always Free:

- **VM e2-micro** em `us-east1` (Ubuntu 24.04, disco padrão de 30 GB, 1 GB de swap) com:
  - **Caddy**: HTTPS automático (Let's Encrypt) em `https://<subdomínio>.duckdns.org`, repassando para o servidor;
  - **serviço `tapago`**: o servidor Rust (`server/`). Fica parado até o primeiro deploy copiar o binário;
  - **Litestream**: backup contínuo do SQLite para o Cloud Storage. Uma VM nova restaura o último backup sozinha;
  - **DuckDNS**: um timer atualiza o IP a cada 5 minutos;
  - Poppler (`pdftotext` etc.).
- **Rede própria**: abre só as portas 80/443. O SSH entra só pelo IAP do Google (a porta 22 não fica aberta para a internet).
- **Bucket** de backups (`<projeto>-tapago-backups`), protegido contra `tofu destroy`.

## Antes de começar (uma vez)

1. Projeto Firebase criado, com o faturamento vinculado (a VM grátis exige um cartão cadastrado).
2. **Alerta de orçamento**: em console.cloud.google.com → Faturamento → Orçamentos e alertas → Criar orçamento,
   valor de US$ 1 (ou R$ 5), alertas em 50%, 90% e 100%. Se algo sair da cota grátis, você fica sabendo.
3. Subdomínio criado em duckdns.org e o token em mãos.
4. Instalar o `gcloud` (https://cloud.google.com/sdk/docs/install) e autenticar:
   ```sh
   gcloud auth login
   gcloud auth application-default login   # é a credencial que o OpenTofu usa
   ```

## Criar

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars   # e preencha
tofu init
tofu plan     # confira o que vai ser criado
tofu apply
```

No fim aparecem `api_url`, `external_ip` e o comando de SSH. O primeiro boot leva
de 2 a 4 minutos instalando pacotes. Para acompanhar:

```sh
gcloud compute ssh tapago --zone us-east1-b --tunnel-through-iap -- sudo journalctl -u google-startup-scripts -f
```

Até o primeiro deploy do servidor, `https://<subdomínio>.duckdns.org` responde
**502**. É o esperado: o Caddy está no ar, só falta o servidor atrás dele.

## Deploy automático

Cada push no ramo `web` dispara `.github/workflows/deploy-web.yml`, que:

1. roda os testes do servidor, compila e manda o binário para o bucket
   `<projeto>-tapago-releases`;
2. a VM confere esse bucket a cada minuto (timer `tapago-update`), instala o binário
   novo, reinicia o serviço e **volta para a versão anterior sozinha** se a nova não
   responder em 30 segundos;
3. o workflow espera `https://<subdomínio>.duckdns.org/api/version` mostrar o commit novo
   e só então publica o frontend no Firebase Hosting.

O GitHub entra no Google Cloud sem chave guardada (Workload Identity Federation,
`deploy.tf`). Só pushes deste repositório nos ramos `web`/`master` são aceitos, e a
conta de deploy só pode escrever no bucket de versões e publicar no Hosting.

Para ver o que a VM fez:

```sh
gcloud compute ssh tapago --zone us-east1-b --tunnel-through-iap -- sudo journalctl -u tapago-update -u tapago -n 50
```

## Mudar algo depois

Edite `terraform.tfvars` (por exemplo, para adicionar um e-mail) e rode `tofu apply`. A VM
é atualizada sem ser recriada. Para aplicar a configuração nova sem reiniciar:

```sh
gcloud compute ssh tapago --zone us-east1-b --tunnel-through-iap -- sudo google_metadata_script_runner startup
```

## Cuidados

- **`terraform.tfstate` e `terraform.tfvars` têm o token do DuckDNS.** Os dois estão no
  `.gitignore`; guarde uma cópia do state em lugar seguro.
- Não troque `machine_type`, região ou tipo de disco: fora de e2-micro, de
  `us-west1`/`us-central1`/`us-east1` e de `pd-standard` até 30 GB, passa a ser cobrado.
- Os dados ficam no disco da VM **e** no bucket. Se a VM for apagada e recriada, o
  serviço restaura o banco do bucket ao subir.
