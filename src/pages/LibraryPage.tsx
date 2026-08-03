import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { openOriginalPdf } from "../lib/api";
import { colorForName, initials } from "../lib/avatar";
import { listImports } from "../lib/db";
import { formatDate, formatDateTime } from "../lib/format";
import type { StoredImport } from "../lib/types";

const PAGE_SIZE = 10;

export default function LibraryPage() {
  const [imports, setImports] = useState<StoredImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    listImports()
      .then(setImports)
      .finally(() => setLoading(false));
  }, []);

  const pageCount = Math.max(1, Math.ceil(imports.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => imports.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [imports, page],
  );

  return (
    <div>
      <div className="page-header">
        <h2>Colaboradores</h2>
      </div>
      <p className="page-subtitle">
        Colaboradores com espelhos de ponto importados.
      </p>

      <div className="card">
        {loading && <p className="muted">Carregando...</p>}
        {!loading && imports.length === 0 && (
          <p className="muted">Nenhum import ainda. Comece importando um PDF.</p>
        )}
        {imports.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Empresa</th>
                  <th>Período</th>
                  <th>Importado em</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((imp) => (
                  <tr key={imp.importId}>
                    <td>
                      <div className="person-cell">
                        <span className="avatar" style={{ background: colorForName(imp.employeeName) }}>
                          {initials(imp.employeeName)}
                        </span>
                        <Link to={`/employee/${imp.importId}`}>{imp.employeeName}</Link>
                      </div>
                    </td>
                    <td>{imp.companyName}</td>
                    <td>
                      {formatDate(imp.periodStart)} a {formatDate(imp.periodEnd)}
                    </td>
                    <td>{formatDateTime(imp.importedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => openOriginalPdf(imp.originalPdfPath)}
                      >
                        Original
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="pagination">
              <span className="muted">
                Mostrando {page * PAGE_SIZE + 1} a{" "}
                {Math.min(imports.length, page * PAGE_SIZE + PAGE_SIZE)} de {imports.length} registros
              </span>
              <div className="pagination-controls">
                <button
                  type="button"
                  className="secondary"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  aria-label="Página anterior"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  aria-label="Próxima página"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
