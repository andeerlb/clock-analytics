use crate::model::ParseError;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Extracts raw text from a PDF file using `pdftotext -layout` (Poppler).
///
/// `-layout` reconstructs each line from the *visual* (x/y) position of the
/// text on the page, rather than the order text objects happen to appear in
/// the PDF's content stream. Without it, two pages from the same export can
/// come out with a completely different reading order — one page listed
/// dates and times inline per row, another listed every date first and
/// every time value afterward, silently breaking the one-line-per-day
/// assumption the Coalize parser depends on (0 days parsed, no error).
/// `-layout` is slower but the line structure it produces is stable
/// regardless of how the source PDF was generated.
///
/// NOTE: for distribution across Linux/macOS/Windows, `pdftotext` needs to
/// be bundled as a Tauri sidecar binary per platform rather than relying on
/// a system install. This wrapper is the single seam that would change.
pub fn extract_text(pdf_path: &str) -> Result<String, ParseError> {
    let output = Command::new("pdftotext")
        .arg("-layout")
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

/// Splits a PDF into one single-page PDF per page, written into `out_dir`,
/// via `pdfseparate` (Poppler). Used when a source file holds more than one
/// employee's timesheet — one page per person. `out_dir` must be empty/
/// exclusive to this call so the numbered output files can be collected
/// unambiguously.
pub fn split_pages(pdf_path: &str, out_dir: &Path) -> Result<Vec<PathBuf>, ParseError> {
    let pattern = out_dir.join("page-%d.pdf");
    let output = Command::new("pdfseparate")
        .arg(pdf_path)
        .arg(&pattern)
        .output()
        .map_err(|e| ParseError::ExtractionFailed(format!("failed to spawn pdfseparate: {e}")))?;

    if !output.status.success() {
        return Err(ParseError::ExtractionFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    let mut pages: Vec<(u32, PathBuf)> = std::fs::read_dir(out_dir)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            let n: u32 = stem.strip_prefix("page-")?.parse().ok()?;
            Some((n, path))
        })
        .collect();
    pages.sort_by_key(|(n, _)| *n);

    Ok(pages.into_iter().map(|(_, p)| p).collect())
}
