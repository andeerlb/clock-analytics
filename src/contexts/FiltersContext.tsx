import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { toIso, todayUtc } from "../lib/calendar";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";

/** Default period on load: the current calendar month so far — never empty. */
function defaultPeriodStart(): string {
  const today = todayUtc();
  return toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

function defaultSelectedStatuses(): Set<PeriodStatusId> {
  return new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id));
}

export const LIBRARY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
export const REPORT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

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
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  pageSize: number;
  setPageSize: (v: number) => void;
}

export interface ReportFilters {
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

const LibraryFiltersContext = createContext<LibraryFilters | null>(null);
const ReportFiltersContext = createContext<ReportFilters | null>(null);

/**
 * Holds the Colaboradores and Relatórios filter state above the router, so
 * it survives navigating away and back — to a collaborator's Cartão de
 * Ponto, between the two list screens, anywhere. Both routes unmount their
 * page component on every visit; component-local `useState` would reset to
 * defaults each time, which is exactly what this avoids by living one level
 * up, in a provider mounted once for the whole app.
 *
 * Empresa, Cliente, Período, and Status no período are the same underlying
 * state for both screens — not just persisted per-screen, but genuinely
 * shared, so setting one on Colaboradores shows up already applied on
 * Relatórios and vice versa. Busca (Colaboradores-only) and modo de geração
 * (Relatórios-only) don't exist on the other screen, so those — and each
 * screen's own pagination, since the two tables don't show the same rows —
 * stay independent.
 */
export function FiltersProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState("");
  const [companyIds, setCompanyIds] = useState<Set<string>>(new Set());
  const [clientIds, setClientIds] = useState<Set<string>>(new Set());
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(() => toIso(todayUtc()));
  const [selectedStatuses, setSelectedStatuses] = useState(defaultSelectedStatuses);
  const [mode, setMode] = useState<ReportMode>("per-employee");

  const [libraryPage, setLibraryPage] = useState(0);
  const [libraryPageSize, setLibraryPageSize] = useState(LIBRARY_PAGE_SIZE_OPTIONS[0]);
  const [reportPage, setReportPage] = useState(0);
  const [reportPageSize, setReportPageSize] = useState(REPORT_PAGE_SIZE_OPTIONS[0]);

  const setPeriod = (start: string, end: string) => {
    setPeriodStart(start);
    setPeriodEnd(end);
  };

  const library: LibraryFilters = {
    search,
    setSearch,
    selectedCompanyIds: companyIds,
    setSelectedCompanyIds: setCompanyIds,
    selectedClientIds: clientIds,
    setSelectedClientIds: setClientIds,
    periodStart,
    periodEnd,
    setPeriod,
    selectedStatuses,
    setSelectedStatuses,
    page: libraryPage,
    setPage: setLibraryPage,
    pageSize: libraryPageSize,
    setPageSize: setLibraryPageSize,
  };

  const report: ReportFilters = {
    selectedCompanyIds: companyIds,
    setSelectedCompanyIds: setCompanyIds,
    selectedClientIds: clientIds,
    setSelectedClientIds: setClientIds,
    periodStart,
    periodEnd,
    setPeriod,
    selectedStatuses,
    setSelectedStatuses,
    mode,
    setMode,
    page: reportPage,
    setPage: setReportPage,
    pageSize: reportPageSize,
    setPageSize: setReportPageSize,
  };

  return (
    <LibraryFiltersContext.Provider value={library}>
      <ReportFiltersContext.Provider value={report}>{children}</ReportFiltersContext.Provider>
    </LibraryFiltersContext.Provider>
  );
}

export function useLibraryFilters(): LibraryFilters {
  const ctx = useContext(LibraryFiltersContext);
  if (!ctx) throw new Error("useLibraryFilters must be used within a FiltersProvider");
  return ctx;
}

export function useReportFilters(): ReportFilters {
  const ctx = useContext(ReportFiltersContext);
  if (!ctx) throw new Error("useReportFilters must be used within a FiltersProvider");
  return ctx;
}
