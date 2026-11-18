# Portando o desktop para o servidor

> O app desktop (Tauri) foi removido: tudo já roda no servidor. Este guia fica
> como referência das convenções usadas no port (RPC, SQL, arquivos).

Guia para levar uma função de `src/lib/db.ts`, ou um comando Tauri de
`src/lib/api.ts`, para o servidor. O objetivo é **fidelidade**: mesmas regras,
mesmo SQL, mesmas mensagens e mesmo formato de dados. As telas não devem perceber
a diferença.

## 1. Convenção RPC

Cada função portada vira um endpoint:

```
POST /api/rpc/<nomeDaFunçãoEmCamelCase>
corpo:    { ...argumentos da função TS, pelos nomes dos parâmetros }
resposta: o que a função TS retornava, em JSON (função `void` → 204 sem corpo)
```

No frontend, só o **corpo** da função muda. A assinatura e o JSDoc ficam:

```ts
export async function getClient(id: number): Promise<ClientDetail> {
  return rpc<ClientDetail>("getClient", { id });
}
```

(`rpc` vem de `./http`.) Argumentos opcionais vão como estão; o servidor usa
`#[serde(default)]` para os ausentes. `undefined` some no JSON, então trate
"ausente" e `null` igual, a não ser que a função TS os diferencie.

## 2. Servidor: o executor SQL (`src/sql.rs`)

O `db.ts` falava com o SQLite pelo `@tauri-apps/plugin-sql`. O `sql.rs` reproduz
esse plugin **exatamente**: mesmo jeito de ligar parâmetros (`$1`, `$2`…, inclusive
repetidos e fora de ordem) e as linhas voltam como JSON com os mesmos nomes de
coluna (os `AS camelCase` do SQL). Por isso:

- **Copie o texto SQL sem mudar nada.** Os aliases definem o JSON de resposta.
- `db.select(sql, params)` → `sql::select(&state.db, SQL, &params![...]).await?` → `Vec<Row>`
  (`Row` = `serde_json::Map`). `sql::select_one` → `Option<Row>`.
- `db.execute(sql, params)` → `sql::execute(...)` → `ExecResult { rows_affected, last_insert_id }`.
- `runWriteBatch([...])` → `sql::run_batch(&state.db, vec![BatchStatement::new(SQL, params![..]), ...])`.
  `{ $lastInsertId: n }` → `sql::last_insert_id_of(n)`; `expectChanges` → `.expect_changes("msg")`
  (vira 409 com a mensagem).
- `inClause(...)` → `sql::in_clause(column, &values, &mut params)`.
- `foldAccentsSql(expr)` → `sql::fold_accents_sql(expr)`.
- SQL montado dinamicamente (filtros opcionais) segue a mesma lógica de montagem
  do TS: `Vec<String>` de condições + `Vec<Value>` de parâmetros.
- Quando a resposta é a própria linha, devolva `Json(Value::Object(row))` ou
  `Json(rows)`. Só crie struct tipada quando ajudar, por exemplo para entrada
  validada ou JSON aninhado (`JSON.parse` de colunas `*_json` no TS → `serde_json::from_str` no Rust).
- Leitura → decisão → escrita que no TS acontecia em sequência: mantenha a
  sequência. Pode embrulhar numa transação (`state.db.begin()`, passando
  `&mut *tx` como executor) quando isso só deixa mais seguro, sem mudar o resultado.

Modelo de handler:

```rust
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::{params, sql, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/getClient", post(get_client))
        .route("/rpc/removeClientCompany", post(remove_client_company))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs { id: i64 }

async fn get_client(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    let row = sql::select_one(&state.db, "SELECT id, name, cnpj FROM clients WHERE id = $1", &params![args.id])
        .await?
        .ok_or_else(|| ApiError::NotFound("Cliente não encontrado.".into()))?;
    Ok(Json(Value::Object(row)))
}
```

### Erros
- `throw new Error("mensagem")` no TS → mesma mensagem, em português:
  - `ApiError::BadRequest`: validação;
  - `ApiError::Conflict`: duplicado ou concorrência;
  - `ApiError::NotFound`: registro inexistente.

  O frontend mostra a mensagem como antes.
- Erro de banco → `?` (vira 500 genérico; o detalhe vai para o log).
- O navegador não é confiável: revalide no servidor o que o TS validava (CPF,
  CNPJ, campos obrigatórios), com as mesmas mensagens.

### Lógica pura (sem banco)
Cálculo que não depende do banco (ex.: agregados com `analysis.ts`) **pode
continuar no TS**. A função do `db.ts` calcula e manda o resultado no `rpc`. Isso
evita traduzir lógica de negócio sem necessidade. Só porte para Rust o que
precisa ler o banco no meio do caminho.

### Eventos
`notifyPaymentShiftsChanged()` e outros `emit` continuam no TS, depois que o `rpc` resolve.

## 3. Arquivos (`src/files.rs`, `src/lib/files.ts`)

- O navegador escolhe ou arrasta arquivos → `uploadFiles` → recebe **caminhos no servidor**.
  `pickPdfFiles`, `pickFolder`, `listDirFiles`, `pickPaymentFile(s)` e `readPdfBytes`
  já estão portados em `api.ts`. O resto do fluxo continua passando caminhos.
- **Todo caminho que vem do navegador passa por `files::resolve(&state.data_dir, &path)?`**,
  que recusa qualquer coisa fora da pasta de dados. Sem exceção.
- O que precisa ficar guardado vai para `files::imports_dir(&state.data_dir)` (o
  `imports/` do desktop). `uploads/` é temporário e é limpo em 24h.
- O código de domínio do desktop está em `src/domain/` (parsers, poppler,
  pdf_extract, hashing, spreadsheet, file_author, report_zip, model). Use direto;
  `poppler_dir` é sempre `None`, porque o Poppler fica no PATH.
- **Salvar arquivo** (`save()` do plugin-dialog + `writeBinaryFile` / `copyPdfTo`):
  - bytes gerados no TS → `downloadBlob(bytes, nome)`;
  - arquivo do servidor → `downloadServerFile(path, nome)`;
  - arquivo gerado no servidor (ZIP) → grave em `uploads/<uuid>/` e devolva o caminho para o front baixar.
- **Arrastar e soltar** (`@tauri-apps/api/webview` `onDragDropEvent`) → `onDragOver`/`onDrop` do HTML + `uploadDropped(e.dataTransfer, extensões)`.
- **Abrir link** (`@tauri-apps/plugin-opener` `openUrl`) → `window.open(url, "_blank", "noopener")`.
- **"Mostrar na pasta" / "Abrir pasta de dados"** não existem na web: troque por "Baixar" quando fizer sentido, ou remova.
- **Janela de Conferência separada** (`open_reconciliation_window`): abra a mesma tela numa nova aba.

## 3.1 Já portado na base (não refaça)
- **Comandos de arquivo** (`server/src/routes/commands.rs` + `api.ts`): `listProviders`, `hashFiles`,
  `parseImport`, `listSpreadsheetSheets`, `previewSpreadsheet`, `applyPaymentTemplate`,
  `hashPaymentFile`, `readSpreadsheetAuthor`, `downloadPaymentFileFromUrl` (com proteção contra
  endereços internos), `checkRemotePaymentFile`, `generateReportZip`.
- `generateReportZip(entries, nome)`: o 2º argumento agora é o **nome do arquivo**; o ZIP é baixado.
- Os seletores (`pickPdfFiles`, `pickFolder`, `listDirFiles`, `pickPaymentFile(s)`) já devolvem caminhos do servidor.
- `readPdfBytes(path)` busca no servidor. `copyPdfTo(origem, destino)` baixa a origem com o nome do destino.
- `writeBinaryFile(path, bytes)` baixa os bytes com o nome do caminho.
- Viraram no-op: `revealInFileManager`, `setTrayStatus`, `backupDatabaseBeforeDelete` (o Litestream faz
  backup contínuo); `listRecentPaymentFiles` devolve `[]`.
- O `save()` do `@tauri-apps/plugin-dialog` **não funciona no navegador**: troque a chamada pelo nome de
  arquivo sugerido direto (`writeBinaryFile(nomeSugerido, bytes)` / `downloadBlob`). Botões de "mostrar
  na pasta" depois de exportar podem sair.
- Eventos: `../lib/events` (`emit`/`listen`/`emitTo`) já substitui `@tauri-apps/api/event` em todos os arquivos.

## 3.2 Código do servidor chamando outras funções portadas
`routes::call(&state, handler, json!({...}))` chama um handler RPC por dentro do servidor, com os
mesmos argumentos JSON que o frontend mandaria. A verificação automática (`src/remote_checks/`)
usa isso para rodar exatamente o mesmo código da tela de importação.

## 4. Regras do trabalho em paralelo
- Mexa só nos arquivos do seu domínio: `server/src/routes/<domínio>.rs` e as
  funções e telas do seu domínio em `src/`.
- **Não edite** `server/src/main.rs`, `server/src/routes/mod.rs`, `sql.rs`,
  `files.rs`, as migrations nem `src-tauri/`. Precisa de um helper novo? Crie
  dentro do seu módulo (`pub(crate)`) e cite no relatório.
- No `db.ts` e no `api.ts`, troque só os corpos das suas funções. Se uma função
  auxiliar privada ficar sem uso, apague-a (o `tsc` reclama).
- Teste:
  - `cd server && cargo test && cargo clippy --all-targets` (zero avisos);
  - `npx tsc --noEmit`;
  - testes Rust para validações, batches e SQL não trivial, com `db::test_pool()` / `AppState::for_tests()`.

## 5. Rodar e testar no navegador
```sh
# cópia do banco real (só leitura do original)
sqlite3 ~/.config/com.andeerlb.pontoscan/pontoscan.db ".backup '/tmp/<pasta>/pontoscan.db'"
cd server && TAPAGO_REMOTE_CHECKS=off TAPAGO_DEV_USER_EMAIL=dev@local TAPAGO_DB_PATH=/tmp/<pasta>/tapago.db TAPAGO_BIND=127.0.0.1:<porta> cargo run
TAPAGO_API_PROXY=http://127.0.0.1:<porta> npx vite --port <porta-vite> --strictPort
```
Sem `.env.local` com `VITE_FIREBASE_*`, o app abre sem login.
