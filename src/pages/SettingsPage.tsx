import { open, save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Database,
  FileCheck2,
  FolderOpen,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  backupAppData,
  checkPopplerStatus,
  clearImportsDir,
  deletePaths,
  getStorageUsage,
  openAppDataDir,
  setPopplerDir,
} from "../lib/api";
import { clearAllData, findRedundantOriginals, markOriginalsRemoved, vacuumDatabase } from "../lib/db";
import { formatBytes } from "../lib/format";
import type { PopplerStatus, StorageUsage } from "../lib/types";

const CLEAR_CONFIRM_PHRASE = "APAGAR TUDO";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [vacuuming, setVacuuming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeMessage, setPurgeMessage] = useState<string | null>(null);
  const [backupBeforeClear, setBackupBeforeClear] = useState(true);
  const [keepCompanies, setKeepCompanies] = useState(false);
  const [keepClients, setKeepClients] = useState(false);
  const [keepEmployees, setKeepEmployees] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [popplerStatus, setPopplerStatusState] = useState<PopplerStatus | null>(null);
  const [popplerDirInput, setPopplerDirInput] = useState("");
  const [popplerSaving, setPopplerSaving] = useState(false);
  const [popplerError, setPopplerError] = useState<string | null>(null);

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
  }, []);

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
      if (backupBeforeClear) {
        const destPath = await save({
          defaultPath: "clock-analytics-backup.zip",
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        if (!destPath) {
          setClearing(false);
          return;
        }
        await backupAppData(destPath);
      }
      await clearAllData({ keepCompanies, keepClients, keepEmployees });
      await clearImportsDir();
      navigate("/");
    } catch (e) {
      setError(String(e));
      setClearing(false);
    }
  }

  const totalBytes = storage ? storage.dbBytes + storage.importsBytes : 0;

  return (
    <div>
      <div className="page-header">
        <h2>Configurações</h2>
      </div>
      <p className="page-subtitle">
        O Clock Analytics guarda tudo localmente neste computador — banco de dados e cópias dos
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

        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem", marginBottom: "1.2rem" }}>
          <input
            type="checkbox"
            checked={backupBeforeClear}
            onChange={(e) => setBackupBeforeClear(e.target.checked)}
          />
          Fazer backup (zip do banco + PDFs) antes de apagar
        </label>

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
          {backupBeforeClear ? <Archive size={15} style={{ marginRight: "0.4rem" }} /> : <Trash2 size={15} style={{ marginRight: "0.4rem" }} />}
          {clearing ? "Apagando..." : "Apagar tudo"}
        </button>
      </div>
    </div>
  );
}
