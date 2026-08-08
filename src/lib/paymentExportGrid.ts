import type ExcelJS from "exceljs";
import { columnLetter, formatDateSlash, formatMinutesAsTime } from "./format";
import { PAYMENT_SHIFT_STATUS_LABELS, type PaymentExportBindableField } from "./types";
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
    field === "shiftPeriod" ||
    field === "valor" ||
    field === "status" ||
    field === "employeeName"
  );
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

export function parseCellName(name: string): { col: number; row: number } {
  const m = name.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`Célula inválida no template: ${name}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

interface ParsedCellStyle {
  bgColor?: string;
  fontColor?: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
}

/** `rgb(255, 255, 0)` / `#ffff00` -> `"FFFFFF00"` (ARGB, opaque) — the shape ExcelJS's `fgColor.argb` wants. */
export function cssColorToArgb(css: string): string | undefined {
  const rgb = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) {
    return "FF" + rgb.slice(1, 4).map((c) => Number(c).toString(16).padStart(2, "0").toUpperCase()).join("");
  }
  const hex = css.match(/^#([0-9a-fA-F]{6})$/);
  return hex ? "FF" + hex[1].toUpperCase() : undefined;
}

/** jspreadsheet-ce stores a cell's style as a semicolon-separated CSS string (e.g. `"background-color: rgb(255,255,0); font-weight: bold;"`) — parsed once here into the handful of properties ExcelJS needs. */
export function parseCellStyle(styleStr: string | undefined): ParsedCellStyle {
  if (!styleStr) return {};
  const result: ParsedCellStyle = {};
  for (const decl of styleStr.split(";")) {
    const [rawKey, ...rest] = decl.split(":");
    const key = rawKey?.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!key || !val) continue;
    if (key === "background-color") result.bgColor = cssColorToArgb(val);
    else if (key === "color") result.fontColor = cssColorToArgb(val);
    else if (key === "font-weight") result.bold = val === "bold" || Number(val) >= 700;
    else if (key === "font-style") result.italic = val === "italic";
    else if (key === "text-align" && (val === "left" || val === "center" || val === "right")) result.align = val;
  }
  return result;
}

export function applyStyleToCell(cell: ExcelJS.Cell, styleStr: string | undefined) {
  const style = parseCellStyle(styleStr);
  if (style.bgColor) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.bgColor } };
  if (style.bold || style.italic || style.fontColor) {
    cell.font = { bold: style.bold, italic: style.italic, color: style.fontColor ? { argb: style.fontColor } : undefined };
  }
  if (style.align) cell.alignment = { horizontal: style.align };
}

export interface TemplateGrid {
  data: (string | number | boolean)[][];
  style?: Record<string, string>;
  mergeCells?: Record<string, [number, number, ...unknown[]]>;
  columns?: { width?: number | string }[];
}

/** Excel's column width unit is "characters of the default font", not pixels — jspreadsheet-ce's own widths are pixels, so this is an approximate conversion (Excel's own rule of thumb: `(pixels - 5) / 7`), not a pixel-perfect match. */
export function pxToExcelWidth(px: number | string | undefined): number {
  const n = typeof px === "string" ? Number(px) : px;
  if (!n || Number.isNaN(n)) return 12;
  return Math.max(4, Math.round((n - 5) / 7));
}

/** Copies one template row (values + per-cell style + merges anchored on it) into the workbook at `destRowNumber` (1-based), optionally substituting each cell's text via `renderCell`. Used for the static header block (identity mapping, no substitution) and for every repeated detail/separator/subtotal row. */
export function writeTemplateRow(
  sheet: ExcelJS.Worksheet,
  grid: TemplateGrid,
  templateRowIndex: number,
  destRowNumber: number,
  colCount: number,
  renderCell?: (colIndex: number, rawValue: string) => string | number,
) {
  const templateValues = grid.data[templateRowIndex] ?? [];
  const destRow = sheet.getRow(destRowNumber);
  for (let c = 0; c < colCount; c++) {
    const raw = String(templateValues[c] ?? "");
    const value = renderCell ? renderCell(c, raw) : raw;
    const cell = destRow.getCell(c + 1);
    cell.value = value === "" ? null : value;
    applyStyleToCell(cell, grid.style?.[`${columnLetter(c)}${templateRowIndex + 1}`]);
  }
  for (const [name, span] of Object.entries(grid.mergeCells ?? {})) {
    const anchor = parseCellName(name);
    if (anchor.row !== templateRowIndex) continue;
    const colspan = span[0] ?? 1;
    // Repeated (detail/separator/subtotal) rows are always exactly one
    // physical row per record — a template row marked with one of those
    // roles isn't expected to carry a vertical (rowspan>1) merge, only
    // horizontal. Capped here rather than honored, so a stray rowspan on
    // one of those roles can't silently swallow the next record's row.
    if (colspan > 1) {
      sheet.mergeCells(destRowNumber, anchor.col + 1, destRowNumber, anchor.col + colspan);
    }
  }
}
