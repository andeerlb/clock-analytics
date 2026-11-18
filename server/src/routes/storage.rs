//! Configurações → Dados and Zona de risco: storage usage, cleanup, the
//! database copy, the backup .zip and "Apagar histórico e arquivos".
//!
//! Port of `db.ts` (`vacuumDatabase`, `getDatabaseTableSizes`,
//! `getImportedFileNamesByBasename`, `findRedundantOriginals`,
//! `markOriginalsRemoved`, `clearAllData`, SQL verbatim) and of the desktop's
//! `storage.rs` commands. What the desktop saved through a "Salvar como"
//! dialog is written to `uploads/<uuid>/` here and downloaded by the browser.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::error::{ApiError, ApiResult};
use crate::files::{imports_dir, resolve, uploads_dir};
use crate::sql::{self, BatchStatement};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/getStorageUsage", post(get_storage_usage))
        .route("/rpc/getImportsFileList", post(get_imports_file_list))
        .route("/rpc/getDatabaseTableSizes", post(get_database_table_sizes))
        .route("/rpc/listImportedFileNames", post(list_imported_file_names))
        .route("/rpc/vacuumDatabase", post(vacuum_database))
        .route("/rpc/findRedundantOriginals", post(find_redundant_originals))
        .route("/rpc/deleteImportedFiles", post(delete_imported_files))
        .route("/rpc/markOriginalsRemoved", post(mark_originals_removed))
        .route("/rpc/exportDatabase", post(export_database))
        .route("/rpc/backupAppData", post(backup_app_data))
        .route("/rpc/clearAllData", post(clear_all_data))
        .route("/rpc/clearImportsDir", post(clear_imports_dir))
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

/// A fresh `uploads/<uuid>/<name>` for a file the browser will download.
fn download_target(state: &AppState, name: &str) -> PathBuf {
    uploads_dir(&state.data_dir).join(uuid::Uuid::new_v4().to_string()).join(name)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
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

async fn vacuum(state: &AppState) -> ApiResult<()> {
    sql::execute(&state.db, "VACUUM", &[]).await?;
    sql::execute(&state.db, "PRAGMA wal_checkpoint(TRUNCATE)", &[]).await?;
    Ok(())
}

/// "Compactar o banco".
async fn vacuum_database(State(state): State<AppState>) -> ApiResult<StatusCode> {
    vacuum(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Remover originais repetidos ----------------------------------------------

async fn find_redundant_originals(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(
        &state.db,
        "
    SELECT sf.id AS sourceFileId, sf.original_pdf_path AS path
    FROM source_files sf
    WHERE sf.page_count > 1
      AND sf.original_pdf_path != ''
      AND (SELECT COUNT(*) FROM imports i WHERE i.source_file_id = sf.id) = sf.page_count
  ",
        &[],
    )
    .await?;
    Ok(Json(rows.into_iter().map(Value::Object).collect()))
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFileIdsArgs {
    source_file_ids: Vec<i64>,
}

/// "Removed" is the empty string: `original_pdf_path` is NOT NULL.
async fn mark_originals_removed(State(state): State<AppState>, Json(args): Json<SourceFileIdsArgs>) -> ApiResult<StatusCode> {
    if args.source_file_ids.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let placeholders = (1..=args.source_file_ids.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
    let params: Vec<Value> = args.source_file_ids.iter().map(|id| json!(id)).collect();
    sql::execute(&state.db, &format!("UPDATE source_files SET original_pdf_path = '' WHERE id IN ({placeholders})"), &params).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- cópia do banco e backup ---------------------------------------------------

#[derive(Serialize)]
struct GeneratedFile {
    path: String,
}

/// A consistent single-file snapshot of the live database (`VACUUM INTO`:
/// safe while the server keeps writing, no WAL sidecar needed).
async fn snapshot_database(state: &AppState, dest: &Path) -> ApiResult<()> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| ApiError::Internal(e.to_string()))?;
    }
    sql::execute(&state.db, "VACUUM INTO $1", &params![path_string(dest)]).await?;
    Ok(())
}

/// "Baixar uma cópia do banco": the path of a fresh .db for the browser to download.
async fn export_database(State(state): State<AppState>) -> ApiResult<Json<GeneratedFile>> {
    let dest = download_target(&state, "pontoscan.db");
    snapshot_database(&state, &dest).await?;
    Ok(Json(GeneratedFile { path: path_string(&dest) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupArgs {
    include_db: bool,
    include_files: bool,
}

fn add_dir_to_zip(zip: &mut ZipWriter<fs::File>, base: &Path, dir: &Path, options: SimpleFileOptions) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            add_dir_to_zip(zip, base, &path, options)?;
        } else {
            let rel = path.strip_prefix(base).map_err(io::Error::other)?;
            zip.start_file(format!("imports/{}", rel.to_string_lossy()), options)?;
            io::copy(&mut fs::File::open(&path)?, zip)?;
        }
    }
    Ok(())
}

/// The backup .zip offered before "Apagar histórico e arquivos": the
/// database (as `pontoscan.db`) and/or the whole `imports/` tree, same layout
/// as the desktop's. Imported files are stored as-is: PDFs and spreadsheets
/// are already compressed, and deflating them only costs the small VM time.
async fn backup_app_data(State(state): State<AppState>, Json(args): Json<BackupArgs>) -> ApiResult<Json<GeneratedFile>> {
    let dest = download_target(&state, "pontoscan-backup.zip");
    let snapshot = dest.with_file_name("pontoscan.db");
    if args.include_db {
        snapshot_database(&state, &snapshot).await?;
    } else if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| ApiError::Internal(e.to_string()))?;
    }
    let imports = imports_dir(&state.data_dir);
    let zip_path = dest.clone();
    blocking(move || {
        let mut zip = ZipWriter::new(fs::File::create(&zip_path)?);
        if args.include_db {
            let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
            zip.start_file("pontoscan.db", deflated)?;
            io::copy(&mut fs::File::open(&snapshot)?, &mut zip)?;
            fs::remove_file(&snapshot)?;
        }
        if args.include_files && imports.exists() {
            let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
            add_dir_to_zip(&mut zip, &imports, &imports, stored)?;
        }
        zip.finish()?.flush()
    })
    .await?;
    Ok(Json(GeneratedFile { path: path_string(&dest) }))
}

// --- Apagar histórico e arquivos ----------------------------------------------

/// `ClearDataOptions`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ClearDataOptions {
    keep_companies: bool,
    keep_clients: bool,
    keep_employees: bool,
    keep_payment_templates: bool,
    keep_employee_templates: bool,
    keep_manually_edited_shifts: bool,
}

/// `clearAllData`'s statements, in order (children before parents: foreign
/// keys are enforced and none cascade), plus the tables whose
/// autoincrement counters reset.
fn clear_statements(options: &ClearDataOptions) -> (Vec<String>, Vec<&'static str>) {
    let keep_employees = options.keep_employees;
    let keep_clients = options.keep_clients || keep_employees;
    let keep_companies = options.keep_companies || keep_clients;
    let keep_payment_templates = options.keep_payment_templates;
    let keep_employee_templates = options.keep_employee_templates;
    let keep_manually_edited_shifts = options.keep_manually_edited_shifts && keep_employees;

    let mut statements: Vec<String> = [
        "DELETE FROM punches",
        "DELETE FROM day_records",
        "DELETE FROM imports",
        "DELETE FROM import_files",
        "UPDATE payment_shifts SET previous_shift_id = NULL WHERE previous_shift_id IS NOT NULL",
    ]
    .map(String::from)
    .to_vec();

    let going_shifts = if keep_manually_edited_shifts { "SELECT id FROM payment_shifts WHERE edited_manually = 0" } else { "SELECT id FROM payment_shifts" };
    statements.push(format!("DELETE FROM payment_audits WHERE payment_shift_id IN ({going_shifts})"));
    statements.push(format!("UPDATE source_url_check_diffs SET matched_shift_id = NULL WHERE matched_shift_id IN ({going_shifts})"));
    if keep_manually_edited_shifts {
        statements.push(format!(
            "UPDATE payment_shifts SET source_file_id = NULL{} WHERE edited_manually = 1",
            if keep_payment_templates { "" } else { ", template_id = NULL" }
        ));
        statements.push("DELETE FROM payment_shifts WHERE edited_manually = 0".into());
    } else {
        statements.push("DELETE FROM payment_shifts".into());
    }
    statements.push("DELETE FROM source_files".into());

    let mut cleared = vec!["punches", "day_records", "imports", "import_files", "payment_shifts", "source_files"];
    let mut push = |list: &[&str]| statements.extend(list.iter().map(|s| s.to_string()));

    if !keep_payment_templates {
        push(&[
            "DELETE FROM payment_template_rules",
            "DELETE FROM payment_template_status_rules",
            "DELETE FROM payment_template_fields",
            "DELETE FROM payment_template_sheets",
            "DELETE FROM payment_template_groups",
            "DELETE FROM payment_templates",
        ]);
        cleared.push("payment_templates");
    }
    if !keep_employee_templates {
        push(&["DELETE FROM employee_template_fields", "DELETE FROM employee_template_sheets", "DELETE FROM employee_template_groups", "DELETE FROM employee_templates"]);
        cleared.push("employee_templates");
    }
    if !keep_employees {
        push(&["DELETE FROM employee_pix_keys", "DELETE FROM employee_aliases", "DELETE FROM employee_client_companies", "DELETE FROM employees"]);
        cleared.extend(["employee_pix_keys", "employee_aliases", "employee_client_companies", "employees"]);
    }
    if !keep_clients {
        push(&["DELETE FROM payment_template_rules", "DELETE FROM client_payment_value_rules", "DELETE FROM client_companies", "DELETE FROM clients"]);
        cleared.extend(["client_payment_value_rules", "clients"]);
    }
    if !keep_companies {
        push(&["DELETE FROM payment_value_rules", "DELETE FROM role_aliases", "DELETE FROM roles", "DELETE FROM companies"]);
        cleared.extend(["payment_value_rules", "role_aliases", "roles", "companies"]);
    }
    (statements, cleared)
}

#[derive(Deserialize)]
struct ClearArgs {
    #[serde(default)]
    options: ClearDataOptions,
}

/// The database half of "Apagar histórico e arquivos": one transaction, then
/// the autoincrement counters and the freed space.
async fn clear_all_data(State(state): State<AppState>, Json(args): Json<ClearArgs>) -> ApiResult<StatusCode> {
    let (statements, cleared) = clear_statements(&args.options);
    sql::run_batch(&state.db, statements.into_iter().map(|s| BatchStatement::new(s, vec![])).collect()).await?;

    let placeholders = (1..=cleared.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
    let params: Vec<Value> = cleared.iter().map(|t| json!(t)).collect();
    // No autoincrement table written yet means no sqlite_sequence: nothing to reset.
    let _ = sql::execute(&state.db, &format!("DELETE FROM sqlite_sequence WHERE name IN ({placeholders})"), &params).await;

    vacuum(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The file half: empties `imports/`.
async fn clear_imports_dir(State(state): State<AppState>) -> ApiResult<StatusCode> {
    let dir = imports_dir(&state.data_dir);
    blocking(move || {
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::create_dir_all(&dir)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::call;
    use std::io::Read;

    async fn count(state: &AppState, table: &str) -> i64 {
        sql::select_one(&state.db, &format!("SELECT COUNT(*) AS n FROM {table}"), &[]).await.unwrap().unwrap()["n"].as_i64().unwrap()
    }

    async fn seed(state: &AppState) {
        for stmt in [
            "INSERT INTO companies (id, name, cnpj) VALUES (1, 'Acme', '11222333000181')",
            "INSERT INTO clients (id, name, cnpj) VALUES (1, 'Cliente', '11444777000161')",
            "INSERT INTO client_companies (client_id, company_id) VALUES (1, 1)",
            "INSERT INTO employees (id, name, cpf) VALUES (1, 'Ana', '52998224725')",
            "INSERT INTO employee_client_companies (employee_id, client_id, company_id) VALUES (1, 1, 1)",
            "INSERT INTO payment_templates (id, name, file_kind, date_format, identifier_priority) VALUES (1, 'T', 'xlsx', 'DD/MM/YYYY', '[]')",
            "INSERT INTO payment_shifts (id, employee_id, client_id, company_id, local, work_date, status, template_id, edited_manually) VALUES (1, 1, 1, 1, 'L', '2026-01-01', 'pendente', 1, 0)",
            "INSERT INTO payment_shifts (id, employee_id, client_id, company_id, local, work_date, status, template_id, edited_manually) VALUES (2, 1, 1, 1, 'L', '2026-01-02', 'pago', 1, 1)",
        ] {
            sql::execute(&state.db, stmt, &[]).await.unwrap_or_else(|e| panic!("{stmt}: {e}"));
        }
    }

    #[tokio::test]
    async fn clear_everything() {
        let state = AppState::for_tests().await;
        seed(&state).await;
        call(&state, clear_all_data, json!({ "options": {} })).await.unwrap();
        for table in ["payment_shifts", "employees", "clients", "companies", "payment_templates"] {
            assert_eq!(count(&state, table).await, 0, "{table}");
        }
    }

    #[tokio::test]
    async fn clear_keeping_people_and_hand_edited_shifts() {
        let state = AppState::for_tests().await;
        seed(&state).await;
        call(&state, clear_all_data, json!({ "options": { "keepEmployees": true, "keepManuallyEditedShifts": true } })).await.unwrap();
        assert_eq!(count(&state, "employees").await, 1);
        assert_eq!(count(&state, "clients").await, 1, "keeping employees keeps their clients");
        assert_eq!(count(&state, "companies").await, 1);
        assert_eq!(count(&state, "payment_templates").await, 0);
        let kept = sql::select(&state.db, "SELECT id, template_id AS templateId, source_file_id AS sourceFileId FROM payment_shifts", &[]).await.unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["id"], json!(2));
        assert!(kept[0]["templateId"].is_null(), "templates went, so the link is dropped");
    }

    #[tokio::test]
    async fn hand_edited_shifts_need_employees() {
        let state = AppState::for_tests().await;
        seed(&state).await;
        call(&state, clear_all_data, json!({ "options": { "keepManuallyEditedShifts": true } })).await.unwrap();
        assert_eq!(count(&state, "payment_shifts").await, 0);
    }

    /// A database on disk, like production (`VACUUM INTO` from an in-memory
    /// database writes to memory, not to the file).
    async fn state_on_disk() -> AppState {
        let dir = std::env::temp_dir().join(format!("pontoscan-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let pool = crate::db::connect(&dir.join("pontoscan.db")).await.unwrap();
        AppState::new(pool, dir, chrono_tz::America::Sao_Paulo)
    }

    #[tokio::test]
    async fn database_copy_and_backup_zip() {
        let state = state_on_disk().await;
        seed(&state).await;
        let imports = imports_dir(&state.data_dir);
        fs::create_dir_all(&imports).unwrap();
        fs::write(imports.join("a.pdf"), b"%PDF-1.4 teste").unwrap();

        let copy = call(&state, |s, _: Json<Value>| export_database(s), json!({})).await.unwrap();
        let copy_path = copy["path"].as_str().unwrap();
        let mut header = [0u8; 16];
        fs::File::open(copy_path).unwrap().read_exact(&mut header).unwrap();
        assert_eq!(&header, b"SQLite format 3\0");

        let zip_path = call(&state, backup_app_data, json!({ "includeDb": true, "includeFiles": true })).await.unwrap()["path"].as_str().unwrap().to_owned();
        let mut archive = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["imports/a.pdf", "pontoscan.db"]);
        let mut pdf = String::new();
        archive.by_name("imports/a.pdf").unwrap().read_to_string(&mut pdf).unwrap();
        assert_eq!(pdf, "%PDF-1.4 teste");
        assert!(!Path::new(&zip_path).with_file_name("pontoscan.db").exists(), "the snapshot is removed after zipping");

        let only_db = call(&state, backup_app_data, json!({ "includeDb": true, "includeFiles": false })).await.unwrap();
        assert_eq!(zip::ZipArchive::new(fs::File::open(only_db["path"].as_str().unwrap()).unwrap()).unwrap().len(), 1);
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

        call(&state, |s, _: Json<Value>| clear_imports_dir(s), json!({})).await.unwrap();
        assert!(imports.exists());
        assert_eq!(fs::read_dir(&imports).unwrap().count(), 0);
    }
}
