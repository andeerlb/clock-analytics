//! Files on the server. The desktop app passed local paths around
//! (`parseImport(paths)`, `readPdfBytes(path)`, …); the web version keeps
//! that shape, with paths that point into the server's data folder:
//!
//! - the browser uploads what the user picked → `POST /api/files/upload`
//!   saves each file as `<data>/uploads/<uuid>/<original name>` and returns
//!   those paths;
//! - the rest of the flow passes those paths to the endpoints that used to
//!   be Tauri commands, which copy what they keep into `<data>/imports/`;
//! - `GET /api/files/content?path=` serves a stored file back.
//!
//! Every path that comes from the browser goes through [`resolve`], which
//! refuses anything outside the data folder.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::error::{ApiError, ApiResult};
use crate::AppState;

/// Biggest single upload accepted (a multi-hundred-page timesheet PDF is
/// tens of MB).
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;
/// Uploads are working copies: whatever an import keeps is copied into
/// `imports/`, so anything older than this is safe to delete.
const UPLOAD_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/files/upload", post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)))
        .route("/files/content", get(content))
        .route("/files/list", post(list))
}

pub fn uploads_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("uploads")
}

/// Where imported files are kept for good (the desktop app's `imports/`).
pub fn imports_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("imports")
}

/// Turns a path received from the browser into a real file path, refusing
/// anything that resolves outside the data folder (`..`, symlinks, absolute
/// paths elsewhere) or that doesn't exist.
pub fn resolve(data_dir: &Path, path: &str) -> ApiResult<PathBuf> {
    let not_found = || ApiError::NotFound("Arquivo não encontrado no servidor.".into());
    let candidate = Path::new(path);
    let candidate = if candidate.is_absolute() { candidate.to_path_buf() } else { data_dir.join(candidate) };
    let real = candidate.canonicalize().map_err(|_| not_found())?;
    if !real.starts_with(data_dir) || !real.is_file() {
        return Err(not_found());
    }
    Ok(real)
}

/// The name a browser sent, reduced to a safe single path component.
fn safe_file_name(name: Option<&str>) -> String {
    let base = name.unwrap_or("").rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    match cleaned.as_str() {
        "" | "." | ".." => "arquivo".to_owned(),
        _ => cleaned,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedFile {
    /// Server path to hand to the other endpoints.
    pub path: String,
    pub file_name: String,
    pub size: u64,
}

/// All files of one request land in the same folder (so "Pasta inteira"
/// can list them back with `/files/list`); a repeated name gets " (2)", " (3)"…
async fn upload(State(state): State<AppState>, mut multipart: Multipart) -> ApiResult<Json<Vec<UploadedFile>>> {
    let bad = |e: axum::extract::multipart::MultipartError| ApiError::BadRequest(format!("Falha ao receber o arquivo: {e}"));
    let internal = |e: std::io::Error| ApiError::Internal(e.to_string());
    let dir = uploads_dir(&state.data_dir).join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir).await.map_err(internal)?;
    let mut saved: Vec<UploadedFile> = Vec::new();
    while let Some(mut field) = multipart.next_field().await.map_err(bad)? {
        let file_name = unique_name(&dir, &safe_file_name(field.file_name()));
        let path = dir.join(&file_name);
        let mut file = tokio::fs::File::create(&path).await.map_err(internal)?;
        let mut size = 0u64;
        while let Some(chunk) = field.chunk().await.map_err(bad)? {
            size += chunk.len() as u64;
            file.write_all(&chunk).await.map_err(internal)?;
        }
        file.flush().await.map_err(internal)?;
        saved.push(UploadedFile { path: path.to_string_lossy().into_owned(), file_name, size });
    }
    if saved.is_empty() {
        let _ = tokio::fs::remove_dir(&dir).await;
        return Err(ApiError::BadRequest("Nenhum arquivo enviado.".into()));
    }
    Ok(Json(saved))
}

fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_owned();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|n| format!("{stem} ({n}){ext}")).find(|candidate| !dir.join(candidate).exists()).unwrap()
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    dir: String,
    extensions: Vec<String>,
}

/// `listDirFiles`: files directly inside `dir` (a folder from an upload)
/// whose extension is one of `extensions` (no dot), sorted by name.
async fn list(State(state): State<AppState>, Json(query): Json<ListQuery>) -> ApiResult<Json<Vec<String>>> {
    let not_found = || ApiError::NotFound("Pasta não encontrada no servidor.".into());
    let candidate = Path::new(&query.dir);
    let candidate = if candidate.is_absolute() { candidate.to_path_buf() } else { state.data_dir.join(candidate) };
    let dir = candidate.canonicalize().map_err(|_| not_found())?;
    if !dir.starts_with(state.data_dir.as_path()) || !dir.is_dir() {
        return Err(not_found());
    }
    let wanted: Vec<String> = query.extensions.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect();
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|_| not_found())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension().and_then(|e| e.to_str()).is_some_and(|e| wanted.contains(&e.to_ascii_lowercase()))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    files.sort();
    Ok(Json(files))
}

#[derive(Debug, Deserialize)]
struct ContentQuery {
    path: String,
    /// When set, the browser is told to save the file under this name.
    download: Option<String>,
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("pdf") => "application/pdf",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xls") => "application/vnd.ms-excel",
        Some("csv") => "text/csv; charset=utf-8",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

async fn content(State(state): State<AppState>, Query(query): Query<ContentQuery>) -> ApiResult<Response> {
    let path = resolve(&state.data_dir, &query.path)?;
    let file = tokio::fs::File::open(&path).await.map_err(|_| ApiError::NotFound("Arquivo não encontrado no servidor.".into()))?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file));
    let mut response = (
        [(header::CONTENT_TYPE, content_type_for(&path)), (header::CACHE_CONTROL, "private, no-store")],
        body,
    )
        .into_response();
    if let Some(name) = query.download {
        let disposition = format!("attachment; filename*=UTF-8''{}", percent_encode(&safe_file_name(Some(&name))));
        if let Ok(value) = disposition.parse() {
            response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
        }
    }
    Ok(response)
}

/// RFC 5987 encoding for the download file name.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Deletes upload folders older than [`UPLOAD_TTL`], at startup and hourly.
pub fn spawn_upload_cleanup(data_dir: PathBuf) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            tick.tick().await;
            let dir = uploads_dir(&data_dir);
            let removed = tokio::task::spawn_blocking(move || remove_older_than(&dir, UPLOAD_TTL)).await.unwrap_or(0);
            if removed > 0 {
                tracing::info!(removed, "uploads antigos removidos");
            }
        }
    });
}

fn remove_older_than(dir: &Path, ttl: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > ttl);
        if old && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_refuses_paths_outside_the_data_dir() {
        let state = AppState::for_tests().await;
        let inside = state.data_dir.join("imports/a.pdf");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, b"%PDF").unwrap();

        assert_eq!(resolve(&state.data_dir, inside.to_str().unwrap()).unwrap(), inside);
        assert_eq!(resolve(&state.data_dir, "imports/a.pdf").unwrap(), inside);
        assert!(resolve(&state.data_dir, "/etc/passwd").is_err());
        assert!(resolve(&state.data_dir, "imports/../../../../etc/passwd").is_err());
        assert!(resolve(&state.data_dir, "imports/missing.pdf").is_err());
        assert!(resolve(&state.data_dir, "imports").is_err(), "a folder is not a file");
    }

    #[test]
    fn file_names_are_reduced_to_one_safe_component() {
        assert_eq!(safe_file_name(Some("../../etc/passwd")), "passwd");
        assert_eq!(safe_file_name(Some("C:\\Users\\a\\Espelho Março.pdf")), "Espelho Março.pdf");
        assert_eq!(safe_file_name(Some("..")), "arquivo");
        assert_eq!(safe_file_name(None), "arquivo");
    }
}
