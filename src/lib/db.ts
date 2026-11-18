import { invoke } from "@tauri-apps/api/core";
import { emit } from "./events";
import Database from "@tauri-apps/plugin-sql";
import { overtimeMinutesForDay, sumIntervalMinutes } from "./analysis";
import type { PeriodStatusId } from "./periodStatus";
import { api, ApiError, rpc } from "./http";
import type { PixKeyType } from "./pix";
import type {
  ConflictInfo,
  DuplicateFileInfo,
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
  PaymentExportTemplateInput,
  PaymentExportTemplateListRow,
  PaymentExportTemplateRow,
  PaymentFileKind,
  PaymentPdfTemplateInput,
  PaymentPdfTemplateListRow,
  PaymentPdfTemplateRow,
  PaymentRuleCondition,
  PaymentTemplateGroup,
  PaymentTemplateListRow,
  PaymentTemplateRow,
  PaymentTemplateRuleKind,
  PaymentShiftRow,
  PaymentShiftStatus,
  PaymentShiftSummaryRow,
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

/** `{ $lastInsertId: n }` stands for the id the batch's own statement `n` (0-based) inserted. */
type BatchParam = string | number | null | { $lastInsertId: number };
interface BatchStatement {
  sql: string;
  params?: BatchParam[];
  /** Error to fail (and roll back) the whole batch with when this statement changes no rows. */
  expectChanges?: string;
}

/**
 * Runs `statements` as ONE transaction (see `run_write_batch` in
 * src-tauri/src/db_batch.rs) — all of them apply or, on the first error,
 * none do. Use for any write that spans several statements: separate
 * `db.execute` calls can't share a transaction, since the plugin hands each
 * one to whichever pooled connection is free.
 */
async function runWriteBatch(
  statements: BatchStatement[],
): Promise<{ rowsAffected: number; lastInsertId: number }[]> {
  // The batch runs on the pool `Database.load` registers — make sure it exists.
  await getDb();
  return invoke("run_write_batch", { db: DB_URL, statements });
}

/**
 * Broadcast (via Tauri's global event bus, reaching every open window —
 * the main one and a detached "Conferência de Pagamentos" window alike)
 * whenever a mutation changes what a `payment_shifts`/`payment_audits`
 * -backed list shows. `PaymentReconciliationScreen`/`PaymentsPage` each
 * listen for this to refetch, instead of the two windows only ever seeing
 * their own local changes. Fire-and-forget: nothing downstream needs to
 * await delivery, and a dropped event just means that window is stale
 * until its next refetch, not a correctness issue.
 */
export const PAYMENT_SHIFTS_CHANGED_EVENT = "payment-shifts-changed";
function notifyPaymentShiftsChanged(): void {
  emit(PAYMENT_SHIFTS_CHANGED_EVENT).catch(() => {});
}

/**
 * Awaits a shift transition and then broadcasts the change — also when the
 * server refused it because another writer superseded that shift first
 * (409): the desktop emitted right after the INSERT ran, before throwing
 * that error, so the other windows refresh in that case too.
 */
async function withShiftsChangedNotice(call: Promise<number>): Promise<number> {
  try {
    const id = await call;
    notifyPaymentShiftsChanged();
    return id;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) notifyPaymentShiftsChanged();
    throw error;
  }
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
  return rpc<number>("logSourceFile", { input });
}

/**
 * Marks that at least one sheet from this original file was actually saved.
 * The "já importado, não reprocessar" pre-check keys off this — a file can
 * parse fine (and show up in history) without ever being saved, and in
 * that case it should still be reprocessable.
 */
export async function markSourceFileSaved(fileHash: string): Promise<void> {
  await rpc<void>("markSourceFileSaved", { fileHash });
}

export async function deleteImport(importId: number): Promise<void> {
  await rpc<void>("deleteImport", { importId });
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
  // Computed once, here, at import time, over the whole (fixed) period —
  // the UI reads these instead of scanning day_records on every render.
  // `maxPunches` floors at 4 (2 pairs), matching the fixed grid the PDF
  // itself always has, even on days that leave it unfilled. Pure
  // computation, so it stays here (analysis.ts) and the server stores it.
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

  // The server validates the cliente/empresa pair, upserts the employee and
  // import file, and removes `replaceImportId` + writes the new rows, all in
  // one transaction.
  return rpc<number>("saveParsedTimesheet", {
    sheet,
    clientId,
    companyId,
    replaceImportId: replaceImportId ?? null,
    sourceFileId: sourceFileId ?? null,
    aggregates: {
      maxPunches,
      totalWorkedMinutes,
      overtimeMinutes,
      absenceMinutes,
      lateMinutes,
      regularMinutes,
      intervalMinutes,
      pendingCount,
    },
  });
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
  return api.get<CompanyRow[]>("/companies");
}

/** Full company detail, including its optional pay-value chain — only `getCompany` fetches this; `listCompanies` stays lightweight for dropdowns. */
export interface CompanyDetail extends CompanyRow {
  valueRules: PaymentValueRule[];
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
  const { id } = await api.post<{ id: number }>("/companies", { name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRules });
  return id;
}

export async function getCompany(id: number): Promise<CompanyDetail> {
  return api.get<CompanyDetail>(`/companies/${id}`);
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
  await api.put<void>(`/companies/${id}`, { name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRules });
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
  return rpc<ClientRow[]>("listClients");
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
  return rpc<number>("createClient", { companyIds, name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRules });
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

export async function getClient(id: number): Promise<ClientDetail> {
  return rpc<ClientDetail>("getClient", { id });
}

/** Links `clientId` to an additional `companyId` — a no-op if already linked. */
export async function addClientCompany(clientId: number, companyId: number): Promise<void> {
  await rpc<void>("addClientCompany", { clientId, companyId });
}

/**
 * Unlinks `clientId` from `companyId` — rejected if it would leave the
 * client with no empresa at all, or if there are colaboradores already
 * registered under that specific (client, empresa) pair, since removing
 * the link would leave their `company_id` pointing somewhere the client
 * itself no longer claims to belong to.
 */
export async function removeClientCompany(clientId: number, companyId: number): Promise<void> {
  await rpc<void>("removeClientCompany", { clientId, companyId });
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
  await rpc<void>("updateClient", { id, name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRules });
}

/** The night-shift window/rule + pay-value chain actually in effect for one (cliente, empresa) pair — the client's own override when it has one, falling back field-by-field (night window) or as a whole chain (value rules) to the company's otherwise. Mirrored in SQL by `shiftPeriodSql` for night-shift classification (the only one of the two ever resolved SQL-side). */
export interface EffectivePaymentRules {
  nightStartTime: string;
  nightEndTime: string;
  nightShiftRule: NightShiftRule;
  valueRules: PaymentValueRule[];
}

export async function getEffectivePaymentRules(clientId: number, companyId: number): Promise<EffectivePaymentRules> {
  return rpc<EffectivePaymentRules>("getEffectivePaymentRules", { clientId, companyId });
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
  return rpc<PagedResult<EmployeeRow>>("listEmployeesGlobal", { query });
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
  return rpc<EmployeeRow[]>("getEmployeesByIds", { ids });
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
  return rpc<number>("createEmployeeManual", { clientId, companyId, name, cpf, matricula });
}

export async function getEmployee(id: number): Promise<EmployeeRow> {
  return rpc<EmployeeRow>("getEmployee", { id });
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
  await rpc<void>("linkEmployeeToClientCompany", { employeeId, clientId, companyId, matricula });
}

/** Just the matrícula for one of a colaborador's (cliente, empresa) links — the rest of `employee_client_companies` isn't user-editable after creation (the link itself is added/removed via `linkEmployeeToClientCompany`/`unlinkEmployeeClientCompany`). */
export async function updateEmployeeClientCompanyMatricula(
  employeeId: number,
  clientId: number,
  companyId: number,
  matricula: string | null,
): Promise<void> {
  await rpc<void>("updateEmployeeClientCompanyMatricula", { employeeId, clientId, companyId, matricula });
}

/**
 * Removes one of a colaborador's (cliente, empresa) links — refuses to drop
 * the last one, since a colaborador with zero links can't be resolved by
 * any future import (every import path requires a resolved cliente+empresa
 * pair).
 */
export async function unlinkEmployeeClientCompany(employeeId: number, clientId: number, companyId: number): Promise<void> {
  await rpc<void>("unlinkEmployeeClientCompany", { employeeId, clientId, companyId });
}

/**
 * Updates name/CPF only — every (cliente, empresa) link and its matrícula
 * is managed separately (`linkEmployeeToClientCompany`/
 * `unlinkEmployeeClientCompany`/`updateEmployeeClientCompanyMatricula`)
 * since there can be more than one, and none of them are "the" identity
 * anymore — CPF alone is (see 0072_employee_client_link.sql).
 */
export async function updateEmployee(id: number, name: string, cpf: string): Promise<void> {
  await rpc<void>("updateEmployee", { id, name, cpf });
}

/**
 * Hard-deletes a colaborador and everything tied to them: cartões de ponto
 * (imports, plus their day_records/punches), turnos de pagamento
 * (payment_shifts — the real rows, not the usual soft `deleted_at`, since
 * there's no colaborador left for a soft-deleted row to still belong to),
 * apelidos, and cliente/empresa links. Cascades done by hand rather than
 * relying on `ON DELETE CASCADE`, same reasoning as `deleteImport` — sqlite
 * only enforces foreign keys when `PRAGMA foreign_keys = ON` was set on the
 * connection, which isn't guaranteed here. Irreversible — and so refused
 * for a colaborador with any paid shift in their history unless `allowPaid`.
 */
export interface EmployeeDeletionImpact {
  /** Rows with status 'pago' anywhere in the colaborador's shift chains — a payment that was later reverted still counts. Non-zero means deleting needs `allowPaid`. */
  paymentRecords: number;
  /** Current (head, not removed) shifts — what Pagamentos lists for them. */
  shifts: number;
  /** Of `shifts`, the ones currently paid, and their total. */
  paidShifts: number;
  paidAmount: number;
  timesheets: number;
  pixKeys: number;
}

/** What `deleteEmployee` would erase — shown before a delete so the user sees exactly what goes with it. */
export async function getEmployeeDeletionImpact(employeeId: number): Promise<EmployeeDeletionImpact> {
  return rpc<EmployeeDeletionImpact>("getEmployeeDeletionImpact", { employeeId });
}

export async function deleteEmployee(employeeId: number, options: { allowPaid?: boolean } = {}): Promise<void> {
  await rpc<void>("deleteEmployee", { employeeId, options });
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
  await rpc<void>("reassignEmployeeHistoryToClientCompany", { employeeId, newClientId, newCompanyId, periodStart, periodEnd });
}

export async function getImportById(id: number): Promise<StoredImport | null> {
  return rpc<StoredImport | null>("getImportById", { id });
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

type ImportScopeQuery = Pick<ListImportsQuery, "employeeIds" | "companyIds" | "clientIds" | "periodStart" | "periodEnd">;

/**
 * How many imports in scope match each "Status no período" category, for
 * the counts on the status chips. Ignores the status filter itself, so
 * each count says what picking that chip alone would bring in.
 */
export async function countImportsByStatus(query: ImportScopeQuery): Promise<Record<PeriodStatusId, number>> {
  return rpc<Record<PeriodStatusId, number>>("countImportsByStatus", { query });
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
  return rpc<PagedResult<StoredImport>>("listImports", { query });
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
  return rpc<StoredDayRecord[]>("listStoredDayRecords", { filters });
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
  const byHash = await rpc<Record<string, DuplicateFileInfo>>("findDuplicateFiles", { hashes });
  return new Map(Object.entries(byHash));
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
  return rpc<{ importId: number; periodStart: string; periodEnd: string; importedAt: string } | null>("findConflictingImport", {
    employeeCpf,
    clientId,
    companyId,
    periodStart,
    periodEnd,
  });
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
  return rpc<ConflictInfo[]>("findConflicts", { sheets, clientId, companyId });
}

export interface ImportFilesQuery {
  importType: ImportType;
  /** Substring match on file name or provider/template — case-insensitive only for ASCII (SQLite's `LOWER()` doesn't case-fold accents). */
  search?: string;
  /** "link": downloaded from a URL; "local": picked from disk. */
  source?: "link" | "local";
  /** Only files whose import didn't fully succeed (warning or error). */
  problemsOnly?: boolean;
  page: number;
  pageSize: number;
}

export interface ImportFileCounts {
  total: number;
  link: number;
  local: number;
  problems: number;
}

/** Per-filter counts for the import history's chips (unaffected by search). */
export async function countImportFiles(importType: ImportType): Promise<ImportFileCounts> {
  return rpc<ImportFileCounts>("countImportFiles", { importType });
}

/**
 * The import history for one import flow (timesheet or payment), most
 * recent first — filtered and paginated in SQL, not in memory.
 */
export async function listImportFiles(query: ImportFilesQuery): Promise<PagedResult<ImportFileRow>> {
  return rpc<PagedResult<ImportFileRow>>("listImportFiles", { query });
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

/** "month" = "Mês atual": from the 1st of the current month to today (see `resolveReimportPeriod`). */
export type ReimportDateMode = "fixed" | "relative" | "month";

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
  // Unlike source_url_check_diffs (which keeps a config_label snapshot for
  // audit even after the config is gone), this table has no audit value on
  // its own — it's pure scheduling bookkeeping (see `isConfigDue`), so once
  // the config no longer exists there's nothing left to compute from it.
  await runWriteBatch([
    { sql: "DELETE FROM source_url_check_log_configs WHERE config_id = $1", params: [id] },
    { sql: "DELETE FROM source_url_reimport_configs WHERE id = $1", params: [id] },
  ]);
}

/**
 * Fully stops tracking a URL — removes its tracking flag, every one of its
 * reimport configs, and its whole check-log history. Deliberately leaves
 * `source_files`/`payment_shifts` untouched: this is "stop watching this
 * URL," not "undo what was ever imported from it."
 */
export async function untrackPaymentUrl(sourceUrl: string): Promise<void> {
  const params = [sourceUrl];
  await runWriteBatch([
    {
      sql: `DELETE FROM source_url_check_diffs
     WHERE check_log_id IN (SELECT id FROM source_url_check_log WHERE source_url = $1)`,
      params,
    },
    {
      sql: `DELETE FROM source_url_check_log_configs
     WHERE check_log_id IN (SELECT id FROM source_url_check_log WHERE source_url = $1)`,
      params,
    },
    { sql: "DELETE FROM source_url_check_log WHERE source_url = $1", params },
    { sql: "DELETE FROM source_url_reimport_configs WHERE source_url = $1", params },
    { sql: "DELETE FROM source_url_settings WHERE source_url = $1", params },
  ]);
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
  await rpc<void>("trackUrlForAutoReimport", { sourceUrl, templateId, periodStart, periodEnd, keepManualEdits });
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
  /** Who saved the version this check downloaded; `null` when nothing was downloaded or the format says nothing. */
  author: FileAuthor | null = null,
): Promise<number> {
  const db = await getDb();
  const inserted = await db.execute(
    `INSERT INTO source_url_check_log (source_url, file_name, result, message, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sourceUrl, fileName, result, message, author?.savedBy ?? null, author?.savedAt ?? null],
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
  /** Who saved the spreadsheet version this check downloaded (see `FileAuthor`). */
  savedBy: string | null;
  savedAt: string | null;
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
            l.saved_by AS savedBy, l.saved_at AS savedAt,
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
  /** URL/file whose check produced this notification. */
  sourceUrl: string;
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
  /**
   * Who saved the spreadsheet version where this change FIRST showed up,
   * read from the file's properties (only the last person to save before
   * that check is known). `savedAt` null: not known (from before this was
   * recorded, or a format without that property). `savedBy` null with a
   * `savedAt`: saved by a program that wrote no name.
   */
  savedBy: string | null;
  savedAt: string | null;
}

export type CheckDiffInput = Omit<
  CheckDiffRow,
  "id" | "checkLogId" | "sourceUrl" | "dismissedAt" | "periodStart" | "periodEnd" | "savedBy" | "savedAt"
>;

/** Who saved a downloaded spreadsheet, from its own properties — see `read_spreadsheet_author` in Rust. */
export interface FileAuthor {
  savedBy: string | null;
  savedAt: string | null;
}

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
export async function saveCheckDiffs(
  checkLogId: number,
  sourceUrl: string,
  entries: CheckDiffInput[],
  /** Who saved the version this check downloaded — given to each change that shows up for the first time here. */
  author: FileAuthor | null = null,
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  for (const e of entries) {
    const fingerprint = diffContentFingerprint(e);
    const dismissedMatch = await db.select<{ id: number }[]>(
      `SELECT id FROM dismissed_diff_fingerprints WHERE source_url = $1 AND fingerprint = $2 LIMIT 1`,
      [sourceUrl, fingerprint],
    );
    // The same change already seen on an earlier check of this URL keeps the
    // author of the version it first appeared in (even an unknown one, from
    // before authors were recorded): later checks only saw it again.
    const earlier = await db.select<{ savedBy: string | null; savedAt: string | null }[]>(
      `SELECT d.saved_by AS savedBy, d.saved_at AS savedAt
       FROM source_url_check_diffs d
       JOIN source_url_check_log l ON l.id = d.check_log_id
       WHERE l.source_url = $1 AND d.check_log_id < $2 AND ${fingerprintSqlExpr("d.")} = $3
       ORDER BY d.id DESC LIMIT 1`,
      [sourceUrl, checkLogId, fingerprint],
    );
    const savedBy = earlier.length > 0 ? earlier[0].savedBy : (author?.savedBy ?? null);
    const savedAt = earlier.length > 0 ? earlier[0].savedAt : (author?.savedAt ?? null);
    const inserted = await db.execute(
      `INSERT INTO source_url_check_diffs
         (check_log_id, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
          work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
          column_letter, field_name, old_value, new_value, message, applied, saved_by, saved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
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
        savedBy,
        savedAt,
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
    `SELECT d.id, d.check_log_id AS checkLogId, l.source_url AS sourceUrl, d.config_id AS configId, d.config_label AS configLabel,
            d.change_kind AS changeKind, d.matched_shift_id AS matchedShiftId, d.employee_id AS employeeId,
            d.employee_name AS employeeName, d.work_date AS workDate, d.local, d.role,
            d.schedule_start_minutes AS scheduleStartMinutes, d.schedule_end_minutes AS scheduleEndMinutes,
            d.sheet_name AS sheetName, d.row_number AS rowNumber, d.column_letter AS columnLetter,
            d.field_name AS fieldName, d.old_value AS oldValue, d.new_value AS newValue, d.message, d.applied,
            d.dismissed_at AS dismissedAt, jc.period_start AS periodStart, jc.period_end AS periodEnd,
            d.saved_by AS savedBy, d.saved_at AS savedAt
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
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
  return rpc<ShiftFieldDiffRow[]>("listLatestFieldDiffsForShifts", { shiftIds });
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
  return rpc<CheckDiffRow[]>("listAllLatestShiftDiffs");
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
  return rpc<void>("dismissCheckDiffs", { ids });
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
        column_letter, field_name, old_value, new_value, message, applied, dismissed_at, saved_by, saved_at)
     SELECT $2, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
            work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
            column_letter, field_name, old_value, new_value, message, applied,
            CASE WHEN EXISTS (
              SELECT 1 FROM dismissed_diff_fingerprints f
              WHERE f.source_url = $3 AND f.fingerprint = ${fingerprintSqlExpr("")}
            ) THEN datetime('now') ELSE NULL END,
            saved_by, saved_at
     FROM source_url_check_diffs
     WHERE check_log_id = $1`,
    [fromCheckLogId, toCheckLogId, sourceUrl],
  );
  // Same downloaded version, so the same author on the check itself.
  await db.execute(
    `UPDATE source_url_check_log
     SET saved_by = (SELECT saved_by FROM source_url_check_log WHERE id = $1),
         saved_at = (SELECT saved_at FROM source_url_check_log WHERE id = $1)
     WHERE id = $2`,
    [fromCheckLogId, toCheckLogId],
  );
}

/** Batched lookup for the deep-check diff pass — one query for every matched shift's current values instead of N calls to `getPaymentShift`. */
export async function getPaymentShiftsByIds(ids: number[]): Promise<PaymentShiftRow[]> {
  return rpc<PaymentShiftRow[]>("getPaymentShiftsByIds", { ids });
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
  return rpc<PaymentTemplateListRow[]>("listPaymentTemplates");
}

export async function getPaymentTemplate(id: number): Promise<PaymentTemplateRow> {
  return rpc<PaymentTemplateRow>("getPaymentTemplate", { id });
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

export async function createPaymentTemplate(input: PaymentTemplateInput): Promise<number> {
  return rpc<number>("createPaymentTemplate", { input });
}

export async function updatePaymentTemplate(id: number, input: PaymentTemplateInput): Promise<void> {
  await rpc<void>("updatePaymentTemplate", { id, input });
}

/**
 * Deletes the template and its groups/rules (and their sheets/field
 * mappings). Any `payment_shifts` already imported with this template
 * keep existing — they're real payment data, not template config — just
 * lose the (nullable, purely informational) back-reference to it.
 */
export async function deletePaymentTemplate(id: number): Promise<void> {
  await rpc<void>("deletePaymentTemplate", { id });
}

export async function listPaymentExportTemplates(): Promise<PaymentExportTemplateListRow[]> {
  return rpc<PaymentExportTemplateListRow[]>("listPaymentExportTemplates");
}

export async function getPaymentExportTemplate(id: number): Promise<PaymentExportTemplateRow> {
  return rpc<PaymentExportTemplateRow>("getPaymentExportTemplate", { id });
}

export async function createPaymentExportTemplate(input: PaymentExportTemplateInput): Promise<number> {
  return rpc<number>("createPaymentExportTemplate", { input });
}

export async function updatePaymentExportTemplate(id: number, input: PaymentExportTemplateInput): Promise<void> {
  await rpc<void>("updatePaymentExportTemplate", { id, input });
}

/** Creates an independent copy of an export template, including its entire grid configuration. */
export async function clonePaymentExportTemplate(id: number): Promise<number> {
  return rpc<number>("clonePaymentExportTemplate", { id });
}

export async function deletePaymentExportTemplate(id: number): Promise<void> {
  await rpc<void>("deletePaymentExportTemplate", { id });
}

export async function listPaymentPdfTemplates(): Promise<PaymentPdfTemplateListRow[]> {
  return rpc<PaymentPdfTemplateListRow[]>("listPaymentPdfTemplates");
}

export async function getPaymentPdfTemplate(id: number): Promise<PaymentPdfTemplateRow> {
  return rpc<PaymentPdfTemplateRow>("getPaymentPdfTemplate", { id });
}

export async function createPaymentPdfTemplate(input: PaymentPdfTemplateInput): Promise<number> {
  return rpc<number>("createPaymentPdfTemplate", { input });
}

export async function updatePaymentPdfTemplate(id: number, input: PaymentPdfTemplateInput): Promise<void> {
  await rpc<void>("updatePaymentPdfTemplate", { id, input });
}

/** Creates an independent copy of a PDF template, including its entire grid configuration. */
export async function clonePaymentPdfTemplate(id: number): Promise<number> {
  return rpc<number>("clonePaymentPdfTemplate", { id });
}

export async function deletePaymentPdfTemplate(id: number): Promise<void> {
  await rpc<void>("deletePaymentPdfTemplate", { id });
}

export async function listEmployeeTemplates(): Promise<EmployeeTemplateListRow[]> {
  return rpc<EmployeeTemplateListRow[]>("listEmployeeTemplates");
}

export async function getEmployeeTemplate(id: number): Promise<EmployeeTemplateRow> {
  return rpc<EmployeeTemplateRow>("getEmployeeTemplate", { id });
}

export interface EmployeeTemplateInput {
  name: string;
  fileKind: PaymentFileKind;
  acceptedFileKinds: PaymentFileKind[];
  delimiter: string | null;
  identifierPriority: IdentifierAttempt[];
  groups: EmployeeTemplateGroup[];
}

export async function createEmployeeTemplate(input: EmployeeTemplateInput): Promise<number> {
  return rpc<number>("createEmployeeTemplate", { input });
}

export async function updateEmployeeTemplate(id: number, input: EmployeeTemplateInput): Promise<void> {
  await rpc<void>("updateEmployeeTemplate", { id, input });
}

/**
 * Deletes the template and its groups (and their sheets/field mappings).
 * Unlike `deletePaymentTemplate`, there's no back-reference to null out
 * first — employees created via import don't carry a link back to the
 * template that created them.
 */
export async function deleteEmployeeTemplate(id: number): Promise<void> {
  await rpc<void>("deleteEmployeeTemplate", { id });
}

export interface EmployeeImportRow {
  clientId: number;
  companyId: number;
  /** Existing employee resolved during preview; null means create by CPF. */
  employeeId: number | null;
  /** Null means the field was not mapped and the saved value must be preserved. */
  name: string | null;
  cpf: string | null;
  matricula: string | null;
  matriculaMapped: boolean;
  pixKeys: string[];
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
export async function createEmployeesFromImport(rows: EmployeeImportRow[], savedFileHashes: Iterable<string> = []): Promise<void> {
  // `savedFileHashes` may be a Set, which JSON can't carry — send it as an array.
  await rpc<void>("createEmployeesFromImport", { rows, savedFileHashes: Array.from(savedFileHashes) });
}

export interface EmployeePixKeyRow {
  id: number;
  employeeId: number;
  keyValue: string;
  keyType: PixKeyType;
}

export async function listEmployeePixKeys(employeeId: number): Promise<EmployeePixKeyRow[]> {
  return rpc<EmployeePixKeyRow[]>("listEmployeePixKeys", { employeeId });
}

export async function addEmployeePixKey(employeeId: number, rawValue: string, keyType?: PixKeyType): Promise<void> {
  await rpc<void>("addEmployeePixKey", { employeeId, rawValue, keyType });
}

export async function updateEmployeePixKeyType(id: number, keyType: PixKeyType): Promise<void> {
  await rpc<void>("updateEmployeePixKeyType", { id, keyType });
}

export async function removeEmployeePixKey(id: number): Promise<void> {
  await rpc<void>("removeEmployeePixKey", { id });
}

export interface EmployeeAliasRow {
  id: number;
  employeeId: number;
  alias: string;
}

/** Every "possível nome" registered for one colaborador, most recent first. */
export async function listEmployeeAliases(employeeId: number): Promise<EmployeeAliasRow[]> {
  return rpc<EmployeeAliasRow[]>("listEmployeeAliases", { employeeId });
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
  return rpc<{ id: number; name: string } | null>("findEmployeeAliasOwner", { employeeId, alias });
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
  await rpc<void>("addEmployeeAlias", { employeeId, alias });
}

export async function removeEmployeeAlias(aliasId: number): Promise<void> {
  await rpc<void>("removeEmployeeAlias", { aliasId });
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
  return rpc<RoleRow[]>("listRoles", { companyId });
}

/** Every função across every empresa — the Pagamentos "Função" filter's option list, narrowed client-side to whichever empresas are currently selected (same pattern `clientOptions` already uses for Cliente vs Empresa). */
export async function listRolesGlobal(): Promise<RoleRow[]> {
  return rpc<RoleRow[]>("listRolesGlobal");
}

export async function getRole(id: number): Promise<RoleRow> {
  return rpc<RoleRow>("getRole", { id });
}

export async function createRole(companyId: number, name: string): Promise<number> {
  return rpc<number>("createRole", { companyId, name });
}

export async function updateRole(id: number, name: string): Promise<void> {
  await rpc<void>("updateRole", { id, name });
}

/**
 * Deletes a função and its apelidos. Unlike `deleteEmployee`, this doesn't
 * touch `payment_shifts` — a turno isn't "about" its função the way it's
 * about its colaborador, so existing shifts just lose the link
 * (`role_id` → NULL) and keep their raw `role` text untouched, instead of
 * being deleted along with the função.
 */
export async function deleteRole(roleId: number): Promise<void> {
  await rpc<void>("deleteRole", { roleId });
}

export interface RoleAliasRow {
  id: number;
  roleId: number;
  alias: string;
}

/** Every "possível nome" registered for one função, most recent first. */
export async function listRoleAliases(roleId: number): Promise<RoleAliasRow[]> {
  return rpc<RoleAliasRow[]>("listRoleAliases", { roleId });
}

/**
 * Whether `alias` is already registered to some função within `companyId`
 * — `null` when it's free. Scoped per empresa only, same granularity as
 * `roles` itself. Case-insensitive, same ASCII-only limitation already
 * accepted for name search elsewhere.
 */
export async function findRoleAliasOwner(companyId: number, alias: string): Promise<{ id: number; name: string } | null> {
  return rpc<{ id: number; name: string } | null>("findRoleAliasOwner", { companyId, alias });
}

/**
 * Registers `alias` for `roleId` — throws a message naming the current
 * owner if it's already someone else's within the same empresa. Already
 * registered to this same função is a silent no-op, not an error, mirroring
 * `addEmployeeAlias`.
 */
export async function addRoleAlias(roleId: number, alias: string): Promise<void> {
  await rpc<void>("addRoleAlias", { roleId, alias });
}

export async function removeRoleAlias(aliasId: number): Promise<void> {
  await rpc<void>("removeRoleAlias", { aliasId });
}

/**
 * Resolves a payment row's função within `companyId` by name or apelido —
 * simplified sibling of `findEmployeeByAttempts` (just one field, no
 * identifier precedence to walk since função only ever matches on its own
 * text). Case-insensitive, same as the "nome" tentativa there.
 */
export async function findRoleByName(companyId: number, text: string | null): Promise<RoleRow | null> {
  return rpc<RoleRow | null>("findRoleByName", { companyId, text });
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
  return rpc<EmployeeRow | null>("findEmployeeByAttempts", { clientId, companyId, attempts, values });
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
  return rpc<EmployeeRow | null>("findEmployeeAnywhereByAttempts", { attempts, values });
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
  // The server answers `[index, match]` pairs (a Map has no JSON form).
  return new Map(await rpc<[number, DuplicatePaymentShiftMatch][]>("findDuplicatePaymentShifts", { rows }));
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
  return rpc<PositionMatchedShift | null>("findPaymentShiftByPosition", { sourceUrl, sheetName, rowNumber });
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
  return rpc<SourceUrlHeadShift[]>("listHeadShiftsForSourceUrl", { sourceUrl, periodStart, periodEnd });
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
export async function savePaymentShifts(rows: PaymentShiftInput[], savedFileHashes: Iterable<string> = []): Promise<void> {
  await rpc<void>("savePaymentShifts", { rows, savedFileHashes: Array.from(savedFileHashes) });
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
  return rpc<string[]>("listDistinctPaymentShiftLocals");
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
  /** Actionable subset used by dashboard deep-links into Pagamentos. */
  attention?: "pending-audit" | "missing-amount";
  /** Exact dashboard drill-down subset; evaluated at row level in SQL. */
  analytics?: "journey-over-12h" | "journey-under-4h" | "rest-under-11h" | "heatmap";
  analyticsWeekday?: number;
  analyticsTimeBucket?: number;
  analyticsShiftIds?: number[];
  /** Restricts to exactly these shift ids — set by `withMissingValueShiftIds` for `attention: "missing-amount"`, whose real condition (no recorded amount AND no value-rule estimate) can't be expressed in SQL. Omitted means no restriction; an empty array matches nothing. */
  shiftIds?: number[];
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
  return rpc<PagedResult<PaymentShiftSummaryRow>>("listPaymentShiftSummaries", { query });
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
  roleId: number | null;
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
  return rpc<PaymentShiftReportRow[]>("listPaymentShiftsForReport", { query });
}

/**
 * Same rows as `listPaymentShiftsForReport`, `LIMIT`/`OFFSET`-paginated —
 * "Conferência de Pagamentos"'s own infinite-scroll list uses this instead,
 * so opening it against a large filtered period doesn't pull every matching
 * shift into memory up front. `listPaymentShiftsForReport` itself is left
 * untouched: "Gerar PDF"/"Exportar Excel" (`paymentsReport.ts`/
 * `paymentExport.ts`) both still need the complete set in one shot.
 */
export async function listPaymentShiftsForReportPage(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
  page: number,
  pageSize: number,
): Promise<PagedResult<PaymentShiftReportRow>> {
  return rpc<PagedResult<PaymentShiftReportRow>>("listPaymentShiftsForReportPage", { query, page, pageSize });
}

/**
 * Count of `pago` shifts matching `query` with no recorded `payment_audits`
 * verdict yet — powers "Conferência de Pagamentos"'s "N pendente(s) de
 * conferência" badge. A dedicated query rather than counting client-side
 * because the screen no longer loads every matching row up front (see
 * `listPaymentShiftsForReportPage`), only whatever's been scrolled into
 * view so far.
 */
export async function countPaymentShiftsPendingAudit(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<number> {
  return rpc<number>("countPaymentShiftsPendingAudit", { query });
}

export interface PaymentShiftFlatRow extends PaymentShiftRow {
  companyId: number;
  companyName: string;
  clientId: number;
  clientName: string;
  /** Same idea as `PaymentShiftReportRow.shiftPeriod` — computed in SQL, `null` when there's no schedule to classify. */
  shiftPeriod: ShiftPeriod | null;
}

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
  return rpc<PagedResult<PaymentShiftFlatRow>>("listPaymentShiftsFlat", { query });
}

/**
 * How many shifts match the current filters in each status, ignoring the
 * status filter itself — the counts on the Pagamentos status tabs and on
 * "Conferência". Same row conditions as `listPaymentShiftsFlat`.
 */
export async function countPaymentShiftsByStatus(
  query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">,
): Promise<Record<PaymentShiftStatus, number>> {
  return rpc<Record<PaymentShiftStatus, number>>("countPaymentShiftsByStatus", { query });
}

export interface PaymentShiftGroupRow extends PaymentShiftRow {
  /** Same idea as `PaymentShiftReportRow.shiftPeriod` — computed in SQL, `null` when there's no schedule to classify. */
  shiftPeriod: ShiftPeriod | null;
}

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
  return rpc<PaymentShiftGroupRow[]>("listPaymentShiftsForGroup", { employeeId, competencia, filters });
}

/**
 * A single shift by id, current or superseded — used to open the "ver
 * status anterior" link on a `pago` row, which points at a row that
 * `listPaymentShiftsForGroup`/`listPaymentShiftsFlat` no longer return on
 * their own since it's not a head row anymore.
 */
export async function getPaymentShift(id: number): Promise<PaymentShiftRow> {
  return rpc<PaymentShiftRow>("getPaymentShift", { id });
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
  return withShiftsChangedNotice(rpc<number>("markPaymentShiftPaid", { shiftId, amount }));
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
  return withShiftsChangedNotice(rpc<number>("revertPaymentShiftToPending", { shiftId }));
}

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
  return withShiftsChangedNotice(rpc<number>("markPaymentShiftAuditError", { shiftId }));
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
  return withShiftsChangedNotice(rpc<number>("undoPaymentShiftAuditError", { shiftId }));
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
  await rpc<void>("recordPaymentAudit", { paymentShiftId, result, note });
  notifyPaymentShiftsChanged();
}

/** The recorded audit verdict, if any, for each given `payment_shifts.id` — at most one per id (UNIQUE constraint). */
export async function listPaymentAuditsForShiftIds(shiftIds: number[]): Promise<PaymentAuditRow[]> {
  return rpc<PaymentAuditRow[]>("listPaymentAuditsForShiftIds", { shiftIds });
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
  await rpc<void>("deletePaymentAudit", { paymentShiftId });
  notifyPaymentShiftsChanged();
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
  return withShiftsChangedNotice(rpc<number>("editPaymentShift", { shiftId, fields }));
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
  return rpc<number>("applyAutoSyncedFieldUpdate", { shiftId, fields, sourceFileId, sourceRowNumber, sourceSheetName });
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
  return rpc<PaymentShiftRow[]>("getPaymentShiftHistory", { shiftId });
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
  await rpc<void>("deletePaymentShift", { shiftId });
  notifyPaymentShiftsChanged();
}

/** Which columns of the Pagamentos table are shown — `null` means every column (the default, and what a fresh install has). */
export async function getPaymentVisibleColumns(): Promise<string[] | null> {
  return rpc<string[] | null>("getPaymentVisibleColumns");
}

/** Persists the Pagamentos table's column visibility — saved immediately on every toggle, not behind a "Salvar" button, same as the other filter state that lives in `FiltersContext`. */
export async function setPaymentVisibleColumns(columns: string[]): Promise<void> {
  await rpc<void>("setPaymentVisibleColumns", { columns });
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

  // One transaction (`runWriteBatch`): either everything below is wiped or
  // nothing is. Separate `db.execute` calls used to leave the data half
  // deleted when a foreign key failed part-way. Order matters: this
  // connection enforces foreign keys and none of them cascade, so every
  // child goes before its parent.
  const statements: string[] = [
    "DELETE FROM punches",
    "DELETE FROM day_records",
    "DELETE FROM imports",
    "DELETE FROM import_files",
    // Self-referencing (previous_shift_id, "Fazer pagamento" history): null
    // those first, or the bulk delete can trip on its own rows.
    "UPDATE payment_shifts SET previous_shift_id = NULL WHERE previous_shift_id IS NOT NULL",
  ];

  // Payment shifts are import history too: always cleared, except, when
  // asked, the ones edited by hand. What points at a shift that's going
  // goes first: its audit (NOT NULL) and the check diffs that matched it.
  const goingShifts = keepManuallyEditedShifts ? "SELECT id FROM payment_shifts WHERE edited_manually = 0" : "SELECT id FROM payment_shifts";
  statements.push(
    `DELETE FROM payment_audits WHERE payment_shift_id IN (${goingShifts})`,
    `UPDATE source_url_check_diffs SET matched_shift_id = NULL WHERE matched_shift_id IN (${goingShifts})`,
  );
  if (keepManuallyEditedShifts) {
    // A kept row loses its links into what's being wiped: source_files always
    // goes, template_id only survives with keepPaymentTemplates. employee_id
    // is NOT NULL, which is why keeping these requires keeping employees.
    statements.push(
      `UPDATE payment_shifts SET source_file_id = NULL${keepPaymentTemplates ? "" : ", template_id = NULL"} WHERE edited_manually = 1`,
      "DELETE FROM payment_shifts WHERE edited_manually = 0",
    );
  } else {
    statements.push("DELETE FROM payment_shifts");
  }
  statements.push("DELETE FROM source_files");

  const clearedTables = ["punches", "day_records", "imports", "import_files", "payment_shifts", "source_files"];

  // Templates are configuration, not history: optional to keep, and
  // independent of the companies/clients/employees chain.
  if (!keepPaymentTemplates) {
    statements.push(
      "DELETE FROM payment_template_rules",
      "DELETE FROM payment_template_status_rules",
      "DELETE FROM payment_template_fields",
      "DELETE FROM payment_template_sheets",
      "DELETE FROM payment_template_groups",
      "DELETE FROM payment_templates",
    );
    clearedTables.push("payment_templates");
  }
  if (!keepEmployeeTemplates) {
    statements.push(
      "DELETE FROM employee_template_fields",
      "DELETE FROM employee_template_sheets",
      "DELETE FROM employee_template_groups",
      "DELETE FROM employee_templates",
    );
    clearedTables.push("employee_templates");
  }

  if (!keepEmployees) {
    // Everything with a NOT NULL employee_id goes before the employees,
    // including their client/empresa links (employee_client_companies).
    statements.push(
      "DELETE FROM employee_pix_keys",
      "DELETE FROM employee_aliases",
      "DELETE FROM employee_client_companies",
      "DELETE FROM employees",
    );
    clearedTables.push("employee_pix_keys", "employee_aliases", "employee_client_companies", "employees");
  }
  if (!keepClients) {
    // A kept payment template can still point at a client through its
    // routing rules: drop the rules, keep the template. Clients also own
    // their value rules. (keepCompanies can only be false when keepClients
    // is too, so this also covers a company wipe.)
    statements.push(
      "DELETE FROM payment_template_rules",
      "DELETE FROM client_payment_value_rules",
      "DELETE FROM client_companies",
      "DELETE FROM clients",
    );
    clearedTables.push("client_payment_value_rules", "clients");
  }
  if (!keepCompanies) {
    // Value rules and funções (with their aliases) belong to a company.
    statements.push("DELETE FROM payment_value_rules", "DELETE FROM role_aliases", "DELETE FROM roles", "DELETE FROM companies");
    clearedTables.push("payment_value_rules", "role_aliases", "roles", "companies");
  }

  await runWriteBatch(statements.map((statement) => ({ sql: statement })));

  try {
    const placeholders = clearedTables.map((_, i) => `$${i + 1}`).join(", ");
    await db.execute(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`, clearedTables);
  } catch {
    // No autoincrement table has ever been written to yet — nothing to reset.
  }

  await db.execute("VACUUM");
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}
