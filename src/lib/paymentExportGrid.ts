import type ExcelJS from "exceljs";
import { formatDateSlash, formatMinutesAsTime, shiftDurationMinutes } from "./format";
import { PAYMENT_SHIFT_STATUS_LABELS, type PaymentExportBindableField, type TemplateGridData } from "./types";
import type { PaymentShiftReportRow } from "./db";

/**
 * Everything `paymentExport.ts` needs that has NO Tauri dependency — split
 * out on purpose so this file (the actual grid/style/token logic, the part
 * most worth getting right) can be unit-tested in plain Node against a real
 * `exceljs` workbook, without needing the Tauri runtime `paymentExport.ts`
 * itself requires (SQL plugin, save dialog, fs write).
 */

const SHIFT_PERIOD_LABELS: Record<"diurno" | "noturno", string> = { diurno: "Diurno", noturno: "Noturno" };

const TOKEN_RE = /\{\{(\w+)\}\}/g;
const EXACT_TOKEN_RE = /^\{\{(\w+)\}\}$/;

export function isBindableField(field: string): field is PaymentExportBindableField {
  return (
    field === "companyName" ||
    field === "clientName" ||
    field === "local" ||
    field === "workDate" ||
    field === "role" ||
    field === "horario" ||
    field === "workedHours" ||
    field === "shiftPeriod" ||
    field === "valor" ||
    field === "status" ||
    field === "employeeName"
  );
}

/** A shift's worked duration in minutes, or `null` when it has no parsed schedule to compute one from — shared by `fieldDisplayValue`/`groupKeyValue`'s "workedHours" case. */
function workedMinutes(row: PaymentShiftReportRow): number | null {
  return row.scheduleStartMinutes !== null && row.scheduleEndMinutes !== null
    ? shiftDurationMinutes(row.scheduleStartMinutes, row.scheduleEndMinutes)
    : null;
}

/** A shift's displayable text for one bindable field — used when a token is mixed into other text in a cell (so the whole cell has to become one string), or for any field that isn't `valor` even in an exact-token cell. */
export function fieldDisplayValue(field: PaymentExportBindableField, row: PaymentShiftReportRow, amount: number | null): string {
  switch (field) {
    case "companyName":
      return row.companyName;
    case "clientName":
      return row.clientName;
    case "local":
      return row.local;
    case "workDate":
      return formatDateSlash(row.workDate);
    case "role":
      return row.role;
    case "horario":
      return row.scheduleStartMinutes !== null && row.scheduleEndMinutes !== null
        ? `${formatMinutesAsTime(row.scheduleStartMinutes)} - ${formatMinutesAsTime(row.scheduleEndMinutes)}`
        : "";
    case "workedHours": {
      const minutes = workedMinutes(row);
      return minutes !== null ? formatMinutesAsTime(minutes) : "";
    }
    case "shiftPeriod":
      return row.shiftPeriod ? SHIFT_PERIOD_LABELS[row.shiftPeriod] : "";
    case "valor":
      return amount !== null ? String(amount) : "";
    case "status":
      return PAYMENT_SHIFT_STATUS_LABELS[row.status];
    case "employeeName":
      return row.employeeName;
    default:
      return "";
  }
}

/**
 * The raw, sortable value behind a groupBy field — deliberately NOT
 * `fieldDisplayValue` (a locale-formatted "dd/mm/yyyy" wouldn't sort
 * chronologically, e.g. "05/08" < "12/07" lexically even though July comes
 * first). Decides both group boundaries (equality) and group order
 * (comparison).
 */
export function groupKeyValue(field: PaymentExportBindableField, row: PaymentShiftReportRow, amount: number | null): string {
  switch (field) {
    case "companyName":
      return row.companyName;
    case "clientName":
      return row.clientName;
    case "local":
      return row.local;
    case "workDate":
      return row.workDate;
    case "role":
      return row.role;
    case "horario":
      return `${row.scheduleStartMinutes ?? -1}-${row.scheduleEndMinutes ?? -1}`;
    case "workedHours":
      // Zero-padded (unlike the other raw keys above) so lexical comparison
      // sorts groups by ACTUAL duration — "60" would otherwise sort before
      // "120" as plain strings.
      return String(workedMinutes(row) ?? -1).padStart(4, "0");
    case "shiftPeriod":
      return row.shiftPeriod ?? "";
    case "valor":
      return String(amount ?? "");
    case "status":
      return row.status;
    case "employeeName":
      return row.employeeName;
    default:
      return "";
  }
}

/** A cell's raw template text -> what actually gets written to the exported cell. An exact `{{valor}}` (nothing else in the cell) becomes a real number, so it's summable/formats as currency in Excel; a token mixed into other text, or any other field, becomes a substituted string. Unknown/unrecognized tokens are left as-is, visibly, rather than silently vanishing. */
export function renderTemplateCell(rawValue: string, row: PaymentShiftReportRow, amount: number | null): string | number {
  const trimmed = rawValue.trim();
  const exact = trimmed.match(EXACT_TOKEN_RE);
  if (exact) {
    const field = exact[1];
    if (!isBindableField(field)) return rawValue;
    if (field === "valor") return amount ?? 0;
    return fieldDisplayValue(field, row, amount);
  }
  if (!rawValue.includes("{{")) return rawValue;
  return rawValue.replace(TOKEN_RE, (whole, field) => (isBindableField(field) ? fieldDisplayValue(field, row, amount) : whole));
}

/** "#rrggbb" -> "FFRRGGBB" (ARGB, opaque) — the shape ExcelJS's `fgColor.argb` wants. */
function hexToArgb(hex: string): string {
  return "FF" + hex.replace("#", "").toUpperCase();
}

/** Excel's column width unit is "characters of the default font", not pixels — the grid editor's own widths are pixels, so this is an approximate conversion (Excel's own rule of thumb: `(pixels - 5) / 7`), not a pixel-perfect match. */
export function pxToExcelWidth(px: number): number {
  if (!px || Number.isNaN(px)) return 12;
  return Math.max(4, Math.round((px - 5) / 7));
}

/** Excel row height is in points, not pixels — `px * 0.75` is the standard 96dpi-screen-px-to-point conversion, same rough-approximation spirit as `pxToExcelWidth`. */
export function pxToExcelPoints(px: number): number {
  if (!px || Number.isNaN(px)) return 15;
  return Math.max(6, Math.round(px * 0.75));
}

export interface WriteTemplateRowOptions {
  /** Substitutes each cell's raw text — used for repeating detail/separator/subtotal rows; omitted for the static header block, which is written verbatim. */
  renderCell?: (colIndex: number, rawValue: string) => string | number;
  /**
   * Only true for the static header block (written once, at its real
   * unshifted row). A repeating detail/separator/subtotal row caps every
   * merge anchored on it to its own single row (colSpan only, rowSpan
   * forced to 1) — a merge that spanned rows would bleed into whatever the
   * next repeated record writes on the following row.
   */
  honorRowSpan?: boolean;
}

/** Copies one template row (values, per-cell background/text color/bold/italic/font, and any merge anchored on it) into the workbook at `destRowNumber` (1-based). Used for the static header block (identity mapping, no substitution) and for every repeated detail/separator/subtotal row. */
export function writeTemplateRow(
  sheet: ExcelJS.Worksheet,
  grid: TemplateGridData,
  templateRowIndex: number,
  destRowNumber: number,
  options: WriteTemplateRowOptions = {},
) {
  const templateRow = grid.rows[templateRowIndex] ?? [];
  const destRow = sheet.getRow(destRowNumber);
  const rowHeight = grid.rowHeights?.[templateRowIndex];
  if (rowHeight) destRow.height = pxToExcelPoints(rowHeight);

  templateRow.forEach((templateCell, c) => {
    const value = options.renderCell ? options.renderCell(c, templateCell.value) : templateCell.value;
    const destCell = destRow.getCell(c + 1);
    destCell.value = value === "" ? null : value;
    if (templateCell.backgroundColor) {
      destCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hexToArgb(templateCell.backgroundColor) } };
    }
    if (templateCell.bold || templateCell.italic || templateCell.fontColor || templateCell.fontFamily || templateCell.fontSize) {
      destCell.font = {
        bold: templateCell.bold || undefined,
        italic: templateCell.italic || undefined,
        color: templateCell.fontColor ? { argb: hexToArgb(templateCell.fontColor) } : undefined,
        name: templateCell.fontFamily ?? undefined,
        size: templateCell.fontSize ?? undefined,
      };
    }
  });

  for (const merge of grid.merges ?? []) {
    if (merge.row !== templateRowIndex) continue;
    const rowSpan = options.honorRowSpan ? merge.rowSpan : 1;
    sheet.mergeCells(destRowNumber, merge.col + 1, destRowNumber + rowSpan - 1, merge.col + merge.colSpan);
  }
}
