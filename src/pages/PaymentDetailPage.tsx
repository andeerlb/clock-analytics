import { AlertCircle, CheckCircle2, Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import DateRangePicker from "../components/DateRangePicker";
import MultiSelectDropdown, { type MultiSelectOption } from "../components/MultiSelectDropdown";
import { getEmployee, listPaymentShiftsForEmployeeMonth, type EmployeeRow } from "../lib/db";
import { formatDate, formatMinutesAsTime } from "../lib/format";
import type { PaymentShiftRow, PaymentShiftStatus } from "../lib/types";

const STATUS_OPTIONS: MultiSelectOption<PaymentShiftStatus>[] = [
  { id: "pendente", label: "Pendente" },
  { id: "erro", label: "Erro" },
  { id: "pago", label: "Pago" },
];

/** What the Pagamentos list's `<Link state={...}>` hands off — the filters active there when the user clicked into this colaborador/competência, used as this page's own initial filter state (not kept in sync afterwards). */
export interface PaymentDetailNavState {
  statuses: PaymentShiftStatus[];
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
  const [shifts, setShifts] = useState<PaymentShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<PaymentShiftStatus>>(
    () => new Set(navState?.statuses ?? STATUS_OPTIONS.map((o) => o.id)),
  );
  const [periodStart, setPeriodStart] = useState(navState?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(navState?.periodEnd ?? "");

  useEffect(() => {
    if (!competencia || Number.isNaN(id)) return;
    setLoading(true);
    Promise.all([getEmployee(id), listPaymentShiftsForEmployeeMonth(id, competencia)])
      .then(([employeeRow, shiftRows]) => {
        setEmployee(employeeRow);
        setShifts(shiftRows);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, competencia]);

  function toggleStatus(status: PaymentShiftStatus) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const visibleShifts = useMemo(
    () =>
      shifts.filter((s) => {
        if (selectedStatuses.size === 0 || !selectedStatuses.has(s.status)) return false;
        if (periodStart && s.workDate < periodStart) return false;
        if (periodEnd && s.workDate > periodEnd) return false;
        return true;
      }),
    [shifts, selectedStatuses, periodStart, periodEnd],
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
                  <th>Observação</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleShifts.map((s) => {
                  const badge = STATUS_BADGE[s.status];
                  const BadgeIcon = badge.icon;
                  return (
                    <tr key={s.id}>
                      <td>{formatDate(s.workDate)}</td>
                      <td>{s.local}</td>
                      <td>{s.role}</td>
                      <td>
                        {s.scheduleStartMinutes !== null && s.scheduleEndMinutes !== null
                          ? `${formatMinutesAsTime(s.scheduleStartMinutes)} – ${formatMinutesAsTime(s.scheduleEndMinutes)}`
                          : "—"}
                      </td>
                      <td className="muted">{s.note ?? "—"}</td>
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
