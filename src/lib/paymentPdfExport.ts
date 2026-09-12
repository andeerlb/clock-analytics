import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "./api";
import { getPaymentPdfTemplate, listPaymentShiftsForReport, type ListPaymentShiftSummariesQuery, type PaymentShiftReportRow } from "./db";
import { formatTimestampForFileName, sanitizeFileName } from "./format";
import { buildShiftValueResolver } from "./paymentShiftValue";
import { groupKeyValue } from "./paymentExportGrid";
import {
  PdfGridPainter,
  renderPdfCellText,
  renderPdfGroupCell,
  renderPdfSumCell,
} from "./paymentPdfGrid";
import type { PaymentPdfTemplateConfig } from "./types";

export interface PaymentPdfExportResult {
  /** How many turnos actually made it into the PDF — can be 0 even when `matchedCount` isn't, since a turno with no computed value yet is excluded (see the filter below). */
  rowCount: number;
  /** Same idea as `PaymentsReportResult.matchedCount` — how many turnos matched the filters *before* the "has a value" filter. */
  matchedCount: number;
  /** Wherever the user chose to save it — `null` when there were no matching rows (nothing was generated) or the save dialog was cancelled. Hand this straight to `PdfViewerModal`. */
  path: string | null;
  title: string;
}

/**
 * Generates a payment-shifts PDF using a saved PDF template — the
 * template-driven counterpart of `generatePaymentsReportPdf` (hand-built
 * layout) and the PDF twin of `generatePaymentsExportXlsx`. The template's
 * grid (built in the same `TemplateGridEditor`) supplies every row's text and
 * styling; the `PdfGridPainter` (see `paymentPdfGrid.ts`) draws it, breaking
 * pages and repeating the static header block. Deliberately simpler than the
 * Excel flow: no outline, no consolidated rows, and the SOMA row always breaks
 * on `groupBy` — everything a PDF has no meaningful equivalent for.
 */
export async function generatePaymentsPdfExport(
  templateId: number,
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<PaymentPdfExportResult> {
  const template = await getPaymentPdfTemplate(templateId);
  const config: PaymentPdfTemplateConfig = template.config;
  const grid = config.grid;

  const allRows = await listPaymentShiftsForReport(query);
  if (allRows.length === 0) {
    return { rowCount: 0, matchedCount: 0, path: null, title: template.name };
  }

  const shiftValue = await buildShiftValueResolver(allRows);

  // Same "no value = nothing to report" rule as both other exports — a row
  // with a null or literal-zero amount is left out entirely rather than
  // written with a blank/zero Valor.
  const rows = allRows.filter((r) => {
    const value = shiftValue(r);
    return value !== null && value !== 0;
  });
  if (rows.length === 0) {
    return { rowCount: 0, matchedCount: allRows.length, path: null, title: template.name };
  }

  const amounts = new Map<PaymentShiftReportRow, number | null>(rows.map((r) => [r, shiftValue(r)]));

  function groupKeyOf(row: PaymentShiftReportRow): string {
    return config.groupBy.map((f) => groupKeyValue(f, row, amounts.get(row) ?? null)).join(" ");
  }

  // Groups must be contiguous runs, so sort by the same key that decides
  // boundaries — same rule as the Excel export's sort (minus the independent
  // SOMA grouping, which PDF templates don't have), with the detail fields as
  // a stable tiebreaker inside each group.
  const sorted = [...rows].sort((a, b) => {
    const groupCompare = groupKeyOf(a).localeCompare(groupKeyOf(b), undefined, { numeric: true });
    if (groupCompare !== 0) return groupCompare;
    return (
      a.workDate.localeCompare(b.workDate) ||
      a.employeeName.localeCompare(b.employeeName) ||
      (a.scheduleStartMinutes ?? -1) - (b.scheduleStartMinutes ?? -1)
    );
  });

  const painter = new PdfGridPainter(grid, { orientation: config.orientation ?? "landscape" });

  // The static block (rows above the detail row) is written once at the top,
  // verbatim — and again at the top of every page the report spills onto.
  const headerRows: number[] = [];
  for (let r = 0; r < config.detailRowIndex && r < grid.rows.length; r++) headerRows.push(r);
  painter.setHeaderRows(headerRows);
  for (const r of headerRows) painter.drawRow(r, { honorRowSpan: true });

  // Each group: optional header row, one detail row per turno, then the
  // template's trailing rows (separator / SOMA) in the order they sit in the
  // grid itself — same layout-decides-the-order rule as the Excel export.
  const trailing = [
    ...(config.separator?.enabled
      ? [{ kind: "separator" as const, rowIndex: config.separator.rowIndex }]
      : []),
    ...(config.subtotal?.enabled
      ? [{ kind: "subtotal" as const, rowIndex: config.subtotal.rowIndex }]
      : []),
  ].sort((a, b) => a.rowIndex - b.rowIndex);

  let currentKey: string | null = null;
  let groupRows: PaymentShiftReportRow[] = [];
  let sums = { valor: 0, workedHoursMinutes: 0 };

  function flushGroup() {
    if (groupRows.length === 0) return;
    if (config.groupHeader?.enabled) {
      painter.drawRow(config.groupHeader.rowIndex, {
        renderCell: (_c, raw) => renderPdfGroupCell(raw, groupRows, amounts),
      });
    }
    for (const row of groupRows) {
      const amount = amounts.get(row) ?? null;
      painter.drawRow(config.detailRowIndex, {
        renderCell: (_c, raw) => renderPdfCellText(raw, row, amount),
      });
    }
    for (const trailingRow of trailing) {
      if (trailingRow.kind === "separator") {
        painter.drawRow(trailingRow.rowIndex);
      } else {
        painter.drawRow(trailingRow.rowIndex, {
          renderCell: (_c, raw) => renderPdfSumCell(raw, sums),
        });
      }
    }
    groupRows = [];
    sums = { valor: 0, workedHoursMinutes: 0 };
  }

  for (const row of sorted) {
    const key = groupKeyOf(row);
    if (currentKey === null) currentKey = key;
    if (key !== currentKey) {
      flushGroup();
      currentKey = key;
    }
    groupRows.push(row);
    sums.valor += amounts.get(row) ?? 0;
    const start = row.scheduleStartMinutes;
    const end = row.scheduleEndMinutes;
    if (start !== null && end !== null) {
      sums.workedHoursMinutes += start <= end ? end - start : 24 * 60 - start + end;
    }
  }
  flushGroup();

  const destPath = await save({
    defaultPath: `${sanitizeFileName(template.name)}-${formatTimestampForFileName()}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!destPath) return { rowCount: rows.length, matchedCount: allRows.length, path: null, title: template.name };

  const bytes = new Uint8Array(painter.doc.output("arraybuffer"));
  await writeBinaryFile(destPath, bytes);

  return { rowCount: rows.length, matchedCount: allRows.length, path: destPath, title: template.name };
}
