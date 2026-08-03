/** "2026-07-01" -> "1 de julho de 2026" */
export function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** "2026-07-01" -> "01 de jul." — compact form for dense per-day tables. */
export function formatDayShort(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

/** SQLite `datetime('now')` output ("2026-08-03 20:55:52", UTC) -> "3 de agosto de 2026 às 20:55" */
export function formatDateTime(sqliteDatetime: string): string {
  const iso = sqliteDatetime.includes("T")
    ? sqliteDatetime
    : `${sqliteDatetime.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(date);
}

const MONTH_ABBR = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

function isLastDayOfMonth(date: Date): boolean {
  const next = new Date(date);
  next.setUTCDate(date.getUTCDate() + 1);
  return next.getUTCMonth() !== date.getUTCMonth();
}

/**
 * Compact period label for table rows. Timesheet periods are almost always
 * a full calendar month ("01/07" to "31/07"), so that common case collapses
 * to "jul/2026" instead of a verbose date range; anything else (a provider
 * with a different period shape) falls back to the full range.
 */
export function formatPeriod(startIso: string, endIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);

  const isFullMonth =
    start.getUTCDate() === 1 &&
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCFullYear() === end.getUTCFullYear() &&
    isLastDayOfMonth(end);

  if (isFullMonth) {
    return `${MONTH_ABBR[start.getUTCMonth()]}/${start.getUTCFullYear()}`;
  }
  return `${formatDate(startIso)} a ${formatDate(endIso)}`;
}
