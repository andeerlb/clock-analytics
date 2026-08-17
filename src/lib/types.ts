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

/**
 * The Pagamentos list's "Horário" filter — unlike `NightShiftRule` (which
 * tests a shift's start/end against a *range*), this tests one side of the
 * shift's own horário against a single reference point the user picks.
 */
export type ScheduleTimeRule = "start-before" | "start-after" | "end-before" | "end-after";

export const SCHEDULE_TIME_RULE_LABELS: Record<ScheduleTimeRule, string> = {
  "start-before": "Início antes de",
  "start-after": "Início depois de",
  "end-before": "Fim antes de",
  "end-after": "Fim depois de",
};

export interface ScheduleTimeFilter {
  rule: ScheduleTimeRule;
  /** "HH:MM" */
  time: string;
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

/** Which import flow a source file went through — each has its own history. */
export type ImportType = "timesheet" | "payment" | "employee";

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
}

/** One file's raw (uuid-named) filename and size — an itemized entry behind the storage indicator's "PDFs importados" breakdown. */
export interface StorageFileEntry {
  name: string;
  bytes: number;
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
  /** Origin URL for a payment file downloaded via URL — null for local picks and timesheet PDFs. */
  sourceUrl: string | null;
  /** Whether "Desativar verificação automática" was set for `sourceUrl` — meaningless when `sourceUrl` is null. */
  checkDisabled: boolean;
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
  | "status";

export const PAYMENT_TARGET_FIELDS: PaymentTargetField[] = [
  "cpf",
  "matricula",
  "nome",
  "local",
  "data",
  "funcao",
  "horario",
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
  status: "Status",
};

/**
 * Sentinel `field` value a routing/status rule condition can key off of
 * that ISN'T one of the template's mapped columns — the aba/sheet name a
 * row came from (see `PaymentTemplateGroup.sheetNames`). Kept distinct from
 * `PaymentTargetField` on purpose: it has no business showing up in the
 * column-mapping UI ("map this column to Aba" doesn't mean anything — the
 * aba is implicit, never read from a cell), only in a rule's own
 * "Se [Campo]" selector. See `withSheetNameField` (format.ts) for how a
 * parsed row's fields actually pick this up before a rule ever sees it.
 */
export const SHEET_NAME_RULE_FIELD = "aba";

export type PaymentRuleField = PaymentTargetField | typeof SHEET_NAME_RULE_FIELD;

/**
 * One field test inside a routing/status rule — a `"condition"` rule can
 * have several of these, ALL of which must match (AND) for the rule to
 * fire (e.g. "SE Aba == X E CPF == Y"). See `resolvePaymentRoute`/
 * `resolvePaymentStatus` (format.ts) for exactly how one condition is
 * matched — routing and status rules evaluate an individual condition
 * slightly differently (an empty `values` means something different for
 * each), but both AND their `conditions` array the same way.
 */
export interface PaymentRuleCondition {
  field: PaymentRuleField;
  values: string[];
  /** Whether matching `values` against the row's field folds case. */
  caseInsensitive: boolean;
}

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
  excludedSheetNames: string[];
  fieldMappings: PaymentTemplateFieldMapping[];
}

/** One row per saved payment import template — the list view. */
export interface PaymentTemplateListRow {
  id: number;
  name: string;
  /** The format the template's mapping was originally built against — still what "Arquivo" step re-derives from a newly picked sample file. */
  fileKind: PaymentFileKind;
  /**
   * Every format an import actually accepts for this template — always
   * includes `fileKind` itself. xlsx/xls/ods can be freely combined (they
   * already parse through the same calamine-backed reader, see
   * spreadsheet.rs) but never mixed with csv, which has its own delimiter/
   * no-sheets shape a csv template's mapping assumes.
   */
  acceptedFileKinds: PaymentFileKind[];
  updatedAt: string;
}

/**
 * One step of a template's if/else-if/else routing chain — see
 * `resolvePaymentRoute` in `format.ts` for how these are evaluated. A
 * `"condition"` rule matches rows where EVERY entry in `conditions` matches
 * (AND) — e.g. `[{field: "aba", values: ["X"]}, {field: "cpf", values:
 * ["Y"]}]` reads as "SE Aba == X E CPF == Y"; an `"else"` rule (`conditions`
 * empty) always matches, is optional, and at most one per template — always
 * the last step in the chain.
 */
export type PaymentTemplateRuleKind = "condition" | "else";

export interface PaymentTemplateRule {
  kind: PaymentTemplateRuleKind;
  /** Empty when `kind === "else"`. */
  conditions: PaymentRuleCondition[];
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
  /** Empty when `kind === "else"`. */
  conditions: PaymentRuleCondition[];
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
 * Narrows which shifts a `PaymentValueRule` step even applies to, before its
 * duration check runs. "data"/"local"/"funcao" match like
 * `PaymentTemplateRule`'s field/values — the shift's value must be one of
 * `values` (an "OR" within the condition). "horario" instead compares one
 * side of the shift's own schedule to a reference point, reusing
 * `ScheduleTimeRule` — a range, not a discrete value, so a values list
 * wouldn't make sense there. A rule step's `conditions` array is AND'd
 * together (see `resolvePaymentValue`); composing multiple "horario"
 * conditions is how a window ("começa depois de X E termina antes de Y") is
 * expressed.
 */
export type PaymentValueRuleCondition =
  | {
      field: "data" | "local" | "funcao";
      values: string[];
      /** Whether matching `values` folds case — same idea as `PaymentTemplateRule.caseInsensitive`. */
      caseInsensitive: boolean;
    }
  | {
      field: "horario";
      scheduleRule: ScheduleTimeRule;
      scheduleMinutes: number;
    };

/**
 * One step of a company's (not a template's) if/else-if/else pay-value
 * chain — see `resolvePaymentValue` in `format.ts`. A `"condition"` step
 * matches when every entry in `conditions` matches (see
 * `PaymentValueRuleCondition`) *and* the shift's own duration (horas
 * trabalhadas, summed from its Horário) compares to `thresholdMinutes` per
 * `operator`; an `"else"` step (operator/thresholdMinutes both `null`,
 * conditions ignored) always matches. Entirely optional, same as
 * `PaymentStatusRule` — a company with none of these has no computed Valor
 * at all, not a zero.
 */
export interface PaymentValueRule {
  kind: PaymentTemplateRuleKind;
  /** Column conditions narrowing which shifts this step can match — empty means no restriction, matching every group (the behavior before this existed). */
  conditions: PaymentValueRuleCondition[];
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
 * A known field an employee-import template's column can map to — a strict
 * subset of PaymentTargetField's vocabulary (same three string values), so
 * a mapped row's raw field keys line up unchanged with the existing
 * IdentifierAttempt/findEmployeeByAttempts machinery.
 */
export type EmployeeTargetField = "cpf" | "matricula" | "nome";

export const EMPLOYEE_TARGET_FIELDS: EmployeeTargetField[] = ["cpf", "matricula", "nome"];

export const EMPLOYEE_TARGET_FIELD_LABELS: Record<EmployeeTargetField, string> = {
  cpf: "CPF",
  matricula: "Matrícula",
  nome: "Nome",
};

/** Mapping both of these is required for a group to be usable — both are NOT NULL columns on `employees`. matricula stays optional. */
export const REQUIRED_EMPLOYEE_FIELDS: EmployeeTargetField[] = ["cpf", "nome"];

export interface EmployeeTemplateFieldMapping {
  columnLetter: string;
  targetField: EmployeeTargetField;
  headerLabel: string | null;
}

/** Same per-sheet-group shape as PaymentTemplateGroup — see its doc comment. */
export interface EmployeeTemplateGroup {
  sheetNames: string[];
  excludedSheetNames: string[];
  fieldMappings: EmployeeTemplateFieldMapping[];
  /** 1-indexed physical row where this group's header/title ends — rows up to and including it are skipped at import time. `null` when no header row is marked (every row is treated as data). */
  headerRow: number | null;
}

/** One row per saved employee-import template — the list view. */
export interface EmployeeTemplateListRow {
  id: number;
  name: string;
  /** The format the template's mapping was originally built against — still what "Arquivo" step re-derives from a newly picked sample file. */
  fileKind: PaymentFileKind;
  /** Same idea as `PaymentTemplateListRow.acceptedFileKinds` — every format an import actually accepts, always including `fileKind` itself. */
  acceptedFileKinds: PaymentFileKind[];
  updatedAt: string;
}

/** Full shape of an employee-import template, including its column-mapping groups and identifier priority. */
export interface EmployeeTemplateRow extends EmployeeTemplateListRow {
  delimiter: string | null;
  groups: EmployeeTemplateGroup[];
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

/**
 * The manual bank-statement verdict recorded by "Conferência de Pagamentos"
 * for a `pago` payment shift. `erro` also triggers reverting the shift back
 * to `pendente` (via the existing `revertPaymentShiftToPending`) — see
 * `payment_audits`' own migration comment for why this is a separate table
 * rather than a `PaymentShiftStatus` value.
 */
export type PaymentAuditResult = "confirmado" | "erro";

export const PAYMENT_AUDIT_RESULT_LABELS: Record<PaymentAuditResult, string> = {
  confirmado: "Confirmado",
  erro: "Erro",
};

/** One `payment_audits` row — always at most one per `paymentShiftId` (UNIQUE constraint). */
export interface PaymentAuditRow {
  id: number;
  paymentShiftId: number;
  result: PaymentAuditResult;
  note: string | null;
  auditedAt: string;
}

/** One imported work shift row, joined with its employee/client/company for display. */
export interface PaymentShiftRow {
  id: number;
  employeeId: number;
  employeeName: string;
  /** Snapshotted onto the row at write time (never a live join through `employees`) — moving an employee to a different client later leaves every already-written shift's client/company exactly as it was. See `PaymentShiftCoreFields`/`applyAutoSyncedFieldUpdate` in db.ts for who's allowed to change it (only a fresh re-sync, never a plain status/value edit). */
  clientId: number;
  companyId: number;
  local: string;
  workDate: string;
  role: string;
  /** The função `role`'s text currently resolves to, via `roles`/`role_aliases` scoped to `companyId` — `null` when the text doesn't match any cadastro (or is blank). */
  roleId: number | null;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  status: PaymentShiftStatus;
  errorMessage: string | null;
  amount: number | null;
  importedAt: string;
  /** The row this one replaces (a status transition, a value edit, or a reprocessed import match) — that older row is frozen (never written to again) once this points to it. `null` for a row nothing has replaced yet. */
  previousShiftId: number | null;
  /** columnLetter -> raw text value, for every non-blank column the template left unmapped ("Ignorar") on this row — kept for history/audit instead of discarded. `null` when there was nothing left unmapped (or it was all blank). */
  extraData: Record<string, string> | null;
  /** True when this row was created by a deliberate user action on the Pagamentos detail page (editar valor, fazer pagamento, voltar para pendente) rather than an import — a reprocessed import match refuses to supersede one of these unless "Manter registros atualizados manualmente" is off (see `PaymentSettings`). */
  editedManually: boolean;
  /** This row's position in the original source file — `null` for a row that isn't from an import (a manual "Fazer pagamento"/"Editar valor" row carries its source shift's own position forward, same as `extraData`). Indexed, unlike `extraData`, so the deep-check diff's position-based fallback match can look it up (see `findPaymentShiftByPosition`). */
  sourceRowNumber: number | null;
  sourceSheetName: string | null;
  /** Joined from `source_files.file_name` via `sourceFileId` — not a column on `payment_shifts` itself. `null` when the shift has no `sourceFileId` (or that source file was since removed). */
  sourceFileName: string | null;
  /** Joined from `source_files.source_url` — only set when this shift came from a tracked URL import; `null` for a locally-picked file (or no import origin at all). */
  sourceUrl: string | null;
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

/**
 * One payment-shift field a Excel export template's cell can bind to via a
 * `{{field}}` token — see `PaymentExportTemplateConfig`. Deliberately a
 * small, fixed vocabulary (unlike `PaymentTargetField`'s import-mapping
 * side): every one of these is always present on every shift regardless of
 * which import template produced it. `extraData` is NOT included here on
 * purpose — its keys are raw source-column letters from whichever import
 * template a shift came through, not a stable field name, so binding to one
 * would silently break for shifts imported through a different template.
 */
export type PaymentExportBindableField =
  | "companyName"
  | "clientName"
  | "local"
  | "workDate"
  | "role"
  | "horario"
  | "workedHours"
  | "shiftPeriod"
  | "valor"
  | "status"
  | "employeeName";

export const PAYMENT_EXPORT_BINDABLE_FIELD_LABELS: Record<PaymentExportBindableField, string> = {
  companyName: "Loja/Empresa",
  clientName: "Cliente",
  local: "Local",
  workDate: "Data",
  role: "Função",
  horario: "Horário",
  workedHours: "Horas trabalhadas",
  shiftPeriod: "Diurno/Noturno",
  valor: "Valor",
  status: "Status",
  employeeName: "Colaborador",
};

/** A border line's dash pattern — independent of its thickness (see `CellBorderSide.width`). "double" is its own pattern (not a thickness) because that's how Excel itself models it: a fixed two-line motif, not a thick single line. */
export type CellBorderPattern = "solid" | "dashed" | "dotted" | "double";

/** One side of a cell's border. `null` (on `TemplateGridCellBorder`) means "no border on this side" — distinct from "not set" (there's no third state; a cell either has a visible border on a given side or it doesn't). */
export interface CellBorderSide {
  /** Free-form px thickness (not a "thin/medium/thick" preset) — approximated back to the nearest of Excel's own named border weights at export time, see `borderSideToExcel` in `paymentExportGrid.ts`. */
  width: number;
  pattern: CellBorderPattern;
  /** "#rrggbb". */
  color: string;
}

export interface TemplateGridCellBorder {
  top: CellBorderSide | null;
  right: CellBorderSide | null;
  bottom: CellBorderSide | null;
  left: CellBorderSide | null;
}

/** Horizontal text alignment. `null` = default (left-reading, same as leaving it unset in Excel). */
export type CellHorizontalAlign = "left" | "center" | "right" | "justify";

/** Vertical text alignment. `null` = the grid's own default, which is vertically centered (unlike a fresh Excel cell, which defaults to bottom) — chosen to match how every cell has always rendered in `TemplateGridEditor`, so old templates don't visually shift once this field exists. */
export type CellVerticalAlign = "top" | "middle" | "bottom";

/** One cell in a `TemplateGridData` — text, background/text color, bold/italic, font family/size, per-side border, and horizontal/vertical alignment. */
export interface TemplateGridCell {
  value: string;
  /** "#rrggbb", or `null` for no fill. */
  backgroundColor: string | null;
  /** "#rrggbb", or `null` for the sheet's default text color. */
  fontColor: string | null;
  bold: boolean;
  italic: boolean;
  /** e.g. "Arial" — `null` means the sheet default ("Calibri"). */
  fontFamily: string | null;
  /** Points, e.g. 11 — `null` means the sheet default (11). */
  fontSize: number | null;
  border: TemplateGridCellBorder;
  /** `null` = default (left-reading). */
  horizontalAlign: CellHorizontalAlign | null;
  /** `null` = default (vertically centered — see `CellVerticalAlign`'s own doc comment). */
  verticalAlign: CellVerticalAlign | null;
}

/** One merged block of cells, anchored at its top-left — see `TemplateGridData.merges`. */
export interface TemplateGridMerge {
  row: number;
  col: number;
  /** Both >= 1; a 1x1 "merge" never actually gets created (the UI only offers merging a range of more than one cell). */
  rowSpan: number;
  colSpan: number;
}

/** The whole hand-built grid a `PaymentExportTemplateConfig` is designed on — see `src/components/TemplateGridEditor.tsx`. */
export interface TemplateGridData {
  /** `rows[r][c]` — every row has the same length (`columnWidths.length`). */
  rows: TemplateGridCell[][];
  /** Pixel width per column, same length as every row in `rows`. Ignored at export time for a column where `columnAutoFit` is `true`. */
  columnWidths: number[];
  /**
   * Per-column: `true` = ignore `columnWidths[c]` at export time and size
   * the real exported column to the longest actual value written into it
   * ("ajustar ao maior registro"); `false` (the default) = strictly use
   * `columnWidths[c]`. Toggled via right-click on the column letter header.
   * Same length as `columnWidths`.
   */
  columnAutoFit: boolean[];
  /** Pixel height per row, same length as `rows`. */
  rowHeights: number[];
  merges: TemplateGridMerge[];
}

/**
 * A saved, reusable layout for exporting payment shifts to a real, styled
 * `.xlsx` — see `src/lib/paymentExport.ts`. The grid itself (cell text,
 * background color, column widths) is built directly in the
 * `TemplateGridEditor`; this type adds the "row role" markers the export
 * engine needs on top of that grid (which row row/column plays which part),
 * since the grid itself has no built-in concept of a repeating/grouped
 * report.
 */
export interface PaymentExportTemplateConfig {
  grid: TemplateGridData;
  /** 0-based row index within `grid.rows` that repeats once per payment-shift record within a group. Its cells may contain `{{field}}` tokens (see `PaymentExportBindableField`). Rows strictly above this are static header/title, written once, verbatim. */
  detailRowIndex: number;
  /** In priority order; a new group starts whenever any of these differ between two consecutive (sorted) shifts. Empty means no grouping — every shift in one group. */
  groupBy: PaymentExportBindableField[];
  /** An optional blank row placed between groups, reusing one templated row's style. */
  separator: {
    enabled: boolean;
    /** Row index (within `grid.rows`) whose style is reused for the separator. */
    rowIndex: number;
  } | null;
  /**
   * An optional subtotal row, summing every matching shift's `valor`.
   * Written as a live `SUM(...)` Excel formula over the detail row's
   * `{{valor}}` column (falls back to a precomputed static number if the
   * detail row has no exact `{{valor}}` cell to reference). Unlike the
   * detail row, there's no separate "which column" config: whichever
   * cell(s) in this row contain the literal `{{valorSoma}}` token get the
   * total (same mechanism `{{field}}` tokens use on the detail row — see
   * `renderSumCell` in `paymentExportGrid.ts`); every other cell is static
   * text, written as typed, exactly like the separator row.
   */
  subtotal: {
    enabled: boolean;
    /** Row index (within `grid.rows`) whose content/style is reused for the subtotal row. */
    rowIndex: number;
  } | null;
  /**
   * Which grouping the SOMA row breaks on — independent of `groupBy` (the
   * *turno* grouping), so a SOMA can total each turno-group individually
   * (set this equal to `groupBy`) or roll up several turno-groups into one
   * wider total, down to a single grand total for everything (`[]`). A
   * detail-row group can never straddle a SOMA group boundary — rows are
   * sorted by this grouping first, `groupBy` second, so every SOMA group is
   * a contiguous run of one or more whole turno-groups.
   *
   * `undefined` only for templates saved before this field existed — treated
   * exactly like the pre-existing behavior, one SOMA per turno-group, by
   * falling back to `groupBy` wherever this is read (see
   * `paymentExport.ts`). A template saved through the editor always writes
   * this explicitly (even when it happens to equal `groupBy`), so the
   * ambiguity is only ever a legacy-data concern, never something the UI
   * itself produces going forward.
   */
  subtotalGroupBy?: PaymentExportBindableField[];
}

/** One row per saved payment export template — the list view. */
export interface PaymentExportTemplateListRow {
  id: number;
  name: string;
  updatedAt: string;
}

/** Full shape of a payment export template, including its grid/grouping/subtotal config. */
export interface PaymentExportTemplateRow extends PaymentExportTemplateListRow {
  config: PaymentExportTemplateConfig;
  createdAt: string;
}

export interface PaymentExportTemplateInput {
  name: string;
  config: PaymentExportTemplateConfig;
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
