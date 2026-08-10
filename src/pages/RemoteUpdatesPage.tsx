import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
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
import type { PaymentTemplateListRow } from "../lib/types";

/** How many of a URL's most recent checks the "Histórico recente" strip shows. */
const HISTORY_STRIP_SIZE = 7;

const RESULT_BADGE: Record<UrlCheckResult, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  changed: { className: "badge warn", label: "Mudou", icon: AlertTriangle },
  unchanged: { className: "badge ok", label: "Sem mudança", icon: CheckCircle2 },
  unknown: { className: "badge neutral", label: "Indeterminado", icon: HelpCircle },
  error: { className: "badge file-error", label: "Erro", icon: AlertCircle },
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
    remoteUpdates,
    dismissRemoteUpdate,
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

  // Collapsed state per tracked URL — absent (not in the set) means
  // expanded, so every file starts open (matches the page's previous,
  // always-expanded behavior) and only collapses once the user asks.
  const [collapsedUrls, setCollapsedUrls] = useState<Set<string>>(new Set());
  function toggleFileExpanded(sourceUrl: string) {
    setCollapsedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(sourceUrl)) next.delete(sourceUrl);
      else next.add(sourceUrl);
      return next;
    });
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
      if (collapsedUrls.has(c.sourceUrl) || loadingHistoryConfigId === c.id) continue;
      const cached = historyByConfig.get(c.id);
      if (cached && cached.checkedAt === c.lastCheckedAt) continue;
      setLoadingHistoryConfigId(c.id);
      listUrlCheckLogForConfig(c.id, HISTORY_STRIP_SIZE)
        .then((rows) => setHistoryByConfig((prev) => new Map(prev).set(c.id, { checkedAt: c.lastCheckedAt, rows })))
        .finally(() => setLoadingHistoryConfigId((id) => (id === c.id ? null : id)));
      break; // one fetch at a time is plenty — the effect re-runs as soon as this one lands
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reimportConfigs, collapsedUrls, historyByConfig, loadingHistoryConfigId]);

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

  /** Every tracked file whose most recent check failed — a top-of-page summary, so a failure isn't only visible to whoever scrolls down to that specific file's card. */
  const erroredFiles = useMemo(() => trackedFiles.filter((t) => t.lastResult === "error"), [trackedFiles]);

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
      {erroredFiles.length > 0 && (
        <div className="error-box">
          {erroredFiles.length === 1
            ? `1 arquivo falhou na última verificação: ${erroredFiles[0].fileName}.`
            : `${erroredFiles.length} arquivos falharam na última verificação: ${erroredFiles.map((f) => f.fileName).join(", ")}.`}{" "}
          Veja os detalhes no histórico de cada configuração, abaixo.
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Arquivos rastreados</h3>
          <div style={{ display: "flex", gap: "0.5rem" }}>
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
        </div>
        {trackedFiles.length === 0 && (
          <p className="muted">Nenhum arquivo importado por URL ainda.</p>
        )}
        {trackedFiles.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem", marginTop: "1rem" }}>
            {trackedFiles.map((t: TrackedPaymentUrl) => {
              const updatesForFile = remoteUpdates.filter((u) => u.sourceUrl === t.sourceUrl);
              const configsForFile = reimportConfigs.filter((c) => c.sourceUrl === t.sourceUrl);
              const activeCount = configsForFile.filter((c) => !c.checkDisabled).length;
              const statusVariant = activeCount > 0 ? "active" : "paused";
              const statusLabel = configsForFile.length === 0 ? "Sem config." : activeCount > 0 ? "Ativo" : "Pausado";
              const expanded = !collapsedUrls.has(t.sourceUrl);
              const anyConfigChecking = configsForFile.some((c) => checkingConfigIds.has(c.id));
              return (
                <div key={t.sourceUrl} className="tracked-card">
                  <div className="tracked-card-header" onClick={() => toggleFileExpanded(t.sourceUrl)}>
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
                      {t.lastResult === "error" && t.lastErrorMessage && (
                        <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                          {t.lastErrorMessage}
                        </div>
                      )}
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
                        PARAR RASTREAMENTO
                      </button>
                      <button
                        type="button"
                        className={`tracked-chevron${expanded ? " expanded" : ""}`}
                        aria-label={expanded ? "Recolher" : "Expandir"}
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
                        const update = updatesForFile.find((u) => u.configId === c.id);

                        // This config's own recent-check history — fetched
                        // scoped to exactly the checks THIS config was
                        // evaluated in (see `listUrlCheckLogForConfig`), so a
                        // sibling config sharing the same URL never shows up
                        // here just because it happened to be checked too.
                        const configHistory = historyByConfig.get(c.id);
                        const configHistoryBars = configHistory
                          ? [...configHistory.rows].reverse().map((h) => ({
                              entry: h,
                              diffCount: h.diffCount,
                              failed: h.message !== null || h.hasOwnError,
                            }))
                          : [];
                        const configSuccessRate =
                          configHistoryBars.length > 0
                            ? Math.round(
                                (configHistoryBars.filter((b) => !b.failed).length / configHistoryBars.length) * 100,
                              )
                            : null;

                        return (
                          <div key={c.id}>
                            <div className="history-strip" style={{ marginBottom: "0.6rem" }}>
                              <div className="history-strip-head">
                                <span className="history-strip-label">
                                  HISTÓRICO RECENTE{configsForFile.length > 1 ? ` — ${c.templateName ?? "template removido"}` : ""}
                                </span>
                                {configSuccessRate !== null && (
                                  <span style={{ fontSize: "0.75rem", color: "var(--success)", fontWeight: 600 }}>
                                    <CheckCircle2 size={12} style={{ verticalAlign: "-2px", marginRight: "0.25rem" }} />
                                    {configSuccessRate}% sem erro
                                  </span>
                                )}
                              </div>
                              <div className="history-bars">
                                {configHistoryBars.length > 0
                                  ? configHistoryBars.map((b) => (
                                      <button
                                        key={b.entry.id}
                                        type="button"
                                        className={`history-bar ${b.failed ? "fail" : "ok"}`}
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
                                          ? "Rodando em instantes..."
                                          : `🕐 Próxima em ${dueAt !== null ? formatCountdown(dueAt - now) : "—"}`}
                                  </span>
                                </div>
                                <div className="field-row" style={{ marginBottom: "0.7rem" }}>
                                  <div className="field" style={{ flex: "1 1 140px", marginBottom: 0 }}>
                                    <label>Template</label>
                                    <p
                                      className="muted"
                                      style={{ margin: 0 }}
                                      title="Definido ao criar a configuração — pra trocar, remova e crie de novo"
                                    >
                                      {c.templateName ?? "Template removido"}
                                    </p>
                                  </div>
                                  <div className="field" style={{ flex: "1 1 120px", marginBottom: 0 }}>
                                    <label>Modo</label>
                                    <select
                                      value={draft.dateMode}
                                      onChange={(e) => patchConfigDraft(c, { dateMode: e.target.value as ReimportDateMode })}
                                    >
                                      <option value="fixed">Fixo</option>
                                      <option value="relative">Relativo a hoje</option>
                                    </select>
                                  </div>
                                </div>
                                {draft.dateMode === "fixed" ? (
                                  <div className="field" style={{ marginBottom: "0.7rem" }}>
                                    <label>Período</label>
                                    <DateRangePicker
                                      startValue={draft.start}
                                      endValue={draft.end}
                                      onChange={(start, end) => patchConfigDraft(c, { start, end })}
                                    />
                                  </div>
                                ) : (
                                  <div className="field-row" style={{ marginBottom: "0.7rem" }}>
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
                                <div className="field-row" style={{ marginBottom: 0 }}>
                                  <div className="field" style={{ flex: "1 1 110px", marginBottom: 0 }}>
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
                                  <div className="field" style={{ flex: "1 1 160px", marginBottom: 0 }}>
                                    <label>Período efetivo</label>
                                    <div className="effective-field">{resolvedPreview}</div>
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
                                    {savingConfigId === c.id ? "Salvando..." : "💾 Salvar configurações"}
                                  </button>
                                  <button
                                    type="button"
                                    className="outline"
                                    onClick={() => navigate("/import/payments", { state: { autoReimportConfigId: c.id } })}
                                    title="Abre Importar Pagamentos com este arquivo e template já preenchidos e reprocessa agora, mesmo sem mudança detectada no servidor de origem"
                                  >
                                    <Upload size={13} style={{ marginRight: "0.35rem", verticalAlign: "-2px" }} />
                                    Reprocessar agora
                                  </button>
                                  <div style={{ display: "flex", gap: "0.5rem" }}>
                                    <button
                                      type="button"
                                      className="ghost"
                                      style={{ flex: 1 }}
                                      onClick={() => forceCheckConfig(c.id)}
                                      disabled={checkingConfigIds.has(c.id)}
                                      title="Verifica esta configuração agora, ignorando o intervalo configurado"
                                    >
                                      <RefreshCw
                                        size={12}
                                        className={checkingConfigIds.has(c.id) ? "spin" : undefined}
                                        style={{ marginRight: "0.3rem", verticalAlign: "-2px" }}
                                      />
                                      Forçar verificação
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
                                      style={{ color: "var(--danger)" }}
                                      onClick={() => handleDeleteConfig(c.id)}
                                      disabled={deletingConfigId === c.id}
                                      aria-label="Remover configuração"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
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
                      <div style={{ marginTop: "0.5rem" }}>
                        <label
                          style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.85rem" }}
                          title="A verificação automática já aplica a mudança encontrada direto no sistema, em vez de deixar pendente pra revisão manual na tela de Pagamentos"
                        >
                          <input
                            type="checkbox"
                            checked={newConfigDraft.autoApplyEnabled}
                            onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, autoApplyEnabled: e.target.checked }))}
                          />
                          Atualizar registros automaticamente
                        </label>
                        {newConfigDraft.autoApplyEnabled && (
                          <div
                            style={{
                              marginLeft: "1.5rem",
                              marginTop: "0.3rem",
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.25rem",
                            }}
                          >
                            <label
                              className="muted"
                              style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.8rem" }}
                            >
                              <input
                                type="checkbox"
                                checked={newConfigDraft.autoApplyOverwriteManualEdits}
                                onChange={(e) =>
                                  setNewConfigDraft((prev) => ({ ...prev, autoApplyOverwriteManualEdits: e.target.checked }))
                                }
                              />
                              Sobrescrever edições manuais
                            </label>
                            <label
                              className="muted"
                              style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400, fontSize: "0.8rem" }}
                            >
                              <input
                                type="checkbox"
                                checked={newConfigDraft.autoApplyOverwritePaid}
                                onChange={(e) =>
                                  setNewConfigDraft((prev) => ({ ...prev, autoApplyOverwritePaid: e.target.checked }))
                                }
                              />
                              Sobrescrever turnos já pagos
                            </label>
                          </div>
                        )}
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
        {!isLoadingDrawerDiff && drawerDiffRows.length === 0 && !drawerRow?.entry.message && (
          <p className="muted" style={{ margin: 0 }}>Nenhuma mudança encontrada nesta verificação.</p>
        )}
        {!isLoadingDrawerDiff && drawerDiffRows.length > 0 && (
          <ChangeDiffPanel
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
