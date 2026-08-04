import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  FileHash,
  FileParseResult,
  PopplerStatus,
  ProviderInfo,
  ReportZipEntry,
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

/** Opens the native file picker, restricted to payroll spreadsheet formats, single-select. */
export async function pickPaymentFile(): Promise<string | null> {
  const selection = await open({
    multiple: false,
    filters: [{ name: "Planilha de pagamentos", extensions: ["csv", "xlsx", "xls", "ods"] }],
  });
  return typeof selection === "string" ? selection : null;
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

/** Copies a payment template's sample file into the app's own data folder. */
export function copyPaymentSample(sourcePath: string): Promise<string> {
  return invoke("copy_payment_sample", { sourcePath });
}

/** Builds the Relatórios export zip at `destZipPath` from the given entries. */
export function generateReportZip(entries: ReportZipEntry[], destZipPath: string): Promise<void> {
  return invoke("generate_report_zip", { entries, destZipPath });
}

/** Disk usage of the DB and the copied PDFs. */
export function getStorageUsage(): Promise<StorageUsage> {
  return invoke("get_storage_usage");
}

/** Best-effort delete of each path — returns how many bytes were actually freed. */
export function deletePaths(paths: string[]): Promise<number> {
  return invoke("delete_paths", { paths });
}

/** Empties and recreates the imports/ folder — the file half of "Limpar tudo". */
export function clearImportsDir(): Promise<void> {
  return invoke("clear_imports_dir");
}

/** Zips the DB and imports/ to `destZipPath` — the backup offered before "Limpar tudo". */
export function backupAppData(destZipPath: string): Promise<void> {
  return invoke("backup_app_data", { destZipPath });
}

/** Whether pdfinfo/pdftotext/pdfseparate/pdfunite were found — checked at startup and on Configurações. */
export function checkPopplerStatus(): Promise<PopplerStatus> {
  return invoke("check_poppler_status");
}

/** Saves (or, passing null, clears) the manual override for where to find the Poppler CLI tools. */
export function setPopplerDir(dir: string | null): Promise<PopplerStatus> {
  return invoke("set_poppler_dir", { dir });
}
