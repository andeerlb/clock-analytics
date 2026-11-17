import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { Archive, CheckCircle2, ChevronRight, Download, FolderOpen, RefreshCw, Search, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import AiSettingsCard, { type AiConnection } from "../components/AiSettingsCard";
import ConfirmModal from "../components/ConfirmModal";
import GithubIcon from "../components/GithubIcon";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import UpdateModal from "../components/UpdateModal";
import {
  aiStatus,
  backupAppData,
  cancelDatabaseImport,
  checkPopplerStatus,
  clearImportsDir,
  deletePaths,
  exportDatabase,
  getCloseToTray,
  getImportsFileList,
  getStorageUsage,
  importDatabase,
  openAppDataDir,
  setCloseToTray,
  setPopplerDir,
  type DatabaseImportEvent,
} from "../lib/api";
import {
  checkpointDatabase,
  clearAllData,
  findRedundantOriginals,
  getDatabaseTableSizes,
  getImportedFileNamesByBasename,
  markOriginalsRemoved,
  vacuumDatabase,
  type DatabaseTableSize,
  type RedundantOriginal,
} from "../lib/db";
import { formatBytes } from "../lib/format";
import type { PopplerStatus, StorageFileEntry, StorageUsage } from "../lib/types";
import { checkForUpdate, REPO_URL } from "../lib/updateCheck";

const CLEAR_CONFIRM_PHRASE = "APAGAR TUDO";
const IMPORT_CONFIRM_PHRASE = "SUBSTITUIR BANCO";

/** Rows whose details open below them. */
type ExpandableRow = "atualizacoes" | "espaco" | "pdf" | "ia";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  // Which storage tile's breakdown is open in the detail Modal, if any —
  // "Total" has no breakdown of its own, so it isn't a valid value here.
  const [storageDetail, setStorageDetail] = useState<"db" | "imports" | null>(null);
  const [dbTableSizes, setDbTableSizes] = useState<DatabaseTableSize[] | null>(null);
  const [importFileEntries, setImportFileEntries] = useState<StorageFileEntry[] | null>(null);
  const [loadingStorageDetail, setLoadingStorageDetail] = useState(false);
  const [storageDetailError, setStorageDetailError] = useState<string | null>(null);
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
  // Whether "Apagar tudo" spares payment_shifts rows edited by hand (Fazer
  // pagamento/Voltar para pendente/Editar valor) instead of wiping every
  // one — an "Apagar tudo" option like the others above, not a persisted
  // preference (never saved anywhere, just re-chosen each visit like
  // `keepCompanies`/`keepPaymentTemplates`). Only meaningful alongside
  // `keepEmployees` (a kept shift's employee_id is NOT NULL), so it's
  // disabled below unless that's already checked.
  const [keepManuallyEditedShifts, setKeepManuallyEditedShifts] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [importConfirmText, setImportConfirmText] = useState("");
  const [importing, setImporting] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  const [importEvents, setImportEvents] = useState<DatabaseImportEvent[]>([]);

  const [popplerStatus, setPopplerStatusState] = useState<PopplerStatus | null>(null);
  const [popplerDirInput, setPopplerDirInput] = useState("");
  const [popplerSaving, setPopplerSaving] = useState(false);
  const [popplerError, setPopplerError] = useState<string | null>(null);

  const [closeToTray, setCloseToTrayState] = useState(false);
  const [closeToTraySaving, setCloseToTraySaving] = useState(false);
  const [closeToTrayError, setCloseToTrayError] = useState<string | null>(null);

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

  // `keepManuallyEditedShifts` only makes sense with employees kept too (a
  // kept shift's employee_id is NOT NULL) — covers every path that turns
  // `keepEmployees` off (the three toggle functions above each do it
  // differently) instead of repeating the same reset in all three.
  useEffect(() => {
    if (!keepEmployees) setKeepManuallyEditedShifts(false);
  }, [keepEmployees]);

  function refreshStorage() {
    setLoadingStorage(true);
    return getStorageUsage()
      .then(setStorage)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingStorage(false));
  }

  function closeStorageDetail() {
    setStorageDetail(null);
    setDbTableSizes(null);
    setImportFileEntries(null);
    setStorageDetailError(null);
  }

  // Fetches the clicked tile's breakdown on open — "Banco de dados" lists
  // per-table disk usage (see `getDatabaseTableSizes`), "Arquivos importados"
  // lists each file actually inside imports/ (PDFs plus any payment
  // spreadsheet downloaded by link), largest first, with its human name
  // resolved where possible (see `getImportedFileNamesByBasename` for why
  // that resolution isn't always available).
  useEffect(() => {
    if (!storageDetail) return;
    setLoadingStorageDetail(true);
    setStorageDetailError(null);
    const request =
      storageDetail === "db"
        ? getDatabaseTableSizes().then(setDbTableSizes)
        : Promise.all([getImportsFileList(), getImportedFileNamesByBasename()]).then(([files, namesByBasename]) => {
            setImportFileEntries(
              [...files]
                .map((f) => ({ name: namesByBasename.get(f.name) ?? f.name, bytes: f.bytes }))
                .sort((a, b) => b.bytes - a.bytes),
            );
          });
    request.catch((e) => setStorageDetailError(String(e))).finally(() => setLoadingStorageDetail(false));
  }, [storageDetail]);

  useEffect(() => {
    refreshStorage();
    refreshPopplerStatus();
    getCloseToTray()
      .then(setCloseToTrayState)
      .catch((e) => setCloseToTrayError(String(e)));
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

  async function handleCloseToTrayChange(enabled: boolean) {
    setCloseToTrayError(null);
    setCloseToTraySaving(true);
    try {
      await setCloseToTray(enabled);
      setCloseToTrayState(enabled);
    } catch (e) {
      setCloseToTrayError(String(e));
    } finally {
      setCloseToTraySaving(false);
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

  async function handleOpenDataDir() {
    try {
      await openAppDataDir();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleExportDatabase() {
    setError(null);
    setExporting(true);
    try {
      const destPath = await save({
        defaultPath: "pontoscan.db",
        filters: [{ name: "Banco de dados SQLite", extensions: ["db"] }],
      });
      if (!destPath) return;
      // Flush the WAL into the main file first — otherwise the copy could
      // be missing whatever hasn't been checkpointed yet.
      await checkpointDatabase();
      await exportDatabase(destPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  async function handleImportDatabase() {
    if (importConfirmText.trim() !== IMPORT_CONFIRM_PHRASE) return;
    setError(null);
    setImporting(true);
    try {
      const srcPath = await open({
        multiple: false,
        filters: [{ name: "Banco de dados SQLite", extensions: ["db"] }],
      });
      if (!srcPath || Array.isArray(srcPath)) {
        setImporting(false);
        return;
      }
      // The Rust side only validates and stages the chosen file. The actual
      // swap happens during the next startup, before SQLite is opened, so
      // background queries cannot block this flow or leave a closed pool in
      // the still-running UI.
      const events = await importDatabase(srcPath);
      setImportEvents(events);
      localStorage.setItem("database-import-events", JSON.stringify(events));
      setRestartCountdown(30);
    } catch (e) {
      setError(String(e));
      setImporting(false);
    }
  }

  useEffect(() => {
    if (restartCountdown === null) return;
    if (restartCountdown <= 0) {
      const restart = import.meta.env.DEV ? exit(0) : relaunch();
      restart.catch((e) => {
        setError(String(e));
        setRestartCountdown(null);
        setImporting(false);
      });
      return;
    }
    const timeout = setTimeout(() => setRestartCountdown((value) => value === null ? null : value - 1), 1000);
    return () => clearTimeout(timeout);
  }, [restartCountdown]);

  async function cancelPendingImport() {
    try {
      await cancelDatabaseImport();
      localStorage.removeItem("database-import-events");
      setImportEvents([]);
      setRestartCountdown(null);
      setImporting(false);
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
      await clearAllData({
        keepCompanies,
        keepClients,
        keepEmployees,
        keepPaymentTemplates,
        keepEmployeeTemplates,
        keepManuallyEditedShifts,
      });
      await clearImportsDir();
      navigate("/");
    } catch (e) {
      setError(String(e));
      setClearing(false);
    }
  }

  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<ExpandableRow | null>(null);
  const [aiConnection, setAiConnection] = useState<AiConnection | null>(null);
  const [purgeCandidates, setPurgeCandidates] = useState<RedundantOriginal[] | null>(null);
  /** Step of the "Apagar histórico" wizard; null when closed. */
  const [wizardStep, setWizardStep] = useState<number | null>(null);
  const [importDbOpen, setImportDbOpen] = useState(false);

  // The assistant row shows how it's connected before it's opened.
  useEffect(() => {
    aiStatus()
      .then((status) => setAiConnection(status.claudeCode ? "claude-code" : status.apiKey ? "api-key" : "none"))
      .catch(() => setAiConnection(null));
  }, []);

  // Ctrl/Cmd+K jumps to the search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const totalBytes = storage ? storage.dbBytes + storage.importsBytes : 0;
  const popplerMissing = popplerStatus ? popplerStatus.binaries.filter((b) => !b.path).length : 0;

  async function handleFindRedundant() {
    setError(null);
    setPurgeMessage(null);
    setPurging(true);
    try {
      const candidates = await findRedundantOriginals();
      if (candidates.length === 0) setPurgeMessage("Nenhum original repetido para remover.");
      else setPurgeCandidates(candidates);
    } catch (e) {
      setError(String(e));
    } finally {
      setPurging(false);
    }
  }

  async function handleConfirmPurge() {
    if (!purgeCandidates) return;
    setPurging(true);
    try {
      const freedBytes = await deletePaths(purgeCandidates.map((c) => c.path));
      await markOriginalsRemoved(purgeCandidates.map((c) => c.sourceFileId));
      setPurgeMessage(`${purgeCandidates.length} ${purgeCandidates.length === 1 ? "original removido" : "originais removidos"}, ${formatBytes(freedBytes)} liberados.`);
      setPurgeCandidates(null);
      await refreshStorage();
    } catch (e) {
      setError(String(e));
      setPurgeCandidates(null);
    } finally {
      setPurging(false);
    }
  }

  function openClearWizard() {
    setConfirmText("");
    setWizardStep(0);
  }

  const keptSummary = [
    keepCompanies && "empresas",
    keepClients && "clientes",
    keepEmployees && "colaboradores",
    keepManuallyEditedShifts && "turnos de pagamento editados à mão",
    keepPaymentTemplates && "modelos de pagamento",
    keepEmployeeTemplates && "modelos de colaboradores",
  ].filter((v): v is string => Boolean(v));
  const removedSummary = [
    "histórico de importações",
    "arquivos importados",
    !keepEmployees && "colaboradores",
    !keepClients && "clientes",
    !keepCompanies && "empresas",
    !keepPaymentTemplates && "modelos de pagamento",
    !keepEmployeeTemplates && "modelos de colaboradores",
  ].filter((v): v is string => Boolean(v));

  // The list filters as you type: each row matches on its own words plus
  // its title, so "backup", "espaço" or "bandeja" finds the right one.
  const query = normalizeSearch(search.trim());
  const matches = (keywords: string) => !query || normalizeSearch(keywords).includes(query);

  const rows = {
    bandeja: matches("geral continuar rodando fechar janela bandeja segundo plano minimizar"),
    atualizacoes: matches("geral atualizações atualizacao versão nova github sobre"),
    espaco: matches("dados espaço usado armazenamento disco tamanho banco arquivos"),
    originais: matches("dados liberar espaço remover originais repetidos redundantes pdf lote"),
    compactar: matches("dados compactar banco vacuum espaço"),
    copia: matches("dados salvar cópia copia backup exportar banco"),
    pasta: matches("dados abrir pasta de dados explorador"),
    pdf: matches("integrações ferramentas de pdf poppler pdfinfo pdftotext pdfseparate pdfunite"),
    ia: matches("integrações assistente ia inteligência artificial claude anthropic chave api"),
    apagar: matches("zona de risco apagar tudo histórico arquivos limpar zerar backup"),
    substituir: matches("zona de risco substituir banco importar restaurar arquivo db"),
  };
  const groups = {
    geral: rows.bandeja || rows.atualizacoes,
    dados: rows.espaco || rows.originais || rows.compactar || rows.copia || rows.pasta,
    integracoes: rows.pdf || rows.ia,
    risco: rows.apagar || rows.substituir,
  };
  const nothingFound = !Object.values(groups).some(Boolean);

  function toggleRow(id: ExpandableRow) {
    setExpanded((current) => (current === id ? null : id));
  }

  return (
    <div className="settings-page">
      <PageHeader title="Configurações" subtitle="Procure pelo que você quer fazer." />

      <label className="settings-search">
        <Search size={16} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Ex.: espaço, backup, atualização, bandeja"
          aria-label="Buscar nas configurações"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>Ctrl K</kbd>
      </label>

      {error && <div className="error-box">{error}</div>}

      {nothingFound && <p className="settings-empty">Nada encontrado com “{search.trim()}”.</p>}

      {groups.geral && (
        <section className="settings-group" aria-labelledby="settings-group-geral">
          <h3 id="settings-group-geral" className="settings-group-title">
            Geral
          </h3>
          <div className="settings-card">
            {rows.bandeja && (
              <label className="settings-row settings-row-clickable">
                <span className="settings-row-text">
                  <span className="settings-row-title">Continuar rodando ao fechar a janela</span>
                  <span className="settings-row-desc">Fica na bandeja e mantém as verificações automáticas. Para encerrar, use “Sair” no menu da bandeja.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="settings-switch"
                  checked={closeToTray}
                  disabled={closeToTraySaving}
                  onChange={(e) => handleCloseToTrayChange(e.target.checked)}
                />
              </label>
            )}
            {rows.bandeja && closeToTrayError && <div className="error-box settings-error">{closeToTrayError}</div>}

            {rows.atualizacoes && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "atualizacoes"}
                  onToggle={() => toggleRow("atualizacoes")}
                  title="Atualizações"
                  desc={appVersion ? `PontoScan ${appVersion}` : undefined}
                  value={
                    availableUpdate ? (
                      <span className="settings-pill settings-pill-info">{availableUpdate.version} disponível</span>
                    ) : upToDate ? (
                      <span className="settings-pill settings-pill-ok">Em dia</span>
                    ) : undefined
                  }
                />
                {expanded === "atualizacoes" && (
                  <div className="settings-detail">
                    <p className="settings-detail-text">
                      {availableUpdate ? (
                        <>
                          Nova versão disponível: <strong style={{ color: "var(--success)" }}>{availableUpdate.version}</strong>. Você está na {appVersion}.
                        </>
                      ) : upToDate ? (
                        "Você já está na versão mais recente."
                      ) : (
                        "Procure para ver se há uma versão nova."
                      )}
                    </p>
                    {updateCheckError && <p className="settings-detail-text settings-text-danger">Não foi possível verificar: {updateCheckError}</p>}
                    <div className="settings-actions">
                      {availableUpdate ? (
                        <button type="button" className="settings-button settings-button-primary" onClick={() => setShowUpdateModal(true)}>
                          Atualizar para {availableUpdate.version}
                        </button>
                      ) : (
                        <button type="button" className="settings-button" onClick={handleCheckForUpdate} disabled={checkingUpdate}>
                          <RefreshCw size={14} />
                          {checkingUpdate ? "Procurando..." : "Procurar atualização"}
                        </button>
                      )}
                      <button type="button" className="settings-button settings-button-ghost" onClick={() => openUrl(REPO_URL)}>
                        <GithubIcon size={14} />
                        Ver no GitHub
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {groups.dados && (
        <section className="settings-group" aria-labelledby="settings-group-dados">
          <h3 id="settings-group-dados" className="settings-group-title">
            Dados
          </h3>
          <div className="settings-card">
            {rows.espaco && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "espaco"}
                  onToggle={() => toggleRow("espaco")}
                  title="Espaço usado"
                  desc={storage ? `Banco ${formatBytes(storage.dbBytes)} · Arquivos ${formatBytes(storage.importsBytes)}` : undefined}
                  value={<span className="settings-row-value">{loadingStorage || !storage ? "Calculando..." : formatBytes(totalBytes)}</span>}
                />
                {expanded === "espaco" && storage && (
                  <div className="settings-detail">
                    {totalBytes > 0 && (
                      <div className="settings-storage-bar" aria-hidden="true">
                        <i style={{ width: `${(storage.dbBytes / totalBytes) * 100}%`, background: "#60a5fa" }} />
                        <i style={{ width: `${(storage.importsBytes / totalBytes) * 100}%`, background: "#a78bfa" }} />
                      </div>
                    )}
                    <div className="settings-storage-legend">
                      <button type="button" onClick={() => setStorageDetail("db")} title="Ver o que ocupa espaço, do maior para o menor">
                        <i style={{ background: "#60a5fa" }} />
                        Banco de dados · {formatBytes(storage.dbBytes)}
                      </button>
                      <button type="button" onClick={() => setStorageDetail("imports")} title="Ver o que ocupa espaço, do maior para o menor">
                        <i style={{ background: "#a78bfa" }} />
                        Arquivos importados · {formatBytes(storage.importsBytes)} ({storage.importsFileCount} {storage.importsFileCount === 1 ? "arquivo" : "arquivos"})
                      </button>
                    </div>
                    <p className="settings-detail-text">Clique em cada parte para ver o que ocupa mais espaço.</p>
                  </div>
                )}
              </div>
            )}
            {rows.originais && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">Remover originais repetidos</span>
                  <span className="settings-row-desc">
                    PDFs em lote já importados por inteiro. Cada colaborador continua com a própria página.
                    {purgeMessage && <span className="settings-row-result"> {purgeMessage}</span>}
                  </span>
                </span>
                <button type="button" className="settings-button" onClick={handleFindRedundant} disabled={purging}>
                  {purging ? "Procurando..." : "Procurar e remover"}
                </button>
              </div>
            )}
            {rows.compactar && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">Compactar o banco</span>
                  <span className="settings-row-desc">Recupera o espaço de registros já apagados, sem remover nenhum dado.</span>
                </span>
                <button type="button" className="settings-button" onClick={handleVacuum} disabled={vacuuming}>
                  {vacuuming ? "Compactando..." : "Compactar"}
                </button>
              </div>
            )}
            {rows.copia && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">Salvar uma cópia do banco</span>
                  <span className="settings-row-desc">Um arquivo .db para guardar ou mandar pra alguém analisar. Não muda nada aqui.</span>
                </span>
                <button type="button" className="settings-button" onClick={handleExportDatabase} disabled={exporting}>
                  <Download size={14} />
                  {exporting ? "Salvando..." : "Salvar cópia"}
                </button>
              </div>
            )}
            {rows.pasta && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">Abrir pasta de dados</span>
                  <span className="settings-row-desc">Onde ficam o banco e os arquivos importados.</span>
                </span>
                <button type="button" className="settings-button settings-button-ghost" onClick={handleOpenDataDir}>
                  <FolderOpen size={14} />
                  Abrir
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {groups.integracoes && (
        <section className="settings-group" aria-labelledby="settings-group-integracoes">
          <h3 id="settings-group-integracoes" className="settings-group-title">
            Integrações
          </h3>
          <div className="settings-card">
            {rows.pdf && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "pdf"}
                  onToggle={() => toggleRow("pdf")}
                  title="Ferramentas de PDF"
                  desc={popplerStatus?.popplerDir ?? "Poppler, para ler e montar PDFs"}
                  value={
                    popplerStatus &&
                    (popplerMissing === 0 ? (
                      <span className="settings-pill settings-pill-ok">
                        {popplerStatus.binaries.length} de {popplerStatus.binaries.length}
                      </span>
                    ) : (
                      <span className="settings-pill settings-pill-bad">
                        {popplerMissing} de {popplerStatus.binaries.length} faltando
                      </span>
                    ))
                  }
                />
                {expanded === "pdf" && (
                  <div className="settings-detail">
                    <div className="settings-binaries">
                      {popplerStatus?.binaries.map((b) => (
                        <div key={b.name} className="settings-binary">
                          {b.path ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}
                          <code>{b.name}</code>
                          <span className="settings-binary-path">{b.path ?? "não encontrado"}</span>
                        </div>
                      ))}
                    </div>
                    <div className="settings-field">
                      <label htmlFor="poppler-dir">{popplerMissing > 0 ? "Informe a pasta onde o Poppler está instalado" : "Usar outra pasta (opcional)"}</label>
                      <div className="settings-inline-form">
                        <input id="poppler-dir" type="text" placeholder="ex.: /opt/homebrew/bin" value={popplerDirInput} onChange={(e) => setPopplerDirInput(e.target.value)} />
                        <button type="button" className="settings-button" onClick={handleChoosePopplerDir}>
                          <FolderOpen size={14} />
                          Escolher…
                        </button>
                        <button type="button" className="settings-button settings-button-primary" onClick={handleSavePopplerDir} disabled={popplerSaving}>
                          {popplerSaving ? "Testando..." : "Salvar e testar"}
                        </button>
                      </div>
                    </div>
                    {popplerError && <div className="error-box settings-error">{popplerError}</div>}
                  </div>
                )}
              </div>
            )}
            {rows.ia && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "ia"}
                  onToggle={() => toggleRow("ia")}
                  title="Assistente com IA"
                  desc={aiConnection === "claude-code" ? "Pelo Claude Code deste computador" : aiConnection === "api-key" ? "Pela chave de API da Anthropic" : "Responde perguntas sobre o app e os dados"}
                  value={
                    aiConnection &&
                    (aiConnection === "none" ? (
                      <span className="settings-pill settings-pill-warn">Desligado</span>
                    ) : (
                      <span className="settings-pill settings-pill-ok">Pronto</span>
                    ))
                  }
                />
                {expanded === "ia" && (
                  <div className="settings-detail settings-detail-flush">
                    <AiSettingsCard onConnectionChange={setAiConnection} />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {groups.risco && (
        <section className="settings-group" aria-labelledby="settings-group-risco">
          <h3 id="settings-group-risco" className="settings-group-title settings-text-danger">
            Zona de risco
          </h3>
          <div className="settings-card settings-card-danger">
            {rows.apagar && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title settings-text-danger">Apagar histórico e arquivos</span>
                  <span className="settings-row-desc">Escolha o que manter e salve um backup antes.</span>
                </span>
                <button type="button" className="settings-button settings-button-danger" onClick={openClearWizard}>
                  Começar…
                </button>
              </div>
            )}
            {rows.substituir && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title settings-text-danger">Substituir o banco</span>
                  <span className="settings-row-desc">Restaura tudo a partir de um arquivo .db. O app reinicia.</span>
                </span>
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  onClick={() => {
                    setImportConfirmText("");
                    setImportDbOpen(true);
                  }}
                >
                  Começar…
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {storageDetail && (
        <Modal onClose={closeStorageDetail} title={storageDetail === "db" ? "Banco de dados" : "Arquivos importados"} maxHeight="70vh">
          {loadingStorageDetail && <p className="muted">Calculando...</p>}
          {storageDetailError && <div className="error-box">{storageDetailError}</div>}
          {!loadingStorageDetail && !storageDetailError && (
            <div className="settings-detail-list">
              {(storageDetail === "db" ? (dbTableSizes ?? []).length : (importFileEntries ?? []).length) === 0 && <p className="muted">Nada para mostrar.</p>}
              {storageDetail === "db" &&
                dbTableSizes?.map((t) => (
                  <div key={t.tableName} className="settings-detail-row">
                    <span>{t.tableName}</span>
                    <span className="muted">{formatBytes(t.bytes)}</span>
                  </div>
                ))}
              {storageDetail === "imports" &&
                importFileEntries?.map((f, i) => (
                  <div key={i} className="settings-detail-row">
                    <span style={{ overflowWrap: "anywhere" }}>{f.name}</span>
                    <span className="muted">{formatBytes(f.bytes)}</span>
                  </div>
                ))}
            </div>
          )}
        </Modal>
      )}

      {purgeCandidates && (
        <ConfirmModal
          title={`Remover ${purgeCandidates.length} ${purgeCandidates.length === 1 ? "original repetido" : "originais repetidos"}?`}
          message="São PDFs em lote que já tiveram todas as páginas importadas. As páginas de cada colaborador continuam salvas; só o arquivo inteiro original é apagado."
          confirmLabel={purging ? "Removendo..." : "Remover"}
          confirmDisabled={purging}
          onConfirm={handleConfirmPurge}
          onCancel={() => setPurgeCandidates(null)}
        />
      )}

      {wizardStep !== null && (
        <Modal onClose={() => !clearing && setWizardStep(null)} width="34rem" closeOnBackdrop={false}>
          <div className="settings-wizard">
            <div className="settings-wizard-head">
              <div>
                <h3>Apagar histórico e arquivos</h3>
                <span className="muted">
                  Passo {wizardStep + 1} de 3 · {["O que manter", "Backup", "Confirmar"][wizardStep]}
                </span>
              </div>
              <div className="settings-wizard-steps" aria-hidden="true">
                {[0, 1, 2].map((s) => (
                  <i key={s} className={s <= wizardStep ? "on" : undefined} />
                ))}
              </div>
            </div>

            {wizardStep === 0 && (
              <div className="settings-wizard-body">
                <p className="muted">O histórico de importações e os arquivos importados sempre são apagados: dá pra recriar tudo reimportando. O que mais você quer manter?</p>
                <span className="settings-label">Cadastro</span>
                <WizardOption checked={keepCompanies} disabled={keepClients} onChange={toggleKeepCompanies} title="Empresas" />
                <WizardOption checked={keepClients} disabled={keepEmployees} onChange={toggleKeepClients} title="Clientes" desc="Mantém as empresas também" />
                <WizardOption checked={keepEmployees} onChange={toggleKeepEmployees} title="Colaboradores" desc="Mantém clientes e empresas também" />
                <WizardOption
                  checked={keepManuallyEditedShifts}
                  disabled={!keepEmployees}
                  onChange={setKeepManuallyEditedShifts}
                  title="Turnos de pagamento editados à mão"
                  desc={keepEmployees ? "Pagos, voltados para pendente ou com valor corrigido" : "Precisa manter os colaboradores"}
                />
                <span className="settings-label">Configuração</span>
                <WizardOption checked={keepPaymentTemplates} onChange={setKeepPaymentTemplates} title="Modelos de pagamento" desc="Mapeamento de colunas das planilhas" />
                <WizardOption checked={keepEmployeeTemplates} onChange={setKeepEmployeeTemplates} title="Modelos de colaboradores" />
              </div>
            )}

            {wizardStep === 1 && (
              <div className="settings-wizard-body">
                <p className="muted">Recomendado: salve um backup antes. Você escolhe onde salvar o .zip depois de confirmar.</p>
                <WizardOption checked={backupDb} onChange={setBackupDb} title="Banco de dados" desc="Cadastro, histórico e configurações" />
                <WizardOption checked={backupFiles} onChange={setBackupFiles} title="Arquivos importados" desc="PDFs de ponto e planilhas baixadas por link" />
              </div>
            )}

            {wizardStep === 2 && (
              <div className="settings-wizard-body">
                <div className="settings-wizard-summary">
                  <div>
                    <strong className="settings-text-danger">Vai apagar</strong>
                    <span>{removedSummary.join(", ")}.</span>
                  </div>
                  <div>
                    <strong>Vai manter</strong>
                    <span>{keptSummary.length ? `${keptSummary.join(", ")}.` : "nada."}</span>
                  </div>
                  <div>
                    <strong>Backup</strong>
                    <span>
                      {backupDb || backupFiles
                        ? `Sim: ${[backupDb && "banco de dados", backupFiles && "arquivos importados"].filter(Boolean).join(" e ")}.`
                        : "Não. Não vai dar pra desfazer."}
                    </span>
                  </div>
                </div>
                <label htmlFor="clear-confirm" className="muted">
                  Digite <strong className="settings-text-strong">{CLEAR_CONFIRM_PHRASE}</strong> para confirmar
                </label>
                <input id="clear-confirm" type="text" autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={CLEAR_CONFIRM_PHRASE} />
              </div>
            )}

            <div className="settings-wizard-foot">
              <button type="button" className="settings-button settings-button-ghost" onClick={() => setWizardStep(null)} disabled={clearing}>
                Cancelar
              </button>
              {wizardStep > 0 && (
                <button type="button" className="settings-button" onClick={() => setWizardStep(wizardStep - 1)} disabled={clearing}>
                  Voltar
                </button>
              )}
              {wizardStep < 2 ? (
                <button type="button" className="settings-button settings-button-primary" onClick={() => setWizardStep(wizardStep + 1)}>
                  Continuar
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-button settings-button-danger-solid"
                  onClick={handleClearAll}
                  disabled={clearing || confirmText.trim() !== CLEAR_CONFIRM_PHRASE}
                >
                  {backupDb || backupFiles ? <Archive size={14} /> : <Trash2 size={14} />}
                  {clearing ? "Apagando..." : backupDb || backupFiles ? "Salvar backup e apagar" : "Apagar"}
                </button>
              )}
            </div>
            {error && <div className="error-box settings-error">{error}</div>}
          </div>
        </Modal>
      )}

      {importDbOpen && restartCountdown === null && (
        <Modal onClose={() => !importing && setImportDbOpen(false)} width="32rem" closeOnBackdrop={false}>
          <div className="settings-wizard">
            <div className="settings-wizard-head">
              <div>
                <h3>Substituir o banco por outro arquivo</h3>
                <span className="muted">Cadastro, histórico e configurações: tudo vem do arquivo escolhido.</span>
              </div>
            </div>
            <div className="settings-wizard-body">
              <div className="settings-wizard-summary">
                <div>
                  <strong>Como funciona</strong>
                  <span>
                    O arquivo é conferido antes. Durante a troca, o banco atual fica guardado; se algo der errado, ele volta sozinho. Depois que dá certo, essa cópia é apagada e o
                    app reinicia.
                  </span>
                </div>
                <div>
                  <strong className="settings-text-danger">Atenção</strong>
                  <span>Só use se souber exatamente o que há nesse arquivo. Se quiser, salve antes uma cópia do banco atual em Dados e armazenamento.</span>
                </div>
              </div>
              <label htmlFor="import-confirm" className="muted">
                Digite <strong className="settings-text-strong">{IMPORT_CONFIRM_PHRASE}</strong> para confirmar
              </label>
              <input id="import-confirm" type="text" autoFocus value={importConfirmText} onChange={(e) => setImportConfirmText(e.target.value)} placeholder={IMPORT_CONFIRM_PHRASE} />
            </div>
            <div className="settings-wizard-foot">
              <button type="button" className="settings-button settings-button-ghost" onClick={() => setImportDbOpen(false)} disabled={importing}>
                Cancelar
              </button>
              <button
                type="button"
                className="settings-button settings-button-danger-solid"
                onClick={handleImportDatabase}
                disabled={importing || importConfirmText.trim() !== IMPORT_CONFIRM_PHRASE}
              >
                <Upload size={14} />
                {importing ? "Substituindo..." : "Escolher arquivo e substituir"}
              </button>
            </div>
            {error && <div className="error-box settings-error">{error}</div>}
          </div>
        </Modal>
      )}

      {restartCountdown !== null && (
        <Modal onClose={() => {}} closeOnEscape={false} closeOnBackdrop={false} width="30rem">
          <h3 style={{ marginTop: 0 }}>Banco pronto para restauração</h3>
          <p className="muted" style={{ lineHeight: 1.55 }}>
            O arquivo foi validado e preparado.{" "}
            {import.meta.env.DEV ? (
              <>
                O modo de desenvolvimento será encerrado em <strong>{restartCountdown} segundo(s)</strong>. Depois, execute <code>yarn tauri dev</code> novamente para concluir a
                restauração.
              </>
            ) : (
              <>
                O PontoScan reiniciará em <strong>{restartCountdown} segundo(s)</strong> para restaurar o banco com segurança.
              </>
            )}
          </p>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Se ocorrer algum erro, o banco atual será mantido. Nenhuma cópia extra permanecerá após uma restauração bem-sucedida.
          </p>
          <div style={{ display: "grid", gap: "0.4rem", margin: "1rem 0" }}>
            {importEvents.map((event) => (
              <div
                key={`${event.label}-${event.occurredAt}`}
                style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.5rem 0.65rem", background: "var(--sidebar-bg)", borderRadius: 6 }}
              >
                <span>✓ {event.label}</span>
                <code>{event.occurredAt}</code>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.5rem 0.65rem", background: "var(--accent-soft)", borderRadius: 6 }}>
              <span>⏳ Reinício pendente</span>
              <code>em {restartCountdown}s</code>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.1rem" }}>
            <button type="button" className="secondary" onClick={cancelPendingImport}>
              Cancelar importação
            </button>
            <button type="button" onClick={() => setRestartCountdown(0)}>
              {import.meta.env.DEV ? "Fechar modo dev agora" : "Reiniciar agora"}
            </button>
          </div>
        </Modal>
      )}

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

/** One "keep this" / "include this" choice in the Apagar wizard: the whole row is the checkbox. */
function WizardOption({
  checked,
  onChange,
  title,
  desc,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  desc?: string;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "settings-option settings-option-disabled" : "settings-option"}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="settings-option-title">{title}</span>
        {desc && <span className="settings-option-desc">{desc}</span>}
      </span>
    </label>
  );
}

/** A settings row that opens its details below it when clicked. */
function ExpandHead({ open, onToggle, title, desc, value }: { open: boolean; onToggle: () => void; title: string; desc?: ReactNode; value?: ReactNode }) {
  return (
    <button type="button" className="settings-row settings-row-button" aria-expanded={open} onClick={onToggle}>
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {desc && <span className="settings-row-desc">{desc}</span>}
      </span>
      {value}
      <ChevronRight size={16} className={open ? "settings-chevron settings-chevron-open" : "settings-chevron"} />
    </button>
  );
}

/** Lowercase, without accents: "Atualização" and "atualizacao" find the same row. */
function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
