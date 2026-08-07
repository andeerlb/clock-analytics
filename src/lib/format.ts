import { addDaysIso, todayUtc, toIso } from "./calendar";
import type {
  NightShiftRule,
  PaymentShiftStatus,
  PaymentValueRuleCondition,
  PaymentValueRuleOperator,
  ShiftPeriod,
} from "./types";

/** 120 -> "R$ 120,00" */
export function formatCurrencyBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

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

/** "2026-01-22" -> "22/Jan/2026" */
export function formatDateAbbrev(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const month = MONTH_ABBR[Number(m) - 1];
  return `${d}/${month.charAt(0).toUpperCase()}${month.slice(1)}/${y}`;
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

export function normalizeCpf(cpf: string): string {
  return cpf.replace(/\D/g, "");
}

/** "12345678901" -> "123.456.789-01". Falls back to the raw input if it isn't 11 digits. */
export function formatCpf(cpf: string): string {
  const digits = normalizeCpf(cpf);
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

/**
 * As-you-type CNPJ mask for a controlled input's `onChange` — unlike
 * `formatCnpj` (which only formats an already-complete value and falls
 * back to raw otherwise), this punctuates whatever's typed so far and
 * caps it at 14 digits, so the field can never hold anything else.
 */
export function maskCnpj(input: string): string {
  const digits = normalizeCnpj(input).slice(0, 14);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += `.${digits.slice(2, 5)}`;
  if (digits.length > 5) out += `.${digits.slice(5, 8)}`;
  if (digits.length > 8) out += `/${digits.slice(8, 12)}`;
  if (digits.length > 12) out += `-${digits.slice(12, 14)}`;
  return out;
}

/** As-you-type CPF mask for a controlled input's `onChange` — see `maskCnpj`. */
export function maskCpf(input: string): string {
  const digits = normalizeCpf(input).slice(0, 11);
  let out = digits.slice(0, 3);
  if (digits.length > 3) out += `.${digits.slice(3, 6)}`;
  if (digits.length > 6) out += `.${digits.slice(6, 9)}`;
  if (digits.length > 9) out += `-${digits.slice(9, 11)}`;
  return out;
}

/**
 * SQLite's `datetime('now')` produces "2026-08-03 20:55:52" — UTC, but with
 * no "T"/timezone marker, so a plain `new Date(sqliteDatetime)` gets parsed
 * as LOCAL time by most JS engines, silently shifting it by the browser's
 * UTC offset. Anything doing arithmetic on a SQLite timestamp (not just
 * displaying it) needs this, not a raw `new Date(...)` — a countdown built
 * on the un-normalized value ends up off by the timezone offset (e.g. a
 * "1 minuto" interval reads as ~3h away for a UTC-3 user).
 */
export function parseSqliteDateTime(sqliteDatetime: string): Date {
  const iso = sqliteDatetime.includes("T") ? sqliteDatetime : `${sqliteDatetime.replace(" ", "T")}Z`;
  return new Date(iso);
}

/** SQLite `datetime('now')` output ("2026-08-03 20:55:52", UTC) -> "3 de agosto de 2026 às 20:55" */
export function formatDateTime(sqliteDatetime: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(
    parseSqliteDateTime(sqliteDatetime),
  );
}

/** "3m 12s" while there's a whole minute or more left, just "12s" under a minute, "agora" once due — shared by the Sidebar's live indicator and the Verificação automática page's per-file countdown. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "agora";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * A reimport config's actual Período, right now — fixed configs just
 * return their stored bounds; relative ones resolve fresh against today
 * ("início = hoje - N dias"), so the same config gives a different range
 * every day instead of a stale one computed once and stored. Shared by
 * `RemoteFileUpdatesContext` (deciding what an automatic reimport should
 * use) and the Verificação automática page (previewing "vai usar: X → Y").
 */
export function resolveReimportPeriod(config: {
  dateMode: "fixed" | "relative";
  periodStart: string | null;
  periodEnd: string | null;
  startOffsetDays: number | null;
  endOffsetDays: number | null;
}): { start: string | null; end: string | null } {
  if (config.dateMode === "fixed") return { start: config.periodStart, end: config.periodEnd };
  const today = toIso(todayUtc());
  return {
    start: config.startOffsetDays !== null ? addDaysIso(today, -config.startOffsetDays) : null,
    end: config.endOffsetDays !== null ? addDaysIso(today, -config.endOffsetDays) : null,
  };
}

/** A human label for a reimport config that was never given a custom one — recognizes the common relative shapes, falls back to a generic description otherwise. */
export function resolveReimportConfigLabel(config: {
  label: string;
  dateMode: "fixed" | "relative";
  startOffsetDays: number | null;
  endOffsetDays: number | null;
}): string {
  if (config.label.trim()) return config.label;
  if (config.dateMode !== "relative") return "Período fixo";
  const { startOffsetDays: start, endOffsetDays: end } = config;
  if (start === 0 && end === 0) return "Hoje";
  if (start === 1 && end === 1) return "Ontem";
  if (start === 1 && end === 0) return "Hoje e ontem";
  if (start !== null && end === 0) return `Últimos ${start} dias`;
  if (start !== null && end !== null) return `${start} a ${end} dias atrás`;
  return "Personalizado";
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

/** 0-indexed column position -> spreadsheet-style letters: 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index0: number): string {
  let n = index0 + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Normalizes a raw "data" field from an applied payment template into an
 * ISO (YYYY-MM-DD) date, or `null` if it can't be parsed — a row that
 * fails this becomes a "erro" row in the import preview rather than
 * silently getting dropped or mis-dated.
 *
 * Tries an already-ISO-looking value first (covers both a native date
 * cell the Rust side already formatted, and source text that already
 * looks ISO, e.g. "2026-02-18T00:00:00" seen in real exports), then falls
 * back to a positional parse using the template's own `dateFormat`.
 */
export function parseDateWithFormat(raw: string, dateFormat: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  const parts = trimmed.replace(/[^\d]+/g, " ").trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [a, b, c] = parts;

  let day: string;
  let month: string;
  let year: string;
  switch (dateFormat) {
    case "DD/MM/YYYY":
    case "DD/MM/YY":
      [day, month, year] = [a, b, c];
      break;
    case "MM/DD/YYYY":
      [month, day, year] = [a, b, c];
      break;
    case "YYYY-MM-DD":
      [year, month, day] = [a, b, c];
      break;
    default:
      return null;
  }

  if (year.length === 2) year = `20${year}`;
  const dayNum = Number(day);
  const monthNum = Number(month);
  const yearNum = Number(year);
  if (!dayNum || !monthNum || !yearNum || monthNum > 12 || dayNum > 31) return null;

  return `${String(yearNum).padStart(4, "0")}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
}

/**
 * Pulls a start/end time pair out of a free-text Horário cell — payroll
 * exports write this as "9:00 - 15:00", "7:30 às 13:30", etc., always two
 * HH:MM-ish timestamps somewhere in the string. Takes the first two
 * matches; `null` if fewer than two are found. Minutes are 0-1439 (time of
 * day, not a signed duration) — a shift crossing midnight (end < start) is
 * valid here, left for a future duration calculation to add 1440 for.
 */
export function parseScheduleToMinutes(raw: string): { startMinutes: number; endMinutes: number } | null {
  const matches = [...raw.matchAll(/(\d{1,2}):(\d{2})/g)];
  if (matches.length < 2) return null;

  function toMinutes(match: RegExpMatchArray): number | null {
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  const startMinutes = toMinutes(matches[0]);
  const endMinutes = toMinutes(matches[1]);
  if (startMinutes === null || endMinutes === null) return null;
  return { startMinutes, endMinutes };
}

/** Minutes-since-midnight -> "HH:MM", zero-padded. */
export function formatMinutesAsTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" -> minutes-since-midnight, or `null` if it's not a valid time. Inverse of `formatMinutesAsTime`. */
export function parseTimeToMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Splits a time-of-day range `[start, end)` (minutes-since-midnight) into
 * one or two non-wrapping `[start, end)` pieces on the 0-1440 circle — a
 * range that crosses midnight (`end < start`, e.g. 22:00-05:00) becomes
 * `[start, 1440)` + `[0, end)`. Every range-comparison helper below reduces
 * to comparing these non-wrapping pieces pairwise, which sidesteps having
 * to special-case wraparound at each call site.
 */
function splitAtMidnight(start: number, end: number): [number, number][] {
  return start <= end ? [[start, end]] : [[start, 1440], [0, end]];
}

/** Whether `point` (minutes-since-midnight) falls in `[start, end)`, wrapping past midnight if `end < start`. */
function isTimeInRange(point: number, start: number, end: number): boolean {
  return splitAtMidnight(start, end).some(([s, e]) => point >= s && point < e);
}

/** Total overlap, in minutes, between two time-of-day ranges — each may itself cross midnight. */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const aParts = splitAtMidnight(aStart, aEnd);
  const bParts = splitAtMidnight(bStart, bEnd);
  let total = 0;
  for (const [as, ae] of aParts) {
    for (const [bs, be] of bParts) {
      total += Math.max(0, Math.min(ae, be) - Math.max(as, bs));
    }
  }
  return total;
}

/** A range's own duration in minutes, accounting for a midnight crossing — e.g. a 22:00-06:00 shift is 480, not negative. */
export function shiftDurationMinutes(start: number, end: number): number {
  return end > start ? end - start : 1440 - start + end;
}

/**
 * Classifies a payment shift as "diurno" or "noturno" against a company's
 * night window, per whichever `rule` that company has configured — see
 * `NightShiftRule` in `types.ts` for what each one means. Both the shift's
 * and the night window's own start/end can cross midnight (e.g. a
 * 22:00-05:00 night window, or an overnight 22:00-06:00 shift); every rule
 * here is wraparound-safe.
 */
export function classifyShiftPeriod(
  rule: NightShiftRule,
  nightStartMinutes: number,
  nightEndMinutes: number,
  shiftStartMinutes: number,
  shiftEndMinutes: number,
): ShiftPeriod {
  const startInRange = isTimeInRange(shiftStartMinutes, nightStartMinutes, nightEndMinutes);
  const endInRange = isTimeInRange(shiftEndMinutes, nightStartMinutes, nightEndMinutes);

  let isNoturno: boolean;
  switch (rule) {
    case "start-in-range":
      isNoturno = startInRange;
      break;
    case "end-in-range":
      isNoturno = endInRange;
      break;
    case "start-or-end-in-range":
      isNoturno = startInRange || endInRange;
      break;
    case "majority-overlap": {
      const overlap = overlapMinutes(shiftStartMinutes, shiftEndMinutes, nightStartMinutes, nightEndMinutes);
      const duration = shiftDurationMinutes(shiftStartMinutes, shiftEndMinutes);
      isNoturno = duration > 0 && overlap / duration >= 0.5;
      break;
    }
    case "overlap":
    default:
      isNoturno = overlapMinutes(shiftStartMinutes, shiftEndMinutes, nightStartMinutes, nightEndMinutes) > 0;
      break;
  }
  return isNoturno ? "noturno" : "diurno";
}

/**
 * Resolves which company/client a payment-import row belongs to, by
 * walking a template's if/else-if/else rule chain in order — the first
 * rule that matches wins. A `"condition"` rule matches when the row's
 * already-mapped `rule.field` value (trimmed, case-insensitive) is one of
 * `rule.values`; an `"else"` rule always matches. `null` means no rule
 * matched (no `"else"` present, and no condition matched either) — the
 * caller shows this as a row needing manual resolution, not a silent drop.
 */
export function resolvePaymentRoute(
  rules: {
    kind: "condition" | "else";
    field: string | null;
    values: string[];
    caseInsensitive: boolean;
    companyId: number;
    clientId: number;
  }[],
  fields: Record<string, string>,
): { companyId: number; clientId: number } | null {
  for (const rule of rules) {
    if (rule.kind === "else") {
      return { companyId: rule.companyId, clientId: rule.clientId };
    }
    const raw = rule.field ? fields[rule.field] : undefined;
    if (!raw) continue;
    const fold = (s: string) => (rule.caseInsensitive ? s.toLowerCase() : s);
    const normalized = fold(raw.trim());
    if (rule.values.some((v) => fold(v.trim()) === normalized)) {
      return { companyId: rule.companyId, clientId: rule.clientId };
    }
  }
  return null;
}

/**
 * Resolves a payment-import row's initial status, walking a template's
 * if/else-if/else status chain the same way `resolvePaymentRoute` walks
 * the routing one — first match wins, "um pra um" (one status per rule,
 * not a company/client pair). `null` means no rule matched (including an
 * empty chain, since this feature is optional) — the caller falls back to
 * the default `"pendente"`, not a manual-resolution state like an
 * unresolved route: an unmatched status is a normal, expected outcome.
 *
 * A `"condition"` rule with an empty `values` (the "Valores possíveis"
 * field left blank) matches when the row's mapped field is itself empty or
 * missing — a deliberate configuration, not a placeholder for "no
 * condition set" — rather than being skipped like `resolvePaymentRoute`
 * skips a rule with no raw value to compare.
 */
export function resolvePaymentStatus(
  rules: {
    kind: "condition" | "else";
    field: string | null;
    values: string[];
    caseInsensitive: boolean;
    status: PaymentShiftStatus;
  }[],
  fields: Record<string, string>,
): PaymentShiftStatus | null {
  for (const rule of rules) {
    if (rule.kind === "else") return rule.status;
    const raw = (rule.field ? fields[rule.field] : undefined)?.trim() ?? "";
    if (rule.values.length === 0) {
      if (!raw) return rule.status;
      continue;
    }
    if (!raw) continue;
    const fold = (s: string) => (rule.caseInsensitive ? s.toLowerCase() : s);
    const normalized = fold(raw);
    if (rule.values.some((v) => fold(v.trim()) === normalized)) return rule.status;
  }
  return null;
}

/** Whether a single `PaymentValueRuleCondition` matches a shift's own column values. */
function matchesValueCondition(
  condition: PaymentValueRuleCondition,
  shift: { workDate: string; local: string; role: string; scheduleStartMinutes: number | null; scheduleEndMinutes: number | null },
): boolean {
  if (condition.field === "horario") {
    const minutes = condition.scheduleRule.startsWith("start") ? shift.scheduleStartMinutes : shift.scheduleEndMinutes;
    if (minutes === null) return false;
    return condition.scheduleRule.endsWith("before") ? minutes < condition.scheduleMinutes : minutes > condition.scheduleMinutes;
  }
  if (condition.values.length === 0) return true;
  const raw = condition.field === "data" ? shift.workDate : condition.field === "local" ? shift.local : shift.role;
  const fold = (s: string) => (condition.caseInsensitive ? s.toLowerCase() : s);
  const normalized = fold(raw.trim());
  return condition.values.some((v) => fold(v.trim()) === normalized);
}

/**
 * Resolves a shift's Valor by walking a company's if/else-if/else
 * pay-value chain — first match wins, same order-of-evaluation idea as
 * `resolvePaymentStatus`. A `"condition"` step matches when every one of
 * its `conditions` (Data/Local/Função/Horário, see
 * `matchesValueCondition`) matches *and* `durationMinutes` (the shift's own
 * horas trabalhadas, see `shiftDurationMinutes`) compares to
 * `thresholdMinutes` per `operator`; an `"else"` step always matches.
 * `null` means no rule matched — including an empty chain, since this is
 * entirely optional — the caller shows "—", not a zero (a zero would
 * misleadingly read as "this shift is worth nothing").
 */
export function resolvePaymentValue(
  rules: {
    kind: "condition" | "else";
    conditions: PaymentValueRuleCondition[];
    operator: PaymentValueRuleOperator | null;
    thresholdMinutes: number | null;
    amount: number;
  }[],
  durationMinutes: number,
  shift: { workDate: string; local: string; role: string; scheduleStartMinutes: number | null; scheduleEndMinutes: number | null },
): number | null {
  for (const rule of rules) {
    if (rule.kind === "else") return rule.amount;
    if (!rule.conditions.every((c) => matchesValueCondition(c, shift))) continue;
    if (rule.operator === null || rule.thresholdMinutes === null) continue;
    const matches = {
      "=": durationMinutes === rule.thresholdMinutes,
      "!=": durationMinutes !== rule.thresholdMinutes,
      ">": durationMinutes > rule.thresholdMinutes,
      ">=": durationMinutes >= rule.thresholdMinutes,
      "<": durationMinutes < rule.thresholdMinutes,
      "<=": durationMinutes <= rule.thresholdMinutes,
    }[rule.operator];
    if (matches) return rule.amount;
  }
  return null;
}
