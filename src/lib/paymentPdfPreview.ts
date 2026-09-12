import { drawPdfDocument } from "./paymentPdfGrid";
import type { PaymentPdfTemplateConfig } from "./types";
import type { PaymentShiftReportRow } from "./db";

/**
 * Builds a throwaway PDF from a template config and FAKE data — the editor's
 * "Pré-visualizar" button, so the user sees the real rendering (fonts, colors,
 * grouping, SOMA, page orientation, the repeated header block) without
 * exporting anything or touching real turnos. Pure and Tauri-free: it runs
 * the exact same `drawPdfDocument` the real export runs, just fed sample rows.
 */

const FAKE_BASE = {
  employeeId: 0,
  companyId: 0,
  clientId: 0,
  roleId: null,
  amount: null,
  importedAt: "2026-08-10 09:15:00",
  extraData: null,
};

const FAKE_SHIFTS: PaymentShiftReportRow[] = [
  { ...FAKE_BASE, id: 1, employeeName: "Crislan Souza", workDate: "2026-08-02", role: "FLV", local: "Loja 12", status: "pendente", shiftPeriod: "diurno", scheduleStartMinutes: 7 * 60, scheduleEndMinutes: 13 * 60, companyName: "Padaria Santo Amaro", clientName: "Rede Comida Boa" },
  { ...FAKE_BASE, id: 2, employeeName: "Crislan Souza", workDate: "2026-08-03", role: "Mercearia", local: "Loja 12", status: "pago", shiftPeriod: "noturno", scheduleStartMinutes: 22 * 60, scheduleEndMinutes: 4 * 60, companyName: "Padaria Santo Amaro", clientName: "Rede Comida Boa" },
  { ...FAKE_BASE, id: 3, employeeName: "Crislan Souza", workDate: "2026-08-05", role: "Caixa", local: "Loja 07", status: "pago", shiftPeriod: "diurno", scheduleStartMinutes: 8 * 60, scheduleEndMinutes: 17 * 60, companyName: "Padaria Santo Amaro", clientName: "Rede Comida Boa" },
  { ...FAKE_BASE, id: 4, employeeName: "Wellinton Lima", workDate: "2026-08-02", role: "Açougue", local: "Loja 12", status: "pago", shiftPeriod: "diurno", scheduleStartMinutes: 6 * 60, scheduleEndMinutes: 14 * 60, companyName: "Padaria Santo Amaro", clientName: "Rede Comida Boa" },
  { ...FAKE_BASE, id: 5, employeeName: "Wellinton Lima", workDate: "2026-08-04", role: "Açougue", local: "Loja 12", status: "erro", shiftPeriod: "diurno", scheduleStartMinutes: 6 * 60, scheduleEndMinutes: 14 * 60, companyName: "Padaria Santo Amaro", clientName: "Rede Comida Boa" },
  { ...FAKE_BASE, id: 6, employeeName: "Marta Ribeiro", workDate: "2026-08-06", role: "FLV", local: "Loja 07", status: "pendente", shiftPeriod: "diurno", scheduleStartMinutes: 9 * 60, scheduleEndMinutes: 15 * 60, companyName: "Mercado Central", clientName: "Rede Comida Boa" },
  { ...FAKE_BASE, id: 7, employeeName: "Marta Ribeiro", workDate: "2026-08-07", role: "FLV", local: "Loja 07", status: "pago", shiftPeriod: "noturno", scheduleStartMinutes: 21 * 60, scheduleEndMinutes: 3 * 60, companyName: "Mercado Central", clientName: "Rede Comida Boa" },
];

/** A plausible-looking amount per fake shift (varies a little per role/day so SOMAs and layouts are exercised). */
const FAKE_AMOUNTS = new Map<PaymentShiftReportRow, number | null>(
  FAKE_SHIFTS.map((row, index) => [row, 78.5 + index * 13.25]),
);

export const PAYMENT_PDF_PREVIEW_ROW_COUNT = FAKE_SHIFTS.length;

/** Renders the template with fake data and returns the finished PDF bytes. */
export function buildPaymentPdfPreviewBytes(config: PaymentPdfTemplateConfig): Uint8Array {
  const painter = drawPdfDocument(config, FAKE_SHIFTS, FAKE_AMOUNTS);
  return new Uint8Array(painter.doc.output("arraybuffer"));
}
