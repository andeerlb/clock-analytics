/** A page of `rows` out of `total` matching rows — `total` is pre-filter/pagination, for computing page count. */
export interface PagedResult<T> {
  rows: T[];
  total: number;
}

export interface Company {
  name: string;
  cnpj: string;
}

/**
 * Which rule decides a payment shift (own start/end time) counts as
 * "noturno" against a company's night_start_time/night_end_time window —
 * see `classifyShiftPeriod` in `format.ts` for how each is evaluated.
 */
export type NightShiftRule =
  | "start-in-range"
  | "end-in-range"
  | "start-or-end-in-range"
  | "overlap"
  | "majority-overlap";

export const NIGHT_SHIFT_RULE_LABELS: Record<NightShiftRule, string> = {
  "start-in-range": "Início do turno dentro do intervalo noturno",
  "end-in-range": "Fim do turno dentro do intervalo noturno",
  "start-or-end-in-range": "Início ou fim do turno dentro do intervalo noturno",
  overlap: "Qualquer sobreposição do turno com o intervalo noturno",
  "majority-overlap": "Mais da metade do turno dentro do intervalo noturno",
};

/** A payment shift classified against its company's night window — see `classifyShiftPeriod` in `format.ts`. */
export type ShiftPeriod = "diurno" | "noturno";

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

/** Which import flow a source file went through — each has its own history. */
export type ImportType = "timesheet" | "payment";

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

/** Disk usage of everything the app itself created — the Configurações storage indicator. */
export interface StorageUsage {
  dbBytes: number;
  importsBytes: number;
  importsFileCount: number;
  paymentTemplatesBytes: number;
  paymentTemplatesFileCount: number;
}

/** Whether a single Poppler CLI tool (pdfinfo/pdftotext/pdfseparate/pdfunite) was found. */
export interface PopplerBinaryStatus {
  name: string;
  found: boolean;
  path: string | null;
}

/**
 * Whether the app can find the Poppler CLI tools it shells out to for PDF
 * import/export. Checked at startup and on Configurações — a missing
 * install shows up as guidance there instead of an opaque "failed to spawn"
 * error the first time an import is attempted.
 */
export interface PopplerStatus {
  allFound: boolean;
  popplerDir: string | null;
  binaries: PopplerBinaryStatus[];
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
  importType: ImportType;
  status: ImportStatus;
  errorMessage: string | null;
  originalPdfPath: string;
  pageCount: number;
  importedAt: string;
  /** Set once at least one sheet from this file was actually saved. */
  savedAt: string | null;
}

export type PaymentFileKind = "csv" | "xlsx" | "xls" | "ods";

/**
 * A known field a payment template's column can map to. Each row is a work
 * shift (place, day, role, hours) that will later be used to *calculate* a
 * payment — not a ready-made payment amount, which is why there's no
 * "valor" here: that's entered at payment time, never imported.
 *
 * Which one acts as "the" employee identifier isn't a separate setting —
 * it's implicit in whichever field(s) a template happens to map a column
 * to. More than one identifier can be mapped at once (e.g. both CPF and
 * Nome); when that happens, only the highest-precedence one found is
 * actually used: CPF > Matrícula > Nome (see `IDENTIFIER_FIELD_PRECEDENCE`).
 */
export type PaymentTargetField =
  | "cpf"
  | "matricula"
  | "nome"
  | "local"
  | "data"
  | "funcao"
  | "horario"
  | "observacao"
  | "status";

export const PAYMENT_TARGET_FIELDS: PaymentTargetField[] = [
  "cpf",
  "matricula",
  "nome",
  "local",
  "data",
  "funcao",
  "horario",
  "observacao",
  "status",
];

/** Highest to lowest precedence — see the `PaymentTargetField` doc comment. */
export const IDENTIFIER_FIELD_PRECEDENCE: PaymentTargetField[] = ["cpf", "matricula", "nome"];

export type IdentifierField = "cpf" | "matricula" | "nome";

/**
 * One "tentativa" of matching a payment row to an employee — every field
 * listed must match the *same* employee together (an AND). A template's
 * full identifier priority is an ordered list of these; they're tried in
 * sequence and the first one that finds an employee wins (an OR across
 * tentativas). Configurable per template — see `findEmployeeByAttempts` in
 * db.ts — rather than the single fixed cpf > matricula > nome precedence
 * this replaced.
 */
export interface IdentifierAttempt {
  fields: IdentifierField[];
  /** Whether matricula/nome matching folds case — same idea as `PaymentTemplateRule.caseInsensitive`. Doesn't affect cpf, which is always digit-normalized regardless. */
  caseInsensitive: boolean;
}

/** Reproduces the old fixed precedence: three single-field tentativas, same order, case-insensitive (matching the old hardcoded nome behavior). */
export const DEFAULT_IDENTIFIER_PRIORITY: IdentifierAttempt[] = [
  { fields: ["cpf"], caseInsensitive: true },
  { fields: ["matricula"], caseInsensitive: true },
  { fields: ["nome"], caseInsensitive: true },
];

/** Mapping one of these (besides an identifier) is required for a group to be usable. */
export const REQUIRED_PAYMENT_FIELDS: PaymentTargetField[] = ["local", "data", "funcao", "horario"];

export const PAYMENT_TARGET_FIELD_LABELS: Record<PaymentTargetField, string> = {
  cpf: "CPF",
  matricula: "Matrícula",
  nome: "Nome",
  local: "Local de trabalho",
  data: "Data",
  funcao: "Função",
  horario: "Horário",
  observacao: "Observação",
  status: "Status",
};

export interface PaymentTemplateFieldMapping {
  columnLetter: string;
  targetField: PaymentTargetField;
  headerLabel: string | null;
}

/**
 * Different sheets in the same workbook can have genuinely different
 * layouts, so a template maps one or more independent "groups" instead of
 * a single flat mapping — sheets with an identical structure share a
 * group; sheets that differ get their own. CSV has no sheets, so it
 * always has exactly one group with an empty `sheetNames`.
 *
 * There's no header-row field here on purpose: which physical row is real
 * data isn't decided at template-configuration time, it's decided at
 * import time by trying to parse each row's "data" field as a date —
 * whichever rows fail (typically a header, title, or footer row) are
 * skipped automatically.
 */
export interface PaymentTemplateGroup {
  sheetNames: string[];
  fieldMappings: PaymentTemplateFieldMapping[];
}

/** One row per saved payment import template — the list view. */
export interface PaymentTemplateListRow {
  id: number;
  name: string;
  fileKind: PaymentFileKind;
  updatedAt: string;
}

/**
 * One step of a template's if/else-if/else routing chain — see
 * `resolvePaymentRoute` in `format.ts` for how these are evaluated. A
 * `"condition"` rule matches rows whose `field` value is one of `values`;
 * an `"else"` rule (field/values both `null`) always matches, is optional,
 * and at most one per template — always the last step in the chain.
 */
export type PaymentTemplateRuleKind = "condition" | "else";

export interface PaymentTemplateRule {
  kind: PaymentTemplateRuleKind;
  field: PaymentTargetField | null;
  values: string[];
  /** Whether matching `values` against a row's field folds case — ignored when `kind === "else"`. */
  caseInsensitive: boolean;
  companyId: number;
  companyName: string;
  clientId: number;
  clientName: string;
}

/**
 * One step of a template's if/else-if/else status chain — see
 * `resolvePaymentStatus` in `format.ts`. Same evaluation as
 * `PaymentTemplateRule` (routing), but "um pra um": the consequence is a
 * single `status` instead of company_id/client_id. Unlike routing rules,
 * this chain is entirely optional — a template with none of these leaves
 * every imported shift `pendente`, same as before this existed.
 */
export interface PaymentStatusRule {
  kind: PaymentTemplateRuleKind;
  field: PaymentTargetField | null;
  values: string[];
  /** Whether matching `values` against a row's field folds case — ignored when `kind === "else"`. */
  caseInsensitive: boolean;
  status: PaymentShiftStatus;
}

export type PaymentValueRuleOperator = "=" | "!=" | ">" | ">=" | "<" | "<=";

export const PAYMENT_VALUE_RULE_OPERATOR_LABELS: Record<PaymentValueRuleOperator, string> = {
  "=": "Igual a",
  "!=": "Diferente de",
  ">": "Maior que",
  ">=": "Maior ou igual a",
  "<": "Menor que",
  "<=": "Menor ou igual a",
};

/**
 * One step of a company's (not a template's) if/else-if/else pay-value
 * chain — see `resolvePaymentValue` in `format.ts`. A `"condition"` step
 * matches when the shift's own duration (horas trabalhadas, summed from
 * its Horário) compares to `thresholdMinutes` per `operator`; an `"else"`
 * step (operator/thresholdMinutes both `null`) always matches. Entirely
 * optional, same as `PaymentStatusRule` — a company with none of these has
 * no computed Valor at all, not a zero.
 */
export interface PaymentValueRule {
  kind: PaymentTemplateRuleKind;
  operator: PaymentValueRuleOperator | null;
  /** Duration threshold in whole minutes (not decimal hours) — "7h20" is exactly 440, comparable with `=`/`!=` without float rounding. */
  thresholdMinutes: number | null;
  amount: number;
}

/** Full shape of a payment import template, including its sheet groups and routing/status rules. */
export interface PaymentTemplateRow extends PaymentTemplateListRow {
  delimiter: string | null;
  dateFormat: string;
  groups: PaymentTemplateGroup[];
  rules: PaymentTemplateRule[];
  statusRules: PaymentStatusRule[];
  identifierPriority: IdentifierAttempt[];
  createdAt: string;
}

/**
 * A payment shift's own lifecycle — starts `pendente` on import unless the
 * template's status rules (see `PaymentStatusRule`) resolve something
 * else. `valor` and any further transition to `pago` (or `erro`) belong to
 * a later "processar pagamento" step, not to import.
 */
export type PaymentShiftStatus = "pendente" | "erro" | "pago";

export const PAYMENT_SHIFT_STATUS_LABELS: Record<PaymentShiftStatus, string> = {
  pendente: "Pendente",
  erro: "Erro",
  pago: "Pago",
};

/** One imported work shift row, joined with its employee/client/company for display. */
export interface PaymentShiftRow {
  id: number;
  employeeId: number;
  employeeName: string;
  local: string;
  workDate: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  note: string | null;
  status: PaymentShiftStatus;
  errorMessage: string | null;
  amount: number | null;
  importedAt: string;
}

/** One row per (colaborador, competência) — the Pagamentos list. */
export interface PaymentShiftSummaryRow {
  employeeId: number;
  employeeName: string;
  clientId: number;
  clientName: string;
  companyId: number;
  companyName: string;
  /** "YYYY-MM" */
  competencia: string;
  total: number;
  pendente: number;
  erro: number;
  pago: number;
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
  /** Days in the period with an odd, incomplete punch count (a dangling entrada/saída). */
  pendingCount: number;
  importedAt: string;
}
