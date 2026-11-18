import { Archive, ChevronRight, Download, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import AiSettingsCard, { type AiConnection } from "../components/AiSettingsCard";
import ConfirmModal from "../components/ConfirmModal";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import {
  aiStatus,
  clearImportsDir,
  deleteImportedFiles,
  downloadBackup,
  downloadDatabaseCopy,
  getImportsFileList,
  getStorageUsage,
} from "../lib/api";
import {
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
import { fetchServerVersion } from "../lib/http";
import type { StorageFileEntry, StorageUsage } from "../lib/types";

const CLEAR_CONFIRM_PHRASE = "APAGAR TUDO";

/** Rows whose details open below them. */
type ExpandableRow = "espaco" | "ia";

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
  const [serverVersion, setServerVersion] = useState<string | null>(null);

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
    fetchServerVersion()
      .then(setServerVersion)
      .catch(() => setServerVersion(null));
  }, []);

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

  async function handleExportDatabase() {
    setError(null);
    setExporting(true);
    try {
      await downloadDatabaseCopy();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setExporting(false);
    }
  }

  async function handleClearAll() {
    if (confirmText.trim() !== CLEAR_CONFIRM_PHRASE) return;
    setError(null);
    setClearing(true);
    try {
      // The backup is downloaded by the browser first; nothing is deleted
      // unless that worked.
      if (backupDb || backupFiles) await downloadBackup(backupDb, backupFiles);
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

  // The assistant row shows how it's connected before it's opened.
  useEffect(() => {
    aiStatus()
      .then((status) => setAiConnection(status.apiKey ? "api-key" : "none"))
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
      const freedBytes = await deleteImportedFiles(purgeCandidates.map((c) => c.path));
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
    versao: matches("geral versão versao atualização atualizacao sobre"),
    espaco: matches("dados espaço usado armazenamento disco tamanho banco arquivos servidor"),
    originais: matches("dados liberar espaço remover originais repetidos redundantes pdf lote"),
    compactar: matches("dados compactar banco vacuum espaço"),
    copia: matches("dados baixar salvar cópia copia backup exportar banco"),
    ia: matches("integrações assistente ia inteligência artificial claude anthropic chave api"),
    apagar: matches("zona de risco apagar tudo histórico arquivos limpar zerar backup"),
  };
  const groups = {
    geral: rows.versao,
    dados: rows.espaco || rows.originais || rows.compactar || rows.copia,
    integracoes: rows.ia,
    risco: rows.apagar,
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
          placeholder="Ex.: espaço, backup, assistente"
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
            {rows.versao && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">Versão</span>
                  <span className="settings-row-desc">A web se atualiza sozinha. Se aparecer algo estranho depois de uma atualização, recarregue a página.</span>
                </span>
                <span className="settings-row-value">{serverVersion ? `versão ${serverVersion.slice(0, 7)}` : "—"}</span>
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
                    <p className="settings-detail-text">No servidor. Clique em cada parte para ver o que ocupa mais espaço.</p>
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
                  <span className="settings-row-title">Baixar uma cópia do banco</span>
                  <span className="settings-row-desc">Um arquivo .db para guardar ou mandar pra alguém analisar. Não muda nada aqui.</span>
                </span>
                <button type="button" className="settings-button" onClick={handleExportDatabase} disabled={exporting}>
                  <Download size={14} />
                  {exporting ? "Preparando..." : "Baixar cópia"}
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
            {rows.ia && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "ia"}
                  onToggle={() => toggleRow("ia")}
                  title="Assistente com IA"
                  desc={aiConnection === "api-key" ? "Chave da Anthropic cadastrada para a equipe" : "Responde perguntas sobre o app e os dados"}
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
                  <span className="settings-row-desc">Escolha o que manter e baixe um backup antes.</span>
                </span>
                <button type="button" className="settings-button settings-button-danger" onClick={openClearWizard}>
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
                <p className="muted">Recomendado: baixe um backup antes. O arquivo .zip é baixado pelo navegador assim que você confirmar, e só depois os dados são apagados.</p>
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
                  {clearing ? "Apagando..." : backupDb || backupFiles ? "Baixar backup e apagar" : "Apagar"}
                </button>
              )}
            </div>
            {error && <div className="error-box settings-error">{error}</div>}
          </div>
        </Modal>
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
