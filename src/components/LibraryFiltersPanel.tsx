import { Building2, Calendar, CalendarDays, ListFilter, RotateCcw, Search, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLibraryFilters } from "../contexts/FiltersContext";
import { colorForName, initials } from "../lib/avatar";
import { addDaysIso, toIso, todayUtc } from "../lib/calendar";
import { countImportsByStatus, getEmployeesByIds, type ClientRow, type CompanyRow } from "../lib/db";
import { formatCnpj, formatDateSlash, formatPersonName } from "../lib/format";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import PeriodPicker, { formatPeriodShort, type PeriodPreset } from "./PeriodPicker";
import EmployeeMultiSelectDropdown from "./EmployeeMultiSelectDropdown";
import OptionPicker, { type PickerOption } from "./OptionPicker";
import SidePanel from "./SidePanel";

const ALL_STATUSES = PERIOD_STATUS_OPTIONS.map((o) => o.id);

/** "Status no período" as chips: what went wrong, then what kind of hours exist. Short labels; the field title already says "no período". */
const STATUS_GROUPS: { label: string; chips: { id: PeriodStatusId; label: string; color: string }[] }[] = [
  {
    label: "Ocorrências",
    chips: [
      { id: "absence", label: "Faltas", color: "var(--danger)" },
      { id: "late", label: "Atrasos", color: "var(--warning)" },
      { id: "pending", label: "Marcação pendente", color: "var(--warning)" },
      { id: "no-punch", label: "Sem marcação", color: "var(--danger)" },
    ],
  },
  {
    label: "Horas",
    chips: [
      { id: "overtime", label: "Horas extras", color: "#60a5fa" },
      { id: "regular", label: "Horas regulares", color: "var(--success)" },
      { id: "interval", label: "Intervalo", color: "var(--success)" },
    ],
  },
];

function monthStart(today: Date, monthsBack: number): string {
  return toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1)));
}

/** Shortcuts inside the Período box. "Mês atual" comes first: it's also the page's default period. */
function periodPresets(): PeriodPreset[] {
  const today = todayUtc();
  const todayIso = toIso(today);
  const lastMonthEnd = toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)));
  return [
    { label: "Mês atual", start: monthStart(today, 0), end: todayIso },
    { label: "Mês passado", start: monthStart(today, 1), end: lastMonthEnd },
    { label: "Últimos 30 dias", start: addDaysIso(todayIso, -29), end: todayIso },
    { label: "Últimos 3 meses", start: monthStart(today, 2), end: todayIso },
    { label: "Este ano", start: toIso(new Date(Date.UTC(today.getUTCFullYear(), 0, 1))), end: todayIso },
  ];
}

function periodText(start: string, end: string): string {
  if (!start && !end) return "Todo o período";
  if (start && end) return formatPeriodShort(start, end);
  return start ? `desde ${formatDateSlash(start)}` : `até ${formatDateSlash(end)}`;
}

function toggled<T>(set: Set<T>, id: T): Set<T> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function FieldLabel({ icon: Icon, children, action }: { icon: typeof Building2; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="field-label-row">
      <label>
        <Icon size={13} />
        {children}
      </label>
      {action}
    </div>
  );
}

/**
 * The Cartão Ponto filters and their summary, read straight from
 * `useLibraryFilters()`: the panel applies every change right away, so
 * there's no draft to keep in sync with what the table shows.
 */
function useLibraryFilterActions() {
  const f = useLibraryFilters();

  function update(apply: () => void) {
    apply();
    f.setPage(0);
  }

  const statusFiltered = f.selectedStatuses.size < ALL_STATUSES.length;
  /** Período isn't counted: it always has a value (the current month by default). */
  const activeCount = [f.selectedEmployeeIds.size > 0, f.selectedCompanyIds.size > 0, f.selectedClientIds.size > 0, statusFiltered].filter(Boolean).length;

  return {
    f,
    activeCount,
    statusFiltered,
    setEmployees: (ids: Set<string>) => update(() => f.setSelectedEmployeeIds(ids)),
    setCompanies: (ids: Set<string>) =>
      update(() => {
        f.setSelectedCompanyIds(ids);
        f.setSelectedClientIds(new Set());
      }),
    setClients: (ids: Set<string>) => update(() => f.setSelectedClientIds(ids)),
    setStatuses: (ids: Set<PeriodStatusId>) => update(() => f.setSelectedStatuses(ids)),
    setPeriod: (start: string, end: string) => update(() => f.setPeriod(start, end)),
    clearAll: () =>
      update(() => {
        f.setSelectedEmployeeIds(new Set());
        f.setSelectedCompanyIds(new Set());
        f.setSelectedClientIds(new Set());
        // Back to the page's default period: an empty period would match no import at all.
        const [currentMonth] = periodPresets();
        f.setPeriod(currentMonth.start, currentMonth.end);
        f.setSelectedStatuses(new Set(ALL_STATUSES));
      }),
  };
}

export function useLibraryActiveFilterCount(): number {
  return useLibraryFilterActions().activeCount;
}

/**
 * The "Filtros" panel of the Cartão Ponto page, docked beside the table
 * like the assistant (see `SidePanel`) instead of a modal Drawer.
 */
export default function LibraryFiltersPanel({
  open,
  onClose,
  companies,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  companies: CompanyRow[];
  clients: ClientRow[];
}) {
  const { f, activeCount, setEmployees, setCompanies, setClients, setStatuses, setPeriod, clearAll } = useLibraryFilterActions();
  // Recomputed on open, so "Mês atual" follows the date if the app stays open overnight.
  const presets = useMemo(() => periodPresets(), [open]);

  const clientOptions = useMemo(() => {
    const scoped = f.selectedCompanyIds.size > 0 ? clients.filter((c) => f.selectedCompanyIds.has(String(c.companyId))) : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.companyName.localeCompare(b.companyName) || a.name.localeCompare(b.name));
  }, [clients, f.selectedCompanyIds]);

  const companyOptions = useMemo<PickerOption[]>(
    () =>
      [...companies]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => {
          const clientCount = new Set(clients.filter((cl) => cl.companyId === c.id).map((cl) => cl.id)).size;
          const cnpj = c.cnpj ? formatCnpj(c.cnpj) : "";
          const count = `${clientCount} ${clientCount === 1 ? "cliente" : "clientes"}`;
          return { id: String(c.id), label: c.name, meta: cnpj ? `${cnpj} · ${count}` : count };
        }),
    [companies, clients],
  );

  // Grouped by empresa only when more than one empresa is in the list.
  const clientPickerOptions = useMemo<PickerOption[]>(() => {
    const grouped = new Set(clientOptions.map((c) => c.companyId)).size > 1;
    return clientOptions.map((c) => ({
      id: String(c.id),
      label: c.name,
      meta: c.cnpj ? formatCnpj(c.cnpj) : undefined,
      group: grouped ? c.companyName : undefined,
    }));
  }, [clientOptions]);

  // The chips work the other way round from the stored filter: nothing
  // picked means every status (no filter), and picking one narrows to it.
  const pickedStatuses = f.selectedStatuses.size === ALL_STATUSES.length ? new Set<PeriodStatusId>() : f.selectedStatuses;
  function togglePickedStatus(id: PeriodStatusId) {
    const next = toggled(pickedStatuses, id);
    setStatuses(next.size === 0 ? new Set(ALL_STATUSES) : next);
  }

  const [statusCounts, setStatusCounts] = useState<Record<PeriodStatusId, number> | null>(null);
  const scopeKey = JSON.stringify([[...f.selectedEmployeeIds], [...f.selectedCompanyIds], [...f.selectedClientIds], f.periodStart, f.periodEnd]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    countImportsByStatus({
      employeeIds: Array.from(f.selectedEmployeeIds, Number),
      companyIds: Array.from(f.selectedCompanyIds, Number),
      clientIds: Array.from(f.selectedClientIds, Number),
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
    })
      .then((counts) => !cancelled && setStatusCounts(counts))
      .catch(() => !cancelled && setStatusCounts(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopeKey]);

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="Filtros"
      badge={activeCount === 0 ? undefined : `${activeCount} ${activeCount === 1 ? "ativo" : "ativos"}`}
      footer={
        <>
          <button type="button" className="ghost" onClick={clearAll} disabled={activeCount === 0 && f.periodStart === presets[0].start && f.periodEnd === presets[0].end}>
            <RotateCcw size={13} style={{ marginRight: "0.35rem" }} />
            Limpar filtros
          </button>
        </>
      }
    >
      <div className="field" style={{ position: "relative", zIndex: 5 }}>
        <FieldLabel icon={Calendar}>Período</FieldLabel>
        <PeriodPicker start={f.periodStart} end={f.periodEnd} onChange={setPeriod} presets={presets} />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 4 }}>
        <FieldLabel
          icon={Search}
          action={
            f.selectedEmployeeIds.size > 0 && (
              <button type="button" className="field-reset" onClick={() => setEmployees(new Set())}>
                Limpar
              </button>
            )
          }
        >
          Colaborador
        </FieldLabel>
        <EmployeeMultiSelectDropdown
          selected={f.selectedEmployeeIds}
          onToggle={(id) => setEmployees(toggled(f.selectedEmployeeIds, id))}
          onClear={() => setEmployees(new Set())}
          companyIds={f.selectedCompanyIds.size > 0 ? Array.from(f.selectedCompanyIds, Number) : undefined}
          clientIds={f.selectedClientIds.size > 0 ? Array.from(f.selectedClientIds, Number) : undefined}
          align="right"
          fullWidth
          showIcon={false}
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 3 }}>
        <FieldLabel
          icon={Building2}
          action={
            f.selectedCompanyIds.size > 0 && (
              <button type="button" className="field-reset" onClick={() => setCompanies(new Set())}>
                Limpar
              </button>
            )
          }
        >
          Empresa
        </FieldLabel>
        <OptionPicker
          options={companyOptions}
          selected={f.selectedCompanyIds}
          onToggle={(id) => setCompanies(toggled(f.selectedCompanyIds, id))}
          onSelectAll={() => setCompanies(new Set(companies.map((c) => String(c.id))))}
          onClear={() => setCompanies(new Set())}
          title="Empresas"
          allPlaceholder="Todas as empresas"
          searchPlaceholder="Buscar empresa ou CNPJ"
          selectAllLabel="Selecionar todas"
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 2 }}>
        <FieldLabel
          icon={Users}
          action={
            f.selectedClientIds.size > 0 && (
              <button type="button" className="field-reset" onClick={() => setClients(new Set())}>
                Limpar
              </button>
            )
          }
        >
          Cliente
        </FieldLabel>
        <OptionPicker
          options={clientPickerOptions}
          selected={f.selectedClientIds}
          onToggle={(id) => setClients(toggled(f.selectedClientIds, id))}
          onSelectAll={() => setClients(new Set(clientOptions.map((c) => String(c.id))))}
          onClear={() => setClients(new Set())}
          title="Clientes"
          allPlaceholder="Todos os clientes"
          searchPlaceholder="Buscar cliente ou CNPJ"
          selectAllLabel="Selecionar todos"
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 1 }}>
        <FieldLabel
          icon={ListFilter}
          action={
            pickedStatuses.size > 0 && (
              <button type="button" className="field-reset" onClick={() => setStatuses(new Set(ALL_STATUSES))}>
                Limpar
              </button>
            )
          }
        >
          O que aconteceu no período
        </FieldLabel>
        {STATUS_GROUPS.map((group) => (
          <div key={group.label} className="status-group">
            <span className="status-group-label">{group.label}</span>
            <div className="status-chips">
              {group.chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="status-chip"
                  aria-pressed={pickedStatuses.has(chip.id)}
                  onClick={() => togglePickedStatus(chip.id)}
                >
                  <i style={{ background: chip.color }} />
                  {chip.label}
                  {statusCounts && <span className="status-chip-count">{statusCounts[chip.id]}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SidePanel>
  );
}

/** One applied filter in the bar: a click opens the panel, the X removes it. */
function Chip({ label, value, lead, onOpen, onRemove }: { label?: string; value: string; lead?: ReactNode; onOpen: () => void; onRemove?: () => void }) {
  return (
    <span className={onRemove ? "filter-chip" : "filter-chip filter-chip-static"}>
      <button type="button" className="filter-chip-open" onClick={onOpen} title="Abrir filtros">
        {lead}
        {label && <span className="filter-chip-label">{label}</span>}
        <span className="filter-chip-value">{value}</span>
      </button>
      {onRemove && (
        <button type="button" className="filter-chip-remove" aria-label={`Remover filtro ${label ?? value}`} onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

function namesOrCount(ids: Set<string>, rows: { id: number; name: string }[]): string {
  const names = rows.filter((r) => ids.has(String(r.id))).map((r) => r.name);
  if (names.length === 0) return String(ids.size);
  return names.length === 1 ? names[0] : `${names[0]} e mais ${names.length - 1}`;
}

/** Names for the selected colaboradores, fetched once per selection, for the chip's initials and summary. */
function useSelectedEmployeeNames(ids: Set<string>): string[] {
  const [names, setNames] = useState<string[]>([]);
  const key = Array.from(ids).sort().join(",");
  useEffect(() => {
    if (ids.size === 0) {
      setNames([]);
      return;
    }
    let cancelled = false;
    getEmployeesByIds(Array.from(ids, Number))
      .then((rows) => {
        if (cancelled) return;
        setNames(rows.map((r) => formatPersonName(r.name)).sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => !cancelled && setNames([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return names;
}

/**
 * The applied filters, in the bar under the page title. Período is always
 * there (it always has a value), the rest only when set. Clearing them all
 * at once lives in the panel ("Limpar filtros"), not here.
 */
export function LibraryFilterChips({ companies, clients, onOpen }: { companies: CompanyRow[]; clients: ClientRow[]; onOpen: () => void }) {
  const { f, statusFiltered, setEmployees, setCompanies, setClients, setStatuses } = useLibraryFilterActions();
  const employeeNames = useSelectedEmployeeNames(f.selectedEmployeeIds);
  const presets = periodPresets();
  const preset = presets.find((p) => p.start === f.periodStart && p.end === f.periodEnd);
  const statusLabels = STATUS_GROUPS.flatMap((g) => g.chips)
    .filter((c) => f.selectedStatuses.has(c.id))
    .map((c) => c.label);

  let employeeSummary = `${f.selectedEmployeeIds.size} colaboradores`;
  if (employeeNames.length === 1) employeeSummary = employeeNames[0];
  else if (employeeNames.length > 1) employeeSummary = `${employeeNames[0].split(" ")[0]} e mais ${employeeNames.length - 1}`;

  return (
    <>
      <Chip
        lead={<CalendarDays size={14} className="filter-chip-icon" />}
        value={preset ? `${preset.label} · ${periodText(f.periodStart, f.periodEnd)}` : periodText(f.periodStart, f.periodEnd)}
        onOpen={onOpen}
      />
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
          onRemove={() => setEmployees(new Set())}
        />
      )}
      {f.selectedCompanyIds.size > 0 && (
        <Chip label="Empresa" value={namesOrCount(f.selectedCompanyIds, companies)} onOpen={onOpen} onRemove={() => setCompanies(new Set())} />
      )}
      {f.selectedClientIds.size > 0 && (
        <Chip label="Cliente" value={namesOrCount(f.selectedClientIds, clients)} onOpen={onOpen} onRemove={() => setClients(new Set())} />
      )}
      {statusFiltered && (
        <Chip
          label="Status"
          value={statusLabels.length <= 2 ? statusLabels.join(", ") : `${statusLabels.length} ocorrências`}
          onOpen={onOpen}
          onRemove={() => setStatuses(new Set(ALL_STATUSES))}
        />
      )}
    </>
  );
}
