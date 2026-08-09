import { applyPaymentTemplate, type AppliedPaymentRow } from "./api";
import {
  findDuplicatePaymentShifts,
  findEmployeeByAttempts,
  findPaymentShiftByPosition,
  getPaymentShiftsByIds,
  getPaymentTemplate,
  type CheckDiffInput,
  type ReimportConfig,
} from "./db";
import {
  formatMinutesAsTime,
  parseDateWithFormat,
  parseScheduleToMinutes,
  resolvePaymentRoute,
  resolvePaymentStatus,
  resolveReimportConfigLabel,
  resolveReimportPeriod,
} from "./format";

/** "08:00–17:00", or "—" when there's no schedule at all — same shape `oldValue`/`newValue` need to be in (plain display text), not raw minutes. */
function formatScheduleRange(startMinutes: number | null, endMinutes: number | null): string {
  if (startMinutes === null || endMinutes === null) return "—";
  return `${formatMinutesAsTime(startMinutes)}–${formatMinutesAsTime(endMinutes)}`;
}

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
 * A row whose "data" column doesn't parse is just skipped, same as the real
 * import does — that's a title/header/footer row, not real data. A row
 * whose ROTA or COLABORADOR doesn't resolve is different: it IS real data
 * (it has a date within período), it just can't be matched against
 * `payment_shifts` — reported as `change_kind: 'unresolved'` rather than
 * silently dropped, precisely so an edit that breaks the name/route match
 * (a typo, a name that no longer matches any cadastro) still shows up as
 * something changed instead of the check quietly reporting "sem mudança"
 * while a real, unresolvable difference sits in the file. This function
 * throws only for a whole-config failure (deleted template, unreadable/
 * corrupt file) — the caller turns that into one `change_kind: 'error'`
 * diff entry instead of letting it take down every other config's check
 * for the same URL.
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

  function unresolvedEntry(
    row: AppliedPaymentRow,
    workDate: string,
    schedule: { startMinutes: number; endMinutes: number } | null,
    message: string,
  ): CheckDiffInput {
    return {
      configId: config.id,
      configLabel,
      changeKind: "unresolved",
      matchedShiftId: null,
      employeeId: null,
      // Not a resolved colaborador — the raw "nome" text is shown as-is so
      // the card is still identifiable, even though it isn't an employeeId.
      employeeName: row.fields.nome || null,
      workDate,
      local: row.fields.local ?? null,
      role: row.fields.funcao ?? null,
      scheduleStartMinutes: schedule?.startMinutes ?? null,
      scheduleEndMinutes: schedule?.endMinutes ?? null,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      columnLetter: null,
      fieldName: null,
      oldValue: null,
      newValue: null,
      message,
    };
  }

  const candidates: ParsedCandidate[] = [];
  const unresolvedEntries: CheckDiffInput[] = [];
  for (const row of applied) {
    const workDateRaw = row.fields.data ?? "";
    const workDate = workDateRaw ? parseDateWithFormat(workDateRaw, template.dateFormat) : null;
    if (!workDate) continue;
    if ((periodStart && workDate < periodStart) || (periodEnd && workDate > periodEnd)) continue;

    const parsedSchedule = parseScheduleToMinutes(row.fields.horario ?? "");

    const route = resolvePaymentRoute(template.rules, row.fields);
    if (!route) {
      unresolvedEntries.push(
        unresolvedEntry(
          row,
          workDate,
          parsedSchedule,
          "Nenhuma regra de rota bateu com esta linha — não dá pra saber a qual cliente/empresa ela pertence.",
        ),
      );
      continue;
    }

    const employee = await findEmployeeByAttempts(route.clientId, route.companyId, template.identifierPriority, {
      cpf: row.fields.cpf || null,
      matricula: row.fields.matricula || null,
      nome: row.fields.nome || null,
    });
    if (!employee) {
      unresolvedEntries.push(
        unresolvedEntry(
          row,
          workDate,
          parsedSchedule,
          `Colaborador não encontrado para "${row.fields.nome || "(nome vazio)"}".`,
        ),
      );
      continue;
    }

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

  interface CurrentShift {
    shiftId: number;
    workDate: string;
    local: string;
    role: string;
    scheduleStartMinutes: number | null;
    scheduleEndMinutes: number | null;
    status: string;
    extraData: Record<string, string> | null;
  }

  const entries: CheckDiffInput[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const c = deduped[i];
    const match = matches.get(i);

    // A soft-deleted or manually-edited head is diffed the same as any
    // other match — this reports "what changed in the file", not a
    // judgment call about whether to overwrite a deliberate manual action
    // (that's `keepManualEdits`'s job, enforced only at actual reimport
    // time in `ImportPaymentsPage`).
    let current: CurrentShift | null = null;
    // Only set when `current` came from the position fallback below — the
    // one case where the row's OWN identity fields (data/local/função/
    // horário) are worth diffing too, since that's exactly what made the
    // identity match miss it in the first place.
    let reportIdentityFieldChanges = false;

    if (match) {
      const matched = currentById.get(match.shiftId);
      if (matched) {
        current = {
          shiftId: match.shiftId,
          workDate: matched.workDate,
          local: matched.local,
          role: matched.role,
          scheduleStartMinutes: matched.scheduleStartMinutes,
          scheduleEndMinutes: matched.scheduleEndMinutes,
          status: matched.status,
          extraData: matched.extraData,
        };
      }
    } else {
      // No identity match — before concluding this is a brand-new shift,
      // check whether some OTHER shift used to sit at this exact row/aba
      // of this same URL (see `findPaymentShiftByPosition`'s doc comment).
      // Catches the case an identity match structurally can't: the file
      // edited local/função/horário/data on a row that was already
      // imported, which changes its identity out from under the old match.
      const positional = await findPaymentShiftByPosition(config.sourceUrl, c.sheetName, c.rowNumber);
      if (positional) {
        current = {
          shiftId: positional.shiftId,
          workDate: positional.workDate,
          local: positional.local,
          role: positional.role,
          scheduleStartMinutes: positional.scheduleStartMinutes,
          scheduleEndMinutes: positional.scheduleEndMinutes,
          status: positional.status,
          extraData: positional.extraData,
        };
        reportIdentityFieldChanges = true;
      }
    }

    if (!current) {
      // No existing head for this identity OR this position — a genuinely
      // new shift, not an edit of something already imported.
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
      continue;
    }

    const shift = current;
    function fieldDiff(fieldName: string, oldValue: string, newValue: string) {
      entries.push({
        ...identityBase(c),
        changeKind: "field",
        matchedShiftId: shift.shiftId,
        columnLetter: null,
        fieldName,
        oldValue,
        newValue,
        message: null,
      });
    }

    if (reportIdentityFieldChanges) {
      if (shift.workDate !== c.workDate) fieldDiff("data", shift.workDate, c.workDate);
      if (shift.local !== c.local) fieldDiff("local", shift.local, c.local);
      if (shift.role !== c.role) fieldDiff("função", shift.role, c.role);
      if (shift.scheduleStartMinutes !== c.scheduleStartMinutes || shift.scheduleEndMinutes !== c.scheduleEndMinutes) {
        fieldDiff(
          "horário",
          formatScheduleRange(shift.scheduleStartMinutes, shift.scheduleEndMinutes),
          formatScheduleRange(c.scheduleStartMinutes, c.scheduleEndMinutes),
        );
      }
    }

    if (shift.status !== c.status) fieldDiff("status", shift.status, c.status);

    // Only the columns the template currently leaves unmapped are
    // comparable this way — if the template's mapping changed since this
    // shift was first imported, a column that used to be "extra" (and thus
    // is in `currentExtra`) might not be anymore (won't be in
    // `freshExtra`), or vice versa; that shows up as one side missing
    // rather than a false "changed", which is the safer failure mode.
    const currentExtra = shift.extraData ?? {};
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
        matchedShiftId: shift.shiftId,
        columnLetter: key,
        fieldName: `extra:${key}`,
        oldValue,
        newValue,
        message: null,
      });
    }
  }

  return [...unresolvedEntries, ...entries];
}
