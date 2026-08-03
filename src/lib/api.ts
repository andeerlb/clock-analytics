import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ParsedTimesheet, ProviderInfo } from "./types";

export function listProviders(): Promise<ProviderInfo[]> {
  return invoke("list_providers");
}

export function parseImport(provider: string, paths: string[]): Promise<ParsedTimesheet[]> {
  return invoke("parse_import", { provider, paths });
}

export function openOriginalPdf(path: string): Promise<void> {
  return invoke("open_original_pdf", { path });
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
