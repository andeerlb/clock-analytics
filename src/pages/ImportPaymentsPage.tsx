import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Pagination from "../components/Pagination";
import PaymentTemplateWizard from "../components/PaymentTemplateWizard";
import { deletePaths } from "../lib/api";
import {
  deletePaymentTemplate,
  getPaymentTemplate,
  listImportFiles,
  listPaymentTemplates,
} from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { ImportFileRow, ImportStatus, PaymentTemplateListRow, PaymentTemplateRow } from "../lib/types";

const STATUS_BADGE: Record<ImportStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { className: "badge ok", label: "Sucesso", icon: CheckCircle2 },
  warning: { className: "badge overwrite", label: "Com alertas", icon: AlertTriangle },
  error: { className: "badge file-error", label: "Falha", icon: AlertCircle },
};

const FILE_KIND_LABELS: Record<string, string> = {
  csv: "CSV",
  xlsx: "Excel",
  xls: "Excel",
  ods: "ODS",
};

const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportPaymentsPage() {
  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);

  const [templates, setTemplates] = useState<PaymentTemplateListRow[]>([]);
  const [wizardTarget, setWizardTarget] = useState<PaymentTemplateRow | "new" | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listImportFiles("payment").then(setRecentFiles);
    refreshTemplates();
  }, []);

  function refreshTemplates() {
    listPaymentTemplates().then(setTemplates);
  }

  async function handleEditTemplate(id: number) {
    setError(null);
    try {
      const template = await getPaymentTemplate(id);
      setWizardTarget(template);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDeleteTemplate(id: number) {
    setError(null);
    try {
      const samplePath = await deletePaymentTemplate(id);
      if (samplePath) await deletePaths([samplePath]).catch(() => {});
      setConfirmDeleteId(null);
      refreshTemplates();
    } catch (e) {
      setError(String(e));
    }
  }

  const filteredRecentFiles = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (!query) return recentFiles;
    return recentFiles.filter((f) => f.fileName.toLowerCase().includes(query));
  }, [recentFiles, historySearch]);

  useEffect(() => {
    setHistoryPage(0);
  }, [historySearch]);

  const historyPageCount = Math.max(1, Math.ceil(filteredRecentFiles.length / historyPageSize));
  const historyPageItems = useMemo(
    () =>
      filteredRecentFiles.slice(
        historyPage * historyPageSize,
        historyPage * historyPageSize + historyPageSize,
      ),
    [filteredRecentFiles, historyPage, historyPageSize],
  );

  return (
    <div>
      <Link to="/import" className="back-link">
        <ArrowLeft size={14} />
        Importar
      </Link>
      <div className="page-header">
        <h2>Importar pagamentos</h2>
        <button type="button" onClick={() => setWizardTarget("new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo template
        </button>
      </div>
      <p className="page-subtitle">
        Importe pagamentos a partir de arquivos CSV, Excel ou ODS fornecidos pelo seu provedor.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="import-layout">
        <div className="import-main">
          <div className="card table-card">
            {templates.length === 0 ? (
              <p className="muted" style={{ padding: "1.4rem" }}>
                Nenhum template cadastrado ainda. Crie um para mapear as colunas de um arquivo de
                pagamentos antes de importar.
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Cliente</th>
                      <th>Formato</th>
                      <th>Atualizado em</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td>{t.clientName ?? "Global"}</td>
                        <td>{FILE_KIND_LABELS[t.fileKind] ?? t.fileKind}</td>
                        <td>{formatDateTime(t.updatedAt)}</td>
                        <td>
                          {confirmDeleteId === t.id ? (
                            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                              <span style={{ color: "var(--danger)", fontSize: "0.82rem" }}>
                                Confirmar exclusão?
                              </span>
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem", color: "var(--danger)" }}
                                onClick={() => handleDeleteTemplate(t.id)}
                              >
                                Excluir
                              </button>
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                Cancelar
                              </button>
                            </span>
                          ) : (
                            <span style={{ display: "flex", gap: "0.3rem" }}>
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: "0.3rem" }}
                                onClick={() => handleEditTemplate(t.id)}
                                aria-label="Editar"
                                title="Editar"
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: "0.3rem" }}
                                onClick={() => setConfirmDeleteId(t.id)}
                                aria-label="Excluir"
                                title="Excluir"
                              >
                                <Trash2 size={14} />
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="import-side">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Histórico de importações</h3>

            {recentFiles.length > 0 && (
              <div className="field" style={{ marginBottom: "0.8rem" }}>
                <div style={{ position: "relative" }}>
                  <Search
                    size={14}
                    style={{
                      position: "absolute",
                      left: "0.65rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--text-muted)",
                    }}
                  />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Buscar por nome do arquivo..."
                    style={{ width: "100%", paddingLeft: "2rem" }}
                  />
                </div>
              </div>
            )}

            {recentFiles.length === 0 && <p className="muted">Nenhum arquivo importado ainda.</p>}
            {recentFiles.length > 0 && filteredRecentFiles.length === 0 && (
              <p className="muted">Nenhum arquivo encontrado.</p>
            )}

            {filteredRecentFiles.length > 0 && (
              <div className="file-list">
                {historyPageItems.map((f) => {
                  const badge = STATUS_BADGE[f.status];
                  const BadgeIcon = badge.icon;
                  return (
                    <div className="file-row" key={f.id}>
                      <div className="file-row-icon">
                        <FileText size={18} />
                      </div>
                      <div className="file-row-info">
                        <div className="file-name" title={f.fileName}>
                          {f.fileName}
                        </div>
                        <div className="file-meta">
                          {f.provider || "—"} · {formatDateTime(f.importedAt)}
                        </div>
                        {f.status !== "success" && f.errorMessage && (
                          <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                            {f.errorMessage}
                          </div>
                        )}
                      </div>
                      <div className="file-row-actions">
                        <span className={badge.className}>
                          <BadgeIcon size={13} />
                          {badge.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {filteredRecentFiles.length > HISTORY_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={historyPage}
                pageCount={historyPageCount}
                onPageChange={setHistoryPage}
                rangeLabel={`Mostrando ${historyPage * historyPageSize + 1} a ${Math.min(
                  filteredRecentFiles.length,
                  historyPage * historyPageSize + historyPageSize,
                )} de ${filteredRecentFiles.length}`}
                pageSize={historyPageSize}
                pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setHistoryPageSize(size);
                  setHistoryPage(0);
                }}
                maxPageButtons={3}
              />
            )}
          </div>
        </div>
      </div>

      <PaymentTemplateWizard
        target={wizardTarget}
        onClose={() => setWizardTarget(null)}
        onSaved={() => {
          setWizardTarget(null);
          refreshTemplates();
        }}
      />
    </div>
  );
}
