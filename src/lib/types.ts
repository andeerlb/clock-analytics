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
 */
export interface FileParseResult {
  path: string;
  fileName: string;
  sheets: ParsedTimesheet[];
  error: string | null;
}

export interface ProviderInfo {
  id: string;
  label: string;
}

/** Content-hash of a picked file, computed before any parsing happens. */
export interface FileHash {
  path: string;
  fileName: string;
  hash: string;
}

/**
 * A previously-imported file, found by matching a hash against `import_files`.
 * `employees` lists every import that came from this file — a consolidated
 * PDF can hold more than one person, so there's no single "the" employee to
 * point at.
 */
export interface DuplicateFileInfo {
  importFileId: number;
  fileName: string;
  importedAt: string;
  employees: { importId: number; employeeName: string; companyName: string }[];
}

export interface ImportFileRow {
  id: number;
  fileName: string;
  fileHash: string;
  importedAt: string;
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
  periodStart: string;
  periodEnd: string;
  originalPdfPath: string;
  importedAt: string;
}
