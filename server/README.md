# PontoScan — servidor web

Backend da versão web do PontoScan (Rust + axum + SQLite). Substitui o acesso
direto ao banco que o app desktop fazia pelo `src/lib/db.ts`, e os comandos Tauri
que mexiam com arquivos. Como portar uma função: `PORTING.md`.

## Rodar localmente

Em dois terminais:

```sh
# 1. servidor (porta 8787), sem login — só em build de desenvolvimento
cd server
PONTOSCAN_DEV_USER_EMAIL=voce@exemplo.com cargo run

# 2. frontend (porta 1420), que repassa /api para o servidor
yarn dev
```

Abra http://localhost:1420. Por padrão o banco fica em `server/data/pontoscan.db`
e é criado vazio, com todas as migrations. Para usar seus dados reais, aponte
`PONTOSCAN_DB_PATH` para uma **cópia** do banco do desktop. Por exemplo, no Linux:

```sh
sqlite3 ~/.config/com.andeerlb.pontoscan/pontoscan.db ".backup 'server/data/pontoscan.db'"
```

```sh
cd server && cargo test
```

## Variáveis de ambiente

| Variável | Padrão | O que é |
|---|---|---|
| `PONTOSCAN_BIND` | `127.0.0.1:8787` | Endereço/porta em que o servidor escuta. |
| `PONTOSCAN_DB_PATH` | `data/pontoscan.db` | Arquivo SQLite. Criado se não existir. |
| `PONTOSCAN_DATA_DIR` | pasta do banco | Onde ficam os arquivos: `imports/` (PDFs e planilhas importados, guardados) e `uploads/` (envios temporários, apagados em 24h). |
| `PONTOSCAN_STATIC_DIR` | — | Pasta do frontend buildado (`dist/`) para o próprio servidor servir. Vazio = só API (frontend no Firebase Hosting). |
| `PONTOSCAN_CORS_ORIGINS` | — | Origens que podem chamar a API, separadas por vírgula, ex. `https://pontoscan.web.app`. |
| `FIREBASE_PROJECT_ID` | — | **Obrigatório em produção.** ID do projeto Firebase cujos tokens de login são aceitos. |
| `PONTOSCAN_ALLOWED_EMAILS` | — | **Obrigatório em produção.** E-mails que podem entrar, separados por vírgula. O Firebase aceita qualquer conta Google; é esta lista que barra os demais. |
| `PONTOSCAN_DEV_USER_EMAIL` | — | Desliga o login e trata toda requisição como este e-mail. **Só funciona em build de desenvolvimento**; um build de release se recusa a subir com ela definida. |
| `RUST_LOG` | `info,tower_http=info,sqlx=warn` | Nível de log. |

## Migrations

São as mesmas do desktop: os arquivos em `src-tauri/migrations/` e a lista em
`src-tauri/src/migrations_list.rs`, compartilhada pelos dois. Um banco exportado
do desktop abre aqui como já migrado. Para criar uma migration nova, adicione
o `.sql` **e** a linha na lista. Nunca edite um arquivo ou uma linha que já existe.

## Login

O frontend entra com Google pelo Firebase Authentication e manda o ID token em
`Authorization: Bearer ...`. O servidor confere a assinatura com as chaves
públicas do Google, além do projeto, do emissor e da validade, e depois a lista de
e-mails. Todas as rotas em `/api` exigem login, exceto `/api/health`.
