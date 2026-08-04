import Database from "@tauri-apps/plugin-sql";
import { overtimeMinutesForDay, sumIntervalMinutes } from "./analysis";
import { normalizeCnpj } from "./format";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  ImportFileRow,
  ImportStatus,
  ImportType,
  ParsedTimesheet,
  StoredDayRecord,
  StoredImport,
} from "./types";

export const DB_URL = "sqlite:pontoscan.db";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}

async function upsertEmployee(
  db: Database,
  companyId: number,
  clientId: number,
  name: string,
  cpf: string,
): Promise<number> {
  // Scoped to the client, not the broader company — a CPF is unique to the
  // specific legal entity (client) it worked for, and a company can have
  // several of those.
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE client_id = $1 AND cpf = $2",
    [clientId, cpf],
  );
  if (existing.length > 0) {
    await db.execute("UPDATE employees SET name = $1 WHERE id = $2", [name, existing[0].id]);
    return existing[0].id;
  }
  const result = await db.execute(
    "INSERT INTO employees (company_id, client_id, name, cpf) VALUES ($1, $2, $3, $4)",
    [companyId, clientId, name, cpf],
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
 *
 * Returns the `source_files.id`, so a save that follows can link its
 * `imports` row back to the whole original file (not just its own page).
 */
export async function logSourceFile(input: {
  fileHash: string;
  fileName: string;
  pageCount: number;
  provider: string;
  importType: ImportType;
  status: ImportStatus;
  errorMessage: string | null;
  originalPdfPath: string;
}): Promise<number> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_files
       (file_name, file_hash, page_count, provider, import_type, status, error_message, original_pdf_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(file_hash) DO UPDATE SET
       file_name = excluded.file_name,
       page_count = excluded.page_count,
       provider = excluded.provider,
       import_type = excluded.import_type,
       status = excluded.status,
       error_message = excluded.error_message,
       original_pdf_path = excluded.original_pdf_path,
       imported_at = datetime('now')`,
    [
      input.fileName,
      input.fileHash,
      input.pageCount,
      input.provider,
      input.importType,
      input.status,
      input.errorMessage,
      input.originalPdfPath,
    ],
  );
  // `lastInsertId` isn't reliable across the ON CONFLICT DO UPDATE path, so
  // look the row up explicitly rather than trust it.
  const row = await db.select<{ id: number }[]>(
    "SELECT id FROM source_files WHERE file_hash = $1",
    [input.fileHash],
  );
  return row[0].id;
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
 * Persists one parsed timesheet (and its days/punches) into SQLite, under
 * `clientId` — the client the user explicitly selected before importing,
 * not whatever `sheet.company` says — and `companyId`, the specific
 * company (among that client's linked companies) chosen for this import.
 * Clients/companies are pre-registered (see `createClient`/`createCompany`);
 * imports no longer create either on the fly.
 * Pass `replaceImportId` to overwrite an existing conflicting import
 * (same employee+client+overlapping period) instead of adding alongside it.
 * Pass `sourceFileId` (from `logSourceFile`) to link back to the whole
 * original file — for a multi-page batch, that's distinct from this sheet's
 * own split-off page.
 */
export async function saveParsedTimesheet(
  sheet: ParsedTimesheet,
  clientId: number,
  companyId: number,
  replaceImportId?: number,
  sourceFileId?: number,
): Promise<number> {
  const db = await getDb();

  if (replaceImportId !== undefined) {
    await deleteImport(replaceImportId);
  }

  // A client can be linked to more than one company, so the pairing has to
  // be validated explicitly rather than derived.
  const link = await db.select<{ clientId: number }[]>(
    "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
    [clientId, companyId],
  );
  if (link.length === 0) {
    throw new Error("Esse cliente não está vinculado à empresa selecionada.");
  }

  const employeeId = await upsertEmployee(
    db,
    companyId,
    clientId,
    sheet.employee.name,
    sheet.employee.cpf,
  );
  const importFileId = await upsertImportFile(db, sheet.originalFileName, sheet.originalFileHash);

  // Computed once, here, at import time, over the whole (fixed) period —
  // the UI reads these instead of scanning day_records on every render.
  // `maxPunches` floors at 4 (2 pairs), matching the fixed grid the PDF
  // itself always has, even on days that leave it unfilled.
  let maxPunches = 4;
  let totalWorkedMinutes = 0;
  let overtimeMinutes = 0;
  // Falta (no valid punch pair — 0 or 1 punches) vs atraso (has a pair but
  // still came up short) — two buckets of the same underlying per-day
  // absence minutes, split by that day's own punch count.
  let absenceMinutes = 0;
  let lateMinutes = 0;
  let regularMinutes = 0;
  let intervalMinutes = 0;
  // A day with an odd punch count (a dangling entrada or saída with no
  // pair) — same condition as the Cartão de Ponto's own "Marcação
  // pendente" day filter, counted here so the period-level list/report
  // filter can flag it without loading every import's day_records.
  let pendingCount = 0;
  for (const day of sheet.days) {
    maxPunches = Math.max(maxPunches, day.punches.length);
    totalWorkedMinutes += day.totalWorkedMinutes;
    overtimeMinutes += overtimeMinutesForDay(day);
    if (day.punches.length < 2) {
      absenceMinutes += day.absenceMinutes;
    } else {
      lateMinutes += day.absenceMinutes;
    }
    regularMinutes += day.normalHoursMinutes;
    intervalMinutes += sumIntervalMinutes(day.punches);
    if (day.punches.length % 2 !== 0) pendingCount++;
  }

  const importResult = await db.execute(
    `INSERT INTO imports
       (provider, employee_id, period_start, period_end, original_pdf_path, import_file_id,
        source_file_id, max_punches, total_worked_minutes, overtime_minutes, absence_minutes,
        late_minutes, regular_minutes, interval_minutes, pending_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      sheet.provider,
      employeeId,
      sheet.period.start,
      sheet.period.end,
      sheet.originalPdfPath,
      importFileId,
      sourceFileId ?? null,
      maxPunches,
      totalWorkedMinutes,
      overtimeMinutes,
      absenceMinutes,
      lateMinutes,
      regularMinutes,
      intervalMinutes,
      pendingCount,
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

export interface CompanyWithStats extends CompanyRow {
  employeeCount: number;
}

export async function listCompaniesWithStats(): Promise<CompanyWithStats[]> {
  const db = await getDb();
  return db.select<CompanyWithStats[]>(`
    SELECT c.id, c.name, c.cnpj, COUNT(DISTINCT e.id) AS employeeCount
    FROM companies c
    LEFT JOIN employees e ON e.company_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `);
}

/**
 * Registers a new company. CNPJ is the natural key — registering one that
 * already exists is rejected rather than silently updating the name, since
 * a typo'd CNPJ should surface as an error, not quietly merge into another
 * company's record.
 */
export async function createCompany(name: string, cnpj: string): Promise<number> {
  const db = await getDb();
  const normalizedCnpj = normalizeCnpj(cnpj);
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM companies WHERE cnpj = $1",
    [normalizedCnpj],
  );
  if (existing.length > 0) {
    throw new Error("Já existe uma empresa cadastrada com esse CNPJ.");
  }
  const result = await db.execute("INSERT INTO companies (name, cnpj) VALUES ($1, $2)", [
    name.trim(),
    normalizedCnpj,
  ]);
  return result.lastInsertId as number;
}

// One row per (client, company) link — a client with multiple companies
// shows up once per company here, which is the shape both the ClientsPage
// table and the ImportPage "which companies is this client linked to"
// lookup want.
export interface ClientRow {
  id: number;
  name: string;
  cnpj: string;
  companyId: number;
  companyName: string;
}

export async function listClients(): Promise<ClientRow[]> {
  const db = await getDb();
  return db.select<ClientRow[]>(`
    SELECT cl.id, cl.name, cl.cnpj, c.id AS companyId, c.name AS companyName
    FROM clients cl
    JOIN client_companies cc ON cc.client_id = cl.id
    JOIN companies c ON c.id = cc.company_id
    ORDER BY c.name, cl.name
  `);
}

export interface ClientWithStats extends ClientRow {
  employeeCount: number;
}

export async function listClientsWithStats(): Promise<ClientWithStats[]> {
  const db = await getDb();
  return db.select<ClientWithStats[]>(`
    SELECT cl.id, cl.name, cl.cnpj, c.id AS companyId, c.name AS companyName,
           COUNT(DISTINCT e.id) AS employeeCount
    FROM clients cl
    JOIN client_companies cc ON cc.client_id = cl.id
    JOIN companies c ON c.id = cc.company_id
    LEFT JOIN employees e ON e.client_id = cl.id
    GROUP BY cl.id, c.id
    ORDER BY c.name, cl.name
  `);
}

/**
 * Registers a client under `companyId`. A client's CNPJ is a globally
 * unique physical entity — just like a company's — but the same client can
 * be linked to more than one company. So this either creates a brand new
 * client (no client with that CNPJ exists yet) or links an existing one
 * (found by CNPJ) to this additional company. Linking the same client to
 * the same company twice is rejected.
 */
export async function createClient(
  companyId: number,
  name: string,
  cnpj: string,
): Promise<number> {
  const db = await getDb();
  const normalizedCnpj = normalizeCnpj(cnpj);

  const existing = await db.select<{ id: number }[]>("SELECT id FROM clients WHERE cnpj = $1", [
    normalizedCnpj,
  ]);

  let clientId: number;
  if (existing.length > 0) {
    clientId = existing[0].id;
    const existingLink = await db.select<{ clientId: number }[]>(
      "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
      [clientId, companyId],
    );
    if (existingLink.length > 0) {
      throw new Error("Esse cliente já está vinculado a essa empresa.");
    }
  } else {
    const result = await db.execute("INSERT INTO clients (name, cnpj) VALUES ($1, $2)", [
      name.trim(),
      normalizedCnpj,
    ]);
    clientId = result.lastInsertId as number;
  }

  await db.execute(
    "INSERT INTO client_companies (client_id, company_id) VALUES ($1, $2)",
    [clientId, companyId],
  );
  return clientId;
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
      cl.id AS clientId,
      cl.name AS clientName,
      i.period_start AS periodStart,
      i.period_end AS periodEnd,
      i.original_pdf_path AS originalPdfPath,
      sf.original_pdf_path AS sourceOriginalPdfPath,
      i.max_punches AS maxPunches,
      i.total_worked_minutes AS totalWorkedMinutes,
      i.overtime_minutes AS overtimeMinutes,
      i.absence_minutes AS absenceMinutes,
      i.late_minutes AS lateMinutes,
      i.regular_minutes AS regularMinutes,
      i.interval_minutes AS intervalMinutes,
      i.pending_count AS pendingCount,
      i.imported_at AS importedAt
    FROM imports i
    JOIN employees e ON e.id = i.employee_id
    JOIN companies c ON c.id = e.company_id
    LEFT JOIN clients cl ON cl.id = e.client_id
    LEFT JOIN source_files sf ON sf.id = i.source_file_id
    ORDER BY i.imported_at DESC
  `);
}

interface DayRecordFilters {
  importId?: number;
  companyId?: number;
  clientId?: number;
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
  if (filters.clientId !== undefined) {
    params.push(filters.clientId);
    conditions.push(`cl.id = $${params.length}`);
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
      cl.id AS clientId,
      cl.name AS clientName,
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
    LEFT JOIN clients cl ON cl.id = e.client_id
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
 * Looks for an existing import of the same employee at the same client
 * whose period overlaps the given range — the "you already imported this
 * person for this period" check, independent of which file it came from.
 */
export async function findConflictingImport(
  employeeCpf: string,
  clientId: number,
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
    WHERE e.cpf = $1 AND e.client_id = $2
      AND i.period_start <= $4 AND i.period_end >= $3
    ORDER BY i.imported_at DESC
    LIMIT 1
    `,
    [employeeCpf, clientId, periodStart, periodEnd],
  );
  return rows[0] ?? null;
}

/**
 * Checks a batch of freshly-parsed sheets against existing imports for
 * period overlaps — under `clientId`, the client the user selected for
 * this whole batch (not whatever each sheet's own parsed company says).
 */
export async function findConflicts(
  sheets: ParsedTimesheet[],
  clientId: number,
): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const existing = await findConflictingImport(
      sheet.employee.cpf,
      clientId,
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

/** The import history for one import flow (timesheet or payment), most recent first. */
export async function listImportFiles(importType: ImportType): Promise<ImportFileRow[]> {
  const db = await getDb();
  return db.select<ImportFileRow[]>(
    `SELECT
      id,
      file_name AS fileName,
      file_hash AS fileHash,
      provider,
      import_type AS importType,
      status,
      error_message AS errorMessage,
      original_pdf_path AS originalPdfPath,
      page_count AS pageCount,
      imported_at AS importedAt,
      saved_at AS savedAt
    FROM source_files
    WHERE import_type = $1
    ORDER BY imported_at DESC`,
    [importType],
  );
}

/**
 * A multi-page batch's whole original file, once every one of its pages
 * has its own saved import — at that point the whole-original is pure
 * duplication (each employee's split-off page already has everything),
 * so it's safe to offer up for deletion. Single-page sources are never
 * candidates: there, the "original" and the employee's own file are the
 * same one copy, not a duplicate.
 */
export interface RedundantOriginal {
  sourceFileId: number;
  path: string;
}

export async function findRedundantOriginals(): Promise<RedundantOriginal[]> {
  const db = await getDb();
  return db.select<RedundantOriginal[]>(`
    SELECT sf.id AS sourceFileId, sf.original_pdf_path AS path
    FROM source_files sf
    WHERE sf.page_count > 1
      AND sf.original_pdf_path != ''
      AND (SELECT COUNT(*) FROM imports i WHERE i.source_file_id = sf.id) = sf.page_count
  `);
}

/**
 * Marks a batch's whole-original as removed after its file has actually
 * been deleted from disk. `original_pdf_path` stays `NOT NULL` in the
 * schema, so "removed" is the empty string — same sentinel the column
 * already defaults to before a file is ever recorded — rather than NULL.
 */
export async function markOriginalsRemoved(sourceFileIds: number[]): Promise<void> {
  if (sourceFileIds.length === 0) return;
  const db = await getDb();
  const placeholders = sourceFileIds.map((_, i) => `$${i + 1}`).join(", ");
  await db.execute(
    `UPDATE source_files SET original_pdf_path = '' WHERE id IN (${placeholders})`,
    sourceFileIds,
  );
}

/**
 * Recompacts the DB file — reclaims space left behind by deleted rows
 * without touching any surviving data. Cheap, non-destructive; the natural
 * first thing to try before "Limpar tudo".
 */
export async function vacuumDatabase(): Promise<void> {
  const db = await getDb();
  await db.execute("VACUUM");
}

export interface ClearDataOptions {
  /** Keep companies (and, transitively, whatever else depends on them). */
  keepCompanies?: boolean;
  /** Keep clients/client_companies — implies keeping companies too (a kept client's links need somewhere to point). */
  keepClients?: boolean;
  /** Keep employees — implies keeping their clients and companies too (both are required FKs). */
  keepEmployees?: boolean;
}

/**
 * Deletes rows from every table (schema and migration history stay intact)
 * and reclaims the freed space — the database half of "Limpar tudo". The
 * file half (everything under `imports/`) is a separate, Rust-side step,
 * since this only touches the SQL connection.
 *
 * Import/timesheet data (punches, day_records, imports, import_files,
 * source_files) is always wiped — there's no "keep" option for it, since
 * it's exactly what's re-derivable by re-importing the same PDFs. Master
 * data (companies/clients/employees) can optionally survive via `options`,
 * respecting the real dependency chain: employees → clients → companies.
 */
export async function clearAllData(options: ClearDataOptions = {}): Promise<void> {
  const db = await getDb();

  const keepEmployees = Boolean(options.keepEmployees);
  const keepClients = Boolean(options.keepClients) || keepEmployees;
  const keepCompanies = Boolean(options.keepCompanies) || keepClients;

  await db.execute("DELETE FROM punches");
  await db.execute("DELETE FROM day_records");
  await db.execute("DELETE FROM imports");
  await db.execute("DELETE FROM import_files");
  await db.execute("DELETE FROM source_files");

  const clearedTables = ["punches", "day_records", "imports", "import_files", "source_files"];

  if (!keepEmployees) {
    await db.execute("DELETE FROM employees");
    clearedTables.push("employees");
  }
  if (!keepClients) {
    await db.execute("DELETE FROM client_companies");
    await db.execute("DELETE FROM clients");
    clearedTables.push("clients");
  }
  if (!keepCompanies) {
    await db.execute("DELETE FROM companies");
    clearedTables.push("companies");
  }

  try {
    const placeholders = clearedTables.map((_, i) => `$${i + 1}`).join(", ");
    await db.execute(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`, clearedTables);
  } catch {
    // No autoincrement table has ever been written to yet — nothing to reset.
  }

  await db.execute("VACUUM");
}
