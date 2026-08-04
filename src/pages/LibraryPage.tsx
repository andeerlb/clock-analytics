import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DateRangePicker from "../components/DateRangePicker";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import { colorForName, initials } from "../lib/avatar";
import { toIso, todayUtc } from "../lib/calendar";
import { listClients, listCompanies, listImports, type ClientRow, type CompanyRow } from "../lib/db";
import { formatDate, formatDateTime } from "../lib/format";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import type { StoredImport } from "../lib/types";

/** Default period on load: the current calendar month so far — this field is never empty. */
function defaultPeriodStart(): string {
  const today = todayUtc();
  return toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

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
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(() => toIso(todayUtc()));
  const [selectedStatuses, setSelectedStatuses] = useState<Set<PeriodStatusId>>(
    () => new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)),
  );
  const [viewerImport, setViewerImport] = useState<StoredImport | null>(null);

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
  }, [search, companyId, clientId, periodStart, periodEnd, selectedStatuses]);

  const filteredImports = useMemo(() => {
    const query = search.trim().toLowerCase();
    return imports.filter((imp) => {
      if (companyId && String(imp.companyId) !== companyId) return false;
      if (clientId && String(imp.clientId) !== clientId) return false;
      if (query && !imp.employeeName.toLowerCase().includes(query)) {
        return false;
      }
      if (imp.periodEnd < periodStart || imp.periodStart > periodEnd) return false;
      for (const opt of PERIOD_STATUS_OPTIONS) {
        if (opt.matches(imp) && !selectedStatuses.has(opt.id)) return false;
      }
      return true;
    });
  }, [imports, search, companyId, clientId, periodStart, periodEnd, selectedStatuses]);

  const pageCount = Math.max(1, Math.ceil(filteredImports.length / pageSize));
  const pageItems = useMemo(
    () => filteredImports.slice(page * pageSize, page * pageSize + pageSize),
    [filteredImports, page, pageSize],
  );

  const hasFilters = Boolean(
    search || companyId || clientId || selectedStatuses.size !== PERIOD_STATUS_OPTIONS.length,
  );

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
              <label>Período</label>
              <DateRangePicker
                startValue={periodStart}
                endValue={periodEnd}
                onChange={(s, e) => {
                  setPeriodStart(s);
                  setPeriodEnd(e);
                }}
                allowClear={false}
              />
            </div>
            <div className="field">
              <label>Status no período</label>
              <MultiSelectDropdown
                options={PERIOD_STATUS_OPTIONS}
                selected={selectedStatuses}
                onToggle={(id) =>
                  setSelectedStatuses((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onSelectAll={() => setSelectedStatuses(new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)))}
                onSelectNone={() => setSelectedStatuses(new Set())}
                allLabel="Todos os status"
                noneLabel="Nenhum filtro selecionado"
                countLabel={(n, total) => `${n} de ${total} filtros`}
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
                        onClick={() => setViewerImport(imp)}
                        title="Ver o PDF deste colaborador"
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

      <PdfViewerModal
        path={viewerImport?.originalPdfPath ?? null}
        title={viewerImport ? `${viewerImport.employeeName} — ${formatDate(viewerImport.periodStart)} a ${formatDate(viewerImport.periodEnd)}` : undefined}
        onClose={() => setViewerImport(null)}
      />
    </div>
  );
}
