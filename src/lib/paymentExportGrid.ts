import type ExcelJS from "exceljs";
import { columnLetter, formatDateSlash, formatMinutesAsTime, shiftDurationMinutes } from "./format";
import { PAYMENT_SHIFT_STATUS_LABELS, type CellBorderSide, type PaymentExportBindableField, type TemplateGridData } from "./types";
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
        ? `${formatMinutesAsTime(row.scheduleStartMinutes)} às ${formatMinutesAsTime(row.scheduleEndMinutes)}`
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

/** "2026-07-01" -> a real UTC-midnight `Date` for that calendar day — written as an Excel date VALUE (not a "dd/mm/yyyy" string) so the cell is a genuine date type in Excel, not text that merely looks like one. UTC (not local) midnight, matching every other ISO-date parse in this codebase (see `calendar.ts`), so the day never shifts under a non-UTC system clock. */
function isoDateToUtcDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** A cell's raw template text -> what actually gets written to the exported cell. An exact `{{valor}}` becomes a real number (currency-formatted at write time, see `writeTemplateRow`); an exact `{{workDate}}` becomes a real `Date` (date-formatted at write time); either mixed into other text, or any other field, becomes a substituted string. Unknown/unrecognized tokens are left as-is, visibly, rather than silently vanishing. */
export function renderTemplateCell(rawValue: string, row: PaymentShiftReportRow, amount: number | null): string | number | Date {
  const trimmed = rawValue.trim();
  const exact = trimmed.match(EXACT_TOKEN_RE);
  if (exact) {
    const field = exact[1];
    if (!isBindableField(field)) return rawValue;
    if (field === "valor") return amount ?? 0;
    if (field === "workDate") return isoDateToUtcDate(row.workDate);
    return fieldDisplayValue(field, row, amount);
  }
  if (!rawValue.includes("{{")) return rawValue;
  return rawValue.replace(TOKEN_RE, (whole, field) => (isBindableField(field) ? fieldDisplayValue(field, row, amount) : whole));
}

const SUM_TOKEN = "{{valorSoma}}";
const EXACT_SUM_TOKEN_RE = /^\{\{valorSoma\}\}$/;
const SUM_TOKEN_RE = /\{\{valorSoma\}\}/g;

/** Which cells to reference for a group's live `SUM()` formula — the detail row's `{{valor}}` column, across the exact rows just written for that group. */
export interface SumFormulaRange {
  /** 0-based column index of the detail row's `{{valor}}` cell. */
  columnIndex: number;
  /** 1-based sheet row numbers (inclusive) of the group's first/last written detail row. */
  firstRow: number;
  lastRow: number;
}

/**
 * A SOMA-row cell's raw template text -> what actually gets written for one
 * group's computed total. An exact `{{valorSoma}}` (nothing else in the
 * cell) becomes a live `SUM(...)` Excel formula over the detail row's
 * `{{valor}}` column (so it recalculates like a real spreadsheet, matching
 * how the user's original manual ledger does it) when `formulaRange` is
 * available; falls back to the precomputed number when the detail row has
 * no exact `{{valor}}` cell to reference. Mixed into other text (e.g.
 * "Total: {{valorSoma}}") it becomes a substituted string — a cell's value
 * can't be part-formula/part-text. A cell without the token is left exactly
 * as typed — the SOMA row otherwise behaves like the separator row (plain
 * static content), there's no separate "label column" concept to track.
 */
export function renderSumCell(rawValue: string, sum: number, formulaRange: SumFormulaRange | null): string | number | { formula: string } {
  const trimmed = rawValue.trim();
  if (EXACT_SUM_TOKEN_RE.test(trimmed)) {
    if (formulaRange) {
      const letter = columnLetter(formulaRange.columnIndex);
      return { formula: `SUM(${letter}${formulaRange.firstRow}:${letter}${formulaRange.lastRow})` };
    }
    return sum;
  }
  if (!rawValue.includes(SUM_TOKEN)) return rawValue;
  return rawValue.replace(SUM_TOKEN_RE, () => String(sum));
}

/** 0-based column index of the detail row's exact `{{valor}}` cell, or `null` if it doesn't have one — used to build the SOMA row's live formula range. */
export function findValorColumnIndex(grid: TemplateGridData, detailRowIndex: number): number | null {
  const row = grid.rows[detailRowIndex] ?? [];
  const index = row.findIndex((cell) => cell.value.trim() === "{{valor}}");
  return index === -1 ? null : index;
}

/** "#rrggbb" -> "FFRRGGBB" (ARGB, opaque) — the shape ExcelJS's `fgColor.argb` wants. */
function hexToArgb(hex: string): string {
  return "FF" + hex.replace("#", "").toUpperCase();
}

/**
 * `CellBorderSide` -> the shape ExcelJS's `destCell.border.{top,right,bottom,left}`
 * wants. The editor's own `width` is a free px number (see that field's own
 * doc comment), but real `.xlsx` borders only support Excel's fixed set of
 * named weights — this rounds the chosen width down to the nearest of
 * "thin"/"medium"/"thick" (Excel's own rough visual steps: 1px, 2-3px,
 * 4px+). `pattern` picks the border's dash motif independently: "double" is
 * its own named style regardless of width (Excel has no "double medium"),
 * "dashed"/"dotted" likewise ignore width (`.xlsx` has no numeric dash
 * width), and "solid" is the only pattern where width actually changes
 * which named style gets written.
 */
function borderSideToExcel(side: CellBorderSide | null): ExcelJS.Border | undefined {
  if (!side) return undefined;
  const argb = hexToArgb(side.color);
  if (side.pattern === "double") return { style: "double", color: { argb } };
  if (side.pattern === "dashed") return { style: "dashed", color: { argb } };
  if (side.pattern === "dotted") return { style: "dotted", color: { argb } };
  const style: ExcelJS.BorderStyle = side.width >= 4 ? "thick" : side.width >= 2 ? "medium" : "thin";
  return { style, color: { argb } };
}

/** Excel's column width unit is "characters of the default font", not pixels — the grid editor's own widths are pixels, so this is an approximate conversion (Excel's own rule of thumb: `(pixels - 5) / 7`), not a pixel-perfect match. */
export function pxToExcelWidth(px: number): number {
  if (!px || Number.isNaN(px)) return 12;
  return Math.max(4, Math.round((px - 5) / 7));
}

/** Matches `TemplateGridEditor`'s own `DEFAULT_ROW_HEIGHT` — used only as a last-resort fallback when a saved grid predates `rowHeights` entirely. */
const DEFAULT_ROW_HEIGHT_PX = 30;

/**
 * Excel's real number-format code for a BRL amount — applied to the CELL
 * (`numFmt`), never baked into the text itself, so it's a real formatted
 * number in Excel (sortable, summable, shows "R$" automatically) rather
 * than a string that happens to start with "R$". Applied to every cell
 * whose raw template text is an exact `{{valor}}` or `{{valorSoma}}` token
 * (see `writeTemplateRow`) — both the per-shift value and the SOMA total
 * must always render as currency, never as a bare number.
 */
const CURRENCY_NUM_FMT = '"R$" #,##0.00';

/** Excel's date number-format code — applied to the CELL (`numFmt`) of every exact `{{workDate}}` cell, alongside writing a real `Date` value (see `isoDateToUtcDate`), so Excel recognizes it as an actual date type (draggable fill, sortable as a date, "Formatar células" shows "Data"), not text that merely reads like one. */
const DATE_NUM_FMT = "dd/mm/yyyy";

/** Excel row height is in points, not pixels — `px * 0.75` is the standard 96dpi-screen-px-to-point conversion, same rough-approximation spirit as `pxToExcelWidth`. */
export function pxToExcelPoints(px: number): number {
  if (!px || Number.isNaN(px)) return 15;
  return Math.max(6, Math.round(px * 0.75));
}

export interface WriteTemplateRowOptions {
  /** Substitutes each cell's raw text — used for repeating detail/separator/subtotal rows; omitted for the static header block, which is written verbatim. */
  renderCell?: (colIndex: number, rawValue: string) => string | number | Date | { formula: string };
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
  // Always set explicitly (never left for Excel/Sheets to guess at) — every
  // call for the same `templateRowIndex` (e.g. every repeated detail-row
  // instance) must produce the exact same height, or a viewer app that
  // auto-adjusts row height per-cell-content can end up showing visibly
  // inconsistent row sizes down a repeated column even though the
  // underlying data is uniform.
  destRow.height = pxToExcelPoints(grid.rowHeights?.[templateRowIndex] ?? DEFAULT_ROW_HEIGHT_PX);

  templateRow.forEach((templateCell, c) => {
    const value = options.renderCell ? options.renderCell(c, templateCell.value) : templateCell.value;
    const destCell = destRow.getCell(c + 1);
    destCell.value = value === "" ? null : value;
    const rawToken = templateCell.value.trim();
    if (rawToken === "{{valor}}" || rawToken === "{{valorSoma}}") {
      destCell.numFmt = CURRENCY_NUM_FMT;
    } else if (rawToken === "{{workDate}}") {
      destCell.numFmt = DATE_NUM_FMT;
    }
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
    const border = templateCell.border;
    if (border && (border.top || border.right || border.bottom || border.left)) {
      destCell.border = {
        top: borderSideToExcel(border.top),
        right: borderSideToExcel(border.right),
        bottom: borderSideToExcel(border.bottom),
        left: borderSideToExcel(border.left),
      };
    }
    // `vertical` always defaults to "middle" (not left unset, which ExcelJS/
    // Excel would render as bottom-aligned) so the exported file matches
    // what the template editor has always shown — every cell there is
    // vertically centered by default, see `TemplateGridCell.verticalAlign`'s
    // own doc comment.
    destCell.alignment = {
      horizontal: templateCell.horizontalAlign ?? undefined,
      vertical: templateCell.verticalAlign ?? "middle",
    };
  });

  for (const merge of grid.merges ?? []) {
    if (merge.row !== templateRowIndex) continue;
    const rowSpan = options.honorRowSpan ? merge.rowSpan : 1;
    sheet.mergeCells(destRowNumber, merge.col + 1, destRowNumber + rowSpan - 1, merge.col + merge.colSpan);
  }
}

/**
 * Resizes every column marked `columnAutoFit` to fit the longest value
 * actually written into it ("ajustar ao maior registro") — call this only
 * after every row (header + every repeated detail/separator/subtotal
 * instance) has been written, since it depends on the real exported
 * values, not just the template. A column left at the default (fixed)
 * keeps whatever was already set from `columnWidths`/`pxToExcelWidth`.
 */
export function applyColumnAutoFit(sheet: ExcelJS.Worksheet, grid: TemplateGridData) {
  grid.columnAutoFit?.forEach((autoFit, c) => {
    if (!autoFit) return;
    const column = sheet.getColumn(c + 1);
    let maxLength = 0;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const text = cell.value === null || cell.value === undefined ? "" : String(cell.value);
      maxLength = Math.max(maxLength, text.length);
    });
    column.width = Math.max(4, maxLength + 2);
  });
}
