use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::process::Command;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// One file to place inside the generated zip. `zip_path` is the full
/// relative path within the archive, folders and all (e.g.
/// "Empresa X/Cliente Y/Nome - jul-2026.pdf") — the grouping, naming, and
/// period formatting are all decided by the frontend, which already has the
/// company/client/employee names and locale-aware date formatting; this
/// side just moves bytes. A single source path is copied in as-is; more
/// than one means "one PDF per person, merge them into a single per-client
/// document" — done with `pdfunite` before the result is added to the zip.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportZipEntry {
    pub zip_path: String,
    pub source_pdf_paths: Vec<String>,
}

pub fn build(entries: &[ReportZipEntry], dest_zip_path: &str, poppler_dir: Option<&str>) -> Result<(), String> {
    let file = fs::File::create(dest_zip_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in entries {
        if entry.source_pdf_paths.is_empty() {
            continue;
        }

        let merged_tmp_path = if entry.source_pdf_paths.len() > 1 {
            Some(merge_pdfs(&entry.source_pdf_paths, poppler_dir)?)
        } else {
            None
        };
        let source_path = merged_tmp_path.as_deref().unwrap_or(&entry.source_pdf_paths[0]);

        let bytes = fs::read(source_path).map_err(|e| e.to_string())?;
        zip.start_file(&entry.zip_path, options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;

        if let Some(tmp) = merged_tmp_path {
            let _ = fs::remove_file(tmp);
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Concatenates several single-employee PDFs into one, via `pdfunite`
/// (Poppler) — same family as the `pdftotext`/`pdfseparate` calls already
/// used for parsing. Result is written to a temp file the caller is
/// responsible for cleaning up once it's been read.
fn merge_pdfs(paths: &[String], poppler_dir: Option<&str>) -> Result<String, String> {
    let out_path = std::env::temp_dir().join(format!("pontoscan-merged-{}.pdf", uuid::Uuid::new_v4()));
    let out_path_str = out_path.to_string_lossy().to_string();

    let output = Command::new(crate::poppler::resolve("pdfunite", poppler_dir))
        .args(paths)
        .arg(&out_path_str)
        .output()
        .map_err(|e| format!("failed to spawn pdfunite: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(out_path_str)
}
