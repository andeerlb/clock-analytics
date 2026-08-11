import { Building2, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import { listCompanies, listRolesGlobal, type CompanyRow, type RoleRow } from "../lib/db";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Cadastro de funções — mirrors `EmployeesPage`, but simpler: no CPF/
 * matrícula, and scoped by empresa only (see `roles.company_id` — a função
 * has no cliente of its own, unlike a colaborador). Filtered/paginated
 * client-side, unlike `EmployeesPage`'s SQL-side filtering — a função
 * cadastro is small and finite per empresa, so `listRolesGlobal` just
 * fetches everything once.
 */
export default function RolesPage() {
  const navigate = useNavigate();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  useEffect(() => {
    setLoading(true);
    Promise.all([listCompanies(), listRolesGlobal()])
      .then(([companyRows, roleRows]) => {
        setCompanies(companyRows);
        setRoles(roleRows);
      })
      .finally(() => setLoading(false));
  }, []);

  const companyNameById = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return roles
      .filter((r) => selectedCompanyIds.size === 0 || selectedCompanyIds.has(String(r.companyId)))
      .filter((r) => !query || r.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [roles, search, selectedCompanyIds]);

  function toggleCompany(id: string) {
    const next = new Set(selectedCompanyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedCompanyIds(next);
    setPage(0);
  }

  const hasFilters = Boolean(search.trim() || selectedCompanyIds.size > 0);
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageItems = filtered.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div>
      <div className="page-header">
        <h2>Funções</h2>
        <button type="button" onClick={() => navigate("/roles/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Nova função
        </button>
      </div>
      <p className="page-subtitle">
        Cadastro de funções (cargos), por empresa — usado para filtrar turnos por função e para dar
        match com a coluna Função dos arquivos importados.
      </p>

      <div className="card">
        <div className="field-row" style={{ marginBottom: 0, alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <label htmlFor="roles-search">Função</label>
            <div style={{ position: "relative" }}>
              <Search
                size={14}
                style={{ position: "absolute", left: "0.65rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
              />
              <input
                id="roles-search"
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
        </div>
      </div>

      <div className="card table-card">
        {loading && roles.length === 0 && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && total === 0 && !hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhuma função cadastrada ainda.
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
                    <th>Função</th>
                    <th>Empresa</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/roles/${r.id}`}>{r.name}</Link>
                      </td>
                      <td>{companyNameById.get(r.companyId) ?? "—"}</td>
                    </tr>
                  ))}
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
