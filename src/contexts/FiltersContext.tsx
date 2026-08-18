import { emitTo, listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { toIso, todayUtc } from "../lib/calendar";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import type { PaymentShiftStatus, ScheduleTimeFilter, ShiftPeriod } from "../lib/types";

/** Default period on load: the current calendar month so far — never empty. */
function defaultPeriodStart(): string {
  const today = todayUtc();
  return toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

export const LIBRARY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
export const PAYMENTS_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const PAYMENT_SHIFT_STATUSES: PaymentShiftStatus[] = ["pendente", "erro", "pago"];
const SHIFT_PERIODS: ShiftPeriod[] = ["diurno", "noturno"];

/**
 * One-time filter handshake for "Destacar" on "Conferência de Pagamentos"
 * (see `commands::open_reconciliation_window`): the detached window is a
 * brand-new React tree with its own `FiltersProvider`, so it can't just
 * read the main window's live `usePaymentsFilters()` state — it asks for a
 * snapshot instead, right after it mounts. `RECONCILIATION_WINDOW_LABEL`
 * matches the label `open_reconciliation_window` gives that window in Rust.
 */
export const MAIN_WINDOW_LABEL = "main";
export const RECONCILIATION_WINDOW_LABEL = "reconciliation";
export const RECONCILIATION_WINDOW_READY_EVENT = "reconciliation-window-ready";
export const SEED_PAYMENTS_FILTERS_EVENT = "seed-payments-filters";

/**
 * "Anexar" on the detached window — the reverse handshake:
 * `PaymentReconciliationWindowPage` emits this (targeted at
 * `MAIN_WINDOW_LABEL`) carrying its own current filters, then closes
 * itself; `ReconciliationModalProvider` (mounted once in `App.tsx`'s
 * shell) is what's listening, and responds by seeding the main window's
 * `usePaymentsFilters()` with that snapshot and opening the modal.
 */
export const REATTACH_RECONCILIATION_EVENT = "reattach-reconciliation";

/** Wire shape for the handshake above — every `Set`-typed `PaymentsFilters` field flattened to a plain array so it survives `JSON.stringify` across the Tauri event bridge. */
export interface PaymentsFiltersSnapshot {
  employeeIds: string[];
  companyIds: string[];
  clientIds: string[];
  roleIds: string[];
  locals: string[];
  periodStart: string;
  periodEnd: string;
  statuses: PaymentShiftStatus[];
  shiftPeriods: ShiftPeriod[];
  scheduleTimeFilter: ScheduleTimeFilter | null;
  grouped: boolean;
}

export function snapshotPaymentsFilters(f: PaymentsFilters): PaymentsFiltersSnapshot {
  return {
    employeeIds: Array.from(f.selectedEmployeeIds),
    companyIds: Array.from(f.selectedCompanyIds),
    clientIds: Array.from(f.selectedClientIds),
    roleIds: Array.from(f.selectedRoleIds),
    locals: Array.from(f.selectedLocals),
    periodStart: f.periodStart,
    periodEnd: f.periodEnd,
    statuses: Array.from(f.selectedStatuses),
    shiftPeriods: Array.from(f.selectedShiftPeriods),
    scheduleTimeFilter: f.scheduleTimeFilter,
    grouped: f.grouped,
  };
}

export function applyPaymentsFiltersSnapshot(f: PaymentsFilters, snap: PaymentsFiltersSnapshot): void {
  f.setSelectedEmployeeIds(new Set(snap.employeeIds));
  f.setSelectedCompanyIds(new Set(snap.companyIds));
  f.setSelectedClientIds(new Set(snap.clientIds));
  f.setSelectedRoleIds(new Set(snap.roleIds));
  f.setSelectedLocals(new Set(snap.locals));
  f.setPeriod(snap.periodStart, snap.periodEnd);
  f.setSelectedStatuses(new Set(snap.statuses));
  f.setSelectedShiftPeriods(new Set(snap.shiftPeriods));
  f.setScheduleTimeFilter(snap.scheduleTimeFilter);
  f.setGrouped(snap.grouped);
}

export type ReportMode = "per-employee" | "per-client";

export interface LibraryFilters {
  /** Specific colaboradores picked from the "Colaborador" search-and-select — same `EmployeeMultiSelectDropdown`-backed filter Pagamentos uses. */
  selectedEmployeeIds: Set<string>;
  setSelectedEmployeeIds: (v: Set<string>) => void;
  selectedCompanyIds: Set<string>;
  setSelectedCompanyIds: (v: Set<string>) => void;
  selectedClientIds: Set<string>;
  setSelectedClientIds: (v: Set<string>) => void;
  periodStart: string;
  periodEnd: string;
  setPeriod: (start: string, end: string) => void;
  selectedStatuses: Set<PeriodStatusId>;
  setSelectedStatuses: Dispatch<SetStateAction<Set<PeriodStatusId>>>;
  mode: ReportMode;
  setMode: (m: ReportMode) => void;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  pageSize: number;
  setPageSize: (v: number) => void;
}

export interface PaymentsFilters {
  /** Specific colaboradores picked from the "Colaborador" search-and-select — not a freeform text filter, so a name that never turns up a suggestion is visibly "not in the database" rather than just failing to match. */
  selectedEmployeeIds: Set<string>;
  setSelectedEmployeeIds: (v: Set<string>) => void;
  selectedCompanyIds: Set<string>;
  setSelectedCompanyIds: (v: Set<string>) => void;
  selectedClientIds: Set<string>;
  setSelectedClientIds: (v: Set<string>) => void;
  selectedRoleIds: Set<string>;
  setSelectedRoleIds: (v: Set<string>) => void;
  /** Exact `payment_shifts.local` text values, not ids — `local` has no cadastro table of its own (see `listDistinctPaymentShiftLocals`). */
  selectedLocals: Set<string>;
  setSelectedLocals: (v: Set<string>) => void;
  periodStart: string;
  periodEnd: string;
  setPeriod: (start: string, end: string) => void;
  selectedStatuses: Set<PaymentShiftStatus>;
  setSelectedStatuses: Dispatch<SetStateAction<Set<PaymentShiftStatus>>>;
  selectedShiftPeriods: Set<ShiftPeriod>;
  setSelectedShiftPeriods: Dispatch<SetStateAction<Set<ShiftPeriod>>>;
  scheduleTimeFilter: ScheduleTimeFilter | null;
  setScheduleTimeFilter: Dispatch<SetStateAction<ScheduleTimeFilter | null>>;
  /** "Agrupar por colaborador" — off by default (flat, one row per turno); on shows one row per colaborador/competência, expandable inline. */
  grouped: boolean;
  setGrouped: Dispatch<SetStateAction<boolean>>;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  pageSize: number;
  setPageSize: (v: number) => void;
  /** The "Exportar Excel" template picker — a string id (or "" for none chosen), same as every other filter here: survives navigating away and back, unlike the component-local `useState` it replaced. */
  selectedExportTemplateId: string;
  setSelectedExportTemplateId: Dispatch<SetStateAction<string>>;
}

const LibraryFiltersContext = createContext<LibraryFilters | null>(null);
const PaymentsFiltersContext = createContext<PaymentsFilters | null>(null);

/**
 * Holds the Cartão Ponto and Pagamentos filter state above the router, so
 * each survives navigating away and back — to a collaborator's Cartão de
 * Ponto or Pagamentos detail, anywhere. The route unmounts the page
 * component on every visit; component-local `useState` would reset to
 * defaults each time, which is exactly what this avoids by living one
 * level up, in a provider mounted once for the whole app. Two separate
 * contexts (not one shared shape) since the two screens' filters aren't
 * the same fields (Cartão Ponto has `mode`, Pagamentos doesn't; the status
 * options are different enums) — merging them would just make both sides
 * carry fields that don't apply to them.
 */
export function FiltersProvider({ children }: { children: ReactNode }) {
  const [employeeIds, setEmployeeIds] = useState<Set<string>>(new Set());
  const [companyIds, setCompanyIds] = useState<Set<string>>(new Set());
  const [clientIds, setClientIds] = useState<Set<string>>(new Set());
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(() => toIso(todayUtc()));
  const [selectedStatuses, setSelectedStatuses] = useState<Set<PeriodStatusId>>(
    () => new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)),
  );
  const [mode, setMode] = useState<ReportMode>("per-employee");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(LIBRARY_PAGE_SIZE_OPTIONS[0]);

  const library: LibraryFilters = {
    selectedEmployeeIds: employeeIds,
    setSelectedEmployeeIds: setEmployeeIds,
    selectedCompanyIds: companyIds,
    setSelectedCompanyIds: setCompanyIds,
    selectedClientIds: clientIds,
    setSelectedClientIds: setClientIds,
    periodStart,
    periodEnd,
    setPeriod: (start, end) => {
      setPeriodStart(start);
      setPeriodEnd(end);
    },
    selectedStatuses,
    setSelectedStatuses,
    mode,
    setMode,
    page,
    setPage,
    pageSize,
    setPageSize,
  };

  const [paymentsEmployeeIds, setPaymentsEmployeeIds] = useState<Set<string>>(new Set());
  const [paymentsCompanyIds, setPaymentsCompanyIds] = useState<Set<string>>(new Set());
  const [paymentsClientIds, setPaymentsClientIds] = useState<Set<string>>(new Set());
  const [paymentsRoleIds, setPaymentsRoleIds] = useState<Set<string>>(new Set());
  const [paymentsLocals, setPaymentsLocals] = useState<Set<string>>(new Set());
  const [paymentsPeriodStart, setPaymentsPeriodStart] = useState("");
  const [paymentsPeriodEnd, setPaymentsPeriodEnd] = useState("");
  const [paymentsSelectedStatuses, setPaymentsSelectedStatuses] = useState<Set<PaymentShiftStatus>>(
    () => new Set(PAYMENT_SHIFT_STATUSES),
  );
  const [paymentsSelectedShiftPeriods, setPaymentsSelectedShiftPeriods] = useState<Set<ShiftPeriod>>(
    () => new Set(SHIFT_PERIODS),
  );
  const [paymentsScheduleTimeFilter, setPaymentsScheduleTimeFilter] = useState<ScheduleTimeFilter | null>(null);
  const [paymentsGrouped, setPaymentsGrouped] = useState(false);
  const [paymentsPage, setPaymentsPage] = useState(0);
  const [paymentsPageSize, setPaymentsPageSize] = useState(PAYMENTS_PAGE_SIZE_OPTIONS[0]);
  const [paymentsSelectedExportTemplateId, setPaymentsSelectedExportTemplateId] = useState("");

  const payments: PaymentsFilters = {
    selectedEmployeeIds: paymentsEmployeeIds,
    setSelectedEmployeeIds: setPaymentsEmployeeIds,
    selectedCompanyIds: paymentsCompanyIds,
    setSelectedCompanyIds: setPaymentsCompanyIds,
    selectedClientIds: paymentsClientIds,
    setSelectedClientIds: setPaymentsClientIds,
    selectedRoleIds: paymentsRoleIds,
    setSelectedRoleIds: setPaymentsRoleIds,
    selectedLocals: paymentsLocals,
    setSelectedLocals: setPaymentsLocals,
    periodStart: paymentsPeriodStart,
    periodEnd: paymentsPeriodEnd,
    setPeriod: (start, end) => {
      setPaymentsPeriodStart(start);
      setPaymentsPeriodEnd(end);
    },
    selectedStatuses: paymentsSelectedStatuses,
    setSelectedStatuses: setPaymentsSelectedStatuses,
    selectedShiftPeriods: paymentsSelectedShiftPeriods,
    setSelectedShiftPeriods: setPaymentsSelectedShiftPeriods,
    scheduleTimeFilter: paymentsScheduleTimeFilter,
    setScheduleTimeFilter: setPaymentsScheduleTimeFilter,
    grouped: paymentsGrouped,
    setGrouped: setPaymentsGrouped,
    page: paymentsPage,
    setPage: setPaymentsPage,
    pageSize: paymentsPageSize,
    setPageSize: setPaymentsPageSize,
    selectedExportTemplateId: paymentsSelectedExportTemplateId,
    setSelectedExportTemplateId: setPaymentsSelectedExportTemplateId,
  };

  // Answers the detached "Conferência de Pagamentos" window's one-time
  // "what are the current filters" ask (see `RECONCILIATION_WINDOW_READY_EVENT`
  // above) — a ref, not `payments` itself, as the listener's dependency:
  // the listener is only ever set up once (this provider lives for the
  // whole main-window session), so it needs to read whatever `payments`
  // happens to be CURRENT at the moment the event actually arrives, not
  // whatever it was when the effect first ran.
  const paymentsRef = useRef(payments);
  paymentsRef.current = payments;
  useEffect(() => {
    const unlisten = listen(RECONCILIATION_WINDOW_READY_EVENT, () => {
      emitTo(RECONCILIATION_WINDOW_LABEL, SEED_PAYMENTS_FILTERS_EVENT, snapshotPaymentsFilters(paymentsRef.current)).catch(
        () => {},
      );
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  return (
    <LibraryFiltersContext.Provider value={library}>
      <PaymentsFiltersContext.Provider value={payments}>{children}</PaymentsFiltersContext.Provider>
    </LibraryFiltersContext.Provider>
  );
}

export function useLibraryFilters(): LibraryFilters {
  const ctx = useContext(LibraryFiltersContext);
  if (!ctx) throw new Error("useLibraryFilters must be used within a FiltersProvider");
  return ctx;
}

export function usePaymentsFilters(): PaymentsFilters {
  const ctx = useContext(PaymentsFiltersContext);
  if (!ctx) throw new Error("usePaymentsFilters must be used within a FiltersProvider");
  return ctx;
}
