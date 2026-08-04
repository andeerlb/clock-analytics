// Not user-configurable anywhere in the UI — shared between the frontend
// (Cartão de Ponto's per-day filter) and `db.ts` (period aggregates stored
// at import time), so it lives here as the single source of truth.
export const OVERTIME_THRESHOLD_MINUTES = 8 * 60;

function hhmmToMinutes(value: string): number | null {
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Sum of every break in the day: the gap between each "saída" and the
 * following "entrada" (punches[1]→punches[2], punches[3]→punches[4], ...).
 * A day with just one punch pair (or a trailing unmatched punch) has no
 * closed break to measure, so it contributes nothing.
 */
export function sumIntervalMinutes(punches: string[]): number {
  let total = 0;
  for (let i = 1; i + 1 < punches.length; i += 2) {
    const out = hhmmToMinutes(punches[i]);
    const in_ = hhmmToMinutes(punches[i + 1]);
    if (out !== null && in_ !== null) total += in_ - out;
  }
  return total;
}

export function formatMinutes(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "";
  const abs = Math.abs(totalMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Coalize's weekday abbreviations only ever come out in Portuguese. */
export function isWeekend(weekday: string): boolean {
  return weekday === "Sáb" || weekday === "Dom";
}
