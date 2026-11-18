import { baseName, downloadBlob, downloadServerFile, pickAndUpload } from "./files";
import { api, fetchServerFile, rpc } from "./http";
import type {
  FileHash,
  FileParseResult,
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

/** Disk usage of the DB and the copied imported files (PDFs and, when downloaded by link, payment spreadsheets), on the server. */
export function getStorageUsage(): Promise<StorageUsage> {
  return rpc<StorageUsage>("getStorageUsage");
}

/** Itemized breakdown behind the "Arquivos importados" tile — one entry per file actually inside imports/. */
export function getImportsFileList(): Promise<StorageFileEntry[]> {
  return rpc<StorageFileEntry[]>("getImportsFileList");
}

/** Deletes imported files on the server (only files inside imports/) — returns how many bytes were actually freed. */
export function deleteImportedFiles(paths: string[]): Promise<number> {
  return rpc<number>("deleteImportedFiles", { paths });
}

/** Empties and recreates the imports/ folder — the file half of "Apagar histórico e arquivos". */
export function clearImportsDir(): Promise<void> {
  return rpc<void>("clearImportsDir");
}

/** Zips the DB and/or imports/ on the server and downloads the .zip — the backup offered before "Apagar histórico e arquivos". */
export async function downloadBackup(includeDb: boolean, includeFiles: boolean): Promise<void> {
  const { path } = await rpc<{ path: string }>("backupAppData", { includeDb, includeFiles });
  await downloadServerFile(path, "pontoscan-backup.zip");
}

/** Saves bytes generated in the browser as a download named after `path`'s last component. */
export function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  downloadBlob(data, baseName(path));
  return Promise.resolve();
}

/** Downloads a consistent copy of the live database ("Baixar uma cópia do banco"). */
export async function downloadDatabaseCopy(): Promise<void> {
  const { path } = await rpc<{ path: string }>("exportDatabase");
  await downloadServerFile(path, "pontoscan.db");
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

/** The team's Anthropic key, as the server describes it. The key itself never comes back. */
export interface AiStatus {
  /** Whether a key is saved; without one the assistant is off. */
  apiKey: boolean;
  /** E-mail of whoever saved the current key. */
  savedBy: string | null;
  /** When it was saved (ISO 8601, UTC). */
  savedAt: string | null;
  /** Last 4 characters of the key, to tell keys apart. */
  keyLast4: string | null;
}

/** Whether the assistant has a key (one for the whole team, kept on the server). */
export function aiStatus(): Promise<AiStatus> {
  return rpc("aiStatus");
}

/** Saves or replaces the team's key; the server records who saved it. */
export function aiSetApiKey(apiKey: string): Promise<void> {
  return rpc("aiSetApiKey", { apiKey });
}

export function aiClearApiKey(): Promise<void> {
  return rpc("aiClearApiKey");
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

/** A button under an answer that opens a screen, filtered or on one record. Already validated on the server. */
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

/**
 * Read-only question to the assistant — see `server/src/ai/investigation.rs`.
 * Can take a few minutes; the answer comes back in one piece.
 */
export function aiAsk(request: AiAskRequest): Promise<AiAskOutcome> {
  return rpc("aiAsk", { request });
}
