import { Building2, Calendar, ListFilter, RotateCcw, Search, Users, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useLibraryFilters } from "../contexts/FiltersContext";
import { toIso, todayUtc } from "../lib/calendar";
import type { ClientRow, CompanyRow } from "../lib/db";
import { formatDateSlash } from "../lib/format";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import DateRangePicker from "./DateRangePicker";
import EmployeeMultiSelectDropdown from "./EmployeeMultiSelectDropdown";
import MultiSelectDropdown from "./MultiSelectDropdown";
import SidePanel from "./SidePanel";

const ALL_STATUSES = PERIOD_STATUS_OPTIONS.map((o) => o.id);

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
        f.setPeriod("", "");
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
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, f.selectedCompanyIds]);

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
          <button type="button" className="ghost" onClick={clearAll} disabled={activeCount === 0 && !f.periodStart && !f.periodEnd}>
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
        <FieldLabel icon={Building2}>Empresa</FieldLabel>
        <MultiSelectDropdown
          options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
          selected={f.selectedCompanyIds}
          onToggle={(id) => setCompanies(toggled(f.selectedCompanyIds, id))}
          onSelectAll={() => setCompanies(new Set(companies.map((c) => String(c.id))))}
          onSelectNone={() => setCompanies(new Set())}
          allLabel="Todas as empresas"
          noneLabel="Todas as empresas"
          countLabel={(n, total) => `${n} de ${total} empresas`}
          align="right"
          fullWidth
          showIcon={false}
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 2 }}>
        <FieldLabel icon={Users}>Cliente</FieldLabel>
        <MultiSelectDropdown
          options={clientOptions.map((c) => ({ id: String(c.id), label: c.name }))}
          selected={f.selectedClientIds}
          onToggle={(id) => setClients(toggled(f.selectedClientIds, id))}
          onSelectAll={() => setClients(new Set(clientOptions.map((c) => String(c.id))))}
          onSelectNone={() => setClients(new Set())}
          allLabel="Todos os clientes"
          noneLabel="Todos os clientes"
          countLabel={(n, total) => `${n} de ${total} clientes`}
          align="right"
          fullWidth
          showIcon={false}
        />
      </div>

      <div className="field" style={{ position: "relative", zIndex: 1 }}>
        <FieldLabel
          icon={ListFilter}
          action={
            f.selectedStatuses.size < ALL_STATUSES.length && (
              <button type="button" className="field-reset" onClick={() => setStatuses(new Set(ALL_STATUSES))}>
                Marcar todos
              </button>
            )
          }
        >
          Status no período
        </FieldLabel>
        <div className="status-checks">
          {PERIOD_STATUS_OPTIONS.map((o) => (
            <label key={o.id} className="status-check">
              <input type="checkbox" checked={f.selectedStatuses.has(o.id)} onChange={() => setStatuses(toggled(f.selectedStatuses, o.id))} />
              {o.label}
            </label>
          ))}
        </div>
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
          value={`${f.selectedStatuses.size} de ${ALL_STATUSES.length}`}
          onRemove={() => setStatuses(new Set(ALL_STATUSES))}
        />
      )}
    </div>
  );
}
