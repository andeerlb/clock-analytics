import {
  getEffectivePaymentRules,
  listPaymentShiftsForReport,
  type ListPaymentShiftSummariesQuery,
  type PaymentShiftReportRow,
} from "./db";
import { shiftValue } from "./format";
import type { PaymentValueRule } from "./types";

/**
 * Resolves each report row's Valor for display/export: a `pago` row keeps
 * its own frozen `amount`; every other status gets a live estimate from the
 * effective value rules for its (cliente, empresa) pair — the client's own
 * override when it has one, otherwise the company's (see
 * `getEffectivePaymentRules`) — via the same `shiftValue` every screen uses. Shared by `paymentsReport.ts` (PDF)
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

  return (row: PaymentShiftReportRow) => shiftValue(row, valueRulesByPair.get(`${row.clientId}:${row.companyId}`) ?? []);
}

/**
 * "Turnos sem valor" (`attention: "missing-amount"`) means no recorded
 * amount AND no value-rule estimate — the same `shiftValue(...) === null`
 * the Analytics card counts. SQL can only do the first half
 * (`ps.amount IS NULL`), so the database narrows the set first and the
 * estimate runs here over what's left; the surviving ids then go back as
 * `shiftIds`, letting the regular paginated queries count and page exactly
 * those. Any other query is returned unchanged.
 */
export async function withMissingValueShiftIds<Q extends Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">>(
  query: Q,
): Promise<Q> {
  if (query.attention !== "missing-amount") return query;
  const rows = await listPaymentShiftsForReport(query);
  const value = await buildShiftValueResolver(rows);
  return { ...query, shiftIds: rows.filter((r) => value(r) === null).map((r) => r.id) };
}
