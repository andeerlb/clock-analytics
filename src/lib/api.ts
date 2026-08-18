import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  FileHash,
  FileParseResult,
  PopplerStatus,
  ProviderInfo,
  ReportZipEntry,
  StorageFileEntry,
  StorageUsage,
} from "./types";

export function listProviders(): Promise<ProviderInfo[]> {
  return invoke("list_providers");
}

/** Content-hashes each file — cheap enough to run before deciding whether to parse it at all. */
export function hashFiles(paths: string[]): Promise<FileHash[]> {
  return invoke("hash_files", { paths });
}

/** Parses each file independently — check `.error` per result instead of a try/catch around the whole batch. */
export function parseImport(provider: string, paths: string[]): Promise<FileParseResult[]> {
  return invoke("parse_import", { provider, paths });
}

/** Opens `path`'s containing folder in the OS file manager ("abrir no explorador de arquivos"). */
export function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

/** Opens the app's whole data folder (DB + imports/) in the OS file manager. */
export function openAppDataDir(): Promise<void> {
  return invoke("open_app_data_dir");
}

/** Raw bytes of a PDF, for the in-app viewer to render. */
export async function readPdfBytes(path: string): Promise<ArrayBuffer> {
  return invoke("read_pdf_bytes", { path });
}

/** Copies the PDF at `sourcePath` to `destPath` — the viewer's "Baixar" action. */
export function copyPdfTo(sourcePath: string, destPath: string): Promise<void> {
  return invoke("copy_pdf_to", { sourcePath, destPath });
}

/** Opens the native file picker, restricted to PDFs, multi-select on. */
export async function pickPdfFiles(): Promise<string[]> {
  const selection = await open({
    multiple: true,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

/** Opens the native folder picker — the "Pasta inteira" alternative to multi-file selection. */
export async function pickFolder(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  return typeof selection === "string" ? selection : null;
}

/** Immediate files (not subfolders) inside `dir` whose extension matches one of `extensions` (no leading dot, e.g. "pdf"). */
export function listDirFiles(dir: string, extensions: string[]): Promise<string[]> {
  return invoke("list_dir_files", { dir, extensions });
}

/** Opens the native file picker, restricted to payroll spreadsheet formats, single-select — for the template wizard's sample file. */
export async function pickPaymentFile(): Promise<string | null> {
  const selection = await open({
    multiple: false,
    filters: [{ name: "Planilha de pagamentos", extensions: ["csv", "xlsx", "xls", "ods"] }],
  });
  return typeof selection === "string" ? selection : null;
}

/**
 * Multi-select — for actually importing (one template can be applied to
 * several files at once). Unlike `pickPaymentFile`, filtered to a single
 * format: the template chosen for this import already fixes its expected
 * file format, so there's no "which format is this" left to figure out
 * like there is when first building a template from a sample file.
 */
export async function pickPaymentFiles(extensions: string[]): Promise<string[]> {
  const selection = await open({
    multiple: true,
    filters: [{ name: "Planilha de pagamentos", extensions }],
  });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

export interface PaymentFileHash {
  path: string;
  fileName: string;
  hash: string;
}

/** Content-hashes a payment file — no page count (unlike `hashFiles`, which is PDF-only via pdfinfo). */
export function hashPaymentFile(path: string): Promise<PaymentFileHash> {
  return invoke("hash_payment_file", { path });
}

export interface DownloadedPaymentFile {
  path: string;
  fileName: string;
  fileKind: "xlsx" | "xls" | "ods";
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

/**
 * Downloads a payment spreadsheet from a plain/anonymous direct-download
 * URL into imports/, validating (by magic bytes, backend-side) that it's
 * really an .xlsx/.xls — rejects e.g. an HTML login page some "direct
 * download" links redirect to instead of the file.
 */
export function downloadPaymentFileFromUrl(url: string): Promise<DownloadedPaymentFile> {
  return invoke("download_payment_file_from_url", { url });
}

export interface RemoteFileSignature {
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

export interface RemoteChangeCheck {
  /** `null` = server gave no comparable signal — treat as unknown, not unchanged. */
  changed: boolean | null;
  current: RemoteFileSignature;
}

/** Cheap HEAD-only check for whether `url`'s content differs from the last-known signature. */
export function checkRemotePaymentFile(
  url: string,
  knownEtag: string | null,
  knownLastModified: string | null,
  knownContentLength: number | null,
): Promise<RemoteChangeCheck> {
  return invoke("check_remote_payment_file", {
    url,
    knownEtag,
    knownLastModified,
    knownContentLength,
  });
}

export interface SpreadsheetPreview {
  rows: string[][];
  delimiter: string | null;
}

/** Sheet names in an xlsx/xls/ods workbook, for the payment template wizard's sheet tabs — empty for csv. */
export function listSpreadsheetSheets(path: string): Promise<string[]> {
  return invoke("list_spreadsheet_sheets", { path });
}

/** Raw preview rows (no header-row assumption) for the payment template wizard's Excel-like grid. */
export function previewSpreadsheet(
  path: string,
  sheet: string | null,
  delimiter: string | null,
  maxRows: number,
): Promise<SpreadsheetPreview> {
  return invoke("preview_spreadsheet", { path, sheet, delimiter, maxRows });
}

/** The bit of a `PaymentTemplateGroup` (see types.ts) actually needed to read rows — id/headerLabel don't matter here. */
export interface PaymentTemplateGroupSpec {
  sheetNames: string[];
  /** (columnLetter, targetField) pairs. */
  fieldMappings: [string, string][];
}

export interface AppliedPaymentRow {
  sheetName: string | null;
  /** 1-indexed physical row in the source file — for error messages. */
  rowNumber: number;
  fields: Record<string, string>;
  /** columnLetter -> raw text value, for every non-blank column the template left unmapped ("Ignorar") — kept for history instead of discarded. */
  extraFields: Record<string, string>;
}

/** Reads every row of a real payment file per a saved template's column mapping — the actual import-execution step. */
export function applyPaymentTemplate(
  path: string,
  groups: PaymentTemplateGroupSpec[],
  delimiter: string | null,
): Promise<AppliedPaymentRow[]> {
  return invoke("apply_payment_template", { path, groups, delimiter });
}

/** Builds the Relatórios export zip at `destZipPath` from the given entries. */
export function generateReportZip(entries: ReportZipEntry[], destZipPath: string): Promise<void> {
  return invoke("generate_report_zip", { entries, destZipPath });
}

/** Disk usage of the DB and the copied imported files (PDFs and, when downloaded by link, payment spreadsheets). */
export function getStorageUsage(): Promise<StorageUsage> {
  return invoke("get_storage_usage");
}

/** Itemized breakdown behind the "Arquivos importados" tile — one entry per file actually inside imports/. */
export function getImportsFileList(): Promise<StorageFileEntry[]> {
  return invoke("get_imports_file_list");
}

/** Best-effort delete of each path — returns how many bytes were actually freed. */
export function deletePaths(paths: string[]): Promise<number> {
  return invoke("delete_paths", { paths });
}

/** Empties and recreates the imports/ folder — the file half of "Limpar tudo". */
export function clearImportsDir(): Promise<void> {
  return invoke("clear_imports_dir");
}

/** Zips the DB and/or imports/ to `destZipPath` — the backup offered before "Limpar tudo". Either side can be skipped. */
export function backupAppData(destZipPath: string, includeDb: boolean, includeFiles: boolean): Promise<void> {
  return invoke("backup_app_data", { destZipPath, includeDb, includeFiles });
}

/** Writes arbitrary bytes to `path` — a caller that already has a concrete destination (e.g. from a save dialog). */
export function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  return invoke("write_binary_file", { path, data: Array.from(data) });
}

/** Copies the live database file to `destPath` — call `checkpointDatabase()` (lib/db) first so it's a complete snapshot. */
export function exportDatabase(destPath: string): Promise<void> {
  return invoke("export_database", { destPath });
}

/** Replaces the live database file with `srcPath` — validates it's really a SQLite file and backs up the current one first (see the Rust side). Call `closeDatabase()` (lib/db) before this and relaunch the app right after. */
export function importDatabase(srcPath: string): Promise<void> {
  return invoke("import_database", { srcPath });
}

/** Whether pdfinfo/pdftotext/pdfseparate/pdfunite were found — checked at startup and on Configurações. */
export function checkPopplerStatus(): Promise<PopplerStatus> {
  return invoke("check_poppler_status");
}

/** Saves (or, passing null, clears) the manual override for where to find the Poppler CLI tools. */
export function setPopplerDir(dir: string | null): Promise<PopplerStatus> {
  return invoke("set_poppler_dir", { dir });
}

/** Whether "Minimizar na bandeja ao fechar" is on — checked on Configurações' mount. */
export function getCloseToTray(): Promise<boolean> {
  return invoke("get_close_to_tray");
}

/** Saves "Minimizar na bandeja ao fechar" — takes effect on the next close, no restart needed. */
export function setCloseToTray(enabled: boolean): Promise<void> {
  return invoke("set_close_to_tray", { enabled });
}

/** Swaps the tray icon (normal/"atenção" badge) and tooltip — reflects the aggregate check state even while the window is hidden. */
export function setTrayStatus(attention: boolean, tooltip: string): Promise<void> {
  return invoke("set_tray_status", { attention, tooltip });
}

/** Recently-picked payment template sample file paths, newest first — dead paths already filtered out. */
export function listRecentPaymentFiles(): Promise<string[]> {
  return invoke("list_recent_payment_files");
}

/** Records `path` as the most recently picked payment sample file. */
export function addRecentPaymentFile(path: string): Promise<void> {
  return invoke("add_recent_payment_file", { path });
}

/**
 * Toggles the real OS-level window blur-behind (Acrylic/Vibrancy) on or off.
 * Resolves `true` only on Windows/macOS, where the effect actually exists —
 * `false` on Linux (and anywhere else `window-vibrancy` has no native
 * backend), so callers know to leave their CSS-only blur fallback in place.
 * See `useWindowGlass`.
 */
export function setWindowGlass(active: boolean): Promise<boolean> {
  return invoke("set_window_glass", { active });
}
