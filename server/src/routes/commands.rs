//! The desktop's file-handling Tauri commands (src-tauri/src/commands.rs),
//! as RPC endpoints with the same names `src/lib/api.ts` uses. Same logic,
//! with two web-specific rules:
//! - every path from the browser goes through `files::resolve`;
//! - blocking work (Poppler, spreadsheet parsing, file copies) runs on the
//!   blocking thread pool, off the async runtime.

use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::domain::model::{FileHash, ParsedTimesheet};
use crate::domain::report_zip::ReportZipEntry;
use crate::domain::{file_author, hashing, parsers, pdf_extract, report_zip, spreadsheet};
use crate::error::{ApiError, ApiResult};
use crate::files::{imports_dir, resolve, uploads_dir};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listProviders", post(list_providers))
        .route("/rpc/hashFiles", post(hash_files))
        .route("/rpc/parseImport", post(parse_import))
        .route("/rpc/listSpreadsheetSheets", post(list_spreadsheet_sheets))
        .route("/rpc/previewSpreadsheet", post(preview_spreadsheet))
        .route("/rpc/applyPaymentTemplate", post(apply_payment_template))
        .route("/rpc/hashPaymentFile", post(hash_payment_file))
        .route("/rpc/readSpreadsheetAuthor", post(read_spreadsheet_author))
        .route("/rpc/downloadPaymentFileFromUrl", post(download_payment_file_from_url))
        .route("/rpc/checkRemotePaymentFile", post(check_remote_payment_file))
        .route("/rpc/generateReportZip", post(generate_report_zip))
}

/// Runs blocking file/Poppler work off the async runtime; `Err(String)` from
/// the desktop code becomes a 400 with that message, as the desktop showed it.
async fn blocking<T, F>(work: F) -> ApiResult<T>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .map_err(ApiError::BadRequest)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn resolve_all(state: &AppState, paths: &[String]) -> ApiResult<Vec<String>> {
    paths.iter().map(|p| resolve(&state.data_dir, p).map(|r| path_string(&r))).collect()
}

// --- timesheet PDFs ---------------------------------------------------------

#[derive(Serialize)]
struct ProviderInfo {
    id: String,
    label: String,
}

async fn list_providers() -> Json<Vec<ProviderInfo>> {
    Json(
        parsers::providers()
            .into_iter()
            .map(|(id, label)| ProviderInfo { id: id.to_owned(), label: label.to_owned() })
            .collect(),
    )
}

#[derive(Deserialize)]
struct PathsArgs {
    paths: Vec<String>,
}

/// Content hash + page count per file, so the frontend can spot an
/// already-imported PDF (even renamed) before parsing anything.
async fn hash_files(State(state): State<AppState>, Json(args): Json<PathsArgs>) -> ApiResult<Json<Vec<FileHash>>> {
    let paths = resolve_all(&state, &args.paths)?;
    let hashes = blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let hash = hashing::hash_file(&path).map_err(|e| e.to_string())?;
                let file_name = hashing::file_name(&path);
                let page_count = hashing::page_count(&path, None)?;
                Ok(FileHash { path, file_name, hash, page_count })
            })
            .collect()
    })
    .await?;
    Ok(Json(hashes))
}

/// Outcome of parsing one source file — see the desktop's `FileParseResult`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileParseResult {
    path: String,
    file_name: String,
    file_hash: String,
    page_count: u32,
    original_pdf_path: String,
    sheets: Vec<ParsedTimesheet>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ParseImportArgs {
    provider: String,
    paths: Vec<String>,
}

/// Extracts text from each PDF and hands it to the chosen parser. Each
/// resulting timesheet's own page is copied into `imports/` (the whole batch
/// file is never kept). One bad file or page doesn't fail the others.
async fn parse_import(State(state): State<AppState>, Json(args): Json<ParseImportArgs>) -> ApiResult<Json<Vec<FileParseResult>>> {
    if parsers::get_parser(&args.provider).is_none() {
        return Err(ApiError::BadRequest(format!("unknown provider '{}'", args.provider)));
    }
    let paths = resolve_all(&state, &args.paths)?;
    let imports = imports_dir(&state.data_dir);
    let provider = args.provider;
    let results = blocking(move || {
        let parser = parsers::get_parser(&provider).ok_or_else(|| format!("unknown provider '{provider}'"))?;
        fs::create_dir_all(&imports).map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for source_path in paths {
            let file_name = hashing::file_name(&source_path);
            let file_hash = match hashing::hash_file(&source_path) {
                Ok(h) => h,
                Err(e) => {
                    results.push(failed(source_path, file_name, String::new(), e.to_string()));
                    continue;
                }
            };
            let page_count = match hashing::page_count(&source_path, None) {
                Ok(n) => n,
                Err(e) => {
                    results.push(failed(source_path, file_name, file_hash, e));
                    continue;
                }
            };
            let (sheets, error) = if page_count <= 1 {
                match parse_single_page(&source_path, &file_name, &file_hash, &imports, parser.as_ref()) {
                    Ok(sheets) => (sheets, None),
                    Err(e) => (Vec::new(), Some(e)),
                }
            } else {
                parse_multi_page(&source_path, &file_name, parser.as_ref(), &imports)
            };
            results.push(FileParseResult {
                path: source_path,
                file_name,
                file_hash,
                page_count,
                original_pdf_path: String::new(),
                sheets,
                error,
            });
        }
        Ok(results)
    })
    .await?;
    Ok(Json(results))
}

fn failed(path: String, file_name: String, file_hash: String, error: String) -> FileParseResult {
    FileParseResult { path, file_name, file_hash, page_count: 0, original_pdf_path: String::new(), sheets: Vec::new(), error: Some(error) }
}

fn parse_single_page(
    source_path: &str,
    file_name: &str,
    file_hash: &str,
    imports: &Path,
    parser: &dyn parsers::TimesheetParser,
) -> Result<Vec<ParsedTimesheet>, String> {
    let raw_text = pdf_extract::extract_text(source_path, None).map_err(|e| e.to_string())?;
    let dest = copy_into_imports(source_path, imports)?;
    let mut parsed = parser.parse(&raw_text, &dest).map_err(|e| e.to_string())?;
    for sheet in &mut parsed {
        sheet.original_file_hash = file_hash.to_owned();
        sheet.original_file_name = file_name.to_owned();
    }
    Ok(parsed)
}

fn parse_multi_page(
    source_path: &str,
    file_name: &str,
    parser: &dyn parsers::TimesheetParser,
    imports: &Path,
) -> (Vec<ParsedTimesheet>, Option<String>) {
    let temp_dir = imports.join(format!("split-{}", uuid::Uuid::new_v4()));
    if let Err(e) = fs::create_dir_all(&temp_dir) {
        return (Vec::new(), Some(e.to_string()));
    }
    let page_paths = match pdf_extract::split_pages(source_path, &temp_dir, None) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return (Vec::new(), Some(e.to_string()));
        }
    };

    let mut all_sheets = Vec::new();
    let mut page_errors = Vec::new();
    for (i, page_path) in page_paths.iter().enumerate() {
        let page_path = path_string(page_path);
        let outcome = (|| -> Result<Vec<ParsedTimesheet>, String> {
            let raw_text = pdf_extract::extract_text(&page_path, None).map_err(|e| e.to_string())?;
            let page_hash = hashing::hash_file(&page_path).map_err(|e| e.to_string())?;
            let dest = copy_into_imports(&page_path, imports)?;
            let mut sheets = parser.parse(&raw_text, &dest).map_err(|e| e.to_string())?;
            for sheet in &mut sheets {
                sheet.original_file_hash = page_hash.clone();
                sheet.original_file_name = format!("{file_name} — página {}", i + 1);
            }
            Ok(sheets)
        })();
        match outcome {
            Ok(sheets) => all_sheets.extend(sheets),
            Err(e) => page_errors.push(format!("página {}: {e}", i + 1)),
        }
    }
    let _ = fs::remove_dir_all(&temp_dir);
    let error = (!page_errors.is_empty()).then(|| page_errors.join("; "));
    (all_sheets, error)
}

fn copy_into_imports(source_path: &str, imports: &Path) -> Result<String, String> {
    let dest: PathBuf = imports.join(format!("{}.pdf", uuid::Uuid::new_v4()));
    fs::copy(source_path, &dest).map_err(|e| e.to_string())?;
    Ok(path_string(&dest))
}

#[derive(Deserialize)]
struct ReportZipArgs {
    entries: Vec<ReportZipEntry>,
}

#[derive(Serialize)]
struct GeneratedFile {
    path: String,
}

/// Builds the Relatórios ZIP on the server and returns its path; the
/// browser then downloads it (`downloadServerFile`). The file lives under
/// `uploads/`, so it is cleaned up after a day.
async fn generate_report_zip(State(state): State<AppState>, Json(args): Json<ReportZipArgs>) -> ApiResult<Json<GeneratedFile>> {
    let mut entries = args.entries;
    for entry in &mut entries {
        entry.source_pdf_paths = resolve_all(&state, &entry.source_pdf_paths)?;
        if Path::new(&entry.zip_path).components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(ApiError::BadRequest(format!("Caminho inválido dentro do ZIP: {}", entry.zip_path)));
        }
    }
    let dir = uploads_dir(&state.data_dir).join(uuid::Uuid::new_v4().to_string());
    let dest = dir.join("relatorio.zip");
    let dest_string = path_string(&dest);
    blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        report_zip::build(&entries, &dest_string, None)
    })
    .await?;
    Ok(Json(GeneratedFile { path: path_string(&dest) }))
}

// --- payment spreadsheets ---------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct PathArgs {
    path: String,
}

async fn list_spreadsheet_sheets(State(state): State<AppState>, Json(args): Json<PathArgs>) -> ApiResult<Json<Vec<String>>> {
    let path = path_string(&resolve(&state.data_dir, &args.path)?);
    Ok(Json(blocking(move || spreadsheet::list_sheets(&path)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewArgs {
    path: String,
    sheet: Option<String>,
    delimiter: Option<String>,
    max_rows: u32,
}

async fn preview_spreadsheet(State(state): State<AppState>, Json(args): Json<PreviewArgs>) -> ApiResult<Json<spreadsheet::SpreadsheetPreview>> {
    let path = path_string(&resolve(&state.data_dir, &args.path)?);
    let preview = blocking(move || spreadsheet::preview(&path, args.sheet.as_deref(), args.delimiter.as_deref(), args.max_rows)).await?;
    Ok(Json(preview))
}

#[derive(Deserialize)]
pub(crate) struct ApplyTemplateArgs {
    path: String,
    groups: Vec<spreadsheet::GroupSpec>,
    delimiter: Option<String>,
}

pub(crate) async fn apply_payment_template(
    State(state): State<AppState>,
    Json(args): Json<ApplyTemplateArgs>,
) -> ApiResult<Json<Vec<spreadsheet::AppliedPaymentRow>>> {
    let path = path_string(&resolve(&state.data_dir, &args.path)?);
    let rows = blocking(move || spreadsheet::apply_template(&path, &args.groups, args.delimiter.as_deref())).await?;
    Ok(Json(rows))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaymentFileHash {
    path: String,
    file_name: String,
    hash: String,
}

pub(crate) async fn hash_payment_file(State(state): State<AppState>, Json(args): Json<PathArgs>) -> ApiResult<Json<PaymentFileHash>> {
    let path = path_string(&resolve(&state.data_dir, &args.path)?);
    let hashed = blocking(move || {
        let hash = hashing::hash_file(&path).map_err(|e| e.to_string())?;
        let file_name = hashing::file_name(&path);
        Ok(PaymentFileHash { path, file_name, hash })
    })
    .await?;
    Ok(Json(hashed))
}

pub(crate) async fn read_spreadsheet_author(State(state): State<AppState>, Json(args): Json<PathArgs>) -> ApiResult<Json<file_author::FileAuthor>> {
    let path = path_string(&resolve(&state.data_dir, &args.path)?);
    Ok(Json(blocking(move || Ok(file_author::read(&path))).await?))
}

// --- spreadsheets by URL ----------------------------------------------------

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const HEAD_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;

/// The server fetches URLs typed by users, so it must not be steerable at
/// itself or its network (the VM's metadata server holds its credentials):
/// loopback, private, link-local and similar addresses are refused.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))) // CGNAT
        }
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg0 & 0xfe00) == 0xfc00 // unique local
                || (seg0 & 0xffc0) == 0xfe80 // link local
                || v6.to_ipv4_mapped().is_some_and(|v4| !is_public_ip(IpAddr::V4(v4))))
        }
    }
}

fn host_is_obviously_internal(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => !is_public_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => !is_public_ip(IpAddr::V6(ip)),
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost") || name.ends_with(".internal") || name.ends_with(".local")
        }
        None => true,
    }
}

async fn ensure_public_destination(url: &reqwest::Url) -> ApiResult<()> {
    let refused = || ApiError::BadRequest("Esse endereço não pode ser acessado pelo servidor.".into());
    if host_is_obviously_internal(url) {
        return Err(refused());
    }
    let host = url.host_str().ok_or_else(refused)?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port)).await.map_err(|_| ApiError::BadRequest("Não foi possível encontrar esse endereço.".into()))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if !is_public_ip(addr.ip()) {
            return Err(refused());
        }
    }
    if any { Ok(()) } else { Err(refused()) }
}

fn build_http_client(timeout: Duration) -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        // Each hop is checked against obviously-internal hosts; the first
        // hop's DNS answer is checked in `ensure_public_destination`.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("muitos redirecionamentos")
            } else if host_is_obviously_internal(attempt.url()) {
                attempt.error("redirecionamento para endereço interno recusado")
            } else {
                attempt.follow()
            }
        }))
        .user_agent(concat!("tapago/", env!("CARGO_PKG_VERSION")))
        // OneDrive/SharePoint anonymous links set a cookie mid-redirect and
        // expect it back on the next hop.
        .cookie_store(true)
        .build()
        .map_err(|e| ApiError::Internal(e.to_string()))
}

fn parse_http_url(url: &str) -> ApiResult<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).map_err(|_| ApiError::BadRequest("URL inválida.".into()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::BadRequest("A URL deve começar com http:// ou https://.".into()));
    }
    Ok(parsed)
}

/// OneDrive/SharePoint "anyone with the link" shares open the Office viewer
/// unless `download=1` is present; only Microsoft hosts are rewritten.
fn normalize_office_share_url(url: &reqwest::Url) -> reqwest::Url {
    let host = url.host_str().unwrap_or("");
    let is_ms_share_host = host == "1drv.ms" || host == "onedrive.live.com" || host.ends_with(".sharepoint.com");
    if !is_ms_share_host || url.query_pairs().any(|(k, _)| k == "download") {
        return url.clone();
    }
    let mut normalized = url.clone();
    normalized.query_pairs_mut().append_pair("download", "1");
    normalized
}

fn header_str(headers: &reqwest::header::HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

fn filename_from_content_disposition(header: Option<&str>) -> Option<String> {
    for part in header?.split(';') {
        let part = part.trim();
        let is_rfc5987 = part.starts_with("filename*=");
        let Some(value) = part
            .strip_prefix("filename*=")
            .map(|v| v.trim_start_matches("UTF-8''").trim_start_matches("utf-8''"))
            .or_else(|| part.strip_prefix("filename="))
        else {
            continue;
        };
        let cleaned = value.trim_matches('"').trim();
        if !cleaned.is_empty() {
            return Some(if is_rfc5987 { percent_decode(cleaned) } else { cleaned.to_owned() });
        }
    }
    None
}

fn filename_from_url(url: &reqwest::Url) -> Option<String> {
    let last = url.path_segments()?.next_back()?;
    (!last.trim().is_empty()).then(|| percent_decode(last))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedPaymentFile {
    path: String,
    file_name: String,
    file_kind: String,
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct UrlArgs {
    url: String,
}

/// Downloads a spreadsheet from a direct-download link, checks by magic
/// bytes that it really is xlsx/xls/ods, and stores it in `imports/`.
pub(crate) async fn download_payment_file_from_url(State(state): State<AppState>, Json(args): Json<UrlArgs>) -> ApiResult<Json<DownloadedPaymentFile>> {
    let parsed = normalize_office_share_url(&parse_http_url(&args.url)?);
    ensure_public_destination(&parsed).await?;
    let client = build_http_client(DOWNLOAD_TIMEOUT)?;
    let mut response = client.get(parsed).send().await.map_err(|e| ApiError::BadRequest(format!("Falha ao baixar o arquivo: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::BadRequest(format!("O servidor retornou o status {}.", response.status())));
    }

    let etag = header_str(response.headers(), reqwest::header::ETAG);
    let last_modified = header_str(response.headers(), reqwest::header::LAST_MODIFIED);
    let content_disposition = header_str(response.headers(), reqwest::header::CONTENT_DISPOSITION);
    let content_length = response.content_length().map(|n| n as i64);
    let final_url = response.url().clone();

    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| ApiError::BadRequest(format!("Falha ao baixar o arquivo: {e}")))? {
        if bytes.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            return Err(ApiError::BadRequest("O arquivo é grande demais (limite de 100 MB).".into()));
        }
        bytes.extend_from_slice(&chunk);
    }

    let kind = if infer::doc::is_xlsx(&bytes) {
        "xlsx"
    } else if infer::doc::is_xls(&bytes) {
        "xls"
    } else if infer::odf::is_ods(&bytes) {
        "ods"
    } else {
        return Err(ApiError::BadRequest(
            "O link não retornou um arquivo do Microsoft Office (.xlsx/.xls) ou OpenDocument \
             (.ods) válido. Verifique se a URL exige login ou não é um link de download direto."
                .into(),
        ));
    };

    let imports = imports_dir(&state.data_dir);
    let dest = imports.join(format!("{}.{kind}", uuid::Uuid::new_v4()));
    let dest_for_write = dest.clone();
    blocking(move || {
        fs::create_dir_all(&imports).map_err(|e| e.to_string())?;
        fs::write(&dest_for_write, &bytes).map_err(|e| e.to_string())
    })
    .await?;

    let file_name = filename_from_content_disposition(content_disposition.as_deref())
        .or_else(|| filename_from_url(&final_url))
        .unwrap_or_else(|| format!("download.{kind}"));

    Ok(Json(DownloadedPaymentFile {
        path: path_string(&dest),
        file_name,
        file_kind: kind.to_owned(),
        etag,
        last_modified,
        content_length,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFileSignature {
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RemoteChangeCheck {
    changed: Option<bool>,
    current: RemoteFileSignature,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteCheckArgs {
    url: String,
    known_etag: Option<String>,
    known_last_modified: Option<String>,
    known_content_length: Option<i64>,
}

/// HEAD-based "did the remote file change": ETag when both sides have one,
/// then Last-Modified, then Content-Length; `None` = no comparable signal.
pub(crate) async fn check_remote_payment_file(Json(args): Json<RemoteCheckArgs>) -> ApiResult<Json<RemoteChangeCheck>> {
    let parsed = normalize_office_share_url(&parse_http_url(&args.url)?);
    ensure_public_destination(&parsed).await?;
    let client = build_http_client(HEAD_TIMEOUT)?;
    let response = client
        .head(parsed)
        .send()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Falha ao verificar o arquivo remoto: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::BadRequest(format!("O servidor retornou o status {}.", response.status())));
    }
    let etag = header_str(response.headers(), reqwest::header::ETAG);
    let last_modified = header_str(response.headers(), reqwest::header::LAST_MODIFIED);
    let content_length = response.content_length().map(|n| n as i64);
    let changed = if let (Some(k), Some(c)) = (&args.known_etag, &etag) {
        Some(k != c)
    } else if let (Some(k), Some(c)) = (&args.known_last_modified, &last_modified) {
        Some(k != c)
    } else if let (Some(k), Some(c)) = (args.known_content_length, content_length) {
        Some(k != c)
    } else {
        None
    };
    Ok(Json(RemoteChangeCheck { changed, current: RemoteFileSignature { etag, last_modified, content_length } }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_addresses_are_refused() {
        for url in [
            "http://127.0.0.1/x",
            "http://10.0.0.5/x",
            "http://169.254.169.254/computeMetadata/v1/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://localhost:8787/api",
            "http://[::1]/x",
            "http://192.168.0.1/x",
            "http://100.64.0.1/x",
        ] {
            assert!(host_is_obviously_internal(&reqwest::Url::parse(url).unwrap()), "{url}");
        }
        assert!(!host_is_obviously_internal(&reqwest::Url::parse("https://1drv.ms/x/abc").unwrap()));
    }

    #[tokio::test]
    async fn download_rejects_internal_targets_before_connecting() {
        let state = AppState::for_tests().await;
        let err = download_payment_file_from_url(State(state), Json(UrlArgs { url: "http://169.254.169.254/".into() }))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Esse endereço não pode ser acessado pelo servidor.");
    }

    #[test]
    fn office_links_get_download_1_and_others_are_untouched() {
        let ms = normalize_office_share_url(&reqwest::Url::parse("https://1drv.ms/x/s!abc").unwrap());
        assert!(ms.as_str().ends_with("download=1"));
        let other = normalize_office_share_url(&reqwest::Url::parse("https://exemplo.com/a.xlsx").unwrap());
        assert_eq!(other.as_str(), "https://exemplo.com/a.xlsx");
    }

    #[test]
    fn filename_parsing_matches_the_desktop() {
        assert_eq!(filename_from_content_disposition(Some("attachment; filename=\"Folha.xlsx\"")).as_deref(), Some("Folha.xlsx"));
        assert_eq!(filename_from_content_disposition(Some("attachment; filename*=UTF-8''Mar%C3%A7o.xlsx")).as_deref(), Some("Março.xlsx"));
        assert_eq!(filename_from_content_disposition(Some("inline")), None);
    }

    #[tokio::test]
    async fn parse_import_refuses_paths_outside_the_data_dir() {
        let state = AppState::for_tests().await;
        let err = parse_import(State(state), Json(ParseImportArgs { provider: "coalize".into(), paths: vec!["/etc/passwd".into()] }))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::NotFound(_)));
    }
}
