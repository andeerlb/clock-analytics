use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Disk usage of everything the app itself created — the DB (plus its WAL/
/// SHM sidecars, which hold real data until checkpointed), the copied PDFs
/// under `imports/`, and the copied payment-template sample files under
/// `payment_templates/`. Powers the storage indicator in Configurações.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub db_bytes: u64,
    pub imports_bytes: u64,
    pub imports_file_count: u64,
    pub payment_templates_bytes: u64,
    pub payment_templates_file_count: u64,
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
    let (payment_templates_bytes, payment_templates_file_count) =
        dir_size(&data_dir.join("payment_templates"));

    StorageUsage {
        db_bytes,
        imports_bytes,
        imports_file_count,
        payment_templates_bytes,
        payment_templates_file_count,
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
/// whole `imports/` and `payment_templates/` trees — an escape hatch to
/// save a copy before "Limpar tudo" wipes everything, since this app keeps
/// the only copy of its data. `include_db`/`include_files` let the caller
/// back up just one side (e.g. only the database, skipping the potentially
/// much larger PDF files) instead of always bundling both.
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

        let payment_templates_dir = data_dir.join("payment_templates");
        if payment_templates_dir.exists() {
            add_dir_to_zip(
                &mut zip,
                &payment_templates_dir,
                &payment_templates_dir,
                "payment_templates",
                options,
            )?;
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
