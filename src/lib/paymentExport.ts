import { save } from "@tauri-apps/plugin-dialog";
import ExcelJS from "exceljs";
import { writeBinaryFile } from "./api";
import { getPaymentExportTemplate, listPaymentShiftsForReport, type ListPaymentShiftSummariesQuery, type PaymentShiftReportRow } from "./db";
import { formatTimestampForFileName, sanitizeFileName } from "./format";
import { buildShiftValueResolver } from "./paymentShiftValue";
import {
  applyColumnAutoFit,
  findValorColumnIndex,
  groupKeyValue,
  pxToExcelWidth,
  renderSumCell,
  renderTemplateCell,
  writeTemplateRow,
  type SumFormulaRange,
} from "./paymentExportGrid";
import type { PaymentExportTemplateConfig } from "./types";

export interface PaymentExportResult {
  /** How many turnos actually made it into the sheet — can be 0 even when `matchedCount` isn't, since a turno with no computed value yet is excluded (see the filter below). */
  rowCount: number;
  /** Same idea as `PaymentsReportResult.matchedCount` in `paymentsReport.ts` — how many turnos matched the filters *before* the "has a value" filter, so the caller can tell "nothing matched" apart from "turnos matched, but none has a payment value yet". */
  matchedCount: number;
  /** Wherever the user chose to save it — `null` when there were no matching rows (nothing was generated) or the save dialog was cancelled. */
  path: string | null;
  title: string;
}

/**
 * Generates a payment-shifts export using a saved `PaymentExportTemplate` —
 * the xlsx counterpart of `generatePaymentsReportPdf` in `paymentsReport.ts`,
 * built entirely client-side (see that file's own doc comment for why: this
 * app never generates a report file in Rust, only ever writes finished
 * bytes it's handed). The template's grid (built in `TemplateGridEditor`)
 * supplies every row's text/background color; this function only ever
 * repeats the marked detail row once per shift (grouped/sorted per the
 * template's `groupBy`), and the separator/subtotal rows once per group.
 * The actual token-substitution/row-writing logic lives in
 * `paymentExportGrid.ts` (kept Tauri-free so it can be unit tested
 * directly).
 */
export async function generatePaymentsExportXlsx(
  templateId: number,
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<PaymentExportResult> {
  const template = await getPaymentExportTemplate(templateId);
  const config: PaymentExportTemplateConfig = template.config;
  const grid = config.grid;

  const allRows = await listPaymentShiftsForReport(query);
  if (allRows.length === 0) {
    return { rowCount: 0, matchedCount: 0, path: null, title: template.name };
  }

  const shiftValue = await buildShiftValueResolver(allRows);

  // Same "no value = nothing to report" rule as the PDF export (see
  // paymentsReport.ts) — a row with a null or literal-zero amount is left
  // out of the sheet entirely rather than written with a blank/zero Valor.
  const rows = allRows.filter((r) => {
    const value = shiftValue(r);
    return value !== null && value !== 0;
  });
  if (rows.length === 0) {
    return { rowCount: 0, matchedCount: allRows.length, path: null, title: template.name };
  }

  const amounts = new Map<PaymentShiftReportRow, number | null>(rows.map((r) => [r, shiftValue(r)]));

  function detailGroupKeyOf(row: PaymentShiftReportRow): string {
    return config.groupBy.map((f) => groupKeyValue(f, row, amounts.get(row) ?? null)).join(" ");
  }
  // Falls back to `groupBy` for a template saved before this field existed
  // — see this field's own doc comment on `PaymentExportTemplateConfig`.
  const subtotalGroupByFields = config.subtotalGroupBy ?? config.groupBy;
  function subtotalGroupKeyOf(row: PaymentShiftReportRow): string {
    return subtotalGroupByFields.map((f) => groupKeyValue(f, row, amounts.get(row) ?? null)).join(" ");
  }

  // Sorted primarily by the SOMA grouping, secondarily by the turno
  // grouping — guarantees every SOMA group is a contiguous run of whole
  // turno-groups (never split one mid-way), which is what lets the single
  // pass below track both boundaries with simple accumulators instead of a
  // full two-pass grouping. Stable sort (guaranteed by the spec since
  // ES2019) keeps rows within an unchanged key pair in their original
  // relative order, which is already work_date/local/employeeName from the
  // SQL query itself — same as before this field existed, when the two
  // groupings were always identical.
  const sorted = [...rows].sort((a, b) => {
    const ask = subtotalGroupKeyOf(a);
    const bsk = subtotalGroupKeyOf(b);
    if (ask !== bsk) return ask < bsk ? -1 : 1;
    const adk = detailGroupKeyOf(a);
    const bdk = detailGroupKeyOf(b);
    return adk < bdk ? -1 : adk > bdk ? 1 : 0;
  });

  const workbook = new ExcelJS.Workbook();
  const sheetName = sanitizeFileName(template.name).slice(0, 31) || "Pagamentos";
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = grid.columnWidths.map((w) => ({ width: pxToExcelWidth(w) }));

  // Static header block (everything above the detail row) — written once,
  // verbatim, at the same row numbers it has in the template. `honorRowSpan`
  // is only ever true here — a header row isn't repeated, so a merge on it
  // can safely span multiple rows.
  for (let r = 0; r < config.detailRowIndex; r++) {
    writeTemplateRow(sheet, grid, r, r + 1, { honorRowSpan: true });
  }

  // Which column the SOMA row's `{{valorSoma}}` cell should SUM() over — the
  // detail row's own `{{valor}}` column, so the exported total is a live
  // Excel formula (matching the user's original manual ledger) instead of a
  // precomputed static number. `null` when the detail row has no exact
  // `{{valor}}` cell to reference (falls back to a static number).
  const valorColumnIndex = findValorColumnIndex(grid, config.detailRowIndex);

  // Separator and SOMA are written after a group's detail rows in whichever
  // order the template itself has them (by row index) — the template's own
  // layout decides which one comes first, not a hardcoded order.
  const trailingRows: Array<{ kind: "separator" | "subtotal"; rowIndex: number }> = [];
  if (config.separator?.enabled) trailingRows.push({ kind: "separator", rowIndex: config.separator.rowIndex });
  if (config.subtotal?.enabled) trailingRows.push({ kind: "subtotal", rowIndex: config.subtotal.rowIndex });
  trailingRows.sort((a, b) => a.rowIndex - b.rowIndex);

  let nextRow = config.detailRowIndex + 1;
  let index = 0;
  // Accumulate across however many turno-groups make up the *current* SOMA
  // group — reset only when a SOMA boundary is actually crossed below, not
  // on every turno-group like `sum` (the per-turno-group total the detail
  // loop itself doesn't need to track anymore, now that SOMA has its own
  // grouping).
  let subtotalFirstRow = nextRow;
  let subtotalSum = 0;
  while (index < sorted.length) {
    const detailKey = detailGroupKeyOf(sorted[index]);
    const subtotalKeyAtStart = subtotalGroupKeyOf(sorted[index]);
    while (
      index < sorted.length &&
      detailGroupKeyOf(sorted[index]) === detailKey &&
      subtotalGroupKeyOf(sorted[index]) === subtotalKeyAtStart
    ) {
      const row = sorted[index];
      const amount = amounts.get(row) ?? null;
      subtotalSum += amount ?? 0;
      writeTemplateRow(sheet, grid, config.detailRowIndex, nextRow, {
        renderCell: (_c, raw) => renderTemplateCell(raw, row, amount),
      });
      nextRow++;
      index++;
    }

    // Every SOMA group is a contiguous run of whole turno-groups (see the
    // sort above), so crossing a SOMA boundary can only ever happen right
    // here, between two turno-groups — never mid-group.
    const atSubtotalBoundary = index >= sorted.length || subtotalGroupKeyOf(sorted[index]) !== subtotalKeyAtStart;
    const formulaRange: SumFormulaRange | null =
      valorColumnIndex !== null ? { columnIndex: valorColumnIndex, firstRow: subtotalFirstRow, lastRow: nextRow - 1 } : null;

    // The separator always fires per turno-group boundary; SOMA only fires
    // once its own (possibly wider) group is fully done — skipping it here
    // leaves `trailing.rowIndex`'s relative order against the separator
    // intact for whichever boundary it does fire on, same layout-decides-
    // the-order rule as before this field existed.
    for (const trailing of trailingRows) {
      if (trailing.kind === "separator") {
        writeTemplateRow(sheet, grid, trailing.rowIndex, nextRow);
        nextRow++;
      } else if (atSubtotalBoundary) {
        writeTemplateRow(sheet, grid, trailing.rowIndex, nextRow, {
          renderCell: (_c, raw) => renderSumCell(raw, subtotalSum, formulaRange),
        });
        nextRow++;
      }
    }

    if (atSubtotalBoundary) {
      subtotalSum = 0;
      subtotalFirstRow = nextRow;
    }
  }

  // "Ajustar ao maior registro" columns (right-click a column header to
  // toggle) ignore their fixed `columnWidths` entry — only knowable now,
  // after every row (header + every repeated record + separator/SOMA) has
  // actually been written, since it depends on the real exported values,
  // not just the template.
  applyColumnAutoFit(sheet, grid);

  const buffer = await workbook.xlsx.writeBuffer();

  const destPath = await save({
    defaultPath: `${sanitizeFileName(template.name)}-${formatTimestampForFileName()}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!destPath) return { rowCount: rows.length, matchedCount: allRows.length, path: null, title: template.name };

  await writeBinaryFile(destPath, new Uint8Array(buffer));

  return { rowCount: rows.length, matchedCount: allRows.length, path: destPath, title: template.name };
}
