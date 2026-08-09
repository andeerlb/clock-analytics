import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileText,
  HelpCircle,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import Drawer from "../components/Drawer";
import Pagination from "../components/Pagination";
import {
  useRemoteFileUpdates,
  type ReimportConfig,
  type ReimportDateMode,
  type TrackedPaymentUrl,
} from "../contexts/RemoteFileUpdatesContext";
import {
  DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  deletePaymentShift,
  listCheckDiffCountsByLogIds,
  listCheckDiffs,
  listPaymentTemplates,
  listUrlCheckLog,
  type CheckDiffRow,
  type CheckLogConfigDiffCount,
  type UrlCheckLogEntry,
  type UrlCheckResult,
} from "../lib/db";
import {
  diffFieldLabel,
  formatCountdown,
  formatDateAbbrevYY,
  formatDateTimeAbbrevYY,
  parseSqliteDateTime,
  resolveReimportPeriod,
} from "../lib/format";
import type { PaymentTemplateListRow } from "../lib/types";

const RESULT_BADGE: Record<UrlCheckResult, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  changed: { className: "badge warn", label: "Mudou", icon: AlertTriangle },
  unchanged: { className: "badge ok", label: "Sem mudança", icon: CheckCircle2 },
  unknown: { className: "badge neutral", label: "Indeterminado", icon: HelpCircle },
  error: { className: "badge file-error", label: "Erro", icon: AlertCircle },
};

const LOG_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/** Same identity a deep check matched a record by (employee+data+local+função+horário) — used only to group this one check's diff rows into one card per changed record, not to look anything up. */
/** `'unresolved'` rows have no `employeeId` at all (that's the whole point — the file's colaborador/rota didn't match anything) — grouped by their own row/aba instead, so two different unmatched rows never collapse into one card just because they share null identity fields. */
function diffIdentityKey(r: CheckDiffRow): string {
  if (r.employeeId === null) return `unresolved:${r.sheetName ?? ""}:${r.rowNumber ?? ""}`;
  return `${r.employeeId}|${r.workDate}|${r.local}|${r.role}|${r.scheduleStartMinutes}|${r.scheduleEndMinutes}`;
}

/**
 * The Drawer detail for one "Histórico de verificações" row — grouped by
 * the specific record that changed, one small card per record with a
 * GitHub-diff-style before/after per field. `rows` is already scoped to a
 * single (check, config) pair by the caller (see `openLogDetail`) — no
 * config-level grouping here, since the history table itself never merges
 * more than one config into a single row anymore (each row IS one config).
 * `change_kind: 'new-shift'` records (no existing match at all) get their
 * own "Possível novo turno" card instead of a field diff; `'unresolved'`
 * records (a route or colaborador that didn't match anything — e.g. a typo
 * in the name column) get their own warning card with why, so a change that
 * can't be matched to anything still shows up as a change instead of
 * silently vanishing from the diff; `'error'` entries (a whole config or the
 * whole URL's deep pass failing) render as compact error lines, separate
 * from the field changes.
 */
function CheckDiffPanel({
  rows,
  markingShiftId,
  markedShiftIds,
  onMarkDeleted,
}: {
  rows: CheckDiffRow[];
  /** The one shift currently being soft-deleted via "Marcar como excluído" (disables just that card's button) — `null` when nothing's in flight. */
  markingShiftId: number | null;
  /** Shifts already marked this session — swaps that card's button for a confirmation instead of re-fetching the whole log to notice the same thing. */
  markedShiftIds: Set<number>;
  onMarkDeleted: (shiftId: number) => void;
}) {
  const errors = rows.filter((r) => r.changeKind === "error");
  const changes = rows.filter((r) => r.changeKind !== "error");
  const byIdentity = new Map<string, CheckDiffRow[]>();
  for (const r of changes) {
    const idKey = diffIdentityKey(r);
    const list = byIdentity.get(idKey) ?? [];
    list.push(r);
    byIdentity.set(idKey, list);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      {errors.map((e, i) => (
        <div
          key={`err-${i}`}
          className="error-box"
          style={{ fontSize: "0.78rem", padding: "0.45rem 0.7rem", marginBottom: "0.4rem" }}
        >
          {e.message}
        </div>
      ))}
      {Array.from(byIdentity.entries()).map(([idKey, entries]) => {
        const first = entries[0];
        const isNew = first.changeKind === "new-shift";
        const isUnresolved = first.changeKind === "unresolved";
        const isRemoved = first.changeKind === "removed";
        return (
          <div
            key={idKey}
            style={{
              border: `1px solid ${isNew ? "var(--accent)" : isUnresolved ? "var(--warning)" : isRemoved ? "var(--danger)" : "var(--border-soft)"}`,
              borderRadius: 8,
              padding: "0.5rem 0.7rem",
              marginBottom: "0.4rem",
            }}
          >
            <div style={{ fontSize: "0.82rem", fontWeight: 500 }}>
              {first.employeeName ?? "(nome vazio)"}
              {first.workDate ? ` — ${formatDateAbbrevYY(first.workDate)}` : ""}
              {" · "}
              {first.local || "—"} / {first.role || "—"}
            </div>
            {(first.sheetName || first.rowNumber !== null) && (
              <div className="muted" style={{ fontSize: "0.72rem" }}>
                {first.sheetName ? `aba ${first.sheetName}, ` : ""}
                {first.rowNumber !== null ? `linha ${first.rowNumber}` : ""}
              </div>
            )}
            {isNew ? (
              <span className="badge ok" style={{ marginTop: "0.35rem", display: "inline-flex" }}>
                Possível novo turno
              </span>
            ) : isUnresolved ? (
              <div
                style={{
                  marginTop: "0.35rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.78rem",
                  color: "var(--warning)",
                }}
              >
                <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                {first.message}
              </div>
            ) : isRemoved ? (
              <div style={{ marginTop: "0.35rem" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.78rem",
                    color: "var(--danger)",
                  }}
                >
                  <Trash2 size={13} style={{ flexShrink: 0 }} />
                  Não encontrado na leitura mais recente do arquivo — pode ter sido removido na fonte.
                </div>
                {first.matchedShiftId !== null &&
                  (markedShiftIds.has(first.matchedShiftId) ? (
                    <span className="badge neutral" style={{ marginTop: "0.35rem", display: "inline-flex" }}>
                      Marcado como excluído
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      style={{ marginTop: "0.35rem", fontSize: "0.76rem", padding: "0.25rem 0.5rem" }}
                      disabled={markingShiftId === first.matchedShiftId}
                      onClick={() => onMarkDeleted(first.matchedShiftId!)}
                    >
                      {markingShiftId === first.matchedShiftId ? "Marcando…" : "Marcar como excluído"}
                    </button>
                  ))}
              </div>
            ) : (
              <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                {entries.map((e, i) => (
                  <div key={i} style={{ fontSize: "0.78rem" }}>
                    <span className="muted">{diffFieldLabel(e.fieldName, e.columnLetter)}: </span>
                    <span
                      style={{
                        background: "var(--danger-soft)",
                        color: "var(--danger)",
                        textDecoration: "line-through",
                        padding: "0.05rem 0.35rem",
                        borderRadius: 4,
                      }}
                    >
                      {e.oldValue || "(vazio)"}
                    </span>
                    {" → "}
                    <span
                      style={{
                        background: "var(--success-soft)",
                        color: "var(--success)",
                        padding: "0.05rem 0.35rem",
                        borderRadius: 4,
                      }}
                    >
                      {e.newValue || "(vazio)"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ConfigDraft {
  dateMode: ReimportDateMode;
  start: string;
  end: string;
  startOffset: string;
  endOffset: string;
  interval: string;
  keepManualEdits: boolean;
}

function draftFromConfig(c: ReimportConfig): ConfigDraft {
  return {
    dateMode: c.dateMode,
    start: c.periodStart ?? "",
    end: c.periodEnd ?? "",
    startOffset: c.startOffsetDays !== null ? String(c.startOffsetDays) : "",
    endOffset: c.endOffsetDays !== null ? String(c.endOffsetDays) : "",
    interval: String(c.checkIntervalMinutes),
    keepManualEdits: c.keepManualEdits,
  };
}

/** Resolves a draft's Período the same way a saved config's would, for a live "vai usar: X → Y" preview while editing. */
function resolveDraftPeriod(draft: ConfigDraft): { start: string | null; end: string | null } {
  return resolveReimportPeriod({
    dateMode: draft.dateMode,
    periodStart: draft.start || null,
    periodEnd: draft.end || null,
    startOffsetDays: draft.startOffset === "" ? null : Number(draft.startOffset),
    endOffsetDays: draft.endOffset === "" ? null : Number(draft.endOffset),
  });
}

function formatResolvedPreview(resolved: { start: string | null; end: string | null }): string {
  if (!resolved.start && !resolved.end) return "todo o relatório";
  const start = resolved.start ? formatDateAbbrevYY(resolved.start) : "início";
  const end = resolved.end ? formatDateAbbrevYY(resolved.end) : "fim";
  return `${start} → ${end}`;
}

function draftIntervalValid(interval: string): boolean {
  if (interval.trim() === "") return false; // required — no global default to fall back to anymore
  const n = Number(interval);
  return Number.isFinite(n) && n >= 1;
}

const BLANK_NEW_CONFIG: ConfigDraft & { templateId: string } = {
  templateId: "",
  dateMode: "fixed",
  start: "",
  end: "",
  startOffset: "",
  endOffset: "",
  interval: String(DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES),
  keepManualEdits: true,
};

export default function RemoteUpdatesPage() {
  const navigate = useNavigate();
  const {
    remoteUpdates,
    dismissRemoteUpdate,
    trackedFiles,
    reimportConfigs,
    addReimportConfig,
    updateReimportConfig,
    setConfigCheckDisabled,
    deleteReimportConfig,
    untrackUrl,
    checkingUrls,
    forceCheckUrl,
    forceCheckAll,
    tickError,
  } = useRemoteFileUpdates();

  // Own loading flag for the global "Forçar verificação de todas" button —
  // deliberately NOT derived from `checkingUrls`/`checking`, which reflect
  // ANY check in flight (the regular scheduled tick, or a single config's
  // own "Forçar verificação"). Tying this button to that shared state made
  // it flip to "Verificando..." whenever an unrelated single check ran,
  // which reads as if "forçar todas" had been triggered when it hadn't.
  const [forcingAll, setForcingAll] = useState(false);
  async function handleForceCheckAll() {
    setForcingAll(true);
    try {
      await forceCheckAll();
    } finally {
      setForcingAll(false);
    }
  }

  // "Parar de rastrear" — one confirm modal at a time, across all files.
  const [untrackTarget, setUntrackTarget] = useState<TrackedPaymentUrl | null>(null);
  const [untracking, setUntracking] = useState(false);
  const [untrackError, setUntrackError] = useState<string | null>(null);

  async function handleConfirmUntrack() {
    if (!untrackTarget) return;
    setUntracking(true);
    setUntrackError(null);
    try {
      await untrackUrl(untrackTarget.sourceUrl);
      setUntrackTarget(null);
    } catch (e) {
      setUntrackError(String(e));
    } finally {
      setUntracking(false);
    }
  }

  // Live "next check in Xm Ys" per config — ticks once a second purely to
  // redraw against `trackedFiles`'/`reimportConfigs`' timestamps.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const [templates, setTemplates] = useState<PaymentTemplateListRow[]>([]);
  useEffect(() => {
    listPaymentTemplates().then(setTemplates);
  }, []);

  const lastCheckedByUrl = useMemo(
    () => new Map(trackedFiles.map((t) => [t.sourceUrl, t.lastCheckedAt])),
    [trackedFiles],
  );

  /** Every tracked file whose most recent check failed — a top-of-page summary, so a failure isn't only visible to whoever scrolls down to that specific file's card. */
  const erroredFiles = useMemo(() => trackedFiles.filter((t) => t.lastResult === "error"), [trackedFiles]);

  /** Same due-time math as the context's scheduler — mirrored here just for display. */
  function nextCheckAtFor(c: ReimportConfig): number | null {
    if (c.checkDisabled) return null;
    const lastCheckedAt = lastCheckedByUrl.get(c.sourceUrl);
    const effectiveMs = c.checkIntervalMinutes * 60_000;
    return lastCheckedAt ? parseSqliteDateTime(lastCheckedAt).getTime() + effectiveMs : now;
  }

  // Reimport config drafts — everything but the template is editable per
  // config; template is fixed at creation (see the field's own note below).
  const [configDrafts, setConfigDrafts] = useState<Map<number, ConfigDraft>>(new Map());
  const [savingConfigId, setSavingConfigId] = useState<number | null>(null);
  const [togglingConfigId, setTogglingConfigId] = useState<number | null>(null);
  const [deletingConfigId, setDeletingConfigId] = useState<number | null>(null);

  function configDraftFor(c: ReimportConfig): ConfigDraft {
    return configDrafts.get(c.id) ?? draftFromConfig(c);
  }

  function patchConfigDraft(c: ReimportConfig, patch: Partial<ConfigDraft>) {
    setConfigDrafts((prev) => {
      const current = prev.get(c.id) ?? draftFromConfig(c);
      return new Map(prev).set(c.id, { ...current, ...patch });
    });
  }

  async function handleSaveConfig(c: ReimportConfig) {
    const draft = configDraftFor(c);
    setSavingConfigId(c.id);
    try {
      await updateReimportConfig(c.id, {
        label: c.label,
        dateMode: draft.dateMode,
        periodStart: draft.dateMode === "fixed" ? draft.start || null : null,
        periodEnd: draft.dateMode === "fixed" ? draft.end || null : null,
        startOffsetDays: draft.dateMode === "relative" ? (draft.startOffset === "" ? null : Number(draft.startOffset)) : null,
        endOffsetDays: draft.dateMode === "relative" ? (draft.endOffset === "" ? null : Number(draft.endOffset)) : null,
        checkIntervalMinutes: Math.round(Number(draft.interval)),
        keepManualEdits: draft.keepManualEdits,
      });
      setConfigDrafts((prev) => {
        const next = new Map(prev);
        next.delete(c.id);
        return next;
      });
    } finally {
      setSavingConfigId(null);
    }
  }

  async function handleToggleConfig(c: ReimportConfig) {
    setTogglingConfigId(c.id);
    try {
      await setConfigCheckDisabled(c.id, !c.checkDisabled);
    } finally {
      setTogglingConfigId(null);
    }
  }

  async function handleDeleteConfig(id: number) {
    setDeletingConfigId(id);
    try {
      await deleteReimportConfig(id);
    } finally {
      setDeletingConfigId(null);
    }
  }

  // "Adicionar configuração" — one open form at a time, across all files.
  const [addingConfigForUrl, setAddingConfigForUrl] = useState<string | null>(null);
  const [newConfigDraft, setNewConfigDraft] = useState(BLANK_NEW_CONFIG);
  const [addingConfigSaving, setAddingConfigSaving] = useState(false);
  const [addingConfigError, setAddingConfigError] = useState<string | null>(null);

  function openAddConfig(sourceUrl: string) {
    setAddingConfigForUrl(sourceUrl);
    setNewConfigDraft(BLANK_NEW_CONFIG);
    setAddingConfigError(null);
  }

  async function handleCreateConfig() {
    if (!addingConfigForUrl) return;
    if (!newConfigDraft.templateId) {
      setAddingConfigError("Selecione um template.");
      return;
    }
    setAddingConfigSaving(true);
    setAddingConfigError(null);
    try {
      await addReimportConfig({
        sourceUrl: addingConfigForUrl,
        label: "",
        templateId: Number(newConfigDraft.templateId),
        dateMode: newConfigDraft.dateMode,
        periodStart: newConfigDraft.dateMode === "fixed" ? newConfigDraft.start || null : null,
        periodEnd: newConfigDraft.dateMode === "fixed" ? newConfigDraft.end || null : null,
        startOffsetDays:
          newConfigDraft.dateMode === "relative"
            ? newConfigDraft.startOffset === ""
              ? null
              : Number(newConfigDraft.startOffset)
            : null,
        endOffsetDays:
          newConfigDraft.dateMode === "relative"
            ? newConfigDraft.endOffset === ""
              ? null
              : Number(newConfigDraft.endOffset)
            : null,
        checkIntervalMinutes: Math.round(Number(newConfigDraft.interval)),
        keepManualEdits: newConfigDraft.keepManualEdits,
      });
      setAddingConfigForUrl(null);
    } catch (e) {
      setAddingConfigError(String(e));
    } finally {
      setAddingConfigSaving(false);
    }
  }

  const [logEntries, setLogEntries] = useState<UrlCheckLogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logPage, setLogPage] = useState(0);
  const [logPageSize, setLogPageSize] = useState(LOG_PAGE_SIZE_OPTIONS[0]);
  const [logUrlFilter, setLogUrlFilter] = useState("");

  // Per-(check, config) diff counts for the currently loaded page of
  // `logEntries` — one check covers every active config for a URL at once
  // (see `RemoteFileUpdatesContext.runChecks`), but this page always shows
  // one history ROW per config, so it needs each config's own count, not
  // just `logEntries`' combined total (see `displayRows` below).
  const [diffCountsByLogId, setDiffCountsByLogId] = useState<Map<number, CheckLogConfigDiffCount[]>>(new Map());

  // The Drawer's own diff detail — fetched lazily per check-log id (shared
  // across however many config-rows that one check unrolls into, filtered
  // per row when displayed) and cached, since most checks have none at all.
  const [diffsByLogId, setDiffsByLogId] = useState<Map<number, CheckDiffRow[]>>(new Map());
  const [loadingDiffLogId, setLoadingDiffLogId] = useState<number | null>(null);

  // "Marcar como excluído" on a 'removed' diff card — same soft-delete
  // `deletePaymentShift` uses on the Pagamentos table's own "Remover"
  // button, just reachable straight from the check that found it missing.
  const [markingDeletedShiftId, setMarkingDeletedShiftId] = useState<number | null>(null);
  const [markedDeletedShiftIds, setMarkedDeletedShiftIds] = useState<Set<number>>(new Set());

  async function handleMarkShiftDeleted(shiftId: number) {
    setMarkingDeletedShiftId(shiftId);
    try {
      await deletePaymentShift(shiftId);
      setMarkedDeletedShiftIds((prev) => new Set(prev).add(shiftId));
    } finally {
      setMarkingDeletedShiftId(null);
    }
  }

  useEffect(() => {
    listUrlCheckLog({ sourceUrl: logUrlFilter || undefined, page: logPage, pageSize: logPageSize }).then(
      ({ rows, total }) => {
        setLogEntries(rows);
        setLogTotal(total);
        listCheckDiffCountsByLogIds(rows.map((r) => r.id)).then((counts) => {
          const byLogId = new Map<number, CheckLogConfigDiffCount[]>();
          for (const c of counts) {
            const list = byLogId.get(c.checkLogId) ?? [];
            list.push(c);
            byLogId.set(c.checkLogId, list);
          }
          setDiffCountsByLogId(byLogId);
        });
      },
    );
    // `trackedFiles` changes once per check cycle — re-pulling the log
    // then keeps this table live without a separate poller of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logUrlFilter, logPage, logPageSize, trackedFiles]);

  const logPageCount = Math.max(1, Math.ceil(logTotal / logPageSize));
  const urlOptions = useMemo(
    () => Array.from(new Map(trackedFiles.map((t) => [t.sourceUrl, t.fileName])).entries()),
    [trackedFiles],
  );

  // If the URL the log is filtered to just stopped being tracked (e.g.
  // "Parar de rastrear"), fall back to "Todos os arquivos" instead of
  // silently showing an empty table filtered to a URL that no longer exists.
  useEffect(() => {
    if (logUrlFilter && !urlOptions.some(([url]) => url === logUrlFilter)) {
      setLogUrlFilter("");
      setLogPage(0);
    }
  }, [logUrlFilter, urlOptions]);

  interface CheckLogDisplayRow {
    key: string;
    entry: UrlCheckLogEntry;
    configId: number | null;
    /** The live config, when it still exists — drives Template/Período from current settings (a config can be edited/deleted since this check ran). `null` for a since-deleted config or a whole-URL entry, which fall back to `configLabel` (the snapshot `source_url_check_diffs.config_label` took at the time). */
    config: ReimportConfig | null;
    configLabel: string;
    diffCount: number;
  }

  /**
   * Unrolls each check-log entry into one row PER reimport config it
   * covered — never a single row combining several configs' templates/
   * períodos together (that's exactly what made it impossible to tell which
   * template an inconsistency came from). A config that produced diffs but
   * has since been edited/deleted still gets its own row, via the diff
   * rows' own `configLabel` snapshot instead of a live join.
   */
  const displayRows = useMemo<CheckLogDisplayRow[]>(() => {
    const out: CheckLogDisplayRow[] = [];
    for (const entry of logEntries) {
      const configsForEntry = reimportConfigs.filter((c) => c.sourceUrl === entry.sourceUrl);
      const counts = diffCountsByLogId.get(entry.id) ?? [];
      const countByConfigId = new Map<number, number>();
      let generalCount = 0;
      for (const c of counts) {
        if (c.configId === null) generalCount += c.diffCount;
        else countByConfigId.set(c.configId, (countByConfigId.get(c.configId) ?? 0) + c.diffCount);
      }

      const seenConfigIds = new Set<number>();
      for (const c of configsForEntry) {
        seenConfigIds.add(c.id);
        out.push({
          key: `${entry.id}:${c.id}`,
          entry,
          configId: c.id,
          config: c,
          configLabel: c.templateName ?? "Template removido",
          diffCount: countByConfigId.get(c.id) ?? 0,
        });
      }
      for (const c of counts) {
        if (c.configId === null || seenConfigIds.has(c.configId)) continue;
        out.push({
          key: `${entry.id}:${c.configId}`,
          entry,
          configId: c.configId,
          config: null,
          configLabel: c.configLabel || "Configuração removida",
          diffCount: c.diffCount,
        });
      }
      if (generalCount > 0 || (configsForEntry.length === 0 && counts.length === 0)) {
        out.push({
          key: `${entry.id}:general`,
          entry,
          configId: null,
          config: null,
          configLabel: generalCount > 0 ? "Verificação geral" : "—",
          diffCount: generalCount,
        });
      }
    }
    return out;
  }, [logEntries, reimportConfigs, diffCountsByLogId]);

  const [drawerRow, setDrawerRow] = useState<CheckLogDisplayRow | null>(null);
  const isLoadingDrawerDiff = drawerRow !== null && loadingDiffLogId === drawerRow.entry.id;
  const drawerDiffRows = drawerRow ? (diffsByLogId.get(drawerRow.entry.id) ?? []).filter((r) => r.configId === drawerRow.configId) : [];

  async function openLogDetail(row: CheckLogDisplayRow) {
    setDrawerRow(row);
    if (diffsByLogId.has(row.entry.id)) return;
    setLoadingDiffLogId(row.entry.id);
    try {
      const rows = await listCheckDiffs(row.entry.id);
      setDiffsByLogId((prev) => new Map(prev).set(row.entry.id, rows));
    } finally {
      setLoadingDiffLogId((id) => (id === row.entry.id ? null : id));
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/payments" />
        <h2 style={{ margin: 0 }}>Verificação automática</h2>
      </div>
      <p className="page-subtitle">
        Arquivos de pagamento importados por URL são verificados periodicamente — quando o
        conteúdo remoto muda, cada configuração de reimportação do arquivo avisa separadamente,
        com a opção de reimportar. Cada configuração roda no próprio intervalo e pode ser
        ativada/desativada por conta. Aqui dá pra gerenciar tudo isso e ver o histórico completo.
      </p>

      {tickError && (
        <div className="error-box">
          Falha ao verificar atualizações automaticamente: {tickError}
        </div>
      )}
      {erroredFiles.length > 0 && (
        <div className="error-box">
          {erroredFiles.length === 1
            ? `1 arquivo falhou na última verificação: ${erroredFiles[0].fileName}.`
            : `${erroredFiles.length} arquivos falharam na última verificação: ${erroredFiles.map((f) => f.fileName).join(", ")}.`}{" "}
          Veja os detalhes abaixo, em cada arquivo, ou no histórico.
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Arquivos rastreados</h3>
          <button
            type="button"
            className="ghost"
            onClick={handleForceCheckAll}
            disabled={trackedFiles.length === 0 || forcingAll}
            title="Verifica todos os arquivos rastreados agora, ignorando os intervalos configurados"
          >
            <RefreshCw size={14} className={forcingAll ? "spin" : undefined} style={{ marginRight: "0.35rem" }} />
            {forcingAll ? "Verificando..." : "Forçar verificação de todas"}
          </button>
        </div>
        {trackedFiles.length === 0 && (
          <p className="muted">Nenhum arquivo importado por URL ainda.</p>
        )}
        {trackedFiles.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem", marginTop: "1rem" }}>
            {trackedFiles.map((t: TrackedPaymentUrl) => {
              const updatesForFile = remoteUpdates.filter((u) => u.sourceUrl === t.sourceUrl);
              const configsForFile = reimportConfigs.filter((c) => c.sourceUrl === t.sourceUrl);
              return (
                <div
                  key={t.sourceUrl}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "0.8rem 1rem",
                    background: "var(--card-bg)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <FileText size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>{t.fileName}</span>
                    <button
                      type="button"
                      className="ghost"
                      style={{ marginLeft: "auto", padding: "0.15rem 0.5rem", fontSize: "0.75rem", color: "var(--danger)" }}
                      onClick={() => setUntrackTarget(t)}
                      title="Remove o rastreamento automático e o histórico de verificações deste arquivo — não afeta o que já foi importado"
                    >
                      <Trash2 size={12} style={{ marginRight: "0.3rem", verticalAlign: "-2px" }} />
                      Parar de rastrear
                    </button>
                  </div>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => openUrl(t.sourceUrl)}
                    title={t.sourceUrl}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      marginTop: "0.25rem",
                      maxWidth: "100%",
                      fontSize: "0.78rem",
                    }}
                  >
                    <Link2 size={12} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.sourceUrl}</span>
                  </button>
                  {t.lastResult === "error" && t.lastErrorMessage && (
                    <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                      {t.lastErrorMessage}
                    </div>
                  )}

                  <p className="muted" style={{ fontSize: "0.78rem", margin: "0.8rem 0 0.3rem" }}>
                    Configurações de reimportação — cada uma roda e avisa por conta própria:
                  </p>

                  {configsForFile.length === 0 && (
                    <p className="muted" style={{ fontSize: "0.82rem" }}>
                      Nenhuma configuração ainda — adicione uma pra habilitar a reimportação
                      automática deste arquivo.
                    </p>
                  )}

                  {configsForFile.map((c) => {
                    const draft = configDraftFor(c);
                    const preview = formatResolvedPreview(resolveDraftPeriod(draft));
                    const dueAt = nextCheckAtFor(c);
                    const update = updatesForFile.find((u) => u.configId === c.id);
                    return (
                      <div
                        key={c.id}
                        style={{
                          border: `1px solid ${update ? "var(--warning)" : "var(--border-soft)"}`,
                          borderRadius: 8,
                          padding: "0.6rem 0.7rem",
                          marginTop: "0.5rem",
                        }}
                      >
                        {update && (
                          <div
                            className="warning-box"
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: "1rem",
                              marginBottom: "0.6rem",
                            }}
                          >
                            <span>
                              <AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: "0.4rem" }} />
                              Mudou no servidor de origem.
                            </span>
                            <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                              <button type="button" className="outline" onClick={() => dismissRemoteUpdate(update.configId)}>
                                Ignorar
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  navigate("/import/payments", { state: { autoReimportConfigId: update.configId } })
                                }
                              >
                                Ir para Importar Pagamentos
                              </button>
                            </div>
                          </div>
                        )}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            marginBottom: "0.5rem",
                            flexWrap: "wrap",
                          }}
                        >
                          {c.checkDisabled ? (
                            <span className="badge neutral">Desativada</span>
                          ) : checkingUrls.has(c.sourceUrl) ? (
                            <span
                              className="muted"
                              style={{ fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                            >
                              <RefreshCw size={12} className="spin" />
                              Verificando agora...
                            </span>
                          ) : dueAt !== null && dueAt - now <= 0 ? (
                            <span className="muted" style={{ fontSize: "0.75rem" }}>
                              Rodando em instantes...
                            </span>
                          ) : (
                            <span className="muted" style={{ fontSize: "0.75rem" }}>
                              Próxima verificação em {dueAt !== null ? formatCountdown(dueAt - now) : "—"}
                            </span>
                          )}
                          <button
                            type="button"
                            className="ghost"
                            style={{ marginLeft: "auto", padding: "0.15rem 0.5rem", fontSize: "0.75rem" }}
                            onClick={() => navigate("/import/payments", { state: { autoReimportConfigId: c.id } })}
                            title="Abre Importar Pagamentos com este arquivo e template já preenchidos e reprocessa agora, mesmo sem mudança detectada no servidor de origem"
                          >
                            <Upload size={12} style={{ marginRight: "0.3rem", verticalAlign: "-2px" }} />
                            Reprocessar agora
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }}
                            onClick={() => forceCheckUrl(c.sourceUrl)}
                            disabled={checkingUrls.has(c.sourceUrl)}
                            title="Verifica este arquivo agora, ignorando o intervalo configurado"
                          >
                            <RefreshCw
                              size={12}
                              className={checkingUrls.has(c.sourceUrl) ? "spin" : undefined}
                              style={{ marginRight: "0.3rem", verticalAlign: "-2px" }}
                            />
                            Forçar verificação
                          </button>
                        </div>
                        <div className="field-row" style={{ marginBottom: 0, alignItems: "flex-end" }}>
                          <div className="field" style={{ flex: "0 1 150px", marginBottom: 0 }}>
                            <label>Template</label>
                            <p
                              className="muted"
                              style={{ margin: 0 }}
                              title="Definido ao criar a configuração — pra trocar, remova e crie de novo"
                            >
                              {c.templateName ?? "Template removido"}
                            </p>
                          </div>
                          <div className="field" style={{ flex: "0 1 120px", marginBottom: 0 }}>
                            <label>Modo</label>
                            <select
                              value={draft.dateMode}
                              onChange={(e) => patchConfigDraft(c, { dateMode: e.target.value as ReimportDateMode })}
                            >
                              <option value="fixed">Fixo</option>
                              <option value="relative">Relativo a hoje</option>
                            </select>
                          </div>
                          {draft.dateMode === "fixed" ? (
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label>Período</label>
                              <DateRangePicker
                                startValue={draft.start}
                                endValue={draft.end}
                                onChange={(start, end) => patchConfigDraft(c, { start, end })}
                              />
                            </div>
                          ) : (
                            <>
                              <div className="field" style={{ flex: "0 1 110px", marginBottom: 0 }}>
                                <label>Início (dias atrás)</label>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={draft.startOffset}
                                  onChange={(e) => patchConfigDraft(c, { startOffset: e.target.value })}
                                />
                              </div>
                              <div className="field" style={{ flex: "0 1 110px", marginBottom: 0 }}>
                                <label>Fim (dias atrás)</label>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={draft.endOffset}
                                  onChange={(e) => patchConfigDraft(c, { endOffset: e.target.value })}
                                />
                              </div>
                            </>
                          )}
                          <div className="field" style={{ flex: "0 1 110px", marginBottom: 0 }}>
                            <label>Intervalo (min)</label>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              required
                              value={draft.interval}
                              onChange={(e) => patchConfigDraft(c, { interval: e.target.value })}
                            />
                          </div>
                          <div className="field" style={{ flex: "0 1 200px", marginBottom: 0 }}>
                            <label
                              style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}
                              title="Uma reimportação automática por essa configuração não sobrescreve um turno já pago, revertido ou com valor corrigido à mão"
                            >
                              <input
                                type="checkbox"
                                checked={draft.keepManualEdits}
                                onChange={(e) => patchConfigDraft(c, { keepManualEdits: e.target.checked })}
                              />
                              Manter registros atualizados manualmente
                            </label>
                          </div>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleSaveConfig(c)}
                            disabled={savingConfigId === c.id || !draftIntervalValid(draft.interval)}
                          >
                            {savingConfigId === c.id ? "Salvando..." : "Salvar"}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleToggleConfig(c)}
                            disabled={togglingConfigId === c.id}
                          >
                            {togglingConfigId === c.id ? "..." : c.checkDisabled ? "Ativar" : "Desativar"}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            style={{ marginLeft: "auto", color: "var(--danger)" }}
                            onClick={() => handleDeleteConfig(c.id)}
                            disabled={deletingConfigId === c.id}
                            aria-label="Remover configuração"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {draft.dateMode === "relative" && (
                          <p className="muted" style={{ fontSize: "0.75rem", margin: "0.4rem 0 0" }}>
                            Vai usar: {preview}
                          </p>
                        )}
                      </div>
                    );
                  })}

                  {addingConfigForUrl === t.sourceUrl ? (
                    <div
                      style={{
                        border: "1px dashed var(--border)",
                        borderRadius: 8,
                        padding: "0.6rem 0.7rem",
                        marginTop: "0.5rem",
                      }}
                    >
                      {addingConfigError && <div className="error-box" style={{ marginBottom: "0.6rem" }}>{addingConfigError}</div>}
                      <div className="field-row" style={{ marginBottom: 0, alignItems: "flex-end" }}>
                        <div className="field" style={{ flex: "0 1 170px", marginBottom: 0 }}>
                          <label>Template</label>
                          <select
                            value={newConfigDraft.templateId}
                            onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, templateId: e.target.value }))}
                          >
                            <option value="">Selecione</option>
                            {templates.map((tpl) => (
                              <option key={tpl.id} value={tpl.id}>
                                {tpl.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field" style={{ flex: "0 1 120px", marginBottom: 0 }}>
                          <label>Modo</label>
                          <select
                            value={newConfigDraft.dateMode}
                            onChange={(e) =>
                              setNewConfigDraft((prev) => ({ ...prev, dateMode: e.target.value as ReimportDateMode }))
                            }
                          >
                            <option value="fixed">Fixo</option>
                            <option value="relative">Relativo a hoje</option>
                          </select>
                        </div>
                        {newConfigDraft.dateMode === "fixed" ? (
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label>Período</label>
                            <DateRangePicker
                              startValue={newConfigDraft.start}
                              endValue={newConfigDraft.end}
                              onChange={(start, end) => setNewConfigDraft((prev) => ({ ...prev, start, end }))}
                            />
                          </div>
                        ) : (
                          <>
                            <div className="field" style={{ flex: "0 1 110px", marginBottom: 0 }}>
                              <label>Início (dias atrás)</label>
                              <input
                                type="number"
                                min={0}
                                step={1}
                                value={newConfigDraft.startOffset}
                                onChange={(e) =>
                                  setNewConfigDraft((prev) => ({ ...prev, startOffset: e.target.value }))
                                }
                              />
                            </div>
                            <div className="field" style={{ flex: "0 1 110px", marginBottom: 0 }}>
                              <label>Fim (dias atrás)</label>
                              <input
                                type="number"
                                min={0}
                                step={1}
                                value={newConfigDraft.endOffset}
                                onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, endOffset: e.target.value }))}
                              />
                            </div>
                          </>
                        )}
                        <div className="field" style={{ flex: "0 1 110px", marginBottom: 0 }}>
                          <label>Intervalo (min)</label>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            required
                            value={newConfigDraft.interval}
                            onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, interval: e.target.value }))}
                          />
                        </div>
                        <div className="field" style={{ flex: "0 1 200px", marginBottom: 0 }}>
                          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
                            <input
                              type="checkbox"
                              checked={newConfigDraft.keepManualEdits}
                              onChange={(e) =>
                                setNewConfigDraft((prev) => ({ ...prev, keepManualEdits: e.target.checked }))
                              }
                            />
                            Manter registros atualizados manualmente
                          </label>
                        </div>
                        <button
                          type="button"
                          onClick={handleCreateConfig}
                          disabled={addingConfigSaving || !draftIntervalValid(newConfigDraft.interval)}
                        >
                          {addingConfigSaving ? "Adicionando..." : "Adicionar"}
                        </button>
                        <button type="button" className="ghost" onClick={() => setAddingConfigForUrl(null)}>
                          Cancelar
                        </button>
                      </div>
                      {newConfigDraft.dateMode === "relative" && (
                        <p className="muted" style={{ fontSize: "0.75rem", margin: "0.4rem 0 0" }}>
                          Vai usar: {formatResolvedPreview(resolveDraftPeriod(newConfigDraft))}
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      style={{ marginTop: "0.5rem" }}
                      onClick={() => openAddConfig(t.sourceUrl)}
                    >
                      <Plus size={14} style={{ marginRight: "0.3rem" }} />
                      Adicionar configuração
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card table-card">
        <div className="table-toolbar">
          <h3 style={{ margin: 0 }}>Histórico de verificações</h3>
          <select
            value={logUrlFilter}
            onChange={(e) => {
              setLogUrlFilter(e.target.value);
              setLogPage(0);
            }}
          >
            <option value="">Todos os arquivos</option>
            {urlOptions.map(([url, fileName]) => (
              <option key={url} value={url}>
                {fileName}
              </option>
            ))}
          </select>
        </div>

        {logTotal === 0 && <p className="muted" style={{ padding: "1.4rem" }}>Nenhuma verificação registrada ainda.</p>}

        {logTotal > 0 && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ whiteSpace: "nowrap" }}>Verificou em</th>
                    <th>Período</th>
                    <th>Template</th>
                    <th style={{ maxWidth: 260 }}>Arquivo</th>
                    <th style={{ whiteSpace: "nowrap" }}>Resultado</th>
                    <th>Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => {
                    const badge = RESULT_BADGE[row.entry.result];
                    const BadgeIcon = badge.icon;
                    const hasDiffs = row.diffCount > 0;
                    const isOpen = drawerRow?.key === row.key;
                    return (
                      <tr key={row.key}>
                        <td style={{ whiteSpace: "nowrap" }}>{formatDateTimeAbbrevYY(row.entry.checkedAt, true)}</td>
                        <td className="muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                          {row.config ? formatResolvedPreview(resolveReimportPeriod(row.config)) : "—"}
                        </td>
                        <td className="muted" style={{ fontSize: "0.8rem" }}>
                          {row.config ? (row.config.templateName ?? "Template removido") : row.configLabel}
                        </td>
                        <td style={{ maxWidth: 260 }}>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => openUrl(row.entry.sourceUrl)}
                            title={row.entry.sourceUrl}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.3rem",
                              maxWidth: "100%",
                            }}
                          >
                            <Link2 size={12} style={{ flexShrink: 0 }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {row.entry.fileName}
                            </span>
                          </button>
                        </td>
                        <td>
                          <span className={badge.className}>
                            <BadgeIcon size={13} />
                            {badge.label}
                          </span>
                        </td>
                        <td className="muted" style={{ fontSize: "0.8rem" }}>
                          {(hasDiffs || row.entry.message) && (
                            <button
                              type="button"
                              className={`count-chip chip-filter${isOpen ? " active" : ""}`}
                              onClick={() => openLogDetail(row)}
                              style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
                            >
                              <ChevronRight size={12} />
                              {hasDiffs ? (row.diffCount === 1 ? "1 alteração" : `${row.diffCount} alterações`) : "Erro"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {logTotal > LOG_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={logPage}
                pageCount={logPageCount}
                onPageChange={setLogPage}
                rangeLabel={`Mostrando ${logPage * logPageSize + 1} a ${Math.min(
                  logTotal,
                  logPage * logPageSize + logPageSize,
                )} de ${logTotal}`}
                pageSize={logPageSize}
                pageSizeOptions={LOG_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setLogPageSize(size);
                  setLogPage(0);
                }}
              />
            )}
          </>
        )}
      </div>

      {untrackTarget && (
        <ConfirmModal
          title="Parar de rastrear este arquivo?"
          message={`Remove o rastreamento automático e todo o histórico de verificações de "${untrackTarget.fileName}"${
            reimportConfigs.filter((c) => c.sourceUrl === untrackTarget.sourceUrl).length > 0
              ? ` (${reimportConfigs.filter((c) => c.sourceUrl === untrackTarget.sourceUrl).length} configuração(ões) de reimportação)`
              : ""
          }. Os turnos já importados não são afetados.`}
          confirmLabel={untracking ? "Removendo..." : "Parar de rastrear"}
          onConfirm={handleConfirmUntrack}
          onCancel={() => {
            setUntrackTarget(null);
            setUntrackError(null);
          }}
          confirmDisabled={untracking}
          error={untrackError}
        />
      )}

      <Drawer
        open={drawerRow !== null}
        onClose={() => setDrawerRow(null)}
        title={drawerRow ? `${drawerRow.configLabel} — ${formatDateTimeAbbrevYY(drawerRow.entry.checkedAt, true)}` : ""}
      >
        {drawerRow?.entry.message && (
          <div className="error-box" style={{ fontSize: "0.82rem" }}>
            {drawerRow.entry.message}
          </div>
        )}
        {isLoadingDrawerDiff && <p className="muted" style={{ margin: 0 }}>Carregando detalhes...</p>}
        {!isLoadingDrawerDiff && (
          <CheckDiffPanel
            rows={drawerDiffRows}
            markingShiftId={markingDeletedShiftId}
            markedShiftIds={markedDeletedShiftIds}
            onMarkDeleted={handleMarkShiftDeleted}
          />
        )}
      </Drawer>
    </div>
  );
}
