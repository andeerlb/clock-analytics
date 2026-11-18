//! Configurações → "Espaço usado" (database and imported files on the
//! server), and deleting spreadsheets downloaded by link once an import
//! saved them. The desktop's maintenance tools (compactar, cópia do banco,
//! remover originais, apagar histórico) don't exist on the web.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::files::{imports_dir, resolve};
use crate::sql;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/getStorageUsage", post(get_storage_usage))
        .route("/rpc/getImportsFileList", post(get_imports_file_list))
        .route("/rpc/getDatabaseTableSizes", post(get_database_table_sizes))
        .route("/rpc/listImportedFileNames", post(list_imported_file_names))
        .route("/rpc/deleteImportedFiles", post(delete_imported_files))
}

/// Runs blocking file work off the async runtime.
async fn blocking<T, F>(work: F) -> ApiResult<T>
where
    F: FnOnce() -> io::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .map_err(|e| ApiError::Internal(e.to_string()))
}

/// The SQLite file the pool has open (`None` for an in-memory database).
async fn database_path(state: &AppState) -> ApiResult<Option<PathBuf>> {
    let row = sql::select_one(&state.db, "SELECT file FROM pragma_database_list WHERE name = 'main'", &[]).await?;
    Ok(row.and_then(|r| r.get("file").and_then(Value::as_str).map(PathBuf::from)).filter(|p| !p.as_os_str().is_empty()))
}

// --- Espaço usado ------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StorageUsage {
    db_bytes: u64,
    imports_bytes: u64,
    imports_file_count: u64,
}

fn dir_size(dir: &Path) -> (u64, u64) {
    let Ok(entries) = fs::read_dir(dir) else { return (0, 0) };
    let mut total = (0, 0);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (bytes, count) = dir_size(&path);
            total = (total.0 + bytes, total.1 + count);
        } else if let Ok(meta) = entry.metadata() {
            total = (total.0 + meta.len(), total.1 + 1);
        }
    }
    total
}

/// The database (with its WAL/SHM sidecars) and `imports/`.
async fn get_storage_usage(State(state): State<AppState>) -> ApiResult<Json<StorageUsage>> {
    let db = database_path(&state).await?;
    let imports = imports_dir(&state.data_dir);
    let usage = blocking(move || {
        let db_bytes = ["", "-wal", "-shm"]
            .iter()
            .filter_map(|suffix| db.as_ref().and_then(|db| fs::metadata(format!("{}{suffix}", db.display())).ok()))
            .map(|m| m.len())
            .sum();
        let (imports_bytes, imports_file_count) = dir_size(&imports);
        Ok(StorageUsage { db_bytes, imports_bytes, imports_file_count })
    })
    .await?;
    Ok(Json(usage))
}

#[derive(Debug, Serialize)]
struct FileEntry {
    name: String,
    bytes: u64,
}

/// Files directly inside `imports/` (the layout there is flat).
async fn get_imports_file_list(State(state): State<AppState>) -> ApiResult<Json<Vec<FileEntry>>> {
    let dir = imports_dir(&state.data_dir);
    let files = blocking(move || {
        let Ok(entries) = fs::read_dir(&dir) else { return Ok(vec![]) };
        Ok(entries
            .flatten()
            .filter_map(|entry| {
                let meta = entry.metadata().ok().filter(|m| m.is_file())?;
                Some(FileEntry { name: entry.file_name().to_str()?.to_owned(), bytes: meta.len() })
            })
            .collect())
    })
    .await?;
    Ok(Json(files))
}

/// Per-table disk usage, indexes rolled into their table (`dbstat`).
async fn get_database_table_sizes(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(
        &state.db,
        "SELECT m.tbl_name AS tableName, SUM(d.pgsize) AS bytes
     FROM dbstat d
     JOIN sqlite_master m ON m.name = d.name
     WHERE m.type IN ('table', 'index')
     GROUP BY m.tbl_name
     ORDER BY bytes DESC",
        &[],
    )
    .await?;
    Ok(Json(rows.into_iter().map(Value::Object).collect()))
}

/// `getImportedFileNamesByBasename`'s query; the TS builds the map.
async fn list_imported_file_names(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(&state.db, "SELECT original_pdf_path AS path, file_name AS fileName FROM source_files WHERE original_pdf_path != ''", &[]).await?;
    Ok(Json(rows.into_iter().map(Value::Object).collect()))
}

// --- Planilhas baixadas por link --------------------------------------------

#[derive(Deserialize)]
struct PathsArgs {
    paths: Vec<String>,
}

/// `deletePaths`, limited to files inside `imports/`. A file already gone
/// isn't an error; returns the bytes actually freed.
async fn delete_imported_files(State(state): State<AppState>, Json(args): Json<PathsArgs>) -> ApiResult<Json<u64>> {
    let imports = imports_dir(&state.data_dir).canonicalize().unwrap_or_else(|_| imports_dir(&state.data_dir));
    let mut targets = Vec::new();
    for path in &args.paths {
        match resolve(&state.data_dir, path) {
            Ok(resolved) if resolved.starts_with(&imports) => targets.push(resolved),
            // uploads/ is reachable too, but only imported files are deleted here.
            Ok(_) => return Err(ApiError::BadRequest("Só arquivos importados podem ser apagados por aqui.".into())),
            Err(ApiError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
    }
    let freed = blocking(move || {
        let mut freed = 0u64;
        for path in targets {
            let len = fs::metadata(&path)?.len();
            match fs::remove_file(&path) {
                Ok(()) => freed += len,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(freed)
    })
    .await?;
    Ok(Json(freed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    use crate::routes::call;
    use serde_json::json;

    /// A database on disk, like production (`VACUUM INTO` from an in-memory
    /// database writes to memory, not to the file).
    async fn state_on_disk() -> AppState {
        let dir = std::env::temp_dir().join(format!("tapago-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let pool = crate::db::connect(&dir.join("tapago.db")).await.unwrap();
        AppState::new(pool, dir, chrono_tz::America::Sao_Paulo)
    }

    #[tokio::test]
    async fn storage_usage_and_deleting_only_imported_files() {
        let state = state_on_disk().await;
        let imports = imports_dir(&state.data_dir);
        fs::create_dir_all(&imports).unwrap();
        fs::write(imports.join("a.pdf"), vec![0u8; 100]).unwrap();
        fs::write(imports.join("b.pdf"), vec![0u8; 50]).unwrap();
        fs::write(state.data_dir.join("outro.txt"), b"x").unwrap();

        let usage = call(&state, |s, _: Json<Value>| get_storage_usage(s), json!({})).await.unwrap();
        assert_eq!(usage["importsBytes"], json!(150));
        assert_eq!(usage["importsFileCount"], json!(2));
        assert!(usage["dbBytes"].as_u64().unwrap() > 0);

        let outside = path_string(&state.data_dir.join("outro.txt"));
        // Outside imports/ is "not found" for the browser: nothing is deleted.
        assert_eq!(call(&state, delete_imported_files, json!({ "paths": [outside] })).await.unwrap(), json!(0));
        assert!(state.data_dir.join("outro.txt").exists());
        let a = path_string(&imports.join("a.pdf"));
        let gone = path_string(&imports.join("sumiu.pdf"));
        let freed = call(&state, delete_imported_files, json!({ "paths": [a, gone] })).await.unwrap();
        assert_eq!(freed, json!(100));
        assert!(!imports.join("a.pdf").exists());
        assert!(state.data_dir.join("outro.txt").exists());
    }
}
