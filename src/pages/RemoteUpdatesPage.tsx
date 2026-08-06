import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  HelpCircle,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import BackButton from "../components/BackButton";
import DateRangePicker from "../components/DateRangePicker";
import Pagination from "../components/Pagination";
import {
  useRemoteFileUpdates,
  type ReimportConfig,
  type ReimportDateMode,
  type TrackedPaymentUrl,
} from "../contexts/RemoteFileUpdatesContext";
import {
  DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  listPaymentTemplates,
  listUrlCheckLog,
  type UrlCheckLogEntry,
  type UrlCheckResult,
} from "../lib/db";
import {
  formatCountdown,
  formatDateTime,
  formatDayShort,
  parseSqliteDateTime,
  resolveReimportConfigLabel,
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

interface ConfigDraft {
  label: string;
  dateMode: ReimportDateMode;
  start: string;
  end: string;
  startOffset: string;
  endOffset: string;
  interval: string;
}

function draftFromConfig(c: ReimportConfig): ConfigDraft {
  return {
    label: c.label,
    dateMode: c.dateMode,
    start: c.periodStart ?? "",
    end: c.periodEnd ?? "",
    startOffset: c.startOffsetDays !== null ? String(c.startOffsetDays) : "",
    endOffset: c.endOffsetDays !== null ? String(c.endOffsetDays) : "",
    interval: String(c.checkIntervalMinutes),
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
  const start = resolved.start ? formatDayShort(resolved.start) : "início";
  const end = resolved.end ? formatDayShort(resolved.end) : "fim";
  return `${start} → ${end}`;
}

function draftIntervalValid(interval: string): boolean {
  if (interval.trim() === "") return false; // required — no global default to fall back to anymore
  const n = Number(interval);
  return Number.isFinite(n) && n >= 1;
}

const BLANK_NEW_CONFIG: ConfigDraft & { templateId: string } = {
  label: "",
  templateId: "",
  dateMode: "fixed",
  start: "",
  end: "",
  startOffset: "",
  endOffset: "",
  interval: String(DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES),
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
    checkingUrls,
    forceCheckUrl,
    forceCheckAll,
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
        label: draft.label,
        dateMode: draft.dateMode,
        periodStart: draft.dateMode === "fixed" ? draft.start || null : null,
        periodEnd: draft.dateMode === "fixed" ? draft.end || null : null,
        startOffsetDays: draft.dateMode === "relative" ? (draft.startOffset === "" ? null : Number(draft.startOffset)) : null,
        endOffsetDays: draft.dateMode === "relative" ? (draft.endOffset === "" ? null : Number(draft.endOffset)) : null,
        checkIntervalMinutes: Math.round(Number(draft.interval)),
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
        label: newConfigDraft.label,
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

  useEffect(() => {
    listUrlCheckLog({ sourceUrl: logUrlFilter || undefined, page: logPage, pageSize: logPageSize }).then(
      ({ rows, total }) => {
        setLogEntries(rows);
        setLogTotal(total);
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/import/payments" />
        <h2 style={{ margin: 0 }}>Verificação automática</h2>
      </div>
      <p className="page-subtitle">
        Arquivos de pagamento importados por URL são verificados periodicamente — quando o
        conteúdo remoto muda, cada configuração de reimportação do arquivo avisa separadamente,
        com a opção de reimportar. Cada configuração roda no próprio intervalo e pode ser
        ativada/desativada por conta. Aqui dá pra gerenciar tudo isso e ver o histórico completo.
      </p>

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
                          <div className="field" style={{ flex: "1 1 160px", marginBottom: 0 }}>
                            <label>Rótulo</label>
                            <input
                              type="text"
                              value={draft.label}
                              placeholder={resolveReimportConfigLabel(c)}
                              onChange={(e) => patchConfigDraft(c, { label: e.target.value })}
                            />
                          </div>
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
                        <div className="field" style={{ flex: "1 1 160px", marginBottom: 0 }}>
                          <label>Rótulo (opcional)</label>
                          <input
                            type="text"
                            value={newConfigDraft.label}
                            onChange={(e) => setNewConfigDraft((prev) => ({ ...prev, label: e.target.value }))}
                          />
                        </div>
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
                    <th style={{ whiteSpace: "nowrap" }}>Quando</th>
                    <th style={{ maxWidth: 260 }}>Arquivo</th>
                    <th style={{ whiteSpace: "nowrap" }}>Resultado</th>
                    <th>Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  {logEntries.map((entry) => {
                    const badge = RESULT_BADGE[entry.result];
                    const BadgeIcon = badge.icon;
                    return (
                      <tr key={entry.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.checkedAt)}</td>
                        <td
                          style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={entry.fileName}
                        >
                          {entry.fileName}
                        </td>
                        <td>
                          <span className={badge.className}>
                            <BadgeIcon size={13} />
                            {badge.label}
                          </span>
                        </td>
                        <td className="muted" style={{ fontSize: "0.8rem" }}>
                          {entry.message ?? "—"}
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
    </div>
  );
}
