import { save } from "@tauri-apps/plugin-dialog";
import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import { writeBinaryFile } from "./api";
import { listPaymentShiftsForReport, type ListPaymentShiftSummariesQuery } from "./db";
import { formatCurrencyBRL, formatDateAbbrev, formatMinutesAsTime, formatTimestampForFileName, sanitizeFileName, scheduleDurationMinutes } from "./format";
import { buildShiftValueResolver } from "./paymentShiftValue";
import type { PaymentShiftStatus } from "./types";

const STATUS_LABELS: Record<PaymentShiftStatus, string> = { pendente: "Pendente", erro: "Erro", pago: "Pago" };
const SHIFT_PERIOD_LABELS: Record<"diurno" | "noturno", string> = { diurno: "Diurno", noturno: "Noturno" };

function reportTitle(statuses: PaymentShiftStatus[]): string {
  if (statuses.length === 1) {
    if (statuses[0] === "pendente") return "Colaboradores a pagar";
    if (statuses[0] === "pago") return "Colaboradores pagos";
    if (statuses[0] === "erro") return "Turnos com erro";
  }
  return "Relatório de pagamentos";
}

function shiftReportTitle(statuses: PaymentShiftStatus[]): string {
  if (statuses.length === 1) {
    if (statuses[0] === "pendente") return "Turnos pendentes";
    if (statuses[0] === "pago") return "Turnos pagos";
    if (statuses[0] === "erro") return "Turnos com erro";
  }
  return "Relatório de turnos";
}

export interface PaymentsReportResult {
  rowCount: number;
  matchedCount: number;
  path: string | null;
  title: string;
}

export async function generatePaymentsReportPdf(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
  grouped = false,
): Promise<PaymentsReportResult> {
  return generateReportPdf(query, grouped, true);
}

export async function generatePaymentsShiftReportPdf(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
  grouped = false,
): Promise<PaymentsReportResult> {
  return generateReportPdf(query, grouped, false);
}

async function generateReportPdf(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
  grouped: boolean,
  onlyRowsWithValue: boolean,
): Promise<PaymentsReportResult> {
  const allRows = await listPaymentShiftsForReport(query);
  const title = onlyRowsWithValue ? reportTitle(query.statuses) : shiftReportTitle(query.statuses);
  if (allRows.length === 0) return { rowCount: 0, matchedCount: 0, path: null, title };

  const shiftValue = await buildShiftValueResolver(allRows);
  const rows = onlyRowsWithValue
    ? allRows.filter((row) => {
        const value = shiftValue!(row);
        return value !== null && value !== 0;
      })
    : allRows;
  if (rows.length === 0) return { rowCount: 0, matchedCount: allRows.length, path: null, title };

  const orderedRows = grouped
    ? [...rows].sort((a, b) => a.employeeId - b.employeeId || a.workDate.localeCompare(b.workDate) || a.local.localeCompare(b.local))
    : rows;
  const body: string[][] = [];
  const subtotalRowIndexes = new Set<number>();
  let totalMinutes = 0;
  let totalValue = 0;
  let currentEmployeeId: number | null = null;
  let currentEmployeeName = "";
  let employeeMinutes = 0;
  let employeeValue = 0;
  let employeeShiftCount = 0;
  let totalShiftCount = 0;

  function pushSubtotal() {
    body.push(onlyRowsWithValue
      ? ["", "", "Subtotal", formatMinutesAsTime(employeeMinutes), "", formatCurrencyBRL(employeeValue), currentEmployeeName, ""]
      : ["", "", "Total de turnos", formatMinutesAsTime(employeeMinutes), "", formatCurrencyBRL(employeeValue), currentEmployeeName, "", String(employeeShiftCount)]);
    subtotalRowIndexes.add(body.length - 1);
  }

  for (const row of orderedRows) {
    if (grouped && currentEmployeeId !== null && row.employeeId !== currentEmployeeId) {
      pushSubtotal();
      employeeMinutes = 0;
      employeeValue = 0;
      employeeShiftCount = 0;
    }
    currentEmployeeId = row.employeeId;
    currentEmployeeName = row.employeeName;
    employeeShiftCount += 1;
    const duration = scheduleDurationMinutes(row);
    const hasSchedule = duration !== null;
    if (duration !== null) {
      totalMinutes += duration;
      employeeMinutes += duration;
    }
    const value = shiftValue(row);
    totalShiftCount += 1;
    if (value !== null) {
      totalValue += value;
      employeeValue += value;
    }
    const schedule = hasSchedule
      ? `${formatMinutesAsTime(row.scheduleStartMinutes!)} - ${formatMinutesAsTime(row.scheduleEndMinutes!)}${row.shiftPeriod ? ` (${SHIFT_PERIOD_LABELS[row.shiftPeriod]})` : ""}`
      : "-";
    body.push(onlyRowsWithValue
      ? [row.local, formatDateAbbrev(row.workDate), row.role, duration !== null ? formatMinutesAsTime(duration) : "-", schedule, value !== null ? formatCurrencyBRL(value) : "-", row.employeeName, STATUS_LABELS[row.status]]
      : [row.local, formatDateAbbrev(row.workDate), row.role, duration !== null ? formatMinutesAsTime(duration) : "-", schedule, value !== null ? formatCurrencyBRL(value) : "-", row.employeeName, STATUS_LABELS[row.status], "1"]);
  }
  if (grouped) pushSubtotal();

  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(14);
  doc.text(title, 10.5, 15);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Gerado em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(new Date())}`, 10.5, 21);
  autoTable(doc, {
    startY: 26,
    margin: { top: 26, right: 8, bottom: 8, left: 8 },
    head: [onlyRowsWithValue
      ? ["Local", "Data", "Função", "Qtd/h", "Horário", "Valor", "Nome", "Status"]
      : ["Local", "Data", "Função", "Qtd/h", "Horário", "Valor", "Nome", "Status", "Turnos"]],
    body,
    foot: grouped ? undefined : [onlyRowsWithValue
      ? ["", "", "Total", formatMinutesAsTime(totalMinutes), "", formatCurrencyBRL(totalValue), "", ""]
      : ["", "", "Total de turnos", formatMinutesAsTime(totalMinutes), "", formatCurrencyBRL(totalValue), "", "", String(totalShiftCount)]],
    showFoot: grouped ? undefined : "lastPage",
    styles: { fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [45, 52, 73] },
    footStyles: { fillColor: [230, 230, 230], textColor: 20, fontStyle: "bold" },
    didParseCell: grouped ? (data) => {
      if (data.section === "body" && subtotalRowIndexes.has(data.row.index)) {
        data.cell.styles.fillColor = [230, 230, 230];
        data.cell.styles.textColor = 20;
        data.cell.styles.fontStyle = "bold";
      }
    } : undefined,
  });

  const path = await save({ defaultPath: `${sanitizeFileName(title)}-${formatTimestampForFileName()}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!path) return { rowCount: rows.length, matchedCount: allRows.length, path: null, title };
  await writeBinaryFile(path, new Uint8Array(doc.output("arraybuffer")));
  return { rowCount: rows.length, matchedCount: allRows.length, path, title };
}