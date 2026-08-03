import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { openOriginalPdf } from "../lib/api";
import { listImports } from "../lib/db";
import type { StoredImport } from "../lib/types";

export default function LibraryPage() {
  const [imports, setImports] = useState<StoredImport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listImports()
      .then(setImports)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h2>Colaboradores importados</h2>
        <Link to="/import">
          <button type="button">+ Novo import</button>
        </Link>
      </div>

      <div className="card">
        {loading && <p className="muted">Carregando...</p>}
        {!loading && imports.length === 0 && (
          <p className="muted">Nenhum import ainda. Comece importando um PDF.</p>
        )}
        {imports.length > 0 && (
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
              {imports.map((imp) => (
                <tr key={imp.importId}>
                  <td>{imp.employeeName}</td>
                  <td>{imp.companyName}</td>
                  <td>
                    {imp.periodStart} a {imp.periodEnd}
                  </td>
                  <td>{imp.importedAt}</td>
                  <td style={{ display: "flex", gap: "0.5rem" }}>
                    <Link to={`/employee/${imp.importId}`}>Ver cartão ponto</Link>
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
        )}
      </div>
    </div>
  );
}
