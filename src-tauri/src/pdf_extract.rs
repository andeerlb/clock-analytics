use crate::model::ParseError;
use std::process::Command;

/// Extracts raw text from a PDF file using `pdftotext` (Poppler), in
/// reading order (no `-layout`), which is what the Coalize parser expects.
///
/// NOTE: for distribution across Linux/macOS/Windows, `pdftotext` needs to
/// be bundled as a Tauri sidecar binary per platform rather than relying on
/// a system install. This wrapper is the single seam that would change.
pub fn extract_text(pdf_path: &str) -> Result<String, ParseError> {
    let output = Command::new("pdftotext")
        .arg(pdf_path)
        .arg("-") // write to stdout
        .output()
        .map_err(|e| ParseError::ExtractionFailed(format!("failed to spawn pdftotext: {e}")))?;

    if !output.status.success() {
        return Err(ParseError::ExtractionFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
