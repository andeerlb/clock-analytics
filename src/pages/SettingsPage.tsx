import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Database,
  FileCheck2,
  FolderOpen,
  Link2,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import GithubIcon from "../components/GithubIcon";
import UpdateModal from "../components/UpdateModal";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import {
  backupAppData,
  checkPopplerStatus,
  clearImportsDir,
  deletePaths,
  getStorageUsage,
  openAppDataDir,
  setPopplerDir,
} from "../lib/api";
import {
  clearAllData,
  findRedundantOriginals,
  listDisabledUrlChecks,
  markOriginalsRemoved,
  setUrlCheckDisabled,
  vacuumDatabase,
  type DisabledUrlCheck,
} from "../lib/db";
import { formatBytes, formatDateTime } from "../lib/format";
import type { PopplerStatus, StorageUsage } from "../lib/types";
import { checkForUpdate, REPO_URL } from "../lib/updateCheck";

const CLEAR_CONFIRM_PHRASE = "APAGAR TUDO";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [vacuuming, setVacuuming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeMessage, setPurgeMessage] = useState<string | null>(null);
  const [backupDb, setBackupDb] = useState(true);
  const [backupFiles, setBackupFiles] = useState(true);
  const [keepCompanies, setKeepCompanies] = useState(false);
  const [keepClients, setKeepClients] = useState(false);
  const [keepEmployees, setKeepEmployees] = useState(false);
  // Templates are master/config data, independent of companies/clients/
  // employees — default to kept, matching this app's behavior before these
  // became explicit choices (a template has no FK into any of those three).
  const [keepPaymentTemplates, setKeepPaymentTemplates] = useState(true);
  const [keepEmployeeTemplates, setKeepEmployeeTemplates] = useState(true);
  const [confirmText, setConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [popplerStatus, setPopplerStatusState] = useState<PopplerStatus | null>(null);
  const [popplerDirInput, setPopplerDirInput] = useState("");
  const [popplerSaving, setPopplerSaving] = useState(false);
  const [popplerError, setPopplerError] = useState<string | null>(null);

  const {
    intervalMinutes: remoteCheckInterval,
    setIntervalMinutes: saveRemoteCheckInterval,
    checking: remoteChecking,
    lastCheckedAt: remoteLastCheckedAt,
    lastErrors: remoteCheckFailures,
  } = useRemoteFileUpdates();
  const [remoteCheckInput, setRemoteCheckInput] = useState(String(remoteCheckInterval));
  const [remoteCheckSaving, setRemoteCheckSaving] = useState(false);
  const [remoteCheckError, setRemoteCheckError] = useState<string | null>(null);
  const [disabledUrlChecks, setDisabledUrlChecks] = useState<DisabledUrlCheck[]>([]);
  const [reenablingUrl, setReenablingUrl] = useState<string | null>(null);

  // Keeps the input in sync with the persisted value once it loads (the
  // context starts at a provisional default before that round-trip
  // resolves) — same "sync input from source of truth" need as
  // `popplerDirInput` below, just via a prop-like context value instead of
  // a local fetch.
  useEffect(() => {
    setRemoteCheckInput(String(remoteCheckInterval));
  }, [remoteCheckInterval]);

  useEffect(() => {
    refreshDisabledUrlChecks();
  }, []);

  function refreshDisabledUrlChecks() {
    listDisabledUrlChecks()
      .then(setDisabledUrlChecks)
      .catch(() => {});
  }

  async function handleReenableUrlCheck(sourceUrl: string) {
    setReenablingUrl(sourceUrl);
    try {
      await setUrlCheckDisabled(sourceUrl, false);
      setDisabledUrlChecks((prev) => prev.filter((u) => u.sourceUrl !== sourceUrl));
    } catch (e) {
      setRemoteCheckError(String(e));
    } finally {
      setReenablingUrl(null);
    }
  }

  const remoteCheckIntervalValid = Number.isFinite(Number(remoteCheckInput)) && Number(remoteCheckInput) >= 1;

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);

  // Employees need their company and client to survive (both are required
  // references); clients need their company. Checking a more specific level
  // pulls in everything it depends on; unchecking a broader one lets go of
  // everything that depended on it.
  function toggleKeepCompanies(checked: boolean) {
    setKeepCompanies(checked);
    if (!checked) {
      setKeepClients(false);
      setKeepEmployees(false);
    }
  }
  function toggleKeepClients(checked: boolean) {
    setKeepClients(checked);
    if (checked) setKeepCompanies(true);
    else setKeepEmployees(false);
  }
  function toggleKeepEmployees(checked: boolean) {
    setKeepEmployees(checked);
    if (checked) {
      setKeepClients(true);
      setKeepCompanies(true);
    }
  }

  function refreshStorage() {
    setLoadingStorage(true);
    return getStorageUsage()
      .then(setStorage)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingStorage(false));
  }

  useEffect(() => {
    refreshStorage();
    refreshPopplerStatus();
    getVersion().then(setAppVersion);
    // Passive check on load — best-effort like the Sidebar's, any failure
    // here just means the update badge doesn't show up; the user still has
    // "Procurar atualização" below to check explicitly and see why.
    checkForUpdate()
      .then((update) => {
        if (update) setAvailableUpdate(update);
      })
      .catch(() => {});
  }, []);

  async function handleCheckForUpdate() {
    setCheckingUpdate(true);
    setUpToDate(false);
    setUpdateCheckError(null);
    try {
      const update = await checkForUpdate();
      if (update) {
        setAvailableUpdate(update);
        setShowUpdateModal(true);
      } else {
        setUpToDate(true);
      }
    } catch (e) {
      setUpdateCheckError(String(e instanceof Error ? e.message : e));
    } finally {
      setCheckingUpdate(false);
    }
  }

  function refreshPopplerStatus() {
    return checkPopplerStatus()
      .then((status) => {
        setPopplerStatusState(status);
        setPopplerDirInput(status.popplerDir ?? "");
      })
      .catch((e) => setPopplerError(String(e)));
  }

  async function handleChoosePopplerDir() {
    const selection = await open({ directory: true });
    if (typeof selection === "string") setPopplerDirInput(selection);
  }

  async function handleSavePopplerDir() {
    setPopplerError(null);
    setPopplerSaving(true);
    try {
      const status = await setPopplerDir(popplerDirInput.trim() || null);
      setPopplerStatusState(status);
      setPopplerDirInput(status.popplerDir ?? "");
    } catch (e) {
      setPopplerError(String(e));
    } finally {
      setPopplerSaving(false);
    }
  }

  async function handleSaveRemoteCheckInterval() {
    setRemoteCheckError(null);
    const parsed = Number(remoteCheckInput);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setRemoteCheckError("Informe um número inteiro de minutos, no mínimo 1.");
      return;
    }
    setRemoteCheckSaving(true);
    try {
      await saveRemoteCheckInterval(Math.round(parsed));
    } catch (e) {
      setRemoteCheckError(String(e));
    } finally {
      setRemoteCheckSaving(false);
    }
  }

  async function handleVacuum() {
    setError(null);
    setVacuuming(true);
    try {
      await vacuumDatabase();
      await refreshStorage();
    } catch (e) {
      setError(String(e));
    } finally {
      setVacuuming(false);
    }
  }

  async function handlePurgeRedundant() {
    setError(null);
    setPurgeMessage(null);
    setPurging(true);
    try {
      const candidates = await findRedundantOriginals();
      if (candidates.length === 0) {
        setPurgeMessage("Nenhum arquivo original redundante encontrado.");
        return;
      }
      const freedBytes = await deletePaths(candidates.map((c) => c.path));
      await markOriginalsRemoved(candidates.map((c) => c.sourceFileId));
      setPurgeMessage(
        `${candidates.length} arquivo(s) original(is) removido(s), liberando ${formatBytes(freedBytes)}.`,
      );
      await refreshStorage();
    } catch (e) {
      setError(String(e));
    } finally {
      setPurging(false);
    }
  }

  async function handleOpenDataDir() {
    try {
      await openAppDataDir();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleClearAll() {
    if (confirmText.trim() !== CLEAR_CONFIRM_PHRASE) return;
    setError(null);
    setClearing(true);
    try {
      if (backupDb || backupFiles) {
        const destPath = await save({
          defaultPath: "pontoscan-backup.zip",
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        if (!destPath) {
          setClearing(false);
          return;
        }
        await backupAppData(destPath, backupDb, backupFiles);
      }
      await clearAllData({ keepCompanies, keepClients, keepEmployees, keepPaymentTemplates, keepEmployeeTemplates });
      await clearImportsDir();
      navigate("/");
    } catch (e) {
      setError(String(e));
      setClearing(false);
    }
  }

  const totalBytes = storage
    ? storage.dbBytes + storage.importsBytes + storage.paymentTemplatesBytes
    : 0;

  return (
    <div>
      <div className="page-header">
        <h2>Configurações</h2>
      </div>
      <p className="page-subtitle">
        O PontoScan guarda tudo localmente neste computador — banco de dados e cópias dos
        PDFs importados. Com o tempo isso ocupa espaço em disco; aqui dá pra acompanhar e liberar.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <FileCheck2 size={18} />
          Ferramentas de PDF (Poppler)
        </h3>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          A importação e exportação de PDFs depende de quatro ferramentas de linha de comando do
          Poppler (pdfinfo, pdftotext, pdfseparate, pdfunite). Se alguma não for encontrada, informe
          abaixo a pasta onde elas estão instaladas (ex.: a pasta <code>bin</code> do Homebrew).
        </p>

        {popplerError && <div className="error-box">{popplerError}</div>}

        {popplerStatus && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "1rem" }}>
            {popplerStatus.binaries.map((b) => (
              <div key={b.name} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
                {b.found ? (
                  <CheckCircle2 size={16} color="var(--accent)" />
                ) : (
                  <XCircle size={16} color="var(--danger)" />
                )}
                <code>{b.name}</code>
                {b.found && b.path && (
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    — {b.path}
                  </span>
                )}
                {!b.found && (
                  <span style={{ color: "var(--danger)", fontSize: "0.8rem" }}>não encontrado</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="field-row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 260px", marginBottom: 0 }}>
            <label htmlFor="poppler-dir">Pasta dos binários do Poppler (opcional)</label>
            <input
              id="poppler-dir"
              type="text"
              value={popplerDirInput}
              onChange={(e) => setPopplerDirInput(e.target.value)}
              placeholder="ex.: /opt/homebrew/bin"
            />
          </div>
          <button type="button" className="secondary" onClick={handleChoosePopplerDir}>
            <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
            Escolher pasta
          </button>
          <button type="button" onClick={handleSavePopplerDir} disabled={popplerSaving}>
            {popplerSaving ? "Salvando..." : "Salvar e testar"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Link2 size={18} />
          Importação por URL
        </h3>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          De quanto em quanto tempo verificar se um arquivo de pagamento importado por URL mudou no
          servidor de origem, oferecendo reimportar quando isso acontece.
        </p>

        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
          {remoteChecking ? (
            <>
              <RefreshCw size={14} className="spin" />
              Verificando agora...
            </>
          ) : remoteLastCheckedAt ? (
            <>Última verificação: {formatDateTime(remoteLastCheckedAt)}</>
          ) : (
            "Ainda não verificado nesta sessão."
          )}
        </p>

        {remoteCheckFailures.length > 0 && (
          <div className="error-box">
            Falha ao verificar {remoteCheckFailures.length === 1 ? "1 arquivo" : `${remoteCheckFailures.length} arquivos`}:
            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
              {remoteCheckFailures.map((f) => (
                <li key={f.sourceUrl || f.message}>
                  {f.fileName ? <strong>{f.fileName}</strong> : null}
                  {f.fileName ? " — " : ""}
                  {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {remoteCheckError && <div className="error-box">{remoteCheckError}</div>}

        <div className="field-row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "0 1 160px", marginBottom: 0 }}>
            <label htmlFor="remote-check-interval">Intervalo (minutos)</label>
            <input
              id="remote-check-interval"
              type="number"
              min={1}
              step={1}
              value={remoteCheckInput}
              onChange={(e) => setRemoteCheckInput(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={handleSaveRemoteCheckInterval}
            disabled={remoteCheckSaving || !remoteCheckIntervalValid}
          >
            {remoteCheckSaving ? "Salvando..." : "Salvar"}
          </button>
        </div>

        {disabledUrlChecks.length > 0 && (
          <div style={{ marginTop: "1.2rem" }}>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
              Verificação automática desativada para:
            </p>
            <div className="file-list">
              {disabledUrlChecks.map((u) => (
                <div className="file-row" key={u.sourceUrl}>
                  <div className="file-row-info">
                    <div className="file-name">{u.fileName}</div>
                    <div className="muted" style={{ fontSize: "0.75rem" }}>
                      {u.sourceUrl}
                    </div>
                  </div>
                  <div className="file-row-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleReenableUrlCheck(u.sourceUrl)}
                      disabled={reenablingUrl === u.sourceUrl}
                    >
                      {reenablingUrl === u.sourceUrl ? "Reativando..." : "Reativar"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Database size={18} />
          Armazenamento
        </h3>
        {loadingStorage && <p className="muted">Calculando...</p>}
        {!loadingStorage && storage && (
          <div className="summary-row" style={{ marginBottom: 0 }}>
            <div className="summary-tile">
              <div className="label">Banco de dados</div>
              <div className="value">{formatBytes(storage.dbBytes)}</div>
            </div>
            <div className="summary-tile">
              <div className="label">PDFs importados ({storage.importsFileCount} arquivos)</div>
              <div className="value">{formatBytes(storage.importsBytes)}</div>
            </div>
            <div className="summary-tile">
              <div className="label">
                Modelos de importação de pagamentos ({storage.paymentTemplatesFileCount} arquivos)
              </div>
              <div className="value">{formatBytes(storage.paymentTemplatesBytes)}</div>
            </div>
            <div className="summary-tile">
              <div className="label">Total</div>
              <div className="value" style={{ color: "var(--accent)" }}>
                {formatBytes(totalBytes)}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Sparkles size={18} />
          Manutenção
        </h3>
        <div className="field-row" style={{ alignItems: "flex-start", marginBottom: 0 }}>
          <div style={{ flex: "1 1 260px" }}>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
              Recompacta o arquivo do banco, recuperando espaço deixado por registros já
              apagados. Não remove nenhum dado.
            </p>
            <button type="button" className="secondary" onClick={handleVacuum} disabled={vacuuming}>
              {vacuuming ? "Compactando..." : "Compactar banco de dados"}
            </button>
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
              Quando um arquivo em lote (várias pessoas num PDF só) já teve todas as páginas
              importadas com sucesso, o arquivo original inteiro fica redundante — cada
              colaborador já tem sua própria página salva. Remove só essa cópia extra.
            </p>
            <button type="button" className="secondary" onClick={handlePurgeRedundant} disabled={purging}>
              {purging ? "Verificando..." : "Remover originais redundantes"}
            </button>
            {purgeMessage && (
              <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
                {purgeMessage}
              </p>
            )}
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
              Abre a pasta onde o banco de dados e os PDFs ficam salvos, pra você conferir com os
              próprios olhos.
            </p>
            <button type="button" className="secondary" onClick={handleOpenDataDir}>
              <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
              Abrir pasta de dados
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ borderColor: "var(--danger)" }}>
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--danger)" }}>
          <AlertTriangle size={18} />
          Zona de risco
        </h3>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Sempre apaga todo o histórico de importações e todos os PDFs salvos — isso não tem como
          escolher, já que é justamente o que dá pra recriar reimportando os mesmos arquivos. Como
          esse é o único lugar onde esses dados existem, considere salvar uma cópia antes.
        </p>

        <div style={{ marginBottom: "1.2rem" }}>
          <p className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Opcionalmente, mantenha o cadastro (evita ter que digitar tudo de novo). Manter
            colaboradores exige manter clientes e empresas; manter clientes exige manter empresas.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={keepCompanies}
                disabled={keepClients}
                onChange={(e) => toggleKeepCompanies(e.target.checked)}
              />
              Manter empresas
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={keepClients}
                disabled={keepEmployees}
                onChange={(e) => toggleKeepClients(e.target.checked)}
              />
              Manter clientes
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={keepEmployees}
                onChange={(e) => toggleKeepEmployees(e.target.checked)}
              />
              Manter colaboradores
            </label>
          </div>
        </div>

        <div style={{ marginBottom: "1.2rem" }}>
          <p className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Templates de importação são configuração (mapeamento de colunas), não histórico —
            independentes do cadastro acima, também podem ser mantidos.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={keepPaymentTemplates}
                onChange={(e) => setKeepPaymentTemplates(e.target.checked)}
              />
              Manter templates de pagamento
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={keepEmployeeTemplates}
                onChange={(e) => setKeepEmployeeTemplates(e.target.checked)}
              />
              Manter templates de colaboradores
            </label>
          </div>
        </div>

        <div style={{ marginBottom: "1.2rem" }}>
          <p className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Backup antes de apagar — escolha o quê incluir no zip.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input type="checkbox" checked={backupDb} onChange={(e) => setBackupDb(e.target.checked)} />
              Banco
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input type="checkbox" checked={backupFiles} onChange={(e) => setBackupFiles(e.target.checked)} />
              PDFs
            </label>
          </div>
        </div>

        <div className="field" style={{ maxWidth: "22rem", marginTop: "0.4rem", marginBottom: "1rem", gap: "0.6rem" }}>
          <label htmlFor="clear-confirm">
            Digite <strong>{CLEAR_CONFIRM_PHRASE}</strong> para confirmar
          </label>
          <input
            id="clear-confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CLEAR_CONFIRM_PHRASE}
          />
        </div>

        <button
          type="button"
          onClick={handleClearAll}
          disabled={clearing || confirmText.trim() !== CLEAR_CONFIRM_PHRASE}
          style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#410002" }}
        >
          {backupDb || backupFiles ? (
            <Archive size={15} style={{ marginRight: "0.4rem" }} />
          ) : (
            <Trash2 size={15} style={{ marginRight: "0.4rem" }} />
          )}
          {clearing ? "Apagando..." : "Apagar tudo"}
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <GithubIcon size={18} />
          Sobre
        </h3>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.8rem" }}>
          <div>
            <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
              PontoScan {appVersion ? `v${appVersion}` : ""}
              {availableUpdate && (
                <>
                  {" "}— nova versão disponível:{" "}
                  <strong style={{ color: "var(--success)" }}>{availableUpdate.version}</strong>
                </>
              )}
              {upToDate && " — você já está na versão mais recente"}
            </p>
            {updateCheckError && (
              <p className="muted" style={{ margin: "0.3rem 0 0", fontSize: "0.8rem", color: "var(--danger)" }}>
                Não foi possível verificar atualizações: {updateCheckError}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            {availableUpdate ? (
              <button type="button" onClick={() => setShowUpdateModal(true)}>
                Ver nova versão
              </button>
            ) : (
              <button type="button" className="secondary" onClick={handleCheckForUpdate} disabled={checkingUpdate}>
                <RefreshCw size={15} style={{ marginRight: "0.4rem" }} />
                {checkingUpdate ? "Verificando..." : "Procurar atualização"}
              </button>
            )}
            <button type="button" className="secondary" onClick={() => openUrl(REPO_URL)}>
              <GithubIcon size={15} style={{ marginRight: "0.4rem" }} />
              Ver no GitHub
            </button>
          </div>
        </div>
      </div>

      {showUpdateModal && availableUpdate && (
        <UpdateModal
          update={availableUpdate}
          onClose={() => {
            setShowUpdateModal(false);
            setAvailableUpdate(null);
          }}
        />
      )}
    </div>
  );
}
