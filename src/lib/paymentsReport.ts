import { save } from "@tauri-apps/plugin-dialog";
import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import { writeBinaryFile } from "./api";
import { getCompany, listPaymentShiftsForReport, type ListPaymentShiftSummariesQuery, type PaymentShiftReportRow } from "./db";
import {
  formatCurrencyBRL,
  formatDateAbbrev,
  formatMinutesAsTime,
  formatTimestampForFileName,
  resolvePaymentValue,
  sanitizeFileName,
  shiftDurationMinutes,
} from "./format";
import type { PaymentShiftStatus, PaymentValueRule } from "./types";

const STATUS_LABELS: Record<PaymentShiftStatus, string> = { pendente: "Pendente", erro: "Erro", pago: "Pago" };
const SHIFT_PERIOD_LABELS: Record<"diurno" | "noturno", string> = { diurno: "Diurno", noturno: "Noturno" };

// A small outer margin (instead of jsPDF/autoTable's much larger ~14mm
// default) so the table uses nearly the full page width — the title text
// lines up with the table's own left edge plus its cell padding, so it
// reads flush with the header cells' actual text, not the table's outer
// border.
const PAGE_MARGIN = 8;
const CELL_PADDING = 2.5;
const CONTENT_X = PAGE_MARGIN + CELL_PADDING;

/** Only the single-status cases get a specific name — a mix of statuses (or none of these three) falls back to a neutral title. */
function reportTitle(statuses: PaymentShiftStatus[]): string {
  if (statuses.length === 1) {
    if (statuses[0] === "pendente") return "Colaboradores a pagar";
    if (statuses[0] === "pago") return "Colaboradores pagos";
    if (statuses[0] === "erro") return "Turnos com erro";
  }
  return "Relatório de pagamentos";
}

export interface PaymentsReportResult {
  rowCount: number;
  /** Wherever the user chose to save it — `null` when there were no matching rows (nothing was generated) or the save dialog was cancelled. Hand this straight to `PdfViewerModal`. */
  path: string | null;
  title: string;
}

/**
 * Generates the Pagamentos "Gerar PDF" report for whatever filters are
 * currently active on the list — a flat table (one line per turno, not
 * grouped by colaborador) with Colaborador/Data/Local/Função/Horário (com
 * Diurno/Noturno)/Horas trabalhadas/Valor/Status, and a totals row at the
 * end. Prompts the native save dialog right away (the destination is the
 * user's own choice, not app-managed), then writes there — the caller can
 * open that same path in `PdfViewerModal` (with downloading disabled,
 * since it's already exactly where the user put it) right after.
 */
export async function generatePaymentsReportPdf(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<PaymentsReportResult> {
  const rows = await listPaymentShiftsForReport(query);
  const title = reportTitle(query.statuses);

  if (rows.length === 0) {
    return { rowCount: 0, path: null, title };
  }

  // A `pago` row already carries its own frozen `amount`; every other
  // status needs a live estimate from its own company's rules (same
  // fallback `PaymentDetailPage`'s `shiftValue` uses) — batched per
  // distinct company instead of once per row, since a report can span
  // several at once.
  const companyIds = Array.from(new Set(rows.map((r) => r.companyId)));
  const valueRulesByCompany = new Map<number, PaymentValueRule[]>();
  await Promise.all(
    companyIds.map(async (id) => {
      const company = await getCompany(id);
      valueRulesByCompany.set(id, company.valueRules);
    }),
  );

  function shiftValue(r: PaymentShiftReportRow): number | null {
    if (r.amount !== null) return r.amount;
    if (r.scheduleStartMinutes === null || r.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(r.scheduleStartMinutes, r.scheduleEndMinutes);
    return resolvePaymentValue(valueRulesByCompany.get(r.companyId) ?? [], duration, {
      workDate: r.workDate,
      local: r.local,
      role: r.role,
      scheduleStartMinutes: r.scheduleStartMinutes,
      scheduleEndMinutes: r.scheduleEndMinutes,
    });
  }

  let totalMinutes = 0;
  let totalValue = 0;
  const body = rows.map((r) => {
    const hasSchedule = r.scheduleStartMinutes !== null && r.scheduleEndMinutes !== null;
    const duration = hasSchedule ? shiftDurationMinutes(r.scheduleStartMinutes!, r.scheduleEndMinutes!) : null;
    if (duration !== null) totalMinutes += duration;
    const value = shiftValue(r);
    if (value !== null) totalValue += value;

    const horario = hasSchedule
      ? `${formatMinutesAsTime(r.scheduleStartMinutes!)} – ${formatMinutesAsTime(r.scheduleEndMinutes!)}${
          r.shiftPeriod ? ` (${SHIFT_PERIOD_LABELS[r.shiftPeriod]})` : ""
        }`
      : "—";

    return [
      r.local,
      formatDateAbbrev(r.workDate),
      r.role,
      duration !== null ? formatMinutesAsTime(duration) : "—",
      horario,
      value !== null ? formatCurrencyBRL(value) : "—",
      r.employeeName,
      STATUS_LABELS[r.status],
    ];
  });

  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(14);
  doc.text(title, CONTENT_X, 15);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `Gerado em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(new Date())}`,
    CONTENT_X,
    21,
  );

  autoTable(doc, {
    startY: 26,
    margin: { top: 26, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN },
    head: [["Local", "Data", "Função", "Qtd/h", "Horário", "Valor", "Nome", "Status"]],
    body,
    foot: [["", "", "Total", formatMinutesAsTime(totalMinutes), "", formatCurrencyBRL(totalValue), "", ""]],
    // Total is a sum over every row in the report, not just the ones on a
    // given page — showing it on every page would misleadingly look like a
    // per-page subtotal, so it only prints once, after the last row.
    showFoot: "lastPage",
    styles: { fontSize: 8, cellPadding: CELL_PADDING },
    headStyles: { fillColor: [45, 52, 73] },
    footStyles: { fillColor: [230, 230, 230], textColor: 20, fontStyle: "bold" },
  });

  const destPath = await save({
    defaultPath: `${sanitizeFileName(title)}-${formatTimestampForFileName()}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!destPath) return { rowCount: rows.length, path: null, title };

  const bytes = new Uint8Array(doc.output("arraybuffer"));
  await writeBinaryFile(destPath, bytes);

  return { rowCount: rows.length, path: destPath, title };
}
