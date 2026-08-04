export interface Company {
  name: string;
  cnpj: string;
}

export interface Employee {
  name: string;
  cpf: string;
}

export interface Period {
  /** ISO 8601 date (YYYY-MM-DD) */
  start: string;
  /** ISO 8601 date (YYYY-MM-DD) */
  end: string;
}

/**
 * One row of the original timesheet grid, normalized. `punches` is a loose
 * ordered list (not fixed ent1/sai1/ent2/sai2 slots) so providers with a
 * different number of clock pairs fit the same shape.
 */
export interface DayRecord {
  /** ISO 8601 date (YYYY-MM-DD) */
  date: string;
  weekday: string;
  /** "HH:MM" strings, in the order they appear on the row */
  punches: string[];
  totalWorkedMinutes: number;
  normalHoursMinutes: number;
  absenceMinutes: number;
  observation: string | null;
}

/** Result of parsing one PDF (or one employee block within a consolidated PDF). */
export interface ParsedTimesheet {
  provider: string;
  company: Company;
  employee: Employee;
  period: Period;
  days: DayRecord[];
  /** Path to the copy of the original PDF kept in the app's data dir. */
  originalPdfPath: string;
  /** sha256 of the source PDF's bytes — identifies the file regardless of path/name. */
  originalFileHash: string;
  originalFileName: string;
}

/**
 * Outcome of parsing one source file. Each file is parsed independently, so
 * a failure on one PDF in a batch doesn't hide the results already
 * extracted from the others.
 *
 * A file with more than one page holds one timesheet per page (Coalize
 * batch exports put one employee per page) — `fileHash`/`pageCount` are
 * about the *whole original file*, distinct from each sheet's own
 * `originalFileHash`, which for a multi-page file is that page's own hash.
 *
 * `error` can be set *alongside* non-empty `sheets`: for a multi-page file
 * that means some pages parsed fine and others didn't (a "warning" outcome,
 * not a full failure).
 */
export interface FileParseResult {
  path: string;
  fileName: string;
  fileHash: string;
  pageCount: number;
  /** Copy of the whole original file, kept regardless of outcome. */
  originalPdfPath: string;
  sheets: ParsedTimesheet[];
  error: string | null;
}

export type ImportStatus = "success" | "warning" | "error";

export function importStatusOf(result: Pick<FileParseResult, "sheets" | "error">): ImportStatus {
  if (!result.error) return "success";
  return result.sheets.length > 0 ? "warning" : "error";
}

export interface ProviderInfo {
  id: string;
  label: string;
}

/**
 * One file to place inside the Relatórios export zip. `zipPath` is the
 * full relative path within the archive, folders and all (e.g.
 * "Empresa X/Cliente Y/Nome - jul-2026.pdf"). A single source path is
 * copied in as-is; more than one means "merge these into a single
 * per-client document" (done with `pdfunite` on the Rust side).
 */
export interface ReportZipEntry {
  zipPath: string;
  sourcePdfPaths: string[];
}

/** Content-hash of a picked file, computed before any parsing happens. */
export interface FileHash {
  path: string;
  fileName: string;
  hash: string;
  pageCount: number;
}

/**
 * A previously-imported file, found by matching a whole-file hash against
 * `source_files`. For a single-page file we can also say *who* it was
 * (`employees`); for a multi-page batch we deliberately don't try to
 * resolve that without reprocessing, so `employees` stays empty.
 */
export interface DuplicateFileInfo {
  fileName: string;
  importedAt: string;
  pageCount: number;
  employees: { importId: number; employeeName: string; companyName: string }[];
}

/** A logged import attempt — one row per distinct file ever processed. */
export interface ImportFileRow {
  id: number;
  fileName: string;
  fileHash: string;
  provider: string;
  status: ImportStatus;
  errorMessage: string | null;
  originalPdfPath: string;
  pageCount: number;
  importedAt: string;
  /** Set once at least one sheet from this file was actually saved. */
  savedAt: string | null;
}

/** An existing import for the same employee+company whose period overlaps a freshly parsed sheet. */
export interface ConflictInfo {
  sheetIndex: number;
  existingImportId: number;
  existingPeriodStart: string;
  existingPeriodEnd: string;
  existingImportedAt: string;
}

/** A row as read back from SQLite, joined with its parent import/employee/company. */
export interface StoredDayRecord {
  dayRecordId: number;
  importId: number;
  employeeId: number;
  employeeName: string;
  employeeCpf: string;
  companyId: number;
  companyName: string;
  clientId: number;
  clientName: string;
  originalPdfPath: string;
  date: string;
  weekday: string;
  totalWorkedMinutes: number;
  normalHoursMinutes: number;
  absenceMinutes: number;
  observation: string | null;
  punches: string[];
}

export interface StoredImport {
  importId: number;
  provider: string;
  employeeId: number;
  employeeName: string;
  employeeCpf: string;
  companyId: number;
  companyName: string;
  clientId: number;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  /** This employee's own PDF (their split-off page, for a multi-page batch). */
  originalPdfPath: string;
  /**
   * The whole original file this import came from — `null` for imports
   * saved before this link existed. Equal to `originalPdfPath` when the
   * source was a single-page file; distinct for a multi-page batch.
   */
  sourceOriginalPdfPath: string | null;
  /**
   * How many punch columns this import's grid needs (2 pairs, i.e. 4, by
   * default — more if some day actually had more clock-ins). Computed once
   * at import time; the UI just reads it instead of scanning day_records.
   */
  maxPunches: number;
  /**
   * Aggregates over this import's whole (fixed) period — summed once at
   * import time from its day_records rather than recomputed live, since
   * the period itself never changes once saved. `overtimeMinutes` is the
   * sum of the excess above the (non-configurable) overtime threshold on
   * days that went over it; `regularMinutes` sums each day's normal hours.
   *
   * `absenceMinutes` and `lateMinutes` split what used to be one bucket:
   * a day counts toward `absenceMinutes` (falta) when it has no valid
   * punch pair (0 or 1 punches — a lone punch isn't a pair), and toward
   * `lateMinutes` (atraso) when it has at least one pair but still came
   * up short on hours. Together they equal the old single total.
   */
  totalWorkedMinutes: number;
  overtimeMinutes: number;
  absenceMinutes: number;
  lateMinutes: number;
  regularMinutes: number;
  intervalMinutes: number;
  importedAt: string;
}
