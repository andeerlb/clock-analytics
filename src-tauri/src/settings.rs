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

    /// "Minimizar na bandeja ao fechar" (Configurações) — when true, closing
    /// the main window hides it into the system tray instead of quitting,
    /// so the periodic remote-file checks (`RemoteFileUpdatesContext.tsx`)
    /// keep running in the background. Read fresh from disk on every close
    /// request (see `lib.rs`), not cached at startup, so toggling this
    /// takes effect immediately without restarting the app. Defaults to
    /// `true` — both for a brand-new install (`AppSettings::default()`
    /// below) and for a settings.json written before this field existed
    /// (`#[serde(default = "default_true")]`, since a bare `#[serde(default)]`
    /// on a `bool` would resolve to `bool::default()` = `false`, not this
    /// struct's own default).
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            poppler_dir: None,
            recent_payment_files: Vec::new(),
            close_to_tray: true,
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
