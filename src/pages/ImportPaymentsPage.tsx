import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, FileText, Search, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Pagination from "../components/Pagination";
import { listImportFiles } from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { ImportFileRow, ImportStatus } from "../lib/types";

const STATUS_BADGE: Record<ImportStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { className: "badge ok", label: "Sucesso", icon: CheckCircle2 },
  warning: { className: "badge overwrite", label: "Com alertas", icon: AlertTriangle },
  error: { className: "badge file-error", label: "Falha", icon: AlertCircle },
};

const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportPaymentsPage() {
  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);

  useEffect(() => {
    listImportFiles("payment").then(setRecentFiles);
  }, []);

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
      </div>
      <p className="page-subtitle">
        Importe pagamentos a partir de arquivos CSV, Excel ou ODS fornecidos pelo seu provedor.
      </p>

      <div className="import-layout">
        <div className="import-main">
          <div className="card" style={{ textAlign: "center", padding: "3rem 1.5rem" }}>
            <Wrench size={28} style={{ color: "var(--text-muted)", marginBottom: "0.8rem" }} />
            <h3 style={{ margin: "0 0 0.4rem" }}>Em construção</h3>
            <p className="muted" style={{ margin: 0 }}>
              Em breve você poderá importar pagamentos por aqui. Estamos definindo como esse fluxo
              vai funcionar.
            </p>
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
    </div>
  );
}
