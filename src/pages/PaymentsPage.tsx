import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FileDown,
  FolderOpen,
  History,
  Info,
  Layers,
  Moon,
  Pencil,
  RotateCcw,
  Search,
  ShieldCheck,
  Sun,
  Users,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Avatar from "../components/Avatar";
import ConfirmModal from "../components/ConfirmModal";
import ConfirmPaymentModal from "../components/ConfirmPaymentModal";
import DateRangePicker from "../components/DateRangePicker";
import EditShiftModal, { type EditShiftFields } from "../components/EditShiftModal";
import ExtraColumnsModal from "../components/ExtraColumnsModal";
import MultiSelectDropdown, { type MultiSelectOption } from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import ScheduleTimeFilterDropdown from "../components/ScheduleTimeFilterDropdown";
import ShiftHistoryModal from "../components/ShiftHistoryModal";
import { PAYMENTS_PAGE_SIZE_OPTIONS, usePaymentsFilters } from "../contexts/FiltersContext";
import { revealInFileManager } from "../lib/api";
import {
  editPaymentShift,
  getCompany,
  listClients,
  listCompanies,
  listPaymentShiftSummaries,
  listPaymentShiftsFlat,
  listPaymentShiftsForGroup,
  markPaymentShiftPaid,
  revertPaymentShiftToPending,
  type ClientRow,
  type CompanyDetail,
  type CompanyRow,
  type ListPaymentShiftSummariesQuery,
  type PaymentShiftFlatRow,
  type PaymentShiftGroupRow,
} from "../lib/db";
import { formatCurrencyBRL, formatDate, formatDateTime, formatMinutesAsTime, resolvePaymentValue, shiftDurationMinutes } from "../lib/format";
import { generatePaymentsReportPdf, type PaymentsReportResult } from "../lib/paymentsReport";
import type { PaymentShiftRow, PaymentShiftStatus, PaymentShiftSummaryRow, ShiftPeriod } from "../lib/types";

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

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  pendente: { className: "badge warn", label: "Pendente", icon: Clock3 },
  erro: { className: "badge file-error", label: "Erro", icon: AlertCircle },
  pago: { className: "badge ok", label: "Pago", icon: CheckCircle2 },
};

/** "2026-02" -> "fev/2026" */
function formatCompetencia(competencia: string): string {
  const date = new Date(`${competencia}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function groupKey(employeeId: number, competencia: string): string {
  return `${employeeId}:${competencia}`;
}

/** Where a row action came from — `null` for a flat (desagrupado) row, or the group it's nested under so a mutation can refresh exactly that group plus the summary counts. */
type GroupRef = { employeeId: number; competencia: string } | null;

/**
 * One turno's cells (Data through Ações) — shared between the flat table
 * (which prepends Colaborador/Cliente/Empresa via `identity`) and a grouped
 * row's expanded turno table (no `identity`, since that's already the
 * group's own header). Keeping this as one component instead of two
 * near-identical tables is what let the "editar valor"-only pencil grow
 * into full "editar turno" (Data/Local/Função/Horário/Valor) in one place.
 */
function ShiftRow({
  shift: s,
  companyId,
  groupRef,
  identity,
  company,
  onPay,
  onEdit,
  onRevert,
  onViewHistory,
  onViewExtra,
}: {
  shift: PaymentShiftRow & { shiftPeriod: ShiftPeriod | null };
  companyId: number;
  groupRef: GroupRef;
  identity?: { employeeName: string; companyName: string; clientName: string };
  company: CompanyDetail | null;
  onPay: (shift: PaymentShiftRow, companyId: number, groupRef: GroupRef) => void;
  onEdit: (shift: PaymentShiftRow, companyId: number, groupRef: GroupRef) => void;
  onRevert: (shift: PaymentShiftRow, groupRef: GroupRef) => void;
  onViewHistory: (shiftId: number, companyId: number) => void;
  onViewExtra: (data: Record<string, string>) => void;
}) {
  const badge = STATUS_BADGE[s.status];
  const BadgeIcon = badge.icon;
  const hasSchedule = s.scheduleStartMinutes !== null && s.scheduleEndMinutes !== null;
  const duration = hasSchedule ? shiftDurationMinutes(s.scheduleStartMinutes!, s.scheduleEndMinutes!) : null;
  const value =
    s.amount !== null
      ? s.amount
      : company && duration !== null
        ? resolvePaymentValue(company.valueRules, duration, {
            workDate: s.workDate,
            local: s.local,
            role: s.role,
            scheduleStartMinutes: s.scheduleStartMinutes,
            scheduleEndMinutes: s.scheduleEndMinutes,
          })
        : null;

  return (
    <tr>
      {identity && (
        <>
          <td>
            <div className="person-cell">
              <Avatar name={identity.employeeName} />
              {identity.employeeName}
            </div>
          </td>
          <td>{identity.clientName}</td>
          <td>{identity.companyName}</td>
        </>
      )}
      <td>{formatDate(s.workDate)}</td>
      <td>{s.local}</td>
      <td>{s.role}</td>
      <td>
        {hasSchedule ? (
          <>
            {formatMinutesAsTime(s.scheduleStartMinutes!)} – {formatMinutesAsTime(s.scheduleEndMinutes!)}
            {s.shiftPeriod && (
              <span className={s.shiftPeriod === "noturno" ? "badge info" : "badge neutral"} style={{ marginLeft: "0.5rem" }}>
                {s.shiftPeriod === "noturno" ? <Moon size={12} /> : <Sun size={12} />}
                {s.shiftPeriod === "noturno" ? "Noturno" : "Diurno"}
              </span>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
      <td>{duration !== null ? formatMinutesAsTime(duration) : "—"}</td>
      <td>
        {value !== null ? formatCurrencyBRL(value) : "—"}
        {(s.status === "pendente" || s.status === "erro") && (
          <button
            type="button"
            className="ghost"
            style={{ padding: "0.2rem", marginLeft: "0.4rem" }}
            onClick={() => onEdit(s, companyId, groupRef)}
            title="Editar turno"
          >
            <Pencil size={12} />
          </button>
        )}
      </td>
      <td>
        {s.extraData && Object.keys(s.extraData).length > 0 ? (
          <button
            type="button"
            className="badge neutral"
            style={{ border: "none", cursor: "pointer" }}
            onClick={() => onViewExtra(s.extraData!)}
            title="Ver colunas não mapeadas lidas do arquivo"
          >
            <Info size={12} />
            {Object.keys(s.extraData).length}
          </button>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <span className={badge.className}>
          <BadgeIcon size={13} />
          {badge.label}
        </span>
        {s.editedManually && (
          <span
            className="badge info"
            style={{ marginLeft: "0.4rem" }}
            title="Atualizado manualmente — uma reimportação não sobrescreve este turno enquanto 'Manter registros atualizados manualmente' estiver ativado (Configurações → Zona de risco → Pagamentos)."
          >
            <ShieldCheck size={12} />
          </span>
        )}
        {s.status === "erro" && s.errorMessage && (
          <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.25rem" }}>
            {s.errorMessage}
          </div>
        )}
      </td>
      <td className="muted" style={{ fontSize: "0.8rem" }}>
        {formatDateTime(s.importedAt)}
      </td>
      <td>
        {(s.status === "pendente" || s.status === "erro") && (
          <button type="button" className="secondary" onClick={() => onPay(s, companyId, groupRef)}>
            Fazer pagamento
          </button>
        )}
        {s.status === "pago" && (
          <button type="button" className="ghost" onClick={() => onRevert(s, groupRef)} title="Voltar este turno para pendente">
            <RotateCcw size={13} style={{ marginRight: "0.3rem" }} />
            Voltar para pendente
          </button>
        )}
        {s.previousShiftId !== null && (
          <button
            type="button"
            className="ghost"
            onClick={() => onViewHistory(s.previousShiftId!, companyId)}
            title="Ver histórico de status deste turno"
          >
            <History size={13} style={{ marginRight: "0.3rem" }} />
            Status anterior
          </button>
        )}
      </td>
    </tr>
  );
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
    grouped,
    setGrouped,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaymentsFilters();

  const [summaries, setSummaries] = useState<PaymentShiftSummaryRow[]>([]);
  const [summariesTotal, setSummariesTotal] = useState(0);
  const [flatRows, setFlatRows] = useState<PaymentShiftFlatRow[]>([]);
  const [flatTotal, setFlatTotal] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [revealingPdf, setRevealingPdf] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<PaymentsReportResult | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [groupRows, setGroupRows] = useState<Map<string, PaymentShiftGroupRow[]>>(new Map());
  const [loadingGroups, setLoadingGroups] = useState<Set<string>>(new Set());

  const [companiesById, setCompaniesById] = useState<Map<number, CompanyDetail>>(new Map());
  const fetchedCompanyIds = useRef<Set<number>>(new Set());

  const [payingShift, setPayingShift] = useState<{ shift: PaymentShiftRow; companyId: number; groupRef: GroupRef } | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [revertingShift, setRevertingShift] = useState<{ shift: PaymentShiftRow; groupRef: GroupRef } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [editingShift, setEditingShift] = useState<{ shift: PaymentShiftRow; companyId: number; groupRef: GroupRef } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [viewingHistory, setViewingHistory] = useState<{ shiftId: number; companyId: number } | null>(null);
  const [viewingExtraData, setViewingExtraData] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    Promise.all([listCompanies(), listClients()]).then(([companyRows, clientRows]) => {
      setCompanies(companyRows);
      setClients(clientRows);
    });
  }, []);

  function ensureCompaniesLoaded(ids: number[]) {
    const toFetch = Array.from(new Set(ids)).filter((id) => !fetchedCompanyIds.current.has(id));
    if (toFetch.length === 0) return;
    toFetch.forEach((id) => fetchedCompanyIds.current.add(id));
    Promise.all(toFetch.map((id) => getCompany(id))).then((fetched) => {
      setCompaniesById((prev) => {
        const next = new Map(prev);
        fetched.forEach((c) => next.set(c.id, c));
        return next;
      });
    });
  }

  function baseQuery(): Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize"> {
    return {
      search,
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      statuses: Array.from(selectedStatuses),
      shiftPeriods: Array.from(selectedShiftPeriods),
      scheduleTimeFilter,
    };
  }

  async function refetchFlat() {
    const { rows, total } = await listPaymentShiftsFlat({ ...baseQuery(), page, pageSize });
    setFlatRows(rows);
    setFlatTotal(total);
    ensureCompaniesLoaded(rows.map((r) => r.companyId));
  }

  async function refetchSummaries() {
    const { rows, total } = await listPaymentShiftSummaries({ ...baseQuery(), page, pageSize });
    setSummaries(rows);
    setSummariesTotal(total);
  }

  async function refetchGroup(employeeId: number, competencia: string) {
    const rows = await listPaymentShiftsForGroup(employeeId, competencia, baseQuery());
    setGroupRows((prev) => new Map(prev).set(groupKey(employeeId, competencia), rows));
  }

  // The table itself — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedKeys(new Set());
    setGroupRows(new Map());
    const run = grouped ? refetchSummaries() : refetchFlat();
    run.finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    grouped,
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

  async function afterMutation(groupRef: GroupRef) {
    if (groupRef === null) {
      await refetchFlat();
    } else {
      await Promise.all([refetchSummaries(), refetchGroup(groupRef.employeeId, groupRef.competencia)]);
    }
  }

  function toggleGroup(s: PaymentShiftSummaryRow) {
    const key = groupKey(s.employeeId, s.competencia);
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!groupRows.has(key)) {
      setLoadingGroups((prev) => new Set(prev).add(key));
      listPaymentShiftsForGroup(s.employeeId, s.competencia, baseQuery())
        .then((rows) => {
          setGroupRows((prev) => new Map(prev).set(key, rows));
          ensureCompaniesLoaded([s.companyId]);
        })
        .finally(() => {
          setLoadingGroups((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        });
    }
  }

  async function handleConfirmPayment(amount: number) {
    if (!payingShift) return;
    setPaying(true);
    setPayError(null);
    try {
      await markPaymentShiftPaid(payingShift.shift.id, amount);
      await afterMutation(payingShift.groupRef);
      setPayingShift(null);
    } catch (e) {
      setPayError(String(e instanceof Error ? e.message : e));
    } finally {
      setPaying(false);
    }
  }

  async function handleConfirmRevert() {
    if (!revertingShift) return;
    setReverting(true);
    setRevertError(null);
    try {
      await revertPaymentShiftToPending(revertingShift.shift.id);
      await afterMutation(revertingShift.groupRef);
      setRevertingShift(null);
    } catch (e) {
      setRevertError(String(e instanceof Error ? e.message : e));
    } finally {
      setReverting(false);
    }
  }

  async function handleConfirmEdit(fields: EditShiftFields) {
    if (!editingShift) return;
    setEditing(true);
    setEditError(null);
    try {
      await editPaymentShift(editingShift.shift.id, fields);
      await afterMutation(editingShift.groupRef);
      setEditingShift(null);
    } catch (e) {
      setEditError(String(e instanceof Error ? e.message : e));
    } finally {
      setEditing(false);
    }
  }

  function shiftValueFor(s: PaymentShiftRow, companyId: number): number | null {
    if (s.amount !== null) return s.amount;
    const company = companiesById.get(companyId);
    if (!company || s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(s.scheduleStartMinutes, s.scheduleEndMinutes);
    return resolvePaymentValue(company.valueRules, duration, {
      workDate: s.workDate,
      local: s.local,
      role: s.role,
      scheduleStartMinutes: s.scheduleStartMinutes,
      scheduleEndMinutes: s.scheduleEndMinutes,
    });
  }

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
      const result = await generatePaymentsReportPdf(baseQuery());
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
  const total = grouped ? summariesTotal : flatTotal;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="page-header">
        <h2>Pagamentos</h2>
      </div>
      <p className="page-subtitle">
        {grouped
          ? "Turnos importados, agrupados por colaborador e competência. Clique num colaborador para expandir os turnos individuais daquele mês."
          : "Turnos importados, um turno por linha."}
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

        <div className="field-row" style={{ marginTop: "1rem", marginBottom: 0, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => {
                setGrouped(e.target.checked);
                setPage(0);
              }}
            />
            <Layers size={14} />
            Agrupar por colaborador
          </label>
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
        {loading && (grouped ? summaries.length === 0 : flatRows.length === 0) && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Carregando...
          </p>
        )}
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

        {total > 0 && grouped && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "2rem" }} />
                    <th>Colaborador</th>
                    <th>Cliente</th>
                    <th>Empresa</th>
                    <th>Competência</th>
                    <th style={{ textAlign: "right" }}>Turnos</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => {
                    const key = groupKey(s.employeeId, s.competencia);
                    const isExpanded = expandedKeys.has(key);
                    const rows = groupRows.get(key);
                    const isLoadingGroup = loadingGroups.has(key);
                    return (
                      <Fragment key={key}>
                        <tr style={{ cursor: "pointer" }} onClick={() => toggleGroup(s)}>
                          <td>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          <td>
                            <div className="person-cell">
                              <Avatar name={s.employeeName} />
                              {s.employeeName}
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
                        {isExpanded && (
                          <tr>
                            <td colSpan={7} style={{ padding: 0, background: "var(--surface-container)" }}>
                              {isLoadingGroup && !rows && (
                                <p className="muted" style={{ padding: "1rem" }}>
                                  Carregando turnos...
                                </p>
                              )}
                              {rows && (
                                <div style={{ padding: "0.8rem 1rem" }}>
                                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
                                    {rows.length} de {s.total} turno(s)
                                  </p>
                                  <div className="table-scroll">
                                    <table>
                                      <thead>
                                        <tr>
                                          <th>Data</th>
                                          <th>Local</th>
                                          <th>Função</th>
                                          <th>Horário</th>
                                          <th>Horas trabalhadas</th>
                                          <th>Valor</th>
                                          <th>Extras</th>
                                          <th>Status</th>
                                          <th>Importado em</th>
                                          <th>Ações</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {rows.map((r) => (
                                          <ShiftRow
                                            key={r.id}
                                            shift={r}
                                            companyId={s.companyId}
                                            groupRef={{ employeeId: s.employeeId, competencia: s.competencia }}
                                            company={companiesById.get(s.companyId) ?? null}
                                            onPay={(shift, companyId, groupRef) => setPayingShift({ shift, companyId, groupRef })}
                                            onEdit={(shift, companyId, groupRef) => setEditingShift({ shift, companyId, groupRef })}
                                            onRevert={(shift, groupRef) => setRevertingShift({ shift, groupRef })}
                                            onViewHistory={(shiftId, companyId) => setViewingHistory({ shiftId, companyId })}
                                            onViewExtra={setViewingExtraData}
                                          />
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {total > PAYMENTS_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(total, page * pageSize + pageSize)} de ${total}`}
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

        {total > 0 && !grouped && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>Cliente</th>
                    <th>Empresa</th>
                    <th>Data</th>
                    <th>Local</th>
                    <th>Função</th>
                    <th>Horário</th>
                    <th>Horas trabalhadas</th>
                    <th>Valor</th>
                    <th>Extras</th>
                    <th>Status</th>
                    <th>Importado em</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {flatRows.map((r) => (
                    <ShiftRow
                      key={r.id}
                      shift={r}
                      companyId={r.companyId}
                      groupRef={null}
                      identity={{ employeeName: r.employeeName, companyName: r.companyName, clientName: r.clientName }}
                      company={companiesById.get(r.companyId) ?? null}
                      onPay={(shift, companyId, groupRef) => setPayingShift({ shift, companyId, groupRef })}
                      onEdit={(shift, companyId, groupRef) => setEditingShift({ shift, companyId, groupRef })}
                      onRevert={(shift, groupRef) => setRevertingShift({ shift, groupRef })}
                      onViewHistory={(shiftId, companyId) => setViewingHistory({ shiftId, companyId })}
                      onViewExtra={setViewingExtraData}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {total > PAYMENTS_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(total, page * pageSize + pageSize)} de ${total}`}
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

      {payingShift && (
        <ConfirmPaymentModal
          shift={payingShift.shift}
          suggestedAmount={shiftValueFor(payingShift.shift, payingShift.companyId)}
          busy={paying}
          error={payError}
          onConfirm={handleConfirmPayment}
          onCancel={() => {
            setPayingShift(null);
            setPayError(null);
          }}
        />
      )}

      {revertingShift && (
        <ConfirmModal
          title="Voltar para pendente"
          message={`Isso cria um novo registro com status "Pendente" para ${formatDate(revertingShift.shift.workDate)} · ${revertingShift.shift.local}. O registro pago atual não será alterado, ficando disponível no histórico.`}
          confirmLabel={reverting ? "Revertendo..." : "Voltar para pendente"}
          confirmDisabled={reverting}
          danger={false}
          error={revertError}
          onConfirm={handleConfirmRevert}
          onCancel={() => {
            setRevertingShift(null);
            setRevertError(null);
          }}
        />
      )}

      {editingShift && (
        <EditShiftModal
          shift={editingShift.shift}
          currentValue={shiftValueFor(editingShift.shift, editingShift.companyId)}
          busy={editing}
          error={editError}
          onConfirm={handleConfirmEdit}
          onCancel={() => {
            setEditingShift(null);
            setEditError(null);
          }}
        />
      )}

      <ShiftHistoryModal
        shiftId={viewingHistory?.shiftId ?? null}
        company={viewingHistory ? companiesById.get(viewingHistory.companyId) ?? null : null}
        onClose={() => setViewingHistory(null)}
      />
      <ExtraColumnsModal data={viewingExtraData} onClose={() => setViewingExtraData(null)} />

      <PdfViewerModal
        path={viewerPath}
        title={generatedReport?.title}
        allowDownload={false}
        onClose={() => setViewerPath(null)}
      />
    </div>
  );
}
