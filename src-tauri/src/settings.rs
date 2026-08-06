use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// App-wide preferences, persisted as a small JSON file in the app data dir
/// rather than SQLite — this isn't business data, and a single-file
/// read/write is simpler than a migration for one column.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Manual override for where to find the Poppler CLI tools, set from
    /// Configurações when auto-detection (see `crate::poppler::resolve`)
    /// doesn't find them — e.g. a non-Homebrew install.
    pub poppler_dir: Option<String>,

    /// Last few sample file paths picked in the payment template wizard's
    /// "Arquivo" step — a quick "pick this again" shortcut. Only the path
    /// is kept, not the file itself (the wizard never persists that).
    /// Newest first. `#[serde(default)]` so existing settings.json files
    /// from before this field existed still parse.
    #[serde(default)]
    pub recent_payment_files: Vec<String>,

    /// How often (in minutes) Importar Pagamentos re-checks whether a
    /// URL-sourced payment file has changed on the server since it was
    /// last imported — user-editable in Configurações, default 5. The app
    /// version's own update check is a separate, fixed 30-minute interval
    /// (not user-editable, not stored here).
    #[serde(default = "default_remote_file_check_interval_minutes")]
    pub remote_file_check_interval_minutes: u32,
}

fn default_remote_file_check_interval_minutes() -> u32 {
    5
}

// Written by hand instead of `#[derive(Default)]` — the derive would give
// `remote_file_check_interval_minutes` a bare `0` (u32's own Default),
// ignoring `default_remote_file_check_interval_minutes` entirely, since
// that serde attribute only applies during deserialization, not to the
// `Default` trait. `load()`'s `.unwrap_or_default()` (no settings.json yet)
// needs the real default here too, not just when the field is merely
// absent from an existing file.
impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            poppler_dir: None,
            recent_payment_files: Vec::new(),
            remote_file_check_interval_minutes: default_remote_file_check_interval_minutes(),
        }
    }
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
