import { AlertCircle, CheckCircle2, Clock3, History, Info, Moon, Pencil, RotateCcw, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import ConfirmPaymentModal from "../components/ConfirmPaymentModal";
import DateRangePicker from "../components/DateRangePicker";
import EditShiftValueModal from "../components/EditShiftValueModal";
import ExtraColumnsModal from "../components/ExtraColumnsModal";
import MultiSelectDropdown, { type MultiSelectOption } from "../components/MultiSelectDropdown";
import ScheduleTimeFilterDropdown from "../components/ScheduleTimeFilterDropdown";
import ShiftHistoryModal from "../components/ShiftHistoryModal";
import {
  editPaymentShiftValue,
  getCompany,
  getEmployee,
  listPaymentShiftsForEmployeeMonth,
  markPaymentShiftPaid,
  revertPaymentShiftToPending,
  type CompanyDetail,
  type EmployeeRow,
} from "../lib/db";
import {
  classifyShiftPeriod,
  formatCurrencyBRL,
  formatDate,
  formatDateTime,
  formatMinutesAsTime,
  parseTimeToMinutes,
  resolvePaymentValue,
  shiftDurationMinutes,
} from "../lib/format";
import type { PaymentShiftRow, PaymentShiftStatus, ScheduleTimeFilter, ShiftPeriod } from "../lib/types";

const STATUS_OPTIONS: MultiSelectOption<PaymentShiftStatus>[] = [
  { id: "pendente", label: "Pendente" },
  { id: "erro", label: "Erro" },
  { id: "pago", label: "Pago" },
];

const SHIFT_PERIOD_OPTIONS: MultiSelectOption<ShiftPeriod>[] = [
  { id: "diurno", label: "Diurno" },
  { id: "noturno", label: "Noturno" },
];

/** What the Pagamentos list's `<Link state={...}>` hands off — the filters active there when the user clicked into this colaborador/competência, used as this page's own initial filter state (not kept in sync afterwards). */
export interface PaymentDetailNavState {
  statuses: PaymentShiftStatus[];
  shiftPeriods: ShiftPeriod[];
  scheduleTimeFilter: ScheduleTimeFilter | null;
  periodStart: string;
  periodEnd: string;
}

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  pendente: { className: "badge warn", label: "Pendente", icon: Clock3 },
  erro: { className: "badge file-error", label: "Erro", icon: AlertCircle },
  pago: { className: "badge ok", label: "Pago", icon: CheckCircle2 },
};

/** "2026-02" -> "fevereiro de 2026" */
function formatCompetenciaLong(competencia: string): string {
  const date = new Date(`${competencia}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export default function PaymentDetailPage() {
  const { employeeId, competencia } = useParams<{ employeeId: string; competencia: string }>();
  const location = useLocation();
  // Only used as the initial value below — once here, each filter is this
  // page's own, independently adjustable from that point on.
  const navState = location.state as PaymentDetailNavState | null;
  const id = Number(employeeId);

  const [employee, setEmployee] = useState<EmployeeRow | null>(null);
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [shifts, setShifts] = useState<PaymentShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<PaymentShiftStatus>>(
    () => new Set(navState?.statuses ?? STATUS_OPTIONS.map((o) => o.id)),
  );
  const [selectedShiftPeriods, setSelectedShiftPeriods] = useState<Set<ShiftPeriod>>(
    () => new Set(navState?.shiftPeriods ?? SHIFT_PERIOD_OPTIONS.map((o) => o.id)),
  );
  const [scheduleTimeFilter, setScheduleTimeFilter] = useState<ScheduleTimeFilter | null>(
    navState?.scheduleTimeFilter ?? null,
  );
  const [periodStart, setPeriodStart] = useState(navState?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(navState?.periodEnd ?? "");
  const [payingShift, setPayingShift] = useState<PaymentShiftRow | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [revertingShift, setRevertingShift] = useState<PaymentShiftRow | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [editingValueShift, setEditingValueShift] = useState<PaymentShiftRow | null>(null);
  const [editingValue, setEditingValue] = useState(false);
  const [editValueError, setEditValueError] = useState<string | null>(null);
  const [viewingHistoryId, setViewingHistoryId] = useState<number | null>(null);
  const [viewingExtraData, setViewingExtraData] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (!competencia || Number.isNaN(id)) return;
    setLoading(true);
    Promise.all([getEmployee(id), listPaymentShiftsForEmployeeMonth(id, competencia)])
      .then(async ([employeeRow, shiftRows]) => {
        setEmployee(employeeRow);
        setShifts(shiftRows);
        setCompany(await getCompany(employeeRow.companyId));
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, competencia]);

  async function handleConfirmPayment(amount: number) {
    if (!payingShift || !competencia) return;
    setPaying(true);
    setPayError(null);
    try {
      await markPaymentShiftPaid(payingShift.id, amount);
      setShifts(await listPaymentShiftsForEmployeeMonth(id, competencia));
      setPayingShift(null);
    } catch (e) {
      setPayError(String(e instanceof Error ? e.message : e));
    } finally {
      setPaying(false);
    }
  }

  async function handleConfirmRevert() {
    if (!revertingShift || !competencia) return;
    setReverting(true);
    setRevertError(null);
    try {
      await revertPaymentShiftToPending(revertingShift.id);
      setShifts(await listPaymentShiftsForEmployeeMonth(id, competencia));
      setRevertingShift(null);
    } catch (e) {
      setRevertError(String(e instanceof Error ? e.message : e));
    } finally {
      setReverting(false);
    }
  }

  async function handleConfirmEditValue(amount: number) {
    if (!editingValueShift || !competencia) return;
    setEditingValue(true);
    setEditValueError(null);
    try {
      await editPaymentShiftValue(editingValueShift.id, amount);
      setShifts(await listPaymentShiftsForEmployeeMonth(id, competencia));
      setEditingValueShift(null);
    } catch (e) {
      setEditValueError(String(e instanceof Error ? e.message : e));
    } finally {
      setEditingValue(false);
    }
  }

  function toggleStatus(status: PaymentShiftStatus) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function toggleShiftPeriod(period: ShiftPeriod) {
    setSelectedShiftPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(period)) next.delete(period);
      else next.add(period);
      return next;
    });
  }

  /** `null` when there's no company loaded yet, no schedule on this shift, or the company's night times don't parse. */
  function shiftPeriod(s: PaymentShiftRow): "diurno" | "noturno" | null {
    if (!company || s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
    const nightStart = parseTimeToMinutes(company.nightStartTime);
    const nightEnd = parseTimeToMinutes(company.nightEndTime);
    if (nightStart === null || nightEnd === null) return null;
    return classifyShiftPeriod(company.nightShiftRule, nightStart, nightEnd, s.scheduleStartMinutes, s.scheduleEndMinutes);
  }

  /**
   * A `pago` row's Valor is whatever was confirmed at payment time — frozen
   * forever in `s.amount`, never recomputed even if the company's rules
   * change later. Every other status has no stored amount yet, so this
   * falls back to a live estimate from the company's current rules (`null`
   * when there's no schedule on the shift, or no matching rule — shown as
   * "—", not R$ 0,00).
   */
  function shiftValue(s: PaymentShiftRow): number | null {
    if (s.amount !== null) return s.amount;
    if (!company || s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(s.scheduleStartMinutes, s.scheduleEndMinutes);
    return resolvePaymentValue(company.valueRules, duration);
  }

  /** Same rule as `scheduleTimeConditionSql` in db.ts: a shift with no parsed horário never matches. */
  function matchesScheduleTime(s: PaymentShiftRow, filter: ScheduleTimeFilter): boolean {
    const referenceMinutes = parseTimeToMinutes(filter.time);
    if (referenceMinutes === null) return true;
    const field = filter.rule.startsWith("start") ? s.scheduleStartMinutes : s.scheduleEndMinutes;
    if (field === null) return false;
    return filter.rule.endsWith("before") ? field < referenceMinutes : field > referenceMinutes;
  }

  const visibleShifts = useMemo(
    () =>
      shifts.filter((s) => {
        if (selectedStatuses.size === 0 || !selectedStatuses.has(s.status)) return false;
        if (periodStart && s.workDate < periodStart) return false;
        if (periodEnd && s.workDate > periodEnd) return false;
        // Only filter by Diurno/Noturno once it's narrowed below "both" — a
        // shift whose period can't be classified (no schedule, or company
        // night-rule missing) is excluded whenever it is, same as the SQL
        // HAVING clause the list screen filters with.
        if (selectedShiftPeriods.size < SHIFT_PERIOD_OPTIONS.length) {
          const period = shiftPeriod(s);
          if (period === null || !selectedShiftPeriods.has(period)) return false;
        }
        if (scheduleTimeFilter && !matchesScheduleTime(s, scheduleTimeFilter)) return false;
        return true;
      }),
    [shifts, selectedStatuses, selectedShiftPeriods, scheduleTimeFilter, periodStart, periodEnd, company],
  );

  if (loading) {
    return (
      <div>
        <BackButton fallback="/payments" />
        <p className="muted">Carregando...</p>
      </div>
    );
  }

  if (error || !employee || !competencia) {
    return (
      <div>
        <BackButton fallback="/payments" />
        <div className="error-box">{error ?? "Colaborador ou competência não encontrados."}</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/payments" />
        <h2 style={{ margin: 0 }}>
          Pagamentos — {employee.name} · {formatCompetenciaLong(competencia)}
        </h2>
      </div>
      <p className="page-subtitle">
        {employee.clientName} · {employee.companyName}
      </p>

      <div className="card card-flush">
        <div className="page-header" style={{ marginBottom: 0, alignItems: "center" }}>
          <span className="muted">{visibleShifts.length} de {shifts.length} turno(s)</span>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <DateRangePicker
              startValue={periodStart}
              endValue={periodEnd}
              onChange={(start, end) => {
                setPeriodStart(start);
                setPeriodEnd(end);
              }}
            />
            <ScheduleTimeFilterDropdown value={scheduleTimeFilter} onChange={setScheduleTimeFilter} />
            <MultiSelectDropdown
              options={SHIFT_PERIOD_OPTIONS}
              selected={selectedShiftPeriods}
              onToggle={toggleShiftPeriod}
              onSelectAll={() => setSelectedShiftPeriods(new Set(SHIFT_PERIOD_OPTIONS.map((o) => o.id)))}
              onSelectNone={() => setSelectedShiftPeriods(new Set())}
              icon={Moon}
              allLabel="Diurno e noturno"
              noneLabel="Nenhum"
            />
            <MultiSelectDropdown
              options={STATUS_OPTIONS}
              selected={selectedStatuses}
              onToggle={toggleStatus}
              onSelectAll={() => setSelectedStatuses(new Set(STATUS_OPTIONS.map((o) => o.id)))}
              onSelectNone={() => setSelectedStatuses(new Set())}
              allLabel="Todos os status"
              noneLabel="Nenhum status"
            />
          </div>
        </div>
      </div>

      <div className="card table-card">
        {shifts.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum turno importado para este colaborador nesta competência.
          </p>
        )}
        {shifts.length > 0 && visibleShifts.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum turno com os status selecionados.
          </p>
        )}
        {visibleShifts.length > 0 && (
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
                {visibleShifts.map((s) => {
                  const badge = STATUS_BADGE[s.status];
                  const BadgeIcon = badge.icon;
                  const period = shiftPeriod(s);
                  const hasSchedule = s.scheduleStartMinutes !== null && s.scheduleEndMinutes !== null;
                  const value = shiftValue(s);
                  return (
                    <tr key={s.id}>
                      <td>{formatDate(s.workDate)}</td>
                      <td>{s.local}</td>
                      <td>{s.role}</td>
                      <td>
                        {hasSchedule ? (
                          <>
                            {formatMinutesAsTime(s.scheduleStartMinutes!)} – {formatMinutesAsTime(s.scheduleEndMinutes!)}
                            {period && (
                              <span className={period === "noturno" ? "badge info" : "badge neutral"} style={{ marginLeft: "0.5rem" }}>
                                {period === "noturno" ? <Moon size={12} /> : <Sun size={12} />}
                                {period === "noturno" ? "Noturno" : "Diurno"}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {hasSchedule
                          ? formatMinutesAsTime(shiftDurationMinutes(s.scheduleStartMinutes!, s.scheduleEndMinutes!))
                          : "—"}
                      </td>
                      <td>
                        {value !== null ? formatCurrencyBRL(value) : "—"}
                        {(s.status === "pendente" || s.status === "erro") && (
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.2rem", marginLeft: "0.4rem" }}
                            onClick={() => setEditingValueShift(s)}
                            title="Editar valor"
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
                            onClick={() => setViewingExtraData(s.extraData)}
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
                          <button type="button" className="secondary" onClick={() => setPayingShift(s)}>
                            Fazer pagamento
                          </button>
                        )}
                        {s.status === "pago" && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => setRevertingShift(s)}
                            title="Voltar este turno para pendente"
                          >
                            <RotateCcw size={13} style={{ marginRight: "0.3rem" }} />
                            Voltar para pendente
                          </button>
                        )}
                        {s.previousShiftId !== null && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => setViewingHistoryId(s.previousShiftId)}
                            title="Ver histórico de status deste turno"
                          >
                            <History size={13} style={{ marginRight: "0.3rem" }} />
                            Status anterior
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {payingShift && (
        <ConfirmPaymentModal
          shift={payingShift}
          suggestedAmount={shiftValue(payingShift)}
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
          message={`Isso cria um novo registro com status "Pendente" para ${formatDate(revertingShift.workDate)} · ${revertingShift.local}. O registro pago atual não será alterado, ficando disponível no histórico.`}
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

      {editingValueShift && (
        <EditShiftValueModal
          shift={editingValueShift}
          currentValue={shiftValue(editingValueShift)}
          busy={editingValue}
          error={editValueError}
          onConfirm={handleConfirmEditValue}
          onCancel={() => {
            setEditingValueShift(null);
            setEditValueError(null);
          }}
        />
      )}

      <ShiftHistoryModal shiftId={viewingHistoryId} company={company} onClose={() => setViewingHistoryId(null)} />
      <ExtraColumnsModal data={viewingExtraData} onClose={() => setViewingExtraData(null)} />
    </div>
  );
}
