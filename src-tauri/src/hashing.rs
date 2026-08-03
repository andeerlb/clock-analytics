use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

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
