import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, FileText, Link2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import BackButton from "../components/BackButton";
import ChangeDiffPanel from "../components/ChangeDiffPanel";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import Drawer from "../components/Drawer";
import {
  useRemoteFileUpdates,
  type ReimportConfig,
  type ReimportDateMode,
  type TrackedPaymentUrl,
} from "../contexts/RemoteFileUpdatesContext";
import {
  DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  deletePaymentShift,
  dismissCheckDiffs,
  listCheckDiffs,
  listPaymentTemplates,
  listUrlCheckLogForConfig,
  type CheckDiffRow,
  type UrlCheckLogEntry,
  type UrlCheckResult,
} from "../lib/db";
import {
  formatCountdown,
  formatDateAbbrevYY,
  formatDateTimeAbbrevYY,
  parseSqliteDateTime,
  resolveReimportPeriod,
} from "../lib/format";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import type { PaymentTemplateListRow } from "../lib/types";

/** How many of a URL's most recent checks the "Histórico recente" strip shows. */
const HISTORY_STRIP_SIZE = 7;

/** Page size for the "Histórico completo" drawer's infinite scroll. */
const HISTORY_PAGE_SIZE = 30;

const RESULT_BADGE: Record<UrlCheckResult, { className: string; label: string }> = {
  // "warn" (this codebase's badge system, not this file's own vocabulary)
  // renders red/danger — same weight as an actual failure, which read as
  // "mudou" being just as urgent/bad as "erro". "overwrite" is the amber
  // one, matching `.history-bar.changed` below.
  changed: { className: "badge overwrite", label: "Mudou" },
  unchanged: { className: "badge ok", label: "Sem mudança" },
  unknown: { className: "badge neutral", label: "Indeterminado" },
  error: { className: "badge file-error", label: "Erro" },
};

interface ConfigDraft {
  dateMode: ReimportDateMode;
  start: string;
  end: string;
  startOffset: string;
  endOffset: string;
  interval: string;
  keepManualEdits: boolean;
  autoApplyEnabled: boolean;
  autoApplyOverwriteManualEdits: boolean;
  autoApplyOverwritePaid: boolean;
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
    autoApplyEnabled: c.autoApplyEnabled,
    autoApplyOverwriteManualEdits: c.autoApplyOverwriteManualEdits,
    autoApplyOverwritePaid: c.autoApplyOverwritePaid,
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
  if (resolved.start && resolved.start === resolved.end) return formatDateAbbrevYY(resolved.start);
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
  autoApplyEnabled: false,
  autoApplyOverwriteManualEdits: true,
  autoApplyOverwritePaid: false,
};

export default function RemoteUpdatesPage() {
  const navigate = useNavigate();
  const {
    trackedFiles,
    reimportConfigs,
    addReimportConfig,
    updateReimportConfig,
    setConfigCheckDisabled,
    deleteReimportConfig,
    untrackUrl,
    checkingConfigIds,
    forceCheckConfig,
    forceCheckAll,
    tickError,
  } = useRemoteFileUpdates();

  // Own loading flag for the global "Forçar verificação de todas" button —
  // deliberately NOT derived from `checkingConfigIds`/`checking`, which
  // reflect ANY check in flight (the regular scheduled tick, or a single
  // config's own "Forçar verificação"). Tying this button to that shared
  // state made
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

  // Expanded state per tracked URL — explicit user toggles only; absent
  // means "use the default", which is expanded unless every config for that
  // URL is disabled/missing (a "Pausado" file has nothing actively running,
  // so it starts out of the way instead).
  const [expandedOverrides, setExpandedOverrides] = useState<Map<string, boolean>>(new Map());
  function isUrlExpandedByDefault(sourceUrl: string): boolean {
    return reimportConfigs.some((rc) => rc.sourceUrl === sourceUrl && !rc.checkDisabled);
  }
  function toggleFileExpanded(sourceUrl: string, currentlyExpanded: boolean) {
    setExpandedOverrides((prev) => new Map(prev).set(sourceUrl, !currentlyExpanded));
  }

  // Recent-check history, per REIMPORT CONFIG — each one runs and reports
  // fully independently now (own schedule, own `lastCheckedAt`), so its
  // "Histórico recente" strip is fetched via `listUrlCheckLogForConfig`,
  // never a shared per-URL query re-colored afterward. Lazily fetched the
  // first time its file's card is expanded, then refreshed whenever that
  // config's own `lastCheckedAt` moves past what the cached snapshot was
  // fetched at (a fresh check landing shouldn't leave the strip stale).
  const [historyByConfig, setHistoryByConfig] = useState<
    Map<number, { checkedAt: string | null; rows: UrlCheckLogEntry[] }>
  >(new Map());
  const [loadingHistoryConfigId, setLoadingHistoryConfigId] = useState<number | null>(null);

  useEffect(() => {
    for (const c of reimportConfigs) {
      const expanded = expandedOverrides.get(c.sourceUrl) ?? isUrlExpandedByDefault(c.sourceUrl);
      if (!expanded || loadingHistoryConfigId === c.id) continue;
      const cached = historyByConfig.get(c.id);
      if (cached && cached.checkedAt === c.lastCheckedAt) continue;
      setLoadingHistoryConfigId(c.id);
      listUrlCheckLogForConfig(c.id, HISTORY_STRIP_SIZE)
        .then((rows) => setHistoryByConfig((prev) => new Map(prev).set(c.id, { checkedAt: c.lastCheckedAt, rows })))
        .finally(() => setLoadingHistoryConfigId((id) => (id === c.id ? null : id)));
      break; // one fetch at a time is plenty — the effect re-runs as soon as this one lands
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reimportConfigs, expandedOverrides, historyByConfig, loadingHistoryConfigId]);

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

  /** Same due-time math as the context's scheduler (`isConfigDue`) — mirrored here just for display, from this config's OWN `lastCheckedAt`, independent of any sibling config sharing the same `sourceUrl`. */
  function nextCheckAtFor(c: ReimportConfig): number | null {
    if (c.checkDisabled) return null;
    return c.lastCheckedAt ? parseSqliteDateTime(c.lastCheckedAt).getTime() + c.checkIntervalMinutes * 60_000 : now;
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
        autoApplyEnabled: draft.autoApplyEnabled,
        autoApplyOverwriteManualEdits: draft.autoApplyOverwriteManualEdits,
        autoApplyOverwritePaid: draft.autoApplyOverwritePaid,
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
        autoApplyEnabled: newConfigDraft.autoApplyEnabled,
        autoApplyOverwriteManualEdits: newConfigDraft.autoApplyOverwriteManualEdits,
        autoApplyOverwritePaid: newConfigDraft.autoApplyOverwritePaid,
      });
      setAddingConfigForUrl(null);
    } catch (e) {
      setAddingConfigError(String(e));
    } finally {
      setAddingConfigSaving(false);
    }
  }

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

  // "Aceitar e atualizar" on a 'field' diff card — mirrors
  // `PendingChangesTab.handleAccept`, scoped to whichever check's detail is
  // currently open in this Drawer (`drawerRow.config`, the LIVE config —
  // `null` if it's since been edited away/deleted, in which case there's
  // nothing left to re-download against).
  const [acceptingShiftId, setAcceptingShiftId] = useState<number | null>(null);
  const [acceptedShiftIds, setAcceptedShiftIds] = useState<Set<number>>(new Set());
  const [drawerActionError, setDrawerActionError] = useState<string | null>(null);

  async function handleAcceptShiftChange(shiftId: number) {
    if (!drawerRow?.config) {
      setDrawerActionError(
        "Não foi possível encontrar a configuração de reimportação que encontrou essa mudança — pode ter sido removida.",
      );
      return;
    }
    setAcceptingShiftId(shiftId);
    setDrawerActionError(null);
    try {
      await acceptShiftChange(drawerRow.config, shiftId);
      setAcceptedShiftIds((prev) => new Set(prev).add(shiftId));
    } catch (e) {
      setDrawerActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setAcceptingShiftId(null);
    }
  }

  // "Visto" on a card/line inside this check's own diff detail — same
  // `dismissCheckDiffs` the pending-updates banner uses, just updates the
  // cached `diffsByLogId` entry in place afterward instead of refetching.
  const [dismissingDiffIds, setDismissingDiffIds] = useState<Set<number>>(new Set());
  async function handleDismissDiffRows(rowIds: number[]) {
    setDismissingDiffIds((prev) => new Set([...prev, ...rowIds]));
    try {
      await dismissCheckDiffs(rowIds);
      const dismissedAt = new Date().toISOString();
      setDiffsByLogId((prev) => {
        const next = new Map(prev);
        for (const [logId, diffRows] of prev) {
          next.set(
            logId,
            diffRows.map((r) => (rowIds.includes(r.id) ? { ...r, dismissedAt } : r)),
          );
        }
        return next;
      });
    } finally {
      setDismissingDiffIds((prev) => {
        const next = new Set(prev);
        rowIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  interface CheckLogDisplayRow {
    key: string;
    entry: UrlCheckLogEntry;
    configId: number | null;
    /** The live config, when it still exists — drives Template/Período from current settings (a config can be edited/deleted since this check ran). `null` for a since-deleted config or a whole-URL entry, which fall back to `configLabel` (the snapshot `source_url_check_diffs.config_label` took at the time). */
    config: ReimportConfig | null;
    configLabel: string;
    diffCount: number;
  }

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

  // Período/template a check actually used — snapshotted per config on
  // `source_url_check_log_configs` at evaluation time (see
  // `logUrlCheckResult`), so this stays accurate even after the live config
  // is edited or deleted. Shown both on the full-history list and the
  // single-entry detail, since knowing WHAT was checked (not just when and
  // whether it failed) is what actually informs a decision here.
  function renderCheckMeta(entry: UrlCheckLogEntry) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1.2rem", fontSize: "0.78rem" }} className="muted">
        <span>
          Arquivo:{" "}
          <button
            type="button"
            className="link-button"
            title={entry.sourceUrl}
            onClick={(e) => {
              e.stopPropagation();
              openUrl(entry.sourceUrl);
            }}
          >
            {entry.fileName}
          </button>
        </span>
        <span>Período aplicado: {formatResolvedPreview({ start: entry.periodStart, end: entry.periodEnd })}</span>
        <span>
          Template:{" "}
          {entry.templateId !== null ? (
            <button
              type="button"
              className="link-button"
              onClick={(e) => {
                e.stopPropagation();
                navigate("/import/payments/templates", { state: { openTemplateId: entry.templateId } });
              }}
            >
              {entry.templateName ?? "Template removido"}
            </button>
          ) : (
            entry.templateName ?? "—"
          )}
        </span>
        {entry.errorDiffId !== null &&
          (entry.errorDismissedAt !== null ? (
            <span className="badge neutral" style={{ display: "inline-flex", fontSize: "0.68rem" }}>
              Visto
            </span>
          ) : (
            <button
              type="button"
              className="ghost"
              style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}
              disabled={dismissingErrorIds.has(entry.errorDiffId)}
              onClick={(e) => {
                e.stopPropagation();
                handleDismissError(entry.errorDiffId!);
              }}
            >
              {dismissingErrorIds.has(entry.errorDiffId) ? "..." : "Visto"}
            </button>
          ))}
      </div>
    );
  }

  // "Ver histórico completo" — a paginated (infinite scroll) view of a
  // config's full check history, shown in the same Drawer as the
  // single-entry detail (`drawerRow`) but never both at once. Kept around
  // while a row's detail is open (drilled into from the list) so closing
  // that detail returns to the already-fetched list instead of re-fetching
  // page 1.
  const [historyDrawerConfig, setHistoryDrawerConfig] = useState<{ configId: number; configLabel: string } | null>(
    null,
  );
  const [historyRows, setHistoryRows] = useState<UrlCheckLogEntry[]>([]);
  const [historyLoadingPage, setHistoryLoadingPage] = useState(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);

  async function openFullHistory(configId: number, configLabel: string) {
    setHistoryDrawerConfig({ configId, configLabel });
    setHistoryRows([]);
    setHistoryExhausted(false);
    setHistoryLoadingPage(true);
    try {
      const rows = await listUrlCheckLogForConfig(configId, HISTORY_PAGE_SIZE, 0);
      setHistoryRows(rows);
      if (rows.length < HISTORY_PAGE_SIZE) setHistoryExhausted(true);
    } finally {
      setHistoryLoadingPage(false);
    }
  }

  async function loadMoreHistory() {
    if (!historyDrawerConfig || historyLoadingPage || historyExhausted) return;
    setHistoryLoadingPage(true);
    try {
      const rows = await listUrlCheckLogForConfig(historyDrawerConfig.configId, HISTORY_PAGE_SIZE, historyRows.length);
      setHistoryRows((prev) => [...prev, ...rows]);
      if (rows.length < HISTORY_PAGE_SIZE) setHistoryExhausted(true);
    } finally {
      setHistoryLoadingPage(false);
    }
  }

  // Loads the next page once the sentinel at the bottom of the list scrolls
  // into view — re-subscribes whenever the guard conditions change so the
  // observer's callback always closes over fresh state.
  useEffect(() => {
    if (!historyDrawerConfig || historyExhausted) return;
    const el = historySentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreHistory();
      },
      { rootMargin: "150px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyDrawerConfig, historyRows, historyExhausted, historyLoadingPage]);

  function closeDrawer() {
    setDrawerRow(null);
    setHistoryDrawerConfig(null);
    setHistoryRows([]);
    setHistoryExhausted(false);
    setDrawerActionError(null);
  }

  // "Visto" on a check's own error — acknowledges it (via the same
  // `dismissCheckDiffs` the pending-updates banner uses on the exact same
  // `source_url_check_diffs` row) without removing it from either history
  // list here: only `entry.errorDismissedAt` flips, everywhere that entry is
  // currently held in state (the small strip, the full list, the open
  // detail), so the row stays visible/browsable, just marked seen.
  const [dismissingErrorIds, setDismissingErrorIds] = useState<Set<number>>(new Set());
  async function handleDismissError(diffId: number) {
    setDismissingErrorIds((prev) => new Set(prev).add(diffId));
    try {
      await dismissCheckDiffs([diffId]);
      const dismissedAt = new Date().toISOString();
      const markSeen = (r: UrlCheckLogEntry) => (r.errorDiffId === diffId ? { ...r, errorDismissedAt: dismissedAt } : r);
      setHistoryRows((prev) => prev.map(markSeen));
      setHistoryByConfig((prev) => {
        const next = new Map(prev);
        for (const [configId, data] of prev) next.set(configId, { ...data, rows: data.rows.map(markSeen) });
        return next;
      });
      setDrawerRow((prev) => (prev && prev.entry.errorDiffId === diffId ? { ...prev, entry: markSeen(prev.entry) } : prev));
    } finally {
      setDismissingErrorIds((prev) => {
        const next = new Set(prev);
        next.delete(diffId);
        return next;
      });
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
        ativada/desativada por conta. Aqui dá pra gerenciar tudo isso e ver o histórico recente
        de cada configuração.
      </p>

      {tickError && (
        <div className="error-box">
          Falha ao verificar atualizações automaticamente: {tickError}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginBottom: "1rem" }}>
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
        <button
          type="button"
          onClick={() => navigate("/import/payments")}
          title="Rastrear um novo arquivo — importe-o em Importar Pagamentos marcando 'Rastrear atualizações automaticamente'"
        >
          <Plus size={14} style={{ marginRight: "0.35rem", verticalAlign: "-2px" }} />
          Novo Arquivo
        </button>
      </div>
      {trackedFiles.length === 0 && (
        <p className="muted">Nenhum arquivo importado por URL ainda.</p>
      )}
      {trackedFiles.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          {trackedFiles.map((t: TrackedPaymentUrl) => {
              const configsForFile = reimportConfigs.filter((c) => c.sourceUrl === t.sourceUrl);
              const activeCount = configsForFile.filter((c) => !c.checkDisabled).length;
              const statusVariant = activeCount > 0 ? "active" : "paused";
              const statusLabel = configsForFile.length === 0 ? "Sem config." : activeCount > 0 ? "Ativo" : "Pausado";
              const expanded = expandedOverrides.get(t.sourceUrl) ?? activeCount > 0;
              const anyConfigChecking = configsForFile.some((c) => checkingConfigIds.has(c.id));
              return (
                <div key={t.sourceUrl} className="tracked-card">
                  <div className="tracked-card-header" onClick={() => toggleFileExpanded(t.sourceUrl, expanded)}>
                    <div className="tracked-card-icon">
                      <FileText size={16} />
                    </div>
                    <div className="tracked-card-title">
                      <div className="tracked-card-title-row">
                        <span className="tracked-card-name">{t.fileName}</span>
                        <span className={`status-pill ${statusVariant}`}>{statusLabel}</span>
                      </div>
                      <button
                        type="button"
                        className="link-button tracked-card-url"
                        onClick={(e) => {
                          e.stopPropagation();
                          openUrl(t.sourceUrl);
                        }}
                        title={t.sourceUrl}
                        style={{ display: "flex", alignItems: "center", gap: "0.35rem", maxWidth: "100%", fontSize: "0.78rem" }}
                      >
                        <Link2 size={12} style={{ flexShrink: 0 }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.sourceUrl}</span>
                      </button>
                    </div>
                    <div className="tracked-card-actions" onClick={(e) => e.stopPropagation()}>
                      {anyConfigChecking && (
                        <span
                          className="muted"
                          style={{ fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                        >
                          <RefreshCw size={12} className="spin" />
                          Verificando...
                        </span>
                      )}
                      <button
                        type="button"
                        className="stop-tracking-btn"
                        onClick={() => setUntrackTarget(t)}
                        title="Remove o rastreamento automático e o histórico de verificações deste arquivo — não afeta o que já foi importado"
                      >
                        REMOVER RASTREAMENTO
                      </button>
                      <button
                        type="button"
                        className={`tracked-chevron${expanded ? " expanded" : ""}`}
                        aria-label={expanded ? "Recolher" : "Expandir"}
                        onClick={() => toggleFileExpanded(t.sourceUrl, expanded)}
                      >
                        <ChevronDown size={18} />
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="tracked-card-body">
                      {configsForFile.length === 0 && (
                        <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>
                          Nenhuma configuração ainda — adicione uma pra habilitar a reimportação
                          automática deste arquivo.
                        </p>
                      )}

                      {configsForFile.map((c) => {
                        const draft = configDraftFor(c);
                        const resolvedPreview = formatResolvedPreview(resolveDraftPeriod(draft));
                        const dueAt = nextCheckAtFor(c);

                        // This config's own recent-check history — fetched
                        // scoped to exactly the checks THIS config was
                        // evaluated in (see `listUrlCheckLogForConfig`), so a
                        // sibling config sharing the same URL never shows up
                        // here just because it happened to be checked too.
                        const configHistory = historyByConfig.get(c.id);
                        const configHistoryBars = configHistory
                          ? configHistory.rows.map((h) => {
                              const failed = h.message !== null || h.hasOwnError;
                              return {
                                entry: h,
                                diffCount: h.diffCount,
                                failed,
                                // Diffs found for THIS config specifically (never a
                                // sibling's), excluding error rows — real changes to
                                // review, distinct from "sem mudança" (both are
                                // "no error", but only one has something to act on).
                                changed: !failed && h.diffCount > 0,
                              };
                            })
                          : [];

                        return (
                          <div key={c.id}>
                            <div className="config-grid">
                              <div className="sync-panel">
                                <div className="panel-head">
                                  <span className="panel-label">
                                    CONFIGURAÇÕES DE SINCRONIZAÇÃO
                                    {configsForFile.length > 1 ? ` — ${c.templateName ?? "template removido"}` : ""}
                                  </span>
                                  <span className="next-chip">
                                    {c.checkDisabled
                                      ? "Desativada"
                                      : checkingConfigIds.has(c.id)
                                        ? "Verificando agora..."
                                        : dueAt !== null && dueAt - now <= 0
                                          ? "Rodando"
                                          : `Próxima em ${dueAt !== null ? formatCountdown(dueAt - now) : "—"}`}
                                  </span>
                                </div>
                                <div className="sync-panel-columns">
                                  <div className="sync-panel-col">
                                    <div className="field">
                                      <label>Template</label>
                                      <div
                                        className="template-box"
                                        title="Definido ao criar a configuração — pra trocar, remova e crie de novo"
                                      >
                                        {c.templateName ?? "Template removido"}
                                      </div>
                                    </div>
                                    <div className="field">
                                      <label>Intervalo (min)</label>
                                      <div className="stepper">
                                        <button
                                          type="button"
                                          aria-label="Diminuir intervalo"
                                          onClick={() =>
                                            patchConfigDraft(c, {
                                              interval: String(Math.max(1, (Number(draft.interval) || 1) - 1)),
                                            })
                                          }
                                        >
                                          −
                                        </button>
                                        <input
                                          type="number"
                                          min={1}
                                          step={1}
                                          required
                                          value={draft.interval}
                                          onChange={(e) => patchConfigDraft(c, { interval: e.target.value })}
                                        />
                                        <button
                                          type="button"
                                          aria-label="Aumentar intervalo"
                                          onClick={() =>
                                            patchConfigDraft(c, { interval: String((Number(draft.interval) || 0) + 1) })
                                          }
                                        >
                                          +
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="sync-panel-col">
                                    <div className="field">
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
                                      <div className="field">
                                        <label>Período Selecionado</label>
                                        <DateRangePicker
                                          startValue={draft.start}
                                          endValue={draft.end}
                                          onChange={(start, end) => patchConfigDraft(c, { start, end })}
                                        />
                                      </div>
                                    ) : (
                                      <div className="field-row" style={{ marginBottom: 0 }}>
                                        <div className="field" style={{ flex: "1 1 110px", marginBottom: 0 }}>
                                          <label>Início (dias atrás)</label>
                                          <input
                                            type="number"
                                            min={0}
                                            step={1}
                                            value={draft.startOffset}
                                            onChange={(e) => patchConfigDraft(c, { startOffset: e.target.value })}
                                          />
                                        </div>
                                        <div className="field" style={{ flex: "1 1 110px", marginBottom: 0 }}>
                                          <label>Fim (dias atrás)</label>
                                          <input
                                            type="number"
                                            min={0}
                                            step={1}
                                            value={draft.endOffset}
                                            onChange={(e) => patchConfigDraft(c, { endOffset: e.target.value })}
                                          />
                                        </div>
                                      </div>
                                    )}
                                    <div className="field">
                                      <label>Período efetivo aplicável</label>
                                      <div className="effective-field">{resolvedPreview}</div>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div className="automation-panel">
                                <span className="panel-label" style={{ marginBottom: "0.75rem" }}>
                                  AUTOMAÇÃO E REGRAS
                                </span>
                                <div className="automation-toggle-box">
                                  <label
                                    style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", fontWeight: 400, cursor: "pointer" }}
                                    title="A verificação automática já aplica a mudança encontrada direto no sistema, em vez de deixar pendente pra revisão manual na tela de Pagamentos"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={draft.autoApplyEnabled}
                                      onChange={(e) => patchConfigDraft(c, { autoApplyEnabled: e.target.checked })}
                                      style={{ marginTop: "2px" }}
                                    />
                                    <span>
                                      <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>Atualizar registros automaticamente</div>
                                      <div className="muted" style={{ fontSize: "0.76rem", marginTop: "2px" }}>
                                        O sistema aplicará as regras abaixo nas sincronizações.
                                      </div>
                                    </span>
                                  </label>
                                </div>
                                <div className="automation-sub-rules">
                                  <label
                                    className="muted"
                                    style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.82rem" }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={draft.autoApplyOverwriteManualEdits}
                                      onChange={(e) => patchConfigDraft(c, { autoApplyOverwriteManualEdits: e.target.checked })}
                                      disabled={!draft.autoApplyEnabled}
                                    />
                                    Sobrescrever edições manuais
                                  </label>
                                  <label
                                    className="muted"
                                    style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.82rem" }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={draft.autoApplyOverwritePaid}
                                      onChange={(e) => patchConfigDraft(c, { autoApplyOverwritePaid: e.target.checked })}
                                      disabled={!draft.autoApplyEnabled}
                                    />
                                    Sobrescrever turnos já pagos
                                  </label>
                                  <label
                                    className="muted"
                                    style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.82rem" }}
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
                                <div className="automation-actions">
                                  <button
                                    type="button"
                                    onClick={() => handleSaveConfig(c)}
                                    disabled={savingConfigId === c.id || !draftIntervalValid(draft.interval)}
                                  >
                                    {savingConfigId === c.id ? "Salvando..." : "Salvar configurações"}
                                  </button>
                                  <button
                                    type="button"
                                    className="outline"
                                    onClick={() => navigate("/import/payments", { state: { autoReimportConfigId: c.id } })}
                                    title="Abre Importar Pagamentos com este arquivo e template já preenchidos e reprocessa agora, mesmo sem mudança detectada no servidor de origem"
                                  >
                                    Reprocessar agora
                                  </button>
                                  <div style={{ display: "flex", gap: "0.5rem" }}>
                                    <button
                                      type="button"
                                      className="outline"
                                      style={{ flex: 1 }}
                                      onClick={() => forceCheckConfig(c.id)}
                                      disabled={checkingConfigIds.has(c.id)}
                                      title="Verifica esta configuração agora, ignorando o intervalo configurado"
                                    >
                                      {checkingConfigIds.has(c.id) ? "Verificando..." : "Forçar verificação"}
                                    </button>
                                    <button
                                      type="button"
                                      className="outline"
                                      onClick={() => handleToggleConfig(c)}
                                      disabled={togglingConfigId === c.id}
                                    >
                                      {togglingConfigId === c.id ? "..." : c.checkDisabled ? "Ativar" : "Desativar"}
                                    </button>
                                    <button
                                      type="button"
                                      className="outline"
                                      style={{ color: "var(--danger)" }}
                                      onClick={() => handleDeleteConfig(c.id)}
                                      disabled={deletingConfigId === c.id}
                                    >
                                      {deletingConfigId === c.id ? "Removendo..." : "Remover"}
                                    </button>
                                  </div>
                                </div>
                              </div>
                              <div className="history-strip" style={{ gridColumn: "1 / -1" }}>
                                <div className="history-strip-head">
                                  <span className="history-strip-label">
                                    HISTÓRICO RECENTE{configsForFile.length > 1 ? ` — ${c.templateName ?? "template removido"}` : ""}
                                  </span>
                                  <button
                                    type="button"
                                    className="link-button"
                                    style={{ fontSize: "0.75rem" }}
                                    onClick={() => openFullHistory(c.id, c.templateName ?? "Template removido")}
                                  >
                                    Ver histórico completo
                                  </button>
                                </div>
                                <div className="history-bars">
                                  {configHistoryBars.length > 0
                                    ? configHistoryBars.map((b) => (
                                        <button
                                          key={b.entry.id}
                                          type="button"
                                          className={`history-bar ${b.failed ? "fail" : b.changed ? "changed" : "ok"}`}
                                          title={`${formatDateTimeAbbrevYY(b.entry.checkedAt, true)} — ${RESULT_BADGE[b.entry.result].label}${b.diffCount > 0 ? ` (${b.diffCount})` : ""} — clique para ver os detalhes`}
                                          onClick={() =>
                                            openLogDetail({
                                              key: `${b.entry.id}:${c.id}`,
                                              entry: b.entry,
                                              configId: c.id,
                                              config: c,
                                              configLabel: c.templateName ?? "Template removido",
                                              diffCount: b.diffCount,
                                            })
                                          }
                                        />
                                      ))
                                    : Array.from({ length: HISTORY_STRIP_SIZE }).map((_, i) => (
                                        <div key={i} className="history-bar" />
                                      ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {addingConfigForUrl === t.sourceUrl ? (
                        <div style={{ marginTop: "0.5rem" }}>
                          {addingConfigError && (
                            <div className="error-box" style={{ marginBottom: "0.6rem" }}>
                              {addingConfigError}
                            </div>
                          )}
                          <div className="config-grid">
                            <div className="sync-panel">
                              <div className="panel-head">
                                <span className="panel-label">NOVA CONFIGURAÇÃO</span>
                              </div>
                              <div className="sync-panel-columns">
                                <div className="sync-panel-col">
                                  <div className="field">
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
                                  <div className="field">
                                    <label>Intervalo (min)</label>
                                    <div className="stepper">
                                      <button
                                        type="button"
                                        aria-label="Diminuir intervalo"
                                        onClick={() =>
                                          setNewConfigDraft((prev) => ({
                                            ...prev,
                                            interval: String(Math.max(1, (Number(prev.interval) || 1) - 1)),
                                          }))
                                        }
                                      >
                                        −
                                      </button>
                                      <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        required
                                        value={newConfigDraft.interval}
                                        onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, interval: e.target.value }))}
                                      />
                                      <button
                                        type="button"
                                        aria-label="Aumentar intervalo"
                                        onClick={() =>
                                          setNewConfigDraft((prev) => ({
                                            ...prev,
                                            interval: String((Number(prev.interval) || 0) + 1),
                                          }))
                                        }
                                      >
                                        +
                                      </button>
                                    </div>
                                  </div>
                                </div>
                                <div className="sync-panel-col">
                                  <div className="field">
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
                                    <div className="field">
                                      <label>Período Selecionado</label>
                                      <DateRangePicker
                                        startValue={newConfigDraft.start}
                                        endValue={newConfigDraft.end}
                                        onChange={(start, end) => setNewConfigDraft((prev) => ({ ...prev, start, end }))}
                                      />
                                    </div>
                                  ) : (
                                    <div className="field-row" style={{ marginBottom: 0 }}>
                                      <div className="field" style={{ flex: "1 1 110px", marginBottom: 0 }}>
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
                                      <div className="field" style={{ flex: "1 1 110px", marginBottom: 0 }}>
                                        <label>Fim (dias atrás)</label>
                                        <input
                                          type="number"
                                          min={0}
                                          step={1}
                                          value={newConfigDraft.endOffset}
                                          onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, endOffset: e.target.value }))}
                                        />
                                      </div>
                                    </div>
                                  )}
                                  <div className="field">
                                    <label>Período efetivo aplicável</label>
                                    <div className="effective-field">
                                      {formatResolvedPreview(resolveDraftPeriod(newConfigDraft))}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="automation-panel">
                              <span className="panel-label" style={{ marginBottom: "0.75rem" }}>
                                AUTOMAÇÃO E REGRAS
                              </span>
                              <div className="automation-toggle-box">
                                <label
                                  style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", fontWeight: 400, cursor: "pointer" }}
                                  title="A verificação automática já aplica a mudança encontrada direto no sistema, em vez de deixar pendente pra revisão manual na tela de Pagamentos"
                                >
                                  <input
                                    type="checkbox"
                                    checked={newConfigDraft.autoApplyEnabled}
                                    onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, autoApplyEnabled: e.target.checked }))}
                                    style={{ marginTop: "2px" }}
                                  />
                                  <span>
                                    <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>Atualizar registros automaticamente</div>
                                    <div className="muted" style={{ fontSize: "0.76rem", marginTop: "2px" }}>
                                      O sistema aplicará as regras abaixo nas sincronizações.
                                    </div>
                                  </span>
                                </label>
                              </div>
                              <div className="automation-sub-rules">
                                <label
                                  className="muted"
                                  style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.82rem" }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={newConfigDraft.autoApplyOverwriteManualEdits}
                                    onChange={(e) =>
                                      setNewConfigDraft((prev) => ({ ...prev, autoApplyOverwriteManualEdits: e.target.checked }))
                                    }
                                    disabled={!newConfigDraft.autoApplyEnabled}
                                  />
                                  Sobrescrever edições manuais
                                </label>
                                <label
                                  className="muted"
                                  style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.82rem" }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={newConfigDraft.autoApplyOverwritePaid}
                                    onChange={(e) =>
                                      setNewConfigDraft((prev) => ({ ...prev, autoApplyOverwritePaid: e.target.checked }))
                                    }
                                    disabled={!newConfigDraft.autoApplyEnabled}
                                  />
                                  Sobrescrever turnos já pagos
                                </label>
                                <label
                                  className="muted"
                                  style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.82rem" }}
                                  title="Uma reimportação automática por essa configuração não sobrescreve um turno já pago, revertido ou com valor corrigido à mão"
                                >
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
                              <div className="automation-actions">
                                <button
                                  type="button"
                                  onClick={handleCreateConfig}
                                  disabled={addingConfigSaving || !draftIntervalValid(newConfigDraft.interval)}
                                >
                                  {addingConfigSaving ? "Adicionando..." : "Adicionar"}
                                </button>
                                <button type="button" className="outline" onClick={() => setAddingConfigForUrl(null)}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          </div>
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
                  )}
                </div>
              );
            })}
        </div>
      )}

      {untrackTarget && (
        <ConfirmModal
          title="Remover rastreamento deste arquivo?"
          message={`Remove o rastreamento automático e todo o histórico de verificações de "${untrackTarget.fileName}"${
            reimportConfigs.filter((c) => c.sourceUrl === untrackTarget.sourceUrl).length > 0
              ? ` (${reimportConfigs.filter((c) => c.sourceUrl === untrackTarget.sourceUrl).length} configuração(ões) de reimportação)`
              : ""
          }. Os turnos já importados não são afetados.`}
          confirmLabel={untracking ? "Removendo..." : "Remover rastreamento"}
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
        open={drawerRow !== null || historyDrawerConfig !== null}
        onClose={closeDrawer}
        width="min(680px, 95vw)"
        title={
          drawerRow
            ? `${drawerRow.configLabel} — ${formatDateTimeAbbrevYY(drawerRow.entry.checkedAt, true)}`
            : historyDrawerConfig
              ? `Histórico completo — ${historyDrawerConfig.configLabel}`
              : ""
        }
      >
        {drawerRow && (
          <>
            {historyDrawerConfig && (
              <button
                type="button"
                className="ghost"
                style={{ marginBottom: "0.8rem", paddingLeft: 0 }}
                onClick={() => setDrawerRow(null)}
              >
                ← Voltar ao histórico completo
              </button>
            )}
            <div style={{ marginBottom: "0.8rem" }}>{renderCheckMeta(drawerRow.entry)}</div>
            {drawerActionError && (
              <div className="error-box" style={{ fontSize: "0.82rem", marginBottom: "0.6rem" }}>
                {drawerActionError}
              </div>
            )}
            {drawerRow.entry.message && (
              <>
                <div className="error-box" style={{ fontSize: "0.82rem" }}>
                  {drawerRow.entry.message}
                </div>
                {drawerRow.configId !== null && (
                  <button
                    type="button"
                    style={{ marginTop: "0.6rem" }}
                    onClick={() =>
                      navigate("/import/payments", {
                        state: {
                          autoReimportConfigId: drawerRow.configId,
                          autoReimportPeriodStart: drawerRow.entry.periodStart,
                          autoReimportPeriodEnd: drawerRow.entry.periodEnd,
                        },
                      })
                    }
                    title="Abre Importar Pagamentos com este arquivo e template já preenchidos e reprocessa agora, com o mesmo período que essa verificação usou"
                  >
                    Reprocessar agora
                  </button>
                )}
              </>
            )}
            {isLoadingDrawerDiff && <p className="muted" style={{ margin: 0 }}>Carregando detalhes...</p>}
            {!isLoadingDrawerDiff && drawerDiffRows.length === 0 && !drawerRow.entry.message && (
              <p className="muted" style={{ margin: 0 }}>Nenhuma mudança encontrada nesta verificação.</p>
            )}
            {!isLoadingDrawerDiff && drawerDiffRows.length > 0 && (
              <ChangeDiffPanel
                rows={drawerDiffRows}
                markingShiftId={markingDeletedShiftId}
                markedShiftIds={markedDeletedShiftIds}
                onMarkDeleted={handleMarkShiftDeleted}
                onAccept={handleAcceptShiftChange}
                acceptingShiftId={acceptingShiftId}
                acceptedShiftIds={acceptedShiftIds}
                onDismiss={handleDismissDiffRows}
                dismissingIds={dismissingDiffIds}
                onReprocess={(configId, periodStart, periodEnd) =>
                  navigate("/import/payments", {
                    state: {
                      autoReimportConfigId: configId,
                      autoReimportPeriodStart: periodStart,
                      autoReimportPeriodEnd: periodEnd,
                    },
                  })
                }
              />
            )}
          </>
        )}

        {!drawerRow && historyDrawerConfig && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {historyRows.length === 0 && historyLoadingPage && (
              <p className="muted" style={{ margin: 0 }}>Carregando...</p>
            )}
            {historyRows.length === 0 && !historyLoadingPage && (
              <p className="muted" style={{ margin: 0 }}>Nenhuma verificação registrada ainda.</p>
            )}
            {historyRows.map((entry) => {
              const badge = RESULT_BADGE[entry.result];
              return (
                <div
                  key={entry.id}
                  className="history-full-row"
                  onClick={() =>
                    openLogDetail({
                      key: `${entry.id}:${historyDrawerConfig.configId}`,
                      entry,
                      configId: historyDrawerConfig.configId,
                      config: reimportConfigs.find((rc) => rc.id === historyDrawerConfig.configId) ?? null,
                      configLabel: historyDrawerConfig.configLabel,
                      diffCount: entry.diffCount,
                    })
                  }
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem" }}>
                    <span style={{ fontSize: "0.82rem" }}>{formatDateTimeAbbrevYY(entry.checkedAt, true)}</span>
                    <span className={badge.className} style={{ fontSize: "0.7rem" }}>
                      {badge.label}
                      {entry.diffCount > 0 ? ` (${entry.diffCount})` : ""}
                    </span>
                  </div>
                  {entry.message && (
                    <div style={{ fontSize: "0.78rem", color: "var(--danger)", marginTop: "0.35rem" }}>{entry.message}</div>
                  )}
                  <div style={{ marginTop: "0.35rem" }}>{renderCheckMeta(entry)}</div>
                </div>
              );
            })}
            {!historyExhausted && <div ref={historySentinelRef} style={{ height: 1 }} />}
            {historyLoadingPage && historyRows.length > 0 && (
              <p className="muted" style={{ margin: 0, textAlign: "center", fontSize: "0.78rem" }}>
                Carregando mais...
              </p>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
