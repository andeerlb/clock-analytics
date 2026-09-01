use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Every SQLite database file starts with this exact 16-byte header.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Disk usage of everything the app itself created — the DB (plus its WAL/
/// SHM sidecars, which hold real data until checkpointed) and the copied
/// imported files under `imports/` (timesheet PDFs, plus any payment
/// spreadsheet downloaded by link). Powers the storage indicator in
/// Configurações.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub db_bytes: u64,
    pub imports_bytes: u64,
    pub imports_file_count: u64,
}

pub fn usage(data_dir: &Path) -> StorageUsage {
    let mut db_bytes = 0u64;
    for suffix in ["", "-wal", "-shm"] {
        let path = data_dir.join(format!("pontoscan.db{suffix}"));
        if let Ok(meta) = fs::metadata(&path) {
            db_bytes += meta.len();
        }
    }

    let (imports_bytes, imports_file_count) = dir_size(&data_dir.join("imports"));

    StorageUsage {
        db_bytes,
        imports_bytes,
        imports_file_count,
    }
}

fn dir_size(dir: &Path) -> (u64, u64) {
    let mut total = 0u64;
    let mut count = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (b, c) = dir_size(&path);
            total += b;
            count += c;
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
            count += 1;
        }
    }
    (total, count)
}

/// One file's name and size — the itemized counterpart to `dir_size`'s
/// aggregate total, for the "o que está pesando" breakdown behind
/// "PDFs importados" in Configurações. Only regards files directly inside
/// `dir` (the layout there is flat; a stray subdirectory, e.g. a
/// still-in-progress PDF split, is skipped rather than recursed into).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub bytes: u64,
}

pub fn list_files(dir: &Path) -> Vec<FileEntry> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            out.push(FileEntry { name: name.to_string(), bytes: meta.len() });
        }
    }
    out
}

/// Best-effort delete of every path given — used both for "remover
/// originais redundantes" (specific files) and could be reused elsewhere.
/// A file already missing isn't an error (nothing to clean up); any other
/// failure is collected and reported, but doesn't stop the rest from being
/// attempted. Returns the total bytes actually freed.
pub fn delete_paths(paths: &[String]) -> Result<u64, String> {
    let mut freed = 0u64;
    let mut errors = Vec::new();
    for path in paths {
        match fs::metadata(path) {
            Ok(meta) => match fs::remove_file(path) {
                Ok(()) => freed += meta.len(),
                Err(e) => errors.push(format!("{path}: {e}")),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errors.push(format!("{path}: {e}")),
        }
    }
    if errors.is_empty() {
        Ok(freed)
    } else {
        Err(errors.join("; "))
    }
}

/// Empties and recreates `imports/` — the file half of "Limpar tudo". The
/// database half (deleting every row) runs separately over the existing SQL
/// connection rather than touching the `.db` file directly, since it can
/// stay open the whole time.
pub fn clear_imports_dir(data_dir: &Path) -> Result<(), String> {
    let imports_dir = data_dir.join("imports");
    if imports_dir.exists() {
        fs::remove_dir_all(&imports_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&imports_dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// Zips up the database (with its WAL/SHM sidecars, if present) and/or the
/// whole `imports/` tree — an escape hatch to save a copy before "Limpar
/// tudo" wipes everything, since this app keeps the only copy of its data.
/// `include_db`/`include_files` let the caller back up just one side (e.g.
/// only the database, skipping the potentially much larger PDF files)
/// instead of always bundling both.
pub fn backup(
    data_dir: &Path,
    dest_zip_path: &str,
    include_db: bool,
    include_files: bool,
) -> Result<(), String> {
    let file = fs::File::create(dest_zip_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    if include_db {
        for suffix in ["", "-wal", "-shm"] {
            let name = format!("pontoscan.db{suffix}");
            let path = data_dir.join(&name);
            if path.exists() {
                let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                zip.start_file(&name, options).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
            }
        }
    }

    if include_files {
        let imports_dir = data_dir.join("imports");
        if imports_dir.exists() {
            add_dir_to_zip(&mut zip, &imports_dir, &imports_dir, "imports", options)?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut ZipWriter<fs::File>,
    base: &Path,
    dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            add_dir_to_zip(zip, base, &path, prefix, options)?;
        } else {
            let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
            let zip_path = format!("{prefix}/{}", rel.to_string_lossy());
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            zip.start_file(zip_path, options).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copies the live `pontoscan.db` to `dest_path` — the caller is expected
/// to have already run `PRAGMA wal_checkpoint(TRUNCATE)` over the existing
/// connection first, so this single file (no `-wal`/`-shm` sidecars needed)
/// is a complete, self-contained snapshot of everything up to this moment.
pub fn export_database(data_dir: &Path, dest_path: &str) -> Result<(), String> {
    let src = data_dir.join("pontoscan.db");
    fs::copy(&src, dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

const PENDING_IMPORT_FILE: &str = "pontoscan.db.pending-import";
const STAGING_IMPORT_FILE: &str = "pontoscan.db.import-copying";
const ROLLBACK_IMPORT_FILE: &str = "pontoscan.db.import-rollback";
const IMPORT_RESULT_FILE: &str = "database-import-result.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseImportResult {
    pub success: bool,
    pub message: String,
    pub events: Vec<DatabaseImportEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseImportEvent {
    pub label: String,
    pub occurred_at: String,
}

fn import_event(label: &str) -> DatabaseImportEvent {
    DatabaseImportEvent {
        label: label.into(),
        occurred_at: chrono::Local::now().format("%H:%M:%S%.3f").to_string(),
    }
}

/// Validates and stages an imported database without touching the live
/// file. The running app may still have queries/connections in flight, so
/// replacing `pontoscan.db` here can deadlock its pool or leave the UI alive
/// with a closed DB if anything fails afterward. `apply_pending_database_import`
/// performs the actual swap on the next launch, before the frontend opens
/// SQLite at all.
pub fn import_database(data_dir: &Path, src_path: &str) -> Result<Vec<DatabaseImportEvent>, String> {
    let mut events = vec![import_event("Validando arquivo")];
    let mut header = [0u8; 16];
    let mut f = fs::File::open(src_path).map_err(|e| e.to_string())?;
    f.read_exact(&mut header).map_err(|_| {
        "Arquivo pequeno demais para ser um banco de dados SQLite válido.".to_string()
    })?;
    if &header != SQLITE_MAGIC {
        return Err("Esse arquivo não é um banco de dados SQLite válido.".to_string());
    }
    events.push(import_event("Arquivo validado"));
    events.push(import_event("Preparando restauração"));

    let staging = data_dir.join(STAGING_IMPORT_FILE);
    let pending = data_dir.join(PENDING_IMPORT_FILE);
    let _ = fs::remove_file(&staging);
    fs::copy(src_path, &staging).map_err(|e| e.to_string())?;
    // Only this atomic rename makes the import eligible for startup. A
    // forced close during `copy` leaves merely `import-copying`, which the
    // next launch discards instead of treating as a complete database.
    fs::rename(&staging, &pending).map_err(|e| e.to_string())?;
    events.push(import_event("Restauração preparada"));
    events.push(import_event("Aguardando reinício"));
    Ok(events)
}

/// Applies a previously staged import during app startup, while no SQL
/// plugin connection exists yet. The old DB is backed up first. If the
/// final rename fails after removing the old file, the backup is restored
/// immediately so startup never knowingly leaves the app without a DB.
pub fn apply_pending_database_import(data_dir: &Path) -> Result<bool, String> {
    let staging = data_dir.join(STAGING_IMPORT_FILE);
    let pending = data_dir.join(PENDING_IMPORT_FILE);
    let rollback = data_dir.join(ROLLBACK_IMPORT_FILE);
    let dest = data_dir.join("pontoscan.db");

    // An interrupted staging copy was never declared ready and is safe to
    // discard. It can be at most one selected DB in size and never grows
    // across launches.
    if staging.exists() {
        let _ = fs::remove_file(&staging);
    }

    if !pending.exists() {
        // Crash after installing the imported DB but before deleting the
        // rollback: finish the successful cleanup now.
        if rollback.exists() && dest.exists() {
            fs::remove_file(rollback).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        // No ready import exists, so an orphan rollback means the swap did
        // not reach installation. Put the previous DB back.
        if rollback.exists() && !dest.exists() {
            fs::rename(rollback, dest).map_err(|e| e.to_string())?;
            return Err("A restauração foi interrompida e o banco anterior foi recuperado.".into());
        }
        return Ok(false);
    }

    // Resume safely if a previous process stopped after moving the old DB
    // aside but before installing the ready import.
    if dest.exists() {
        let _ = fs::remove_file(&rollback);
        fs::rename(&dest, &rollback).map_err(|e| e.to_string())?;
    }

    for suffix in ["-wal", "-shm"] {
        let sidecar = data_dir.join(format!("pontoscan.db{suffix}"));
        if sidecar.exists() {
            fs::remove_file(&sidecar).map_err(|e| e.to_string())?;
        }
    }

    if let Err(error) = fs::rename(&pending, &dest) {
        if rollback.exists() {
            let _ = fs::rename(&rollback, &dest);
        }
        return Err(error.to_string());
    }
    if rollback.exists() {
        if let Err(error) = fs::remove_file(&rollback) {
            let _ = fs::remove_file(&dest);
            let _ = fs::rename(&rollback, &dest);
            return Err(format!(
                "A troca foi desfeita porque a cópia temporária não pôde ser apagada: {error}"
            ));
        }
    }
    Ok(true)
}

pub fn cancel_database_import(data_dir: &Path) -> Result<(), String> {
    for name in [PENDING_IMPORT_FILE, STAGING_IMPORT_FILE] {
        let path = data_dir.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn write_database_import_result(data_dir: &Path, result: &DatabaseImportResult) {
    if let Ok(json) = serde_json::to_vec(result) {
        let _ = fs::write(data_dir.join(IMPORT_RESULT_FILE), json);
    }
}

pub fn take_database_import_result(data_dir: &Path) -> Result<Option<DatabaseImportResult>, String> {
    let path = data_dir.join(IMPORT_RESULT_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let result = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(result))
}

pub fn clear_database_import_result(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(IMPORT_RESULT_FILE);
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
