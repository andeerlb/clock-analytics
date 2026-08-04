/** Bytes -> "12.3 MB" — the Configurações storage indicator. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

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

/** "2026-07-01" -> "01/07/2026" */
export function formatDateSlash(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * "2026-07-01" -> "01/07" — the year is only spelled out when it isn't the
 * current one, since a dense day-by-day table almost never needs it.
 */
export function formatDateCompact(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const currentYear = new Date().getFullYear();
  return Number(y) === currentYear ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/**
 * Makes a string safe to use as a file or folder name across Linux/macOS/
 * Windows — strips path separators and the handful of characters Windows
 * forbids, and trims trailing dots/spaces (also a Windows quirk).
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

/** Last path segment — the save dialog returns a full OS path, split on either separator so it works on Windows too. */
export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/**
 * "2026-08-04-153042" — sortable, filesystem-safe (no colons) local
 * timestamp for a default file name, so generating a zip more than once in
 * the same session doesn't collide with the previous one and prompt to
 * overwrite it.
 */
export function formatTimestampForFileName(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Strips everything but digits — the canonical, storable/comparable form of a CNPJ. */
export function normalizeCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "");
}

/** "62489830000181" -> "62.489.830/0001-81". Falls back to the raw input if it isn't 14 digits. */
export function formatCnpj(cnpj: string): string {
  const digits = normalizeCnpj(cnpj);
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
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
