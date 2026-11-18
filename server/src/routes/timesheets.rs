//! Importação de espelhos de ponto e Cartão Ponto (imports, day_records, source_files) + os comandos de PDF.
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
