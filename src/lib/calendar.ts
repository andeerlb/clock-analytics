// Shared pt-BR calendar math for DatePicker and DateRangePicker — kept
// separate from the components so the grid/month logic isn't duplicated
// between a single-date picker and a range picker.

export const MONTH_NAMES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export const WEEKDAY_HEADER = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** The Sunday on or before the 1st of `year`/`month`, in UTC — where a 6x7 grid starts. */
export function gridStart(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - first.getUTCDay());
  return start;
}

/** `iso` shifted by `months` calendar months (negative to go back), as an ISO date. */
export function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return toIso(d);
}

/** `iso` shifted by `days` (negative to go back), as an ISO date — used to resolve a relative reimport Período ("hoje - N dias") against the current date. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}
