import type { StoredImport } from "./types";

export type PeriodStatusId = "overtime" | "absence" | "late" | "regular" | "no-punch" | "interval";

/**
 * Status categories for a whole import's (fixed) period, reading the
 * aggregates stored at import time instead of recomputing anything — used
 * anywhere a list of imports needs filtering by what happened over their
 * period, not a single day. Shared between the Relatórios and
 * Colaboradores screens so the two stay in sync.
 *
 * `absence` (falta) and `late` (atraso) are separate buckets: falta is a
 * day with no valid punch pair, atraso is a day with a pair that still
 * came up short — see `saveParsedTimesheet` for how they're split.
 */
export const PERIOD_STATUS_OPTIONS: {
  id: PeriodStatusId;
  label: string;
  matches: (imp: StoredImport) => boolean;
}[] = [
  { id: "overtime", label: "Horas extras no período", matches: (i) => i.overtimeMinutes > 0 },
  { id: "absence", label: "Faltas no período", matches: (i) => i.absenceMinutes > 0 },
  { id: "late", label: "Atrasos no período", matches: (i) => i.lateMinutes > 0 },
  { id: "regular", label: "Com horas regulares no período", matches: (i) => i.regularMinutes > 0 },
  { id: "no-punch", label: "Sem nenhuma marcação no período", matches: (i) => i.totalWorkedMinutes === 0 },
  { id: "interval", label: "Com intervalo no período", matches: (i) => i.intervalMinutes > 0 },
];

/**
 * Whether `imp` should stay visible under the current "Status no período"
 * checkboxes. These categories aren't exhaustive or mutually exclusive — a
 * period can match several, or none at all (e.g. some punches, but nothing
 * that rises to overtime/absence/atraso/regular/interval). With every box
 * checked (the default), nothing is filtered out, including periods
 * matching none of them. As soon as anything is unchecked, this narrows to
 * an inclusive OR: only periods matching at least one still-checked
 * category remain — so checking just "Horas extras" shows periods with
 * overtime and nothing else, not every period the deselected categories
 * happen not to describe.
 */
export function matchesSelectedStatuses(imp: StoredImport, selected: Set<PeriodStatusId>): boolean {
  if (selected.size === PERIOD_STATUS_OPTIONS.length) return true;
  return PERIOD_STATUS_OPTIONS.some((opt) => selected.has(opt.id) && opt.matches(imp));
}
