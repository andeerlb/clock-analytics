//! "Assistente com IA": the team's Anthropic API key and the RPC endpoints
//! the chat (`AiAssistant.tsx`) and Configurações (`AiSettingsCard.tsx`) call.
//! The assistant itself is in `investigation`.
//!
//! One key for the whole team, saved by any signed-in user. It lives in a
//! file of its own under the data dir (`secrets/anthropic-api-key.json`,
//! 0600 in a 0700 folder), not in the SQLite database, which is replicated
//! to backups. It never goes back to the browser: `aiStatus` only says who
//! saved it, when, and its last 4 characters.

mod investigation;

use std::io::Write;
use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::AppState;

use investigation::{AskOutcome, AskRequest};

const SECRETS_DIR: &str = "secrets";
const KEY_FILE: &str = "anthropic-api-key.json";
/// Anthropic keys are ~110 characters; anything far past that was pasted wrong.
const MAX_KEY_CHARS: usize = 500;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/aiStatus", post(ai_status))
        .route("/rpc/aiSetApiKey", post(ai_set_api_key))
        .route("/rpc/aiClearApiKey", post(ai_clear_api_key))
        .route("/rpc/aiAsk", post(ai_ask))
}

// ---------------------------------------------------------------------------
// Key storage
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredKey {
    key: String,
    /// E-mail of who saved it.
    saved_by: String,
    /// RFC 3339, UTC.
    saved_at: String,
}

fn key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SECRETS_DIR).join(KEY_FILE)
}

fn io_error(e: std::io::Error) -> ApiError {
    ApiError::Internal(format!("chave da Anthropic: {e}"))
}

fn read_key(data_dir: &Path) -> ApiResult<Option<StoredKey>> {
    match std::fs::read(key_path(data_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| ApiError::Internal(format!("chave da Anthropic ilegível: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}

/// Owner-only folder, created if missing and tightened if it already exists.
fn secrets_dir(data_dir: &Path) -> ApiResult<PathBuf> {
    let dir = data_dir.join(SECRETS_DIR);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    }
    Ok(dir)
}

/// Written to a 0600 temporary file and renamed over the old one, so a
/// reader never sees half a key and the key is never readable by others,
/// not even for a moment.
fn write_key(data_dir: &Path, stored: &StoredKey) -> ApiResult<()> {
    let dir = secrets_dir(data_dir)?;
    let temp = dir.join(format!(".{KEY_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(stored).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, dir.join(KEY_FILE))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(io_error)
}

fn clear_key(data_dir: &Path) -> ApiResult<()> {
    match std::fs::remove_file(key_path(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(e)),
    }
}

/// Same message as the desktop when empty. The key goes into an HTTP header,
/// so whitespace or control characters inside it mean a bad paste.
fn validate_key(api_key: &str) -> ApiResult<String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(ApiError::BadRequest("Informe a chave de API.".into()));
    }
    if api_key.chars().count() > MAX_KEY_CHARS || api_key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ApiError::BadRequest("Essa chave de API não parece válida. Copie de novo do console da Anthropic.".into()));
    }
    Ok(api_key.to_string())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AiStatus {
    /// Whether a key is saved: without one the assistant is off.
    api_key: bool,
    saved_by: Option<String>,
    saved_at: Option<String>,
    /// Enough to tell keys apart; never the key itself.
    key_last4: Option<String>,
}

fn status_of(stored: Option<StoredKey>) -> AiStatus {
    match stored {
        Some(stored) => {
            let chars: Vec<char> = stored.key.chars().collect();
            let last4: String = chars[chars.len().saturating_sub(4)..].iter().collect();
            AiStatus { api_key: true, saved_by: Some(stored.saved_by), saved_at: Some(stored.saved_at), key_last4: Some(last4) }
        }
        None => AiStatus { api_key: false, saved_by: None, saved_at: None, key_last4: None },
    }
}

async fn ai_status(State(state): State<AppState>) -> ApiResult<Json<AiStatus>> {
    Ok(Json(status_of(read_key(&state.data_dir)?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetKeyArgs {
    api_key: String,
}

async fn ai_set_api_key(State(state): State<AppState>, Extension(user): Extension<AuthUser>, Json(args): Json<SetKeyArgs>) -> ApiResult<StatusCode> {
    let key = validate_key(&args.api_key)?;
    let stored = StoredKey { key, saved_by: user.email, saved_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true) };
    write_key(&state.data_dir, &stored)?;
    tracing::info!(saved_by = %stored.saved_by, "chave da Anthropic cadastrada");
    Ok(StatusCode::NO_CONTENT)
}

async fn ai_clear_api_key(State(state): State<AppState>, Extension(user): Extension<AuthUser>) -> ApiResult<StatusCode> {
    clear_key(&state.data_dir)?;
    tracing::info!(removed_by = %user.email, "chave da Anthropic removida");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AskArgs {
    request: AskRequest,
}

/// Read-only question to the assistant. Can take a few minutes (up to
/// `MAX_TURNS` round trips to the API); the answer comes back in one piece.
async fn ai_ask(State(state): State<AppState>, Json(args): Json<AskArgs>) -> ApiResult<Json<AskOutcome>> {
    let stored = read_key(&state.data_dir)?
        .ok_or_else(|| ApiError::BadRequest("O assistente está desligado: cadastre uma chave da Anthropic em Configurações.".into()))?;
    Ok(Json(investigation::ask(&state.db, &stored.key, args.request).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::call;
    use serde_json::{json, Value};

    const KEY: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ";

    async fn save(state: &AppState, key: &str, email: &str) -> ApiResult<StatusCode> {
        ai_set_api_key(State(state.clone()), Extension(AuthUser { email: email.into(), initial_admin: true }), Json(SetKeyArgs { api_key: key.into() })).await
    }

    async fn status(state: &AppState) -> Value {
        call(state, |s, Json(()): Json<()>| ai_status(s), Value::Null).await.unwrap()
    }

    #[tokio::test]
    async fn without_a_key_the_status_says_so() {
        let state = AppState::for_tests().await;
        assert_eq!(status(&state).await, json!({ "apiKey": false, "savedBy": null, "savedAt": null, "keyLast4": null }));
    }

    #[tokio::test]
    async fn saving_records_who_and_when_and_the_status_shows_only_the_last_4() {
        let state = AppState::for_tests().await;
        save(&state, &format!("  {KEY}\n"), "ana@empresa.com").await.unwrap();
        let shown = status(&state).await;
        assert_eq!(shown["apiKey"], true);
        assert_eq!(shown["savedBy"], "ana@empresa.com");
        assert_eq!(shown["keyLast4"], "WXYZ");
        let saved_at = chrono::DateTime::parse_from_rfc3339(shown["savedAt"].as_str().unwrap()).unwrap();
        assert!((Utc::now() - saved_at.with_timezone(&Utc)).num_seconds().abs() < 60);
        assert!(!shown.to_string().contains("abcdefghij"), "the key never goes back: {shown}");
        // Stored trimmed, exactly as it will go in the header.
        assert_eq!(read_key(&state.data_dir).unwrap().unwrap().key, KEY);
    }

    #[tokio::test]
    async fn saving_again_replaces_the_key_and_who_saved_it() {
        let state = AppState::for_tests().await;
        save(&state, KEY, "ana@empresa.com").await.unwrap();
        save(&state, "sk-ant-outra-1234", "bia@empresa.com").await.unwrap();
        let stored = read_key(&state.data_dir).unwrap().unwrap();
        assert_eq!((stored.key.as_str(), stored.saved_by.as_str()), ("sk-ant-outra-1234", "bia@empresa.com"));
        let leftovers: Vec<_> = std::fs::read_dir(state.data_dir.join(SECRETS_DIR)).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, [KEY_FILE], "no temporary files left behind");
    }

    #[tokio::test]
    async fn clearing_removes_the_key_and_is_fine_when_there_is_none() {
        let state = AppState::for_tests().await;
        let clear = || ai_clear_api_key(State(state.clone()), Extension(AuthUser { email: "ana@empresa.com".into(), initial_admin: true }));
        assert_eq!(clear().await.unwrap(), StatusCode::NO_CONTENT);
        save(&state, KEY, "ana@empresa.com").await.unwrap();
        clear().await.unwrap();
        assert_eq!(status(&state).await["apiKey"], false);
        assert!(!key_path(&state.data_dir).exists());
    }

    #[tokio::test]
    async fn empty_or_mangled_keys_are_refused_with_the_desktop_message() {
        let state = AppState::for_tests().await;
        for (key, message) in [
            ("   ", "Informe a chave de API."),
            ("sk-ant-com espaço", "Essa chave de API não parece válida. Copie de novo do console da Anthropic."),
            (&"x".repeat(MAX_KEY_CHARS + 1), "Essa chave de API não parece válida. Copie de novo do console da Anthropic."),
        ] {
            let error = save(&state, key, "ana@empresa.com").await.unwrap_err();
            assert!(matches!(&error, ApiError::BadRequest(m) if m == message), "{key:?}: {error}");
        }
        assert!(!key_path(&state.data_dir).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let state = AppState::for_tests().await;
        // A folder that already existed with loose permissions gets tightened.
        std::fs::create_dir_all(state.data_dir.join(SECRETS_DIR)).unwrap();
        std::fs::set_permissions(state.data_dir.join(SECRETS_DIR), std::fs::Permissions::from_mode(0o755)).unwrap();
        save(&state, KEY, "ana@empresa.com").await.unwrap();
        save(&state, "sk-ant-outra-1234", "ana@empresa.com").await.unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&key_path(&state.data_dir)), 0o600);
        assert_eq!(mode(&state.data_dir.join(SECRETS_DIR)), 0o700);
    }

    #[tokio::test]
    async fn the_key_never_lands_in_the_database() {
        let state = AppState::for_tests().await;
        save(&state, KEY, "ana@empresa.com").await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'").fetch_all(&state.db).await.unwrap();
        for table in tables {
            let rows = crate::sql::select(&state.db, &format!("SELECT * FROM \"{table}\""), &[]).await.unwrap();
            let dump = serde_json::to_string(&rows).unwrap();
            assert!(!dump.contains("abcdefghij") && !dump.contains("ana@empresa.com"), "found in {table}");
        }
    }

    #[tokio::test]
    async fn asking_without_a_key_explains_how_to_turn_it_on() {
        let state = AppState::for_tests().await;
        let args = json!({ "request": { "conversation": [], "question": "quantos turnos?", "screen": null, "shift": null, "nameChoices": {} } });
        let error = call(&state, ai_ask, args).await.unwrap_err();
        assert_eq!(error.to_string(), "O assistente está desligado: cadastre uma chave da Anthropic em Configurações.");
    }
}
