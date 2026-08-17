import { Briefcase, Building2, Calendar, Clock3, Layers, ListFilter, MapPin, Moon, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ClientRow, CompanyRow, RoleRow } from "../lib/db";
import type { PaymentShiftStatus, ScheduleTimeFilter, ShiftPeriod } from "../lib/types";
import DateRangePicker from "./DateRangePicker";
import Drawer from "./Drawer";
import EmployeeMultiSelectDropdown from "./EmployeeMultiSelectDropdown";
import MultiSelectDropdown, { type MultiSelectOption } from "./MultiSelectDropdown";
import ScheduleTimeFilterDropdown from "./ScheduleTimeFilterDropdown";

export const STATUS_OPTIONS: MultiSelectOption<PaymentShiftStatus>[] = [
  { id: "pendente", label: "Pendente" },
  { id: "erro", label: "Erro" },
  { id: "pago", label: "Pago" },
];

/** A summary row matches once at least one of its shifts falls in a checked bucket — same "at least one" semantics as Status, and the same SQL-side HAVING pattern (see `shiftPeriodSql` in db.ts). */
export const SHIFT_PERIOD_OPTIONS: MultiSelectOption<ShiftPeriod>[] = [
  { id: "diurno", label: "Diurno" },
  { id: "noturno", label: "Noturno" },
];

/** Everything the Drawer edits — shared shape between the Pagamentos page's own applied filters and "Conferência de Pagamentos", which edits the exact same underlying `usePaymentsFilters()` state. */
export interface PaymentsFiltersValue {
  employeeIds: Set<string>;
  companyIds: Set<string>;
  clientIds: Set<string>;
  roleIds: Set<string>;
  locals: Set<string>;
  periodStart: string;
  periodEnd: string;
  statuses: Set<PaymentShiftStatus>;
  shiftPeriods: Set<ShiftPeriod>;
  scheduleTimeFilter: ScheduleTimeFilter | null;
  grouped: boolean;
}

/** A field label with its icon in front — used in the Filtros Drawer, where the icon sits beside the label instead of inside the control below it (unlike this same control's own toolbar usage elsewhere). */
function FieldLabel({ icon: Icon, htmlFor, children }: { icon: typeof Building2; htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
      <Icon size={13} />
      {children}
    </label>
  );
}

/**
 * The "Filtros" side panel shared by the Pagamentos page and "Conferência de
 * Pagamentos" — both edit the same `usePaymentsFilters()` state, just via
 * different callers, so this owns the draft-vs-applied dance itself instead
 * of each caller re-implementing it: draft state is seeded from `value`
 * every time the Drawer transitions to open, and only commits back out via
 * `onApply` once "Aplicar filtros" is clicked (a cancelled edit never
 * leaks in).
 */
export default function PaymentsFiltersDrawer({
  open,
  onClose,
  value,
  onApply,
  companies,
  clients,
  roles,
  locals,
  /** Omit the "Agrupar por colaborador" field for a caller with no grouped/flat concept of its own (e.g. "Conferência de Pagamentos", which always shows a flat list). */
  showGroupedToggle = true,
}: {
  open: boolean;
  onClose: () => void;
  value: PaymentsFiltersValue;
  onApply: (next: PaymentsFiltersValue) => void;
  companies: CompanyRow[];
  clients: ClientRow[];
  roles: RoleRow[];
  locals: string[];
  showGroupedToggle?: boolean;
}) {
  const [draftEmployeeIds, setDraftEmployeeIds] = useState(value.employeeIds);
  const [draftCompanyIds, setDraftCompanyIds] = useState(value.companyIds);
  const [draftClientIds, setDraftClientIds] = useState(value.clientIds);
  const [draftRoleIds, setDraftRoleIds] = useState(value.roleIds);
  const [draftLocals, setDraftLocals] = useState(value.locals);
  const [draftPeriodStart, setDraftPeriodStart] = useState(value.periodStart);
  const [draftPeriodEnd, setDraftPeriodEnd] = useState(value.periodEnd);
  const [draftStatuses, setDraftStatuses] = useState(value.statuses);
  const [draftShiftPeriods, setDraftShiftPeriods] = useState(value.shiftPeriods);
  const [draftScheduleTimeFilter, setDraftScheduleTimeFilter] = useState(value.scheduleTimeFilter);
  const [draftGrouped, setDraftGrouped] = useState(value.grouped);

  // Reseed every time the Drawer opens, so a cancelled edit never leaks
  // into the next time it's opened.
  useEffect(() => {
    if (!open) return;
    setDraftEmployeeIds(value.employeeIds);
    setDraftCompanyIds(value.companyIds);
    setDraftClientIds(value.clientIds);
    setDraftRoleIds(value.roleIds);
    setDraftLocals(value.locals);
    setDraftPeriodStart(value.periodStart);
    setDraftPeriodEnd(value.periodEnd);
    setDraftStatuses(value.statuses);
    setDraftShiftPeriods(value.shiftPeriods);
    setDraftScheduleTimeFilter(value.scheduleTimeFilter);
    setDraftGrouped(value.grouped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const clientOptions = useMemo(() => {
    const scoped = draftCompanyIds.size > 0 ? clients.filter((c) => draftCompanyIds.has(String(c.companyId))) : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, draftCompanyIds]);

  const roleOptions = useMemo(() => {
    const scoped = draftCompanyIds.size > 0 ? roles.filter((r) => draftCompanyIds.has(String(r.companyId))) : roles;
    return [...scoped].sort((a, b) => a.name.localeCompare(b.name));
  }, [roles, draftCompanyIds]);

  function toggleDraftEmployee(id: string) {
    const next = new Set(draftEmployeeIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftEmployeeIds(next);
  }
  function toggleDraftCompany(id: string) {
    const next = new Set(draftCompanyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftCompanyIds(next);
    setDraftClientIds(new Set());
    setDraftRoleIds(new Set());
  }
  function toggleDraftClient(id: string) {
    const next = new Set(draftClientIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftClientIds(next);
  }
  function toggleDraftRole(id: string) {
    const next = new Set(draftRoleIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftRoleIds(next);
  }
  function toggleDraftLocal(id: string) {
    const next = new Set(draftLocals);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftLocals(next);
  }
  function toggleDraftStatus(id: PaymentShiftStatus) {
    const next = new Set(draftStatuses);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftStatuses(next);
  }
  function toggleDraftShiftPeriod(id: ShiftPeriod) {
    const next = new Set(draftShiftPeriods);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftShiftPeriods(next);
  }

  function applyFilters() {
    onApply({
      employeeIds: draftEmployeeIds,
      companyIds: draftCompanyIds,
      clientIds: draftClientIds,
      roleIds: draftRoleIds,
      locals: draftLocals,
      periodStart: draftPeriodStart,
      periodEnd: draftPeriodEnd,
      statuses: draftStatuses,
      shiftPeriods: draftShiftPeriods,
      scheduleTimeFilter: draftScheduleTimeFilter,
      grouped: draftGrouped,
    });
  }

  /** Resets every field to its default and applies immediately — unlike every other change in the Drawer, "Limpar filtros" doesn't wait for "Aplicar filtros" since there's no draft of an empty state worth reviewing first. */
  function clearFilters() {
    const cleared: PaymentsFiltersValue = {
      employeeIds: new Set(),
      companyIds: new Set(),
      clientIds: new Set(),
      roleIds: new Set(),
      locals: new Set(),
      periodStart: "",
      periodEnd: "",
      statuses: new Set(STATUS_OPTIONS.map((o) => o.id)),
      shiftPeriods: new Set(SHIFT_PERIOD_OPTIONS.map((o) => o.id)),
      scheduleTimeFilter: null,
      grouped: false,
    };
    setDraftEmployeeIds(cleared.employeeIds);
    setDraftCompanyIds(cleared.companyIds);
    setDraftClientIds(cleared.clientIds);
    setDraftRoleIds(cleared.roleIds);
    setDraftLocals(cleared.locals);
    setDraftPeriodStart(cleared.periodStart);
    setDraftPeriodEnd(cleared.periodEnd);
    setDraftStatuses(cleared.statuses);
    setDraftShiftPeriods(cleared.shiftPeriods);
    setDraftScheduleTimeFilter(cleared.scheduleTimeFilter);
    setDraftGrouped(cleared.grouped);
    onApply(cleared);
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Filtros"
      footer={
        <>
          <button type="button" onClick={applyFilters}>
            Aplicar filtros
          </button>
          <button type="button" className="ghost" onClick={clearFilters}>
            Limpar filtros
          </button>
        </>
      }
    >
      {/* Two fields per row by default (`auto-fit`/`minmax` collapses to one
          per row only if the panel gets too narrow to fit two) — every
          field's own control is stretched (`fullWidth`) to fill its cell
          instead of sizing to its label text. Colaborador is the one fixed
          exception, always alone on a full-width row, since a name search
          reads oddly sharing a row with an unrelated dropdown. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1.1rem" }}>
        {/* `zIndex` counts down in DOM order (top-to-bottom, left-to-right) —
            every field's popover can extend downward past its own row (e.g.
            Período's two-month calendar is wider than one column, Status's
            checklist is taller than one row), so without this an earlier
            field's open popover gets visually painted over by a *later*
            field's grid cell, which has no z-index of its own to lose to
            (CSS Grid gives every item an implicit stacking level in DOM
            order once any sibling sets an explicit z-index). */}
        <div className="field" style={{ gridColumn: "1 / -1", position: "relative", zIndex: 9 }}>
          <FieldLabel icon={Search}>Colaborador</FieldLabel>
          <EmployeeMultiSelectDropdown
            selected={draftEmployeeIds}
            onToggle={toggleDraftEmployee}
            onClear={() => setDraftEmployeeIds(new Set())}
            companyIds={draftCompanyIds.size > 0 ? Array.from(draftCompanyIds, Number) : undefined}
            clientIds={draftClientIds.size > 0 ? Array.from(draftClientIds, Number) : undefined}
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 8 }}>
          <FieldLabel icon={Calendar}>Período</FieldLabel>
          <DateRangePicker
            startValue={draftPeriodStart}
            endValue={draftPeriodEnd}
            onChange={(start, end) => {
              setDraftPeriodStart(start);
              setDraftPeriodEnd(end);
            }}
            showIcon={false}
            fullWidth
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 7 }}>
          <FieldLabel icon={Building2}>Empresa</FieldLabel>
          <MultiSelectDropdown
            options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
            selected={draftCompanyIds}
            onToggle={toggleDraftCompany}
            onSelectAll={() => setDraftCompanyIds(new Set(companies.map((c) => String(c.id))))}
            onSelectNone={() => setDraftCompanyIds(new Set())}
            allLabel="Todas as empresas"
            noneLabel="Nenhuma empresa"
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 6 }}>
          <FieldLabel icon={Users}>Cliente</FieldLabel>
          <MultiSelectDropdown
            options={clientOptions.map((c) => ({ id: String(c.id), label: c.name }))}
            selected={draftClientIds}
            onToggle={toggleDraftClient}
            onSelectAll={() => setDraftClientIds(new Set(clientOptions.map((c) => String(c.id))))}
            onSelectNone={() => setDraftClientIds(new Set())}
            allLabel="Todos os clientes"
            noneLabel="Nenhum cliente"
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 5 }}>
          <FieldLabel icon={Briefcase}>Função</FieldLabel>
          <MultiSelectDropdown
            options={roleOptions.map((r) => ({ id: String(r.id), label: r.name }))}
            selected={draftRoleIds}
            onToggle={toggleDraftRole}
            onSelectAll={() => setDraftRoleIds(new Set(roleOptions.map((r) => String(r.id))))}
            onSelectNone={() => setDraftRoleIds(new Set())}
            allLabel="Todas as funções"
            noneLabel="Nenhuma função"
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 4 }}>
          <FieldLabel icon={MapPin}>Local</FieldLabel>
          <MultiSelectDropdown
            options={locals.map((l) => ({ id: l, label: l }))}
            selected={draftLocals}
            onToggle={toggleDraftLocal}
            onSelectAll={() => setDraftLocals(new Set(locals))}
            onSelectNone={() => setDraftLocals(new Set())}
            allLabel="Todos os locais"
            noneLabel="Nenhum local"
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 3 }}>
          <FieldLabel icon={Clock3}>Horário</FieldLabel>
          <ScheduleTimeFilterDropdown value={draftScheduleTimeFilter} onChange={setDraftScheduleTimeFilter} align="left" fullWidth showIcon={false} />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 2 }}>
          <FieldLabel icon={Moon}>Diurno/Noturno</FieldLabel>
          <MultiSelectDropdown
            options={SHIFT_PERIOD_OPTIONS}
            selected={draftShiftPeriods}
            onToggle={toggleDraftShiftPeriod}
            onSelectAll={() => setDraftShiftPeriods(new Set(SHIFT_PERIOD_OPTIONS.map((o) => o.id)))}
            onSelectNone={() => setDraftShiftPeriods(new Set())}
            allLabel="Diurno e noturno"
            noneLabel="Nenhum"
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 1 }}>
          <FieldLabel icon={ListFilter}>Status</FieldLabel>
          <MultiSelectDropdown
            options={STATUS_OPTIONS}
            selected={draftStatuses}
            onToggle={toggleDraftStatus}
            onSelectAll={() => setDraftStatuses(new Set(STATUS_OPTIONS.map((o) => o.id)))}
            onSelectNone={() => setDraftStatuses(new Set())}
            allLabel="Todos os status"
            noneLabel="Nenhum status"
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        {showGroupedToggle && (
          <div className="field" style={{ position: "relative", zIndex: 0 }}>
            <FieldLabel icon={Layers}>Exibição</FieldLabel>
            <label className="drawer-checkbox-field">
              <input type="checkbox" checked={draftGrouped} onChange={(e) => setDraftGrouped(e.target.checked)} />
              Agrupar por colaborador
            </label>
          </div>
        )}
      </div>
    </Drawer>
  );
}
