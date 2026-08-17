import { Building2, Calendar, ListFilter, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ClientRow, CompanyRow } from "../lib/db";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import DateRangePicker from "./DateRangePicker";
import Drawer from "./Drawer";
import EmployeeMultiSelectDropdown from "./EmployeeMultiSelectDropdown";
import MultiSelectDropdown from "./MultiSelectDropdown";

/** Everything the Drawer edits — same shape as the Cartão Ponto page's own applied filters (`useLibraryFilters()`). */
export interface LibraryFiltersValue {
  employeeIds: Set<string>;
  companyIds: Set<string>;
  clientIds: Set<string>;
  periodStart: string;
  periodEnd: string;
  statuses: Set<PeriodStatusId>;
}

/** A field label with its icon in front — same as `PaymentsFiltersDrawer`'s own `FieldLabel`. */
function FieldLabel({ icon: Icon, htmlFor, children }: { icon: typeof Building2; htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
      <Icon size={13} />
      {children}
    </label>
  );
}

/**
 * The "Filtros" side panel for the Cartão Ponto page — same collapsed
 * button + Drawer pattern as `PaymentsFiltersDrawer`, with its own
 * draft-vs-applied dance: draft state is seeded from `value` every time the
 * Drawer transitions to open, and only commits back out via `onApply` once
 * "Aplicar filtros" is clicked (a cancelled edit never leaks in).
 */
export default function LibraryFiltersDrawer({
  open,
  onClose,
  value,
  onApply,
  companies,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  value: LibraryFiltersValue;
  onApply: (next: LibraryFiltersValue) => void;
  companies: CompanyRow[];
  clients: ClientRow[];
}) {
  const [draftEmployeeIds, setDraftEmployeeIds] = useState(value.employeeIds);
  const [draftCompanyIds, setDraftCompanyIds] = useState(value.companyIds);
  const [draftClientIds, setDraftClientIds] = useState(value.clientIds);
  const [draftPeriodStart, setDraftPeriodStart] = useState(value.periodStart);
  const [draftPeriodEnd, setDraftPeriodEnd] = useState(value.periodEnd);
  const [draftStatuses, setDraftStatuses] = useState(value.statuses);

  // Reseed every time the Drawer opens, so a cancelled edit never leaks
  // into the next time it's opened.
  useEffect(() => {
    if (!open) return;
    setDraftEmployeeIds(value.employeeIds);
    setDraftCompanyIds(value.companyIds);
    setDraftClientIds(value.clientIds);
    setDraftPeriodStart(value.periodStart);
    setDraftPeriodEnd(value.periodEnd);
    setDraftStatuses(value.statuses);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const clientOptions = useMemo(() => {
    const scoped = draftCompanyIds.size > 0 ? clients.filter((c) => draftCompanyIds.has(String(c.companyId))) : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, draftCompanyIds]);

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
  }
  function toggleDraftClient(id: string) {
    const next = new Set(draftClientIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftClientIds(next);
  }
  function toggleDraftStatus(id: PeriodStatusId) {
    const next = new Set(draftStatuses);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraftStatuses(next);
  }

  function applyFilters() {
    onApply({
      employeeIds: draftEmployeeIds,
      companyIds: draftCompanyIds,
      clientIds: draftClientIds,
      periodStart: draftPeriodStart,
      periodEnd: draftPeriodEnd,
      statuses: draftStatuses,
    });
  }

  /** Resets every field to its default and applies immediately — unlike every other change in the Drawer, "Limpar filtros" doesn't wait for "Aplicar filtros" since there's no draft of an empty state worth reviewing first. */
  function clearFilters() {
    const cleared: LibraryFiltersValue = {
      employeeIds: new Set(),
      companyIds: new Set(),
      clientIds: new Set(),
      periodStart: "",
      periodEnd: "",
      statuses: new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)),
    };
    setDraftEmployeeIds(cleared.employeeIds);
    setDraftCompanyIds(cleared.companyIds);
    setDraftClientIds(cleared.clientIds);
    setDraftPeriodStart(cleared.periodStart);
    setDraftPeriodEnd(cleared.periodEnd);
    setDraftStatuses(cleared.statuses);
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
      {/* Colaborador alone on a full-width row (same as `PaymentsFiltersDrawer`),
          then Período/Status and Empresa/Cliente paired two-per-row below. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1.1rem" }}>
        <div className="field" style={{ gridColumn: "1 / -1", position: "relative", zIndex: 5 }}>
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
        <div className="field" style={{ position: "relative", zIndex: 4 }}>
          <FieldLabel icon={Calendar}>Período</FieldLabel>
          <DateRangePicker
            startValue={draftPeriodStart}
            endValue={draftPeriodEnd}
            onChange={(start, end) => {
              setDraftPeriodStart(start);
              setDraftPeriodEnd(end);
            }}
            allowClear={false}
            showIcon={false}
            fullWidth
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 3 }}>
          <FieldLabel icon={ListFilter}>Status no período</FieldLabel>
          <MultiSelectDropdown
            options={PERIOD_STATUS_OPTIONS}
            selected={draftStatuses}
            onToggle={toggleDraftStatus}
            onSelectAll={() => setDraftStatuses(new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)))}
            onSelectNone={() => setDraftStatuses(new Set())}
            allLabel="Todos os status"
            noneLabel="Nenhum filtro selecionado"
            countLabel={(n, total) => `${n} de ${total} filtros`}
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 2 }}>
          <FieldLabel icon={Building2}>Empresa</FieldLabel>
          <MultiSelectDropdown
            options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
            selected={draftCompanyIds}
            onToggle={toggleDraftCompany}
            onSelectAll={() => setDraftCompanyIds(new Set(companies.map((c) => String(c.id))))}
            onSelectNone={() => setDraftCompanyIds(new Set())}
            allLabel="Todas as empresas"
            noneLabel="Todas as empresas"
            countLabel={(n, total) => `${n} de ${total} empresas`}
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
        <div className="field" style={{ position: "relative", zIndex: 1 }}>
          <FieldLabel icon={Users}>Cliente</FieldLabel>
          <MultiSelectDropdown
            options={clientOptions.map((c) => ({ id: String(c.id), label: c.name }))}
            selected={draftClientIds}
            onToggle={toggleDraftClient}
            onSelectAll={() => setDraftClientIds(new Set(clientOptions.map((c) => String(c.id))))}
            onSelectNone={() => setDraftClientIds(new Set())}
            allLabel="Todos os clientes"
            noneLabel="Todos os clientes"
            countLabel={(n, total) => `${n} de ${total} clientes`}
            align="left"
            fullWidth
            showIcon={false}
          />
        </div>
      </div>
    </Drawer>
  );
}
