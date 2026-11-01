use sqlx::sqlite::{Sqlite, SqliteConnectOptions};
use sqlx::{Connection, Executor, Row, SqliteConnection};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{DbInstances, DbPool};

const BACKUP_DIR: &str = "backups";
const MIGRATION_BACKUP_PREFIX: &str = "pontoscan-antes-da-migracao-";
const DELETE_BACKUP_PREFIX: &str = "pontoscan-antes-de-excluir-";
/// Older backups of each kind past this many are deleted, oldest first.
const BACKUPS_TO_KEEP: usize = 5;

/// `backups/<prefix><timestamp>[-<label>].db` — the timestamp right after
/// the prefix keeps each kind's files sorting chronologically by name.
fn backup_path(data_dir: &Path, prefix: &str, label: Option<&str>) -> Result<PathBuf, String> {
    let dir = data_dir.join(BACKUP_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut name = format!("{prefix}{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    if let Some(label) = label.map(file_name_label).filter(|l| !l.is_empty()) {
        name.push('-');
        name.push_str(&label);
    }
    Ok(dir.join(format!("{name}.db")))
}

/// Lowercased letters/digits of `label` with everything else collapsed to
/// single dashes, capped in length — safe inside a file name on every OS.
fn file_name_label(label: &str) -> String {
    let mut out = String::new();
    for c in label.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect::<String>().trim_end_matches('-').to_string()
}

/// `VACUUM INTO` (unlike copying the file) also captures whatever is still
/// sitting in the `-wal` sidecar, as one consistent snapshot.
async fn vacuum_into<'e, E: Executor<'e, Database = Sqlite>>(executor: E, dest: &Path) -> Result<(), String> {
    sqlx::query("VACUUM INTO $1")
        .bind(dest.to_string_lossy().into_owned())
        .execute(executor)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Snapshots `pontoscan.db` into `backups/` when it has migrations still to
/// apply — several of them rebuild whole tables (DROP + recreate), and the
/// database is the only copy of the user's data. Must run before the SQL
/// plugin opens its pool, since that's what applies the migrations.
///
/// Returns the backup's path, or `None` when there was nothing to protect:
/// no database yet (a fresh install), or every migration already applied.
pub async fn backup_if_migrations_pending(data_dir: &Path, known_versions: &[i64]) -> Result<Option<PathBuf>, String> {
    let db_path = data_dir.join("pontoscan.db");
    if !db_path.exists() {
        return Ok(None);
    }

    let options = SqliteConnectOptions::new().filename(&db_path).create_if_missing(false);
    let mut conn = SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
    let result = snapshot_if_pending(&mut conn, data_dir, known_versions).await;
    conn.close().await.map_err(|e| e.to_string())?;
    let backup = result?;

    if backup.is_some() {
        prune_old_backups(&data_dir.join(BACKUP_DIR), MIGRATION_BACKUP_PREFIX);
    }
    Ok(backup)
}

async fn snapshot_if_pending(
    conn: &mut SqliteConnection,
    data_dir: &Path,
    known_versions: &[i64],
) -> Result<Option<PathBuf>, String> {
    let has_migrations_table = sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .is_some();
    let applied: Vec<i64> = if has_migrations_table {
        sqlx::query("SELECT version FROM _sqlx_migrations WHERE success = 1")
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|row| row.get::<i64, _>(0))
            .collect()
    } else {
        Vec::new()
    };
    if known_versions.iter().all(|v| applied.contains(v)) {
        return Ok(None);
    }

    let dest = backup_path(data_dir, MIGRATION_BACKUP_PREFIX, None)?;
    vacuum_into(&mut *conn, &dest).await?;
    Ok(Some(dest))
}

/// Snapshots the open database into `backups/` right before an
/// irreversible delete the user forced through ("Excluir mesmo assim" on a
/// colaborador with payments) — `label` (e.g. the colaborador's name) goes
/// into the file name so the right backup is easy to find later. Returns
/// the backup's path.
#[tauri::command]
pub async fn backup_database_before_delete(
    app: AppHandle,
    db_instances: State<'_, DbInstances>,
    label: String,
) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get(crate::db::DB_URL) {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("Banco de dados não carregado.".into()),
    };
    let dest = backup_path(&data_dir, DELETE_BACKUP_PREFIX, Some(&label))?;
    vacuum_into(pool, &dest).await?;
    prune_old_backups(&data_dir.join(BACKUP_DIR), DELETE_BACKUP_PREFIX);
    Ok(dest.to_string_lossy().into_owned())
}

fn prune_old_backups(dir: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix)))
        .collect();
    // The timestamp in the name sorts chronologically.
    backups.sort();
    let excess = backups.len().saturating_sub(BACKUPS_TO_KEEP);
    for path in &backups[..excess] {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pontoscan-migration-backup-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn create_db(data_dir: &Path, applied: &[i64]) {
        let options = SqliteConnectOptions::new().filename(data_dir.join("pontoscan.db")).create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, success BOOLEAN NOT NULL)")
            .execute(&mut conn)
            .await
            .unwrap();
        for version in applied {
            sqlx::query("INSERT INTO _sqlx_migrations (version, success) VALUES ($1, 1)")
                .bind(version)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        conn.close().await.unwrap();
    }

    #[test]
    fn skips_a_fresh_install() {
        tauri::async_runtime::block_on(async {
            let dir = temp_data_dir("fresh");
            assert_eq!(backup_if_migrations_pending(&dir, &[1, 2]).await.unwrap(), None);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn skips_when_every_migration_is_applied() {
        tauri::async_runtime::block_on(async {
            let dir = temp_data_dir("current");
            create_db(&dir, &[1, 2]).await;
            assert_eq!(backup_if_migrations_pending(&dir, &[1, 2]).await.unwrap(), None);
            assert!(!dir.join(BACKUP_DIR).exists());
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn snapshots_when_a_migration_is_pending() {
        tauri::async_runtime::block_on(async {
            let dir = temp_data_dir("pending");
            create_db(&dir, &[1]).await;
            let backup = backup_if_migrations_pending(&dir, &[1, 2]).await.unwrap().unwrap();

            let options = SqliteConnectOptions::new().filename(&backup);
            let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(count, 1);
            conn.close().await.unwrap();
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn keeps_only_the_newest_backups() {
        let dir = temp_data_dir("prune");
        let backups = dir.join(BACKUP_DIR);
        fs::create_dir_all(&backups).unwrap();
        for day in 1..=7 {
            fs::write(backups.join(format!("{MIGRATION_BACKUP_PREFIX}2026010{day}-000000.db")), b"").unwrap();
        }
        fs::write(backups.join("outro-arquivo.db"), b"").unwrap();
        fs::write(backups.join(format!("{DELETE_BACKUP_PREFIX}20260101-000000-joao.db")), b"").unwrap();

        prune_old_backups(&backups, MIGRATION_BACKUP_PREFIX);

        let mut left: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        // Only this prefix's own files are pruned.
        assert_eq!(left.len(), BACKUPS_TO_KEEP + 2);
        assert!(left.contains(&"outro-arquivo.db".to_string()));
        assert!(left.iter().any(|n| n.starts_with(DELETE_BACKUP_PREFIX)));
        assert!(!left.iter().any(|n| n.starts_with(MIGRATION_BACKUP_PREFIX) && (n.contains("20260101") || n.contains("20260102"))));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_are_safe_in_file_names() {
        assert_eq!(file_name_label("  João da Silva / Filial 2 "), "joão-da-silva-filial-2");
        assert_eq!(file_name_label("../../etc"), "etc");
        assert_eq!(file_name_label("***"), "");
    }
}
