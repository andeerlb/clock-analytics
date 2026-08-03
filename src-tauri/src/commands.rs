use crate::model::ParsedTimesheet;
use crate::parsers;
use crate::pdf_extract;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
pub struct ProviderInfo {
    id: String,
    label: String,
}

#[tauri::command]
pub fn list_providers() -> Vec<ProviderInfo> {
    parsers::providers()
        .into_iter()
        .map(|(id, label)| ProviderInfo {
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect()
}

/// Extracts text from each source PDF, hands it to the chosen provider's
/// parser, and copies the original file into the app's data dir so it stays
/// browsable later ("ver relatório original") independent of where the user
/// picked it from on disk.
///
/// Persisting the parsed result into SQLite is left to the frontend (via
/// `@tauri-apps/plugin-sql`) once it has a result it's happy with — this
/// command only turns files into structured, previewable data.
#[tauri::command]
pub fn parse_import(
    app: AppHandle,
    provider: String,
    paths: Vec<String>,
) -> Result<Vec<ParsedTimesheet>, String> {
    let parser = parsers::get_parser(&provider).ok_or_else(|| format!("unknown provider '{provider}'"))?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let imports_dir = data_dir.join("imports");
    fs::create_dir_all(&imports_dir).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for source_path in paths {
        let raw_text = pdf_extract::extract_text(&source_path).map_err(|e| e.to_string())?;

        let file_id = uuid::Uuid::new_v4();
        let dest: PathBuf = imports_dir.join(format!("{file_id}.pdf"));
        fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
        let dest_str = dest.to_string_lossy().to_string();

        let parsed = parser
            .parse(&raw_text, &dest_str)
            .map_err(|e| e.to_string())?;
        results.extend(parsed);
    }

    Ok(results)
}

#[tauri::command]
pub fn open_original_pdf(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}
