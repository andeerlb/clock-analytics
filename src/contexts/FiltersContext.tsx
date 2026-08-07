import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
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

export type ReportMode = "per-employee" | "per-client";

export interface LibraryFilters {
  search: string;
  setSearch: (v: string) => void;
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
  search: string;
  setSearch: (v: string) => void;
  selectedCompanyIds: Set<string>;
  setSelectedCompanyIds: (v: Set<string>) => void;
  selectedClientIds: Set<string>;
  setSelectedClientIds: (v: Set<string>) => void;
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
  const [search, setSearch] = useState("");
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
    search,
    setSearch,
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

  const [paymentsSearch, setPaymentsSearch] = useState("");
  const [paymentsCompanyIds, setPaymentsCompanyIds] = useState<Set<string>>(new Set());
  const [paymentsClientIds, setPaymentsClientIds] = useState<Set<string>>(new Set());
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

  const payments: PaymentsFilters = {
    search: paymentsSearch,
    setSearch: setPaymentsSearch,
    selectedCompanyIds: paymentsCompanyIds,
    setSelectedCompanyIds: setPaymentsCompanyIds,
    selectedClientIds: paymentsClientIds,
    setSelectedClientIds: setPaymentsClientIds,
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
  };

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
