import Database from "@tauri-apps/plugin-sql";
import { overtimeMinutesForDay, sumIntervalMinutes } from "./analysis";
import { normalizeCnpj, normalizeCpf } from "./format";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  ImportFileRow,
  ImportStatus,
  ImportType,
  ParsedTimesheet,
  PaymentFileKind,
  PaymentTemplateFieldMapping,
  PaymentTemplateGroup,
  PaymentTemplateListRow,
  PaymentTemplateRow,
  PaymentShiftRow,
  PaymentShiftSummaryRow,
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
  /** Shift hours from here until `nightEndTime` count as "noturno" — used to classify a payment template's Horário field. */
  nightStartTime: string;
  nightEndTime: string;
}

export async function listCompanies(): Promise<CompanyRow[]> {
  const db = await getDb();
  return db.select<CompanyRow[]>(
    "SELECT id, name, cnpj, night_start_time AS nightStartTime, night_end_time AS nightEndTime FROM companies ORDER BY name",
  );
}

export interface CompanyWithStats extends CompanyRow {
  employeeCount: number;
}

export async function listCompaniesWithStats(): Promise<CompanyWithStats[]> {
  const db = await getDb();
  return db.select<CompanyWithStats[]>(`
    SELECT c.id, c.name, c.cnpj, c.night_start_time AS nightStartTime, c.night_end_time AS nightEndTime,
           COUNT(DISTINCT e.id) AS employeeCount
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
export async function createCompany(
  name: string,
  cnpj: string,
  nightStartTime = "22:00",
  nightEndTime = "05:00",
): Promise<number> {
  const db = await getDb();
  const normalizedCnpj = normalizeCnpj(cnpj);
  if (normalizedCnpj.length !== 14) {
    throw new Error("CNPJ deve ter 14 dígitos.");
  }
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM companies WHERE cnpj = $1",
    [normalizedCnpj],
  );
  if (existing.length > 0) {
    throw new Error("Já existe uma empresa cadastrada com esse CNPJ.");
  }
  const result = await db.execute(
    "INSERT INTO companies (name, cnpj, night_start_time, night_end_time) VALUES ($1, $2, $3, $4)",
    [name.trim(), normalizedCnpj, nightStartTime, nightEndTime],
  );
  return result.lastInsertId as number;
}

export async function getCompany(id: number): Promise<CompanyRow> {
  const db = await getDb();
  const rows = await db.select<CompanyRow[]>(
    "SELECT id, name, cnpj, night_start_time AS nightStartTime, night_end_time AS nightEndTime FROM companies WHERE id = $1",
    [id],
  );
  if (rows.length === 0) throw new Error("Empresa não encontrada.");
  return rows[0];
}

export async function updateCompany(
  id: number,
  name: string,
  cnpj: string,
  nightStartTime: string,
  nightEndTime: string,
): Promise<void> {
  const db = await getDb();
  const normalizedCnpj = normalizeCnpj(cnpj);
  if (normalizedCnpj.length !== 14) {
    throw new Error("CNPJ deve ter 14 dígitos.");
  }
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM companies WHERE cnpj = $1 AND id != $2",
    [normalizedCnpj, id],
  );
  if (existing.length > 0) {
    throw new Error("Já existe uma empresa cadastrada com esse CNPJ.");
  }
  await db.execute(
    "UPDATE companies SET name = $1, cnpj = $2, night_start_time = $3, night_end_time = $4 WHERE id = $5",
    [name.trim(), normalizedCnpj, nightStartTime, nightEndTime, id],
  );
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

export interface ClientOption {
  id: number;
  name: string;
  cnpj: string;
}

/**
 * Every client, once each — for a plain "which client owns this?" picker
 * where company doesn't matter. `listClients()` returns one row per
 * client-company link (it backs the company-scoped timesheet import
 * picker), so using it here would show duplicate rows for any client
 * linked to more than one company.
 */
export async function listClientOptions(): Promise<ClientOption[]> {
  const db = await getDb();
  return db.select<ClientOption[]>("SELECT id, name, cnpj FROM clients ORDER BY name");
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
  if (normalizedCnpj.length !== 14) {
    throw new Error("CNPJ deve ter 14 dígitos.");
  }

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

export interface ClientDetail {
  id: number;
  name: string;
  cnpj: string;
  companies: { id: number; name: string }[];
}

export async function getClient(id: number): Promise<ClientDetail> {
  const db = await getDb();
  const rows = await db.select<{ id: number; name: string; cnpj: string }[]>(
    "SELECT id, name, cnpj FROM clients WHERE id = $1",
    [id],
  );
  if (rows.length === 0) throw new Error("Cliente não encontrado.");
  const companies = await db.select<{ id: number; name: string }[]>(
    `SELECT c.id, c.name
     FROM client_companies cc
     JOIN companies c ON c.id = cc.company_id
     WHERE cc.client_id = $1
     ORDER BY c.name`,
    [id],
  );
  return { ...rows[0], companies };
}

/**
 * Updates a client's own name/CNPJ — not its company links, which stay
 * managed the way they always have been (via `createClient`'s "link to an
 * additional company" path), since that's a many-to-many relationship, not
 * a simple field on the client itself.
 */
export async function updateClient(id: number, name: string, cnpj: string): Promise<void> {
  const db = await getDb();
  const normalizedCnpj = normalizeCnpj(cnpj);
  if (normalizedCnpj.length !== 14) {
    throw new Error("CNPJ deve ter 14 dígitos.");
  }
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM clients WHERE cnpj = $1 AND id != $2",
    [normalizedCnpj, id],
  );
  if (existing.length > 0) {
    throw new Error("Já existe um cliente cadastrado com esse CNPJ.");
  }
  await db.execute("UPDATE clients SET name = $1, cnpj = $2 WHERE id = $3", [
    name.trim(),
    normalizedCnpj,
    id,
  ]);
}

export interface EmployeeRow {
  id: number;
  name: string;
  cpf: string;
  /** Optional — not every client's payroll system uses one, unlike CPF. */
  matricula: string | null;
  clientId: number;
  clientName: string;
  companyId: number;
  companyName: string;
}

/**
 * Every employee, across every client — the Colaboradores cadastro list.
 * Not scoped to a single client up front (unlike the import flows) since
 * this is meant as a master directory; the clientName/companyName columns
 * disambiguate a CPF that happens to exist under more than one client.
 */
export async function listEmployeesGlobal(): Promise<EmployeeRow[]> {
  const db = await getDb();
  return db.select<EmployeeRow[]>(`
    SELECT e.id, e.name, e.cpf, e.matricula,
           cl.id AS clientId, cl.name AS clientName,
           c.id AS companyId, c.name AS companyName
    FROM employees e
    JOIN clients cl ON cl.id = e.client_id
    JOIN companies c ON c.id = e.company_id
    ORDER BY e.name
  `);
}

/**
 * Registers an employee directly (not via a timesheet import) — the
 * Colaboradores cadastro's "Cadastrar" action. Same client-scoped CPF
 * matching as the import flow's internal `upsertEmployee`: a CPF is
 * unique to the specific client (legal entity) it worked for, so the same
 * CPF can legitimately exist again under a different client.
 */
export async function createEmployeeManual(
  clientId: number,
  companyId: number,
  name: string,
  cpf: string,
  matricula: string | null = null,
): Promise<number> {
  const db = await getDb();
  const normalizedCpf = normalizeCpf(cpf);
  if (normalizedCpf.length !== 11) {
    throw new Error("CPF deve ter 11 dígitos.");
  }

  const link = await db.select<{ clientId: number }[]>(
    "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
    [clientId, companyId],
  );
  if (link.length === 0) {
    throw new Error("Esse cliente não está vinculado à empresa selecionada.");
  }

  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE client_id = $1 AND cpf = $2",
    [clientId, normalizedCpf],
  );
  if (existing.length > 0) {
    throw new Error("Já existe um colaborador com esse CPF para esse cliente.");
  }

  const result = await db.execute(
    "INSERT INTO employees (company_id, client_id, name, cpf, matricula) VALUES ($1, $2, $3, $4, $5)",
    [companyId, clientId, name.trim(), normalizedCpf, matricula?.trim() || null],
  );
  return result.lastInsertId as number;
}

export async function getEmployee(id: number): Promise<EmployeeRow> {
  const db = await getDb();
  const rows = await db.select<EmployeeRow[]>(
    `SELECT e.id, e.name, e.cpf, e.matricula,
            cl.id AS clientId, cl.name AS clientName,
            c.id AS companyId, c.name AS companyName
     FROM employees e
     JOIN clients cl ON cl.id = e.client_id
     JOIN companies c ON c.id = e.company_id
     WHERE e.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Colaborador não encontrado.");
  return rows[0];
}

/**
 * Updates name/CPF/matrícula only — client/empresa aren't editable here,
 * since a colaborador is really "this person at this client"; moving them
 * to a different one is conceptually a new colaborador, not an edit.
 */
export async function updateEmployee(
  id: number,
  name: string,
  cpf: string,
  matricula: string | null = null,
): Promise<void> {
  const db = await getDb();
  const normalizedCpf = normalizeCpf(cpf);
  if (normalizedCpf.length !== 11) {
    throw new Error("CPF deve ter 11 dígitos.");
  }

  const current = await db.select<{ clientId: number }[]>(
    "SELECT client_id AS clientId FROM employees WHERE id = $1",
    [id],
  );
  if (current.length === 0) throw new Error("Colaborador não encontrado.");

  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE client_id = $1 AND cpf = $2 AND id != $3",
    [current[0].clientId, normalizedCpf, id],
  );
  if (existing.length > 0) {
    throw new Error("Já existe um colaborador com esse CPF para esse cliente.");
  }

  await db.execute("UPDATE employees SET name = $1, cpf = $2, matricula = $3 WHERE id = $4", [
    name.trim(),
    normalizedCpf,
    matricula?.trim() || null,
    id,
  ]);
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

export async function listPaymentTemplates(): Promise<PaymentTemplateListRow[]> {
  const db = await getDb();
  return db.select<PaymentTemplateListRow[]>(`
    SELECT pt.id, pt.name, pt.client_id AS clientId, cl.name AS clientName,
           pt.file_kind AS fileKind, pt.updated_at AS updatedAt
    FROM payment_templates pt
    LEFT JOIN clients cl ON cl.id = pt.client_id
    ORDER BY pt.updated_at DESC
  `);
}

export async function getPaymentTemplate(id: number): Promise<PaymentTemplateRow> {
  const db = await getDb();
  const rows = await db.select<Omit<PaymentTemplateRow, "groups">[]>(
    `SELECT pt.id, pt.name, pt.client_id AS clientId, cl.name AS clientName,
            pt.file_kind AS fileKind, pt.delimiter,
            pt.decimal_separator AS decimalSeparator, pt.date_format AS dateFormat,
            pt.sample_file_path AS sampleFilePath, pt.sample_file_name AS sampleFileName,
            pt.created_at AS createdAt, pt.updated_at AS updatedAt
     FROM payment_templates pt
     LEFT JOIN clients cl ON cl.id = pt.client_id
     WHERE pt.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Template não encontrado.");

  const groupRows = await db.select<{ id: number; headerRow: number }[]>(
    "SELECT id, header_row AS headerRow FROM payment_template_groups WHERE template_id = $1",
    [id],
  );
  const groups: PaymentTemplateGroup[] = [];
  for (const g of groupRows) {
    const sheetRows = await db.select<{ sheetName: string }[]>(
      "SELECT sheet_name AS sheetName FROM payment_template_sheets WHERE group_id = $1 ORDER BY sheet_name",
      [g.id],
    );
    const fieldMappings = await db.select<PaymentTemplateFieldMapping[]>(
      `SELECT column_letter AS columnLetter, target_field AS targetField, header_label AS headerLabel
       FROM payment_template_fields
       WHERE group_id = $1
       ORDER BY column_letter`,
      [g.id],
    );
    groups.push({ headerRow: g.headerRow, sheetNames: sheetRows.map((r) => r.sheetName), fieldMappings });
  }

  return { ...rows[0], groups };
}

export interface PaymentTemplateInput {
  name: string;
  clientId: number | null;
  fileKind: PaymentFileKind;
  delimiter: string | null;
  decimalSeparator: string;
  dateFormat: string;
  sampleFilePath: string;
  sampleFileName: string;
  groups: PaymentTemplateGroup[];
}

async function insertTemplateGroups(
  db: Database,
  templateId: number,
  groups: PaymentTemplateGroup[],
): Promise<void> {
  for (const group of groups) {
    const result = await db.execute(
      "INSERT INTO payment_template_groups (template_id, header_row) VALUES ($1, $2)",
      [templateId, group.headerRow],
    );
    const groupId = result.lastInsertId as number;
    for (const sheetName of group.sheetNames) {
      await db.execute(
        "INSERT INTO payment_template_sheets (group_id, sheet_name) VALUES ($1, $2)",
        [groupId, sheetName],
      );
    }
    for (const mapping of group.fieldMappings) {
      await db.execute(
        `INSERT INTO payment_template_fields (group_id, column_letter, target_field, header_label)
         VALUES ($1, $2, $3, $4)`,
        [groupId, mapping.columnLetter, mapping.targetField, mapping.headerLabel],
      );
    }
  }
}

/** Deletes every group under a template, and (via their group_id) every sheet/field row under those groups. */
async function deleteTemplateGroups(db: Database, templateId: number): Promise<void> {
  const groupRows = await db.select<{ id: number }[]>(
    "SELECT id FROM payment_template_groups WHERE template_id = $1",
    [templateId],
  );
  if (groupRows.length === 0) return;
  const ids = groupRows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  await db.execute(`DELETE FROM payment_template_fields WHERE group_id IN (${placeholders})`, ids);
  await db.execute(`DELETE FROM payment_template_sheets WHERE group_id IN (${placeholders})`, ids);
  await db.execute("DELETE FROM payment_template_groups WHERE template_id = $1", [templateId]);
}

export async function createPaymentTemplate(input: PaymentTemplateInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO payment_templates
       (name, client_id, file_kind, delimiter, decimal_separator, date_format,
        sample_file_path, sample_file_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.name,
      input.clientId,
      input.fileKind,
      input.delimiter,
      input.decimalSeparator,
      input.dateFormat,
      input.sampleFilePath,
      input.sampleFileName,
    ],
  );
  const templateId = result.lastInsertId as number;
  await insertTemplateGroups(db, templateId, input.groups);
  return templateId;
}

export async function updatePaymentTemplate(id: number, input: PaymentTemplateInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE payment_templates SET
       name = $1, client_id = $2, file_kind = $3, delimiter = $4,
       decimal_separator = $5, date_format = $6,
       sample_file_path = $7, sample_file_name = $8, updated_at = datetime('now')
     WHERE id = $9`,
    [
      input.name,
      input.clientId,
      input.fileKind,
      input.delimiter,
      input.decimalSeparator,
      input.dateFormat,
      input.sampleFilePath,
      input.sampleFileName,
      id,
    ],
  );
  await deleteTemplateGroups(db, id);
  await insertTemplateGroups(db, id, input.groups);
}

/**
 * Deletes the template and its groups (and their sheets/field mappings);
 * returns its `sample_file_path` so the caller can best-effort delete the
 * copied file too (via the existing generic `deletePaths()` Rust command)
 * — this function only touches the SQL side.
 */
export async function deletePaymentTemplate(id: number): Promise<string> {
  const db = await getDb();
  const rows = await db.select<{ sampleFilePath: string }[]>(
    "SELECT sample_file_path AS sampleFilePath FROM payment_templates WHERE id = $1",
    [id],
  );
  await deleteTemplateGroups(db, id);
  await db.execute("DELETE FROM payment_templates WHERE id = $1", [id]);
  return rows[0]?.sampleFilePath ?? "";
}

/**
 * Resolves a payment row's employee within `clientId`, trying CPF, then
 * matrícula, then nome, in that order — the precedence already defined in
 * `IDENTIFIER_FIELD_PRECEDENCE`. Whichever one hits first wins; the others
 * (if also mapped) are never consulted.
 */
export async function findEmployeeByIdentifiers(
  clientId: number,
  cpf: string | null,
  matricula: string | null,
  nome: string | null,
): Promise<EmployeeRow | null> {
  const db = await getDb();
  const select = `SELECT e.id, e.name, e.cpf, e.matricula,
      cl.id AS clientId, cl.name AS clientName,
      c.id AS companyId, c.name AS companyName
    FROM employees e
    JOIN clients cl ON cl.id = e.client_id
    JOIN companies c ON c.id = e.company_id
    WHERE e.client_id = $1 AND `;

  if (cpf) {
    const normalizedCpf = normalizeCpf(cpf);
    if (normalizedCpf.length === 11) {
      const rows = await db.select<EmployeeRow[]>(`${select}e.cpf = $2`, [clientId, normalizedCpf]);
      if (rows.length > 0) return rows[0];
    }
  }
  if (matricula?.trim()) {
    const rows = await db.select<EmployeeRow[]>(`${select}e.matricula = $2`, [
      clientId,
      matricula.trim(),
    ]);
    if (rows.length > 0) return rows[0];
  }
  if (nome?.trim()) {
    const rows = await db.select<EmployeeRow[]>(`${select}lower(e.name) = lower($2)`, [
      clientId,
      nome.trim(),
    ]);
    if (rows.length > 0) return rows[0];
  }
  return null;
}

/**
 * Flags rows that already have a saved shift for the same employee/date/
 * local — purely informational (returns which *indices* of `rows` look
 * like duplicates), since unlike timesheet imports a payment shift is
 * additive: re-selecting a flagged row just adds another row, there's no
 * overwrite/replace semantics here.
 */
export async function findDuplicatePaymentShifts(
  rows: { employeeId: number; workDate: string; local: string }[],
): Promise<Set<number>> {
  const db = await getDb();
  const duplicates = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const existing = await db.select<{ id: number }[]>(
      "SELECT id FROM payment_shifts WHERE employee_id = $1 AND work_date = $2 AND local = $3",
      [r.employeeId, r.workDate, r.local],
    );
    if (existing.length > 0) duplicates.add(i);
  }
  return duplicates;
}

export interface PaymentShiftInput {
  employeeId: number;
  templateId: number | null;
  sourceFileId: number | null;
  local: string;
  workDate: string;
  role: string;
  schedule: string;
  note: string | null;
}

/** Bulk-inserts shifts — every row always starts `pendente`; valor/pago happen in a later step. */
export async function savePaymentShifts(rows: PaymentShiftInput[]): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO payment_shifts
         (employee_id, template_id, source_file_id, local, work_date, role, schedule, note, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente')`,
      [r.employeeId, r.templateId, r.sourceFileId, r.local, r.workDate, r.role, r.schedule, r.note],
    );
  }
}

/** One row per (colaborador, competência) — the Pagamentos list. */
export async function listPaymentShiftSummaries(): Promise<PaymentShiftSummaryRow[]> {
  const db = await getDb();
  return db.select<PaymentShiftSummaryRow[]>(`
    SELECT
      e.id AS employeeId, e.name AS employeeName,
      cl.id AS clientId, cl.name AS clientName,
      c.id AS companyId, c.name AS companyName,
      strftime('%Y-%m', ps.work_date) AS competencia,
      COUNT(*) AS total,
      SUM(CASE WHEN ps.status = 'pendente' THEN 1 ELSE 0 END) AS pendente,
      SUM(CASE WHEN ps.status = 'erro' THEN 1 ELSE 0 END) AS erro,
      SUM(CASE WHEN ps.status = 'pago' THEN 1 ELSE 0 END) AS pago
    FROM payment_shifts ps
    JOIN employees e ON e.id = ps.employee_id
    JOIN clients cl ON cl.id = e.client_id
    JOIN companies c ON c.id = e.company_id
    GROUP BY e.id, competencia
    ORDER BY competencia DESC, e.name
  `);
}

/** Every shift for one colaborador in one competência ("YYYY-MM") — the Pagamentos detail. */
export async function listPaymentShiftsForEmployeeMonth(
  employeeId: number,
  competencia: string,
): Promise<PaymentShiftRow[]> {
  const db = await getDb();
  return db.select<PaymentShiftRow[]>(
    `SELECT ps.id, ps.employee_id AS employeeId, e.name AS employeeName,
            ps.local, ps.work_date AS workDate, ps.role, ps.schedule, ps.note,
            ps.status, ps.error_message AS errorMessage, ps.amount, ps.imported_at AS importedAt
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     WHERE ps.employee_id = $1 AND strftime('%Y-%m', ps.work_date) = $2
     ORDER BY ps.work_date, ps.id`,
    [employeeId, competencia],
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
    // Payment templates aren't import history — they're master/config data
    // like clients/companies, so "Limpar tudo" never deletes them. But a
    // template scoped to a client that's about to be wiped would otherwise
    // be left pointing at a client_id that no longer exists (this
    // connection doesn't enforce foreign keys, same reason deleteImport
    // has to clean up manually elsewhere) — demote it to a global template
    // instead of leaving it dangling.
    await db.execute("UPDATE payment_templates SET client_id = NULL WHERE client_id IS NOT NULL");
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
