import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  HelpCircle,
  Link2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import BackButton from "../components/BackButton";
import Pagination from "../components/Pagination";
import { useRemoteFileUpdates, type TrackedPaymentUrl } from "../contexts/RemoteFileUpdatesContext";
import { listUrlCheckLog, type UrlCheckLogEntry, type UrlCheckResult } from "../lib/db";
import { formatCountdown, formatDateTime } from "../lib/format";

const RESULT_BADGE: Record<UrlCheckResult, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  changed: { className: "badge warn", label: "Mudou", icon: AlertTriangle },
  unchanged: { className: "badge ok", label: "Sem mudança", icon: CheckCircle2 },
  unknown: { className: "badge neutral", label: "Indeterminado", icon: HelpCircle },
  error: { className: "badge file-error", label: "Erro", icon: AlertCircle },
};

const LOG_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function RemoteUpdatesPage() {
  const {
    remoteUpdates,
    dismissRemoteUpdate,
    trackedFiles,
    intervalMinutes,
    setIntervalMinutes,
    setUrlIntervalMinutes,
    setUrlCheckDisabled,
    checking,
  } = useRemoteFileUpdates();

  // Live "next check in Xm Ys" — same recipe as the Sidebar's, ticking
  // once a second purely to redraw against `trackedFiles`' timestamps.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const [intervalInput, setIntervalInput] = useState(String(intervalMinutes));
  const [intervalSaving, setIntervalSaving] = useState(false);
  const [intervalError, setIntervalError] = useState<string | null>(null);

  useEffect(() => {
    setIntervalInput(String(intervalMinutes));
  }, [intervalMinutes]);

  const intervalValid = Number.isFinite(Number(intervalInput)) && Number(intervalInput) >= 1;

  async function handleSaveInterval() {
    setIntervalError(null);
    const parsed = Number(intervalInput);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setIntervalError("Informe um número inteiro de minutos, no mínimo 1.");
      return;
    }
    setIntervalSaving(true);
    try {
      await setIntervalMinutes(Math.round(parsed));
    } catch (e) {
      setIntervalError(String(e));
    } finally {
      setIntervalSaving(false);
    }
  }

  // Per-file interval overrides are edited as drafts (not written on every
  // keystroke) — empty draft = "usar padrão global" (clears the override).
  const [intervalDrafts, setIntervalDrafts] = useState<Map<string, string>>(new Map());
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [togglingUrl, setTogglingUrl] = useState<string | null>(null);

  function draftFor(t: TrackedPaymentUrl): string {
    const draft = intervalDrafts.get(t.sourceUrl);
    if (draft !== undefined) return draft;
    return t.checkIntervalMinutes !== null ? String(t.checkIntervalMinutes) : "";
  }

  function draftValid(t: TrackedPaymentUrl): boolean {
    const raw = draftFor(t).trim();
    if (raw === "") return true; // clears the override
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1;
  }

  async function handleSaveFileInterval(t: TrackedPaymentUrl) {
    const raw = draftFor(t).trim();
    const minutes = raw === "" ? null : Math.round(Number(raw));
    setSavingUrl(t.sourceUrl);
    try {
      await setUrlIntervalMinutes(t.sourceUrl, minutes);
      setIntervalDrafts((prev) => {
        const next = new Map(prev);
        next.delete(t.sourceUrl);
        return next;
      });
    } finally {
      setSavingUrl(null);
    }
  }

  async function handleToggleDisabled(t: TrackedPaymentUrl) {
    setTogglingUrl(t.sourceUrl);
    try {
      await setUrlCheckDisabled(t.sourceUrl, !t.checkDisabled);
    } finally {
      setTogglingUrl(null);
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
        conteúdo remoto muda, você é avisado com a opção de reimportar. Aqui dá pra configurar o
        intervalo (global ou por arquivo), ver o histórico completo e ligar/desligar a verificação
        de cada um.
      </p>

      {remoteUpdates.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Atualizações disponíveis</h3>
          {remoteUpdates.map((u) => (
            <div
              className="warning-box"
              key={u.sourceUrl}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}
            >
              <span>
                <AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: "0.4rem" }} />
                <strong>{u.fileName}</strong> mudou no servidor de origem desde a última
                importação ({formatDateTime(u.lastImportedAt)}).
              </span>
              <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                <button type="button" className="outline" onClick={() => dismissRemoteUpdate(u.sourceUrl)}>
                  Ignorar
                </button>
                <Link to="/import/payments">
                  <button type="button">Ir para Importar Pagamentos</button>
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <RefreshCw size={18} className={checking ? "spin" : undefined} />
          Intervalo padrão
        </h3>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          Usado por qualquer arquivo sem intervalo próprio definido na lista abaixo.
          {checking && " Verificando agora..."}
        </p>

        {intervalError && <div className="error-box">{intervalError}</div>}

        <div className="field-row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "0 1 160px", marginBottom: 0 }}>
            <label htmlFor="global-check-interval">Intervalo (minutos)</label>
            <input
              id="global-check-interval"
              type="number"
              min={1}
              step={1}
              value={intervalInput}
              onChange={(e) => setIntervalInput(e.target.value)}
            />
          </div>
          <button type="button" onClick={handleSaveInterval} disabled={intervalSaving || !intervalValid}>
            {intervalSaving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Arquivos rastreados</h3>
        {trackedFiles.length === 0 && (
          <p className="muted">Nenhum arquivo importado por URL ainda.</p>
        )}
        {trackedFiles.length > 0 && (
          <div className="file-list">
            {trackedFiles.map((t) => {
              const badge = t.lastResult ? RESULT_BADGE[t.lastResult] : null;
              const BadgeIcon = badge?.icon;
              const effectiveMinutes = t.checkIntervalMinutes ?? intervalMinutes;
              const dueAt = t.lastCheckedAt
                ? new Date(t.lastCheckedAt).getTime() + effectiveMinutes * 60_000
                : now;
              return (
                <div className="file-row" key={t.sourceUrl}>
                  <div className="file-row-icon">
                    <FileText size={18} />
                  </div>
                  <div className="file-row-info">
                    <div className="file-name" title={t.sourceUrl}>
                      {t.fileName}
                      <Link2 size={12} style={{ marginLeft: "0.4rem", opacity: 0.5, verticalAlign: "-1px" }} />
                    </div>
                    <div className="file-meta">
                      {t.provider || "—"} ·{" "}
                      {t.lastCheckedAt ? `Última verificação: ${formatDateTime(t.lastCheckedAt)}` : "Nunca verificado"}
                      {!t.checkDisabled && (
                        <> · Próxima em {formatCountdown(dueAt - now)}</>
                      )}
                    </div>
                    {t.lastResult === "error" && t.lastErrorMessage && (
                      <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                        {t.lastErrorMessage}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {badge && BadgeIcon && !t.checkDisabled && (
                      <span className={badge.className}>
                        <BadgeIcon size={13} />
                        {badge.label}
                      </span>
                    )}
                    {t.checkDisabled && <span className="badge neutral">Desativado</span>}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder={String(intervalMinutes)}
                      value={draftFor(t)}
                      onChange={(e) =>
                        setIntervalDrafts((prev) => new Map(prev).set(t.sourceUrl, e.target.value))
                      }
                      title="Intervalo próprio, em minutos — deixe em branco para usar o padrão global"
                      style={{ width: "4.5rem" }}
                      disabled={t.checkDisabled}
                    />
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleSaveFileInterval(t)}
                      disabled={t.checkDisabled || savingUrl === t.sourceUrl || !draftValid(t)}
                    >
                      {savingUrl === t.sourceUrl ? "Salvando..." : "Salvar"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleToggleDisabled(t)}
                      disabled={togglingUrl === t.sourceUrl}
                    >
                      {togglingUrl === t.sourceUrl ? "..." : t.checkDisabled ? "Reativar" : "Desativar"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card table-card">
        <div className="page-header" style={{ marginBottom: "1rem" }}>
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
                    <th>Quando</th>
                    <th>Arquivo</th>
                    <th>Resultado</th>
                    <th>Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  {logEntries.map((entry) => {
                    const badge = RESULT_BADGE[entry.result];
                    const BadgeIcon = badge.icon;
                    return (
                      <tr key={entry.id}>
                        <td>{formatDateTime(entry.checkedAt)}</td>
                        <td>{entry.fileName}</td>
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
