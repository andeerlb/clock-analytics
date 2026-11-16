import { Building2, Calendar, ListFilter, RotateCcw, Search, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLibraryFilters } from "../contexts/FiltersContext";
import { toIso, todayUtc } from "../lib/calendar";
import { countImportsByStatus, type ClientRow, type CompanyRow } from "../lib/db";
import { formatCnpj, formatDateSlash } from "../lib/format";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import DateRangePicker from "./DateRangePicker";
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

/** Shortcuts above the date picker. "Mês atual" is also the page's default period. */
function periodPresets(): { label: string; start: string; end: string }[] {
  const today = todayUtc();
  const todayIso = toIso(today);
  const lastMonthEnd = toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)));
  return [
    { label: "Mês atual", start: monthStart(today, 0), end: todayIso },
    { label: "Mês passado", start: monthStart(today, 1), end: lastMonthEnd },
    { label: "Últimos 3 meses", start: monthStart(today, 2), end: todayIso },
  ];
}

function periodText(start: string, end: string): string {
  if (!start && !end) return "Todo o período";
  if (start && end) return `${formatDateSlash(start)} a ${formatDateSlash(end)}`;
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
  total,
}: {
  open: boolean;
  onClose: () => void;
  companies: CompanyRow[];
  clients: ClientRow[];
  /** How many imports the current filters match. */
  total: number | null;
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
      badge={activeCount === 0 ? "nenhum ativo" : `${activeCount} ${activeCount === 1 ? "ativo" : "ativos"}`}
      footer={
        <>
          {total !== null && (
            <span className="side-panel-summary">
              {total} {total === 1 ? "espelho" : "espelhos"}
            </span>
          )}
          <button type="button" className="ghost" onClick={clearAll} disabled={activeCount === 0 && f.periodStart === presets[0].start && f.periodEnd === presets[0].end}>
            <RotateCcw size={13} style={{ marginRight: "0.35rem" }} />
            Limpar filtros
          </button>
        </>
      }
    >
      <div className="field" style={{ position: "relative", zIndex: 5 }}>
        <FieldLabel icon={Calendar}>Período</FieldLabel>
        <div className="period-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className={f.periodStart === p.start && f.periodEnd === p.end ? "period-preset period-preset-active" : "period-preset"}
              onClick={() => setPeriod(p.start, p.end)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <DateRangePicker startValue={f.periodStart} endValue={f.periodEnd} onChange={setPeriod} allowClear={false} showIcon={false} fullWidth />
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
        <span className="status-hint">
          {pickedStatuses.size === 0
            ? "Nenhum marcado: mostra todos os espelhos."
            : pickedStatuses.size === 1
              ? "Mostra os espelhos com esta ocorrência."
              : `Mostra os espelhos com qualquer uma das ${pickedStatuses.size}.`}
        </span>
      </div>
    </SidePanel>
  );
}

function Chip({ label, value, onRemove }: { label: string; value: string; onRemove?: () => void }) {
  return (
    <span className={onRemove ? "filter-chip" : "filter-chip filter-chip-static"}>
      <span className="filter-chip-label">{label}</span>
      {value}
      {onRemove && (
        <button type="button" className="filter-chip-remove" aria-label={`Remover filtro ${label}`} onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function namesOrCount(ids: Set<string>, rows: { id: number; name: string }[], noun: [string, string]): string {
  if (ids.size === 1) {
    const row = rows.find((r) => ids.has(String(r.id)));
    if (row) return row.name;
  }
  return `${ids.size} ${ids.size === 1 ? noun[0] : noun[1]}`;
}

/** The applied filters, shown beside "Filtros" while the panel is closed. */
export function LibraryFilterChips({ companies, clients }: { companies: CompanyRow[]; clients: ClientRow[] }) {
  const { f, statusFiltered, setEmployees, setCompanies, setClients, setStatuses } = useLibraryFilterActions();
  return (
    <div className="filter-chips">
      <Chip label="Período" value={periodText(f.periodStart, f.periodEnd)} />
      {f.selectedEmployeeIds.size > 0 && (
        <Chip
          label="Colaboradores"
          value={String(f.selectedEmployeeIds.size)}
          onRemove={() => setEmployees(new Set())}
        />
      )}
      {f.selectedCompanyIds.size > 0 && (
        <Chip label="Empresa" value={namesOrCount(f.selectedCompanyIds, companies, ["empresa", "empresas"])} onRemove={() => setCompanies(new Set())} />
      )}
      {f.selectedClientIds.size > 0 && (
        <Chip label="Cliente" value={namesOrCount(f.selectedClientIds, clients, ["cliente", "clientes"])} onRemove={() => setClients(new Set())} />
      )}
      {statusFiltered && (
        <Chip
          label="Status"
          value={
            f.selectedStatuses.size === 1
              ? (STATUS_GROUPS.flatMap((g) => g.chips).find((c) => f.selectedStatuses.has(c.id))?.label ?? "1")
              : `${f.selectedStatuses.size} ocorrências`
          }
          onRemove={() => setStatuses(new Set(ALL_STATUSES))}
        />
      )}
    </div>
  );
}
