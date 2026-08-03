import Database from "@tauri-apps/plugin-sql";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  ImportFileRow,
  ImportStatus,
  ParsedTimesheet,
  StoredDayRecord,
  StoredImport,
} from "./types";

export const DB_URL = "sqlite:clock-analytics.db";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}

async function upsertCompany(db: Database, name: string, cnpj: string): Promise<number> {
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM companies WHERE cnpj = $1",
    [cnpj],
  );
  if (existing.length > 0) {
    await db.execute("UPDATE companies SET name = $1 WHERE id = $2", [name, existing[0].id]);
    return existing[0].id;
  }
  const result = await db.execute("INSERT INTO companies (name, cnpj) VALUES ($1, $2)", [
    name,
    cnpj,
  ]);
  return result.lastInsertId as number;
}

async function upsertEmployee(
  db: Database,
  companyId: number,
  name: string,
  cpf: string,
): Promise<number> {
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE company_id = $1 AND cpf = $2",
    [companyId, cpf],
  );
  if (existing.length > 0) {
    await db.execute("UPDATE employees SET name = $1 WHERE id = $2", [name, existing[0].id]);
    return existing[0].id;
  }
  const result = await db.execute(
    "INSERT INTO employees (company_id, name, cpf) VALUES ($1, $2, $3)",
    [companyId, name, cpf],
  );
  return result.lastInsertId as number;
}

async function upsertImportFile(db: Database, fileName: string, fileHash: string): Promise<number> {
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM import_files WHERE file_hash = $1",
    [fileHash],
  );
  if (existing.length > 0) return existing[0].id;
  const result = await db.execute(
    "INSERT INTO import_files (file_name, file_hash) VALUES ($1, $2)",
    [fileName, fileHash],
  );
  return result.lastInsertId as number;
}

/**
 * Logs one import attempt — called right after parsing, regardless of
 * outcome, so the import history reflects every file that was ever
 * processed, not just the ones that ended up saved. Re-processing the same
 * file (same hash) refreshes this row instead of duplicating it.
 */
export async function logSourceFile(input: {
  fileHash: string;
  fileName: string;
  pageCount: number;
  provider: string;
  status: ImportStatus;
  errorMessage: string | null;
  originalPdfPath: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_files
       (file_name, file_hash, page_count, provider, status, error_message, original_pdf_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(file_hash) DO UPDATE SET
       file_name = excluded.file_name,
       page_count = excluded.page_count,
       provider = excluded.provider,
       status = excluded.status,
       error_message = excluded.error_message,
       original_pdf_path = excluded.original_pdf_path,
       imported_at = datetime('now')`,
    [
      input.fileName,
      input.fileHash,
      input.pageCount,
      input.provider,
      input.status,
      input.errorMessage,
      input.originalPdfPath,
    ],
  );
}

/**
 * Marks that at least one sheet from this original file was actually saved.
 * The "já importado, não reprocessar" pre-check keys off this — a file can
 * parse fine (and show up in history) without ever being saved, and in
 * that case it should still be reprocessable.
 */
export async function markSourceFileSaved(fileHash: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE source_files SET saved_at = datetime('now') WHERE file_hash = $1", [
    fileHash,
  ]);
}

/**
 * Deletes an import and its day_records/punches. Cascades are done by hand
 * rather than relying on `ON DELETE CASCADE`, since sqlite only enforces
 * foreign keys when `PRAGMA foreign_keys = ON` was set on the connection,
 * which isn't guaranteed here.
 */
export async function deleteImport(importId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM punches WHERE day_record_id IN (SELECT id FROM day_records WHERE import_id = $1)",
    [importId],
  );
  await db.execute("DELETE FROM day_records WHERE import_id = $1", [importId]);
  await db.execute("DELETE FROM imports WHERE id = $1", [importId]);
}

/**
 * Persists one parsed timesheet (and its days/punches) into SQLite.
 * Pass `replaceImportId` to overwrite an existing conflicting import
 * (same employee+company+overlapping period) instead of adding alongside it.
 */
export async function saveParsedTimesheet(
  sheet: ParsedTimesheet,
  replaceImportId?: number,
): Promise<number> {
  const db = await getDb();

  if (replaceImportId !== undefined) {
    await deleteImport(replaceImportId);
  }

  const companyId = await upsertCompany(db, sheet.company.name, sheet.company.cnpj);
  const employeeId = await upsertEmployee(db, companyId, sheet.employee.name, sheet.employee.cpf);
  const importFileId = await upsertImportFile(db, sheet.originalFileName, sheet.originalFileHash);

  const importResult = await db.execute(
    `INSERT INTO imports (provider, employee_id, period_start, period_end, original_pdf_path, import_file_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sheet.provider,
      employeeId,
      sheet.period.start,
      sheet.period.end,
      sheet.originalPdfPath,
      importFileId,
    ],
  );
  const importId = importResult.lastInsertId as number;

  for (const day of sheet.days) {
    const dayResult = await db.execute(
      `INSERT INTO day_records
         (import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        importId,
        day.date,
        day.weekday,
        day.totalWorkedMinutes,
        day.normalHoursMinutes,
        day.absenceMinutes,
        day.observation,
      ],
    );
    const dayRecordId = dayResult.lastInsertId as number;

    for (let i = 0; i < day.punches.length; i++) {
      await db.execute(
        "INSERT INTO punches (day_record_id, punch_time, sequence_index) VALUES ($1, $2, $3)",
        [dayRecordId, day.punches[i], i],
      );
    }
  }

  return importId;
}

export interface CompanyRow {
  id: number;
  name: string;
  cnpj: string;
}

export async function listCompanies(): Promise<CompanyRow[]> {
  const db = await getDb();
  return db.select<CompanyRow[]>("SELECT id, name, cnpj FROM companies ORDER BY name");
}

export async function listImports(): Promise<StoredImport[]> {
  const db = await getDb();
  return db.select<StoredImport[]>(`
    SELECT
      i.id AS importId,
      i.provider AS provider,
      i.employee_id AS employeeId,
      e.name AS employeeName,
      e.cpf AS employeeCpf,
      c.id AS companyId,
      c.name AS companyName,
      i.period_start AS periodStart,
      i.period_end AS periodEnd,
      i.original_pdf_path AS originalPdfPath,
      i.imported_at AS importedAt
    FROM imports i
    JOIN employees e ON e.id = i.employee_id
    JOIN companies c ON c.id = e.company_id
    ORDER BY i.imported_at DESC
  `);
}

interface DayRecordFilters {
  importId?: number;
  companyId?: number;
  periodStart?: string;
  periodEnd?: string;
}

/** Reads day records joined with their employee/company, punches attached. */
export async function listStoredDayRecords(
  filters: DayRecordFilters,
): Promise<StoredDayRecord[]> {
  const db = await getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.importId !== undefined) {
    params.push(filters.importId);
    conditions.push(`i.id = $${params.length}`);
  }
  if (filters.companyId !== undefined) {
    params.push(filters.companyId);
    conditions.push(`c.id = $${params.length}`);
  }
  if (filters.periodStart !== undefined) {
    params.push(filters.periodStart);
    conditions.push(`d.date >= $${params.length}`);
  }
  if (filters.periodEnd !== undefined) {
    params.push(filters.periodEnd);
    conditions.push(`d.date <= $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await db.select<Omit<StoredDayRecord, "punches">[]>(
    `
    SELECT
      d.id AS dayRecordId,
      d.import_id AS importId,
      e.id AS employeeId,
      e.name AS employeeName,
      e.cpf AS employeeCpf,
      c.id AS companyId,
      c.name AS companyName,
      i.original_pdf_path AS originalPdfPath,
      d.date AS date,
      d.weekday AS weekday,
      d.total_worked_minutes AS totalWorkedMinutes,
      d.normal_hours_minutes AS normalHoursMinutes,
      d.absence_minutes AS absenceMinutes,
      d.observation AS observation
    FROM day_records d
    JOIN imports i ON i.id = d.import_id
    JOIN employees e ON e.id = i.employee_id
    JOIN companies c ON c.id = e.company_id
    ${where}
    ORDER BY e.name, d.date
    `,
    params,
  );

  if (rows.length === 0) return [];

  const dayRecordIds = rows.map((r) => r.dayRecordId);
  const placeholders = dayRecordIds.map((_, i) => `$${i + 1}`).join(", ");
  const punchRows = await db.select<
    { dayRecordId: number; punchTime: string; sequenceIndex: number }[]
  >(
    `SELECT day_record_id AS dayRecordId, punch_time AS punchTime, sequence_index AS sequenceIndex
     FROM punches WHERE day_record_id IN (${placeholders}) ORDER BY day_record_id, sequence_index`,
    dayRecordIds,
  );

  const punchesByDay = new Map<number, string[]>();
  for (const p of punchRows) {
    const list = punchesByDay.get(p.dayRecordId) ?? [];
    list.push(p.punchTime);
    punchesByDay.set(p.dayRecordId, list);
  }

  return rows.map((r) => ({ ...r, punches: punchesByDay.get(r.dayRecordId) ?? [] }));
}

/**
 * Given a batch of whole-file hashes (from `hashFiles`), finds which ones
 * were already *saved* before — identity is content-based, so a renamed or
 * re-picked copy of the same PDF is still recognized. Deliberately keyed on
 * `saved_at`, not just having been processed: a file can parse fine and
 * show up in the import history without anything from it actually being
 * saved, and in that case it should stay reprocessable.
 *
 * For a single-page file the matching employee is resolved and linked; for
 * a multi-page batch file we deliberately don't try to say who's in it at
 * this stage (that would mean reprocessing it) — the caller just gets
 * "already imported" + when, with an empty `employees` list.
 */
export async function findDuplicateFiles(
  hashes: string[],
): Promise<Map<string, DuplicateFileInfo>> {
  if (hashes.length === 0) return new Map();
  const db = await getDb();

  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const sourceRows = await db.select<
    { fileHash: string; fileName: string; importedAt: string; pageCount: number }[]
  >(
    `SELECT file_hash AS fileHash, file_name AS fileName, imported_at AS importedAt,
            page_count AS pageCount
     FROM source_files WHERE file_hash IN (${placeholders}) AND saved_at IS NOT NULL`,
    hashes,
  );
  if (sourceRows.length === 0) return new Map();

  const singlePageHashes = sourceRows.filter((r) => r.pageCount === 1).map((r) => r.fileHash);
  const employeesByHash = new Map<
    string,
    { importId: number; employeeName: string; companyName: string }[]
  >();
  if (singlePageHashes.length > 0) {
    const ph = singlePageHashes.map((_, i) => `$${i + 1}`).join(", ");
    const empRows = await db.select<
      { fileHash: string; importId: number; employeeName: string; companyName: string }[]
    >(
      `
      SELECT f.file_hash AS fileHash, i.id AS importId, e.name AS employeeName, c.name AS companyName
      FROM import_files f
      JOIN imports i ON i.import_file_id = f.id
      JOIN employees e ON e.id = i.employee_id
      JOIN companies c ON c.id = e.company_id
      WHERE f.file_hash IN (${ph})
      `,
      singlePageHashes,
    );
    for (const row of empRows) {
      const list = employeesByHash.get(row.fileHash) ?? [];
      list.push({ importId: row.importId, employeeName: row.employeeName, companyName: row.companyName });
      employeesByHash.set(row.fileHash, list);
    }
  }

  const byHash = new Map<string, DuplicateFileInfo>();
  for (const row of sourceRows) {
    byHash.set(row.fileHash, {
      fileName: row.fileName,
      importedAt: row.importedAt,
      pageCount: row.pageCount,
      employees: employeesByHash.get(row.fileHash) ?? [],
    });
  }
  return byHash;
}

/**
 * Looks for an existing import of the same employee at the same company
 * whose period overlaps the given range — the "you already imported this
 * person for this period" check, independent of which file it came from.
 */
export async function findConflictingImport(
  employeeCpf: string,
  companyCnpj: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ importId: number; periodStart: string; periodEnd: string; importedAt: string } | null> {
  const db = await getDb();
  const rows = await db.select<
    { importId: number; periodStart: string; periodEnd: string; importedAt: string }[]
  >(
    `
    SELECT i.id AS importId, i.period_start AS periodStart, i.period_end AS periodEnd,
           i.imported_at AS importedAt
    FROM imports i
    JOIN employees e ON e.id = i.employee_id
    JOIN companies c ON c.id = e.company_id
    WHERE e.cpf = $1 AND c.cnpj = $2
      AND i.period_start <= $4 AND i.period_end >= $3
    ORDER BY i.imported_at DESC
    LIMIT 1
    `,
    [employeeCpf, companyCnpj, periodStart, periodEnd],
  );
  return rows[0] ?? null;
}

/** Checks a batch of freshly-parsed sheets against existing imports for period overlaps. */
export async function findConflicts(sheets: ParsedTimesheet[]): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const existing = await findConflictingImport(
      sheet.employee.cpf,
      sheet.company.cnpj,
      sheet.period.start,
      sheet.period.end,
    );
    if (existing) {
      conflicts.push({
        sheetIndex: i,
        existingImportId: existing.importId,
        existingPeriodStart: existing.periodStart,
        existingPeriodEnd: existing.periodEnd,
        existingImportedAt: existing.importedAt,
      });
    }
  }
  return conflicts;
}

/** The import history: every file ever processed, most recent first. */
export async function listImportFiles(): Promise<ImportFileRow[]> {
  const db = await getDb();
  return db.select<ImportFileRow[]>(`
    SELECT
      id,
      file_name AS fileName,
      file_hash AS fileHash,
      provider,
      status,
      error_message AS errorMessage,
      original_pdf_path AS originalPdfPath,
      page_count AS pageCount,
      imported_at AS importedAt,
      saved_at AS savedAt
    FROM source_files
    ORDER BY imported_at DESC
  `);
}
