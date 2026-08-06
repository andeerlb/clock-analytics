import Database from "@tauri-apps/plugin-sql";
import { overtimeMinutesForDay, sumIntervalMinutes } from "./analysis";
import { normalizeCnpj, normalizeCpf, parseTimeToMinutes } from "./format";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "./periodStatus";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  EmployeeTemplateFieldMapping,
  EmployeeTemplateGroup,
  EmployeeTemplateListRow,
  EmployeeTemplateRow,
  IdentifierAttempt,
  ImportFileRow,
  ImportStatus,
  ImportType,
  NightShiftRule,
  PagedResult,
  ParsedTimesheet,
  PaymentFileKind,
  PaymentTargetField,
  PaymentTemplateFieldMapping,
  PaymentTemplateGroup,
  PaymentTemplateListRow,
  PaymentTemplateRow,
  PaymentTemplateRule,
  PaymentTemplateRuleKind,
  PaymentShiftRow,
  PaymentShiftStatus,
  PaymentShiftSummaryRow,
  PaymentStatusRule,
  PaymentValueRule,
  ScheduleTimeFilter,
  ShiftPeriod,
  StoredDayRecord,
  StoredImport,
} from "./types";

export const DB_URL = "sqlite:pontoscan.db";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}

/**
 * Appends a `column IN ($n, $n+1, ...)` fragment (and its values) built off
 * the current length of `params` — `null` when `values` is empty, since an
 * empty IN(...) isn't valid SQL and the caller means "no filter" anyway.
 */
function inClause(column: string, values: (string | number)[], params: (string | number)[]): string | null {
  if (values.length === 0) return null;
  const placeholders = values.map((_, i) => `$${params.length + i + 1}`).join(", ");
  params.push(...values);
  return `${column} IN (${placeholders})`;
}

async function upsertEmployee(
  db: Database,
  companyId: number,
  clientId: number,
  name: string,
  cpf: string,
): Promise<number> {
  // Digits-only, same normalization every other write path to `employees`
  // applies (createEmployeeManual/updateEmployee/createEmployeesFromImport)
  // — the PDF parser's own CPF regex allows dots/dashes through, so this is
  // the only thing standing between a punctuated CPF and a stored row that
  // `findEmployeeByAttempts`'s digits-only comparison would then silently
  // never match again.
  const normalizedCpf = normalizeCpf(cpf);
  // Scoped to *both* client and company, not just the client — a cliente
  // can be linked to more than one empresa (`client_companies`), and
  // `UNIQUE(company_id, cpf)` on `employees` deliberately allows the same
  // CPF to exist once per empresa of that same cliente (e.g. someone
  // contracted through two different empresas for the same cliente).
  // Scoping only by client would find (and silently rename) the wrong
  // empresa's employee record whenever both exist — the same bug already
  // fixed in `findEmployeeByAttempts`.
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE client_id = $1 AND company_id = $2 AND cpf = $3",
    [clientId, companyId, normalizedCpf],
  );
  if (existing.length > 0) {
    await db.execute("UPDATE employees SET name = $1 WHERE id = $2", [name, existing[0].id]);
    return existing[0].id;
  }
  const result = await db.execute(
    "INSERT INTO employees (company_id, client_id, name, cpf) VALUES ($1, $2, $3, $4)",
    [companyId, clientId, name, normalizedCpf],
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
  /** Set only for a payment file downloaded via URL — null for local picks and timesheet PDFs. */
  sourceUrl?: string | null;
  sourceEtag?: string | null;
  sourceLastModified?: string | null;
  sourceContentLength?: number | null;
}): Promise<number> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_files
       (file_name, file_hash, page_count, provider, import_type, status, error_message, original_pdf_path,
        source_url, source_etag, source_last_modified, source_content_length)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT(file_hash) DO UPDATE SET
       file_name = excluded.file_name,
       page_count = excluded.page_count,
       provider = excluded.provider,
       import_type = excluded.import_type,
       status = excluded.status,
       error_message = excluded.error_message,
       original_pdf_path = excluded.original_pdf_path,
       source_url = excluded.source_url,
       source_etag = excluded.source_etag,
       source_last_modified = excluded.source_last_modified,
       source_content_length = excluded.source_content_length,
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
      input.sourceUrl ?? null,
      input.sourceEtag ?? null,
      input.sourceLastModified ?? null,
      input.sourceContentLength ?? null,
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
  /** Shift hours from here until `nightEndTime` count as "noturno" — how much of that window a shift needs to hit is decided by `nightShiftRule`. */
  nightStartTime: string;
  nightEndTime: string;
  nightShiftRule: NightShiftRule;
}

export async function listCompanies(): Promise<CompanyRow[]> {
  const db = await getDb();
  return db.select<CompanyRow[]>(
    `SELECT id, name, cnpj, night_start_time AS nightStartTime, night_end_time AS nightEndTime,
            night_shift_rule AS nightShiftRule
     FROM companies ORDER BY name`,
  );
}

/** Full company detail, including its optional pay-value chain — only `getCompany` fetches this; `listCompanies` stays lightweight for dropdowns. */
export interface CompanyDetail extends CompanyRow {
  valueRules: PaymentValueRule[];
}

/** Inserted in array order — same evaluation-by-insertion-order convention as the payment-template rule chains, see `resolvePaymentValue`. */
async function insertCompanyValueRules(db: Database, companyId: number, rules: PaymentValueRule[]): Promise<void> {
  for (const rule of rules) {
    await db.execute(
      `INSERT INTO payment_value_rules (company_id, kind, operator, threshold_minutes, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        companyId,
        rule.kind,
        rule.kind === "condition" ? rule.operator : null,
        rule.kind === "condition" ? rule.thresholdMinutes : null,
        rule.amount,
      ],
    );
  }
}

async function deleteCompanyValueRules(db: Database, companyId: number): Promise<void> {
  await db.execute("DELETE FROM payment_value_rules WHERE company_id = $1", [companyId]);
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
  nightShiftRule: NightShiftRule = "overlap",
  valueRules: PaymentValueRule[] = [],
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
    "INSERT INTO companies (name, cnpj, night_start_time, night_end_time, night_shift_rule) VALUES ($1, $2, $3, $4, $5)",
    [name.trim(), normalizedCnpj, nightStartTime, nightEndTime, nightShiftRule],
  );
  const companyId = result.lastInsertId as number;
  await insertCompanyValueRules(db, companyId, valueRules);
  return companyId;
}

export async function getCompany(id: number): Promise<CompanyDetail> {
  const db = await getDb();
  const rows = await db.select<CompanyRow[]>(
    `SELECT id, name, cnpj, night_start_time AS nightStartTime, night_end_time AS nightEndTime,
            night_shift_rule AS nightShiftRule
     FROM companies WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Empresa não encontrada.");

  const valueRules = await db.select<PaymentValueRule[]>(
    `SELECT kind, operator, threshold_minutes AS thresholdMinutes, amount
     FROM payment_value_rules WHERE company_id = $1 ORDER BY id`,
    [id],
  );

  return { ...rows[0], valueRules };
}

export async function updateCompany(
  id: number,
  name: string,
  cnpj: string,
  nightStartTime: string,
  nightEndTime: string,
  nightShiftRule: NightShiftRule,
  valueRules: PaymentValueRule[],
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
    "UPDATE companies SET name = $1, cnpj = $2, night_start_time = $3, night_end_time = $4, night_shift_rule = $5 WHERE id = $6",
    [name.trim(), normalizedCnpj, nightStartTime, nightEndTime, nightShiftRule, id],
  );
  await deleteCompanyValueRules(db, id);
  await insertCompanyValueRules(db, id, valueRules);
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

/**
 * Registers a client under one or more `companyIds`. A client's CNPJ is a
 * globally unique physical entity — just like a company's — but the same
 * client can be linked to more than one company. So this either creates a
 * brand new client (no client with that CNPJ exists yet) or links an
 * existing one (found by CNPJ) to whichever of `companyIds` it isn't
 * already linked to — an already-linked company in the list is skipped,
 * not rejected, since picking several companies at once naturally means
 * some might already be linked (e.g. re-entering an existing CNPJ to add
 * it to more companies).
 */
export async function createClient(
  companyIds: number[],
  name: string,
  cnpj: string,
): Promise<number> {
  const db = await getDb();
  const normalizedCnpj = normalizeCnpj(cnpj);
  if (normalizedCnpj.length !== 14) {
    throw new Error("CNPJ deve ter 14 dígitos.");
  }
  if (companyIds.length === 0) {
    throw new Error("Selecione pelo menos uma empresa.");
  }

  const existing = await db.select<{ id: number }[]>("SELECT id FROM clients WHERE cnpj = $1", [
    normalizedCnpj,
  ]);

  let clientId: number;
  if (existing.length > 0) {
    clientId = existing[0].id;
  } else {
    const result = await db.execute("INSERT INTO clients (name, cnpj) VALUES ($1, $2)", [
      name.trim(),
      normalizedCnpj,
    ]);
    clientId = result.lastInsertId as number;
  }

  for (const companyId of companyIds) {
    const existingLink = await db.select<{ clientId: number }[]>(
      "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
      [clientId, companyId],
    );
    if (existingLink.length > 0) continue;
    await db.execute("INSERT INTO client_companies (client_id, company_id) VALUES ($1, $2)", [
      clientId,
      companyId,
    ]);
  }

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

/** Links `clientId` to an additional `companyId` — a no-op if already linked. */
export async function addClientCompany(clientId: number, companyId: number): Promise<void> {
  const db = await getDb();
  const existingLink = await db.select<{ clientId: number }[]>(
    "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
    [clientId, companyId],
  );
  if (existingLink.length > 0) return;
  await db.execute("INSERT INTO client_companies (client_id, company_id) VALUES ($1, $2)", [
    clientId,
    companyId,
  ]);
}

/**
 * Unlinks `clientId` from `companyId` — rejected if it would leave the
 * client with no empresa at all, or if there are colaboradores already
 * registered under that specific (client, empresa) pair, since removing
 * the link would leave their `company_id` pointing somewhere the client
 * itself no longer claims to belong to.
 */
export async function removeClientCompany(clientId: number, companyId: number): Promise<void> {
  const db = await getDb();
  const linkCount = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM client_companies WHERE client_id = $1",
    [clientId],
  );
  if ((linkCount[0]?.count ?? 0) <= 1) {
    throw new Error("O cliente precisa continuar vinculado a pelo menos uma empresa.");
  }
  const employeeCount = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM employees WHERE client_id = $1 AND company_id = $2",
    [clientId, companyId],
  );
  if ((employeeCount[0]?.count ?? 0) > 0) {
    throw new Error("Existem colaboradores cadastrados para esse cliente nessa empresa — desvincule ou mova-os antes.");
  }
  await db.execute("DELETE FROM client_companies WHERE client_id = $1 AND company_id = $2", [
    clientId,
    companyId,
  ]);
}

/**
 * Updates a client's own name/CNPJ — its company links are managed
 * separately, via `addClientCompany`/`removeClientCompany`.
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

export interface EmployeesGlobalQuery {
  /** Substring match on name — case-insensitive only for ASCII (SQLite's `LOWER()` doesn't case-fold accents). */
  search?: string;
  companyIds?: number[];
  clientIds?: number[];
  page: number;
  pageSize: number;
}

/**
 * Every employee, across every client — the Colaboradores cadastro list.
 * Not scoped to a single client up front (unlike the import flows) since
 * this is meant as a master directory; the clientName/companyName columns
 * disambiguate a CPF that happens to exist under more than one client.
 * Filtered and paginated in SQL, not in memory — `total` is the count
 * across all matching rows, before `page`/`pageSize` are applied.
 */
export async function listEmployeesGlobal(query: EmployeesGlobalQuery): Promise<PagedResult<EmployeeRow>> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const search = query.search?.trim();
  if (search) {
    params.push(search);
    conditions.push(`LOWER(e.name) LIKE '%' || LOWER($${params.length}) || '%'`);
  }
  const companyClause = inClause("c.id", query.companyIds ?? [], params);
  if (companyClause) conditions.push(companyClause);
  const clientClause = inClause("cl.id", query.clientIds ?? [], params);
  if (clientClause) conditions.push(clientClause);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM employees e JOIN clients cl ON cl.id = e.client_id JOIN companies c ON c.id = e.company_id`;

  const countRows = await db.select<{ count: number }[]>(`SELECT COUNT(*) AS count ${from} ${whereClause}`, params);
  const total = countRows[0]?.count ?? 0;

  const rows = await db.select<EmployeeRow[]>(
    `SELECT e.id, e.name, e.cpf, e.matricula,
            cl.id AS clientId, cl.name AS clientName,
            c.id AS companyId, c.name AS companyName
     ${from}
     ${whereClause}
     ORDER BY e.name
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, query.page * query.pageSize],
  );

  return { rows, total };
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

  // Scoped by both client and company — scoping only by client (the old
  // behavior) would reject a CPF that's actually free for this empresa just
  // because it's already used under a *different* empresa of the same
  // (multi-empresa) cliente, which `UNIQUE(company_id, cpf)` allows.
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE client_id = $1 AND company_id = $2 AND cpf = $3",
    [clientId, companyId, normalizedCpf],
  );
  if (existing.length > 0) {
    throw new Error("Já existe um colaborador com esse CPF para essa empresa e cliente.");
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

  const current = await db.select<{ clientId: number; companyId: number }[]>(
    "SELECT client_id AS clientId, company_id AS companyId FROM employees WHERE id = $1",
    [id],
  );
  if (current.length === 0) throw new Error("Colaborador não encontrado.");

  // Scoped by both client and company, same reasoning as `createEmployeeManual`.
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM employees WHERE client_id = $1 AND company_id = $2 AND cpf = $3 AND id != $4",
    [current[0].clientId, current[0].companyId, normalizedCpf, id],
  );
  if (existing.length > 0) {
    throw new Error("Já existe um colaborador com esse CPF para essa empresa e cliente.");
  }

  await db.execute("UPDATE employees SET name = $1, cpf = $2, matricula = $3 WHERE id = $4", [
    name.trim(),
    normalizedCpf,
    matricula?.trim() || null,
    id,
  ]);
}

const IMPORT_SELECT_COLUMNS = `
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
`;

const IMPORT_FROM_CLAUSE = `
  FROM imports i
  JOIN employees e ON e.id = i.employee_id
  JOIN companies c ON c.id = e.company_id
  LEFT JOIN clients cl ON cl.id = e.client_id
  LEFT JOIN source_files sf ON sf.id = i.source_file_id
`;

/** Which raw `imports` column(s) each "Status no período" checkbox reads — must stay in sync with `PERIOD_STATUS_OPTIONS`' `matches` functions, which do the same test in JS on already-fetched rows. */
const STATUS_SQL_CONDITIONS: Record<PeriodStatusId, string> = {
  overtime: "i.overtime_minutes > 0",
  absence: "i.absence_minutes > 0",
  late: "i.late_minutes > 0",
  regular: "i.regular_minutes > 0",
  "no-punch": "i.total_worked_minutes = 0",
  pending: "i.pending_count > 0",
  interval: "i.interval_minutes > 0",
};

export async function getImportById(id: number): Promise<StoredImport | null> {
  const db = await getDb();
  const rows = await db.select<StoredImport[]>(
    `SELECT ${IMPORT_SELECT_COLUMNS} ${IMPORT_FROM_CLAUSE} WHERE i.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface ListImportsQuery {
  /** Substring match on employee name — case-insensitive only for ASCII (SQLite's `LOWER()` doesn't case-fold accents). */
  search?: string;
  companyIds?: number[];
  clientIds?: number[];
  periodStart: string;
  periodEnd: string;
  statuses: PeriodStatusId[];
  /** Omit both to get every matching row, unpaginated — used for bulk export, where every match is needed, not just the current page. */
  page?: number;
  pageSize?: number;
}

/**
 * The Cartão Ponto library, filtered and paginated in SQL, not in memory.
 * An empty `statuses` matches nothing (same as the in-memory
 * `matchesSelectedStatuses` did for an empty selected set) — short-circuits
 * before querying, since an always-false SQL condition would just be
 * spelling out the same thing more expensively.
 */
export async function listImports(query: ListImportsQuery): Promise<PagedResult<StoredImport>> {
  if (query.statuses.length === 0) return { rows: [], total: 0 };

  const db = await getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const search = query.search?.trim();
  if (search) {
    params.push(search);
    conditions.push(`LOWER(e.name) LIKE '%' || LOWER($${params.length}) || '%'`);
  }
  const companyClause = inClause("c.id", query.companyIds ?? [], params);
  if (companyClause) conditions.push(companyClause);
  const clientClause = inClause("cl.id", query.clientIds ?? [], params);
  if (clientClause) conditions.push(clientClause);

  params.push(query.periodStart, query.periodEnd);
  conditions.push(`i.period_end >= $${params.length - 1} AND i.period_start <= $${params.length}`);

  if (query.statuses.length < PERIOD_STATUS_OPTIONS.length) {
    conditions.push(`(${query.statuses.map((s) => STATUS_SQL_CONDITIONS[s]).join(" OR ")})`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countRows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) AS count ${IMPORT_FROM_CLAUSE} ${whereClause}`,
    params,
  );
  const total = countRows[0]?.count ?? 0;

  const paginate = query.page !== undefined && query.pageSize !== undefined;
  const limitClause = paginate ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}` : "";
  const limitParams = paginate ? [query.pageSize!, query.page! * query.pageSize!] : [];

  const rows = await db.select<StoredImport[]>(
    `SELECT ${IMPORT_SELECT_COLUMNS}
     ${IMPORT_FROM_CLAUSE}
     ${whereClause}
     ORDER BY i.imported_at DESC
     ${limitClause}`,
    [...params, ...limitParams],
  );

  return { rows, total };
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
 * **and empresa** whose period overlaps the given range — the "you already
 * imported this person for this period" check, independent of which file it
 * came from. Scoped by both, not just client, for the same reason as
 * `upsertEmployee`: a cliente linked to more than one empresa can have a
 * separate employee record (and separate imports) per empresa, sharing the
 * same CPF — scoping only by client would flag a false conflict against the
 * *other* empresa's import.
 */
export async function findConflictingImport(
  employeeCpf: string,
  clientId: number,
  companyId: number,
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
    WHERE e.cpf = $1 AND e.client_id = $2 AND e.company_id = $3
      AND i.period_start <= $5 AND i.period_end >= $4
    ORDER BY i.imported_at DESC
    LIMIT 1
    `,
    [employeeCpf, clientId, companyId, periodStart, periodEnd],
  );
  return rows[0] ?? null;
}

/**
 * Checks a batch of freshly-parsed sheets against existing imports for
 * period overlaps — under `clientId`/`companyId`, the pair the user selected
 * for this whole batch (not whatever each sheet's own parsed company says).
 */
export async function findConflicts(
  sheets: ParsedTimesheet[],
  clientId: number,
  companyId: number,
): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const existing = await findConflictingImport(
      sheet.employee.cpf,
      clientId,
      companyId,
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

export interface ImportFilesQuery {
  importType: ImportType;
  /** Substring match on file name — case-insensitive only for ASCII (SQLite's `LOWER()` doesn't case-fold accents). */
  search?: string;
  page: number;
  pageSize: number;
}

/**
 * The import history for one import flow (timesheet or payment), most
 * recent first — filtered and paginated in SQL, not in memory.
 */
export async function listImportFiles(query: ImportFilesQuery): Promise<PagedResult<ImportFileRow>> {
  const db = await getDb();
  const conditions = ["import_type = $1"];
  const params: (string | number)[] = [query.importType];

  const search = query.search?.trim();
  if (search) {
    params.push(search);
    conditions.push(`LOWER(file_name) LIKE '%' || LOWER($${params.length}) || '%'`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countRows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) AS count FROM source_files ${whereClause}`,
    params,
  );
  const total = countRows[0]?.count ?? 0;

  const rawRows = await db.select<(Omit<ImportFileRow, "checkDisabled"> & { checkDisabled: number })[]>(
    `SELECT
      sf.id,
      sf.file_name AS fileName,
      sf.file_hash AS fileHash,
      sf.provider,
      sf.import_type AS importType,
      sf.status,
      sf.error_message AS errorMessage,
      sf.original_pdf_path AS originalPdfPath,
      sf.page_count AS pageCount,
      sf.imported_at AS importedAt,
      sf.saved_at AS savedAt,
      sf.source_url AS sourceUrl,
      COALESCE(sus.check_disabled, 0) AS checkDisabled
    FROM source_files sf
    LEFT JOIN source_url_settings sus ON sus.source_url = sf.source_url
    ${whereClause}
    ORDER BY sf.imported_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, query.page * query.pageSize],
  );
  const rows: ImportFileRow[] = rawRows.map((r) => ({ ...r, checkDisabled: Boolean(r.checkDisabled) }));

  return { rows, total };
}

export type UrlCheckResult = "changed" | "unchanged" | "unknown" | "error";

export interface TrackedPaymentUrl {
  sourceUrl: string;
  fileName: string;
  provider: string;
  /** Most recent import from this URL. */
  importedAt: string;
  sourceEtag: string | null;
  sourceLastModified: string | null;
  sourceContentLength: number | null;
  checkDisabled: boolean;
  /** Per-URL override (minutes) — null means "inherit the global default". */
  checkIntervalMinutes: number | null;
  /** From the most recent `source_url_check_log` entry for this URL, if any. */
  lastCheckedAt: string | null;
  lastResult: UrlCheckResult | null;
  lastErrorMessage: string | null;
}

/**
 * Every distinct URL a payment file was ever downloaded from, with its
 * full tracking state — one row per source_url (a URL whose content
 * changed and got reimported has more than one source_files row; only the
 * newest counts), regardless of enabled/disabled, so the Verificação
 * automática page can show and manage everything (not just what's
 * currently active). `RemoteFileUpdatesContext`'s scheduler is the one
 * that filters to `!checkDisabled` before deciding what's due.
 */
export async function listTrackedPaymentUrls(): Promise<TrackedPaymentUrl[]> {
  const db = await getDb();
  const rawRows = await db.select<(Omit<TrackedPaymentUrl, "checkDisabled"> & { checkDisabled: number })[]>(
    `SELECT
       sf.source_url AS sourceUrl,
       sf.file_name AS fileName,
       sf.provider,
       sf.imported_at AS importedAt,
       sf.source_etag AS sourceEtag,
       sf.source_last_modified AS sourceLastModified,
       sf.source_content_length AS sourceContentLength,
       COALESCE(sus.check_disabled, 0) AS checkDisabled,
       sus.check_interval_minutes AS checkIntervalMinutes,
       log.checked_at AS lastCheckedAt,
       log.result AS lastResult,
       log.message AS lastErrorMessage
     FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY source_url ORDER BY imported_at DESC) AS rn
       FROM source_files
       WHERE import_type = 'payment' AND source_url IS NOT NULL
     ) sf
     LEFT JOIN source_url_settings sus ON sus.source_url = sf.source_url
     LEFT JOIN (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY source_url ORDER BY checked_at DESC) AS rn
       FROM source_url_check_log
     ) log ON log.source_url = sf.source_url AND log.rn = 1
     WHERE sf.rn = 1
     ORDER BY sf.imported_at DESC`,
  );
  return rawRows.map((r) => ({ ...r, checkDisabled: Boolean(r.checkDisabled) }));
}

/**
 * Turns the periodic remote-change check on/off for one source URL — a
 * user who doesn't want to be bothered about a particular file anymore,
 * without giving up on URL-sourced imports altogether. Persisted per URL
 * (not per source_files row) so it survives that URL's content changing
 * and being reimported under a new row/hash.
 */
export async function setUrlCheckDisabled(sourceUrl: string, disabled: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_url_settings (source_url, check_disabled, updated_at)
     VALUES ($1, $2, datetime('now'))
     ON CONFLICT(source_url) DO UPDATE SET
       check_disabled = excluded.check_disabled,
       updated_at = excluded.updated_at`,
    [sourceUrl, disabled ? 1 : 0],
  );
}

/** `minutes: null` clears the override, falling back to the global interval. */
export async function setUrlCheckIntervalMinutes(sourceUrl: string, minutes: number | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_url_settings (source_url, check_interval_minutes, updated_at)
     VALUES ($1, $2, datetime('now'))
     ON CONFLICT(source_url) DO UPDATE SET
       check_interval_minutes = excluded.check_interval_minutes,
       updated_at = excluded.updated_at`,
    [sourceUrl, minutes],
  );
}

const MAX_CHECK_LOG_ENTRIES_PER_URL = 200;

/** Records one check attempt and prunes older entries for that URL beyond the last 200, so the log stays bounded regardless of how short the check interval is. */
export async function logUrlCheckResult(
  sourceUrl: string,
  fileName: string,
  result: UrlCheckResult,
  message: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_url_check_log (source_url, file_name, result, message) VALUES ($1, $2, $3, $4)`,
    [sourceUrl, fileName, result, message],
  );
  await db.execute(
    `DELETE FROM source_url_check_log
     WHERE source_url = $1
       AND id NOT IN (
         SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC LIMIT $2
       )`,
    [sourceUrl, MAX_CHECK_LOG_ENTRIES_PER_URL],
  );
}

export interface UrlCheckLogEntry {
  id: number;
  sourceUrl: string;
  fileName: string;
  checkedAt: string;
  result: UrlCheckResult;
  message: string | null;
}

/** Full check history, most recent first — optionally scoped to one URL — for the Verificação automática page. */
export async function listUrlCheckLog(query: {
  sourceUrl?: string;
  page: number;
  pageSize: number;
}): Promise<PagedResult<UrlCheckLogEntry>> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.sourceUrl) {
    params.push(query.sourceUrl);
    conditions.push(`source_url = $${params.length}`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) AS count FROM source_url_check_log ${whereClause}`,
    params,
  );
  const total = countRows[0]?.count ?? 0;

  const rows = await db.select<UrlCheckLogEntry[]>(
    `SELECT id, source_url AS sourceUrl, file_name AS fileName, checked_at AS checkedAt, result, message
     FROM source_url_check_log
     ${whereClause}
     ORDER BY checked_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, query.page * query.pageSize],
  );

  return { rows, total };
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
    SELECT pt.id, pt.name, pt.file_kind AS fileKind, pt.updated_at AS updatedAt
    FROM payment_templates pt
    ORDER BY pt.updated_at DESC
  `);
}

export async function getPaymentTemplate(id: number): Promise<PaymentTemplateRow> {
  const db = await getDb();
  const rows = await db.select<
    (Omit<PaymentTemplateRow, "groups" | "rules" | "identifierPriority"> & { identifierPriority: string })[]
  >(
    `SELECT pt.id, pt.name, pt.file_kind AS fileKind, pt.delimiter,
            pt.date_format AS dateFormat, pt.identifier_priority AS identifierPriority,
            pt.created_at AS createdAt, pt.updated_at AS updatedAt
     FROM payment_templates pt
     WHERE pt.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Template não encontrado.");

  const groupRows = await db.select<{ id: number }[]>(
    "SELECT id FROM payment_template_groups WHERE template_id = $1",
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
    groups.push({ sheetNames: sheetRows.map((r) => r.sheetName), fieldMappings });
  }

  const ruleRows = await db.select<
    {
      kind: PaymentTemplateRuleKind;
      field: PaymentTargetField | null;
      valuesJson: string | null;
      caseInsensitive: number;
      companyId: number;
      companyName: string;
      clientId: number;
      clientName: string;
    }[]
  >(
    `SELECT r.kind, r.field, r.values_json AS valuesJson, r.case_insensitive AS caseInsensitive,
            r.company_id AS companyId, c.name AS companyName,
            r.client_id AS clientId, cl.name AS clientName
     FROM payment_template_rules r
     JOIN companies c ON c.id = r.company_id
     JOIN clients cl ON cl.id = r.client_id
     WHERE r.template_id = $1
     ORDER BY r.id`,
    [id],
  );
  const rules: PaymentTemplateRule[] = ruleRows.map((r) => ({
    ...r,
    values: r.valuesJson ? JSON.parse(r.valuesJson) : [],
    caseInsensitive: Boolean(r.caseInsensitive),
  }));

  const statusRuleRows = await db.select<
    {
      kind: PaymentTemplateRuleKind;
      field: PaymentTargetField | null;
      valuesJson: string | null;
      caseInsensitive: number;
      status: PaymentShiftStatus;
    }[]
  >(
    `SELECT kind, field, values_json AS valuesJson, case_insensitive AS caseInsensitive, status
     FROM payment_template_status_rules
     WHERE template_id = $1
     ORDER BY id`,
    [id],
  );
  const statusRules: PaymentStatusRule[] = statusRuleRows.map((r) => ({
    ...r,
    values: r.valuesJson ? JSON.parse(r.valuesJson) : [],
    caseInsensitive: Boolean(r.caseInsensitive),
  }));

  return {
    ...rows[0],
    identifierPriority: JSON.parse(rows[0].identifierPriority) as IdentifierAttempt[],
    groups,
    rules,
    statusRules,
  };
}

export interface PaymentTemplateRuleInput {
  kind: PaymentTemplateRuleKind;
  field: PaymentTargetField | null;
  values: string[];
  caseInsensitive: boolean;
  companyId: number;
  clientId: number;
}

export interface PaymentTemplateStatusRuleInput {
  kind: PaymentTemplateRuleKind;
  field: PaymentTargetField | null;
  values: string[];
  caseInsensitive: boolean;
  status: PaymentShiftStatus;
}

export interface PaymentTemplateInput {
  name: string;
  fileKind: PaymentFileKind;
  delimiter: string | null;
  dateFormat: string;
  identifierPriority: IdentifierAttempt[];
  groups: PaymentTemplateGroup[];
  rules: PaymentTemplateRuleInput[];
  statusRules: PaymentTemplateStatusRuleInput[];
}

async function insertTemplateGroups(
  db: Database,
  templateId: number,
  groups: PaymentTemplateGroup[],
): Promise<void> {
  for (const group of groups) {
    const result = await db.execute(
      "INSERT INTO payment_template_groups (template_id) VALUES ($1)",
      [templateId],
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

/** Inserted in array order — evaluation order for the if/else-if/else chain matches insertion (id) order, see `resolvePaymentRoute`. */
async function insertTemplateRules(
  db: Database,
  templateId: number,
  rules: PaymentTemplateRuleInput[],
): Promise<void> {
  for (const rule of rules) {
    await db.execute(
      `INSERT INTO payment_template_rules
         (template_id, kind, field, values_json, case_insensitive, company_id, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        templateId,
        rule.kind,
        rule.kind === "condition" ? rule.field : null,
        rule.kind === "condition" ? JSON.stringify(rule.values) : null,
        rule.caseInsensitive ? 1 : 0,
        rule.companyId,
        rule.clientId,
      ],
    );
  }
}

async function deleteTemplateRules(db: Database, templateId: number): Promise<void> {
  await db.execute("DELETE FROM payment_template_rules WHERE template_id = $1", [templateId]);
}

/** Inserted in array order — same evaluation-by-insertion-order convention as `insertTemplateRules`, see `resolvePaymentStatus`. */
async function insertTemplateStatusRules(
  db: Database,
  templateId: number,
  rules: PaymentTemplateStatusRuleInput[],
): Promise<void> {
  for (const rule of rules) {
    await db.execute(
      `INSERT INTO payment_template_status_rules
         (template_id, kind, field, values_json, case_insensitive, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        templateId,
        rule.kind,
        rule.kind === "condition" ? rule.field : null,
        rule.kind === "condition" ? JSON.stringify(rule.values) : null,
        rule.caseInsensitive ? 1 : 0,
        rule.status,
      ],
    );
  }
}

async function deleteTemplateStatusRules(db: Database, templateId: number): Promise<void> {
  await db.execute("DELETE FROM payment_template_status_rules WHERE template_id = $1", [templateId]);
}

export async function createPaymentTemplate(input: PaymentTemplateInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO payment_templates (name, file_kind, delimiter, date_format, identifier_priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.name, input.fileKind, input.delimiter, input.dateFormat, JSON.stringify(input.identifierPriority)],
  );
  const templateId = result.lastInsertId as number;
  await insertTemplateGroups(db, templateId, input.groups);
  await insertTemplateRules(db, templateId, input.rules);
  await insertTemplateStatusRules(db, templateId, input.statusRules);
  return templateId;
}

export async function updatePaymentTemplate(id: number, input: PaymentTemplateInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE payment_templates SET
       name = $1, file_kind = $2, delimiter = $3, date_format = $4,
       identifier_priority = $5, updated_at = datetime('now')
     WHERE id = $6`,
    [input.name, input.fileKind, input.delimiter, input.dateFormat, JSON.stringify(input.identifierPriority), id],
  );
  await deleteTemplateGroups(db, id);
  await insertTemplateGroups(db, id, input.groups);
  await deleteTemplateRules(db, id);
  await insertTemplateRules(db, id, input.rules);
  await deleteTemplateStatusRules(db, id);
  await insertTemplateStatusRules(db, id, input.statusRules);
}

/**
 * Deletes the template and its groups/rules (and their sheets/field
 * mappings). Any `payment_shifts` already imported with this template
 * keep existing — they're real payment data, not template config — just
 * lose the (nullable, purely informational) back-reference to it.
 */
export async function deletePaymentTemplate(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE payment_shifts SET template_id = NULL WHERE template_id = $1", [id]);
  await deleteTemplateGroups(db, id);
  await deleteTemplateRules(db, id);
  await deleteTemplateStatusRules(db, id);
  await db.execute("DELETE FROM payment_templates WHERE id = $1", [id]);
}

export async function listEmployeeTemplates(): Promise<EmployeeTemplateListRow[]> {
  const db = await getDb();
  return db.select<EmployeeTemplateListRow[]>(`
    SELECT et.id, et.name, et.file_kind AS fileKind, et.updated_at AS updatedAt
    FROM employee_templates et
    ORDER BY et.updated_at DESC
  `);
}

export async function getEmployeeTemplate(id: number): Promise<EmployeeTemplateRow> {
  const db = await getDb();
  const rows = await db.select<
    (Omit<EmployeeTemplateRow, "groups" | "identifierPriority"> & { identifierPriority: string })[]
  >(
    `SELECT et.id, et.name, et.file_kind AS fileKind, et.delimiter,
            et.identifier_priority AS identifierPriority,
            et.created_at AS createdAt, et.updated_at AS updatedAt
     FROM employee_templates et
     WHERE et.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Template não encontrado.");

  const groupRows = await db.select<{ id: number; headerRow: number | null }[]>(
    "SELECT id, header_row AS headerRow FROM employee_template_groups WHERE template_id = $1",
    [id],
  );
  const groups: EmployeeTemplateGroup[] = [];
  for (const g of groupRows) {
    const sheetRows = await db.select<{ sheetName: string }[]>(
      "SELECT sheet_name AS sheetName FROM employee_template_sheets WHERE group_id = $1 ORDER BY sheet_name",
      [g.id],
    );
    const fieldMappings = await db.select<EmployeeTemplateFieldMapping[]>(
      `SELECT column_letter AS columnLetter, target_field AS targetField, header_label AS headerLabel
       FROM employee_template_fields
       WHERE group_id = $1
       ORDER BY column_letter`,
      [g.id],
    );
    groups.push({ sheetNames: sheetRows.map((r) => r.sheetName), fieldMappings, headerRow: g.headerRow });
  }

  return {
    ...rows[0],
    identifierPriority: JSON.parse(rows[0].identifierPriority) as IdentifierAttempt[],
    groups,
  };
}

export interface EmployeeTemplateInput {
  name: string;
  fileKind: PaymentFileKind;
  delimiter: string | null;
  identifierPriority: IdentifierAttempt[];
  groups: EmployeeTemplateGroup[];
}

async function insertEmployeeTemplateGroups(
  db: Database,
  templateId: number,
  groups: EmployeeTemplateGroup[],
): Promise<void> {
  for (const group of groups) {
    const result = await db.execute(
      "INSERT INTO employee_template_groups (template_id, header_row) VALUES ($1, $2)",
      [templateId, group.headerRow],
    );
    const groupId = result.lastInsertId as number;
    for (const sheetName of group.sheetNames) {
      await db.execute(
        "INSERT INTO employee_template_sheets (group_id, sheet_name) VALUES ($1, $2)",
        [groupId, sheetName],
      );
    }
    for (const mapping of group.fieldMappings) {
      await db.execute(
        `INSERT INTO employee_template_fields (group_id, column_letter, target_field, header_label)
         VALUES ($1, $2, $3, $4)`,
        [groupId, mapping.columnLetter, mapping.targetField, mapping.headerLabel],
      );
    }
  }
}

/** Deletes every group under a template, and (via their group_id) every sheet/field row under those groups. */
async function deleteEmployeeTemplateGroups(db: Database, templateId: number): Promise<void> {
  const groupRows = await db.select<{ id: number }[]>(
    "SELECT id FROM employee_template_groups WHERE template_id = $1",
    [templateId],
  );
  if (groupRows.length === 0) return;
  const ids = groupRows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  await db.execute(`DELETE FROM employee_template_fields WHERE group_id IN (${placeholders})`, ids);
  await db.execute(`DELETE FROM employee_template_sheets WHERE group_id IN (${placeholders})`, ids);
  await db.execute("DELETE FROM employee_template_groups WHERE template_id = $1", [templateId]);
}

export async function createEmployeeTemplate(input: EmployeeTemplateInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO employee_templates (name, file_kind, delimiter, identifier_priority)
     VALUES ($1, $2, $3, $4)`,
    [input.name, input.fileKind, input.delimiter, JSON.stringify(input.identifierPriority)],
  );
  const templateId = result.lastInsertId as number;
  await insertEmployeeTemplateGroups(db, templateId, input.groups);
  return templateId;
}

export async function updateEmployeeTemplate(id: number, input: EmployeeTemplateInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE employee_templates SET
       name = $1, file_kind = $2, delimiter = $3,
       identifier_priority = $4, updated_at = datetime('now')
     WHERE id = $5`,
    [input.name, input.fileKind, input.delimiter, JSON.stringify(input.identifierPriority), id],
  );
  await deleteEmployeeTemplateGroups(db, id);
  await insertEmployeeTemplateGroups(db, id, input.groups);
}

/**
 * Deletes the template and its groups (and their sheets/field mappings).
 * Unlike `deletePaymentTemplate`, there's no back-reference to null out
 * first — employees created via import don't carry a link back to the
 * template that created them.
 */
export async function deleteEmployeeTemplate(id: number): Promise<void> {
  const db = await getDb();
  await deleteEmployeeTemplateGroups(db, id);
  await db.execute("DELETE FROM employee_templates WHERE id = $1", [id]);
}

export interface EmployeeImportRow {
  clientId: number;
  companyId: number;
  name: string;
  cpf: string;
  matricula: string | null;
}

/**
 * Plain bulk insert — no upsert. Anything matching an already-registered
 * employee was already filtered out of the selectable set by
 * ImportEmployeesPage before this is ever called (see `findEmployeeByAttempts`).
 */
export async function createEmployeesFromImport(rows: EmployeeImportRow[]): Promise<void> {
  const db = await getDb();
  for (const row of rows) {
    await db.execute(
      "INSERT INTO employees (company_id, client_id, name, cpf, matricula) VALUES ($1, $2, $3, $4, $5)",
      [row.companyId, row.clientId, row.name.trim(), normalizeCpf(row.cpf), row.matricula?.trim() || null],
    );
  }
}

export interface EmployeeAliasRow {
  id: number;
  employeeId: number;
  alias: string;
}

/** Every "possível nome" registered for one colaborador, most recent first. */
export async function listEmployeeAliases(employeeId: number): Promise<EmployeeAliasRow[]> {
  const db = await getDb();
  return db.select<EmployeeAliasRow[]>(
    `SELECT id, employee_id AS employeeId, alias FROM employee_aliases WHERE employee_id = $1 ORDER BY id DESC`,
    [employeeId],
  );
}

/**
 * Whether `alias` is already registered to some colaborador within
 * `clientId` **and** `companyId` — `null` when it's free. Scoped per
 * client+company, same as CPF uniqueness (the same alias text can be
 * reused across different clients, or across different empresas of the
 * same multi-empresa cliente, just not within the same client+company
 * pair). Case-insensitive, same ASCII-only limitation already accepted for
 * name search elsewhere.
 */
export async function findEmployeeAliasOwner(
  clientId: number,
  companyId: number,
  alias: string,
): Promise<{ id: number; name: string } | null> {
  const db = await getDb();
  const rows = await db.select<{ id: number; name: string }[]>(
    `SELECT e.id, e.name
     FROM employee_aliases ea
     JOIN employees e ON e.id = ea.employee_id
     WHERE e.client_id = $1 AND e.company_id = $2 AND lower(ea.alias) = lower($3)`,
    [clientId, companyId, alias.trim()],
  );
  return rows[0] ?? null;
}

/**
 * Registers `alias` for `employeeId` — throws a message naming the current
 * owner if it's already someone else's within the same client. Already
 * registered to this same employee is a silent no-op, not an error, since
 * the payment-import "vincular colaborador" flow can call this repeatedly
 * for several rows that share the same raw name.
 */
export async function addEmployeeAlias(employeeId: number, alias: string): Promise<void> {
  const db = await getDb();
  const trimmed = alias.trim();
  if (!trimmed) throw new Error("Nome não pode ser vazio.");

  const employeeRows = await db.select<{ clientId: number; companyId: number }[]>(
    "SELECT client_id AS clientId, company_id AS companyId FROM employees WHERE id = $1",
    [employeeId],
  );
  if (employeeRows.length === 0) throw new Error("Colaborador não encontrado.");

  const owner = await findEmployeeAliasOwner(employeeRows[0].clientId, employeeRows[0].companyId, trimmed);
  if (owner && owner.id !== employeeId) {
    throw new Error(`Esse nome já está vinculado a ${owner.name}.`);
  }
  if (owner) return;

  await db.execute("INSERT INTO employee_aliases (employee_id, alias) VALUES ($1, $2)", [employeeId, trimmed]);
}

export async function removeEmployeeAlias(aliasId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM employee_aliases WHERE id = $1", [aliasId]);
}

/**
 * Resolves a payment row's employee within `clientId` **and** `companyId`
 * by walking a template's `identifierPriority` — every field in one
 * "tentativa" must match the *same* employee together (an AND); tentativas
 * are tried in order and the first one that finds an employee wins (an OR
 * across tentativas). A tentativa is skipped outright if any of its fields
 * has no raw value for this row — there's nothing to match on.
 *
 * Both `clientId` and `companyId` are required, not just `clientId`: a
 * cliente can be linked to more than one empresa (`client_companies`), and
 * an employee's own `company_id` records which one they actually belong
 * to — scoping only by client would match an employee registered under a
 * *different* empresa of the same cliente (e.g. a routing rule's "senão"
 * pointing at the same cliente as a condition rule, but a different
 * empresa), silently misrouting the shift to that other empresa.
 */
export async function findEmployeeByAttempts(
  clientId: number,
  companyId: number,
  attempts: IdentifierAttempt[],
  values: { cpf: string | null; matricula: string | null; nome: string | null },
): Promise<EmployeeRow | null> {
  const db = await getDb();
  const select = `SELECT e.id, e.name, e.cpf, e.matricula,
      cl.id AS clientId, cl.name AS clientName,
      c.id AS companyId, c.name AS companyName
    FROM employees e
    JOIN clients cl ON cl.id = e.client_id
    JOIN companies c ON c.id = e.company_id
    WHERE e.client_id = $1 AND e.company_id = $2`;

  for (const attempt of attempts) {
    if (attempt.fields.length === 0) continue;
    const conditions: string[] = [];
    const params: (string | number)[] = [clientId, companyId];
    let skip = false;

    for (const field of attempt.fields) {
      if (field === "cpf") {
        // Always digit-normalized — case doesn't apply.
        const normalized = values.cpf ? normalizeCpf(values.cpf) : "";
        if (normalized.length !== 11) {
          skip = true;
          break;
        }
        params.push(normalized);
        conditions.push(`e.cpf = $${params.length}`);
      } else if (field === "matricula") {
        const trimmed = values.matricula?.trim();
        if (!trimmed) {
          skip = true;
          break;
        }
        params.push(trimmed);
        conditions.push(
          attempt.caseInsensitive ? `lower(e.matricula) = lower($${params.length})` : `e.matricula = $${params.length}`,
        );
      } else {
        const trimmed = values.nome?.trim();
        if (!trimmed) {
          skip = true;
          break;
        }
        // Matches the colaborador's own name, or any "possível nome"
        // (employee_aliases) registered for them — same caseInsensitive
        // setting governs both, so a tentativa doesn't need a second flag.
        params.push(trimmed);
        const nameParam = params.length;
        params.push(trimmed);
        const aliasParam = params.length;
        const nameCmp = attempt.caseInsensitive ? `lower(e.name) = lower($${nameParam})` : `e.name = $${nameParam}`;
        const aliasCmp = attempt.caseInsensitive
          ? `lower(ea.alias) = lower($${aliasParam})`
          : `ea.alias = $${aliasParam}`;
        conditions.push(
          `(${nameCmp} OR EXISTS (SELECT 1 FROM employee_aliases ea WHERE ea.employee_id = e.id AND ${aliasCmp}))`,
        );
      }
    }

    if (skip) continue;
    const rows = await db.select<EmployeeRow[]>(`${select} AND ${conditions.join(" AND ")}`, params);
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
/**
 * A row only counts as a duplicate when it matches an existing shift on
 * every column, not just employee/data/local — a partial match (say, same
 * colaborador and day and local but a different horário) is a plausible
 * second real shift, not a duplicate. An exact match is unambiguous, so
 * the caller treats it as "já importado" (offer to reprocess) rather than
 * a "possível duplicata" needing a judgment call.
 */
export async function findDuplicatePaymentShifts(
  rows: {
    employeeId: number;
    workDate: string;
    local: string;
    role: string;
    scheduleStartMinutes: number | null;
    scheduleEndMinutes: number | null;
  }[],
): Promise<Set<number>> {
  const db = await getDb();
  const duplicates = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const existing = await db.select<{ id: number }[]>(
      `SELECT id FROM payment_shifts
       WHERE employee_id = $1 AND work_date = $2 AND local = $3 AND role = $4
         AND IFNULL(schedule_start_minutes, -1) = IFNULL($5, -1)
         AND IFNULL(schedule_end_minutes, -1) = IFNULL($6, -1)`,
      [r.employeeId, r.workDate, r.local, r.role, r.scheduleStartMinutes, r.scheduleEndMinutes],
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
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  /** Resolved from the template's status rules (see `resolvePaymentStatus`), falling back to `"pendente"` when none match — not always `"pendente"` anymore. */
  status: PaymentShiftStatus;
  /** Every non-blank column the template left unmapped on this row (see `AppliedPaymentRow.extraFields`) — `null` when there was nothing left unmapped. */
  extraData: Record<string, string> | null;
}

/** Bulk-inserts shifts — `valor` and any further `pago` transition still happen in a later step. */
export async function savePaymentShifts(rows: PaymentShiftInput[]): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO payment_shifts
         (employee_id, template_id, source_file_id, local, work_date, role,
          schedule_start_minutes, schedule_end_minutes, status, extra_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.employeeId,
        r.templateId,
        r.sourceFileId,
        r.local,
        r.workDate,
        r.role,
        r.scheduleStartMinutes,
        r.scheduleEndMinutes,
        r.status,
        r.extraData ? JSON.stringify(r.extraData) : null,
      ],
    );
  }
}

/**
 * A shift's "current" row is whichever one nothing else points to via
 * `previous_shift_id` — once "Fazer pagamento" creates a new row linked
 * back to a pendente/erro one, that older row is superseded and drops out
 * of every list/summary/total, staying only as history reachable through
 * the link on the row that replaced it (see `getPaymentShift`).
 */
const HEAD_SHIFT_CONDITION =
  "ps.id NOT IN (SELECT previous_shift_id FROM payment_shifts WHERE previous_shift_id IS NOT NULL)";

/** Which aggregated column each "Status" checkbox reads — a group matches a status once at least one of its shifts has it. */
const PAYMENT_STATUS_HAVING_CONDITIONS: Record<PaymentShiftStatus, string> = {
  pendente: "SUM(CASE WHEN ps.status = 'pendente' THEN 1 ELSE 0 END) > 0",
  erro: "SUM(CASE WHEN ps.status = 'erro' THEN 1 ELSE 0 END) > 0",
  pago: "SUM(CASE WHEN ps.status = 'pago' THEN 1 ELSE 0 END) > 0",
};

/**
 * SQL-side mirror of `classifyShiftPeriod` (format.ts) — every rule there
 * has an equivalent boolean/arithmetic expression here, built the same way
 * (split each side into up to two non-wrapping `[start,end)` pieces on the
 * 0-1440 circle, then compare pieces pairwise) so the "Diurno/Noturno"
 * filter on the Pagamentos list agrees with the badge shown on the detail
 * page. Kept as plain string-building instead of a stored SQL function
 * since this project only ever talks to SQLite through the JS driver.
 */
function intervalPiecesSql(startExpr: string, endExpr: string): { p1s: string; p1e: string; p2s: string; p2e: string } {
  const wraps = `(${endExpr} < ${startExpr})`;
  return {
    p1s: startExpr,
    p1e: `(CASE WHEN ${wraps} THEN 1440 ELSE ${endExpr} END)`,
    p2s: "0",
    p2e: `(CASE WHEN ${wraps} THEN ${endExpr} ELSE 0 END)`,
  };
}

function piecePairs(a: ReturnType<typeof intervalPiecesSql>, b: ReturnType<typeof intervalPiecesSql>) {
  return [
    [a.p1s, a.p1e, b.p1s, b.p1e],
    [a.p1s, a.p1e, b.p2s, b.p2e],
    [a.p2s, a.p2e, b.p1s, b.p1e],
    [a.p2s, a.p2e, b.p2s, b.p2e],
  ] as const;
}

/** Whether two (possibly midnight-wrapping) time-of-day ranges overlap at all. */
function rangesOverlapSql(aStart: string, aEnd: string, bStart: string, bEnd: string): string {
  const pairs = piecePairs(intervalPiecesSql(aStart, aEnd), intervalPiecesSql(bStart, bEnd));
  return `(${pairs.map(([as, ae, bs, be]) => `(${as} < ${be} AND ${bs} < ${ae})`).join(" OR ")})`;
}

/** Total overlap, in minutes, between two (possibly midnight-wrapping) time-of-day ranges. */
function overlapMinutesSql(aStart: string, aEnd: string, bStart: string, bEnd: string): string {
  const pairs = piecePairs(intervalPiecesSql(aStart, aEnd), intervalPiecesSql(bStart, bEnd));
  return `(${pairs.map(([as, ae, bs, be]) => `MAX(0, MIN(${ae}, ${be}) - MAX(${as}, ${bs}))`).join(" + ")})`;
}

/** Whether `point` falls in a (possibly midnight-wrapping) `[start, end)` range. */
function timeInRangeSql(pointExpr: string, startExpr: string, endExpr: string): string {
  return `(CASE WHEN ${endExpr} < ${startExpr}
    THEN (${pointExpr} >= ${startExpr} OR ${pointExpr} < ${endExpr})
    ELSE (${pointExpr} >= ${startExpr} AND ${pointExpr} < ${endExpr}) END)`;
}

/**
 * SQL fragments for classifying a `payment_shifts` row (already joined as
 * `ps`, with its employee's company already joined as `c`) as "noturno" —
 * `hasSchedule` (a row with no parsed horário is neither diurno nor
 * noturno, same as `classifyShiftPeriod`'s caller returning `null`) and
 * `isNoturno` (the rule-dependent classification itself, only meaningful
 * where `hasSchedule` holds) are kept separate so a caller can build both
 * "is noturno" (`hasSchedule AND isNoturno`) and "is diurno" (`hasSchedule
 * AND NOT isNoturno`) without `NOT` accidentally flipping missing-schedule
 * rows into false positives.
 */
function shiftPeriodSql(): { hasSchedule: string; isNoturno: string } {
  const nightStart = "((CAST(substr(c.night_start_time,1,2) AS INTEGER) * 60) + CAST(substr(c.night_start_time,4,2) AS INTEGER))";
  const nightEnd = "((CAST(substr(c.night_end_time,1,2) AS INTEGER) * 60) + CAST(substr(c.night_end_time,4,2) AS INTEGER))";
  const shiftStart = "ps.schedule_start_minutes";
  const shiftEnd = "ps.schedule_end_minutes";

  const startInRange = timeInRangeSql(shiftStart, nightStart, nightEnd);
  const endInRange = timeInRangeSql(shiftEnd, nightStart, nightEnd);
  const overlaps = rangesOverlapSql(shiftStart, shiftEnd, nightStart, nightEnd);
  const overlapMinutes = overlapMinutesSql(shiftStart, shiftEnd, nightStart, nightEnd);
  const duration = `(CASE WHEN ${shiftEnd} > ${shiftStart} THEN ${shiftEnd} - ${shiftStart} ELSE 1440 - ${shiftStart} + ${shiftEnd} END)`;
  const majorityOverlap = `(${duration} > 0 AND ${overlapMinutes} * 2 >= ${duration})`;

  const isNoturno = `(CASE c.night_shift_rule
    WHEN 'start-in-range' THEN ${startInRange}
    WHEN 'end-in-range' THEN ${endInRange}
    WHEN 'start-or-end-in-range' THEN (${startInRange} OR ${endInRange})
    WHEN 'majority-overlap' THEN ${majorityOverlap}
    ELSE ${overlaps}
  END)`;

  return { hasSchedule: `(${shiftStart} IS NOT NULL AND ${shiftEnd} IS NOT NULL)`, isNoturno };
}

/**
 * Row-level SQL for the "Horário" filter: whether a shift's own start (or
 * end) falls before/after a single reference time the user picked — unlike
 * `shiftPeriodSql`, there's no range/rule table on the company to read, the
 * reference time is just a literal supplied by the caller. A shift with no
 * parsed horário never matches (same "missing schedule never matches"
 * stance as `shiftPeriodSql`'s `hasSchedule` guard). Returns `null` for an
 * unparseable time, meaning "don't filter" — same as the filter being unset.
 */
function scheduleTimeConditionSql(filter: ScheduleTimeFilter, params: (string | number)[]): string | null {
  const referenceMinutes = parseTimeToMinutes(filter.time);
  if (referenceMinutes === null) return null;
  const field = filter.rule.startsWith("start") ? "ps.schedule_start_minutes" : "ps.schedule_end_minutes";
  const op = filter.rule.endsWith("before") ? "<" : ">";
  params.push(referenceMinutes);
  return `(${field} IS NOT NULL AND ${field} ${op} $${params.length})`;
}

export interface ListPaymentShiftSummariesQuery {
  /** Substring match on employee name — case-insensitive only for ASCII (SQLite's `LOWER()` doesn't case-fold accents). */
  search?: string;
  companyIds?: number[];
  clientIds?: number[];
  /** "YYYY-MM-DD", inclusive on both ends — either can be omitted to leave that side open. Same day-level `DateRangePicker` as Cartão Ponto, not competência-granularity. */
  periodStart?: string;
  periodEnd?: string;
  statuses: PaymentShiftStatus[];
  /** Diurno/noturno, per `shiftPeriodSql` — named `shiftPeriods` (not `periods`) to not collide with `periodStart`/`periodEnd` above, which are a date range. */
  shiftPeriods: ShiftPeriod[];
  /** The "Horário" filter — `null`/omitted means unfiltered, unlike `statuses`/`shiftPeriods` where an empty array means "match nothing". */
  scheduleTimeFilter?: ScheduleTimeFilter | null;
  page: number;
  pageSize: number;
}

/**
 * One row per (colaborador, competência) — the Pagamentos list. Filtered
 * and paginated in SQL: the row-level filters (search/empresa/cliente/
 * período) go in WHERE, before the GROUP BY; the status and diurno/noturno
 * filters both read aggregated SUMs, so they go in HAVING instead. An
 * empty `statuses` or `shiftPeriods` matches nothing (same as the
 * in-memory version's behavior for an empty selected set) and
 * short-circuits before querying.
 */
export async function listPaymentShiftSummaries(
  query: ListPaymentShiftSummariesQuery,
): Promise<PagedResult<PaymentShiftSummaryRow>> {
  if (query.statuses.length === 0 || query.shiftPeriods.length === 0) return { rows: [], total: 0 };

  const db = await getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  conditions.push(HEAD_SHIFT_CONDITION);
  const search = query.search?.trim();
  if (search) {
    params.push(search);
    conditions.push(`LOWER(e.name) LIKE '%' || LOWER($${params.length}) || '%'`);
  }
  const companyClause = inClause("c.id", query.companyIds ?? [], params);
  if (companyClause) conditions.push(companyClause);
  const clientClause = inClause("cl.id", query.clientIds ?? [], params);
  if (clientClause) conditions.push(clientClause);
  if (query.periodStart) {
    params.push(query.periodStart);
    conditions.push(`ps.work_date >= $${params.length}`);
  }
  if (query.periodEnd) {
    params.push(query.periodEnd);
    conditions.push(`ps.work_date <= $${params.length}`);
  }

  const havingParts: string[] = [];
  if (query.statuses.length < 3) {
    havingParts.push(`(${query.statuses.map((s) => PAYMENT_STATUS_HAVING_CONDITIONS[s]).join(" OR ")})`);
  }
  if (query.shiftPeriods.length < 2) {
    const { hasSchedule, isNoturno } = shiftPeriodSql();
    const shiftPeriodConditions = query.shiftPeriods.map((p) =>
      p === "noturno"
        ? `SUM(CASE WHEN ${hasSchedule} AND ${isNoturno} THEN 1 ELSE 0 END) > 0`
        : `SUM(CASE WHEN ${hasSchedule} AND NOT ${isNoturno} THEN 1 ELSE 0 END) > 0`,
    );
    havingParts.push(`(${shiftPeriodConditions.join(" OR ")})`);
  }
  if (query.scheduleTimeFilter) {
    const cond = scheduleTimeConditionSql(query.scheduleTimeFilter, params);
    if (cond) havingParts.push(`SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) > 0`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const havingClause = havingParts.length > 0 ? `HAVING ${havingParts.join(" AND ")}` : "";
  const from = `FROM payment_shifts ps
    JOIN employees e ON e.id = ps.employee_id
    JOIN clients cl ON cl.id = e.client_id
    JOIN companies c ON c.id = e.company_id`;

  const countRows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) AS count FROM (
       SELECT e.id ${from} ${whereClause} GROUP BY e.id, strftime('%Y-%m', ps.work_date) ${havingClause}
     ) t`,
    params,
  );
  const total = countRows[0]?.count ?? 0;

  const rows = await db.select<PaymentShiftSummaryRow[]>(
    `SELECT
      e.id AS employeeId, e.name AS employeeName,
      cl.id AS clientId, cl.name AS clientName,
      c.id AS companyId, c.name AS companyName,
      strftime('%Y-%m', ps.work_date) AS competencia,
      COUNT(*) AS total,
      SUM(CASE WHEN ps.status = 'pendente' THEN 1 ELSE 0 END) AS pendente,
      SUM(CASE WHEN ps.status = 'erro' THEN 1 ELSE 0 END) AS erro,
      SUM(CASE WHEN ps.status = 'pago' THEN 1 ELSE 0 END) AS pago
    ${from}
    ${whereClause}
    GROUP BY e.id, competencia
    ${havingClause}
    ORDER BY competencia DESC, e.name
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, query.page * query.pageSize],
  );

  return { rows, total };
}

export interface PaymentShiftReportRow {
  employeeName: string;
  companyId: number;
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  status: PaymentShiftStatus;
  amount: number | null;
  /** Computed in SQL via the company's own configured rule, same as `shiftPeriodSql` powers for the list's Diurno/Noturno filter — `null` when there's no schedule to classify. */
  shiftPeriod: ShiftPeriod | null;
}

/**
 * Every *current* shift matching the Pagamentos list's filters, flat (no
 * grouping/pagination) — the data behind "Gerar PDF". Same WHERE-condition
 * shape as `listPaymentShiftSummaries` for search/empresa/cliente/período,
 * but status and diurno/noturno are per-row `WHERE` conditions here instead
 * of aggregated `HAVING` ones, since there's no `GROUP BY` to aggregate
 * through.
 */
export async function listPaymentShiftsForReport(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<PaymentShiftReportRow[]> {
  if (query.statuses.length === 0 || query.shiftPeriods.length === 0) return [];

  const db = await getDb();
  const conditions: string[] = [HEAD_SHIFT_CONDITION];
  const params: (string | number)[] = [];

  const search = query.search?.trim();
  if (search) {
    params.push(search);
    conditions.push(`LOWER(e.name) LIKE '%' || LOWER($${params.length}) || '%'`);
  }
  const companyClause = inClause("c.id", query.companyIds ?? [], params);
  if (companyClause) conditions.push(companyClause);
  const clientClause = inClause("cl.id", query.clientIds ?? [], params);
  if (clientClause) conditions.push(clientClause);
  if (query.periodStart) {
    params.push(query.periodStart);
    conditions.push(`ps.work_date >= $${params.length}`);
  }
  if (query.periodEnd) {
    params.push(query.periodEnd);
    conditions.push(`ps.work_date <= $${params.length}`);
  }
  if (query.statuses.length < 3) {
    const placeholders = query.statuses.map((s) => {
      params.push(s);
      return `$${params.length}`;
    });
    conditions.push(`ps.status IN (${placeholders.join(", ")})`);
  }

  const { hasSchedule, isNoturno } = shiftPeriodSql();
  if (query.shiftPeriods.length < 2) {
    conditions.push(
      query.shiftPeriods[0] === "noturno" ? `(${hasSchedule} AND ${isNoturno})` : `(${hasSchedule} AND NOT ${isNoturno})`,
    );
  }
  if (query.scheduleTimeFilter) {
    const cond = scheduleTimeConditionSql(query.scheduleTimeFilter, params);
    if (cond) conditions.push(cond);
  }
  const shiftPeriodExpr = `(CASE WHEN NOT ${hasSchedule} THEN NULL WHEN ${isNoturno} THEN 'noturno' ELSE 'diurno' END)`;

  return db.select<PaymentShiftReportRow[]>(
    `SELECT e.name AS employeeName, c.id AS companyId,
            ps.work_date AS workDate, ps.local, ps.role,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.amount, ${shiftPeriodExpr} AS shiftPeriod
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN clients cl ON cl.id = e.client_id
     JOIN companies c ON c.id = e.company_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ps.work_date, ps.local, e.name`,
    params,
  );
}

const PAYMENT_SHIFT_SELECT_COLUMNS = `
  ps.id, ps.employee_id AS employeeId, e.name AS employeeName,
  ps.local, ps.work_date AS workDate, ps.role,
  ps.schedule_start_minutes AS scheduleStartMinutes,
  ps.schedule_end_minutes AS scheduleEndMinutes,
  ps.status, ps.error_message AS errorMessage, ps.amount, ps.imported_at AS importedAt,
  ps.previous_shift_id AS previousShiftId, ps.extra_data AS extraData
`;

const PAYMENT_SHIFT_FROM_CLAUSE = `
  FROM payment_shifts ps
  JOIN employees e ON e.id = ps.employee_id
`;

type PaymentShiftRowRaw = Omit<PaymentShiftRow, "extraData"> & { extraData: string | null };

/** `extra_data` is stored as a JSON string (or NULL) — parsed once here so every reader gets the real `Record<string, string> | null` shape. */
function parsePaymentShiftRow(row: PaymentShiftRowRaw): PaymentShiftRow {
  return { ...row, extraData: row.extraData ? JSON.parse(row.extraData) : null };
}

/** Every *current* shift (see `HEAD_SHIFT_CONDITION`) for one colaborador in one competência ("YYYY-MM") — the Pagamentos detail. */
export async function listPaymentShiftsForEmployeeMonth(
  employeeId: number,
  competencia: string,
): Promise<PaymentShiftRow[]> {
  const db = await getDb();
  const rows = await db.select<PaymentShiftRowRaw[]>(
    `SELECT ${PAYMENT_SHIFT_SELECT_COLUMNS}
     ${PAYMENT_SHIFT_FROM_CLAUSE}
     WHERE ps.employee_id = $1 AND strftime('%Y-%m', ps.work_date) = $2 AND ${HEAD_SHIFT_CONDITION}
     ORDER BY ps.work_date, ps.id`,
    [employeeId, competencia],
  );
  return rows.map(parsePaymentShiftRow);
}

/**
 * A single shift by id, current or superseded — used to open the "ver
 * status anterior" link on a `pago` row, which points at a row that
 * `listPaymentShiftsForEmployeeMonth` no longer returns on its own since
 * it's not a head row anymore.
 */
export async function getPaymentShift(id: number): Promise<PaymentShiftRow> {
  const db = await getDb();
  const rows = await db.select<PaymentShiftRowRaw[]>(
    `SELECT ${PAYMENT_SHIFT_SELECT_COLUMNS} ${PAYMENT_SHIFT_FROM_CLAUSE} WHERE ps.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Turno não encontrado.");
  return parsePaymentShiftRow(rows[0]);
}

interface PaymentShiftCoreFields {
  employeeId: number;
  templateId: number | null;
  sourceFileId: number | null;
  local: string;
  workDate: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  /** Raw JSON string as stored (or NULL) — passed straight through into the new row, not re-parsed, since a status transition never changes what was in the original file. */
  extraData: string | null;
  status: PaymentShiftStatus;
}

/** Shared by every status-transition function below — the fields that always carry over unchanged into the new row. */
async function readPaymentShiftCoreFields(db: Database, shiftId: number): Promise<PaymentShiftCoreFields> {
  const rows = await db.select<PaymentShiftCoreFields[]>(
    `SELECT employee_id AS employeeId, template_id AS templateId, source_file_id AS sourceFileId,
            local, work_date AS workDate, role,
            schedule_start_minutes AS scheduleStartMinutes, schedule_end_minutes AS scheduleEndMinutes,
            extra_data AS extraData, status
     FROM payment_shifts WHERE id = $1`,
    [shiftId],
  );
  if (rows.length === 0) throw new Error("Turno não encontrado.");
  return rows[0];
}

/**
 * "Fazer pagamento": always inserts a brand-new row instead of mutating
 * `shiftId`'s row — copies its core shift fields, sets status = 'pago',
 * the confirmed `amount`, and links `previousShiftId` back to it. From
 * this point on `shiftId`'s row is frozen (only ever read, never written)
 * and drops out of every head-only list/summary/total.
 */
export async function markPaymentShiftPaid(shiftId: number, amount: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, local, work_date, role,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pago', $9, $10, $11)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.local,
      s.workDate,
      s.role,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      amount,
      shiftId,
      s.extraData,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * Undoes a payment the same append-only way "Fazer pagamento" applies one:
 * a brand-new row with status back to `pendente` (amount cleared — it's no
 * longer paid, so there's nothing to show there until it's paid again),
 * linked back to `shiftId`. `shiftId`'s `pago` row is never mutated, just
 * like every other transition — it stays reachable as history, and a shift
 * can be paid and reverted more than once, each hop its own row.
 */
export async function revertPaymentShiftToPending(shiftId: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, local, work_date, role,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NULL, $9, $10)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.local,
      s.workDate,
      s.role,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      shiftId,
      s.extraData,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * Manually overrides a shift's Valor — same append-only pattern as "Fazer
 * pagamento"/"Voltar para pendente": a brand-new row carrying the given
 * `amount` and `previousShiftId` linked back to `shiftId`, whose own row is
 * left untouched. Status carries over unchanged (unlike those other two
 * transitions, which each force a specific status) — this only ever
 * corrects the value, never the state of the shift.
 *
 * Only for `pendente`/`erro` shifts, where the Valor is just a live
 * estimate from the company's rules until it's actually paid — once a shift
 * is `pago` its amount is the historical record of what was paid and must
 * never be edited, so this refuses to touch one.
 */
export async function editPaymentShiftValue(shiftId: number, amount: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);
  if (s.status === "pago") throw new Error("Não é possível editar o valor de um turno já pago.");

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, local, work_date, role,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.local,
      s.workDate,
      s.role,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      s.status,
      amount,
      shiftId,
      s.extraData,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * Walks the append-only chain backward from `shiftId` via
 * `previousShiftId`, returning every row from oldest to most recent
 * (including `shiftId` itself) — the full "Status anterior" history for a
 * shift, not just one hop back, since a shift can be paid, reverted to
 * pendente, and paid again more than once.
 */
export async function getPaymentShiftHistory(shiftId: number): Promise<PaymentShiftRow[]> {
  const chain: PaymentShiftRow[] = [];
  let currentId: number | null = shiftId;
  while (currentId !== null) {
    const shift: PaymentShiftRow = await getPaymentShift(currentId);
    chain.push(shift);
    currentId = shift.previousShiftId;
  }
  return chain.reverse();
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
  /** Keep payment-import templates and their column-mapping groups/rules. Independent of the others — a template has no FK into companies/clients/employees (routing/identification is resolved per row at import execution time, never baked into the template). */
  keepPaymentTemplates?: boolean;
  /** Keep colaborador-import templates and their column-mapping groups. Same independence as `keepPaymentTemplates`. */
  keepEmployeeTemplates?: boolean;
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
 * data (companies/clients/employees, and both template kinds) can
 * optionally survive via `options` — companies/clients/employees respect
 * the real dependency chain (employees → clients → companies), while the
 * two template kinds are independent of that chain and of each other.
 */
export async function clearAllData(options: ClearDataOptions = {}): Promise<void> {
  const db = await getDb();

  const keepEmployees = Boolean(options.keepEmployees);
  const keepClients = Boolean(options.keepClients) || keepEmployees;
  const keepCompanies = Boolean(options.keepCompanies) || keepClients;
  const keepPaymentTemplates = Boolean(options.keepPaymentTemplates);
  const keepEmployeeTemplates = Boolean(options.keepEmployeeTemplates);

  await db.execute("DELETE FROM punches");
  await db.execute("DELETE FROM day_records");
  await db.execute("DELETE FROM imports");
  await db.execute("DELETE FROM import_files");
  // Payment shifts are import history too (one row per imported work
  // shift), same category as day_records/punches — always cleared, and
  // before source_files/employees since it references both. The table is
  // self-referencing (previous_shift_id, for "Fazer pagamento" history),
  // so null those out first — otherwise the bulk delete can violate that
  // FK mid-way through, depending on delete order.
  await db.execute("UPDATE payment_shifts SET previous_shift_id = NULL WHERE previous_shift_id IS NOT NULL");
  await db.execute("DELETE FROM payment_shifts");
  await db.execute("DELETE FROM source_files");

  const clearedTables = ["punches", "day_records", "imports", "import_files", "payment_shifts", "source_files"];

  // Templates are master/config data, not import history — optional to
  // keep, like companies/clients/employees, but independent of that chain:
  // neither template kind has an FK into companies/clients/employees
  // (routing/identification is resolved per row at import execution time).
  if (!keepPaymentTemplates) {
    await db.execute("DELETE FROM payment_template_rules");
    await db.execute("DELETE FROM payment_template_status_rules");
    await db.execute("DELETE FROM payment_template_fields");
    await db.execute("DELETE FROM payment_template_sheets");
    await db.execute("DELETE FROM payment_template_groups");
    await db.execute("DELETE FROM payment_templates");
    clearedTables.push("payment_templates");
  }
  if (!keepEmployeeTemplates) {
    await db.execute("DELETE FROM employee_template_fields");
    await db.execute("DELETE FROM employee_template_sheets");
    await db.execute("DELETE FROM employee_template_groups");
    await db.execute("DELETE FROM employee_templates");
    clearedTables.push("employee_templates");
  }

  if (!keepEmployees) {
    // employee_aliases.employee_id is NOT NULL REFERENCES employees(id)
    // with FK enforcement on for this connection (confirmed by a real
    // SQLITE_CONSTRAINT_FOREIGNKEY here) — has to go first.
    await db.execute("DELETE FROM employee_aliases");
    await db.execute("DELETE FROM employees");
    clearedTables.push("employee_aliases", "employees");
  }
  if (!keepClients) {
    // A surviving payment template's routing rule still requires a real
    // client_id, and this connection does enforce foreign keys — wiping
    // clients out from under a kept template's rules would fail the same
    // way the missing `employee_aliases` delete above did, so drop rules
    // here too even when the template itself is kept. Redundant (and
    // harmless) when `!keepPaymentTemplates` already cleared them above.
    // (keepCompanies can only be false when keepClients is too, so this
    // single spot covers a company wipe as well.)
    await db.execute("DELETE FROM payment_template_rules");
    await db.execute("DELETE FROM client_companies");
    await db.execute("DELETE FROM clients");
    clearedTables.push("clients");
  }
  if (!keepCompanies) {
    // Same FK-dangling concern as payment_template_rules above: every
    // value rule requires a real company_id.
    await db.execute("DELETE FROM payment_value_rules");
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
