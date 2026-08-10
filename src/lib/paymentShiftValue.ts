import { getEffectivePaymentRules, type PaymentShiftReportRow } from "./db";
import { resolvePaymentValue, shiftDurationMinutes } from "./format";
import type { PaymentValueRule } from "./types";

/**
 * Resolves each report row's Valor for display/export: a `pago` row keeps
 * its own frozen `amount`; every other status gets a live estimate from the
 * effective value rules for its (cliente, empresa) pair — the client's own
 * override when it has one, otherwise the company's (see
 * `getEffectivePaymentRules`) — same fallback `PaymentsPage`'s own
 * `shiftValueFor` uses for the live list. Shared by `paymentsReport.ts` (PDF)
 * and `paymentExport.ts` (xlsx) so the two exporters can't drift apart on
 * this. Batches lookups once per distinct (clientId, companyId) pair across
 * all of `rows`, not once per row — a report/export can span several
 * clientes/empresas at once.
 */
export async function buildShiftValueResolver(
  rows: PaymentShiftReportRow[],
): Promise<(row: PaymentShiftReportRow) => number | null> {
  const pairKeys = Array.from(new Set(rows.map((r) => `${r.clientId}:${r.companyId}`)));
  const valueRulesByPair = new Map<string, PaymentValueRule[]>();
  await Promise.all(
    pairKeys.map(async (key) => {
      const [clientId, companyId] = key.split(":").map(Number);
      const effective = await getEffectivePaymentRules(clientId, companyId);
      valueRulesByPair.set(key, effective.valueRules);
    }),
  );

  return function shiftValue(row: PaymentShiftReportRow): number | null {
    if (row.amount !== null) return row.amount;
    if (row.scheduleStartMinutes === null || row.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(row.scheduleStartMinutes, row.scheduleEndMinutes);
    return resolvePaymentValue(valueRulesByPair.get(`${row.clientId}:${row.companyId}`) ?? [], duration, {
      workDate: row.workDate,
      local: row.local,
      role: row.role,
      scheduleStartMinutes: row.scheduleStartMinutes,
      scheduleEndMinutes: row.scheduleEndMinutes,
    });
  };
}
