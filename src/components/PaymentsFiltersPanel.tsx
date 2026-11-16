import { Briefcase, Building2, Calendar, CalendarDays, Clock3, ListFilter, MapPin, Moon, RotateCcw, Search, Sun, Users } from "lucide-react";
import { useMemo } from "react";
import { usePaymentsFilters } from "../contexts/FiltersContext";
import { colorForName, initials } from "../lib/avatar";
import type { ClientRow, CompanyRow, RoleRow } from "../lib/db";
import { formatCnpj } from "../lib/format";
import type { PaymentShiftStatus, ShiftPeriod } from "../lib/types";
import EmployeeMultiSelectDropdown from "./EmployeeMultiSelectDropdown";
import { Chip, FieldLabel, namesOrCount, periodPresets, periodText, toggled, useSelectedEmployeeNames } from "./LibraryFiltersPanel";
import OptionPicker, { type PickerOption } from "./OptionPicker";
import PeriodPicker, { type PeriodPreset } from "./PeriodPicker";
import ScheduleTimePicker, { scheduleTimeSentence } from "./ScheduleTimePicker";
import SidePanel from "./SidePanel";


/** Pagamentos starts with no period at all, so "Todo o período" leads the shortcuts. */
function paymentsPeriodPresets(): PeriodPreset[] {
  return [{ label: "Todo o período", start: "", end: "" }, ...periodPresets()];
}

const STATUS_CHIPS: { id: PaymentShiftStatus; label: string; color: string }[] = [
  { id: "pendente", label: "Pendente", color: "var(--warning)" },
  { id: "erro", label: "Erro", color: "var(--danger)" },
  { id: "pago", label: "Pago", color: "var(--success)" },
];

/**
 * The Pagamentos filters, applied as soon as they change. On Pagamentos
 * status isn't here (it's the tabs above the table); Conferência, which
 * has no tabs, passes `includeStatus`. `onChange` runs after every change
 * (the page uses it to drop a filter that came from Análises).
 */
function usePaymentsFilterActions(onChange?: () => void, includeStatus = false) {
  const f = usePaymentsFilters();

  function update(apply: () => void) {
    apply();
    f.setPage(0);
    onChange?.();
  }

  // Empty = no filter; anything picked (every option included) is a filter.
  const shiftPeriodFiltered = f.selectedShiftPeriods.size > 0;
  const statusFiltered = includeStatus && f.selectedStatuses.size > 0;
  const activeCount = [
    f.selectedEmployeeIds.size > 0,
    f.selectedCompanyIds.size > 0,
    f.selectedClientIds.size > 0,
    f.selectedRoleIds.size > 0,
    f.selectedLocals.size > 0,
    shiftPeriodFiltered,
    f.scheduleTimeFilter !== null,
    statusFiltered,
  ].filter(Boolean).length;

  return {
    f,
    activeCount,
    shiftPeriodFiltered,
    statusFiltered,
    setStatuses: (ids: Set<PaymentShiftStatus>) => update(() => f.setSelectedStatuses(ids)),
    setEmployees: (ids: Set<string>) => update(() => f.setSelectedEmployeeIds(ids)),
    setCompanies: (ids: Set<string>) =>
      update(() => {
        f.setSelectedCompanyIds(ids);
        f.setSelectedClientIds(new Set());
        f.setSelectedRoleIds(new Set());
      }),
    setClients: (ids: Set<string>) => update(() => f.setSelectedClientIds(ids)),
    setRoles: (ids: Set<string>) => update(() => f.setSelectedRoleIds(ids)),
    setLocals: (ids: Set<string>) => update(() => f.setSelectedLocals(ids)),
    setPeriod: (start: string, end: string) => update(() => f.setPeriod(start, end)),
    setShiftPeriods: (ids: Set<ShiftPeriod>) => update(() => f.setSelectedShiftPeriods(ids)),
    setScheduleTime: (value: typeof f.scheduleTimeFilter) => update(() => f.setScheduleTimeFilter(value)),
    clearAll: () =>
      update(() => {
        f.setSelectedEmployeeIds(new Set());
        f.setSelectedCompanyIds(new Set());
        f.setSelectedClientIds(new Set());
        f.setSelectedRoleIds(new Set());
        f.setSelectedLocals(new Set());
        f.setPeriod("", "");
        f.setSelectedShiftPeriods(new Set());
        f.setScheduleTimeFilter(null);
        if (includeStatus) f.setSelectedStatuses(new Set());
      }),
  };
}

export function usePaymentsActiveFilterCount(includeStatus = false): number {
  return usePaymentsFilterActions(undefined, includeStatus).activeCount;
}

/** The "Filtros" panel of Pagamentos, docked like the one on Cartão Ponto. */
export default function PaymentsFiltersPanel({
  open,
  onClose,
  onChange,
  companies,
  clients,
  roles,
  locals,
  includeStatus = false,
}: {
  open: boolean;
  onClose: () => void;
  onChange?: () => void;
  companies: CompanyRow[];
  clients: ClientRow[];
  roles: RoleRow[];
  locals: string[];
  /** Adds a Status field — for Conferência, which has no status tabs. */
  includeStatus?: boolean;
}) {
  const a = usePaymentsFilterActions(onChange, includeStatus);
  const { f } = a;
  // Recomputed on open, so "Mês atual" follows the date if the app stays open overnight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const presets = useMemo(() => paymentsPeriodPresets(), [open]);

  const scopedClients = useMemo(() => {
    const scoped = f.selectedCompanyIds.size > 0 ? clients.filter((c) => f.selectedCompanyIds.has(String(c.companyId))) : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((x, y) => x.companyName.localeCompare(y.companyName) || x.name.localeCompare(y.name));
  }, [clients, f.selectedCompanyIds]);

  const scopedRoles = useMemo(() => {
    const scoped = f.selectedCompanyIds.size > 0 ? roles.filter((r) => f.selectedCompanyIds.has(String(r.companyId))) : roles;
    return [...scoped].sort((x, y) => x.name.localeCompare(y.name));
  }, [roles, f.selectedCompanyIds]);

  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);

  const companyOptions = useMemo<PickerOption[]>(
    () =>
      [...companies]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((c) => ({ id: String(c.id), label: c.name, meta: c.cnpj ? formatCnpj(c.cnpj) : undefined })),
    [companies],
  );

  const clientOptions = useMemo<PickerOption[]>(() => {
    const grouped = new Set(scopedClients.map((c) => c.companyId)).size > 1;
    return scopedClients.map((c) => ({
      id: String(c.id),
      label: c.name,
      meta: c.cnpj ? formatCnpj(c.cnpj) : undefined,
      group: grouped ? c.companyName : undefined,
    }));
  }, [scopedClients]);

  // Same name can exist under several empresas, so the empresa goes on the second line.
  const roleOptions = useMemo<PickerOption[]>(
    () => scopedRoles.map((r) => ({ id: String(r.id), label: r.name, meta: companyName.get(r.companyId) })),
    [scopedRoles, companyName],
  );

  const localOptions = useMemo<PickerOption[]>(() => [...locals].sort((x, y) => x.localeCompare(y)).map((l) => ({ id: l, label: l })), [locals]);

  // Nothing picked means every status, same as the Cartão Ponto status chips.
  const pickedStatuses = f.selectedStatuses;
  function togglePickedStatus(id: PaymentShiftStatus) {
    a.setStatuses(toggled(f.selectedStatuses, id));
  }

  const pickedShiftPeriods = f.selectedShiftPeriods;
  function toggleShiftPeriod(id: ShiftPeriod) {
    a.setShiftPeriods(toggled(f.selectedShiftPeriods, id));
  }

  const nothingToClear = a.activeCount === 0 && !f.periodStart && !f.periodEnd;

  function clearAction(show: boolean, onClear: () => void) {
    return (
      show && (
        <button type="button" className="field-reset" onClick={onClear}>
          Limpar
        </button>
      )
    );
  }

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="Filtros"
      badge={a.activeCount === 0 ? undefined : `${a.activeCount} ${a.activeCount === 1 ? "ativo" : "ativos"}`}
      footer={
        <button type="button" className="ghost" onClick={a.clearAll} disabled={nothingToClear}>
          <RotateCcw size={13} style={{ marginRight: "0.35rem" }} />
          Limpar filtros
        </button>
      }
    >
      <div className="field" style={{ position: "relative", zIndex: 9 }}>
        <FieldLabel icon={Calendar}>Período</FieldLabel>
        <PeriodPicker start={f.periodStart} end={f.periodEnd} onChange={a.setPeriod} presets={presets} />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 8 }}>
        <FieldLabel icon={Search} action={clearAction(f.selectedEmployeeIds.size > 0, () => a.setEmployees(new Set()))}>
          Colaborador
        </FieldLabel>
        <EmployeeMultiSelectDropdown
          selected={f.selectedEmployeeIds}
          onToggle={(id) => a.setEmployees(toggled(f.selectedEmployeeIds, id))}
          onClear={() => a.setEmployees(new Set())}
          companyIds={f.selectedCompanyIds.size > 0 ? Array.from(f.selectedCompanyIds, Number) : undefined}
          clientIds={f.selectedClientIds.size > 0 ? Array.from(f.selectedClientIds, Number) : undefined}
          align="right"
          fullWidth
          showIcon={false}
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 7 }}>
        <FieldLabel icon={Building2} action={clearAction(f.selectedCompanyIds.size > 0, () => a.setCompanies(new Set()))}>
          Empresa
        </FieldLabel>
        <OptionPicker
          options={companyOptions}
          selected={f.selectedCompanyIds}
          onToggle={(id) => a.setCompanies(toggled(f.selectedCompanyIds, id))}
          onSelectAll={() => a.setCompanies(new Set(companies.map((c) => String(c.id))))}
          onClear={() => a.setCompanies(new Set())}
          title="Empresas"
          allPlaceholder="Todas as empresas"
          searchPlaceholder="Buscar empresa ou CNPJ"
          selectAllLabel="Selecionar todas"
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 6 }}>
        <FieldLabel icon={Users} action={clearAction(f.selectedClientIds.size > 0, () => a.setClients(new Set()))}>
          Cliente
        </FieldLabel>
        <OptionPicker
          options={clientOptions}
          selected={f.selectedClientIds}
          onToggle={(id) => a.setClients(toggled(f.selectedClientIds, id))}
          onSelectAll={() => a.setClients(new Set(scopedClients.map((c) => String(c.id))))}
          onClear={() => a.setClients(new Set())}
          title="Clientes"
          allPlaceholder="Todos os clientes"
          searchPlaceholder="Buscar cliente ou CNPJ"
          selectAllLabel="Selecionar todos"
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 5 }}>
        <FieldLabel icon={Briefcase} action={clearAction(f.selectedRoleIds.size > 0, () => a.setRoles(new Set()))}>
          Função
        </FieldLabel>
        <OptionPicker
          options={roleOptions}
          selected={f.selectedRoleIds}
          onToggle={(id) => a.setRoles(toggled(f.selectedRoleIds, id))}
          onSelectAll={() => a.setRoles(new Set(scopedRoles.map((r) => String(r.id))))}
          onClear={() => a.setRoles(new Set())}
          title="Funções"
          allPlaceholder="Todas as funções"
          searchPlaceholder="Buscar função"
          selectAllLabel="Selecionar todas"
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 4 }}>
        <FieldLabel icon={MapPin} action={clearAction(f.selectedLocals.size > 0, () => a.setLocals(new Set()))}>
          Local
        </FieldLabel>
        <OptionPicker
          options={localOptions}
          selected={f.selectedLocals}
          onToggle={(id) => a.setLocals(toggled(f.selectedLocals, id))}
          onSelectAll={() => a.setLocals(new Set(locals))}
          onClear={() => a.setLocals(new Set())}
          title="Locais"
          allPlaceholder="Todos os locais"
          searchPlaceholder="Buscar local"
          selectAllLabel="Selecionar todos"
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 3 }}>
        <FieldLabel icon={Moon} action={clearAction(a.shiftPeriodFiltered, () => a.setShiftPeriods(new Set()))}>
          Turno
        </FieldLabel>
        <div className="status-chips">
          {(
            [
              { id: "diurno", label: "Diurno", icon: Sun },
              { id: "noturno", label: "Noturno", icon: Moon },
            ] as const
          ).map((p) => (
            <button key={p.id} type="button" className="status-chip" aria-pressed={pickedShiftPeriods.has(p.id)} onClick={() => toggleShiftPeriod(p.id)}>
              <p.icon size={13} />
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field" style={{ position: "relative", zIndex: 2 }}>
        <FieldLabel icon={Clock3} action={clearAction(f.scheduleTimeFilter !== null, () => a.setScheduleTime(null))}>
          Horário
        </FieldLabel>
        <ScheduleTimePicker value={f.scheduleTimeFilter} onChange={a.setScheduleTime} />
      </div>

      {includeStatus && (
        <div className="field" style={{ position: "relative", zIndex: 1 }}>
          <FieldLabel icon={ListFilter} action={clearAction(a.statusFiltered, () => a.setStatuses(new Set()))}>
            Status
          </FieldLabel>
          <div className="status-chips">
            {STATUS_CHIPS.map((s) => (
              <button key={s.id} type="button" className="status-chip" aria-pressed={pickedStatuses.has(s.id)} onClick={() => togglePickedStatus(s.id)}>
                <i style={{ background: s.color }} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </SidePanel>
  );
}

/** The applied Pagamentos filters as chips in the bar; status only with `includeStatus` (on Pagamentos it's the tabs). */
export function PaymentsFilterChips({
  companies,
  clients,
  roles,
  onOpen,
  onChange,
  includeStatus = false,
}: {
  companies: CompanyRow[];
  clients: ClientRow[];
  roles: RoleRow[];
  onOpen: () => void;
  onChange?: () => void;
  includeStatus?: boolean;
}) {
  const a = usePaymentsFilterActions(onChange, includeStatus);
  const { f } = a;
  const employeeNames = useSelectedEmployeeNames(f.selectedEmployeeIds);
  const preset = paymentsPeriodPresets().find((p) => p.start === f.periodStart && p.end === f.periodEnd);
  let periodValue = periodText(f.periodStart, f.periodEnd);
  if (preset) periodValue = preset.start ? `${preset.label} · ${periodValue}` : preset.label;

  let employeeSummary = `${f.selectedEmployeeIds.size} colaboradores`;
  if (employeeNames.length === 1) employeeSummary = employeeNames[0];
  else if (employeeNames.length > 1) employeeSummary = `${employeeNames[0].split(" ")[0]} e mais ${employeeNames.length - 1}`;

  const locals = Array.from(f.selectedLocals);

  return (
    <>
      {/* No period is the default here (every date), so it only shows up, removable, once one is picked. */}
      {(f.periodStart || f.periodEnd) && (
        <Chip lead={<CalendarDays size={14} className="filter-chip-icon" />} value={periodValue} onOpen={onOpen} onRemove={() => a.setPeriod("", "")} />
      )}
      {f.selectedEmployeeIds.size > 0 && (
        <Chip
          lead={
            employeeNames.length > 0 && (
              <span className="filter-chip-stack">
                {employeeNames.slice(0, 3).map((name) => (
                  <span key={name} className="filter-chip-avatar" style={{ background: colorForName(name) }}>
                    {initials(name)}
                  </span>
                ))}
              </span>
            )
          }
          value={employeeSummary}
          onOpen={onOpen}
          onRemove={() => a.setEmployees(new Set())}
        />
      )}
      {f.selectedCompanyIds.size > 0 && <Chip label="Empresa" value={namesOrCount(f.selectedCompanyIds, companies)} onOpen={onOpen} onRemove={() => a.setCompanies(new Set())} />}
      {f.selectedClientIds.size > 0 && <Chip label="Cliente" value={namesOrCount(f.selectedClientIds, clients)} onOpen={onOpen} onRemove={() => a.setClients(new Set())} />}
      {f.selectedRoleIds.size > 0 && <Chip label="Função" value={namesOrCount(f.selectedRoleIds, roles)} onOpen={onOpen} onRemove={() => a.setRoles(new Set())} />}
      {locals.length > 0 && (
        <Chip label="Local" value={locals.length === 1 ? locals[0] : `${locals[0]} e mais ${locals.length - 1}`} onOpen={onOpen} onRemove={() => a.setLocals(new Set())} />
      )}
      {a.shiftPeriodFiltered && (
        <Chip
          label="Turno"
          value={(["diurno", "noturno"] as const)
            .filter((p) => f.selectedShiftPeriods.has(p))
            .map((p) => (p === "diurno" ? "Diurno" : "Noturno"))
            .join(", ")}
          onOpen={onOpen}
          onRemove={() => a.setShiftPeriods(new Set())}
        />
      )}
      {f.scheduleTimeFilter && (
        <Chip
          label="Horário"
          value={scheduleTimeSentence(f.scheduleTimeFilter)}
          onOpen={onOpen}
          onRemove={() => a.setScheduleTime(null)}
        />
      )}
      {a.statusFiltered && (
        <Chip
          label="Status"
          value={STATUS_CHIPS.filter((s) => f.selectedStatuses.has(s.id))
            .map((s) => s.label)
            .join(", ")}
          onOpen={onOpen}
          onRemove={() => a.setStatuses(new Set())}
        />
      )}
    </>
  );
}
