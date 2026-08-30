import { save } from "@tauri-apps/plugin-dialog";
import ExcelJS from "exceljs";
import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import { writeBinaryFile } from "./api";
import type { PaymentShiftReportRow } from "./db";
import { formatCurrencyBRL, formatTimestampForFileName } from "./format";

function totals(rows: PaymentShiftReportRow[]) {
  return {
    custo: rows.reduce((s, r) => s + (r.amount ?? 0), 0),
    pago: rows.filter((r) => r.status === "pago").reduce((s, r) => s + (r.amount ?? 0), 0),
    turnos: rows.length,
    pessoas: new Set(rows.map((r) => r.employeeId)).size,
  };
}
function ranking(rows: PaymentShiftReportRow[], key: (r: PaymentShiftReportRow) => string) {
  const map = new Map<string, { value: number; count: number }>();
  rows.forEach((r) => { const name = key(r) || "Não informado"; const x = map.get(name) ?? { value: 0, count: 0 }; x.value += r.amount ?? 0; x.count++; map.set(name, x); });
  return Array.from(map, ([name, x]) => ({ name, ...x })).sort((a, b) => b.value - a.value);
}

export async function exportAnalyticsPdf(rows: PaymentShiftReportRow[], start: string, end: string, filters = "Nenhum filtro adicional") {
  const path = await save({ defaultPath: `analises-${formatTimestampForFileName()}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!path) return;
  const doc = new jsPDF(); const t = totals(rows);
  doc.setFontSize(18); doc.text("Relatório de análises", 14, 16);
  doc.setFontSize(9); doc.text(`Período: ${start} a ${end}`, 14, 23);
  const filterLines = doc.splitTextToSize(`Filtros: ${filters}`, 180); doc.text(filterLines, 14, 28);
  autoTable(doc, { startY: 31 + filterLines.length * 4, head: [["Custo total", "Pago", "Turnos", "Colaboradores"]], body: [[formatCurrencyBRL(t.custo), formatCurrencyBRL(t.pago), String(t.turnos), String(t.pessoas)]] });
  autoTable(doc, { startY: (doc as any).lastAutoTable.finalY + 8, head: [["Cliente", "Turnos", "Custo"]], body: ranking(rows, (r) => r.clientName).map((r) => [r.name, String(r.count), formatCurrencyBRL(r.value)]) });
  await writeBinaryFile(path, new Uint8Array(doc.output("arraybuffer")));
}

export async function exportAnalyticsXlsx(rows: PaymentShiftReportRow[], start: string, end: string, filters = "Nenhum filtro adicional") {
  const path = await save({ defaultPath: `analises-${formatTimestampForFileName()}.xlsx`, filters: [{ name: "Excel", extensions: ["xlsx"] }] });
  if (!path) return;
  const book = new ExcelJS.Workbook(); const summary = book.addWorksheet("Resumo"); const t = totals(rows);
  summary.addRow(["Relatório de análises", `${start} a ${end}`]); summary.addRow(["Filtros aplicados", filters]); summary.addRow([]);
  summary.addRow(["Indicador", "Valor"]); summary.addRows([["Custo total", t.custo], ["Total pago", t.pago], ["Turnos", t.turnos], ["Colaboradores", t.pessoas]]);
  ["Cliente", "Empresa", "Função", "Colaborador"].forEach((title) => {
    const key = title === "Cliente" ? (r: PaymentShiftReportRow) => r.clientName : title === "Empresa" ? (r: PaymentShiftReportRow) => r.companyName : title === "Função" ? (r: PaymentShiftReportRow) => r.role : (r: PaymentShiftReportRow) => r.employeeName;
    const sheet = book.addWorksheet(title.slice(0, 31)); sheet.addRow([title, "Turnos", "Custo"]); ranking(rows, key).forEach((r) => sheet.addRow([r.name, r.count, r.value])); sheet.getColumn(1).width = 35; sheet.getColumn(3).numFmt = 'R$ #,##0.00';
  });
  const bytes = await book.xlsx.writeBuffer(); await writeBinaryFile(path, new Uint8Array(bytes));
}
