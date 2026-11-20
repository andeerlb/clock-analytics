/**
 * The columns a payment template leaves unmapped ("Outras colunas da
 * planilha"): `payment_shifts.extra_data` keeps each one's raw cell text by
 * column letter, and `source_file_columns` (per imported file + aba) says
 * what that column is — its header text and, for an Excel date/time cell,
 * which kind. The raw text is never rewritten (the automatic verification
 * compares it with the file as-is); it's only formatted for display here.
 */

/** What a turno's `extraColumns` holds per column letter. */
export interface ExtraColumnInfo {
  header: string | null;
  kind: string | null;
}

/** What `savePaymentShifts` stores per file+aba+column. */
export interface SourceColumnInput {
  sourceFileId: number;
  sheetName: string | null;
  columnLetter: string;
  header: string | null;
  kind: string | null;
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * An Excel date/time cell's raw serial (days since 1899-12-30, the time as
 * the fraction of a day) shown as what it is: "06:00", "20/11/2026" or
 * "20/11/2026 06:00". Anything else — no kind, or text that isn't a number —
 * comes back unchanged.
 */
export function formatExtraValue(raw: string, kind: string | null | undefined): string {
  if (kind !== "time" && kind !== "date" && kind !== "datetime") return raw;
  const serial = Number(raw);
  if (!Number.isFinite(serial)) return raw;
  // Rounded to the minute, so 0.2499999 still reads 06:00.
  const d = new Date(EXCEL_EPOCH_MS + Math.round(serial * 1440) * 60_000);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (kind === "time") return time;
  const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return kind === "date" ? date : `${date} ${time}`;
}

export interface ExtraColumnEntry {
  key: string;
  /** The column letter, when the key is one ("E"); `null` for an older free-text key. */
  letter: string | null;
  /** The header read from the file, or `null` when there was none. */
  header: string | null;
  value: string;
}

/** A turno's extra columns in sheet order (A–Z before AA), each with its header and display value. */
export function extraColumnEntries(
  extraData: Record<string, string> | null,
  extraColumns: Record<string, ExtraColumnInfo> | null | undefined,
): ExtraColumnEntry[] {
  if (!extraData) return [];
  return Object.entries(extraData)
    .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
    .map(([key, raw]) => {
      const info = extraColumns?.[key];
      const letter = /^[A-Z]+$/i.test(key) ? key.toUpperCase() : null;
      return {
        key,
        letter,
        header: info?.header?.trim() || (letter ? null : key),
        value: formatExtraValue(raw, info?.kind),
      };
    });
}

interface PreviewRowLike {
  sheetName: string | null;
  workDate: string | null;
  extraFields: Record<string, string>;
  extraKinds: Record<string, string>;
}

/**
 * Per aba of one imported file, what each unmapped column is. The header is
 * the row right above the first row with a date — the same "not data" rule
 * the import already uses to skip title/header rows; a column with nothing
 * there gets no header. The kind is the first date/time kind seen for that
 * column among the data rows.
 */
export function buildSourceColumns(sourceFileId: number, rows: PreviewRowLike[]): SourceColumnInput[] {
  const bySheet = new Map<string, PreviewRowLike[]>();
  for (const row of rows) {
    const key = row.sheetName ?? "";
    const list = bySheet.get(key);
    if (list) list.push(row);
    else bySheet.set(key, [row]);
  }
  const out: SourceColumnInput[] = [];
  for (const sheetRows of bySheet.values()) {
    const firstData = sheetRows.findIndex((r) => r.workDate !== null);
    if (firstData === -1) continue;
    const headerRow = firstData > 0 ? sheetRows[firstData - 1] : null;
    const kinds = new Map<string, string>();
    const letters = new Set<string>();
    for (const r of sheetRows.slice(firstData)) {
      if (r.workDate === null) continue;
      for (const letter of Object.keys(r.extraFields)) letters.add(letter);
      for (const [letter, kind] of Object.entries(r.extraKinds)) if (!kinds.has(letter)) kinds.set(letter, kind);
    }
    for (const letter of letters) {
      const header = headerRow?.extraFields[letter]?.trim() || null;
      const kind = kinds.get(letter) ?? null;
      if (!header && !kind) continue;
      out.push({ sourceFileId, sheetName: sheetRows[0].sheetName, columnLetter: letter, header, kind });
    }
  }
  return out;
}
