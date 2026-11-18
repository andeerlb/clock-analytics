import { parseDateWithFormat, parseScheduleToMinutes } from "./format";
import type { EmployeeTargetField, IdentifierField, PaymentTargetField } from "./types";

/**
 * Helpers behind the payment template's "Onde está cada informação?" flow:
 * spotting the header row of a sheet, prefilling which column holds what
 * from the header names (and, failing that, from the values), and checking
 * a sheet's real rows against its answers.
 */

/** How many rows from the top are searched for the header row. */
const HEADER_SEARCH_ROWS = 20;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
}

function looksLikeDate(value: string): boolean {
  const v = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(v);
}

function looksLikeLabel(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (looksLikeDate(v)) return false;
  if (/^[\d\s.,:/-]+$/.test(v)) return false;
  return true;
}

/**
 * Index of the row holding the column names: among the first rows, the one
 * with the most text-like cells (not dates, not numbers). `-1` when nothing
 * looks like a header — data starts right at row 0 then.
 */
export function findHeaderRow(rows: string[][]): number {
  let best = -1;
  let bestScore = 1;
  rows.slice(0, HEADER_SEARCH_ROWS).forEach((row, i) => {
    const score = row.filter(looksLikeLabel).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export function headersOf(rows: string[][]): string[] {
  const index = findHeaderRow(rows);
  return index < 0 ? [] : rows[index].map((h) => h.trim());
}

/** Rows below the header (all of them when there's no header). */
export function dataRowsOf(rows: string[][]): string[][] {
  return rows.slice(findHeaderRow(rows) + 1);
}

/** Identical column names, in order — sheets sharing one are offered to share answers. `null` without a header. */
export function headerSignature(rows: string[][]): string | null {
  const headers = headersOf(rows);
  if (headers.filter(Boolean).length < 2) return null;
  return headers.map(normalize).join("␟").replace(/(␟)+$/, "");
}

const HEADER_PATTERNS: [PaymentTargetField, RegExp[]][] = [
  ["cpf", [/\bCPF\b/]],
  ["matricula", [/MATRIC/, /^MAT\.?$/, /\bCHAPA\b/, /\bRE\b/]],
  ["nome", [/^NOME$/, /NOME/, /COLABORADOR/, /FUNCIONARIO/, /EMPREGADO/, /PROFISSIONAL/]],
  ["data", [/^(DATA|DIA|DT)$/, /^DATA\b/, /\bDATA\b/]],
  ["horario", [/HORARIO/, /ENTRADA/, /\bTURNO\b/, /JORNADA/, /ESCALA/, /\bHORA/]],
  ["local", [/^LOCAL\b/, /LOCAL/, /UNIDADE/, /\bLOJA\b/, /\bPOSTO\b/, /FILIAL/, /\bOBRA\b/, /CLIENTE/]],
  ["funcao", [/FUNCAO/, /CARGO/, /ATIVIDADE/, /SETOR/]],
  ["status", [/STATUS/, /\bPAGO\b/, /SITUACAO/, /PAGAMENTO/]],
];

/** Share of `values` (non-empty ones) that pass `test`. */
function ratio(values: string[], test: (v: string) => boolean): number {
  const filled = values.filter((v) => v.trim());
  if (filled.length === 0) return 0;
  return filled.filter(test).length / filled.length;
}

/**
 * A first answer for every question, from the column names; Data and
 * Horário also fall back to the column whose values look like dates /
 * time ranges. Each column answers at most one question.
 */
export function guessMapping(rows: string[][]): Record<number, PaymentTargetField> {
  const headers = headersOf(rows).map(normalize);
  const used = new Set<number>();
  const result: Record<number, PaymentTargetField> = {};
  const has = (field: PaymentTargetField) => Object.values(result).includes(field);

  for (const [field, patterns] of HEADER_PATTERNS) {
    for (const pattern of patterns) {
      const index = headers.findIndex((h, i) => !used.has(i) && pattern.test(h));
      if (index >= 0) {
        result[index] = field;
        used.add(index);
        break;
      }
    }
  }

  const data = dataRowsOf(rows).slice(0, 60);
  const width = data.reduce((max, r) => Math.max(max, r.length), headers.length);
  const column = (i: number) => data.map((r) => r[i] ?? "");
  const byValues = (field: PaymentTargetField, test: (v: string) => boolean) => {
    if (has(field)) return;
    for (let i = 0; i < width; i++) {
      if (!used.has(i) && ratio(column(i), test) >= 0.6) {
        result[i] = field;
        used.add(i);
        return;
      }
    }
  };
  byValues("data", looksLikeDate);
  byValues("horario", (v) => parseScheduleToMinutes(v) !== null);
  return result;
}

/** Whether a freshly loaded sheet looks like it holds shifts at all — decides if it starts checked. */
export function looksLikeShiftSheet(rows: string[][]): boolean {
  const fields = Object.values(guessMapping(rows));
  return fields.includes("data") && fields.some((f) => f === "cpf" || f === "matricula" || f === "nome");
}

/** The date format, among `formats`, that reads the most of `values`; `current` wins ties. */
export function detectDateFormat(values: string[], formats: string[], current: string): string {
  const score = (f: string) => values.filter((v) => v.trim() && parseDateWithFormat(v, f) !== null).length;
  let best = current;
  let bestScore = score(current);
  for (const f of formats) {
    const s = score(f);
    if (s > bestScore) {
      best = f;
      bestScore = s;
    }
  }
  return best;
}

const IDENTIFIERS: IdentifierField[] = ["cpf", "matricula", "nome"];

export interface SheetCheckSample {
  who: string;
  date: string;
  schedule: string;
}

export interface SheetCheck {
  /** Rows that name someone — what should be shifts. */
  candidates: number;
  datesOk: number;
  /** Rows with both a readable date and a readable time range. */
  shifts: number;
  /** `null` when the sheet reads fine. */
  problem: { text: string; field: "data" | "horario" | "colaborador" } | null;
  samples: SheetCheckSample[];
}

/**
 * Reads a sheet's rows with its answers, the way an import would: a row is
 * a shift when its date parses. Flags the sheet when most rows that name
 * someone have no readable date (or, past that, no readable time range) —
 * the usual sign that a shared answer doesn't fit this sheet.
 */
export function checkSheet(rows: string[][], mapping: Record<number, PaymentTargetField>, dateFormat: string): SheetCheck {
  const colOf = (field: PaymentTargetField) => {
    const entry = Object.entries(mapping).find(([, f]) => f === field);
    return entry ? Number(entry[0]) : null;
  };
  const idCols = IDENTIFIERS.map(colOf).filter((c): c is number => c !== null);
  const dataCol = colOf("data");
  const scheduleCol = colOf("horario");
  const cell = (row: string[], col: number | null) => (col === null ? "" : (row[col] ?? "").trim());

  const candidates = dataRowsOf(rows).filter((r) => idCols.some((c) => cell(r, c)));
  const dated = candidates.filter((r) => parseDateWithFormat(cell(r, dataCol), dateFormat) !== null);
  const shifts = dated.filter((r) => parseScheduleToMinutes(cell(r, scheduleCol)) !== null);
  const samples = candidates.slice(0, 5).map((r) => ({
    who: idCols.map((c) => cell(r, c)).find(Boolean) ?? "",
    date: cell(r, dataCol),
    schedule: cell(r, scheduleCol),
  }));

  let problem: SheetCheck["problem"] = null;
  if (candidates.length === 0) {
    problem = { text: "nenhuma linha com colaborador", field: "colaborador" };
  } else if (dated.length < candidates.length / 2) {
    problem = { text: `${dated.length} de ${candidates.length} datas reconhecidas`, field: "data" };
  } else if (shifts.length < dated.length / 2) {
    problem = { text: `${shifts.length} de ${dated.length} horários reconhecidos`, field: "horario" };
  }
  return { candidates: candidates.length, datesOk: dated.length, shifts: shifts.length, problem, samples };
}

/* ---------- colaboradores (employee templates) ---------- */

const EMPLOYEE_HEADER_PATTERNS: [EmployeeTargetField, RegExp[]][] = [
  ["cpf", [/\bCPF\b/]],
  ["matricula", [/MATRIC/, /^MAT\.?$/, /\bCHAPA\b/, /\bRE\b/]],
  ["pix", [/\bPIX\b/, /CHAVE/]],
  ["nome", [/^NOME$/, /NOME/, /COLABORADOR/, /FUNCIONARIO/, /EMPREGADO/, /PROFISSIONAL/]],
];

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/** First answers for a colaboradores template, from the column names (CPF also from values that look like one). */
export function guessEmployeeMapping(rows: string[][]): Record<number, EmployeeTargetField> {
  const headers = headersOf(rows).map(normalize);
  const used = new Set<number>();
  const result: Record<number, EmployeeTargetField> = {};
  for (const [field, patterns] of EMPLOYEE_HEADER_PATTERNS) {
    for (const pattern of patterns) {
      const index = headers.findIndex((h, i) => !used.has(i) && pattern.test(h));
      if (index >= 0) {
        result[index] = field;
        used.add(index);
        break;
      }
    }
  }
  if (!Object.values(result).includes("cpf")) {
    const data = dataRowsOf(rows).slice(0, 60);
    const width = data.reduce((max, r) => Math.max(max, r.length), headers.length);
    for (let i = 0; i < width; i++) {
      if (!used.has(i) && ratio(data.map((r) => r[i] ?? ""), (v) => digitsOf(v).length === 11) >= 0.6) {
        result[i] = "cpf";
        break;
      }
    }
  }
  return result;
}

/** Whether a freshly loaded sheet looks like a list of people — decides if it starts checked. */
export function looksLikeEmployeeSheet(rows: string[][]): boolean {
  const fields = Object.values(guessEmployeeMapping(rows));
  return fields.some((f) => f === "cpf" || f === "matricula" || f === "nome") && dataRowsOf(rows).some((r) => r.some((c) => c.trim()));
}

export interface EmployeeSheetCheck {
  /** Rows that name someone. */
  people: number;
  problem: { text: string; field: "colaborador" | "cpf" } | null;
  samples: { who: string; cpf: string }[];
}

/** Reads a sheet's rows with its answers: how many people it has, and whether its CPF column holds CPFs. */
export function checkEmployeeSheet(rows: string[][], mapping: Record<number, EmployeeTargetField>): EmployeeSheetCheck {
  const colOf = (field: EmployeeTargetField) => {
    const entry = Object.entries(mapping).find(([, f]) => f === field);
    return entry ? Number(entry[0]) : null;
  };
  const idCols = IDENTIFIERS.map(colOf).filter((c): c is number => c !== null);
  const cpfCol = colOf("cpf");
  const nameCol = colOf("nome");
  const cell = (row: string[], col: number | null) => (col === null ? "" : (row[col] ?? "").trim());

  const people = dataRowsOf(rows).filter((r) => idCols.some((c) => cell(r, c)));
  const samples = people.slice(0, 5).map((r) => ({
    who: cell(r, nameCol) || idCols.map((c) => cell(r, c)).find(Boolean) || "",
    cpf: cell(r, cpfCol),
  }));

  let problem: EmployeeSheetCheck["problem"] = null;
  if (people.length === 0) {
    problem = { text: "nenhuma linha com colaborador", field: "colaborador" };
  } else if (cpfCol !== null) {
    const filled = people.filter((r) => cell(r, cpfCol));
    const valid = filled.filter((r) => digitsOf(cell(r, cpfCol)).length === 11);
    if (filled.length > 0 && valid.length < filled.length / 2) {
      problem = { text: `${valid.length} de ${filled.length} CPFs reconhecidos`, field: "cpf" };
    }
  }
  return { people: people.length, problem, samples };
}

/**
 * The header row of a colaboradores sheet, or -1. Stricter than
 * `findHeaderRow`: the row must have a column name we know (Nome, CPF,
 * Matrícula, PIX...), because the import skips this row and everything
 * above it — a sheet without a header must not lose its first person.
 */
export function employeeHeaderRow(rows: string[][]): number {
  const index = findHeaderRow(rows);
  if (index < 0) return -1;
  const known = rows[index].map(normalize).some((h) => EMPLOYEE_HEADER_PATTERNS.some(([, patterns]) => patterns.some((p) => p.test(h))));
  return known ? index : -1;
}
