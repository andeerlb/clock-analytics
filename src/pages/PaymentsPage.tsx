import { Building2, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import MultiSelectDropdown, { type MultiSelectOption } from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import { listClients, listCompanies, listPaymentShiftSummaries, type ClientRow, type CompanyRow } from "../lib/db";
import { colorForName, initials } from "../lib/avatar";
import type { PaymentShiftStatus, PaymentShiftSummaryRow } from "../lib/types";

const STATUS_OPTIONS: MultiSelectOption<PaymentShiftStatus>[] = [
  { id: "pendente", label: "Pendente" },
  { id: "erro", label: "Erro" },
  { id: "pago", label: "Pago" },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/** "2026-02" -> "fev/2026" */
function formatCompetencia(competencia: string): string {
  const date = new Date(`${competencia}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export default function PaymentsPage() {
  const [summaries, setSummaries] = useState<PaymentShiftSummaryRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [competenciaStart, setCompetenciaStart] = useState("");
  const [competenciaEnd, setCompetenciaEnd] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<Set<PaymentShiftStatus>>(
    new Set(STATUS_OPTIONS.map((o) => o.id)),
  );
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  useEffect(() => {
    Promise.all([listPaymentShiftSummaries(), listCompanies(), listClients()])
      .then(([summaryRows, companyRows, clientRows]) => {
        setSummaries(summaryRows);
        setCompanies(companyRows);
        setClients(clientRows);
      })
      .finally(() => setLoading(false));
  }, []);

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
  function toggleStatus(id: PaymentShiftStatus) {
    const next = new Set(selectedStatuses);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedStatuses(next);
    setPage(0);
  }

  const filteredSummaries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return summaries.filter((s) => {
      if (query && !s.employeeName.toLowerCase().includes(query)) return false;
      if (selectedCompanyIds.size > 0 && !selectedCompanyIds.has(String(s.companyId))) return false;
      if (selectedClientIds.size > 0 && !selectedClientIds.has(String(s.clientId))) return false;
      if (competenciaStart && s.competencia < competenciaStart) return false;
      if (competenciaEnd && s.competencia > competenciaEnd) return false;
      if (selectedStatuses.size < STATUS_OPTIONS.length) {
        const matches =
          (selectedStatuses.has("pendente") && s.pendente > 0) ||
          (selectedStatuses.has("erro") && s.erro > 0) ||
          (selectedStatuses.has("pago") && s.pago > 0);
        if (!matches) return false;
      }
      return true;
    });
  }, [summaries, search, selectedCompanyIds, selectedClientIds, competenciaStart, competenciaEnd, selectedStatuses]);

  const pageCount = Math.max(1, Math.ceil(filteredSummaries.length / pageSize));
  const pageItems = useMemo(
    () => filteredSummaries.slice(page * pageSize, page * pageSize + pageSize),
    [filteredSummaries, page, pageSize],
  );

  return (
    <div>
      <div className="page-header">
        <h2>Pagamentos</h2>
      </div>
      <p className="page-subtitle">
        Turnos importados, agrupados por colaborador e competência. Clique num colaborador para
        ver os turnos individuais daquele mês.
      </p>

      <div className="card">
        <div className="field-row" style={{ marginBottom: 0, alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <label htmlFor="payments-search">Colaborador</label>
            <div style={{ position: "relative" }}>
              <Search
                size={14}
                style={{ position: "absolute", left: "0.65rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
              />
              <input
                id="payments-search"
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
                setSelectedCompanyIds(new Set());
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedCompanyIds(new Set(companies.map((c) => String(c.id))));
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
                setSelectedClientIds(new Set());
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedClientIds(new Set(clientOptions.map((c) => String(c.id))));
                setPage(0);
              }}
              icon={Users}
              allLabel="Todos os clientes"
              noneLabel="Nenhum cliente"
            />
          </div>
          <div className="field" style={{ flex: "0 1 130px" }}>
            <label htmlFor="payments-competencia-start">De</label>
            <input
              id="payments-competencia-start"
              type="month"
              value={competenciaStart}
              onChange={(e) => {
                setCompetenciaStart(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <div className="field" style={{ flex: "0 1 130px" }}>
            <label htmlFor="payments-competencia-end">Até</label>
            <input
              id="payments-competencia-end"
              type="month"
              value={competenciaEnd}
              onChange={(e) => {
                setCompetenciaEnd(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <div className="field">
            <label>Status</label>
            <MultiSelectDropdown
              options={STATUS_OPTIONS}
              selected={selectedStatuses}
              onToggle={toggleStatus}
              onSelectAll={() => {
                setSelectedStatuses(new Set(STATUS_OPTIONS.map((o) => o.id)));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedStatuses(new Set());
                setPage(0);
              }}
              allLabel="Todos os status"
              noneLabel="Nenhum status"
            />
          </div>
        </div>
      </div>

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && summaries.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum pagamento importado ainda.
          </p>
        )}
        {!loading && summaries.length > 0 && filteredSummaries.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum resultado para os filtros selecionados.
          </p>
        )}
        {filteredSummaries.length > 0 && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>Cliente</th>
                    <th>Empresa</th>
                    <th>Competência</th>
                    <th style={{ textAlign: "right" }}>Turnos</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((s) => (
                    <tr key={`${s.employeeId}-${s.competencia}`}>
                      <td>
                        <div className="person-cell">
                          <span className="avatar" style={{ background: colorForName(s.employeeName) }}>
                            {initials(s.employeeName)}
                          </span>
                          <Link to={`/payments/${s.employeeId}/${s.competencia}`}>{s.employeeName}</Link>
                        </div>
                      </td>
                      <td>{s.clientName}</td>
                      <td>{s.companyName}</td>
                      <td>{formatCompetencia(s.competencia)}</td>
                      <td style={{ textAlign: "right" }}>{s.total}</td>
                      <td>
                        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                          {s.pendente > 0 && <span className="badge warn">{s.pendente} pendente</span>}
                          {s.erro > 0 && <span className="badge file-error">{s.erro} erro</span>}
                          {s.pago > 0 && <span className="badge ok">{s.pago} pago</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {filteredSummaries.length > PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(
                  filteredSummaries.length,
                  page * pageSize + pageSize,
                )} de ${filteredSummaries.length}`}
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
