import { Building2, Plus, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import { listClients, listCompanies, listEmployeesGlobal, type ClientRow, type CompanyRow, type EmployeeRow } from "../lib/db";
import { formatCpf } from "../lib/format";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function EmployeesPage() {
  const navigate = useNavigate();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listCompanies(), listClients()]).then(([companyRows, clientRows]) => {
      setCompanies(companyRows);
      setClients(clientRows);
    });
  }, []);

  // The actual list — filtered, sorted and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listEmployeesGlobal({
      search,
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      page,
      pageSize,
    })
      .then(({ rows, total: rowTotal }) => {
        if (cancelled) return;
        setEmployees(rows);
        setTotal(rowTotal);
      })
      .catch((e) => {
        if (cancelled) return;
        setEmployees([]);
        setTotal(0);
        setError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, selectedCompanyIds, selectedClientIds, page, pageSize]);

  const clientOptions = useMemo(() => {
    const scoped =
      selectedCompanyIds.size > 0
        ? clients.filter((c) => selectedCompanyIds.has(String(c.companyId)))
        : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, selectedCompanyIds]);

  function toggleCompany(id: string) {
    const next = new Set(selectedCompanyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedCompanyIds(next);
    setSelectedClientIds(new Set());
    setPage(0);
  }
  function toggleClient(id: string) {
    const next = new Set(selectedClientIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedClientIds(next);
    setPage(0);
  }

  const hasFilters = Boolean(search.trim() || selectedCompanyIds.size > 0 || selectedClientIds.size > 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="page-header">
        <h2>Colaboradores</h2>
        <button type="button" onClick={() => navigate("/employees/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo colaborador
        </button>
      </div>
      <p className="page-subtitle">
        Cadastro de colaboradores, independente de espelho de ponto ou pagamento importado. O CPF
        é único por cliente — o mesmo CPF pode existir para clientes diferentes.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="field-row" style={{ marginBottom: 0, alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <label htmlFor="employees-search">Colaborador</label>
            <div style={{ position: "relative" }}>
              <Search
                size={14}
                style={{ position: "absolute", left: "0.65rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
              />
              <input
                id="employees-search"
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="Buscar por nome..."
                style={{ width: "100%", paddingLeft: "2rem" }}
              />
            </div>
          </div>
          <div className="field">
            <label>Empresa</label>
            <MultiSelectDropdown
              options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
              selected={selectedCompanyIds}
              onToggle={toggleCompany}
              onSelectAll={() => {
                setSelectedCompanyIds(new Set(companies.map((c) => String(c.id))));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedCompanyIds(new Set());
                setPage(0);
              }}
              icon={Building2}
              allLabel="Todas as empresas"
              noneLabel="Nenhuma empresa"
            />
          </div>
          <div className="field">
            <label>Cliente</label>
            <MultiSelectDropdown
              options={clientOptions.map((c) => ({ id: String(c.id), label: c.name }))}
              selected={selectedClientIds}
              onToggle={toggleClient}
              onSelectAll={() => {
                setSelectedClientIds(new Set(clientOptions.map((c) => String(c.id))));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedClientIds(new Set());
                setPage(0);
              }}
              icon={Users}
              allLabel="Todos os clientes"
              noneLabel="Nenhum cliente"
            />
          </div>
        </div>
      </div>

      <div className="card table-card">
        {loading && employees.length === 0 && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && total === 0 && !hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum colaborador cadastrado ainda.
          </p>
        )}
        {!loading && total === 0 && hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum resultado para os filtros selecionados.
          </p>
        )}
        {total > 0 && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>CPF</th>
                    <th>Cliente</th>
                    <th>Empresas</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => {
                    const distinctClients = Array.from(new Set(e.links.map((l) => l.clientName)));
                    const distinctCompanies = Array.from(new Set(e.links.map((l) => l.companyName)));
                    return (
                      <tr key={e.id}>
                        <td>
                          <div className="person-cell">
                            <Avatar name={e.name} />
                            <Link to={`/employees/${e.id}`}>{e.name}</Link>
                          </div>
                        </td>
                        <td className="mono">{formatCpf(e.cpf)}</td>
                        <td>{distinctClients.join(", ")}</td>
                        <td>{distinctCompanies.join(", ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {total > PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(
                  total,
                  page * pageSize + pageSize,
                )} de ${total}`}
                pageSize={pageSize}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
