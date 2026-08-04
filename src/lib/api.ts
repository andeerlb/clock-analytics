import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileHash, FileParseResult, ProviderInfo, ReportZipEntry } from "./types";

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

/** Raw bytes of a PDF, for the in-app viewer to render. */
export async function readPdfBytes(path: string): Promise<ArrayBuffer> {
  return invoke("read_pdf_bytes", { path });
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

/** Builds the Relatórios export zip at `destZipPath` from the given entries. */
export function generateReportZip(entries: ReportZipEntry[], destZipPath: string): Promise<void> {
  return invoke("generate_report_zip", { entries, destZipPath });
}
