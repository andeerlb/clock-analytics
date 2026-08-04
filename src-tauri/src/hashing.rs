use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;

/// Content hash of a file, used to recognize a PDF that was already
/// imported even if it was picked from a different path or renamed.
pub fn hash_file(path: &str) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Number of pages in a PDF, via `pdfinfo` (Poppler) — cheap enough to run
/// on every file picked, before deciding whether it needs to be split into
/// one timesheet per page. `poppler_dir` is the user's manual override from
/// Configurações, if set — see `crate::poppler::resolve`.
pub fn page_count(path: &str, poppler_dir: Option<&str>) -> Result<u32, String> {
    let output = Command::new(crate::poppler::resolve("pdfinfo", poppler_dir))
        .arg(path)
        .output()
        .map_err(|e| format!("failed to spawn pdfinfo: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("Pages:"))
        .ok_or_else(|| "pdfinfo output missing 'Pages:' field".to_string())?
        .trim()
        .parse::<u32>()
        .map_err(|e| e.to_string())
}
