import Database from "@tauri-apps/plugin-sql";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  ImportFileRow,
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
 * Given a batch of file hashes (from `hashFiles`), finds which ones were
 * already imported before — identity is content-based, so a renamed or
 * re-picked copy of the same PDF is still recognized.
 */
export async function findDuplicateFiles(
  hashes: string[],
): Promise<Map<string, DuplicateFileInfo>> {
  if (hashes.length === 0) return new Map();
  const db = await getDb();

  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<
    {
      importFileId: number;
      fileHash: string;
      fileName: string;
      importedAt: string;
      importId: number;
      employeeName: string;
      companyName: string;
    }[]
  >(
    `
    SELECT
      f.id AS importFileId,
      f.file_hash AS fileHash,
      f.file_name AS fileName,
      f.imported_at AS importedAt,
      i.id AS importId,
      e.name AS employeeName,
      c.name AS companyName
    FROM import_files f
    JOIN imports i ON i.import_file_id = f.id
    JOIN employees e ON e.id = i.employee_id
    JOIN companies c ON c.id = e.company_id
    WHERE f.file_hash IN (${placeholders})
    `,
    hashes,
  );

  const byHash = new Map<string, DuplicateFileInfo>();
  for (const row of rows) {
    // A file can map to more than one employee (consolidated PDFs); the
    // first match is enough to tell the user "this was already imported".
    if (!byHash.has(row.fileHash)) {
      byHash.set(row.fileHash, {
        importFileId: row.importFileId,
        fileName: row.fileName,
        importedAt: row.importedAt,
        employeeName: row.employeeName,
        companyName: row.companyName,
        importId: row.importId,
      });
    }
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

export async function listImportFiles(): Promise<ImportFileRow[]> {
  const db = await getDb();
  return db.select<ImportFileRow[]>(`
    SELECT id, file_name AS fileName, file_hash AS fileHash, imported_at AS importedAt
    FROM import_files
    ORDER BY imported_at DESC
  `);
}
