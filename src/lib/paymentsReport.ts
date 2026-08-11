import { save } from "@tauri-apps/plugin-dialog";
import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import { writeBinaryFile } from "./api";
import { listPaymentShiftsForReport, type ListPaymentShiftSummariesQuery } from "./db";
import { formatCurrencyBRL, formatDateAbbrev, formatMinutesAsTime, formatTimestampForFileName, sanitizeFileName, shiftDurationMinutes } from "./format";
import { buildShiftValueResolver } from "./paymentShiftValue";
import type { PaymentShiftStatus } from "./types";

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
  /** How many turnos actually made it into the PDF — can be 0 even when `matchedCount` isn't, since a turno with no computed value yet is excluded (see the filter below). */
  rowCount: number;
  /** How many turnos matched the filters *before* the "has a value" filter — lets the caller tell "no turno matches these filters" apart from "turnos matched, but none has a payment value yet" instead of collapsing both into one ambiguous "Nenhum turno" message. */
  matchedCount: number;
  /** Wherever the user chose to save it — `null` when there were no matching rows (nothing was generated) or the save dialog was cancelled. Hand this straight to `PdfViewerModal`. */
  path: string | null;
  title: string;
}

/**
 * Generates the Pagamentos "Gerar PDF" report for whatever filters are
 * currently active on the list — a flat table (one line per turno, never
 * collapsed into one row per colaborador) with Colaborador/Data/Local/
 * Função/Horário (com Diurno/Noturno)/Horas trabalhadas/Valor/Status.
 * `grouped` mirrors the list's own "Agrupar por colaborador" toggle: rows
 * are still printed one turno per line either way, but when on, they're
 * sorted so each colaborador's turnos are contiguous and followed by a
 * subtotal row, replacing the single grand-total row used when off — see
 * `PaymentsPage`'s `grouped` state, whose only other effect is how the
 * on-screen table is displayed. Prompts the native save dialog right away
 * (the destination is the user's own choice, not app-managed), then writes
 * there — the caller can open that same path in `PdfViewerModal` (with
 * downloading disabled, since it's already exactly where the user put it)
 * right after.
 */
export async function generatePaymentsReportPdf(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
  grouped: boolean = false,
): Promise<PaymentsReportResult> {
  const allRows = await listPaymentShiftsForReport(query);
  const title = reportTitle(query.statuses);

  if (allRows.length === 0) {
    return { rowCount: 0, matchedCount: 0, path: null, title };
  }

  const shiftValue = await buildShiftValueResolver(allRows);

  // A row with no value at all (still awaiting a schedule/value rule) or a
  // literal zero isn't a payment — it has nothing to report, so it's left
  // out of the PDF entirely rather than printed with a "—"/R$ 0,00 Valor.
  const rows = allRows.filter((r) => {
    const value = shiftValue(r);
    return value !== null && value !== 0;
  });

  if (rows.length === 0) {
    return { rowCount: 0, matchedCount: allRows.length, path: null, title };
  }

  // Grouped: each colaborador's turnos need to sit together so a subtotal
  // can follow them, so rows are re-sorted by employee (then by date, same
  // order the ungrouped report already used) instead of the SQL's own
  // work_date-first order.
  const orderedRows = grouped
    ? [...rows].sort(
        (a, b) => a.employeeId - b.employeeId || a.workDate.localeCompare(b.workDate) || a.local.localeCompare(b.local),
      )
    : rows;

  let totalMinutes = 0;
  let totalValue = 0;
  const body: string[][] = [];
  const subtotalRowIndexes = new Set<number>();

  let currentEmployeeId: number | null = null;
  let currentEmployeeName = "";
  let employeeMinutes = 0;
  let employeeValue = 0;

  function pushSubtotalRow() {
    body.push(["", "", "Subtotal", formatMinutesAsTime(employeeMinutes), "", formatCurrencyBRL(employeeValue), currentEmployeeName, ""]);
    subtotalRowIndexes.add(body.length - 1);
  }

  for (const r of orderedRows) {
    if (grouped && currentEmployeeId !== null && r.employeeId !== currentEmployeeId) {
      pushSubtotalRow();
      employeeMinutes = 0;
      employeeValue = 0;
    }
    currentEmployeeId = r.employeeId;
    currentEmployeeName = r.employeeName;

    const hasSchedule = r.scheduleStartMinutes !== null && r.scheduleEndMinutes !== null;
    const duration = hasSchedule ? shiftDurationMinutes(r.scheduleStartMinutes!, r.scheduleEndMinutes!) : null;
    if (duration !== null) {
      totalMinutes += duration;
      employeeMinutes += duration;
    }
    // Guaranteed non-null/non-zero by the filter above.
    const value = shiftValue(r)!;
    totalValue += value;
    employeeValue += value;

    const horario = hasSchedule
      ? `${formatMinutesAsTime(r.scheduleStartMinutes!)} – ${formatMinutesAsTime(r.scheduleEndMinutes!)}${
          r.shiftPeriod ? ` (${SHIFT_PERIOD_LABELS[r.shiftPeriod]})` : ""
        }`
      : "—";

    body.push([
      r.local,
      formatDateAbbrev(r.workDate),
      r.role,
      duration !== null ? formatMinutesAsTime(duration) : "—",
      horario,
      formatCurrencyBRL(value),
      r.employeeName,
      STATUS_LABELS[r.status],
    ]);
  }
  if (grouped) pushSubtotalRow();

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
    // Ungrouped: one grand total after the last row. Grouped: a subtotal
    // row already sits after each colaborador's turnos (in `body` itself,
    // styled by `didParseCell` below), so there's no separate grand-total
    // foot row.
    foot: grouped ? undefined : [["", "", "Total", formatMinutesAsTime(totalMinutes), "", formatCurrencyBRL(totalValue), "", ""]],
    // Total is a sum over every row in the report, not just the ones on a
    // given page — showing it on every page would misleadingly look like a
    // per-page subtotal, so it only prints once, after the last row.
    showFoot: grouped ? undefined : "lastPage",
    styles: { fontSize: 8, cellPadding: CELL_PADDING },
    headStyles: { fillColor: [45, 52, 73] },
    footStyles: { fillColor: [230, 230, 230], textColor: 20, fontStyle: "bold" },
    didParseCell: grouped
      ? (data) => {
          if (data.section === "body" && subtotalRowIndexes.has(data.row.index)) {
            data.cell.styles.fillColor = [230, 230, 230];
            data.cell.styles.textColor = 20;
            data.cell.styles.fontStyle = "bold";
          }
        }
      : undefined,
  });

  const destPath = await save({
    defaultPath: `${sanitizeFileName(title)}-${formatTimestampForFileName()}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!destPath) return { rowCount: rows.length, matchedCount: allRows.length, path: null, title };

  const bytes = new Uint8Array(doc.output("arraybuffer"));
  await writeBinaryFile(destPath, bytes);

  return { rowCount: rows.length, matchedCount: allRows.length, path: destPath, title };
}
