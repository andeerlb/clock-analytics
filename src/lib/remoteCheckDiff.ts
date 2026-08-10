import { deletePaths, downloadPaymentFileFromUrl, hashPaymentFile, applyPaymentTemplate, type AppliedPaymentRow } from "./api";
import {
  applyAutoSyncedFieldUpdate,
  deletePaymentShift,
  findDuplicatePaymentShifts,
  findEmployeeAnywhereByAttempts,
  findEmployeeByAttempts,
  findPaymentShiftByPosition,
  getPaymentShiftsByIds,
  getPaymentTemplate,
  listHeadShiftsForSourceUrl,
  logSourceFile,
  markSourceFileSaved,
  savePaymentShifts,
  type CheckDiffInput,
  type PaymentShiftInput,
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
  withSheetNameField,
} from "./format";
import type { PaymentShiftStatus } from "./types";

/**
 * "Atualizar registros automaticamente" for one reimport config —
 * `computeReimportDiff` still always COMPUTES and returns every diff it
 * finds; this only controls whether it also WRITES the ones it's allowed to
 * (see `CheckDiffRow.applied`). Never touches `change_kind: 'unresolved'` or
 * `'error'` — those aren't things a write could resolve on its own.
 */
export interface AutoApplyOptions {
  enabled: boolean;
  /** Whether a matched shift with `editedManually` (but not paid) is still fair game. */
  overwriteManualEdits: boolean;
  /** Whether a matched shift with `status: 'pago'` is still fair game. */
  overwritePaid: boolean;
  /** The already-persisted `source_files.id` for `downloadedPath` — required so a written row has real provenance (`findPaymentShiftByPosition` etc. depend on it), same as any manual reimport's `logSourceFile` call. */
  sourceFileId: number;
  /** Scopes every write to just this one shift — used by the manual "Aceitar" action reviewing a single row. `undefined` applies everything eligible (the unattended periodic auto-apply pass). `change_kind: 'new-shift'`/`'removed'` are only ever auto-applied when this is `undefined` — "Aceitar" only ever updates the fields of the shift being reviewed, never creates or deletes one. */
  onlyShiftId?: number;
}

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
  /** From this row's own freshly resolved route — see `applyAutoSyncedFieldUpdate`'s doc comment for why this must survive to the write, not the matched shift's old snapshot. */
  clientId: number;
  companyId: number;
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  sheetName: string | null;
  rowNumber: number;
  status: PaymentShiftStatus;
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
export async function computeReimportDiff(
  config: ReimportConfig,
  downloadedPath: string,
  autoApply?: AutoApplyOptions,
): Promise<CheckDiffInput[]> {
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
      applied: false,
    };
  }

  const candidates: ParsedCandidate[] = [];
  const unresolvedEntries: CheckDiffInput[] = [];
  // Every existing shift this parse actually accounted for (matched by
  // identity, by position, or explained by an 'unresolved' row sitting at
  // its old position) — whatever's left in `listHeadShiftsForSourceUrl`
  // afterward is a shift this file USED to have but this read didn't have
  // anywhere at all (see the 'removed' pass below), not just one whose
  // fields didn't change.
  const accountedForIds = new Set<number>();
  for (const row of applied) {
    const workDateRaw = row.fields.data ?? "";
    const workDate = workDateRaw ? parseDateWithFormat(workDateRaw, template.dateFormat) : null;
    if (!workDate) continue;
    if ((periodStart && workDate < periodStart) || (periodEnd && workDate > periodEnd)) continue;

    const parsedSchedule = parseScheduleToMinutes(row.fields.horario ?? "");
    const fieldsWithSheet = withSheetNameField(row.fields, row.sheetName);

    const route = resolvePaymentRoute(template.rules, fieldsWithSheet);
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
      // Doesn't resolve to a colaborador on its own — but this same
      // row/aba of this same URL may have belonged to someone on a
      // previous import (see `findPaymentShiftByPosition`). Not treated as
      // a match (an unmatched row stays `unresolved`, never silently
      // reassigned to a guessed employee) — just surfaced in the message,
      // since a broken name match is the single most likely reason a row
      // that used to resolve suddenly stops resolving.
      const positional = await findPaymentShiftByPosition(config.sourceUrl, row.sheetName, row.rowNumber);
      if (positional) accountedForIds.add(positional.shiftId);
      // Purely informational — enriches the message so a review knows
      // WHY the scoped search failed, without moving anyone: moving stays
      // exclusive to the manual "Mover para Cliente Y" action on the import
      // preview, a deliberate human decision, never something a background
      // check does on its own.
      const elsewhere = await findEmployeeAnywhereByAttempts(template.identifierPriority, {
        cpf: row.fields.cpf || null,
        matricula: row.fields.matricula || null,
        nome: row.fields.nome || null,
      });
      let message = positional
        ? `Colaborador não encontrado para "${row.fields.nome || "(nome vazio)"}" — nesta posição (${row.sheetName ? `aba ${row.sheetName}, ` : ""}linha ${row.rowNumber}) havia antes um turno de "${positional.employeeName}".`
        : `Colaborador não encontrado para "${row.fields.nome || "(nome vazio)"}".`;
      if (elsewhere) {
        message += ` Existe um colaborador com esse nome cadastrado em ${elsewhere.clientName} (${elsewhere.companyName}), mas a regra desta linha aponta para ${route.clientName} (${route.companyName}) — reveja em "Importar pagamentos" para mover o cadastro, se for o caso.`;
      }
      unresolvedEntries.push(unresolvedEntry(row, workDate, parsedSchedule, message));
      continue;
    }

    candidates.push({
      employeeId: employee.id,
      employeeName: employee.name,
      clientId: route.clientId,
      companyId: route.companyId,
      workDate,
      local: row.fields.local ?? "",
      role: row.fields.funcao ?? "",
      scheduleStartMinutes: parsedSchedule?.startMinutes ?? null,
      scheduleEndMinutes: parsedSchedule?.endMinutes ?? null,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      status: resolvePaymentStatus(template.statusRules, fieldsWithSheet) ?? "pendente",
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
    status: PaymentShiftStatus;
    extraData: Record<string, string> | null;
    editedManually: boolean;
  }

  // Whether AutoApplyOptions actually allows writing THIS shift specifically
  // — same two protections regardless of change_kind ('field' or 'removed'),
  // and the `onlyShiftId` scope "Aceitar" uses to touch just the one row
  // being reviewed.
  function canAutoApply(shift: { shiftId: number; status: PaymentShiftStatus; editedManually: boolean }): boolean {
    if (!autoApply?.enabled) return false;
    if (autoApply.onlyShiftId !== undefined && autoApply.onlyShiftId !== shift.shiftId) return false;
    if (shift.editedManually && !autoApply.overwriteManualEdits) return false;
    if (shift.status === "pago" && !autoApply.overwritePaid) return false;
    return true;
  }

  const entries: CheckDiffInput[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const c = deduped[i];
    const match = matches.get(i);

    // A soft-deleted or manually-edited head is diffed the same as any
    // other match — this reports "what changed in the file", not a
    // judgment call about whether to overwrite a deliberate manual action
    // (that's `keepManualEdits`'s job, enforced only at actual reimport
    // time in `ImportPaymentsPage` — or, for the auto-apply path, `canAutoApply` above).
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
          editedManually: matched.editedManually,
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
          editedManually: positional.editedManually,
        };
        reportIdentityFieldChanges = true;
      }
    }

    if (!current) {
      // No existing head for this identity OR this position — a genuinely
      // new shift, not an edit of something already imported. Only ever
      // auto-created during the unattended pass (`onlyShiftId === undefined`)
      // — "Aceitar" (reviewing one specific existing shift) never creates.
      let newShiftId: number | null = null;
      if (autoApply?.enabled && autoApply.onlyShiftId === undefined) {
        const input: PaymentShiftInput = {
          employeeId: c.employeeId,
          templateId: config.templateId,
          sourceFileId: autoApply.sourceFileId,
          clientId: c.clientId,
          companyId: c.companyId,
          local: c.local,
          workDate: c.workDate,
          role: c.role,
          scheduleStartMinutes: c.scheduleStartMinutes,
          scheduleEndMinutes: c.scheduleEndMinutes,
          status: c.status,
          extraData: Object.keys(c.extraFields).length > 0 ? c.extraFields : null,
          previousShiftId: null,
          sourceRowNumber: c.rowNumber,
          sourceSheetName: c.sheetName,
        };
        await savePaymentShifts([input]);
        // savePaymentShifts doesn't report back the new id (a bulk insert,
        // by design) — safe to re-resolve it via the exact same position
        // lookup a later check would use to find this same row again.
        const created = await findPaymentShiftByPosition(config.sourceUrl, c.sheetName, c.rowNumber);
        newShiftId = created?.shiftId ?? null;
      }
      entries.push({
        ...identityBase(c),
        changeKind: "new-shift",
        matchedShiftId: newShiftId,
        columnLetter: null,
        fieldName: null,
        oldValue: null,
        newValue: null,
        message: null,
        applied: newShiftId !== null,
      });
      continue;
    }

    const shift = current;
    accountedForIds.add(shift.shiftId);
    const shiftFieldEntries: CheckDiffInput[] = [];
    function fieldDiff(fieldName: string, oldValue: string, newValue: string) {
      shiftFieldEntries.push({
        ...identityBase(c),
        changeKind: "field",
        matchedShiftId: shift.shiftId,
        columnLetter: null,
        fieldName,
        oldValue,
        newValue,
        message: null,
        applied: false,
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

    // "pago" is a payment-workflow state "Fazer pagamento" sets from inside
    // the app — the source file has no column that could ever resolve to
    // it (see `resolvePaymentStatus`), so comparing a paid shift's status
    // against the file would flag literally every payment ever made as a
    // "mudança", which isn't a real signal about the file at all.
    if (shift.status !== "pago" && shift.status !== c.status) fieldDiff("status", shift.status, c.status);

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
      shiftFieldEntries.push({
        ...identityBase(c),
        changeKind: "field",
        matchedShiftId: shift.shiftId,
        columnLetter: key,
        fieldName: `extra:${key}`,
        oldValue,
        newValue,
        message: null,
        applied: false,
      });
    }

    if (shiftFieldEntries.length === 0) continue;

    // One write covers every field this shift's diff found — the diff
    // itself stays per-field (for display), but `applyAutoSyncedFieldUpdate`
    // takes a full record, same as any other reimport. `c` already carries
    // this shift's complete fresh values, changed or not.
    if (canAutoApply(shift)) {
      const newShiftId = await applyAutoSyncedFieldUpdate(
        shift.shiftId,
        {
          workDate: c.workDate,
          local: c.local,
          role: c.role,
          scheduleStartMinutes: c.scheduleStartMinutes,
          scheduleEndMinutes: c.scheduleEndMinutes,
          status: shift.status === "pago" ? shift.status : c.status,
          extraData: Object.keys(c.extraFields).length > 0 ? c.extraFields : null,
          clientId: c.clientId,
          companyId: c.companyId,
        },
        autoApply!.sourceFileId,
        c.rowNumber,
        c.sheetName,
      );
      for (const e of shiftFieldEntries) entries.push({ ...e, matchedShiftId: newShiftId, applied: true });
    } else {
      entries.push(...shiftFieldEntries);
    }
  }

  // The inverse of "excluído" (a file row whose match was soft-deleted in
  // the system, flagged by `ImportPaymentsPage`'s duplicate-match check):
  // here the system's record is still very much alive, but nothing in this
  // read of the file landed on it. Scoped to this config's own template
  // sheets — with an empty `sheetNames` (CSV, or any template with only
  // sheet-less groups) that scoping is meaningless, so every head shift for
  // the URL/período is in play instead.
  const expectedSheetNames = new Set(template.groups.flatMap((g) => g.sheetNames));
  const existingHeads = await listHeadShiftsForSourceUrl(config.sourceUrl, periodStart, periodEnd);
  for (const h of existingHeads) {
    if (accountedForIds.has(h.shiftId)) continue;
    if (expectedSheetNames.size > 0 && !expectedSheetNames.has(h.sheetName ?? "")) continue;
    // Never auto-deleted via "Aceitar" (onlyShiftId set) — that action only
    // ever updates the fields of the one shift being reviewed, same rule
    // 'new-shift' creation follows above.
    const willAutoDelete = autoApply?.onlyShiftId === undefined && canAutoApply(h);
    if (willAutoDelete) await deletePaymentShift(h.shiftId);
    entries.push({
      configId: config.id,
      configLabel,
      changeKind: "removed",
      matchedShiftId: h.shiftId,
      employeeId: h.employeeId,
      employeeName: h.employeeName,
      workDate: h.workDate,
      local: h.local,
      role: h.role,
      scheduleStartMinutes: h.scheduleStartMinutes,
      scheduleEndMinutes: h.scheduleEndMinutes,
      sheetName: h.sheetName,
      rowNumber: h.rowNumber,
      columnLetter: null,
      fieldName: null,
      oldValue: null,
      newValue: null,
      message: willAutoDelete
        ? "Este turno não foi encontrado na leitura mais recente do arquivo — marcado como excluído automaticamente."
        : "Este turno não foi encontrado na leitura mais recente do arquivo — pode ter sido removido na fonte.",
      applied: willAutoDelete,
    });
  }

  return [...unresolvedEntries, ...entries];
}

/**
 * "Aceitar e atualizar" — a human reviewing one turno's pending diff on the
 * Pagamentos page (see `PaymentsPage`'s row-blocking Drawer) confirming it
 * should be written. Re-downloads `config.sourceUrl` fresh (the diff table
 * only ever stored DISPLAY strings for `oldValue`/`newValue`, e.g. a
 * schedule range like "08:00–17:00" — not something safe to parse back into
 * typed fields) and re-runs the same `computeReimportDiff` pass real
 * auto-apply uses, scoped to just this one shift (`onlyShiftId`) — clicking
 * "Aceitar" IS the human consent the two protection flags exist to require,
 * so both are forced on for this one write regardless of the config's own
 * saved defaults.
 */
export async function acceptShiftChange(config: ReimportConfig, shiftId: number): Promise<void> {
  const downloaded = await downloadPaymentFileFromUrl(config.sourceUrl);
  try {
    const { hash } = await hashPaymentFile(downloaded.path);
    const sourceFileId = await logSourceFile({
      fileHash: hash,
      fileName: downloaded.fileName,
      pageCount: 1,
      provider: resolveReimportConfigLabel(config),
      importType: "payment",
      status: "success",
      errorMessage: null,
      originalPdfPath: "",
      sourceUrl: config.sourceUrl,
      sourceEtag: downloaded.etag,
      sourceLastModified: downloaded.lastModified,
      sourceContentLength: downloaded.contentLength,
    });
    await computeReimportDiff(config, downloaded.path, {
      enabled: true,
      overwriteManualEdits: true,
      overwritePaid: true,
      sourceFileId,
      onlyShiftId: shiftId,
    });
    await markSourceFileSaved(hash);
  } finally {
    await deletePaths([downloaded.path]);
  }
}
