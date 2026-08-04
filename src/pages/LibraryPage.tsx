import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Pagination from "../components/Pagination";
import { openOriginalPdf } from "../lib/api";
import { colorForName, initials } from "../lib/avatar";
import { listClients, listCompanies, listImports, type ClientRow, type CompanyRow } from "../lib/db";
import { formatDate, formatDateTime } from "../lib/format";
import type { StoredImport } from "../lib/types";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function LibraryPage() {
  const [imports, setImports] = useState<StoredImport[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [search, setSearch] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [clientId, setClientId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  useEffect(() => {
    Promise.all([listImports(), listCompanies(), listClients()])
      .then(([importsRows, companyRows, clientRows]) => {
        setImports(importsRows);
        setCompanies(companyRows);
        setClients(clientRows);
      })
      .finally(() => setLoading(false));
  }, []);

  // `listClients` has one row per (client, company) link — dedupe down to
  // one option per client for this filter, which is independent of company.
  const clientOptions = useMemo(() => {
    const seen = new Map<number, ClientRow>();
    for (const c of clients) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients]);

  // Reset to the first page whenever a filter changes, so pagination never
  // gets stuck showing an out-of-range page.
  useEffect(() => {
    setPage(0);
  }, [search, companyId, clientId, periodStart, periodEnd]);

  const filteredImports = useMemo(() => {
    const query = search.trim().toLowerCase();
    return imports.filter((imp) => {
      if (companyId && String(imp.companyId) !== companyId) return false;
      if (clientId && String(imp.clientId) !== clientId) return false;
      if (query && !imp.employeeName.toLowerCase().includes(query)) {
        return false;
      }
      // Period range filter: keep imports whose period overlaps the
      // selected range — an empty bound means "no constraint on that side".
      if (periodStart && imp.periodEnd < periodStart) return false;
      if (periodEnd && imp.periodStart > periodEnd) return false;
      return true;
    });
  }, [imports, search, companyId, clientId, periodStart, periodEnd]);

  const pageCount = Math.max(1, Math.ceil(filteredImports.length / pageSize));
  const pageItems = useMemo(
    () => filteredImports.slice(page * pageSize, page * pageSize + pageSize),
    [filteredImports, page, pageSize],
  );

  const hasFilters = Boolean(search || companyId || clientId || periodStart || periodEnd);

  return (
    <div>
      <div className="page-header">
        <h2>Colaboradores</h2>
      </div>
      <p className="page-subtitle">
        Colaboradores com espelhos de ponto importados.
      </p>

      {imports.length > 0 && (
        <div className="card">
          <div className="field-row" style={{ marginBottom: 0 }}>
            <div className="field" style={{ flex: "2 1 240px" }}>
              <label htmlFor="search">Buscar</label>
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
                  id="search"
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Nome do colaborador..."
                  style={{ width: "100%", paddingLeft: "2rem" }}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="company-filter">Empresa</label>
              <select
                id="company-filter"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">Todas</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="client-filter">Cliente</label>
              <select
                id="client-filter"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Todos</option>
                {clientOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="period-start">De</label>
              <input
                id="period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="period-end">Até</label>
              <input
                id="period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && imports.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum import ainda. Comece importando um PDF.
          </p>
        )}
        {!loading && imports.length > 0 && filteredImports.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            {hasFilters ? "Nenhum colaborador encontrado para esse filtro." : "Nenhum registro."}
          </p>
        )}
        {filteredImports.length > 0 && (
          <>
            <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Empresa</th>
                  <th>Período</th>
                  <th>Importado em</th>
                  <th>Ações</th>
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
                        title="Abrir o PDF deste colaborador"
                      >
                        PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={setPage}
              rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(
                filteredImports.length,
                page * pageSize + pageSize,
              )} de ${filteredImports.length} registros`}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(0);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
