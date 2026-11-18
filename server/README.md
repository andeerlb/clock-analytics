# Tá Pago — servidor web

Backend da versão web do Tá Pago (Rust + axum + SQLite). Substitui o acesso
direto ao banco que o app desktop fazia pelo `src/lib/db.ts`, e os comandos Tauri
que mexiam com arquivos. Como portar uma função: `PORTING.md`.

## Rodar localmente

Em dois terminais:

```sh
# 1. servidor (porta 8787), sem login — só em build de desenvolvimento
cd server
TAPAGO_DEV_USER_EMAIL=voce@exemplo.com cargo run

# 2. frontend (porta 1420), que repassa /api para o servidor
yarn dev
```

Abra http://localhost:1420. Por padrão o banco fica em `server/data/tapago.db`
e é criado vazio, com todas as migrations. Para usar seus dados reais, aponte
`TAPAGO_DB_PATH` para uma **cópia** do banco do desktop. Por exemplo, no Linux:

```sh
sqlite3 ~/.config/com.andeerlb.pontoscan/pontoscan.db ".backup 'server/data/pontoscan.db'"
```

```sh
cd server && cargo test
```

## Variáveis de ambiente

| Variável | Padrão | O que é |
|---|---|---|
| `TAPAGO_BIND` | `127.0.0.1:8787` | Endereço/porta em que o servidor escuta. |
| `TAPAGO_DB_PATH` | `data/tapago.db` | Arquivo SQLite. Criado se não existir. |
| `TAPAGO_DATA_DIR` | pasta do banco | Onde ficam os arquivos: `imports/` (PDFs e planilhas importados, guardados) e `uploads/` (envios temporários, apagados em 24h). |
| `TAPAGO_TIMEZONE` | `America/Sao_Paulo` | Fuso da equipe. Define o "hoje" dos períodos relativos da verificação automática ("Hoje", "Últimos 7 dias", "Mês atual"). |
| `TAPAGO_REMOTE_CHECKS` | `on` | `off` desliga a verificação automática em segundo plano (útil ao testar com uma cópia do banco real, para não baixar as planilhas de verdade). "Conferir agora" continua funcionando. |
| `TAPAGO_STATIC_DIR` | — | Pasta do frontend buildado (`dist/`) para o próprio servidor servir. Vazio = só API (frontend no Firebase Hosting). |
| `TAPAGO_CORS_ORIGINS` | — | Origens que podem chamar a API, separadas por vírgula, ex. `https://tapago.web.app`. |
| `FIREBASE_PROJECT_ID` | — | **Obrigatório em produção.** ID do projeto Firebase cujos tokens de login são aceitos. |
| `TAPAGO_ALLOWED_EMAILS` | — | **Obrigatório em produção.** Admins iniciais, separados por vírgula: sempre Admin, para ninguém ficar trancado do lado de fora. As demais pessoas são cadastradas pela tela "Usuários e perfis"; o Firebase aceita qualquer conta Google, e quem não está em nenhuma das duas listas é barrado. |
| `TAPAGO_DEV_USER_EMAIL` | — | Desliga o login e trata toda requisição como este e-mail, como admin. **Só funciona em build de desenvolvimento**; um build de release se recusa a subir com ela definida. Para testar outro perfil, defina também `TAPAGO_ALLOWED_EMAILS` sem esse e-mail e cadastre-o na tela com o perfil desejado. |
| `RUST_LOG` | `info,tower_http=info,sqlx=warn` | Nível de log. |

## Migrations

Ficam em `server/migrations/` e a lista, com a ordem, em `server/src/migrations_list.rs`.
São as mesmas versões e o mesmo SQL do antigo app desktop, então um banco vindo
dele abre aqui como já migrado. Para criar uma migration nova, adicione
o `.sql` **e** a linha na lista. Nunca edite um arquivo ou uma linha que já existe.

## Login

O frontend entra com Google pelo Firebase Authentication e manda o ID token em
`Authorization: Bearer ...`. O servidor confere a assinatura com as chaves
públicas do Google, além do projeto, do emissor e da validade, e depois a lista de
e-mails. Todas as rotas em `/api` exigem login, exceto `/api/health`.
