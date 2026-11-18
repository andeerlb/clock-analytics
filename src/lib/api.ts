import { invoke } from "@tauri-apps/api/core";
import { baseName, downloadBlob, downloadServerFile, pickAndUpload } from "./files";
import { api, fetchServerFile, rpc } from "./http";
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
  return rpc("listProviders");
}

/** Content-hashes each file — cheap enough to run before deciding whether to parse it at all. */
export function hashFiles(paths: string[]): Promise<FileHash[]> {
  return rpc("hashFiles", { paths });
}

/** Parses each file independently — check `.error` per result instead of a try/catch around the whole batch. */
export function parseImport(provider: string, paths: string[]): Promise<FileParseResult[]> {
  return rpc("parseImport", { provider, paths });
}

/** Opens `path`'s containing folder in the OS file manager ("abrir no explorador de arquivos"). */
export function revealInFileManager(path: string): Promise<void> {
  // The web has no file manager to open: the file was already downloaded.
  void path;
  return Promise.resolve();
}

/** Opens the app's whole data folder (DB + imports/) in the OS file manager. */
export function openAppDataDir(): Promise<void> {
  return invoke("open_app_data_dir");
}

/** Raw bytes of a PDF stored on the server, for the in-app viewer to render. */
export async function readPdfBytes(path: string): Promise<ArrayBuffer> {
  return fetchServerFile(path);
}

/** The viewer's "Baixar": downloads the stored PDF through the browser, named after `destPath`'s last component. */
export function copyPdfTo(sourcePath: string, destPath: string): Promise<void> {
  return downloadServerFile(sourcePath, baseName(destPath));
}

/** Lets the user choose PDFs, uploads them, and resolves with their server paths (empty if cancelled). */
export async function pickPdfFiles(): Promise<string[]> {
  return pickAndUpload({ accept: [".pdf"], multiple: true, extensions: ["pdf"] });
}

/**
 * The "Pasta inteira" option: the user chooses a folder, its files are
 * uploaded into one server folder, and that folder's server path is
 * returned — `listDirFiles` then lists it, same as on the desktop.
 */
export async function pickFolder(): Promise<string | null> {
  const paths = await pickAndUpload({ directory: true, extensions: ["pdf", "csv", "xlsx", "xls", "ods"] });
  if (paths.length === 0) return null;
  return paths[0].replace(/[\\/][^\\/]*$/, "");
}

/** Immediate files inside `dir` (a folder returned by `pickFolder`) whose extension matches one of `extensions` (no leading dot, e.g. "pdf"). */
export function listDirFiles(dir: string, extensions: string[]): Promise<string[]> {
  return api.post<string[]>("/files/list", { dir, extensions });
}

/** Lets the user choose one payroll spreadsheet (the template wizard's sample file) and uploads it. */
export async function pickPaymentFile(): Promise<string | null> {
  const paths = await pickAndUpload({ accept: [".csv", ".xlsx", ".xls", ".ods"], extensions: ["csv", "xlsx", "xls", "ods"] });
  return paths[0] ?? null;
}

/**
 * Multi-select — for actually importing (one template can be applied to
 * several files at once). Unlike `pickPaymentFile`, filtered to a single
 * format: the template chosen for this import already fixes its expected
 * file format.
 */
export async function pickPaymentFiles(extensions: string[]): Promise<string[]> {
  return pickAndUpload({ accept: extensions.map((e) => `.${e}`), multiple: true, extensions });
}

export interface PaymentFileHash {
  path: string;
  fileName: string;
  hash: string;
}

/** Content-hashes a payment file — no page count (unlike `hashFiles`, which is PDF-only via pdfinfo). */
export function hashPaymentFile(path: string): Promise<PaymentFileHash> {
  return rpc("hashPaymentFile", { path });
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
  return rpc("downloadPaymentFileFromUrl", { url });
}

/** Who last saved a downloaded spreadsheet, and when, from the file's own properties (.xlsx/.ods; nothing for .xls/.csv). */
export function readSpreadsheetAuthor(path: string): Promise<{ savedBy: string | null; savedAt: string | null }> {
  return rpc("readSpreadsheetAuthor", { path });
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
  return rpc("checkRemotePaymentFile", {
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
  return rpc("listSpreadsheetSheets", { path });
}

/** Raw preview rows (no header-row assumption) for the payment template wizard's Excel-like grid. */
export function previewSpreadsheet(
  path: string,
  sheet: string | null,
  delimiter: string | null,
  maxRows: number,
): Promise<SpreadsheetPreview> {
  return rpc("previewSpreadsheet", { path, sheet, delimiter, maxRows });
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
  return rpc("applyPaymentTemplate", { path, groups, delimiter });
}

/** Builds the Relatórios export zip at `destZipPath` from the given entries. */
/** Builds the ZIP on the server and downloads it as `fileName` (a bare name; any folders in it are ignored). */
export async function generateReportZip(entries: ReportZipEntry[], fileName: string): Promise<void> {
  const { path } = await rpc<{ path: string }>("generateReportZip", { entries });
  await downloadServerFile(path, baseName(fileName));
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
  // Web: the browser saves the file (named after `path`'s last component).
  downloadBlob(data, baseName(path));
  return Promise.resolve();
}

/** Copies the live database file to `destPath` — call `checkpointDatabase()` (lib/db) first so it's a complete snapshot. */
export function exportDatabase(destPath: string): Promise<void> {
  return invoke("export_database", { destPath });
}

/** Validates and stages a database file for replacement on the next launch. Relaunch the app right after this resolves. */
export interface DatabaseImportEvent { label: string; occurredAt: string }
export function importDatabase(srcPath: string): Promise<DatabaseImportEvent[]> {
  return invoke("import_database", { srcPath });
}

export function cancelDatabaseImport(): Promise<void> {
  return invoke("cancel_database_import");
}

export interface DatabaseImportResult { success: boolean; message: string; events: DatabaseImportEvent[] }
export function takeDatabaseImportResult(): Promise<DatabaseImportResult | null> {
  return invoke("take_database_import_result");
}
export function clearDatabaseImportResult(): Promise<void> {
  return invoke("clear_database_import_result");
}

/** Whether pdfinfo/pdftotext/pdfseparate/pdfunite were found — checked at startup and on Configurações. */
export function checkPopplerStatus(): Promise<PopplerStatus> {
  return invoke("check_poppler_status");
}

/** Saves (or, passing null, clears) the manual override for where to find the Poppler CLI tools. */
export function setPopplerDir(dir: string | null): Promise<PopplerStatus> {
  return invoke("set_poppler_dir", { dir });
}

/** Snapshots the database into the app's `backups/` folder before a forced delete, with `label` in the file name — resolves to the backup's path. */
export function backupDatabaseBeforeDelete(label: string): Promise<string> {
  // The server streams every change to Cloud Storage (Litestream), so there
  // is no separate pre-delete copy to make.
  void label;
  return Promise.resolve("");
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
  // No system tray in the browser.
  void attention;
  void tooltip;
  return Promise.resolve();
}

/** Recently-picked payment template sample file paths, newest first — dead paths already filtered out. */
export function listRecentPaymentFiles(): Promise<string[]> {
  // Uploaded files only live for a day on the server, so there is no
  // useful "recent files" list on the web.
  return Promise.resolve([]);
}

/** Records `path` as the most recently picked payment sample file. */
export function addRecentPaymentFile(path: string): Promise<void> {
  void path;
  return Promise.resolve();
}

/** Hash route of the standalone "Conferência de Pagamentos" tab (see `App.tsx`). */
const RECONCILIATION_ROUTE = "/payments/reconciliation";
/** Browser window name of that tab — `window.open` with it reuses an already-open one instead of opening a second. */
const RECONCILIATION_WINDOW_NAME = "pontoscan-reconciliation";
let reconciliationTab: Window | null = null;

/** "Destacar" on "Conferência de Pagamentos" — opens (or refocuses) it in its own browser tab. */
export function openReconciliationWindow(): Promise<void> {
  const url = `${window.location.pathname}${window.location.search}#${RECONCILIATION_ROUTE}`;
  // No "noopener": the handle is what lets `isReconciliationWindowOpen` see the tab (it's this app's own page).
  reconciliationTab = window.open(url, RECONCILIATION_WINDOW_NAME);
  reconciliationTab?.focus();
  return Promise.resolve();
}

/** Whether "Conferência de Pagamentos" is open in its own tab (one this tab opened). */
export function isReconciliationWindowOpen(): Promise<boolean> {
  return Promise.resolve(reconciliationTab !== null && !reconciliationTab.closed);
}

/** How the assistant can reach Claude. The installed Claude Code wins when both are present. */
export function aiStatus(): Promise<{ claudeCode: boolean; apiKey: boolean }> {
  return invoke("ai_status");
}

export function aiSetApiKey(apiKey: string): Promise<void> {
  return invoke("ai_set_api_key", { apiKey });
}

export function aiClearApiKey(): Promise<void> {
  return invoke("ai_clear_api_key");
}

export interface AiAskRequest {
  /** Exactly what the previous `answer` outcome returned (`[]` to start), opaque to the UI. */
  conversation: unknown[];
  question: string;
  /** Screen and active filters, described for the model; `null` when the user chose not to use them. */
  screen: string | null;
  shift: { shiftId: number; employeeId: number; workDate: string } | null;
  /** `Ambiguity.key` -> the employee picked, or `null` for "não é uma pessoa". */
  nameChoices: Record<string, number | null>;
}

export interface AiAmbiguity {
  key: string;
  term: string;
  candidates: { id: number; name: string }[];
}

/** A button under an answer that opens a screen, filtered or on one record. Already validated on the Rust side. */
export interface AiScreenLink {
  label: string;
  screen: string;
  employeeIds: number[];
  companyIds: number[];
  clientIds: number[];
  roleIds: number[];
  locals: string[];
  periodStart: string | null;
  periodEnd: string | null;
  statuses: string[];
  recordId: number | null;
}

/** An answer split into the parts the panel lays out differently. Every part is optional. */
export interface AiAnswer {
  conclusion: string | null;
  facts: { label: string; value: string }[];
  body: string;
  hypothesis: string | null;
  /** Unrequested things worth a look; each only fills the input when used. */
  tips: { note: string; question: string }[];
}

export type AiAskOutcome =
  | { kind: "answer"; answer: AiAnswer; conversation: unknown[]; links: AiScreenLink[] }
  | { kind: "needsChoice"; ambiguities: AiAmbiguity[] };

/** Read-only question to the assistant — see `ai_investigation.rs`. */
export function aiAsk(request: AiAskRequest): Promise<AiAskOutcome> {
  return invoke("ai_ask", { request });
}
