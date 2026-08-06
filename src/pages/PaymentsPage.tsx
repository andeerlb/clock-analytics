import { Building2, CheckCircle2, Eye, FileDown, FolderOpen, Moon, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../components/Avatar";
import DateRangePicker from "../components/DateRangePicker";
import MultiSelectDropdown, { type MultiSelectOption } from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import ScheduleTimeFilterDropdown from "../components/ScheduleTimeFilterDropdown";
import { PAYMENTS_PAGE_SIZE_OPTIONS, usePaymentsFilters } from "../contexts/FiltersContext";
import { revealInFileManager } from "../lib/api";
import { listClients, listCompanies, listPaymentShiftSummaries, type ClientRow, type CompanyRow } from "../lib/db";
import { generatePaymentsReportPdf, type PaymentsReportResult } from "../lib/paymentsReport";
import type { PaymentShiftStatus, PaymentShiftSummaryRow, ShiftPeriod } from "../lib/types";
import type { PaymentDetailNavState } from "./PaymentDetailPage";

const STATUS_OPTIONS: MultiSelectOption<PaymentShiftStatus>[] = [
  { id: "pendente", label: "Pendente" },
  { id: "erro", label: "Erro" },
  { id: "pago", label: "Pago" },
];

/** A summary row matches once at least one of its shifts falls in a checked bucket — same "at least one" semantics as Status, and the same SQL-side HAVING pattern (see `shiftPeriodSql` in db.ts). */
const SHIFT_PERIOD_OPTIONS: MultiSelectOption<ShiftPeriod>[] = [
  { id: "diurno", label: "Diurno" },
  { id: "noturno", label: "Noturno" },
];

/** "2026-02" -> "fev/2026" */
function formatCompetencia(competencia: string): string {
  const date = new Date(`${competencia}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export default function PaymentsPage() {
  const {
    search,
    setSearch,
    selectedCompanyIds,
    setSelectedCompanyIds,
    selectedClientIds,
    setSelectedClientIds,
    periodStart,
    periodEnd,
    setPeriod,
    selectedStatuses,
    setSelectedStatuses,
    selectedShiftPeriods,
    setSelectedShiftPeriods,
    scheduleTimeFilter,
    setScheduleTimeFilter,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaymentsFilters();

  const [summaries, setSummaries] = useState<PaymentShiftSummaryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [revealingPdf, setRevealingPdf] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<PaymentsReportResult | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listCompanies(), listClients()]).then(([companyRows, clientRows]) => {
      setCompanies(companyRows);
      setClients(clientRows);
    });
  }, []);

  // The table itself — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listPaymentShiftSummaries({
      search,
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      statuses: Array.from(selectedStatuses),
      shiftPeriods: Array.from(selectedShiftPeriods),
      scheduleTimeFilter,
      page,
      pageSize,
    })
      .then(({ rows, total: rowTotal }) => {
        if (cancelled) return;
        setSummaries(rows);
        setTotal(rowTotal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    search,
    selectedCompanyIds,
    selectedClientIds,
    periodStart,
    periodEnd,
    selectedStatuses,
    selectedShiftPeriods,
    scheduleTimeFilter,
    page,
    pageSize,
  ]);

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
  function toggleShiftPeriod(id: ShiftPeriod) {
    const next = new Set(selectedShiftPeriods);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedShiftPeriods(next);
    setPage(0);
  }

  /** Every turno matching the current filters, not just the visible page — see `generatePaymentsReportPdf`. */
  async function handleGeneratePdf() {
    setPdfError(null);
    setGeneratedReport(null);
    setGeneratingPdf(true);
    try {
      const result = await generatePaymentsReportPdf({
        search,
        companyIds: Array.from(selectedCompanyIds, Number),
        clientIds: Array.from(selectedClientIds, Number),
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        statuses: Array.from(selectedStatuses),
        shiftPeriods: Array.from(selectedShiftPeriods),
        scheduleTimeFilter,
      });
      if (result.rowCount === 0) {
        setPdfError("Nenhum turno para os filtros selecionados.");
      } else if (result.path) {
        // `path === null` with rows > 0 means the user cancelled the save
        // dialog — nothing to show, same as LibraryPage's "Gerar zip".
        setGeneratedReport(result);
      }
    } catch (e) {
      setPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function handleRevealPdf() {
    if (!generatedReport?.path) return;
    setRevealingPdf(true);
    try {
      await revealInFileManager(generatedReport.path);
    } catch (e) {
      setPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setRevealingPdf(false);
    }
  }

  const hasFilters = Boolean(
    search.trim() ||
      selectedCompanyIds.size > 0 ||
      selectedClientIds.size > 0 ||
      periodStart ||
      periodEnd ||
      selectedStatuses.size < STATUS_OPTIONS.length ||
      selectedShiftPeriods.size < SHIFT_PERIOD_OPTIONS.length ||
      scheduleTimeFilter !== null,
  );
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Handed to the detail page via `<Link state={...}>` so its own Status,
  // Diurno/Noturno, and Horário filters start matching whatever was active
  // here, instead of always resetting to "todos" — see `PaymentDetailNavState`.
  const detailNavState: PaymentDetailNavState = {
    statuses: Array.from(selectedStatuses),
    shiftPeriods: Array.from(selectedShiftPeriods),
    scheduleTimeFilter,
    periodStart,
    periodEnd,
  };

  return (
    <div>
      <div className="page-header">
        <h2>Pagamentos</h2>
      </div>
      <p className="page-subtitle">
        Turnos importados, agrupados por colaborador e competência. Clique num colaborador para
        ver os turnos individuais daquele mês.
      </p>
      {pdfError && <div className="error-box">{pdfError}</div>}

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
          <div className="field">
            <label>Período</label>
            <DateRangePicker
              startValue={periodStart}
              endValue={periodEnd}
              onChange={(start, end) => {
                setPeriod(start, end);
                setPage(0);
              }}
            />
          </div>
          <div className="field">
            <label>Horário</label>
            <ScheduleTimeFilterDropdown value={scheduleTimeFilter} onChange={setScheduleTimeFilter} />
          </div>
          <div className="field">
            <label>Diurno/Noturno</label>
            <MultiSelectDropdown
              options={SHIFT_PERIOD_OPTIONS}
              selected={selectedShiftPeriods}
              onToggle={toggleShiftPeriod}
              onSelectAll={() => {
                setSelectedShiftPeriods(new Set(SHIFT_PERIOD_OPTIONS.map((o) => o.id)));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedShiftPeriods(new Set());
                setPage(0);
              }}
              icon={Moon}
              allLabel="Diurno e noturno"
              noneLabel="Nenhum"
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

        <div className="field-row" style={{ marginTop: "1rem", marginBottom: 0 }}>
          <button
            type="button"
            style={{ marginLeft: "auto" }}
            onClick={handleGeneratePdf}
            disabled={generatingPdf}
            title="Considera os filtros acima"
          >
            <FileDown size={15} style={{ marginRight: "0.4rem" }} />
            {generatingPdf ? "Gerando..." : "Gerar PDF"}
          </button>
        </div>

        {generatedReport && generatedReport.path && (
          <div
            className="success-box"
            style={{
              marginTop: "1rem",
              marginBottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <CheckCircle2 size={16} />
              PDF gerado com sucesso: {generatedReport.title} ({generatedReport.rowCount} turno(s))
            </span>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" className="outline" onClick={() => setViewerPath(generatedReport.path)}>
                <Eye size={15} style={{ marginRight: "0.4rem" }} />
                Abrir PDF
              </button>
              <button type="button" className="outline" onClick={handleRevealPdf} disabled={revealingPdf}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                Abrir no explorador
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card table-card">
        {loading && summaries.length === 0 && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && total === 0 && !hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum pagamento importado ainda.
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
                    <th>Cliente</th>
                    <th>Empresa</th>
                    <th>Competência</th>
                    <th style={{ textAlign: "right" }}>Turnos</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => (
                    <tr key={`${s.employeeId}-${s.competencia}`}>
                      <td>
                        <div className="person-cell">
                          <Avatar name={s.employeeName} />
                          <Link to={`/payments/${s.employeeId}/${s.competencia}`} state={detailNavState}>
                            {s.employeeName}
                          </Link>
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

            {total > PAYMENTS_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(
                  total,
                  page * pageSize + pageSize,
                )} de ${total}`}
                pageSize={pageSize}
                pageSizeOptions={PAYMENTS_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
              />
            )}
          </>
        )}
      </div>

      <PdfViewerModal
        path={viewerPath}
        title={generatedReport?.title}
        allowDownload={false}
        onClose={() => setViewerPath(null)}
      />
    </div>
  );
}
