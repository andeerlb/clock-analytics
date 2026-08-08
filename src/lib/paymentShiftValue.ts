import { getCompany, type PaymentShiftReportRow } from "./db";
import { resolvePaymentValue, shiftDurationMinutes } from "./format";
import type { PaymentValueRule } from "./types";

/**
 * Resolves each report row's Valor for display/export: a `pago` row keeps
 * its own frozen `amount`; every other status gets a live estimate from its
 * own company's value rules — same fallback `PaymentsPage`'s own
 * `shiftValueFor` uses for the live list. Shared by `paymentsReport.ts` (PDF)
 * and `paymentExport.ts` (xlsx) so the two exporters can't drift apart on
 * this. Batches company lookups once per distinct `companyId` across all of
 * `rows`, not once per row — a report/export can span several companies at
 * once.
 */
export async function buildShiftValueResolver(
  rows: PaymentShiftReportRow[],
): Promise<(row: PaymentShiftReportRow) => number | null> {
  const companyIds = Array.from(new Set(rows.map((r) => r.companyId)));
  const valueRulesByCompany = new Map<number, PaymentValueRule[]>();
  await Promise.all(
    companyIds.map(async (id) => {
      const company = await getCompany(id);
      valueRulesByCompany.set(id, company.valueRules);
    }),
  );

  return function shiftValue(row: PaymentShiftReportRow): number | null {
    if (row.amount !== null) return row.amount;
    if (row.scheduleStartMinutes === null || row.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(row.scheduleStartMinutes, row.scheduleEndMinutes);
    return resolvePaymentValue(valueRulesByCompany.get(row.companyId) ?? [], duration, {
      workDate: row.workDate,
      local: row.local,
      role: row.role,
      scheduleStartMinutes: row.scheduleStartMinutes,
      scheduleEndMinutes: row.scheduleEndMinutes,
    });
  };
}
