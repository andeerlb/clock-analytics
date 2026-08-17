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
  PaymentAuditResult,
  PaymentAuditRow,
  PaymentExportTemplateConfig,
  PaymentExportTemplateInput,
  PaymentExportTemplateListRow,
  PaymentExportTemplateRow,
  PaymentFileKind,
  PaymentRuleCondition,
  PaymentRuleField,
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

/**
 * Common PT-BR accented letters folded to their base ASCII form. Both cases
 * are listed explicitly (not just lowercase) because SQLite's built-in
 * `LOWER()` only case-folds ASCII — an uppercase "Ç"/"É"/etc. (the employee
 * directory is all-caps) passes through `LOWER()` unchanged, so it still
 * needs its own `REPLACE()` pair downstream of it.
 */
const ACCENT_FOLD_PAIRS: [string, string][] = [
  ["á", "a"], ["à", "a"], ["ã", "a"], ["â", "a"], ["ä", "a"],
  ["Á", "a"], ["À", "a"], ["Ã", "a"], ["Â", "a"], ["Ä", "a"],
  ["é", "e"], ["è", "e"], ["ê", "e"], ["ë", "e"],
  ["É", "e"], ["È", "e"], ["Ê", "e"], ["Ë", "e"],
  ["í", "i"], ["ì", "i"], ["î", "i"], ["ï", "i"],
  ["Í", "i"], ["Ì", "i"], ["Î", "i"], ["Ï", "i"],
  ["ó", "o"], ["ò", "o"], ["õ", "o"], ["ô", "o"], ["ö", "o"],
  ["Ó", "o"], ["Ò", "o"], ["Õ", "o"], ["Ô", "o"], ["Ö", "o"],
  ["ú", "u"], ["ù", "u"], ["û", "u"], ["ü", "u"],
  ["Ú", "u"], ["Ù", "u"], ["Û", "u"], ["Ü", "u"],
  ["ç", "c"], ["Ç", "c"], ["ñ", "n"], ["Ñ", "n"],
];

/**
 * Wraps a SQL expression (a column reference or a bound-parameter
 * placeholder) with `LOWER()` plus a chain of `REPLACE()` calls that fold
 * accented PT-BR letters to their base form — SQLite has no built-in accent
 * folding, so a name search needs the *same* chain applied to both sides of
 * a `LIKE` to match case- and accent-insensitively (e.g. "goncalves" against
 * "GONÇALVES").
 */
function foldAccentsSql(sqlExpr: string): string {
  return ACCENT_FOLD_PAIRS.reduce((expr, [from, to]) => `REPLACE(${expr}, '${from}', '${to}')`, `LOWER(${sqlExpr})`);
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
  // Scoped to cpf alone — since 0072_employee_client_link.sql a colaborador
  // is one person globally, not one person per cliente (and, since 0071,
  // not one person per empresa either). Neither `clientId` nor `companyId`
  // pick out *which* employee row this is anymore; they're just which
  // (cliente, empresa) pair this particular timesheet import links them to,
  // recorded below in `employee_client_companies` alongside every other
  // pair they've already been imported under. Auto-linking a new pair here
  // (instead of asking first, the way `createEmployeeManual`/
  // `findEmployeeByAttempts` do for the same situation) mirrors this
  // function's own prior behavior: it already silently auto-created a
  // brand-new employee on an unmatched cpf with no confirmation step, and
  // importing one specific PDF under an explicitly-chosen cliente/empresa is
  // already a single deliberate action, not an ambiguous bulk match.
  const existing = await db.select<{ id: number }[]>("SELECT id FROM employees WHERE cpf = $1", [normalizedCpf]);
  let employeeId: number;
  if (existing.length > 0) {
    employeeId = existing[0].id;
    await db.execute("UPDATE employees SET name = $1 WHERE id = $2", [name, employeeId]);
  } else {
    const result = await db.execute("INSERT INTO employees (name, cpf) VALUES ($1, $2)", [name, normalizedCpf]);
    employeeId = result.lastInsertId as number;
  }
  await db.execute(
    `INSERT INTO employee_client_companies (employee_id, client_id, company_id) VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, client_id, company_id) DO NOTHING`,
    [employeeId, clientId, companyId],
  );
  return employeeId;
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
       (provider, employee_id, client_id, company_id, period_start, period_end, original_pdf_path, import_file_id,
        source_file_id, max_punches, total_worked_minutes, overtime_minutes, absence_minutes,
        late_minutes, regular_minutes, interval_minutes, pending_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      sheet.provider,
      employeeId,
      clientId,
      companyId,
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
      `INSERT INTO payment_value_rules (company_id, kind, conditions_json, operator, threshold_minutes, amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        companyId,
        rule.kind,
        rule.kind === "condition" && rule.conditions.length > 0 ? JSON.stringify(rule.conditions) : null,
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

  const valueRuleRows = await db.select<(Omit<PaymentValueRule, "conditions"> & { conditionsJson: string | null })[]>(
    `SELECT kind, conditions_json AS conditionsJson, operator, threshold_minutes AS thresholdMinutes, amount
     FROM payment_value_rules WHERE company_id = $1 ORDER BY id`,
    [id],
  );
  const valueRules: PaymentValueRule[] = valueRuleRows.map(({ conditionsJson, ...rule }) => ({
    ...rule,
    conditions: conditionsJson ? JSON.parse(conditionsJson) : [],
  }));

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
  nightStartTime: string | null = null,
  nightEndTime: string | null = null,
  nightShiftRule: NightShiftRule | null = null,
  valueRules: PaymentValueRule[] = [],
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
    // Linking an existing client to one more empresa isn't an edit of that
    // client — its rule overrides (if any) are left exactly as they are,
    // any `nightStartTime`/`valueRules` passed here are silently ignored.
    clientId = existing[0].id;
  } else {
    const result = await db.execute(
      "INSERT INTO clients (name, cnpj, night_start_time, night_end_time, night_shift_rule) VALUES ($1, $2, $3, $4, $5)",
      [name.trim(), normalizedCnpj, nightStartTime, nightEndTime, nightShiftRule],
    );
    clientId = result.lastInsertId as number;
    await insertClientValueRules(db, clientId, valueRules);
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
  /** `null` (all three together) means "no override — inherit the linked company's own night window/rule", see `getEffectivePaymentRules`. */
  nightStartTime: string | null;
  nightEndTime: string | null;
  nightShiftRule: NightShiftRule | null;
  /** Empty means "no override — inherit the linked company's own chain entirely", not "worth zero" — same convention `CompanyDetail.valueRules` already uses. */
  valueRules: PaymentValueRule[];
}

/** Inserted in array order, same evaluation-by-insertion-order convention as `insertCompanyValueRules`. */
async function insertClientValueRules(db: Database, clientId: number, rules: PaymentValueRule[]): Promise<void> {
  for (const rule of rules) {
    await db.execute(
      `INSERT INTO client_payment_value_rules (client_id, kind, conditions_json, operator, threshold_minutes, amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        clientId,
        rule.kind,
        rule.kind === "condition" && rule.conditions.length > 0 ? JSON.stringify(rule.conditions) : null,
        rule.kind === "condition" ? rule.operator : null,
        rule.kind === "condition" ? rule.thresholdMinutes : null,
        rule.amount,
      ],
    );
  }
}

async function deleteClientValueRules(db: Database, clientId: number): Promise<void> {
  await db.execute("DELETE FROM client_payment_value_rules WHERE client_id = $1", [clientId]);
}

export async function getClient(id: number): Promise<ClientDetail> {
  const db = await getDb();
  const rows = await db.select<
    { id: number; name: string; cnpj: string; nightStartTime: string | null; nightEndTime: string | null; nightShiftRule: NightShiftRule | null }[]
  >(
    `SELECT id, name, cnpj, night_start_time AS nightStartTime, night_end_time AS nightEndTime,
            night_shift_rule AS nightShiftRule
     FROM clients WHERE id = $1`,
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
  const valueRuleRows = await db.select<(Omit<PaymentValueRule, "conditions"> & { conditionsJson: string | null })[]>(
    `SELECT kind, conditions_json AS conditionsJson, operator, threshold_minutes AS thresholdMinutes, amount
     FROM client_payment_value_rules WHERE client_id = $1 ORDER BY id`,
    [id],
  );
  const valueRules: PaymentValueRule[] = valueRuleRows.map(({ conditionsJson, ...rule }) => ({
    ...rule,
    conditions: conditionsJson ? JSON.parse(conditionsJson) : [],
  }));
  return { ...rows[0], companies, valueRules };
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
    "SELECT COUNT(*) AS count FROM employee_client_companies WHERE client_id = $1 AND company_id = $2",
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
export async function updateClient(
  id: number,
  name: string,
  cnpj: string,
  nightStartTime: string | null = null,
  nightEndTime: string | null = null,
  nightShiftRule: NightShiftRule | null = null,
  valueRules: PaymentValueRule[] = [],
): Promise<void> {
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
  await db.execute(
    "UPDATE clients SET name = $1, cnpj = $2, night_start_time = $3, night_end_time = $4, night_shift_rule = $5 WHERE id = $6",
    [name.trim(), normalizedCnpj, nightStartTime, nightEndTime, nightShiftRule, id],
  );
  await deleteClientValueRules(db, id);
  await insertClientValueRules(db, id, valueRules);
}

/** The night-shift window/rule + pay-value chain actually in effect for one (cliente, empresa) pair — the client's own override when it has one, falling back field-by-field (night window) or as a whole chain (value rules) to the company's otherwise. Mirrored in SQL by `shiftPeriodSql` for night-shift classification (the only one of the two ever resolved SQL-side). */
export interface EffectivePaymentRules {
  nightStartTime: string;
  nightEndTime: string;
  nightShiftRule: NightShiftRule;
  valueRules: PaymentValueRule[];
}

export async function getEffectivePaymentRules(clientId: number, companyId: number): Promise<EffectivePaymentRules> {
  const [client, company] = await Promise.all([getClient(clientId), getCompany(companyId)]);
  return {
    nightStartTime: client.nightStartTime ?? company.nightStartTime,
    nightEndTime: client.nightEndTime ?? company.nightEndTime,
    nightShiftRule: client.nightShiftRule ?? company.nightShiftRule,
    valueRules: client.valueRules.length > 0 ? client.valueRules : company.valueRules,
  };
}

/**
 * One (cliente, empresa) pairing a colaborador is linked to — the atomic
 * fact `employee_client_companies` records (see
 * 0072_employee_client_link.sql): "this person works at this cliente via
 * this empresa," with its own `matricula` (issued per-empresa, by that
 * empresa's own payroll — not shared across every pairing the same person
 * has). Needed as a pair, not two independent lists, because a single
 * empresa can already serve more than one cliente (`client_companies`) —
 * knowing someone is linked to empresa X and, separately, to cliente A
 * wouldn't say whether they work at A via X specifically.
 */
export interface EmployeeClientCompanyLink {
  clientId: number;
  clientName: string;
  companyId: number;
  companyName: string;
  matricula: string | null;
}

/**
 * A colaborador is one person, globally (`UNIQUE(cpf)`, see
 * 0072_employee_client_link.sql) — `links` is every (cliente, empresa) pair
 * they're linked to, at least one, since importing anything for them
 * requires resolving to a specific pair. Before 0072 a colaborador belonged
 * to exactly one cliente (and, before 0071, exactly one empresa); a second
 * one of either meant a second, duplicate `employees` row — this is what
 * replaced that.
 */
export interface EmployeeRow {
  id: number;
  name: string;
  cpf: string;
  links: EmployeeClientCompanyLink[];
}

/**
 * Builds full `EmployeeRow`s (including each one's `links`) for a batch of
 * employee ids in two queries total instead of one per id — every
 * `employees` read path (`getEmployee`, `listEmployeesGlobal`,
 * `findEmployeeByAttempts` and its siblings) goes through this so the
 * "attach links" logic can't drift between them. Order of the returned
 * array is NOT guaranteed to match `employeeIds` — callers that care about
 * order (e.g. `listEmployeesGlobal`'s `ORDER BY name`) re-sort by id
 * themselves.
 */
async function hydrateEmployeeRows(db: Database, employeeIds: number[]): Promise<EmployeeRow[]> {
  if (employeeIds.length === 0) return [];
  const placeholders = employeeIds.map((_, i) => `$${i + 1}`).join(", ");
  const base = await db.select<{ id: number; name: string; cpf: string }[]>(
    `SELECT e.id, e.name, e.cpf FROM employees e WHERE e.id IN (${placeholders})`,
    employeeIds,
  );
  const linkRows = await db.select<
    {
      employeeId: number;
      clientId: number;
      clientName: string;
      companyId: number;
      companyName: string;
      matricula: string | null;
    }[]
  >(
    `SELECT ecc.employee_id AS employeeId, cl.id AS clientId, cl.name AS clientName,
            c.id AS companyId, c.name AS companyName, ecc.matricula
     FROM employee_client_companies ecc
     JOIN clients cl ON cl.id = ecc.client_id
     JOIN companies c ON c.id = ecc.company_id
     WHERE ecc.employee_id IN (${placeholders})
     ORDER BY cl.name, c.name`,
    employeeIds,
  );
  const linksByEmployee = new Map<number, EmployeeClientCompanyLink[]>();
  for (const row of linkRows) {
    const list = linksByEmployee.get(row.employeeId) ?? [];
    list.push({
      clientId: row.clientId,
      clientName: row.clientName,
      companyId: row.companyId,
      companyName: row.companyName,
      matricula: row.matricula,
    });
    linksByEmployee.set(row.employeeId, list);
  }
  return base.map((e) => ({ ...e, links: linksByEmployee.get(e.id) ?? [] }));
}

export interface EmployeesGlobalQuery {
  /** Substring match on name — case- and accent-insensitive (see `foldAccentsSql`). */
  search?: string;
  companyIds?: number[];
  clientIds?: number[];
  page: number;
  pageSize: number;
}

/**
 * Every employee, globally — the Colaboradores cadastro list. Not scoped to
 * a single cliente/empresa up front (unlike the import flows) since this is
 * meant as a master directory; each row's `links` disambiguate a colaborador
 * linked to more than one cliente and/or empresa. Filtered and paginated in
 * SQL, not in memory — `total` is the count of matching *colaboradores*
 * (not links) before `page`/`pageSize` apply. `companyIds`/`clientIds` are
 * independent facets — "linked to at least one of these empresas" AND
 * "linked to at least one of these clientes," not necessarily via the same
 * link row (a colaborador linked to cliente A via empresa X still matches a
 * `clientIds=[A], companyIds=[Y]` filter if they're separately linked to Y
 * for some other cliente).
 */
export async function listEmployeesGlobal(query: EmployeesGlobalQuery): Promise<PagedResult<EmployeeRow>> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const search = query.search?.trim();
  if (search) {
    params.push(search);
    conditions.push(`${foldAccentsSql("e.name")} LIKE '%' || ${foldAccentsSql(`$${params.length}`)} || '%'`);
  }
  const companyClause = inClause("ecc_company.company_id", query.companyIds ?? [], params);
  if (companyClause) {
    conditions.push(
      `EXISTS (SELECT 1 FROM employee_client_companies ecc_company WHERE ecc_company.employee_id = e.id AND ${companyClause})`,
    );
  }
  const clientClause = inClause("ecc_client.client_id", query.clientIds ?? [], params);
  if (clientClause) {
    conditions.push(
      `EXISTS (SELECT 1 FROM employee_client_companies ecc_client WHERE ecc_client.employee_id = e.id AND ${clientClause})`,
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM employees e`;

  const countRows = await db.select<{ count: number }[]>(`SELECT COUNT(*) AS count ${from} ${whereClause}`, params);
  const total = countRows[0]?.count ?? 0;

  const idRows = await db.select<{ id: number }[]>(
    `SELECT e.id
     ${from}
     ${whereClause}
     ORDER BY e.name
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, query.page * query.pageSize],
  );

  const hydrated = await hydrateEmployeeRows(db, idRows.map((r) => r.id));
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  const rows = idRows.map((r) => byId.get(r.id)!);

  return { rows, total };
}

/**
 * Full `EmployeeRow`s for a specific set of ids, in one batched query —
 * for a caller that already knows *which* colaboradores it wants (e.g. the
 * "Colaborador" filter pinning already-selected names that may have fallen
 * off the current search's page) rather than searching/paginating like
 * `listEmployeesGlobal`.
 */
export async function getEmployeesByIds(ids: number[]): Promise<EmployeeRow[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  return hydrateEmployeeRows(db, ids);
}

/**
 * Registers an employee directly (not via a timesheet import) — the
 * Colaboradores cadastro's "Cadastrar" action. Errors if a colaborador with
 * this CPF already exists at all (globally — CPF is one person, period) —
 * the caller is expected to have already checked for that (e.g. via
 * `findEmployeeAnywhereByAttempts`) and offered "vincular a este
 * cliente/empresa" on the *existing* record instead of getting here; this
 * is a safety net, not the primary UX for that case.
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

  const existing = await db.select<{ id: number }[]>("SELECT id FROM employees WHERE cpf = $1", [normalizedCpf]);
  if (existing.length > 0) {
    throw new Error("Já existe um colaborador com esse CPF.");
  }

  const result = await db.execute("INSERT INTO employees (name, cpf) VALUES ($1, $2)", [name.trim(), normalizedCpf]);
  const employeeId = result.lastInsertId as number;
  await linkEmployeeToClientCompany(employeeId, clientId, companyId, matricula);
  return employeeId;
}

export async function getEmployee(id: number): Promise<EmployeeRow> {
  const db = await getDb();
  const rows = await hydrateEmployeeRows(db, [id]);
  if (rows.length === 0) throw new Error("Colaborador não encontrado.");
  return rows[0];
}

/**
 * Links `employeeId` to the (`clientId`, `companyId`) pair — creates the
 * colaborador's presence there if it doesn't exist yet, or just updates the
 * matrícula if it does (an existing link is not an error: the
 * payment-import "vincular colaborador" flow can call this repeatedly for
 * several rows under the same pair). Used both by `createEmployeeManual`
 * (for the pair picked at creation) and directly, for the "colaborador já
 * existe — vincular também?" confirmation
 * (`findEmployeeAnywhereByAttempts`'s caller).
 */
export async function linkEmployeeToClientCompany(
  employeeId: number,
  clientId: number,
  companyId: number,
  matricula: string | null = null,
): Promise<void> {
  const db = await getDb();
  const link = await db.select<{ clientId: number }[]>(
    "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
    [clientId, companyId],
  );
  if (link.length === 0) {
    throw new Error("Esse cliente não está vinculado à empresa selecionada.");
  }

  await db.execute(
    `INSERT INTO employee_client_companies (employee_id, client_id, company_id, matricula) VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, client_id, company_id) DO UPDATE SET matricula = excluded.matricula`,
    [employeeId, clientId, companyId, matricula?.trim() || null],
  );
}

/** Just the matrícula for one of a colaborador's (cliente, empresa) links — the rest of `employee_client_companies` isn't user-editable after creation (the link itself is added/removed via `linkEmployeeToClientCompany`/`unlinkEmployeeClientCompany`). */
export async function updateEmployeeClientCompanyMatricula(
  employeeId: number,
  clientId: number,
  companyId: number,
  matricula: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE employee_client_companies SET matricula = $1 WHERE employee_id = $2 AND client_id = $3 AND company_id = $4",
    [matricula?.trim() || null, employeeId, clientId, companyId],
  );
}

/**
 * Removes one of a colaborador's (cliente, empresa) links — refuses to drop
 * the last one, since a colaborador with zero links can't be resolved by
 * any future import (every import path requires a resolved cliente+empresa
 * pair).
 */
export async function unlinkEmployeeClientCompany(employeeId: number, clientId: number, companyId: number): Promise<void> {
  const db = await getDb();
  const count = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM employee_client_companies WHERE employee_id = $1",
    [employeeId],
  );
  if ((count[0]?.n ?? 0) <= 1) {
    throw new Error("O colaborador precisa estar vinculado a pelo menos um cliente/empresa.");
  }
  await db.execute(
    "DELETE FROM employee_client_companies WHERE employee_id = $1 AND client_id = $2 AND company_id = $3",
    [employeeId, clientId, companyId],
  );
}

/**
 * Updates name/CPF only — every (cliente, empresa) link and its matrícula
 * is managed separately (`linkEmployeeToClientCompany`/
 * `unlinkEmployeeClientCompany`/`updateEmployeeClientCompanyMatricula`)
 * since there can be more than one, and none of them are "the" identity
 * anymore — CPF alone is (see 0072_employee_client_link.sql).
 */
export async function updateEmployee(id: number, name: string, cpf: string): Promise<void> {
  const db = await getDb();
  const normalizedCpf = normalizeCpf(cpf);
  if (normalizedCpf.length !== 11) {
    throw new Error("CPF deve ter 11 dígitos.");
  }

  const current = await db.select<{ id: number }[]>("SELECT id FROM employees WHERE id = $1", [id]);
  if (current.length === 0) throw new Error("Colaborador não encontrado.");

  const existing = await db.select<{ id: number }[]>("SELECT id FROM employees WHERE cpf = $1 AND id != $2", [
    normalizedCpf,
    id,
  ]);
  if (existing.length > 0) {
    throw new Error("Já existe um colaborador com esse CPF.");
  }

  await db.execute("UPDATE employees SET name = $1, cpf = $2 WHERE id = $3", [name.trim(), normalizedCpf, id]);
}

/**
 * Hard-deletes a colaborador and everything tied to them: cartões de ponto
 * (imports, plus their day_records/punches), turnos de pagamento
 * (payment_shifts — the real rows, not the usual soft `deleted_at`, since
 * there's no colaborador left for a soft-deleted row to still belong to),
 * apelidos, and cliente/empresa links. Cascades done by hand rather than
 * relying on `ON DELETE CASCADE`, same reasoning as `deleteImport` — sqlite
 * only enforces foreign keys when `PRAGMA foreign_keys = ON` was set on the
 * connection, which isn't guaranteed here. Irreversible.
 */
export async function deleteEmployee(employeeId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM punches WHERE day_record_id IN (
       SELECT id FROM day_records WHERE import_id IN (SELECT id FROM imports WHERE employee_id = $1)
     )`,
    [employeeId],
  );
  await db.execute(
    "DELETE FROM day_records WHERE import_id IN (SELECT id FROM imports WHERE employee_id = $1)",
    [employeeId],
  );
  await db.execute("DELETE FROM imports WHERE employee_id = $1", [employeeId]);
  await db.execute("DELETE FROM payment_shifts WHERE employee_id = $1", [employeeId]);
  await db.execute("DELETE FROM employee_aliases WHERE employee_id = $1", [employeeId]);
  await db.execute("DELETE FROM employee_client_companies WHERE employee_id = $1", [employeeId]);
  await db.execute("DELETE FROM employees WHERE id = $1", [employeeId]);
}

/**
 * Opt-in — rewrites the snapshotted `client_id`/`company_id` on every
 * already-imported `payment_shifts`/`imports` row for this colaborador to a
 * given (cliente, empresa) pair, when the user explicitly asks a newly
 * linked pair (`linkEmployeeToClientCompany`) to also apply to already-
 * imported history instead of just future imports. Independent of the
 * link/identity model — this never touches `employees` or
 * `employee_client_companies` itself, only the snapshot 0060/0061 added so
 * that linking a colaborador to a new pair is forward-only by default (a
 * colaborador can be legitimately linked to several pairs at once now, so
 * there's no single "right" cliente/empresa to retroactively force
 * history into — this stays a deliberate, explicit choice).
 *
 * `periodStart`/`periodEnd` mirror ImportPaymentsPage's own "Período
 * (opcional)" filter — each bound independently optional, same convention
 * used everywhere else that filter is read (e.g. `workDate < periodStart`
 * checks around line 854). Both blank reassigns the colaborador's ENTIRE
 * history; either one set scopes it to just what falls in that window —
 * `payment_shifts` by its own `work_date`, `imports` by whether its own
 * `period_start`/`period_end` overlaps the given window at all (an import
 * covers a date range, not a single day, so "contained" would be too
 * strict — any overlap means at least part of it belongs to this
 * reprocessing run).
 */
export async function reassignEmployeeHistoryToClientCompany(
  employeeId: number,
  newClientId: number,
  newCompanyId: number,
  periodStart: string | null,
  periodEnd: string | null,
): Promise<void> {
  const db = await getDb();

  const shiftConditions = ["employee_id = $3"];
  const shiftParams: (string | number)[] = [newClientId, newCompanyId, employeeId];
  if (periodStart) {
    shiftParams.push(periodStart);
    shiftConditions.push(`work_date >= $${shiftParams.length}`);
  }
  if (periodEnd) {
    shiftParams.push(periodEnd);
    shiftConditions.push(`work_date <= $${shiftParams.length}`);
  }
  await db.execute(
    `UPDATE payment_shifts SET client_id = $1, company_id = $2 WHERE ${shiftConditions.join(" AND ")}`,
    shiftParams,
  );

  const importConditions = ["employee_id = $3"];
  const importParams: (string | number)[] = [newClientId, newCompanyId, employeeId];
  if (periodEnd) {
    importParams.push(periodEnd);
    importConditions.push(`period_start <= $${importParams.length}`);
  }
  if (periodStart) {
    importParams.push(periodStart);
    importConditions.push(`period_end >= $${importParams.length}`);
  }
  await db.execute(
    `UPDATE imports SET client_id = $1, company_id = $2 WHERE ${importConditions.join(" AND ")}`,
    importParams,
  );
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
  JOIN companies c ON c.id = i.company_id
  LEFT JOIN clients cl ON cl.id = i.client_id
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
  /** Specific colaboradores picked from the "Colaborador" search-and-select — same `listEmployeesGlobal`-backed filter Pagamentos uses, not a freeform text filter. */
  employeeIds?: number[];
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

  const employeeClause = inClause("e.id", query.employeeIds ?? [], params);
  if (employeeClause) conditions.push(employeeClause);
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
    JOIN companies c ON c.id = i.company_id
    LEFT JOIN clients cl ON cl.id = i.client_id
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
 * came from. Scoped by the import's own `client_id`/`company_id` snapshot
 * (not `employees` — since 0072_employee_client_link.sql a colaborador can
 * be linked to more than one cliente and more than one empresa, so neither
 * picks out "which pair" on its own): the same colaborador can have
 * separate imports per pair — scoping only by cpf would flag a false
 * conflict against a *different* pair's import.
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
    WHERE e.cpf = $1 AND i.client_id = $2 AND i.company_id = $3
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
  /** From the most recent `source_url_check_log` entry for this URL, if any — the actual HTTP check is still one per URL, however many reimport configs it has (see `ReimportConfig.checkDisabled`/`checkIntervalMinutes` for the per-config schedule that decides when that shared check runs). */
  lastCheckedAt: string | null;
  lastResult: UrlCheckResult | null;
  lastErrorMessage: string | null;
  /** The remote signature (etag/lastModified/contentLength) the last deep check (download+parse+diff) ran against — `null` before the first one. Compared against a fresh header check's own signature to decide whether a new deep pass is needed (see `RemoteFileUpdatesContext.runChecks`), independent of `sourceEtag`/etc. above, which only update on an actual saved reimport. */
  lastDeepCheckEtag: string | null;
  lastDeepCheckLastModified: string | null;
  lastDeepCheckContentLength: number | null;
  lastDeepCheckAt: string | null;
  /** What the last deep check actually found for this exact signature — 'changed' only when a real field/new-shift diff turned up, 'unchanged' when it ran clean and found nothing, 'error' when it couldn't finish. This, not the header check, is what a check attempt logs as its `result` (see `RemoteFileUpdatesContext.runChecks`) — a header-only "changed" against an already-deep-checked signature reuses this instead of re-downloading to say the same thing again. */
  lastDeepCheckResult: UrlCheckResult | null;
  /** The `source_url_check_log.id` whose `source_url_check_diffs` rows are the cached ones above — a check that reuses this signature's verdict copies those same diff rows onto its own id (see `copyCheckDiffs`), so its own "Detalhes" is never blank just because the download/parse itself was skipped. */
  lastDeepCheckLogId: number | null;
}

/**
 * Every URL explicitly opted into automatic tracking (`tracking_enabled`,
 * set via the "Rastrear atualizações automaticamente" checkbox at import
 * time — NOT every URL a payment file was ever downloaded from; a URL
 * import with that box left unchecked never shows up here at all), with
 * its shared check state. Per-config schedule/enabled state lives on
 * `ReimportConfig` instead (see `listReimportConfigs`).
 */
export async function listTrackedPaymentUrls(): Promise<TrackedPaymentUrl[]> {
  const db = await getDb();
  return db.select<TrackedPaymentUrl[]>(
    `SELECT
       sf.source_url AS sourceUrl,
       sf.file_name AS fileName,
       sf.provider,
       sf.imported_at AS importedAt,
       sf.source_etag AS sourceEtag,
       sf.source_last_modified AS sourceLastModified,
       sf.source_content_length AS sourceContentLength,
       log.checked_at AS lastCheckedAt,
       log.result AS lastResult,
       log.message AS lastErrorMessage,
       sus.last_deep_check_etag AS lastDeepCheckEtag,
       sus.last_deep_check_last_modified AS lastDeepCheckLastModified,
       sus.last_deep_check_content_length AS lastDeepCheckContentLength,
       sus.last_deep_check_at AS lastDeepCheckAt,
       sus.last_deep_check_result AS lastDeepCheckResult,
       sus.last_deep_check_log_id AS lastDeepCheckLogId
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
     WHERE sf.rn = 1 AND COALESCE(sus.tracking_enabled, 0) = 1
     ORDER BY sf.imported_at DESC`,
  );
}

export type ReimportDateMode = "fixed" | "relative";

export interface ReimportConfig {
  id: number;
  sourceUrl: string;
  /** Empty means "no custom label" — the UI falls back to a generated one (see `resolveReimportConfigLabel` in `lib/format.ts`). */
  label: string;
  templateId: number;
  /** Joined from `payment_templates` — `null` means that template was since deleted. */
  templateName: string | null;
  dateMode: ReimportDateMode;
  /** Used when `dateMode === "fixed"`; `null` means "todo o relatório". */
  periodStart: string | null;
  periodEnd: string | null;
  /** Used when `dateMode === "relative"` — days before today, resolved fresh at use time (see `resolveReimportPeriod`). */
  startOffsetDays: number | null;
  endOffsetDays: number | null;
  /** Whether THIS config currently counts toward "is this URL due for a check" — a URL with several configs still gets one shared HTTP check, but only when at least one non-disabled config asks for it. */
  checkDisabled: boolean;
  /** This config's own check interval, in minutes — mandatory, minimum 1 (see `DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES` for the UI's default when creating a new config). There's no global fallback anymore — every config always has its own value. */
  checkIntervalMinutes: number;
  /** Whether an automatic reimport through THIS config skips a "duplicate" match that was edited manually (Fazer pagamento/Editar valor/Voltar para pendente) instead of superseding it — captured from the checkbox on Importar Pagamentos when the config was created, editable afterward like every other field here. See `findDuplicatePaymentShifts`/`ImportPaymentsPage.handleSave` for where this is actually enforced. */
  keepManualEdits: boolean;
  /** "Atualizar registros automaticamente" — when on, the background check writes a found change straight to `payment_shifts` (via `computeReimportDiff`'s `autoApply` option) instead of only leaving it as a pending diff for manual review on the Pagamentos page. Independent of `keepManualEdits`, which only governs the MANUAL reimport flow in `ImportPaymentsPage`. */
  autoApplyEnabled: boolean;
  /** Only consulted when `autoApplyEnabled` — whether auto-apply is still allowed to overwrite a shift that was hand-edited (`edited_manually`) but not paid. Defaults on: auto-apply is trusted to resync a hand-edited-but-unpaid shift unless explicitly told not to. */
  autoApplyOverwriteManualEdits: boolean;
  /** Only consulted when `autoApplyEnabled` — whether auto-apply is allowed to overwrite a shift that's already `status: 'pago'`. Defaults off: a paid shift's fields are never touched automatically unless explicitly opted in (see `computeReimportDiff`'s existing rule that a paid shift's `status` itself is never diffed either way). */
  autoApplyOverwritePaid: boolean;
  /** When THIS config was last actually evaluated by a check attempt (via `source_url_check_log_configs`) — `null` if never. Drives this config's own due-ness independently of any sibling config sharing the same `sourceUrl`; see `isConfigDue`. */
  lastCheckedAt: string | null;
}

/** Pre-filled in the "Adicionar configuração" form on the Verificação automática page — the user can change it, but a value is always required. */
export const DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES = 5;

/**
 * Every reimport recipe for every tracked URL, loaded all at once (mirrors
 * `listTrackedPaymentUrls`) — grouped by `sourceUrl` by the caller. A URL
 * can have zero, one, or several: each one independently flags its own
 * reimport opportunity when that URL's remote content changes, and each
 * one runs on its own check schedule (see `RemoteFileUpdatesContext`).
 */
export async function listReimportConfigs(): Promise<ReimportConfig[]> {
  const db = await getDb();
  const rawRows = await db.select<
    (Omit<ReimportConfig, "checkDisabled" | "keepManualEdits" | "autoApplyEnabled" | "autoApplyOverwriteManualEdits" | "autoApplyOverwritePaid"> & {
      checkDisabled: number;
      keepManualEdits: number;
      autoApplyEnabled: number;
      autoApplyOverwriteManualEdits: number;
      autoApplyOverwritePaid: number;
    })[]
  >(
    `SELECT
       c.id, c.source_url AS sourceUrl, c.label,
       c.template_id AS templateId, pt.name AS templateName,
       c.date_mode AS dateMode,
       c.period_start AS periodStart, c.period_end AS periodEnd,
       c.start_offset_days AS startOffsetDays, c.end_offset_days AS endOffsetDays,
       c.check_disabled AS checkDisabled, c.check_interval_minutes AS checkIntervalMinutes,
       c.keep_manual_edits AS keepManualEdits,
       c.auto_apply_enabled AS autoApplyEnabled,
       c.auto_apply_overwrite_manual_edits AS autoApplyOverwriteManualEdits,
       c.auto_apply_overwrite_paid AS autoApplyOverwritePaid,
       (SELECT MAX(l.checked_at)
        FROM source_url_check_log_configs jc
        JOIN source_url_check_log l ON l.id = jc.check_log_id
        WHERE jc.config_id = c.id) AS lastCheckedAt
     FROM source_url_reimport_configs c
     LEFT JOIN payment_templates pt ON pt.id = c.template_id
     ORDER BY c.created_at`,
  );
  return rawRows.map((r) => ({
    ...r,
    checkDisabled: Boolean(r.checkDisabled),
    keepManualEdits: Boolean(r.keepManualEdits),
    autoApplyEnabled: Boolean(r.autoApplyEnabled),
    autoApplyOverwriteManualEdits: Boolean(r.autoApplyOverwriteManualEdits),
    autoApplyOverwritePaid: Boolean(r.autoApplyOverwritePaid),
  }));
}

export interface ReimportConfigInput {
  sourceUrl: string;
  label: string;
  templateId: number;
  dateMode: ReimportDateMode;
  periodStart: string | null;
  periodEnd: string | null;
  startOffsetDays: number | null;
  endOffsetDays: number | null;
  checkIntervalMinutes: number;
  keepManualEdits: boolean;
  autoApplyEnabled: boolean;
  autoApplyOverwriteManualEdits: boolean;
  autoApplyOverwritePaid: boolean;
}

export async function createReimportConfig(input: ReimportConfigInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO source_url_reimport_configs
       (source_url, label, template_id, date_mode, period_start, period_end, start_offset_days, end_offset_days,
        check_interval_minutes, keep_manual_edits, auto_apply_enabled, auto_apply_overwrite_manual_edits,
        auto_apply_overwrite_paid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.sourceUrl,
      input.label,
      input.templateId,
      input.dateMode,
      input.periodStart,
      input.periodEnd,
      input.startOffsetDays,
      input.endOffsetDays,
      input.checkIntervalMinutes,
      input.keepManualEdits ? 1 : 0,
      input.autoApplyEnabled ? 1 : 0,
      input.autoApplyOverwriteManualEdits ? 1 : 0,
      input.autoApplyOverwritePaid ? 1 : 0,
    ],
  );
  return result.lastInsertId as number;
}

/** Template is deliberately not editable here — see the Verificação automática page's own comment on why (changing it on an existing config risks silently reinterpreting the column mapping). Delete and recreate instead. */
export async function updateReimportConfig(
  id: number,
  input: Omit<ReimportConfigInput, "sourceUrl" | "templateId">,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE source_url_reimport_configs SET
       label = $2, date_mode = $3, period_start = $4, period_end = $5,
       start_offset_days = $6, end_offset_days = $7, check_interval_minutes = $8,
       keep_manual_edits = $9, auto_apply_enabled = $10, auto_apply_overwrite_manual_edits = $11,
       auto_apply_overwrite_paid = $12, updated_at = datetime('now')
     WHERE id = $1`,
    [
      id,
      input.label,
      input.dateMode,
      input.periodStart,
      input.periodEnd,
      input.startOffsetDays,
      input.endOffsetDays,
      input.checkIntervalMinutes,
      input.keepManualEdits ? 1 : 0,
      input.autoApplyEnabled ? 1 : 0,
      input.autoApplyOverwriteManualEdits ? 1 : 0,
      input.autoApplyOverwritePaid ? 1 : 0,
    ],
  );
}

/** Independent of `updateReimportConfig` — this is an immediate on/off toggle, not part of the edit-then-Salvar draft flow. */
export async function setConfigCheckDisabled(id: number, disabled: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE source_url_reimport_configs SET check_disabled = $2, updated_at = datetime('now') WHERE id = $1",
    [id, disabled ? 1 : 0],
  );
}

export async function deleteReimportConfig(id: number): Promise<void> {
  const db = await getDb();
  // Unlike source_url_check_diffs (which keeps a config_label snapshot for
  // audit even after the config is gone), this table has no audit value on
  // its own — it's pure scheduling bookkeeping (see `isConfigDue`), so once
  // the config no longer exists there's nothing left to compute from it.
  await db.execute("DELETE FROM source_url_check_log_configs WHERE config_id = $1", [id]);
  await db.execute("DELETE FROM source_url_reimport_configs WHERE id = $1", [id]);
}

/**
 * Fully stops tracking a URL — removes its tracking flag, every one of its
 * reimport configs, and its whole check-log history. Deliberately leaves
 * `source_files`/`payment_shifts` untouched: this is "stop watching this
 * URL," not "undo what was ever imported from it."
 */
export async function untrackPaymentUrl(sourceUrl: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM source_url_check_diffs
     WHERE check_log_id IN (SELECT id FROM source_url_check_log WHERE source_url = $1)`,
    [sourceUrl],
  );
  await db.execute(
    `DELETE FROM source_url_check_log_configs
     WHERE check_log_id IN (SELECT id FROM source_url_check_log WHERE source_url = $1)`,
    [sourceUrl],
  );
  await db.execute("DELETE FROM source_url_check_log WHERE source_url = $1", [sourceUrl]);
  await db.execute("DELETE FROM source_url_reimport_configs WHERE source_url = $1", [sourceUrl]);
  await db.execute("DELETE FROM source_url_settings WHERE source_url = $1", [sourceUrl]);
}

/**
 * The one place `tracking_enabled` ever turns on — called from
 * `ImportPaymentsPage.handleSave` only when the user checked "Rastrear
 * atualizações automaticamente" for this save, which also creates that
 * URL's first reimport config (fixed Período, from what was just used,
 * checking enabled with no interval override). Further configs are added
 * by hand on the Verificação automática page (`createReimportConfig`), not
 * through here.
 */
export async function trackUrlForAutoReimport(
  sourceUrl: string,
  templateId: number,
  periodStart: string | null,
  periodEnd: string | null,
  keepManualEdits: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_url_settings (source_url, tracking_enabled, updated_at)
     VALUES ($1, 1, datetime('now'))
     ON CONFLICT(source_url) DO UPDATE SET
       tracking_enabled = 1,
       updated_at = excluded.updated_at`,
    [sourceUrl],
  );
  await createReimportConfig({
    sourceUrl,
    label: "",
    templateId,
    dateMode: "fixed",
    periodStart,
    periodEnd,
    startOffsetDays: null,
    endOffsetDays: null,
    checkIntervalMinutes: DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
    // Auto-apply is an explicit opt-in, turned on later from the
    // Verificação automática page — tracking a URL for the first time never
    // enables unattended writes as a side effect.
    autoApplyEnabled: false,
    autoApplyOverwriteManualEdits: true,
    autoApplyOverwritePaid: false,
    keepManualEdits,
  });
}

const MAX_CHECK_LOG_ENTRIES_PER_URL = 200;

/** A reimport config THIS check attempt actually evaluated, snapshotted at evaluation time — see `logUrlCheckResult`. */
export interface EvaluatedConfigSnapshot {
  id: number;
  templateId: number;
  templateName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/**
 * Records one check attempt and prunes older entries for that URL beyond
 * the last 200, so the log stays bounded regardless of how short the check
 * interval is. `evaluatedConfigs` are the reimport configs THIS attempt
 * actually evaluated (never "every config the URL has" — see
 * `RemoteFileUpdatesContext.runChecks`), recorded in
 * `source_url_check_log_configs` — template/período snapshotted as of this
 * exact evaluation, not read live off `source_url_reimport_configs`, so a
 * later edit or delete of the config never rewrites what a past check
 * actually used — so each config's own due-ness/history is independent of
 * any sibling config sharing the same URL. Returns the inserted row's id, so
 * a deep check that runs right after can link its diffs back to this exact
 * attempt.
 */
export async function logUrlCheckResult(
  sourceUrl: string,
  fileName: string,
  result: UrlCheckResult,
  message: string | null,
  evaluatedConfigs: EvaluatedConfigSnapshot[],
): Promise<number> {
  const db = await getDb();
  const inserted = await db.execute(
    `INSERT INTO source_url_check_log (source_url, file_name, result, message) VALUES ($1, $2, $3, $4)`,
    [sourceUrl, fileName, result, message],
  );
  const checkLogId = inserted.lastInsertId as number;
  for (const config of evaluatedConfigs) {
    await db.execute(
      `INSERT INTO source_url_check_log_configs (check_log_id, config_id, template_id, template_name, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [checkLogId, config.id, config.templateId, config.templateName, config.periodStart, config.periodEnd],
    );
  }
  await db.execute(
    `DELETE FROM source_url_check_diffs
     WHERE check_log_id IN (
       SELECT id FROM source_url_check_log
       WHERE source_url = $1
         AND id NOT IN (SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC LIMIT $2)
     )`,
    [sourceUrl, MAX_CHECK_LOG_ENTRIES_PER_URL],
  );
  await db.execute(
    `DELETE FROM source_url_check_log_configs
     WHERE check_log_id IN (
       SELECT id FROM source_url_check_log
       WHERE source_url = $1
         AND id NOT IN (SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC LIMIT $2)
     )`,
    [sourceUrl, MAX_CHECK_LOG_ENTRIES_PER_URL],
  );
  await db.execute(
    `DELETE FROM source_url_check_log
     WHERE source_url = $1
       AND id NOT IN (
         SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC LIMIT $2
       )`,
    [sourceUrl, MAX_CHECK_LOG_ENTRIES_PER_URL],
  );
  return checkLogId;
}

export interface UrlCheckLogEntry {
  id: number;
  sourceUrl: string;
  fileName: string;
  checkedAt: string;
  result: UrlCheckResult;
  message: string | null;
  /** How many `source_url_check_diffs` rows this check produced FOR THE CONFIG THIS ROW WAS FETCHED FOR — not the check's combined total (see `listUrlCheckLogForConfig`). Drives the "N alterações" hint on that config's history bar without fetching every row's diffs up front. */
  diffCount: number;
  /** Whether any of THIS config's own diff rows on this check is a `change_kind: 'error'` — this config's own processing failed on this check, distinct from a real field/new-shift change and from a sibling config's own error (see `listUrlCheckLogForConfig`). */
  hasOwnError: boolean;
  /** Snapshot of the template/período this config actually used on THIS check attempt (see `source_url_check_log_configs`) — the live config can be edited or deleted afterward, so these stay meaningful even when `ReimportConfig.templateId`/período have since changed. `null` for a check logged before migration 0064. */
  templateId: number | null;
  templateName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** The `source_url_check_diffs.id` of this check's `change_kind: 'error'` row relevant to this config — this config's own error if it has one, otherwise the shared whole-URL error (`config_id IS NULL`) every config evaluated on that same attempt points at. `null` when this check found no error for this config at all (nothing to dismiss). See `dismissCheckDiffs`. */
  errorDiffId: number | null;
  /** "Visto" — when that error row was acknowledged, `null` until then. Dismissing it here also clears it everywhere else that same row is read (e.g. the pending-updates banner), since it's the exact same row, not a copy. */
  errorDismissedAt: string | null;
}

/**
 * Most recent check-log entries this reimport config was actually evaluated
 * in (via `source_url_check_log_configs`) — the "Histórico recente" strip's
 * data source. Independent of any sibling config sharing the same
 * `sourceUrl`: a check attempt that only evaluated OTHER configs (because
 * this one wasn't due yet) never shows up here, and `diffCount`/
 * `hasOwnError` are scoped to this config's own diff rows on that check, not
 * the shared HTTP check's combined outcome.
 */
export async function listUrlCheckLogForConfig(
  configId: number,
  limit: number,
  offset: number = 0,
): Promise<UrlCheckLogEntry[]> {
  const db = await getDb();
  const rawRows = await db.select<(Omit<UrlCheckLogEntry, "hasOwnError"> & { hasOwnError: number })[]>(
    `SELECT l.id, l.source_url AS sourceUrl, l.file_name AS fileName, l.checked_at AS checkedAt, l.result, l.message,
            jc.template_id AS templateId, jc.template_name AS templateName,
            jc.period_start AS periodStart, jc.period_end AS periodEnd,
            (SELECT COUNT(*) FROM source_url_check_diffs d WHERE d.check_log_id = l.id AND d.config_id = $1) AS diffCount,
            (SELECT MAX(CASE WHEN d.change_kind = 'error' THEN 1 ELSE 0 END)
             FROM source_url_check_diffs d WHERE d.check_log_id = l.id AND d.config_id = $1) AS hasOwnError,
            (SELECT d.id FROM source_url_check_diffs d
             WHERE d.check_log_id = l.id AND d.change_kind = 'error' AND (d.config_id = $1 OR d.config_id IS NULL)
             ORDER BY (d.config_id IS NULL) ASC LIMIT 1) AS errorDiffId,
            (SELECT d.dismissed_at FROM source_url_check_diffs d
             WHERE d.check_log_id = l.id AND d.change_kind = 'error' AND (d.config_id = $1 OR d.config_id IS NULL)
             ORDER BY (d.config_id IS NULL) ASC LIMIT 1) AS errorDismissedAt
     FROM source_url_check_log l
     JOIN source_url_check_log_configs jc ON jc.check_log_id = l.id AND jc.config_id = $1
     ORDER BY l.checked_at DESC
     LIMIT $2 OFFSET $3`,
    [configId, limit, offset],
  );
  return rawRows.map((r) => ({ ...r, hasOwnError: Boolean(r.hasOwnError) }));
}

/** Config ids a given check attempt actually evaluated — used to decide whether a cached deep-check verdict can be reused for a NEW set of configs (only safe when every one of them was already covered by that same attempt), see `RemoteFileUpdatesContext.runChecks`. */
export async function listCheckLogConfigIds(checkLogId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ configId: number }[]>(
    `SELECT config_id AS configId FROM source_url_check_log_configs WHERE check_log_id = $1`,
    [checkLogId],
  );
  return rows.map((r) => r.configId);
}

export type CheckDiffKind = "field" | "new-shift" | "unresolved" | "error" | "removed";

export interface CheckDiffRow {
  id: number;
  checkLogId: number;
  configId: number | null;
  configLabel: string;
  changeKind: CheckDiffKind;
  matchedShiftId: number | null;
  employeeId: number | null;
  employeeName: string | null;
  workDate: string | null;
  local: string | null;
  role: string | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  sheetName: string | null;
  rowNumber: number | null;
  columnLetter: string | null;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  message: string | null;
  /** Whether this diff was already written to `payment_shifts` — by unattended auto-apply, or a manual "Aceitar" (see `computeReimportDiff`'s `AutoApplyOptions`) — vs. still pending review. Only ever `true` for `changeKind: 'field' | 'removed'`, the only kinds a write ever applies to. */
  applied: boolean;
  /** "Visto" — when this row was acknowledged, `null` until then. Content-based (see `dismissCheckDiffs`/`dismissed_diff_fingerprints`): dismissing THIS row also registers its content fingerprint, so a LATER check whose new row has the exact same content (same config, kind, identity, value/message — nothing actually changed) arrives already dismissed. A row with even one different field is a genuinely new problem and starts undismissed. */
  dismissedAt: string | null;
  /** The período THIS config actually used on the check that produced this row — joined from `source_url_check_log_configs` (migration 0064), not read live off the config (which may have since changed, especially a "relative to today" one). `null` for a whole-URL row (`configId IS NULL`, no single config to attribute a período to) or a check logged before migration 0064. Drives "Reprocessar agora" replaying the SAME período that failed, not today's. */
  periodStart: string | null;
  periodEnd: string | null;
}

export type CheckDiffInput = Omit<CheckDiffRow, "id" | "checkLogId" | "dismissedAt" | "periodStart" | "periodEnd">;

type CheckDiffRowRaw = Omit<CheckDiffRow, "applied"> & { applied: number };

function parseCheckDiffRow(r: CheckDiffRowRaw): CheckDiffRow {
  return { ...r, applied: Boolean(r.applied) };
}

// U+001F, a control character no real field/message text will ever contain
// — safe as a delimiter joining fingerprint fields without ambiguity.
const FINGERPRINT_SEP = "\x1f";

/** Deterministic content signature for a diff — anything that would make two occurrences look meaningfully different to the user, and nothing else (not `id`/`checkLogId`/`createdAt`/`applied`/`configLabel`, which can shift without the underlying problem changing at all). Same shape (field order/coalescing) as the SQL expression `copyCheckDiffs` builds inline — the two MUST stay identical or lookups silently stop matching. */
function diffContentFingerprint(e: {
  changeKind: CheckDiffKind;
  configId: number | null;
  employeeId: number | null;
  employeeName: string | null;
  workDate: string | null;
  local: string | null;
  role: string | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  sheetName: string | null;
  rowNumber: number | null;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  message: string | null;
}): string {
  return [
    e.changeKind,
    e.configId,
    e.employeeId,
    e.employeeName,
    e.workDate,
    e.local,
    e.role,
    e.scheduleStartMinutes,
    e.scheduleEndMinutes,
    e.sheetName,
    e.rowNumber,
    e.fieldName,
    e.oldValue,
    e.newValue,
    e.message,
  ]
    .map((v) => (v === null || v === undefined ? "" : String(v)))
    .join(FINGERPRINT_SEP);
}

/** Same field order as `diffContentFingerprint`, as a SQL expression over `source_url_check_diffs` columns (aliased/unaliased via `prefix`, e.g. `"d."`) — lets `copyCheckDiffs` check fingerprint matches in one bulk `INSERT ... SELECT` instead of a per-row round trip. */
function fingerprintSqlExpr(prefix: string): string {
  const cols = [
    "change_kind",
    "config_id",
    "employee_id",
    "employee_name",
    "work_date",
    "local",
    "role",
    "schedule_start_minutes",
    "schedule_end_minutes",
    "sheet_name",
    "row_number",
    "field_name",
    "old_value",
    "new_value",
    "message",
  ];
  return cols.map((c) => `COALESCE(${prefix}${c}, '')`).join(` || char(31) || `);
}

/** Bulk-inserts the deep-check diff for one check attempt — see `computeReimportDiff` (`remoteCheckDiff.ts`) for how these are produced. `sourceUrl` scopes the "Visto" fingerprint lookup (see `diffContentFingerprint`): a new row whose content exactly matches one already dismissed for this URL is inserted already dismissed, so re-alerting only happens when something actually changed. */
export async function saveCheckDiffs(checkLogId: number, sourceUrl: string, entries: CheckDiffInput[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  for (const e of entries) {
    const fingerprint = diffContentFingerprint(e);
    const dismissedMatch = await db.select<{ id: number }[]>(
      `SELECT id FROM dismissed_diff_fingerprints WHERE source_url = $1 AND fingerprint = $2 LIMIT 1`,
      [sourceUrl, fingerprint],
    );
    const inserted = await db.execute(
      `INSERT INTO source_url_check_diffs
         (check_log_id, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
          work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
          column_letter, field_name, old_value, new_value, message, applied)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        checkLogId,
        e.configId,
        e.configLabel,
        e.changeKind,
        e.matchedShiftId,
        e.employeeId,
        e.employeeName,
        e.workDate,
        e.local,
        e.role,
        e.scheduleStartMinutes,
        e.scheduleEndMinutes,
        e.sheetName,
        e.rowNumber,
        e.columnLetter,
        e.fieldName,
        e.oldValue,
        e.newValue,
        e.message,
        e.applied ? 1 : 0,
      ],
    );
    if (dismissedMatch.length > 0) {
      await db.execute(`UPDATE source_url_check_diffs SET dismissed_at = datetime('now') WHERE id = $1`, [
        inserted.lastInsertId,
      ]);
    }
  }
}

/** Lazily fetched when a check-log row is expanded in the UI — most rows have none. */
export async function listCheckDiffs(checkLogId: number): Promise<CheckDiffRow[]> {
  const db = await getDb();
  const rows = await db.select<CheckDiffRowRaw[]>(
    `SELECT d.id, d.check_log_id AS checkLogId, d.config_id AS configId, d.config_label AS configLabel,
            d.change_kind AS changeKind, d.matched_shift_id AS matchedShiftId, d.employee_id AS employeeId,
            d.employee_name AS employeeName, d.work_date AS workDate, d.local, d.role,
            d.schedule_start_minutes AS scheduleStartMinutes, d.schedule_end_minutes AS scheduleEndMinutes,
            d.sheet_name AS sheetName, d.row_number AS rowNumber, d.column_letter AS columnLetter,
            d.field_name AS fieldName, d.old_value AS oldValue, d.new_value AS newValue, d.message, d.applied,
            d.dismissed_at AS dismissedAt, jc.period_start AS periodStart, jc.period_end AS periodEnd
     FROM source_url_check_diffs d
     LEFT JOIN source_url_check_log_configs jc ON jc.check_log_id = d.check_log_id AND jc.config_id = d.config_id
     WHERE d.check_log_id = $1
     ORDER BY d.id`,
    [checkLogId],
  );
  return rows.map(parseCheckDiffRow);
}

export interface CheckLogConfigDiffCount {
  checkLogId: number;
  /** `null` for a diff not tied to any one reimport config (e.g. a whole-URL failure) — see `CheckDiffRow.configId`. */
  configId: number | null;
  configLabel: string;
  diffCount: number;
  /** Whether any of this (check, config) pair's diff rows is a `change_kind: 'error'` — this config's own processing failed on this check, distinct from a real field/new-shift change. Used to color a per-config history bar red without fetching every row up front. */
  hasError: boolean;
}

/**
 * Per-(check, config) diff counts for a batch of check-log ids — one check
 * covers every active reimport config for a URL at once (see
 * `RemoteFileUpdatesContext.runChecks`), but the Verificação automática
 * page shows one history ROW per config regardless (never merging several
 * configs' template/período/detalhes into a single combined row — a
 * mismatch found there needs to point at exactly one template, unambiguously),
 * so it needs each config's own count instead of just the total.
 */
export async function listCheckDiffCountsByLogIds(checkLogIds: number[]): Promise<CheckLogConfigDiffCount[]> {
  if (checkLogIds.length === 0) return [];
  const db = await getDb();
  const placeholders = checkLogIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<(Omit<CheckLogConfigDiffCount, "hasError"> & { hasError: number })[]>(
    `SELECT check_log_id AS checkLogId, config_id AS configId, config_label AS configLabel, COUNT(*) AS diffCount,
            MAX(CASE WHEN change_kind = 'error' THEN 1 ELSE 0 END) AS hasError
     FROM source_url_check_diffs
     WHERE check_log_id IN (${placeholders})
     GROUP BY check_log_id, config_id, config_label`,
    checkLogIds,
  );
  return rows.map((r) => ({ ...r, hasError: Boolean(r.hasError) }));
}

export interface ShiftFieldDiffRow {
  shiftId: number;
  checkLogId: number;
  checkedAt: string;
  /** Which reimport config found this — needed by the "Aceitar" action (Pagamentos) to know which config's URL/template to re-download and apply against. `null` for a diff not tied to any one config. */
  configId: number | null;
  configLabel: string;
  /** 'field' — this shift's own field changed in the source; 'removed' — this shift's record wasn't found at all in the latest read of the source (see `computeReimportDiff`'s `change_kind: 'removed'`). Never any other kind — those don't carry a `matchedShiftId`. */
  changeKind: "field" | "removed";
  fieldName: string | null;
  columnLetter: string | null;
  oldValue: string | null;
  newValue: string | null;
  /** Only ever set for `changeKind: 'removed'` — the "não encontrado.../excluído automaticamente" explanation shown in the review Drawer. */
  message: string | null;
  /** Already written to `payment_shifts` (unattended auto-apply) vs. still pending review/accept — see `CheckDiffRow.applied`. */
  applied: boolean;
}

type ShiftFieldDiffRowRaw = Omit<ShiftFieldDiffRow, "applied"> & { applied: number };

/**
 * For each given `payment_shifts.id`, what the automatic background
 * verification most recently found for it — a field that changed, or the
 * whole record missing from the file entirely (see `computeReimportDiff`) —
 * scoped to each row's own source URL's LATEST check (`l.id = MAX(...)` per
 * `source_url`), so a change that was later reimported/edited away, or
 * superseded by a newer check that found the file back in sync, doesn't
 * linger here forever. Used by `PaymentsPage` to flag a row/column the last
 * automatic check found different, without re-checking anything itself.
 */
export async function listLatestFieldDiffsForShifts(shiftIds: number[]): Promise<ShiftFieldDiffRow[]> {
  if (shiftIds.length === 0) return [];
  const db = await getDb();
  const placeholders = shiftIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<ShiftFieldDiffRowRaw[]>(
    `SELECT d.matched_shift_id AS shiftId, d.check_log_id AS checkLogId, l.checked_at AS checkedAt,
            d.config_id AS configId, d.config_label AS configLabel, d.change_kind AS changeKind,
            d.field_name AS fieldName, d.column_letter AS columnLetter, d.old_value AS oldValue,
            d.new_value AS newValue, d.message, d.applied
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
     WHERE d.change_kind IN ('field', 'removed')
       AND d.matched_shift_id IN (${placeholders})
       AND l.id = (SELECT MAX(l2.id) FROM source_url_check_log l2 WHERE l2.source_url = l.source_url)
     ORDER BY d.matched_shift_id, d.id`,
    shiftIds,
  );
  return rows.map((r) => ({ ...r, applied: Boolean(r.applied) }));
}

/**
 * Same "latest check per source_url" scoping as `listLatestFieldDiffsForShifts`,
 * but for EVERY shift in the system (not a specific set) AND every
 * `change_kind` (not just `'field'`/`'removed'`) — feeds the global
 * "bolinha" indicator (`PendingChangesBall`), which is meant to surface
 * ANYTHING the last check found (a changed field, a possible new turno, a
 * possible removal, an unresolved row, a whole-config/URL error), not just
 * the subset that can paint an existing Pagamentos row. That narrower
 * subset is exactly what `listLatestFieldDiffsForShifts` is for — this is
 * the unfiltered version. Includes rows already acknowledged via "Visto"
 * (`dismissed_at`, see `dismissCheckDiffs`) — dismissing never removes a
 * row from this list, it only stops that row from counting toward
 * callers' own "unseen" tallies (each caller filters `dismissedAt === null`
 * itself; see `PendingChangesTab`), so the full history stays browsable.
 */
export async function listAllLatestShiftDiffs(): Promise<CheckDiffRow[]> {
  const db = await getDb();
  const rows = await db.select<CheckDiffRowRaw[]>(
    `SELECT d.id, d.check_log_id AS checkLogId, d.config_id AS configId, d.config_label AS configLabel,
            d.change_kind AS changeKind, d.matched_shift_id AS matchedShiftId, d.employee_id AS employeeId,
            d.employee_name AS employeeName, d.work_date AS workDate, d.local, d.role,
            d.schedule_start_minutes AS scheduleStartMinutes, d.schedule_end_minutes AS scheduleEndMinutes,
            d.sheet_name AS sheetName, d.row_number AS rowNumber, d.column_letter AS columnLetter,
            d.field_name AS fieldName, d.old_value AS oldValue, d.new_value AS newValue, d.message, d.applied,
            d.dismissed_at AS dismissedAt, jc.period_start AS periodStart, jc.period_end AS periodEnd
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
     LEFT JOIN source_url_check_log_configs jc ON jc.check_log_id = d.check_log_id AND jc.config_id = d.config_id
     WHERE l.id = (SELECT MAX(l2.id) FROM source_url_check_log l2 WHERE l2.source_url = l.source_url)
     ORDER BY d.id DESC`,
  );
  return rows.map(parseCheckDiffRow);
}

/**
 * "Visto" — acknowledges specific diff rows without resolving anything or
 * removing them: they stay visible everywhere they're listed (the pending
 * banner, the config's "Histórico completo"), just marked seen, and stop
 * counting toward each screen's own "unseen" badge/alert. Content-based, not
 * just these literal rows: also registers each row's content fingerprint
 * (`dismissed_diff_fingerprints`, scoped to that row's `source_url`), so a
 * LATER check whose new row has the exact identical content — same config,
 * kind, identity, value/message, nothing actually changed — is inserted
 * already dismissed (see `saveCheckDiffs`/`copyCheckDiffs`) instead of
 * re-alerting. The moment even one field differs, it's a genuinely new
 * problem and starts undismissed.
 */
export async function dismissCheckDiffs(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  await db.execute(`UPDATE source_url_check_diffs SET dismissed_at = datetime('now') WHERE id IN (${placeholders})`, ids);

  const rows = await db.select<
    {
      sourceUrl: string;
      changeKind: CheckDiffKind;
      configId: number | null;
      employeeId: number | null;
      employeeName: string | null;
      workDate: string | null;
      local: string | null;
      role: string | null;
      scheduleStartMinutes: number | null;
      scheduleEndMinutes: number | null;
      sheetName: string | null;
      rowNumber: number | null;
      fieldName: string | null;
      oldValue: string | null;
      newValue: string | null;
      message: string | null;
    }[]
  >(
    `SELECT l.source_url AS sourceUrl, d.change_kind AS changeKind, d.config_id AS configId,
            d.employee_id AS employeeId, d.employee_name AS employeeName, d.work_date AS workDate,
            d.local, d.role, d.schedule_start_minutes AS scheduleStartMinutes,
            d.schedule_end_minutes AS scheduleEndMinutes, d.sheet_name AS sheetName, d.row_number AS rowNumber,
            d.field_name AS fieldName, d.old_value AS oldValue, d.new_value AS newValue, d.message
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
     WHERE d.id IN (${placeholders})`,
    ids,
  );
  for (const r of rows) {
    const fingerprint = diffContentFingerprint(r);
    const existing = await db.select<{ id: number }[]>(
      `SELECT id FROM dismissed_diff_fingerprints WHERE source_url = $1 AND fingerprint = $2 LIMIT 1`,
      [r.sourceUrl, fingerprint],
    );
    if (existing.length === 0) {
      await db.execute(`INSERT INTO dismissed_diff_fingerprints (source_url, fingerprint) VALUES ($1, $2)`, [
        r.sourceUrl,
        fingerprint,
      ]);
    }
  }
}

/** Records the remote signature a deep check (download+parse+diff) just ran against, and what it actually found (`result`) — so `RemoteFileUpdatesContext.runChecks` doesn't repeat that work every tick while the user hasn't reimported yet, and a later "changed"-per-header check against the same signature can log the SAME diff-driven verdict instead of re-asserting the raw header result. */
export async function markDeepCheckSignature(
  sourceUrl: string,
  etag: string | null,
  lastModified: string | null,
  contentLength: number | null,
  result: UrlCheckResult,
  checkLogId: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE source_url_settings
     SET last_deep_check_etag = $2, last_deep_check_last_modified = $3, last_deep_check_content_length = $4,
         last_deep_check_result = $5, last_deep_check_log_id = $6, last_deep_check_at = datetime('now')
     WHERE source_url = $1`,
    [sourceUrl, etag, lastModified, contentLength, result, checkLogId],
  );
}

/**
 * Copies one check's diff rows onto another check_log_id, verbatim — used
 * when a check reuses an already-known deep-check verdict for the same
 * remote signature (see `RemoteFileUpdatesContext.runChecks`) instead of
 * re-downloading/re-parsing just to arrive at the same rows again. Every
 * check attempt's history is meant to show what it found, even when what it
 * found is "the same thing as last time" — this is how a cached "Mudou"
 * still gets its own expandable diff detail instead of a blank "—". Same
 * "Visto" fingerprint check as `saveCheckDiffs` (done inline, in SQL, since
 * this is a single bulk copy rather than one entry at a time) — a copied row
 * whose content matches something already dismissed for `sourceUrl` arrives
 * already dismissed too.
 */
export async function copyCheckDiffs(fromCheckLogId: number, toCheckLogId: number, sourceUrl: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO source_url_check_diffs
       (check_log_id, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
        work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
        column_letter, field_name, old_value, new_value, message, applied, dismissed_at)
     SELECT $2, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
            work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
            column_letter, field_name, old_value, new_value, message, applied,
            CASE WHEN EXISTS (
              SELECT 1 FROM dismissed_diff_fingerprints f
              WHERE f.source_url = $3 AND f.fingerprint = ${fingerprintSqlExpr("")}
            ) THEN datetime('now') ELSE NULL END
     FROM source_url_check_diffs
     WHERE check_log_id = $1`,
    [fromCheckLogId, toCheckLogId, sourceUrl],
  );
}

/** Batched lookup for the deep-check diff pass — one query for every matched shift's current values instead of N calls to `getPaymentShift`. */
export async function getPaymentShiftsByIds(ids: number[]): Promise<PaymentShiftRow[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<PaymentShiftRowRaw[]>(
    `SELECT ${PAYMENT_SHIFT_SELECT_COLUMNS} ${PAYMENT_SHIFT_FROM_CLAUSE} WHERE ps.id IN (${placeholders})`,
    ids,
  );
  return rows.map(parsePaymentShiftRow);
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

/** `accepted_file_kinds_json` is `NULL` for every template predating that column — falls back to a single-element list of just its own `fileKind`, the exact behavior before it existed. */
function parseAcceptedFileKinds(fileKind: PaymentFileKind, json: string | null): PaymentFileKind[] {
  return json ? JSON.parse(json) : [fileKind];
}

export async function listPaymentTemplates(): Promise<PaymentTemplateListRow[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<PaymentTemplateListRow, "acceptedFileKinds"> & { acceptedFileKindsJson: string | null })[]>(`
    SELECT pt.id, pt.name, pt.file_kind AS fileKind, pt.accepted_file_kinds_json AS acceptedFileKindsJson, pt.updated_at AS updatedAt
    FROM payment_templates pt
    ORDER BY pt.updated_at DESC
  `);
  return rows.map(({ acceptedFileKindsJson, ...r }) => ({
    ...r,
    acceptedFileKinds: parseAcceptedFileKinds(r.fileKind, acceptedFileKindsJson),
  }));
}

export async function getPaymentTemplate(id: number): Promise<PaymentTemplateRow> {
  const db = await getDb();
  const rows = await db.select<
    (Omit<PaymentTemplateRow, "groups" | "rules" | "identifierPriority" | "acceptedFileKinds"> & {
      identifierPriority: string;
      acceptedFileKindsJson: string | null;
    })[]
  >(
    `SELECT pt.id, pt.name, pt.file_kind AS fileKind, pt.accepted_file_kinds_json AS acceptedFileKindsJson, pt.delimiter,
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
    const sheetRows = await db.select<{ sheetName: string; included: number }[]>(
      `SELECT sheet_name AS sheetName, included
       FROM payment_template_sheets
       WHERE group_id = $1
       ORDER BY sheet_name`,
      [g.id],
    );
    const fieldMappings = await db.select<PaymentTemplateFieldMapping[]>(
      `SELECT column_letter AS columnLetter, target_field AS targetField, header_label AS headerLabel
       FROM payment_template_fields
       WHERE group_id = $1
       ORDER BY column_letter`,
      [g.id],
    );
    groups.push({
      sheetNames: sheetRows.filter((r) => r.included).map((r) => r.sheetName),
      excludedSheetNames: sheetRows.filter((r) => !r.included).map((r) => r.sheetName),
      fieldMappings,
    });
  }

  const ruleRows = await db.select<
    {
      kind: PaymentTemplateRuleKind;
      field: PaymentRuleField | null;
      valuesJson: string | null;
      caseInsensitive: number;
      conditionsJson: string | null;
      companyId: number;
      companyName: string;
      clientId: number;
      clientName: string;
    }[]
  >(
    `SELECT r.kind, r.field, r.values_json AS valuesJson, r.case_insensitive AS caseInsensitive,
            r.conditions_json AS conditionsJson,
            r.company_id AS companyId, c.name AS companyName,
            r.client_id AS clientId, cl.name AS clientName
     FROM payment_template_rules r
     JOIN companies c ON c.id = r.company_id
     JOIN clients cl ON cl.id = r.client_id
     WHERE r.template_id = $1
     ORDER BY r.id`,
    [id],
  );
  const rules: PaymentTemplateRule[] = ruleRows.map((r) => {
    const { field, valuesJson, caseInsensitive, conditionsJson, ...rest } = r;
    return {
      ...rest,
      conditions: conditionsJson
        ? (JSON.parse(conditionsJson) as PaymentRuleCondition[])
        : field
          ? [{ field, values: valuesJson ? JSON.parse(valuesJson) : [], caseInsensitive: Boolean(caseInsensitive) }]
          : [],
    };
  });

  const statusRuleRows = await db.select<
    {
      kind: PaymentTemplateRuleKind;
      field: PaymentRuleField | null;
      valuesJson: string | null;
      caseInsensitive: number;
      conditionsJson: string | null;
      status: PaymentShiftStatus;
    }[]
  >(
    `SELECT kind, field, values_json AS valuesJson, case_insensitive AS caseInsensitive,
            conditions_json AS conditionsJson, status
     FROM payment_template_status_rules
     WHERE template_id = $1
     ORDER BY id`,
    [id],
  );
  const statusRules: PaymentStatusRule[] = statusRuleRows.map((r) => {
    const { field, valuesJson, caseInsensitive, conditionsJson, ...rest } = r;
    return {
      ...rest,
      conditions: conditionsJson
        ? (JSON.parse(conditionsJson) as PaymentRuleCondition[])
        : field
          ? [{ field, values: valuesJson ? JSON.parse(valuesJson) : [], caseInsensitive: Boolean(caseInsensitive) }]
          : [],
    };
  });

  const { acceptedFileKindsJson, ...row } = rows[0];
  return {
    ...row,
    identifierPriority: JSON.parse(rows[0].identifierPriority) as IdentifierAttempt[],
    acceptedFileKinds: parseAcceptedFileKinds(row.fileKind, acceptedFileKindsJson),
    groups,
    rules,
    statusRules,
  };
}

export interface PaymentTemplateRuleInput {
  kind: PaymentTemplateRuleKind;
  /** Empty when `kind === "else"`. */
  conditions: PaymentRuleCondition[];
  companyId: number;
  clientId: number;
}

export interface PaymentTemplateStatusRuleInput {
  kind: PaymentTemplateRuleKind;
  /** Empty when `kind === "else"`. */
  conditions: PaymentRuleCondition[];
  status: PaymentShiftStatus;
}

export interface PaymentTemplateInput {
  name: string;
  fileKind: PaymentFileKind;
  acceptedFileKinds: PaymentFileKind[];
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
        "INSERT INTO payment_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 1)",
        [groupId, sheetName],
      );
    }
    for (const sheetName of group.excludedSheetNames) {
      await db.execute(
        "INSERT INTO payment_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 0)",
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
         (template_id, kind, conditions_json, company_id, client_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        templateId,
        rule.kind,
        rule.kind === "condition" ? JSON.stringify(rule.conditions) : null,
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
         (template_id, kind, conditions_json, status)
       VALUES ($1, $2, $3, $4)`,
      [
        templateId,
        rule.kind,
        rule.kind === "condition" ? JSON.stringify(rule.conditions) : null,
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
    `INSERT INTO payment_templates (name, file_kind, accepted_file_kinds_json, delimiter, date_format, identifier_priority)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.name,
      input.fileKind,
      JSON.stringify(input.acceptedFileKinds),
      input.delimiter,
      input.dateFormat,
      JSON.stringify(input.identifierPriority),
    ],
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
       name = $1, file_kind = $2, accepted_file_kinds_json = $3, delimiter = $4, date_format = $5,
       identifier_priority = $6, updated_at = datetime('now')
     WHERE id = $7`,
    [
      input.name,
      input.fileKind,
      JSON.stringify(input.acceptedFileKinds),
      input.delimiter,
      input.dateFormat,
      JSON.stringify(input.identifierPriority),
      id,
    ],
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

export async function listPaymentExportTemplates(): Promise<PaymentExportTemplateListRow[]> {
  const db = await getDb();
  return db.select<PaymentExportTemplateListRow[]>(
    "SELECT id, name, updated_at AS updatedAt FROM payment_export_templates ORDER BY updated_at DESC",
  );
}

export async function getPaymentExportTemplate(id: number): Promise<PaymentExportTemplateRow> {
  const db = await getDb();
  const rows = await db.select<
    (Omit<PaymentExportTemplateRow, "config"> & { configJson: string })[]
  >(
    "SELECT id, name, config_json AS configJson, created_at AS createdAt, updated_at AS updatedAt FROM payment_export_templates WHERE id = $1",
    [id],
  );
  if (rows.length === 0) throw new Error("Template de exportação não encontrado.");
  const { configJson, ...rest } = rows[0];
  return { ...rest, config: JSON.parse(configJson) as PaymentExportTemplateConfig };
}

export async function createPaymentExportTemplate(input: PaymentExportTemplateInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute("INSERT INTO payment_export_templates (name, config_json) VALUES ($1, $2)", [
    input.name,
    JSON.stringify(input.config),
  ]);
  return result.lastInsertId as number;
}

export async function updatePaymentExportTemplate(id: number, input: PaymentExportTemplateInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE payment_export_templates SET name = $1, config_json = $2, updated_at = datetime('now') WHERE id = $3",
    [input.name, JSON.stringify(input.config), id],
  );
}

export async function deletePaymentExportTemplate(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM payment_export_templates WHERE id = $1", [id]);
}

export async function listEmployeeTemplates(): Promise<EmployeeTemplateListRow[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<EmployeeTemplateListRow, "acceptedFileKinds"> & { acceptedFileKindsJson: string | null })[]>(`
    SELECT et.id, et.name, et.file_kind AS fileKind, et.accepted_file_kinds_json AS acceptedFileKindsJson, et.updated_at AS updatedAt
    FROM employee_templates et
    ORDER BY et.updated_at DESC
  `);
  return rows.map(({ acceptedFileKindsJson, ...r }) => ({
    ...r,
    acceptedFileKinds: parseAcceptedFileKinds(r.fileKind, acceptedFileKindsJson),
  }));
}

export async function getEmployeeTemplate(id: number): Promise<EmployeeTemplateRow> {
  const db = await getDb();
  const rows = await db.select<
    (Omit<EmployeeTemplateRow, "groups" | "identifierPriority" | "acceptedFileKinds"> & {
      identifierPriority: string;
      acceptedFileKindsJson: string | null;
    })[]
  >(
    `SELECT et.id, et.name, et.file_kind AS fileKind, et.accepted_file_kinds_json AS acceptedFileKindsJson, et.delimiter,
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
    const sheetRows = await db.select<{ sheetName: string; included: number }[]>(
      `SELECT sheet_name AS sheetName, included
       FROM employee_template_sheets
       WHERE group_id = $1
       ORDER BY sheet_name`,
      [g.id],
    );
    const fieldMappings = await db.select<EmployeeTemplateFieldMapping[]>(
      `SELECT column_letter AS columnLetter, target_field AS targetField, header_label AS headerLabel
       FROM employee_template_fields
       WHERE group_id = $1
       ORDER BY column_letter`,
      [g.id],
    );
    groups.push({
      sheetNames: sheetRows.filter((r) => r.included).map((r) => r.sheetName),
      excludedSheetNames: sheetRows.filter((r) => !r.included).map((r) => r.sheetName),
      fieldMappings,
      headerRow: g.headerRow,
    });
  }

  const { acceptedFileKindsJson, ...row } = rows[0];
  return {
    ...row,
    identifierPriority: JSON.parse(rows[0].identifierPriority) as IdentifierAttempt[],
    acceptedFileKinds: parseAcceptedFileKinds(row.fileKind, acceptedFileKindsJson),
    groups,
  };
}

export interface EmployeeTemplateInput {
  name: string;
  fileKind: PaymentFileKind;
  acceptedFileKinds: PaymentFileKind[];
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
        "INSERT INTO employee_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 1)",
        [groupId, sheetName],
      );
    }
    for (const sheetName of group.excludedSheetNames) {
      await db.execute(
        "INSERT INTO employee_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 0)",
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
    `INSERT INTO employee_templates (name, file_kind, accepted_file_kinds_json, delimiter, identifier_priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.name,
      input.fileKind,
      JSON.stringify(input.acceptedFileKinds),
      input.delimiter,
      JSON.stringify(input.identifierPriority),
    ],
  );
  const templateId = result.lastInsertId as number;
  await insertEmployeeTemplateGroups(db, templateId, input.groups);
  return templateId;
}

export async function updateEmployeeTemplate(id: number, input: EmployeeTemplateInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE employee_templates SET
       name = $1, file_kind = $2, accepted_file_kinds_json = $3, delimiter = $4,
       identifier_priority = $5, updated_at = datetime('now')
     WHERE id = $6`,
    [
      input.name,
      input.fileKind,
      JSON.stringify(input.acceptedFileKinds),
      input.delimiter,
      JSON.stringify(input.identifierPriority),
      id,
    ],
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
 * Upsert, not a plain bulk insert — a row here can now match an
 * already-registered colaborador under a *different* cliente and/or empresa
 * (the whole point of 0071/0072_employee_*_link.sql), in which case this
 * links the (clientId, companyId) pair to that existing colaborador instead
 * of creating a duplicate person. ImportEmployeesPage is expected to have
 * already surfaced that distinction to the user (new colaborador vs.
 * "vincular a este cliente/empresa") before calling this — see
 * `findEmployeeAnywhereByAttempts`.
 */
export async function createEmployeesFromImport(rows: EmployeeImportRow[]): Promise<void> {
  const db = await getDb();
  for (const row of rows) {
    const normalizedCpf = normalizeCpf(row.cpf);
    const existing = await db.select<{ id: number }[]>("SELECT id FROM employees WHERE cpf = $1", [normalizedCpf]);
    let employeeId: number;
    if (existing.length > 0) {
      employeeId = existing[0].id;
    } else {
      const result = await db.execute("INSERT INTO employees (name, cpf) VALUES ($1, $2)", [
        row.name.trim(),
        normalizedCpf,
      ]);
      employeeId = result.lastInsertId as number;
    }
    await linkEmployeeToClientCompany(employeeId, row.clientId, row.companyId, row.matricula);
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
 * Whether `alias` is already registered to some OTHER colaborador who
 * shares at least one (cliente, empresa) pair with `employeeId` — `null`
 * when it's free. Scoped to shared pairs, not globally: since
 * 0072_employee_client_link.sql a colaborador can be linked to several
 * clientes and empresas, and two colaboradores who never share a single
 * (cliente, empresa) pair can never actually be confused with each other by
 * `findEmployeeByAttempts` (always scoped to one specific pair) — so
 * letting them coincidentally share a raw name/alias is harmless. A
 * collision only matters where it could actually cause a wrong match.
 * Case-insensitive, same ASCII-only limitation already accepted for name
 * search elsewhere.
 */
export async function findEmployeeAliasOwner(
  employeeId: number,
  alias: string,
): Promise<{ id: number; name: string } | null> {
  const db = await getDb();
  const rows = await db.select<{ id: number; name: string }[]>(
    `SELECT DISTINCT e.id, e.name
     FROM employee_aliases ea
     JOIN employees e ON e.id = ea.employee_id
     WHERE lower(ea.alias) = lower($1)
       AND e.id != $2
       AND EXISTS (
         SELECT 1 FROM employee_client_companies mine
         JOIN employee_client_companies theirs
           ON theirs.client_id = mine.client_id AND theirs.company_id = mine.company_id
         WHERE mine.employee_id = $2 AND theirs.employee_id = e.id
       )`,
    [alias.trim(), employeeId],
  );
  return rows[0] ?? null;
}

/**
 * Registers `alias` for `employeeId` — throws a message naming the current
 * owner if it's already someone else's within a shared (cliente, empresa)
 * pair (see `findEmployeeAliasOwner`). Already registered to this same
 * employee is a silent no-op, not an error, since the payment-import
 * "vincular colaborador" flow can call this repeatedly for several rows
 * that share the same raw name.
 */
export async function addEmployeeAlias(employeeId: number, alias: string): Promise<void> {
  const db = await getDb();
  const trimmed = alias.trim();
  if (!trimmed) throw new Error("Nome não pode ser vazio.");

  const employeeRows = await db.select<{ id: number }[]>("SELECT id FROM employees WHERE id = $1", [employeeId]);
  if (employeeRows.length === 0) throw new Error("Colaborador não encontrado.");

  const owner = await findEmployeeAliasOwner(employeeId, trimmed);
  if (owner) {
    throw new Error(`Esse nome já está vinculado a ${owner.name}.`);
  }

  const alreadyMine = await db.select<{ id: number }[]>(
    "SELECT id FROM employee_aliases WHERE employee_id = $1 AND lower(alias) = lower($2)",
    [employeeId, trimmed],
  );
  if (alreadyMine.length > 0) return;

  await db.execute("INSERT INTO employee_aliases (employee_id, alias) VALUES ($1, $2)", [employeeId, trimmed]);
}

export async function removeEmployeeAlias(aliasId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM employee_aliases WHERE id = $1", [aliasId]);
}

export interface RoleRow {
  id: number;
  companyId: number;
  name: string;
}

/**
 * A "função" cadastro, scoped per empresa only (not per cliente like
 * `EmployeeRow` — the same função vocabulary is shared across every cliente
 * that empresa serves).
 */
export async function listRoles(companyId: number): Promise<RoleRow[]> {
  const db = await getDb();
  return db.select<RoleRow[]>(
    `SELECT id, company_id AS companyId, name FROM roles WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
}

/** Every função across every empresa — the Pagamentos "Função" filter's option list, narrowed client-side to whichever empresas are currently selected (same pattern `clientOptions` already uses for Cliente vs Empresa). */
export async function listRolesGlobal(): Promise<RoleRow[]> {
  const db = await getDb();
  return db.select<RoleRow[]>(`SELECT id, company_id AS companyId, name FROM roles ORDER BY name`);
}

export async function getRole(id: number): Promise<RoleRow> {
  const db = await getDb();
  const rows = await db.select<RoleRow[]>(
    `SELECT id, company_id AS companyId, name FROM roles WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error("Função não encontrada.");
  return rows[0];
}

export async function createRole(companyId: number, name: string): Promise<number> {
  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Nome não pode ser vazio.");

  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM roles WHERE company_id = $1 AND lower(name) = lower($2)",
    [companyId, trimmed],
  );
  if (existing.length > 0) throw new Error("Já existe uma função com esse nome para essa empresa.");

  const result = await db.execute("INSERT INTO roles (company_id, name) VALUES ($1, $2)", [companyId, trimmed]);
  return result.lastInsertId as number;
}

export async function updateRole(id: number, name: string): Promise<void> {
  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Nome não pode ser vazio.");

  const current = await db.select<{ companyId: number }[]>(
    "SELECT company_id AS companyId FROM roles WHERE id = $1",
    [id],
  );
  if (current.length === 0) throw new Error("Função não encontrada.");

  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM roles WHERE company_id = $1 AND lower(name) = lower($2) AND id != $3",
    [current[0].companyId, trimmed, id],
  );
  if (existing.length > 0) throw new Error("Já existe uma função com esse nome para essa empresa.");

  await db.execute("UPDATE roles SET name = $1 WHERE id = $2", [trimmed, id]);
}

/**
 * Deletes a função and its apelidos. Unlike `deleteEmployee`, this doesn't
 * touch `payment_shifts` — a turno isn't "about" its função the way it's
 * about its colaborador, so existing shifts just lose the link
 * (`role_id` → NULL) and keep their raw `role` text untouched, instead of
 * being deleted along with the função.
 */
export async function deleteRole(roleId: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE payment_shifts SET role_id = NULL WHERE role_id = $1", [roleId]);
  await db.execute("DELETE FROM role_aliases WHERE role_id = $1", [roleId]);
  await db.execute("DELETE FROM roles WHERE id = $1", [roleId]);
}

export interface RoleAliasRow {
  id: number;
  roleId: number;
  alias: string;
}

/** Every "possível nome" registered for one função, most recent first. */
export async function listRoleAliases(roleId: number): Promise<RoleAliasRow[]> {
  const db = await getDb();
  return db.select<RoleAliasRow[]>(
    `SELECT id, role_id AS roleId, alias FROM role_aliases WHERE role_id = $1 ORDER BY id DESC`,
    [roleId],
  );
}

/**
 * Whether `alias` is already registered to some função within `companyId`
 * — `null` when it's free. Scoped per empresa only, same granularity as
 * `roles` itself. Case-insensitive, same ASCII-only limitation already
 * accepted for name search elsewhere.
 */
export async function findRoleAliasOwner(companyId: number, alias: string): Promise<{ id: number; name: string } | null> {
  const db = await getDb();
  const rows = await db.select<{ id: number; name: string }[]>(
    `SELECT r.id, r.name
     FROM role_aliases ra
     JOIN roles r ON r.id = ra.role_id
     WHERE r.company_id = $1 AND lower(ra.alias) = lower($2)`,
    [companyId, alias.trim()],
  );
  return rows[0] ?? null;
}

/**
 * Registers `alias` for `roleId` — throws a message naming the current
 * owner if it's already someone else's within the same empresa. Already
 * registered to this same função is a silent no-op, not an error, mirroring
 * `addEmployeeAlias`.
 */
export async function addRoleAlias(roleId: number, alias: string): Promise<void> {
  const db = await getDb();
  const trimmed = alias.trim();
  if (!trimmed) throw new Error("Nome não pode ser vazio.");

  const roleRows = await db.select<{ companyId: number }[]>(
    "SELECT company_id AS companyId FROM roles WHERE id = $1",
    [roleId],
  );
  if (roleRows.length === 0) throw new Error("Função não encontrada.");

  const owner = await findRoleAliasOwner(roleRows[0].companyId, trimmed);
  if (owner && owner.id !== roleId) {
    throw new Error(`Esse nome já está vinculado à função ${owner.name}.`);
  }
  if (owner) return;

  await db.execute("INSERT INTO role_aliases (role_id, alias) VALUES ($1, $2)", [roleId, trimmed]);
}

export async function removeRoleAlias(aliasId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM role_aliases WHERE id = $1", [aliasId]);
}

/**
 * Resolves a payment row's função within `companyId` by name or apelido —
 * simplified sibling of `findEmployeeByAttempts` (just one field, no
 * identifier precedence to walk since função only ever matches on its own
 * text). Case-insensitive, same as the "nome" tentativa there.
 */
export async function findRoleByName(companyId: number, text: string | null): Promise<RoleRow | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const db = await getDb();
  const rows = await db.select<RoleRow[]>(
    `SELECT r.id, r.company_id AS companyId, r.name
     FROM roles r
     WHERE r.company_id = $1
       AND (lower(r.name) = lower($2) OR EXISTS (
         SELECT 1 FROM role_aliases ra WHERE ra.role_id = r.id AND lower(ra.alias) = lower($2)
       ))`,
    [companyId, trimmed],
  );
  return rows[0] ?? null;
}

/**
 * Walks a template's `identifierPriority` against a base `SELECT e.id ...`
 * (caller-supplied, already scoped however that variant needs), trying each
 * tentativa in order — every field within one tentativa must match the
 * *same* employee (an AND); the first tentativa that finds someone wins (an
 * OR across tentativas). A tentativa is skipped outright if any of its
 * fields has no raw value for this row — there's nothing to match on.
 * `matricula` lives on `employee_client_companies` now (per cliente+empresa
 * pair), not `employees` — `matriculaCondition` builds that field's SQL
 * condition given a `$n` placeholder and the tentativa's `caseInsensitive`
 * flag, since the two callers need different scopes: `findEmployeeByAttempts`
 * already joined one specific pair (`ecc`) so it can compare that column
 * directly, while `findEmployeeAnywhereByAttempts` has no pair in scope and
 * needs an `EXISTS` across all of an employee's pairs instead. Returns the
 * first matching employee's id, hydrated by the caller.
 */
async function findEmployeeIdByAttempts(
  db: Database,
  baseSelect: string,
  baseParams: (string | number)[],
  attempts: IdentifierAttempt[],
  values: { cpf: string | null; matricula: string | null; nome: string | null },
  matriculaCondition: (placeholder: string, caseInsensitive: boolean) => string,
): Promise<number | null> {
  for (const attempt of attempts) {
    if (attempt.fields.length === 0) continue;
    const conditions: string[] = [];
    const params: (string | number)[] = [...baseParams];
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
        conditions.push(matriculaCondition(`$${params.length}`, attempt.caseInsensitive));
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
    const rows = await db.select<{ id: number }[]>(`${baseSelect} AND ${conditions.join(" AND ")}`, params);
    if (rows.length > 0) return rows[0].id;
  }
  return null;
}

/**
 * Resolves a payment row's employee within `clientId` **and already linked
 * to** `companyId` — by walking a template's `identifierPriority` (see
 * `findEmployeeIdByAttempts`). Both are required, not just `clientId`: a
 * cliente can be linked to more than one empresa (`client_companies`), and
 * this only matches a colaborador who's actually linked to that exact
 * (cliente, empresa) pair via `employee_client_companies` — scoping only by
 * cliente would match a colaborador linked to a *different* empresa of the
 * same cliente (e.g. a routing rule's "senão" pointing at the same cliente
 * as a condition rule, but a different empresa), silently misrouting the
 * shift to that other empresa.
 *
 * Returns `null` both when no colaborador matches at all, and when one
 * matches by `clientId` but isn't linked to that specific `companyId` yet —
 * the caller can't tell those apart from this alone; use
 * `findEmployeeAnywhereByAttempts` to distinguish "genuinely new person" from
 * "existing person, new cliente/empresa" before deciding whether to create
 * or link.
 */
export async function findEmployeeByAttempts(
  clientId: number,
  companyId: number,
  attempts: IdentifierAttempt[],
  values: { cpf: string | null; matricula: string | null; nome: string | null },
): Promise<EmployeeRow | null> {
  const db = await getDb();
  const select = `SELECT e.id
    FROM employees e
    JOIN employee_client_companies ecc ON ecc.employee_id = e.id AND ecc.client_id = $1 AND ecc.company_id = $2
    WHERE 1=1`;
  const id = await findEmployeeIdByAttempts(db, select, [clientId, companyId], attempts, values, (p, ci) =>
    ci ? `lower(ecc.matricula) = lower(${p})` : `ecc.matricula = ${p}`,
  );
  if (id === null) return null;
  const rows = await hydrateEmployeeRows(db, [id]);
  return rows[0] ?? null;
}

/**
 * Same identifier-matching algorithm as `findEmployeeByAttempts`, but with
 * no cliente/empresa scope at all — used when a row didn't resolve under
 * the routed pair, to answer "does this person already exist somewhere
 * else?" (a different cliente, a different empresa of the same cliente, or
 * both) before offering to link them (`linkEmployeeToClientCompany`)
 * instead of silently registering a second, duplicate colaborador — the
 * exact bug 0071/0072_employee_*_link.sql fixed at the data level. Never
 * used to resolve who a payment row actually belongs to during import —
 * that always stays scoped to the route's own resolved cliente/empresa
 * (`findEmployeeByAttempts`), so a coincidental CPF/nome match under an
 * unrelated pair can never silently misroute a shift. Matrícula tentativas
 * match against ANY of the employee's existing pairs' matrícula, since
 * there's no single pair in scope here to compare against directly.
 */
export async function findEmployeeAnywhereByAttempts(
  attempts: IdentifierAttempt[],
  values: { cpf: string | null; matricula: string | null; nome: string | null },
): Promise<EmployeeRow | null> {
  const db = await getDb();
  const select = `SELECT e.id FROM employees e WHERE 1=1`;
  const id = await findEmployeeIdByAttempts(db, select, [], attempts, values, (p, ci) => {
    const cmp = ci ? `lower(ecc.matricula) = lower(${p})` : `ecc.matricula = ${p}`;
    return `EXISTS (SELECT 1 FROM employee_client_companies ecc WHERE ecc.employee_id = e.id AND ${cmp})`;
  });
  if (id === null) return null;
  const rows = await hydrateEmployeeRows(db, [id]);
  return rows[0] ?? null;
}

export interface DuplicatePaymentShiftMatch {
  /** The *current* (head) row for this identity — see `HEAD_SHIFT_CONDITION`. Reprocessing links its new row back to exactly this one via `PaymentShiftInput.previousShiftId`, not to whichever row happens to be oldest. */
  shiftId: number;
  /** Whether that head row was a deliberate manual field edit (see `editPaymentShift`) — the caller uses this to refuse to supersede it (unless `payment_settings.keep_manual_edits` is off). Does NOT by itself mean the row is paid — see `status`, which is the unconditional guard for that. */
  editedManually: boolean;
  /** The head row's own status — a `'pago'` match must never be silently superseded, independent of `editedManually`/`keep_manual_edits` (that setting is about optional protection for a hand-edited-but-unpaid row, not about money already recorded as paid). */
  status: PaymentShiftStatus;
  /**
   * True when the match was only found by walking history — the *head*
   * row's own Local/Função/Horário/Data no longer equal the candidate's,
   * because a manual edit changed one of them after this shift was
   * imported (see the big comment below). The caller uses this to warn
   * that "reprocessar" would overwrite data that now differs from the file,
   * not just a status/valor.
   */
  identityChanged: boolean;
  /**
   * True when the matched head is soft-deleted (see
   * 0052_payment_shifts_soft_delete.sql / `deletePaymentShift`) — "Remover"
   * never physically deletes a row precisely so a later reimport can still
   * find it here and flag it for review instead of silently recreating a
   * shift the user deliberately removed. The caller categorizes this
   * separately from a plain "duplicate" (`editedManually`/`identityChanged`
   * don't matter once this is true).
   */
  deleted: boolean;
}

/**
 * For each candidate row, finds the *current* payment_shifts row matching
 * the same identity — employee/dia/local/função/horário, every column, not
 * just employee/data/local (a partial match, say same colaborador and dia
 * and local but a different horário, is a plausible second real shift, not
 * a duplicate). An exact match is unambiguous, so the caller offers it as
 * "reprocessar" rather than a "possível duplicata" needing a judgment call.
 *
 * A plain "does the candidate match some head row's CURRENT columns" query
 * misses one real case: `editPaymentShift` can change Local/Função/Horário
 * (or Data) by hand, which is exactly the identity this function matches
 * on — after that edit, the head row's identity no longer equals what's
 * still sitting in the source file, so a plain query would treat the
 * reimported row as brand new and create a second, disconnected shift
 * instead of recognizing "this is the same turno, someone corrected it by
 * hand." So this also walks forward from any HISTORICAL row (not just the
 * head) that matches the candidate's identity, via `previous_shift_id`, to
 * find whichever head it eventually became — same append-only chain
 * `getPaymentShiftHistory` walks, just forward instead of backward. Every
 * row reachable that way was necessarily produced by one of the manual
 * transition functions above (only those ever set `previous_shift_id`) —
 * but landing on a head this way does NOT by itself mean `editedManually`
 * is true for it: `markPaymentShiftPaid`/`revertPaymentShiftToPending`
 * inherit the flag from the row they transitioned rather than forcing it,
 * so a plain pay/revert with no field ever hand-edited stays `false` all
 * the way down the chain. `status` is what's unconditionally reliable here.
 *
 * Uses `STRUCTURAL_HEAD_CONDITION`, not `HEAD_SHIFT_CONDITION` — a
 * soft-deleted chain's head is still structurally "the head" (nothing
 * points to it), and this function needs to find it precisely so a
 * reimport can flag "this was removed" instead of just not noticing it at
 * all and creating a brand-new, disconnected shift.
 */
export async function findDuplicatePaymentShifts(
  rows: {
    employeeId: number;
    workDate: string;
    local: string;
    roleId: number | null;
    scheduleStartMinutes: number | null;
    scheduleEndMinutes: number | null;
  }[],
): Promise<Map<number, DuplicatePaymentShiftMatch>> {
  const db = await getDb();
  const matches = new Map<number, DuplicatePaymentShiftMatch>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const existing = await db.select<
      {
        id: number;
        editedManually: number;
        status: PaymentShiftStatus;
        deletedAt: string | null;
        currentWorkDate: string;
        currentLocal: string;
        currentRoleId: number | null;
        currentScheduleStart: number | null;
        currentScheduleEnd: number | null;
      }[]
    >(
      `WITH RECURSIVE lineage(id) AS (
         SELECT ps.id FROM payment_shifts ps
         WHERE ps.employee_id = $1 AND ps.work_date = $2 AND ps.local = $3
           AND IFNULL(ps.role_id, -1) = IFNULL($4, -1)
           AND IFNULL(ps.schedule_start_minutes, -1) = IFNULL($5, -1)
           AND IFNULL(ps.schedule_end_minutes, -1) = IFNULL($6, -1)
         UNION ALL
         SELECT next_ps.id FROM payment_shifts next_ps
         JOIN lineage ON next_ps.previous_shift_id = lineage.id
       )
       SELECT ps.id, ps.edited_manually AS editedManually, ps.status, ps.deleted_at AS deletedAt,
              ps.work_date AS currentWorkDate, ps.local AS currentLocal, ps.role_id AS currentRoleId,
              ps.schedule_start_minutes AS currentScheduleStart, ps.schedule_end_minutes AS currentScheduleEnd
       FROM payment_shifts ps
       WHERE ps.id IN (SELECT id FROM lineage) AND ${STRUCTURAL_HEAD_CONDITION}
       ORDER BY ps.id DESC
       LIMIT 1`,
      [r.employeeId, r.workDate, r.local, r.roleId, r.scheduleStartMinutes, r.scheduleEndMinutes],
    );
    if (existing.length > 0) {
      const head = existing[0];
      const identityChanged =
        head.currentWorkDate !== r.workDate ||
        head.currentLocal !== r.local ||
        (head.currentRoleId ?? null) !== r.roleId ||
        (head.currentScheduleStart ?? null) !== r.scheduleStartMinutes ||
        (head.currentScheduleEnd ?? null) !== r.scheduleEndMinutes;
      matches.set(i, {
        shiftId: head.id,
        editedManually: Boolean(head.editedManually),
        status: head.status,
        identityChanged,
        deleted: head.deletedAt !== null,
      });
    }
  }
  return matches;
}

export interface PositionMatchedShift {
  shiftId: number;
  employeeId: number;
  employeeName: string;
  workDate: string;
  local: string;
  /** Joined from `roles.name` via `roleId` — `''` when `roleId` is `null`. */
  role: string;
  roleId: number | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  status: PaymentShiftStatus;
  extraData: Record<string, string> | null;
  editedManually: boolean;
}

type PositionMatchedShiftRaw = Omit<PositionMatchedShift, "extraData" | "editedManually"> & {
  extraData: string | null;
  editedManually: number;
};

/**
 * Fallback for the deep-check diff (`remoteCheckDiff.ts`), used two ways:
 * (1) a candidate row with no `findDuplicatePaymentShifts` identity match —
 * an edit in the file to the row's OWN identity field (local/função/
 * horário/data) makes it look like a brand-new shift instead of an edit of
 * an existing one; (2) a row whose COLABORADOR couldn't even be resolved
 * (CPF/matrícula/nome all missed) — there `employeeName` lets the caller
 * enrich the "colaborador não encontrado" message with who used to be here,
 * without the diff silently guessing that's who it still is.
 *
 * Finds whichever *current* head shift used to sit at this same row/aba of
 * this same URL's most recent prior import, via `source_row_number`/
 * `source_sheet_name` (indexed) joined through `source_file_id` to
 * `source_files.source_url` — not by matching file identity, which by
 * definition just changed (that's why this URL's HEAD check flagged it as
 * different content in the first place).
 *
 * Same head rule as `findDuplicatePaymentShifts` (`STRUCTURAL_HEAD_CONDITION`,
 * not `HEAD_SHIFT_CONDITION`) — a soft-deleted chain's head is still worth
 * surfacing to the diff, not silently skipped.
 */
export async function findPaymentShiftByPosition(
  sourceUrl: string,
  sheetName: string | null,
  rowNumber: number,
): Promise<PositionMatchedShift | null> {
  const db = await getDb();
  const rows = await db.select<PositionMatchedShiftRaw[]>(
    `SELECT ps.id AS shiftId, ps.employee_id AS employeeId, e.name AS employeeName, ps.work_date AS workDate,
            ps.local, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.extra_data AS extraData, ps.edited_manually AS editedManually
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN source_files sf ON sf.id = ps.source_file_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE sf.source_url = $1
       AND IFNULL(ps.source_sheet_name, '') = IFNULL($2, '')
       AND ps.source_row_number = $3
       AND ${STRUCTURAL_HEAD_CONDITION}
     ORDER BY ps.id DESC
     LIMIT 1`,
    [sourceUrl, sheetName, rowNumber],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { ...r, extraData: r.extraData ? JSON.parse(r.extraData) : null, editedManually: Boolean(r.editedManually) };
}

export interface SourceUrlHeadShift {
  shiftId: number;
  employeeId: number;
  employeeName: string;
  workDate: string;
  local: string;
  /** Joined from `roles.name` via `roleId` — `''` when `roleId` is `null`. */
  role: string;
  roleId: number | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  status: PaymentShiftStatus;
  sheetName: string | null;
  rowNumber: number | null;
  /** Needed by `computeReimportDiff`'s auto-apply gate for `change_kind: 'removed'` — same manual-edit protection a matched 'field' diff already checks. */
  editedManually: boolean;
}

type SourceUrlHeadShiftRaw = Omit<SourceUrlHeadShift, "editedManually"> & { editedManually: number };

/**
 * Every current (head, non-deleted) shift ever imported from this exact
 * source URL, optionally bounded to a período — the mirror image of
 * `findPaymentShiftByPosition` (which answers "what's at this ONE position"
 * instead of "everything"). Used by the deep check
 * (`remoteCheckDiff.ts`'s `computeReimportDiff`, `change_kind: 'removed'`)
 * and the manual reimport preview (`ImportPaymentsPage`) to find shifts that
 * are no longer represented by ANY row in a fresh parse of the file — the
 * inverse of the existing "excluído" detection (a file row whose match was
 * soft-deleted in the system), which only ever catches the file-still-has-it
 * direction.
 */
export async function listHeadShiftsForSourceUrl(
  sourceUrl: string,
  periodStart: string | null,
  periodEnd: string | null,
): Promise<SourceUrlHeadShift[]> {
  const db = await getDb();
  const conditions = ["sf.source_url = $1", HEAD_SHIFT_CONDITION];
  const params: string[] = [sourceUrl];
  if (periodStart) {
    params.push(periodStart);
    conditions.push(`ps.work_date >= $${params.length}`);
  }
  if (periodEnd) {
    params.push(periodEnd);
    conditions.push(`ps.work_date <= $${params.length}`);
  }
  const rows = await db.select<SourceUrlHeadShiftRaw[]>(
    `SELECT ps.id AS shiftId, ps.employee_id AS employeeId, e.name AS employeeName, ps.work_date AS workDate,
            ps.local, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.source_sheet_name AS sheetName, ps.source_row_number AS rowNumber,
            ps.edited_manually AS editedManually
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN source_files sf ON sf.id = ps.source_file_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return rows.map((r) => ({ ...r, editedManually: Boolean(r.editedManually) }));
}

export interface PaymentShiftInput {
  employeeId: number;
  templateId: number | null;
  sourceFileId: number | null;
  clientId: number;
  companyId: number;
  local: string;
  workDate: string;
  /** The função resolved at import time by matching the file's raw text against `roles`/`role_aliases` (see `findRoleByName`) — `null` when it didn't match any cadastro. There is no raw-text column anymore: this FK is the only representation of a turno's função, same as `employeeId`. */
  roleId: number | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  /** Resolved from the template's status rules (see `resolvePaymentStatus`), falling back to `"pendente"` when none match — not always `"pendente"` anymore. */
  status: PaymentShiftStatus;
  /** Every non-blank column the template left unmapped on this row (see `AppliedPaymentRow.extraFields`) — `null` when there was nothing left unmapped. */
  extraData: Record<string, string> | null;
  /** Set when this row reprocesses an existing "duplicate" match (see `findDuplicatePaymentShifts`) — links back to it via `previous_shift_id`, so this new row becomes the current one and the old one is frozen as history instead of the two coexisting as unrelated rows. `null` for a brand-new shift. */
  previousShiftId: number | null;
  /** This row's position (row number + aba) in the source file — `null` for a row with no import origin. Indexed columns, unlike `extraData`, so `findPaymentShiftByPosition` can look them up cheaply. */
  sourceRowNumber: number | null;
  sourceSheetName: string | null;
}

/** Bulk-inserts shifts — `valor` and any further `pago` transition still happen in a later step. Never sets `edited_manually` — that's exclusively for the manual transition functions above, never for anything import-originated. */
export async function savePaymentShifts(rows: PaymentShiftInput[]): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO payment_shifts
         (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
          schedule_start_minutes, schedule_end_minutes, status, extra_data, previous_shift_id,
          source_row_number, source_sheet_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        r.employeeId,
        r.templateId,
        r.sourceFileId,
        r.clientId,
        r.companyId,
        r.local,
        r.workDate,
        r.roleId,
        r.scheduleStartMinutes,
        r.scheduleEndMinutes,
        r.status,
        r.extraData ? JSON.stringify(r.extraData) : null,
        r.previousShiftId,
        r.sourceRowNumber,
        r.sourceSheetName,
      ],
    );
  }
}

/**
 * A shift's "current" row is whichever one nothing else points to via
 * `previous_shift_id` — once "Fazer pagamento" creates a new row linked
 * back to a pendente/erro one, that older row is superseded and drops out
 * of every list/summary/total, staying only as history reachable through
 * the link on the row that replaced it (see `getPaymentShift`). Purely
 * structural — doesn't consider `deleted_at` — so `findDuplicatePaymentShifts`
 * can use this alone to still find a *deleted* chain's head (it needs to,
 * to flag a reimport of it for review); every other consumer wants
 * `HEAD_SHIFT_CONDITION` below instead.
 */
const STRUCTURAL_HEAD_CONDITION =
  "ps.id NOT IN (SELECT previous_shift_id FROM payment_shifts WHERE previous_shift_id IS NOT NULL)";

/**
 * The actual "currently visible" condition every list/summary/report query
 * uses — structurally the head AND not soft-deleted (see
 * 0052_payment_shifts_soft_delete.sql). "Remover" on a turno never
 * physically deletes it (so a later reimport can still recognize and flag
 * it — see `findDuplicatePaymentShifts`), so hiding it from every normal
 * view has to happen here instead.
 */
const HEAD_SHIFT_CONDITION = `${STRUCTURAL_HEAD_CONDITION} AND ps.deleted_at IS NULL`;

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
 * `ps`, with its company already joined as `c` AND its client already
 * joined as `cl`) as "noturno" — the effective night window/rule is the
 * client's own override when set, falling back to the company's otherwise
 * (`COALESCE(cl.night_*, c.night_*)`, same client-wins precedence as
 * `getEffectivePaymentRules`, just mirrored in SQL). `hasSchedule` (a row
 * with no parsed horário is neither diurno nor noturno, same as
 * `classifyShiftPeriod`'s caller returning `null`) and `isNoturno` (the
 * rule-dependent classification itself, only meaningful where `hasSchedule`
 * holds) are kept separate so a caller can build both "is noturno"
 * (`hasSchedule AND isNoturno`) and "is diurno" (`hasSchedule AND NOT
 * isNoturno`) without `NOT` accidentally flipping missing-schedule rows
 * into false positives.
 */
function shiftPeriodSql(): { hasSchedule: string; isNoturno: string } {
  const effectiveStart = "COALESCE(cl.night_start_time, c.night_start_time)";
  const effectiveEnd = "COALESCE(cl.night_end_time, c.night_end_time)";
  const effectiveRule = "COALESCE(cl.night_shift_rule, c.night_shift_rule)";
  const nightStart = `((CAST(substr(${effectiveStart},1,2) AS INTEGER) * 60) + CAST(substr(${effectiveStart},4,2) AS INTEGER))`;
  const nightEnd = `((CAST(substr(${effectiveEnd},1,2) AS INTEGER) * 60) + CAST(substr(${effectiveEnd},4,2) AS INTEGER))`;
  const shiftStart = "ps.schedule_start_minutes";
  const shiftEnd = "ps.schedule_end_minutes";

  const startInRange = timeInRangeSql(shiftStart, nightStart, nightEnd);
  const endInRange = timeInRangeSql(shiftEnd, nightStart, nightEnd);
  const overlaps = rangesOverlapSql(shiftStart, shiftEnd, nightStart, nightEnd);
  const overlapMinutes = overlapMinutesSql(shiftStart, shiftEnd, nightStart, nightEnd);
  const duration = `(CASE WHEN ${shiftEnd} > ${shiftStart} THEN ${shiftEnd} - ${shiftStart} ELSE 1440 - ${shiftStart} + ${shiftEnd} END)`;
  const majorityOverlap = `(${duration} > 0 AND ${overlapMinutes} * 2 >= ${duration})`;

  const isNoturno = `(CASE ${effectiveRule}
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

/**
 * Every distinct "Local" used across current (head) payment_shifts — the
 * Pagamentos "Local" filter's option list. Unlike Função/Cliente/Empresa,
 * `local` has no cadastro table of its own (a plain freeform `TEXT` column
 * directly on `payment_shifts`, never normalized like `role`→`roles` was) —
 * options come straight from what's actually been imported, not a separate
 * lookup table.
 */
export async function listDistinctPaymentShiftLocals(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ local: string }[]>(
    `SELECT DISTINCT ps.local AS local
     FROM payment_shifts ps
     WHERE ${HEAD_SHIFT_CONDITION} AND ps.local <> ''
     ORDER BY ps.local`,
  );
  return rows.map((r) => r.local);
}

/**
 * Row-level WHERE conditions shared by every flat (non-aggregated) shift
 * query — `listPaymentShiftsForReport`, `listPaymentShiftsFlat`, and
 * `listPaymentShiftsForGroup`. `listPaymentShiftSummaries` doesn't use
 * this: its status/diurno-noturno filters read aggregated SUMs, so they
 * belong in HAVING instead, not here.
 */
function buildPaymentShiftRowConditions(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
  params: (string | number)[],
): string[] {
  const conditions: string[] = [HEAD_SHIFT_CONDITION];
  const employeeClause = inClause("e.id", query.employeeIds ?? [], params);
  if (employeeClause) conditions.push(employeeClause);
  const companyClause = inClause("c.id", query.companyIds ?? [], params);
  if (companyClause) conditions.push(companyClause);
  const clientClause = inClause("cl.id", query.clientIds ?? [], params);
  if (clientClause) conditions.push(clientClause);
  const roleClause = inClause("ps.role_id", query.roleIds ?? [], params);
  if (roleClause) conditions.push(roleClause);
  const localClause = inClause("ps.local", query.locals ?? [], params);
  if (localClause) conditions.push(localClause);
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
  return conditions;
}

/** A shift's Diurno/Noturno classification as a SQL expression — `NULL` when there's no schedule to classify, same stance as `shiftPeriodSql`'s `hasSchedule` guard. Requires `c` (companies) joined. */
function shiftPeriodSelectSql(): string {
  const { hasSchedule, isNoturno } = shiftPeriodSql();
  return `(CASE WHEN NOT ${hasSchedule} THEN NULL WHEN ${isNoturno} THEN 'noturno' ELSE 'diurno' END)`;
}

export interface ListPaymentShiftSummariesQuery {
  /** Specific colaboradores picked from the "Colaborador" filter's search-and-select — an empty/omitted array means unfiltered, same as `companyIds`/`clientIds`/`roleIds`/`locals`. */
  employeeIds?: number[];
  companyIds?: number[];
  clientIds?: number[];
  roleIds?: number[];
  /** Exact-match against `payment_shifts.local` — options come from `listDistinctPaymentShiftLocals`, not a cadastro table (see its own doc comment). */
  locals?: string[];
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
  const employeeClause = inClause("e.id", query.employeeIds ?? [], params);
  if (employeeClause) conditions.push(employeeClause);
  const companyClause = inClause("c.id", query.companyIds ?? [], params);
  if (companyClause) conditions.push(companyClause);
  const clientClause = inClause("cl.id", query.clientIds ?? [], params);
  if (clientClause) conditions.push(clientClause);
  const roleClause = inClause("ps.role_id", query.roleIds ?? [], params);
  if (roleClause) conditions.push(roleClause);
  const localClause = inClause("ps.local", query.locals ?? [], params);
  if (localClause) conditions.push(localClause);
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
    JOIN clients cl ON cl.id = ps.client_id
    JOIN companies c ON c.id = ps.company_id`;

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
  /** Added for "Conferência de Pagamentos" — the other consumers (PDF/Excel export) never needed the row's own id, since they only ever render/aggregate it. */
  id: number;
  employeeId: number;
  employeeName: string;
  companyId: number;
  /** companyName/clientId/clientName: added for the Excel export template's groupBy/column bindings — the PDF report only ever used companyId (for the per-shift value-rule lookup). */
  companyName: string;
  clientId: number;
  clientName: string;
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  status: PaymentShiftStatus;
  amount: number | null;
  /** Added for "Conferência de Pagamentos"'s optional "Importado em"/"Extras" columns — see `PaymentShiftRow` for the same fields' meaning. */
  importedAt: string;
  extraData: Record<string, string> | null;
  /** Computed in SQL via the company's own configured rule, same as `shiftPeriodSql` powers for the list's Diurno/Noturno filter — `null` when there's no schedule to classify. */
  shiftPeriod: ShiftPeriod | null;
}

type PaymentShiftReportRowRaw = Omit<PaymentShiftReportRow, "extraData"> & { extraData: string | null };

/**
 * Every *current* shift matching the Pagamentos list's filters, flat (no
 * grouping/pagination) — the data behind "Gerar PDF" and "Conferência de
 * Pagamentos". Same WHERE-condition shape as `listPaymentShiftSummaries` for
 * search/empresa/cliente/período, but status and diurno/noturno are per-row
 * `WHERE` conditions here instead of aggregated `HAVING` ones, since there's
 * no `GROUP BY` to aggregate through.
 */
export async function listPaymentShiftsForReport(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<PaymentShiftReportRow[]> {
  if (query.statuses.length === 0 || query.shiftPeriods.length === 0) return [];

  const db = await getDb();
  const params: (string | number)[] = [];
  const conditions = buildPaymentShiftRowConditions(query, params);

  const rows = await db.select<PaymentShiftReportRowRaw[]>(
    `SELECT ps.id, e.id AS employeeId, e.name AS employeeName, c.id AS companyId, c.name AS companyName,
            cl.id AS clientId, cl.name AS clientName,
            ps.work_date AS workDate, ps.local, COALESCE(r.name, '') AS role,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.amount, ps.imported_at AS importedAt, ps.extra_data AS extraData,
            ${shiftPeriodSelectSql()} AS shiftPeriod
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN clients cl ON cl.id = ps.client_id
     JOIN companies c ON c.id = ps.company_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ps.work_date, ps.local, e.name`,
    params,
  );
  return rows.map((r) => ({ ...r, extraData: r.extraData ? JSON.parse(r.extraData) : null }));
}

export interface PaymentShiftFlatRow extends PaymentShiftRow {
  companyId: number;
  companyName: string;
  clientId: number;
  clientName: string;
  /** Same idea as `PaymentShiftReportRow.shiftPeriod` — computed in SQL, `null` when there's no schedule to classify. */
  shiftPeriod: ShiftPeriod | null;
}

type PaymentShiftFlatRowRaw = Omit<PaymentShiftFlatRow, "extraData" | "editedManually"> & {
  extraData: string | null;
  editedManually: number;
};

/**
 * Every *current* shift matching the Pagamentos list's filters, one row per
 * turno — the "desagrupado" view. Same WHERE-condition shape and pagination
 * as `listPaymentShiftSummaries`, but flat (no `GROUP BY`), so status and
 * diurno/noturno stay row-level `WHERE` conditions like
 * `listPaymentShiftsForReport` instead of aggregated `HAVING` ones.
 */
export async function listPaymentShiftsFlat(
  query: ListPaymentShiftSummariesQuery,
): Promise<PagedResult<PaymentShiftFlatRow>> {
  if (query.statuses.length === 0 || query.shiftPeriods.length === 0) return { rows: [], total: 0 };

  const db = await getDb();
  const params: (string | number)[] = [];
  const conditions = buildPaymentShiftRowConditions(query, params);
  const from = `FROM payment_shifts ps
    JOIN employees e ON e.id = ps.employee_id
    JOIN clients cl ON cl.id = ps.client_id
    JOIN companies c ON c.id = ps.company_id
    LEFT JOIN source_files sf ON sf.id = ps.source_file_id
    LEFT JOIN roles r ON r.id = ps.role_id`;
  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countRows = await db.select<{ count: number }[]>(`SELECT COUNT(*) AS count ${from} ${whereClause}`, params);
  const total = countRows[0]?.count ?? 0;

  const rows = await db.select<PaymentShiftFlatRowRaw[]>(
    `SELECT ${PAYMENT_SHIFT_SELECT_COLUMNS},
            c.name AS companyName, cl.name AS clientName,
            ${shiftPeriodSelectSql()} AS shiftPeriod
     ${from}
     ${whereClause}
     ORDER BY ps.work_date DESC, e.name
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, query.page * query.pageSize],
  );

  return { rows: rows.map((r) => ({ ...parsePaymentShiftRow(r), companyName: r.companyName, clientName: r.clientName, shiftPeriod: r.shiftPeriod })), total };
}

const PAYMENT_SHIFT_SELECT_COLUMNS = `
  ps.id, ps.employee_id AS employeeId, e.name AS employeeName,
  ps.client_id AS clientId, ps.company_id AS companyId,
  ps.local, ps.work_date AS workDate, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
  ps.schedule_start_minutes AS scheduleStartMinutes,
  ps.schedule_end_minutes AS scheduleEndMinutes,
  ps.status, ps.error_message AS errorMessage, ps.amount, ps.imported_at AS importedAt,
  ps.previous_shift_id AS previousShiftId, ps.extra_data AS extraData,
  ps.edited_manually AS editedManually,
  ps.source_row_number AS sourceRowNumber, ps.source_sheet_name AS sourceSheetName,
  sf.file_name AS sourceFileName, sf.source_url AS sourceUrl
`;

const PAYMENT_SHIFT_FROM_CLAUSE = `
  FROM payment_shifts ps
  JOIN employees e ON e.id = ps.employee_id
  LEFT JOIN source_files sf ON sf.id = ps.source_file_id
  LEFT JOIN roles r ON r.id = ps.role_id
`;

type PaymentShiftRowRaw = Omit<PaymentShiftRow, "extraData" | "editedManually"> & {
  extraData: string | null;
  editedManually: number;
};

/** `extra_data` is stored as a JSON string (or NULL), `edited_manually` as a 0/1 integer — normalized once here so every reader gets the real shape. */
function parsePaymentShiftRow(row: PaymentShiftRowRaw): PaymentShiftRow {
  return { ...row, extraData: row.extraData ? JSON.parse(row.extraData) : null, editedManually: Boolean(row.editedManually) };
}

export interface PaymentShiftGroupRow extends PaymentShiftRow {
  /** Same idea as `PaymentShiftReportRow.shiftPeriod` — computed in SQL, `null` when there's no schedule to classify. */
  shiftPeriod: ShiftPeriod | null;
}

type PaymentShiftGroupRowRaw = Omit<PaymentShiftGroupRow, "extraData" | "editedManually"> & {
  extraData: string | null;
  editedManually: number;
};

/**
 * Every *current* shift (see `HEAD_SHIFT_CONDITION`) for one colaborador in
 * one competência ("YYYY-MM") matching the Pagamentos list's filters — the
 * turnos shown when a grouped row is expanded inline. Unlike the old
 * per-page `listPaymentShiftsForEmployeeMonth` this replaces, filtering
 * happens here in SQL (same conditions as `listPaymentShiftsFlat`) instead
 * of being reapplied in JS after an unfiltered fetch — an expanded group
 * shows exactly the turnos the active filters would also select in
 * "desagrupado" mode, not the group's full unfiltered contents.
 */
export async function listPaymentShiftsForGroup(
  employeeId: number,
  competencia: string,
  filters: Pick<
    ListPaymentShiftSummariesQuery,
    "statuses" | "shiftPeriods" | "scheduleTimeFilter" | "periodStart" | "periodEnd"
  >,
): Promise<PaymentShiftGroupRow[]> {
  if (filters.statuses.length === 0 || filters.shiftPeriods.length === 0) return [];

  const db = await getDb();
  const params: (string | number)[] = [employeeId, competencia];
  const conditions = [
    "ps.employee_id = $1",
    "strftime('%Y-%m', ps.work_date) = $2",
    ...buildPaymentShiftRowConditions(filters, params),
  ];
  const rows = await db.select<PaymentShiftGroupRowRaw[]>(
    `SELECT ${PAYMENT_SHIFT_SELECT_COLUMNS}, ${shiftPeriodSelectSql()} AS shiftPeriod
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN companies c ON c.id = ps.company_id
     JOIN clients cl ON cl.id = ps.client_id
     LEFT JOIN source_files sf ON sf.id = ps.source_file_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ps.work_date, ps.id`,
    params,
  );
  return rows.map((r) => ({ ...parsePaymentShiftRow(r), shiftPeriod: r.shiftPeriod }));
}

/**
 * A single shift by id, current or superseded — used to open the "ver
 * status anterior" link on a `pago` row, which points at a row that
 * `listPaymentShiftsForGroup`/`listPaymentShiftsFlat` no longer return on
 * their own since it's not a head row anymore.
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
  /** Snapshotted, carried forward unchanged by every plain status/value transition below — only `applyAutoSyncedFieldUpdate` (a real re-sync against the source file) is allowed to replace it, with a freshly resolved route. */
  clientId: number;
  companyId: number;
  local: string;
  workDate: string;
  /** The função turno, as a role_id only — no raw-text column exists anymore, same as `employeeId`. Carried forward unchanged by every plain status/value transition; only `editPaymentShift`/`applyAutoSyncedFieldUpdate` (which can change the função) re-resolve it instead of copying it. */
  roleId: number | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  /** Raw JSON string as stored (or NULL) — passed straight through into the new row, not re-parsed, since a status transition never changes what was in the original file. */
  extraData: string | null;
  status: PaymentShiftStatus;
  sourceRowNumber: number | null;
  sourceSheetName: string | null;
  /** Only read by `applyAutoSyncedFieldUpdate` (to preserve a paid shift's recorded amount across an auto-synced field fix) — every other caller of `readPaymentShiftCoreFields` supplies its own `amount` explicitly instead of carrying this one over. */
  amount: number | null;
  /** 0/1 as stored — read so `markPaymentShiftPaid`/`revertPaymentShiftToPending` can carry it forward instead of forcing it, since neither of those touches a field (see their own doc comments for why forcing it was wrong). */
  editedManually: number;
  /** Only read by `undoPaymentShiftAuditError`, to walk back one hop and recover the `pago` row's original amount — every other caller ignores it. */
  previousShiftId: number | null;
}

/** Shared by every status-transition function below — the fields that always carry over unchanged into the new row. */
async function readPaymentShiftCoreFields(db: Database, shiftId: number): Promise<PaymentShiftCoreFields> {
  const rows = await db.select<PaymentShiftCoreFields[]>(
    `SELECT employee_id AS employeeId, template_id AS templateId, source_file_id AS sourceFileId,
            client_id AS clientId, company_id AS companyId,
            local, work_date AS workDate, role_id AS roleId,
            schedule_start_minutes AS scheduleStartMinutes, schedule_end_minutes AS scheduleEndMinutes,
            extra_data AS extraData, status,
            source_row_number AS sourceRowNumber, source_sheet_name AS sourceSheetName, amount,
            edited_manually AS editedManually, previous_shift_id AS previousShiftId
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
 *
 * `edited_manually` is INHERITED from `shiftId`, not forced to `1` — paying
 * a shift doesn't itself edit any field, so a plain "Fazer pagamento" on an
 * untouched import shouldn't read as "editado manualmente" in the UI. A
 * paid shift is still unconditionally protected from reimport supersession
 * on its own merit (`status === 'pago'`, checked directly by
 * `findDuplicatePaymentShifts`'s callers and `canAutoApply`'s
 * `autoApplyOverwritePaid` gate) — that protection was never what
 * `edited_manually` needed to carry. What it SHOULD carry forward is a real
 * prior hand-edit: if `shiftId` was itself `editPaymentShift`'d before being
 * paid, that fact isn't erased by paying it.
 */
export async function markPaymentShiftPaid(shiftId: number, amount: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pago', $11, $12, $13, $14, $15, $16)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.clientId,
      s.companyId,
      s.local,
      s.workDate,
      s.roleId,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      amount,
      shiftId,
      s.extraData,
      s.editedManually,
      s.sourceRowNumber,
      s.sourceSheetName,
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
 *
 * `edited_manually` is INHERITED from `shiftId`, same reasoning as
 * `markPaymentShiftPaid`: reverting doesn't edit a field, so it shouldn't
 * force the flag on. But it shouldn't force it OFF either — if `shiftId`'s
 * own chain was manually edited before being paid, that protection has to
 * survive the revert, not reset just because the row passed through
 * `status = 'pago'` on the way. Inheriting is what makes that automatic
 * either direction: pay, then revert, then pay again all just carry
 * whatever the flag already was.
 */
export async function revertPaymentShiftToPending(shiftId: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendente', NULL, $11, $12, $13, $14, $15)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.clientId,
      s.companyId,
      s.local,
      s.workDate,
      s.roleId,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      shiftId,
      s.extraData,
      s.editedManually,
      s.sourceRowNumber,
      s.sourceSheetName,
    ],
  );
  return result.lastInsertId as number;
}

/** Shown alongside the "Erro" badge on the Pagamentos page for a shift `markPaymentShiftAuditError` transitioned — same spot `error_message` already shows an import-time parse failure in. */
const AUDIT_ERROR_MESSAGE = "Marcado como erro na Conferência de Pagamentos.";

/**
 * "Marcar erro" in "Conferência de Pagamentos": same append-only transition
 * as `revertPaymentShiftToPending`, but to `erro` instead of `pendente` —
 * a bank-statement mismatch needs the same "fix the data, pay again" path
 * every other `erro` shift already gets (see `canEdit` in the Pagamentos
 * page's `ShiftRow`), not just a passive audit label. `amount` is cleared,
 * same reasoning as reverting to `pendente`: the old paid amount is no
 * longer the record of anything real once the shift needs correcting.
 * Pairs with `undoPaymentShiftAuditError` for "Desfazer".
 */
export async function markPaymentShiftAuditError(shiftId: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, error_message, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'erro', $11, NULL, $12, $13, $14, $15, $16)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.clientId,
      s.companyId,
      s.local,
      s.workDate,
      s.roleId,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      AUDIT_ERROR_MESSAGE,
      shiftId,
      s.extraData,
      s.editedManually,
      s.sourceRowNumber,
      s.sourceSheetName,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * "Desfazer" on a shift `markPaymentShiftAuditError` transitioned: mints a
 * new `pago` row (same append-only shape, never mutating `shiftId`'s own
 * `erro` row) with the amount read back from the `pago` row that `erro` one
 * superseded — one hop back via `previousShiftId`, always set since only
 * `markPaymentShiftAuditError` ever produces this shape. The audit verdict
 * itself is cleared separately by the caller (`deletePaymentAudit`), same as
 * every other "Desfazer" — this only reverses the `payment_shifts` side.
 */
export async function undoPaymentShiftAuditError(shiftId: number): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);
  if (s.previousShiftId === null) {
    throw new Error("Não foi possível encontrar o pagamento original para restaurar.");
  }
  const previous = await readPaymentShiftCoreFields(db, s.previousShiftId);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pago', $11, $12, $13, $14, $15, $16)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.clientId,
      s.companyId,
      s.local,
      s.workDate,
      s.roleId,
      s.scheduleStartMinutes,
      s.scheduleEndMinutes,
      previous.amount,
      shiftId,
      s.extraData,
      s.editedManually,
      s.sourceRowNumber,
      s.sourceSheetName,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * Records "Conferência de Pagamentos"'s manual bank-statement verdict for a
 * `pago` shift — an upsert, not a plain insert: a shift already audited as
 * `confirmado` can still be corrected to `erro` later ("achei que tinha
 * batido, mas na verdade não bateu"), which just overwrites the existing
 * `payment_audits` row via `UNIQUE(payment_shift_id)`'s own `ON CONFLICT`
 * (see the 0074 migration) rather than erroring — `audited_at` is bumped to
 * now on the update branch too, since SQLite's column `DEFAULT` only ever
 * applies to a fresh `INSERT`, not the `UPDATE` half of an upsert.
 */
export async function recordPaymentAudit(paymentShiftId: number, result: PaymentAuditResult, note: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO payment_audits (payment_shift_id, result, note)
     VALUES ($1, $2, $3)
     ON CONFLICT(payment_shift_id) DO UPDATE SET result = excluded.result, note = excluded.note, audited_at = datetime('now')`,
    [paymentShiftId, result, note],
  );
}

/** The recorded audit verdict, if any, for each given `payment_shifts.id` — at most one per id (UNIQUE constraint). */
export async function listPaymentAuditsForShiftIds(shiftIds: number[]): Promise<PaymentAuditRow[]> {
  if (shiftIds.length === 0) return [];
  const db = await getDb();
  const placeholders = shiftIds.map((_, i) => `$${i + 1}`).join(", ");
  return db.select<PaymentAuditRow[]>(
    `SELECT id, payment_shift_id AS paymentShiftId, result, note, audited_at AS auditedAt
     FROM payment_audits
     WHERE payment_shift_id IN (${placeholders})`,
    shiftIds,
  );
}

/**
 * "Desfazer" — clears a `payment_audits` verdict (either result) so the
 * shift goes back to "não conferido". A `confirmado` verdict never touched
 * `payment_shifts`, so this alone is enough to reverse it; an `erro` one did
 * (see `markPaymentShiftAuditError`), so the caller pairs this with
 * `undoPaymentShiftAuditError` first — this function only ever clears the
 * audit row itself, for either case.
 */
export async function deletePaymentAudit(paymentShiftId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM payment_audits WHERE payment_shift_id = $1`, [paymentShiftId]);
}

/**
 * Manually overrides a shift's own data (Data/Local/Função/Horário/Valor) —
 * same append-only pattern as "Fazer pagamento"/"Voltar para pendente": a
 * brand-new row carrying the given fields and `previousShiftId` linked back
 * to `shiftId`, whose own row is left untouched. Status carries over
 * unchanged (unlike those other two transitions, which each force a
 * specific status) — this only ever corrects the shift's own data, never
 * its state. `amount: null` means "keep computing it live from the
 * company's rules" (the pre-edit default for `pendente`/`erro` shifts), not
 * "zero" — only a non-null `amount` freezes a manual override.
 *
 * Only for `pendente`/`erro` shifts — once a shift is `pago` its data (and
 * amount) is the historical record of what was actually paid and must
 * never be edited, so this refuses to touch one.
 */
export async function editPaymentShift(
  shiftId: number,
  fields: {
    workDate: string;
    local: string;
    role: string;
    scheduleStartMinutes: number | null;
    scheduleEndMinutes: number | null;
    amount: number | null;
  },
): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);
  if (s.status === "pago") throw new Error("Não é possível editar um turno já pago.");

  // Função is only ever a role_id now — the edited text must resolve to a
  // cadastro (by name or apelido, scoped to this shift's própria empresa)
  // or be blank (clearing the função), same requirement the import flow's
  // "função não encontrada" block already enforces at import time.
  const trimmedRole = fields.role.trim();
  let roleId: number | null = null;
  if (trimmedRole) {
    const role = await findRoleByName(s.companyId, trimmedRole);
    if (!role) {
      throw new Error(`Função "${trimmedRole}" não encontrada. Cadastre-a em Funções antes de vincular a este turno.`);
    }
    roleId = role.id;
  }

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $16)`,
    [
      s.employeeId,
      s.templateId,
      s.sourceFileId,
      s.clientId,
      s.companyId,
      fields.local,
      fields.workDate,
      roleId,
      fields.scheduleStartMinutes,
      fields.scheduleEndMinutes,
      s.status,
      fields.amount,
      shiftId,
      s.extraData,
      s.sourceRowNumber,
      s.sourceSheetName,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * The auto-apply counterpart to `editPaymentShift` — same append-only
 * pattern (new row, `previous_shift_id` linked back to `shiftId`), but for
 * `computeReimportDiff`'s `AutoApplyOptions` writing a change it found
 * straight to the database instead of leaving it pending for manual review.
 * Two deliberate differences from `editPaymentShift`:
 *
 * 1. No `status === 'pago'` guard — the caller (`computeReimportDiff`) is
 *    what decides whether touching a paid shift's fields is allowed
 *    (`autoApplyOverwritePaid`), so this stays purely mechanical. `status`
 *    itself is still a caller-supplied field here (unlike `editPaymentShift`,
 *    which always carries the old status forward) since a field-diff sync
 *    can legitimately change it — except a paid shift's status is never
 *    part of a diff in the first place (see `computeReimportDiff`), so in
 *    practice a 'pago' row's status always comes back as 'pago' here too.
 * 2. `amount` is read from the CURRENT row and carried forward untouched,
 *    never overwritten — auto-apply only ever syncs fields the source file
 *    actually encodes (data/local/função/horário/extras/status), and the
 *    paid amount is not one of them (see `savePaymentShifts`, which has no
 *    `amount` column at all — this is the one write path that has to be
 *    careful not to repeat that gap for an ALREADY-paid shift).
 *
 * `edited_manually` is left `0` unconditionally (unlike `editPaymentShift`,
 * which always sets it `1`) — this row's data still authoritatively comes
 * from the tracked file, not a human decision, so it stays eligible for a
 * future auto-apply or manual reimport to correct again, instead of being
 * permanently "protected" the way a genuine manual edit is.
 */
export async function applyAutoSyncedFieldUpdate(
  shiftId: number,
  fields: {
    workDate: string;
    local: string;
    role: string;
    scheduleStartMinutes: number | null;
    scheduleEndMinutes: number | null;
    status: PaymentShiftStatus;
    extraData: Record<string, string> | null;
    /** Fresh, from this line's own re-resolved route — NOT carried over from `readPaymentShiftCoreFields`, unlike every other field this function shares with `editPaymentShift`. This is what lets a re-sync notice "the routing rule changed, this shift belongs to a different client/empresa now". */
    clientId: number;
    companyId: number;
  },
  sourceFileId: number,
  sourceRowNumber: number | null,
  sourceSheetName: string | null,
): Promise<number> {
  const db = await getDb();
  const s = await readPaymentShiftCoreFields(db, shiftId);
  // Re-resolved against `fields.companyId` (this sync's own fresh route),
  // not `s.companyId` — same reasoning as `fields.clientId`/`fields.companyId`
  // themselves being fresh instead of carried over: a routing change can
  // move this shift to a different empresa, whose função cadastro is a
  // different scope entirely.
  const role = await findRoleByName(fields.companyId, fields.role);

  const result = await db.execute(
    `INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data,
        edited_manually, source_row_number, source_sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16)`,
    [
      s.employeeId,
      s.templateId,
      sourceFileId,
      fields.clientId,
      fields.companyId,
      fields.local,
      fields.workDate,
      role?.id ?? null,
      fields.scheduleStartMinutes,
      fields.scheduleEndMinutes,
      fields.status,
      s.amount,
      shiftId,
      fields.extraData ? JSON.stringify(fields.extraData) : null,
      sourceRowNumber,
      sourceSheetName,
    ],
  );
  return result.lastInsertId as number;
}

/**
 * Walks the append-only chain backward from `shiftId` via
 * `previousShiftId`, returning every row from most recent to oldest
 * (including `shiftId` itself) — the full "Status anterior" history for a
 * shift, not just one hop back, since a shift can be paid, reverted to
 * pendente, and paid again more than once. A single recursive query, not
 * a loop of one-row `getPaymentShift` calls. The recursion is only needed
 * to find *which* rows belong to this chain (they're scattered across the
 * table, linked by `previous_shift_id` pointers, not selectable by a plain
 * WHERE) — once that set is known, ordering is a plain `ORDER BY ps.id
 * DESC`: a child row's id is always higher than its parent's (the parent
 * has to already exist, with a lower id, before anything can point back to
 * it), which is unambiguous even when two transitions land in the same
 * `imported_at` second (that column has only 1s resolution).
 */
export async function getPaymentShiftHistory(shiftId: number): Promise<PaymentShiftRow[]> {
  const db = await getDb();
  const rows = await db.select<PaymentShiftRowRaw[]>(
    `WITH RECURSIVE chain(id) AS (
       SELECT $1
       UNION ALL
       SELECT ps.previous_shift_id
       FROM payment_shifts ps
       JOIN chain ON chain.id = ps.id
       WHERE ps.previous_shift_id IS NOT NULL
     )
     SELECT ${PAYMENT_SHIFT_SELECT_COLUMNS}
     ${PAYMENT_SHIFT_FROM_CLAUSE}
     JOIN chain ON chain.id = ps.id
     ORDER BY ps.id DESC`,
    [shiftId],
  );
  return rows.map(parsePaymentShiftRow);
}

/**
 * "Remover": soft-deletes a shift AND its entire append-only history chain
 * — every row reachable by walking `previous_shift_id` backward from
 * `shiftId` (same chain `getPaymentShiftHistory` walks), not just the row
 * itself. Works the same whether the row came from an import or from a
 * manual edit/pagamento — both live in this same table (see
 * `savePaymentShifts`/`markPaymentShiftPaid`'s own doc comments), there is
 * no separate "manual" storage to also clean up.
 *
 * Sets `deleted_at` rather than physically deleting — `HEAD_SHIFT_CONDITION`
 * excludes it, so it disappears from every normal list/summary/report just
 * like a hard delete would, but the row (and its history) is still there
 * for `findDuplicatePaymentShifts` to find. That's deliberate: without it,
 * reimporting the same source file later would have no way to know this
 * shift ever existed and would just silently recreate it. Kept as data,
 * this way it instead shows up in the import preview flagged "excluído",
 * unselected by default, so the user gets a chance to review it instead of
 * it either reappearing unannounced or disappearing forever.
 */
export async function deletePaymentShift(shiftId: number): Promise<void> {
  const db = await getDb();

  const ids = new Set<number>([shiftId]);
  let currentId: number | null = shiftId;
  while (currentId !== null) {
    const rows: { previousShiftId: number | null }[] = await db.select(
      "SELECT previous_shift_id AS previousShiftId FROM payment_shifts WHERE id = $1",
      [currentId],
    );
    const previousId: number | null = rows[0]?.previousShiftId ?? null;
    if (previousId === null || ids.has(previousId)) break;
    ids.add(previousId);
    currentId = previousId;
  }

  const idList = [...ids];
  const placeholders = idList.map((_, i) => `$${i + 1}`).join(", ");
  await db.execute(`UPDATE payment_shifts SET deleted_at = datetime('now') WHERE id IN (${placeholders})`, idList);
}

/** Which columns of the Pagamentos table are shown — `null` means every column (the default, and what a fresh install has). */
export async function getPaymentVisibleColumns(): Promise<string[] | null> {
  const db = await getDb();
  const rows = await db.select<{ visibleColumnsJson: string | null }[]>(
    "SELECT visible_columns_json AS visibleColumnsJson FROM payment_settings WHERE id = 1",
  );
  const json = rows[0]?.visibleColumnsJson ?? null;
  return json ? JSON.parse(json) : null;
}

/** Persists the Pagamentos table's column visibility — saved immediately on every toggle, not behind a "Salvar" button, same as the other filter state that lives in `FiltersContext`. */
export async function setPaymentVisibleColumns(columns: string[]): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE payment_settings SET visible_columns_json = $1, updated_at = datetime('now') WHERE id = 1",
    [JSON.stringify(columns)],
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
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Flushes any WAL contents into the main file — call before copying `pontoscan.db` directly (export) so the single file is a complete, self-contained snapshot instead of missing whatever's still sitting in `-wal`. */
export async function checkpointDatabase(): Promise<void> {
  const db = await getDb();
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Closes the live connection — call before replacing the underlying `pontoscan.db` file (import) so nothing here still holds it open when the app relaunches onto the new one. */
export async function closeDatabase(): Promise<void> {
  const db = await getDb();
  await db.close();
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
  /** Keep `payment_shifts` rows with `edited_manually` set (see the manual transition functions above) instead of wiping every one — only meaningful alongside `keepEmployees` (a kept shift's `employee_id` is `NOT NULL`), enforced by the caller disabling the checkbox rather than here. */
  keepManuallyEditedShifts?: boolean;
}

export interface DatabaseTableSize {
  tableName: string;
  bytes: number;
}

/**
 * Per-table disk usage, largest first — an index's own pages are rolled
 * into the table it belongs to (via a `sqlite_master` join) rather than
 * listed as their own line, since "how big is this index" isn't a question
 * the "o que está pesando no banco" breakdown in Configurações is trying to
 * answer. Backed by `dbstat`, a read-only virtual table SQLite exposes when
 * built with `SQLITE_ENABLE_DBSTAT_VTAB` (true of every build this app
 * ships, both `sqlx-sqlite`'s bundled SQLite and the system `sqlite3` CLI).
 */
export async function getDatabaseTableSizes(): Promise<DatabaseTableSize[]> {
  const db = await getDb();
  return db.select<DatabaseTableSize[]>(
    `SELECT m.tbl_name AS tableName, SUM(d.pgsize) AS bytes
     FROM dbstat d
     JOIN sqlite_master m ON m.name = d.name
     WHERE m.type IN ('table', 'index')
     GROUP BY m.tbl_name
     ORDER BY bytes DESC`,
  );
}

/**
 * Maps an `imports/`-copied file's on-disk (uuid) basename back to the
 * human name it was originally picked/downloaded as, for the "PDFs
 * importados" breakdown in Configurações — `source_files.original_pdf_path`
 * only ever gets populated for a locally-picked timesheet PDF (see every
 * `logSourceFile` caller), so a payment file downloaded by URL won't
 * resolve here; the caller falls back to the raw filename in that case.
 */
export async function getImportedFileNamesByBasename(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.select<{ path: string; fileName: string }[]>(
    "SELECT original_pdf_path AS path, file_name AS fileName FROM source_files WHERE original_pdf_path != ''",
  );
  const byBasename = new Map<string, string>();
  for (const row of rows) {
    const basename = row.path.split(/[/\\]/).pop();
    if (basename) byBasename.set(basename, row.fileName);
  }
  return byBasename;
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
  const keepManuallyEditedShifts = Boolean(options.keepManuallyEditedShifts) && keepEmployees;

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
  if (keepManuallyEditedShifts) {
    // A kept row still loses its own links into what's actually being wiped
    // right here — source_files always goes, and template_id only survives
    // when keepPaymentTemplates is also on — otherwise it'd be a FK
    // pointing at nothing. employee_id is left alone: it's NOT NULL, so a
    // kept row requires keepEmployees, which the caller already guarantees.
    await db.execute(
      `UPDATE payment_shifts SET source_file_id = NULL${keepPaymentTemplates ? "" : ", template_id = NULL"}
       WHERE edited_manually = 1`,
    );
    await db.execute("DELETE FROM payment_shifts WHERE edited_manually = 0");
  } else {
    await db.execute("DELETE FROM payment_shifts");
  }
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
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}
