import { applyPaymentTemplate, type AppliedPaymentRow } from "./api";
import {
  findDuplicatePaymentShifts,
  findEmployeeByAttempts,
  getPaymentShiftsByIds,
  getPaymentTemplate,
  type CheckDiffInput,
  type ReimportConfig,
} from "./db";
import {
  parseDateWithFormat,
  parseScheduleToMinutes,
  resolvePaymentRoute,
  resolvePaymentStatus,
  resolveReimportConfigLabel,
  resolveReimportPeriod,
} from "./format";

/**
 * Synthetic `extra_data` keys `ImportPaymentsPage.buildExtraData` injects on
 * every saved shift (arquivo/linha/aba de origem) — not from the file's own
 * columns, so they're stripped before comparing a freshly parsed row's
 * `extraFields` against what's stored. Without this, every deep check would
 * report a "change" just because the row number shifted.
 */
const PROVENANCE_EXTRA_KEYS = new Set(["arquivo de origem", "linha de origem", "aba de origem"]);

interface ParsedCandidate {
  employeeId: number;
  employeeName: string;
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  sheetName: string | null;
  rowNumber: number;
  status: string;
  extraFields: Record<string, string>;
}

/** Same identity `shiftDedupKey` (ImportPaymentsPage.tsx) and `findDuplicatePaymentShifts` use — employee+data+local+função+horário together. */
function candidateDedupKey(
  c: Pick<ParsedCandidate, "employeeId" | "workDate" | "local" | "role" | "scheduleStartMinutes" | "scheduleEndMinutes">,
): string {
  return JSON.stringify([c.employeeId, c.workDate, c.local, c.role, c.scheduleStartMinutes, c.scheduleEndMinutes]);
}

/**
 * Read-only mirror of `ImportPaymentsPage.handleProcess`'s parse+resolve
 * pipeline (see that file for the row-by-row logic this follows), run
 * against one reimport config's own template/período — used by the
 * background deep check to see what a reimport WOULD find, without ever
 * writing to `payment_shifts`. The actual import stays 100% manual, through
 * the normal "Reprocessar agora" flow.
 *
 * A single bad row is just skipped, same as the real import does (skipped
 * date, unresolved route, colaborador não encontrado — none of those have
 * an existing record to diff against anyway). This function throws only for
 * a whole-config failure (deleted template, unreadable/corrupt file) — the
 * caller turns that into one `change_kind: 'error'` diff entry instead of
 * letting it take down every other config's check for the same URL.
 */
export async function computeReimportDiff(config: ReimportConfig, downloadedPath: string): Promise<CheckDiffInput[]> {
  const template = await getPaymentTemplate(config.templateId);
  const applied: AppliedPaymentRow[] = await applyPaymentTemplate(
    downloadedPath,
    template.groups.map((g) => ({
      sheetNames: g.sheetNames,
      fieldMappings: g.fieldMappings.map((fm) => [fm.columnLetter, fm.targetField] as [string, string]),
    })),
    template.delimiter,
  );

  const { start: periodStart, end: periodEnd } = resolveReimportPeriod(config);
  const configLabel = resolveReimportConfigLabel(config);

  const candidates: ParsedCandidate[] = [];
  for (const row of applied) {
    const workDateRaw = row.fields.data ?? "";
    const workDate = workDateRaw ? parseDateWithFormat(workDateRaw, template.dateFormat) : null;
    if (!workDate) continue;
    if ((periodStart && workDate < periodStart) || (periodEnd && workDate > periodEnd)) continue;

    const route = resolvePaymentRoute(template.rules, row.fields);
    if (!route) continue;

    const employee = await findEmployeeByAttempts(route.clientId, route.companyId, template.identifierPriority, {
      cpf: row.fields.cpf || null,
      matricula: row.fields.matricula || null,
      nome: row.fields.nome || null,
    });
    if (!employee) continue;

    const parsedSchedule = parseScheduleToMinutes(row.fields.horario ?? "");
    candidates.push({
      employeeId: employee.id,
      employeeName: employee.name,
      workDate,
      local: row.fields.local ?? "",
      role: row.fields.funcao ?? "",
      scheduleStartMinutes: parsedSchedule?.startMinutes ?? null,
      scheduleEndMinutes: parsedSchedule?.endMinutes ?? null,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      status: resolvePaymentStatus(template.statusRules, row.fields) ?? "pendente",
      extraFields: row.extraFields,
    });
  }

  // Same "duplicate-in-file" rule the manual import uses — only the first
  // occurrence of a given identity within this parse is compared.
  const seen = new Set<string>();
  const deduped: ParsedCandidate[] = [];
  for (const c of candidates) {
    const key = candidateDedupKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  const matches = await findDuplicatePaymentShifts(
    deduped.map((c) => ({
      employeeId: c.employeeId,
      workDate: c.workDate,
      local: c.local,
      role: c.role,
      scheduleStartMinutes: c.scheduleStartMinutes,
      scheduleEndMinutes: c.scheduleEndMinutes,
    })),
  );

  const matchedShiftIds = Array.from(new Set(Array.from(matches.values()).map((m) => m.shiftId)));
  const currentShifts = await getPaymentShiftsByIds(matchedShiftIds);
  const currentById = new Map(currentShifts.map((s) => [s.id, s]));

  function identityBase(c: ParsedCandidate) {
    return {
      configId: config.id,
      configLabel,
      employeeId: c.employeeId,
      employeeName: c.employeeName,
      workDate: c.workDate,
      local: c.local,
      role: c.role,
      scheduleStartMinutes: c.scheduleStartMinutes,
      scheduleEndMinutes: c.scheduleEndMinutes,
      sheetName: c.sheetName,
      rowNumber: c.rowNumber,
    };
  }

  const entries: CheckDiffInput[] = [];
  deduped.forEach((c, i) => {
    const match = matches.get(i);
    if (!match) {
      // No existing head for this identity at all — a possible new shift,
      // not a field-level edit of something already imported.
      entries.push({
        ...identityBase(c),
        changeKind: "new-shift",
        matchedShiftId: null,
        columnLetter: null,
        fieldName: null,
        oldValue: null,
        newValue: null,
        message: null,
      });
      return;
    }

    // A soft-deleted or manually-edited head is diffed the same as any
    // other match — this reports "what changed in the file", not a
    // judgment call about whether to overwrite a deliberate manual action
    // (that's `keepManualEdits`'s job, enforced only at actual reimport
    // time in `ImportPaymentsPage`).
    const current = currentById.get(match.shiftId);
    if (!current) return;

    if (current.status !== c.status) {
      entries.push({
        ...identityBase(c),
        changeKind: "field",
        matchedShiftId: match.shiftId,
        columnLetter: null,
        fieldName: "status",
        oldValue: current.status,
        newValue: c.status,
        message: null,
      });
    }

    // Only the columns the template currently leaves unmapped are
    // comparable this way — if the template's mapping changed since this
    // shift was first imported, a column that used to be "extra" (and thus
    // is in `currentExtra`) might not be anymore (won't be in
    // `freshExtra`), or vice versa; that shows up as one side missing
    // rather than a false "changed", which is the safer failure mode.
    const currentExtra = current.extraData ?? {};
    const freshExtra = c.extraFields ?? {};
    const extraKeys = new Set([...Object.keys(currentExtra), ...Object.keys(freshExtra)]);
    for (const key of extraKeys) {
      if (PROVENANCE_EXTRA_KEYS.has(key)) continue;
      const oldValue = currentExtra[key] ?? null;
      const newValue = freshExtra[key] ?? null;
      if (oldValue === newValue) continue;
      entries.push({
        ...identityBase(c),
        changeKind: "field",
        matchedShiftId: match.shiftId,
        columnLetter: key,
        fieldName: `extra:${key}`,
        oldValue,
        newValue,
        message: null,
      });
    }
  });

  return entries;
}
