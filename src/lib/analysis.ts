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
