use std::path::PathBuf;

use tauri::{Manager, Runtime};
use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:pontoscan.db";

/// The folder `pontoscan.db` actually lives in: tauri-plugin-sql resolves
/// `DB_URL` (a relative path) against `app_config_dir`, so everything that
/// touches the database file directly (restore, export, backups, size) must
/// use this too, never `app_data_dir`. On Windows and macOS both are the
/// same folder; on Linux they aren't (~/.config vs ~/.local/share), which
/// used to make a restore write to a file the app never reads.
pub fn db_dir<R: Runtime, M: Manager<R>>(manager: &M) -> Result<PathBuf, String> {
    let dir = manager.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Builds the list from `migrations_list.rs`, shared with the web server.
macro_rules! migration_list {
    ($(($version:expr, $description:expr, $file:literal)),* $(,)?) => {
        vec![$(Migration {
            version: $version,
            description: $description,
            sql: include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations/", $file)),
            kind: MigrationKind::Up,
        }),*]
    };
}

pub fn migrations() -> Vec<Migration> {
    include!("migrations_list.rs")
}
