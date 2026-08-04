import type { DayRecord, StoredDayRecord } from "./types";

/**
 * Fields derived from a day's punches. Deliberately not persisted: the
 * overtime threshold is chosen per report, at read time, so baking these
 * into stored rows would go stale the moment the user picks a different X.
 */
export interface DayAnalysis {
  punchCount: number;
  hasPunch: boolean;
  isIncomplete: boolean;
  intervalMinutes: number | null;
  exceedsThreshold: boolean;
}

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

export function analyzeDay(
  day: Pick<DayRecord | StoredDayRecord, "punches" | "totalWorkedMinutes">,
  thresholdMinutes: number,
): DayAnalysis {
  const punchCount = day.punches.length;

  let intervalMinutes: number | null = null;
  if (day.punches.length >= 4) {
    const sai1 = hhmmToMinutes(day.punches[1]);
    const ent2 = hhmmToMinutes(day.punches[2]);
    if (sai1 !== null && ent2 !== null) intervalMinutes = ent2 - sai1;
  }

  return {
    punchCount,
    hasPunch: punchCount > 0,
    isIncomplete: punchCount % 2 !== 0,
    intervalMinutes,
    exceedsThreshold: day.totalWorkedMinutes > thresholdMinutes,
  };
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

export interface PeriodSummary {
  totalWorkedMinutes: number;
  /** Sum of the excess above `thresholdMinutes` on days that went over it. */
  overtimeMinutes: number;
  absenceMinutes: number;
  /** overtimeMinutes - absenceMinutes — a simple "banco de horas" balance. */
  balanceMinutes: number;
}

export function summarizePeriod(
  days: Pick<DayRecord | StoredDayRecord, "totalWorkedMinutes" | "absenceMinutes">[],
  thresholdMinutes: number,
): PeriodSummary {
  let totalWorkedMinutes = 0;
  let overtimeMinutes = 0;
  let absenceMinutes = 0;
  for (const day of days) {
    totalWorkedMinutes += day.totalWorkedMinutes;
    if (day.totalWorkedMinutes > thresholdMinutes) {
      overtimeMinutes += day.totalWorkedMinutes - thresholdMinutes;
    }
    absenceMinutes += day.absenceMinutes;
  }
  return {
    totalWorkedMinutes,
    overtimeMinutes,
    absenceMinutes,
    balanceMinutes: overtimeMinutes - absenceMinutes,
  };
}
