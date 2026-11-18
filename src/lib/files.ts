/**
 * Browser replacements for the desktop app's native dialogs
 * (`@tauri-apps/plugin-dialog`):
 * - `open()`  → `pickFiles()` (a hidden `<input type="file">`), then
 *   `uploadFiles()` to get server paths the rest of the flow can use;
 * - `save()` + `writeBinaryFile()` / `copyPdfTo()` → `downloadBlob()` /
 *   `downloadServerFile()`: the browser saves the file to Downloads (or
 *   asks where, depending on the browser's setting).
 */
import { fetchServerBlob, uploadFiles } from "./http";

export interface PickOptions {
  /** e.g. [".pdf"] or [".csv", ".xlsx"]. */
  accept?: string[];
  multiple?: boolean;
  /** Pick a whole folder (Chrome/Edge/Firefox: `webkitdirectory`). */
  directory?: boolean;
}

/**
 * Opens the browser's file chooser. Resolves with the chosen files, or an
 * empty array if the person cancels. Must be called from a click handler.
 */
export function pickFiles({ accept, multiple = false, directory = false }: PickOptions = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple || directory;
    if (accept?.length) input.accept = accept.join(",");
    if (directory) input.setAttribute("webkitdirectory", "");
    input.style.display = "none";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** Keeps only files whose name ends with one of `extensions` (no dot, any case). */
export function filterByExtension(files: File[], extensions: string[]): File[] {
  const wanted = extensions.map((e) => e.replace(/^\./, "").toLowerCase());
  return files.filter((f) => wanted.includes(f.name.split(".").pop()?.toLowerCase() ?? ""));
}

/** Picks files and uploads them; resolves with their server paths (empty if cancelled). */
export async function pickAndUpload(options: PickOptions & { extensions?: string[] }): Promise<string[]> {
  let files = await pickFiles(options);
  if (options.extensions) files = filterByExtension(files, options.extensions);
  const uploaded = await uploadFiles(files);
  return uploaded.map((u) => u.path);
}

/** Uploads files dropped on the page (HTML drag and drop) and returns their server paths. */
export async function uploadDropped(dataTransfer: DataTransfer, extensions?: string[]): Promise<string[]> {
  let files = Array.from(dataTransfer.files);
  if (extensions) files = filterByExtension(files, extensions);
  const uploaded = await uploadFiles(files);
  return uploaded.map((u) => u.path);
}

/** Saves bytes as a file through the browser. */
export function downloadBlob(data: Blob | ArrayBuffer | Uint8Array, fileName: string, mimeType = "application/octet-stream"): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before freeing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Downloads a file stored on the server under `fileName`. */
export async function downloadServerFile(path: string, fileName: string): Promise<void> {
  downloadBlob(await fetchServerBlob(path), fileName);
}

/** Last path component, for showing a server path to the user ("…/abc/Espelho.pdf" → "Espelho.pdf"). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
