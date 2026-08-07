use crate::hashing;
use crate::model::{FileHash, ParsedTimesheet};
use crate::parsers;
use crate::pdf_extract;
use crate::poppler;
use crate::report_zip::{self, ReportZipEntry};
use crate::settings::{self, AppSettings};
use crate::spreadsheet;
use crate::storage::{self, StorageUsage};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
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

/// Content-hashes and page-counts each file so the frontend can check,
/// before doing any parsing, whether a picked PDF was already imported
/// (even if it was renamed or picked from a different folder) — and
/// whether it's a single timesheet or a multi-page batch.
#[tauri::command]
pub fn hash_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<FileHash>, String> {
    let poppler_dir = load_settings(&app)?.poppler_dir;
    paths
        .into_iter()
        .map(|path| {
            let hash = hashing::hash_file(&path).map_err(|e| e.to_string())?;
            let file_name = hashing::file_name(&path);
            let page_count = hashing::page_count(&path, poppler_dir.as_deref())?;
            Ok(FileHash { path, file_name, hash, page_count })
        })
        .collect()
}

/// Outcome of parsing a single source file — kept separate per file so one
/// bad PDF in a batch doesn't hide the results already extracted from the
/// others. `error` can be set *alongside* non-empty `sheets`: for a
/// multi-page file that means some pages parsed fine and others didn't
/// ("com alertas"), not that the whole file failed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileParseResult {
    pub path: String,
    pub file_name: String,
    /// Content hash of the whole original file, as picked — distinct from
    /// each sheet's own `originalFileHash`, which for a multi-page file is
    /// the hash of just that person's split-off page.
    pub file_hash: String,
    pub page_count: u32,
    /// Copy of the whole original file, kept regardless of outcome so a
    /// failed file can still be reopened later ("Visualizar" in the import
    /// history) to see what was actually sent in.
    pub original_pdf_path: String,
    pub sheets: Vec<ParsedTimesheet>,
    pub error: Option<String>,
}

/// Extracts text from each source PDF, hands it to the chosen provider's
/// parser, and copies the original file into the app's data dir so it stays
/// browsable later independent of where the user picked it from on disk.
///
/// A file with more than one page is treated as one timesheet per page
/// (Coalize's "Espelho Ponto" batch exports put one employee per page): it's
/// split into single-page PDFs first, and each page is parsed on its own —
/// one page failing doesn't take the others down with it, it just shows up
/// as a partial result ("com alertas").
///
/// Each file is parsed independently: a failure on one file is recorded on
/// its own `FileParseResult` rather than aborting the rest of the batch.
///
/// Persisting the parsed result into SQLite is left to the frontend (via
/// `@tauri-apps/plugin-sql`) once it has a result it's happy with — this
/// command only turns files into structured, previewable data.
#[tauri::command]
pub fn parse_import(
    app: AppHandle,
    provider: String,
    paths: Vec<String>,
) -> Result<Vec<FileParseResult>, String> {
    let parser = parsers::get_parser(&provider).ok_or_else(|| format!("unknown provider '{provider}'"))?;
    let poppler_dir = load_settings(&app)?.poppler_dir;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let imports_dir = data_dir.join("imports");
    fs::create_dir_all(&imports_dir).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for source_path in paths {
        let file_name = hashing::file_name(&source_path);

        // Always keep a copy of the whole original file, even on failure —
        // it's what "Visualizar" in the import history opens later, and
        // it's useful to be able to re-inspect a file that didn't parse.
        let original_pdf_path = match copy_into_imports_dir(&source_path, &imports_dir) {
            Ok(p) => p,
            Err(e) => {
                results.push(FileParseResult {
                    path: source_path,
                    file_name,
                    file_hash: String::new(),
                    page_count: 0,
                    original_pdf_path: String::new(),
                    sheets: Vec::new(),
                    error: Some(e),
                });
                continue;
            }
        };

        let file_hash = match hashing::hash_file(&source_path) {
            Ok(h) => h,
            Err(e) => {
                results.push(FileParseResult {
                    path: source_path,
                    file_name,
                    file_hash: String::new(),
                    page_count: 0,
                    original_pdf_path,
                    sheets: Vec::new(),
                    error: Some(e.to_string()),
                });
                continue;
            }
        };
        let page_count = match hashing::page_count(&source_path, poppler_dir.as_deref()) {
            Ok(n) => n,
            Err(e) => {
                results.push(FileParseResult {
                    path: source_path,
                    file_name,
                    file_hash,
                    page_count: 0,
                    original_pdf_path,
                    sheets: Vec::new(),
                    error: Some(e),
                });
                continue;
            }
        };

        let (sheets, error) = if page_count <= 1 {
            match parse_single_page(
                &source_path,
                &file_name,
                &file_hash,
                &original_pdf_path,
                parser.as_ref(),
                poppler_dir.as_deref(),
            ) {
                Ok(sheets) => (sheets, None),
                Err(e) => (Vec::new(), Some(e)),
            }
        } else {
            parse_multi_page(&source_path, &file_name, parser.as_ref(), &imports_dir, poppler_dir.as_deref())
        };

        results.push(FileParseResult {
            path: source_path,
            file_name,
            file_hash,
            page_count,
            original_pdf_path,
            sheets,
            error,
        });
    }

    Ok(results)
}

fn parse_single_page(
    source_path: &str,
    file_name: &str,
    file_hash: &str,
    dest: &str,
    parser: &dyn parsers::TimesheetParser,
    poppler_dir: Option<&str>,
) -> Result<Vec<ParsedTimesheet>, String> {
    let raw_text = pdf_extract::extract_text(source_path, poppler_dir).map_err(|e| e.to_string())?;
    let mut parsed = parser.parse(&raw_text, dest).map_err(|e| e.to_string())?;
    for sheet in &mut parsed {
        sheet.original_file_hash = file_hash.to_string();
        sheet.original_file_name = file_name.to_string();
    }
    Ok(parsed)
}

/// Splits into one PDF per page and parses each independently, so a single
/// bad page shows up as a partial result instead of failing the whole file.
fn parse_multi_page(
    source_path: &str,
    file_name: &str,
    parser: &dyn parsers::TimesheetParser,
    imports_dir: &Path,
    poppler_dir: Option<&str>,
) -> (Vec<ParsedTimesheet>, Option<String>) {
    let temp_dir = imports_dir.join(format!("split-{}", uuid::Uuid::new_v4()));
    if let Err(e) = fs::create_dir_all(&temp_dir) {
        return (Vec::new(), Some(e.to_string()));
    }

    let page_paths = match pdf_extract::split_pages(source_path, &temp_dir, poppler_dir) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return (Vec::new(), Some(e.to_string()));
        }
    };

    let mut all_sheets = Vec::new();
    let mut page_errors = Vec::new();
    for (i, page_path) in page_paths.iter().enumerate() {
        let page_path_str = page_path.to_string_lossy().to_string();
        let outcome = (|| -> Result<Vec<ParsedTimesheet>, String> {
            let raw_text = pdf_extract::extract_text(&page_path_str, poppler_dir).map_err(|e| e.to_string())?;
            let page_hash = hashing::hash_file(&page_path_str).map_err(|e| e.to_string())?;
            let dest = copy_into_imports_dir(&page_path_str, imports_dir)?;

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

    let error = if page_errors.is_empty() {
        None
    } else {
        Some(page_errors.join("; "))
    };
    (all_sheets, error)
}

fn copy_into_imports_dir(source_path: &str, imports_dir: &Path) -> Result<String, String> {
    let file_id = uuid::Uuid::new_v4();
    let dest: PathBuf = imports_dir.join(format!("{file_id}.pdf"));
    fs::copy(source_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// Opens the OS file manager with `path` itself selected/highlighted, not
/// just its containing folder — the opener plugin has no cross-platform
/// "reveal and select" primitive, so each OS gets its own real mechanism:
/// Explorer's `/select,`, Finder's `open -R`, and on Linux the freedesktop
/// `org.freedesktop.FileManager1.ShowItems` D-Bus method (honored by
/// Nautilus/Nemo and a few others). Anything that fails to actually select
/// the file falls back to just opening the parent folder, same as before.
#[cfg(target_os = "windows")]
fn reveal_path(_app: &AppHandle, path: &str) -> Result<(), String> {
    // Explorer parses its own command line itself instead of going through
    // the normal CommandLineToArgvW convention every other Win32 program
    // uses — so `Command::arg`'s automatic escaping (which assumes that
    // convention) actively works against it here: given a path containing a
    // space, `.arg(format!("/select,\"{path}\""))` makes `Command` see an
    // argument with an embedded quote and *also* wrap/escape the whole
    // thing, so Explorer receives literal backslash-quote sequences instead
    // of the bare `"..."` it expects — it can't parse that, so it silently
    // falls back to whatever folder it opens by default (Documents), not
    // the file that was actually just saved. `raw_arg` bypasses `Command`'s
    // escaping entirely and appends the string to the command line
    // verbatim, which is what actually gets Explorer's own parser the
    // `/select,"C:\path with spaces\file.pdf"` syntax it documents.
    use std::os::windows::process::CommandExt;
    let normalized = path.replace('/', "\\");
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{normalized}\""))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_path(_app: &AppHandle, path: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn reveal_path(app: &AppHandle, path: &str) -> Result<(), String> {
    let uri = format!("file://{path}");
    let selected = std::process::Command::new("dbus-send")
        .args([
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            &format!("array:string:{uri}"),
            "string:",
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if selected {
        return Ok(());
    }

    let parent = Path::new(path)
        .parent()
        .ok_or_else(|| "Arquivo sem diretório pai.".to_string())?;
    app.opener()
        .open_path(parent.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_in_file_manager(app: AppHandle, path: String) -> Result<(), String> {
    reveal_path(&app, &path)
}

/// Opens the app's whole data folder (DB + `imports/`) in the OS file
/// manager — the "Abrir pasta de dados" button in Configurações.
#[tauri::command]
pub fn open_app_data_dir(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(data_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Raw bytes of a PDF, for the in-app viewer (pdf.js on the frontend) to
/// render — returning `tauri::ipc::Response` instead of a JSON-wrapped
/// `Vec<u8>` avoids base64/array overhead for what can be a few hundred KB.
#[tauri::command]
pub fn read_pdf_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Copies the PDF at `source_path` to wherever the user picked via the save
/// dialog — the "Baixar" button in the in-app viewer. A plain byte-for-byte
/// copy, not a re-export through pdf.js, so the downloaded file is
/// identical to what's stored.
#[tauri::command]
pub fn copy_pdf_to(source_path: String, dest_path: String) -> Result<(), String> {
    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Sheet names in an xlsx/xls/ods workbook, for the payment template
/// wizard's sheet tabs — empty for csv.
#[tauri::command]
pub fn list_spreadsheet_sheets(path: String) -> Result<Vec<String>, String> {
    spreadsheet::list_sheets(&path)
}

/// Raw preview rows (no header-row assumption) for the payment template
/// wizard's Excel-like grid.
#[tauri::command]
pub fn preview_spreadsheet(
    path: String,
    sheet: Option<String>,
    delimiter: Option<String>,
    max_rows: u32,
) -> Result<spreadsheet::SpreadsheetPreview, String> {
    spreadsheet::preview(&path, sheet.as_deref(), delimiter.as_deref(), max_rows)
}

/// Reads every row of a real (not sample) payment file according to a
/// saved template's column mapping — the actual import-execution step,
/// as opposed to `preview_spreadsheet`'s capped preview used while
/// building the template itself.
#[tauri::command]
pub fn apply_payment_template(
    path: String,
    groups: Vec<spreadsheet::GroupSpec>,
    delimiter: Option<String>,
) -> Result<Vec<spreadsheet::AppliedPaymentRow>, String> {
    spreadsheet::apply_template(&path, &groups, delimiter.as_deref())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentFileHash {
    pub path: String,
    pub file_name: String,
    pub hash: String,
}

/// Content-hashes a payment spreadsheet — the payment-import equivalent of
/// `hash_files`, but without that command's PDF-only `page_count` (via
/// `pdfinfo`), which would just fail outright on a csv/xlsx/ods.
#[tauri::command]
pub fn hash_payment_file(path: String) -> Result<PaymentFileHash, String> {
    let hash = hashing::hash_file(&path).map_err(|e| e.to_string())?;
    let file_name = hashing::file_name(&path);
    Ok(PaymentFileHash { path, file_name, hash })
}

const OFFICE_DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const OFFICE_HEAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

fn build_http_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("pontoscan/", env!("CARGO_PKG_VERSION")))
        // OneDrive/SharePoint's anonymous-link "redemption" sets a cookie
        // partway through its redirect chain and expects it back on the
        // next hop — without this, an otherwise-public "anyone with the
        // link" share dead-ends on Microsoft's login page instead of the
        // file, even though no actual sign-in is required.
        .cookie_store(true)
        .build()
        .map_err(|e| e.to_string())
}

fn parse_http_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "URL inválida.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("A URL deve começar com http:// ou https://.".to_string());
    }
    Ok(parsed)
}

/// A OneDrive/SharePoint "anyone with the link" share resolves to the
/// Office Online HTML viewer (`Doc.aspx?action=default`) by default —
/// `download=1` is Microsoft's own convention for making that same link
/// stream the raw file bytes instead. Only touches known Microsoft
/// file-sharing hosts, and only when the caller's URL doesn't already
/// have it, so an arbitrary non-Microsoft URL (or one already tuned by
/// hand) is never rewritten.
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
    headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

/// Best-effort filename from `Content-Disposition: attachment;
/// filename="..."` (the common shape for "direct download" links) — no
/// percent-decoding of the RFC 5987 `filename*=UTF-8''...` form, just
/// enough to strip the prefix/quoting. Falls through to the URL's last
/// path segment, then a synthesized default, if this doesn't match.
fn filename_from_content_disposition(header: Option<&str>) -> Option<String> {
    let header = header?;
    for part in header.split(';') {
        let part = part.trim();
        // A real header's first `part` is the disposition type itself
        // (`attachment`), which matches neither prefix — that used to hit
        // the trailing `?` and bail out of the WHOLE function with `None`
        // right there, before ever reaching the `filename=`/`filename*=`
        // part later in the same header. `continue` instead, so a
        // non-matching part just skips to the next one.
        let Some(value) = part
            .strip_prefix("filename*=")
            .map(|v| v.trim_start_matches("UTF-8''").trim_start_matches("utf-8''"))
            .or_else(|| part.strip_prefix("filename="))
        else {
            continue;
        };
        let cleaned = value.trim_matches('"').trim();
        if !cleaned.is_empty() {
            return Some(cleaned.to_string());
        }
    }
    None
}

fn filename_from_url(url: &reqwest::Url) -> Option<String> {
    let last = url.path_segments()?.next_back()?;
    (!last.trim().is_empty()).then(|| last.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedPaymentFile {
    /// Local uuid-named copy under `imports/` — from here on treated
    /// exactly like a locally-picked file (hash/preview/apply_template all
    /// just take a `path: String`).
    pub path: String,
    /// Display name — from Content-Disposition or the URL, NOT the uuid on
    /// disk.
    pub file_name: String,
    pub file_kind: String, // "xlsx" | "xls" | "ods"
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<i64>,
}

/// Downloads a payment spreadsheet from a plain/anonymous direct-download
/// URL, validates it's really an xlsx/xls/ods by magic bytes (never
/// trusting the URL's extension or Content-Type — both are attacker/
/// misconfig-controllable, e.g. a login-wall HTML response served with a
/// 200), and writes it into `imports/` next to the timesheet-PDF flow's
/// own copies — `payment_templates/` is dead code today (nothing ever
/// creates that directory), and `imports/` already carries the
/// size/clear/backup lifecycle this file needs for free (see `storage.rs`).
#[tauri::command]
pub async fn download_payment_file_from_url(
    app: AppHandle,
    url: String,
) -> Result<DownloadedPaymentFile, String> {
    let parsed = normalize_office_share_url(&parse_http_url(&url)?);
    let client = build_http_client(OFFICE_DOWNLOAD_TIMEOUT)?;

    let response = client
        .get(parsed.clone())
        .send()
        .await
        .map_err(|e| format!("Falha ao baixar o arquivo: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("O servidor retornou o status {}.", response.status()));
    }

    let etag = header_str(response.headers(), reqwest::header::ETAG);
    let last_modified = header_str(response.headers(), reqwest::header::LAST_MODIFIED);
    let content_disposition = header_str(response.headers(), reqwest::header::CONTENT_DISPOSITION);
    let content_length = response.content_length().map(|n| n as i64);
    // The URL actually served (after following every redirect) — a share
    // host like OneDrive commonly bounces the request off to its real CDN
    // blob URL, which is far more likely to carry the real filename than
    // `parsed` (the original short link, whose only path segment is the
    // opaque item id — exactly what was showing up as the "file name"
    // whenever Content-Disposition didn't pan out either).
    let final_url = response.url().clone();
    eprintln!(
        "[download_payment_file_from_url] content-disposition={:?} final_url={}",
        content_disposition, final_url
    );

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Falha ao baixar o arquivo: {e}"))?;

    let kind = if infer::doc::is_xlsx(&bytes) {
        "xlsx"
    } else if infer::doc::is_xls(&bytes) {
        "xls"
    } else if infer::odf::is_ods(&bytes) {
        "ods"
    } else {
        return Err(
            "O link não retornou um arquivo do Microsoft Office (.xlsx/.xls) ou OpenDocument \
             (.ods) válido. Verifique se a URL exige login ou não é um link de download direto."
                .to_string(),
        );
    };

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let imports_dir = data_dir.join("imports");
    fs::create_dir_all(&imports_dir).map_err(|e| e.to_string())?;
    let dest = imports_dir.join(format!("{}.{kind}", uuid::Uuid::new_v4()));
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    let file_name = filename_from_content_disposition(content_disposition.as_deref())
        .or_else(|| filename_from_url(&final_url))
        .unwrap_or_else(|| format!("download.{kind}"));

    Ok(DownloadedPaymentFile {
        path: dest.to_string_lossy().to_string(),
        file_name,
        file_kind: kind.to_string(),
        etag,
        last_modified,
        content_length,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileSignature {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChangeCheck {
    /// `None` when the server gave no comparable signal at all (no ETag,
    /// no Last-Modified, no Content-Length on either side) — treat as
    /// "unknown", not "unchanged".
    pub changed: Option<bool>,
    pub current: RemoteFileSignature,
}

/// Cheap HEAD-based "did the remote file change" check — ETag is trusted
/// alone when both sides have one (strongest, usually content-addressed);
/// otherwise Last-Modified, then Content-Length, as weaker fallbacks. Runs
/// silently and in parallel on the Importar Pagamentos screen's mount, one
/// call per URL a payment file was ever downloaded from — see
/// `listUrlSourcedPaymentFiles` on the frontend.
#[tauri::command]
pub async fn check_remote_payment_file(
    url: String,
    known_etag: Option<String>,
    known_last_modified: Option<String>,
    known_content_length: Option<i64>,
) -> Result<RemoteChangeCheck, String> {
    let parsed = normalize_office_share_url(&parse_http_url(&url)?);
    let client = build_http_client(OFFICE_HEAD_TIMEOUT)?;

    let response = client
        .head(parsed)
        .send()
        .await
        .map_err(|e| format!("Falha ao verificar o arquivo remoto: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("O servidor retornou o status {}.", response.status()));
    }

    let etag = header_str(response.headers(), reqwest::header::ETAG);
    let last_modified = header_str(response.headers(), reqwest::header::LAST_MODIFIED);
    let content_length = response.content_length().map(|n| n as i64);

    let changed = if let (Some(k), Some(c)) = (&known_etag, &etag) {
        Some(k != c)
    } else if let (Some(k), Some(c)) = (&known_last_modified, &last_modified) {
        Some(k != c)
    } else if let (Some(k), Some(c)) = (known_content_length, content_length) {
        Some(k != c)
    } else {
        None
    };

    Ok(RemoteChangeCheck {
        changed,
        current: RemoteFileSignature { etag, last_modified, content_length },
    })
}

/// Builds the Relatórios export zip. The frontend already knows the
/// company/client/employee grouping and file naming (locale-aware period
/// formatting lives in TS) — this just moves bytes into an archive, merging
/// with `pdfunite` first wherever an entry has more than one source PDF.
#[tauri::command]
pub fn generate_report_zip(
    app: AppHandle,
    entries: Vec<ReportZipEntry>,
    dest_zip_path: String,
) -> Result<(), String> {
    let poppler_dir = load_settings(&app)?.poppler_dir;
    report_zip::build(&entries, &dest_zip_path, poppler_dir.as_deref())
}

/// Disk usage of the DB and the copied PDFs — the storage indicator on the
/// Configurações screen.
#[tauri::command]
pub fn get_storage_usage(app: AppHandle) -> Result<StorageUsage, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(storage::usage(&data_dir))
}

/// Best-effort delete of the given files — used for "remover originais
/// redundantes". Returns how many bytes were actually freed.
#[tauri::command]
pub fn delete_paths(paths: Vec<String>) -> Result<u64, String> {
    storage::delete_paths(&paths)
}

/// Empties and recreates `imports/` — the file half of "Limpar tudo".
#[tauri::command]
pub fn clear_imports_dir(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::clear_imports_dir(&data_dir)
}

/// Zips the DB and/or `imports/` to `dest_zip_path` — the optional backup
/// offered right before "Limpar tudo" wipes everything.
#[tauri::command]
pub fn backup_app_data(
    app: AppHandle,
    dest_zip_path: String,
    include_db: bool,
    include_files: bool,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::backup(&data_dir, &dest_zip_path, include_db, include_files)
}

/// Writes arbitrary bytes to `path` — used for the Pagamentos "Gerar PDF"
/// export (built client-side, this just puts the resulting bytes on disk
/// at wherever the save dialog pointed).
#[tauri::command]
pub fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(settings::load(&data_dir))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopplerBinaryStatus {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
}

/// Whether each Poppler CLI tool the app depends on (`pdfinfo`,
/// `pdftotext`, `pdfseparate`, `pdfunite`) was found — checked eagerly at
/// startup and shown in Configurações, rather than surfacing as an obscure
/// "failed to spawn" error the first time an import is attempted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopplerStatus {
    pub all_found: bool,
    pub poppler_dir: Option<String>,
    pub binaries: Vec<PopplerBinaryStatus>,
}

fn poppler_status(poppler_dir: Option<String>) -> PopplerStatus {
    let binaries: Vec<PopplerBinaryStatus> = poppler::BINARIES
        .iter()
        .map(|name| {
            let resolved = poppler::resolve(name, poppler_dir.as_deref());
            let found = resolved.is_absolute();
            PopplerBinaryStatus {
                name: (*name).to_string(),
                found,
                path: found.then(|| resolved.to_string_lossy().to_string()),
            }
        })
        .collect();
    let all_found = binaries.iter().all(|b| b.found);
    PopplerStatus { all_found, poppler_dir, binaries }
}

/// Checked once on app startup and again whenever Configurações is opened —
/// surfaces a missing Poppler install up front instead of only at import
/// time.
#[tauri::command]
pub fn check_poppler_status(app: AppHandle) -> Result<PopplerStatus, String> {
    Ok(poppler_status(load_settings(&app)?.poppler_dir))
}

/// Saves the user's manual override for where to find the Poppler CLI tools
/// (Configurações → "Pasta dos binários do Poppler") and re-checks status
/// against it. `dir` empty/`None` clears the override, going back to
/// auto-detection.
#[tauri::command]
pub fn set_poppler_dir(app: AppHandle, dir: Option<String>) -> Result<PopplerStatus, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut current = settings::load(&data_dir);
    current.poppler_dir = dir.filter(|d| !d.trim().is_empty());
    settings::save(&data_dir, &current)?;
    Ok(poppler_status(current.poppler_dir))
}

const MAX_RECENT_PAYMENT_FILES: usize = 5;

/// Recently-picked payment template sample file paths, newest first — a
/// quick-pick shortcut on the wizard's Arquivo step. Paths that no longer
/// exist on disk are filtered out here rather than shown as dead entries
/// (not written back; a future `add_recent_payment_file` call naturally
/// prunes the list further).
#[tauri::command]
pub fn list_recent_payment_files(app: AppHandle) -> Result<Vec<String>, String> {
    let settings = load_settings(&app)?;
    Ok(settings
        .recent_payment_files
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect())
}

/// Records `path` as the most recently picked payment sample file, moving
/// it to the front if already present and capping the list.
#[tauri::command]
pub fn add_recent_payment_file(app: AppHandle, path: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut settings = settings::load(&data_dir);
    settings.recent_payment_files.retain(|p| p != &path);
    settings.recent_payment_files.insert(0, path);
    settings.recent_payment_files.truncate(MAX_RECENT_PAYMENT_FILES);
    settings::save(&data_dir, &settings)
}
