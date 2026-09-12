import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "./api";
import { getPaymentPdfTemplate, listPaymentShiftsForReport, type ListPaymentShiftSummariesQuery, type PaymentShiftReportRow } from "./db";
import { formatTimestampForFileName, sanitizeFileName } from "./format";
import { buildShiftValueResolver } from "./paymentShiftValue";
import { drawPdfDocument } from "./paymentPdfGrid";

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
 * template-driven counterpart of the fixed-layout report this replaced, and
 * the PDF twin of `generatePaymentsExportXlsx`. The template's grid (built in
 * the same `TemplateGridEditor`) supplies every row's text and styling;
 * `drawPdfDocument` (see `paymentPdfGrid.ts`) paints it, breaking pages and
 * repeating the static header block. Deliberately simpler than the Excel
 * flow: no outline, no consolidated rows, and the SOMA row always breaks on
 * `groupBy` — everything a PDF has no meaningful equivalent for.
 */
export async function generatePaymentsPdfExport(
  templateId: number,
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<PaymentPdfExportResult> {
  const template = await getPaymentPdfTemplate(templateId);

  const allRows = await listPaymentShiftsForReport(query);
  if (allRows.length === 0) {
    return { rowCount: 0, matchedCount: 0, path: null, title: template.name };
  }

  const shiftValue = await buildShiftValueResolver(allRows);

  // Same "no value = nothing to report" rule as the Excel export — a row
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

  const painter = drawPdfDocument(template.config, rows, amounts);

  const destPath = await save({
    defaultPath: `${sanitizeFileName(template.name)}-${formatTimestampForFileName()}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!destPath) return { rowCount: rows.length, matchedCount: allRows.length, path: null, title: template.name };

  const bytes = new Uint8Array(painter.doc.output("arraybuffer"));
  await writeBinaryFile(destPath, bytes);

  return { rowCount: rows.length, matchedCount: allRows.length, path: destPath, title: template.name };
}

