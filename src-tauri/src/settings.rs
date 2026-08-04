use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// App-wide preferences, persisted as a small JSON file in the app data dir
/// rather than SQLite — this isn't business data, and a single-file
/// read/write is simpler than a migration for one column.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Manual override for where to find the Poppler CLI tools, set from
    /// Configurações when auto-detection (see `crate::poppler::resolve`)
    /// doesn't find them — e.g. a non-Homebrew install.
    pub poppler_dir: Option<String>,
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

pub fn load(data_dir: &Path) -> AppSettings {
    fs::read_to_string(settings_path(data_dir))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

pub fn save(data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(settings_path(data_dir), json).map_err(|e| e.to_string())
}
