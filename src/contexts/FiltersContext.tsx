import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { toIso, todayUtc } from "../lib/calendar";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";

/** Default period on load: the current calendar month so far — never empty. */
function defaultPeriodStart(): string {
  const today = todayUtc();
  return toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

export const LIBRARY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

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

const LibraryFiltersContext = createContext<LibraryFilters | null>(null);

/**
 * Holds the Cartão Ponto filter state above the router, so it survives
 * navigating away and back — to a collaborator's Cartão de Ponto, anywhere.
 * The route unmounts the page component on every visit; component-local
 * `useState` would reset to defaults each time, which is exactly what this
 * avoids by living one level up, in a provider mounted once for the whole
 * app.
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

  return <LibraryFiltersContext.Provider value={library}>{children}</LibraryFiltersContext.Provider>;
}

export function useLibraryFilters(): LibraryFilters {
  const ctx = useContext(LibraryFiltersContext);
  if (!ctx) throw new Error("useLibraryFilters must be used within a FiltersProvider");
  return ctx;
}
