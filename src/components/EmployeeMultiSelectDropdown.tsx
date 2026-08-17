import { Search } from "lucide-react";
import { useEffect, useRef, useState, type UIEvent } from "react";
import { getEmployeesByIds, listEmployeesGlobal, type EmployeeRow } from "../lib/db";

const PAGE_SIZE = 20;
/** How close (px) to the bottom of the results list triggers loading the next page. */
const LOAD_MORE_THRESHOLD_PX = 48;
/** Idle time after the last keystroke before the typed search actually queries the db — long enough to type a full name without firing a query per letter. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The "Colaborador" filter — search-as-you-type against the real employee
 * directory (`listEmployeesGlobal`), with a checkbox per result so more
 * than one can be picked. Unlike a plain text filter, only a colaborador
 * that actually exists in the database can ever be selected — typing a
 * name that never turns up a suggestion tells the user it isn't
 * registered, which a freeform substring match can't (a typo and a
 * genuinely-missing colaborador would otherwise both just show "no
 * results" on the table itself).
 *
 * Structurally this mirrors `MultiSelectDropdown` (same trigger/popover/
 * `align`/`fullWidth` shape, so it drops into the same field grid) rather
 * than `EmployeePicker` (portaled, single-pick-and-close, scoped to one
 * cliente+empresa) — this one keeps a persisted `selected` set and never
 * closes on pick, and isn't scoped to a single cliente/empresa since the
 * Pagamentos filters may have several (or none) selected at once.
 */
export default function EmployeeMultiSelectDropdown({
  selected,
  onToggle,
  onClear,
  companyIds,
  clientIds,
  align = "right",
  fullWidth = false,
  showIcon = true,
}: {
  /** Employee ids, as strings — same convention as every other id-based filter Set in this app. */
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Deselects every currently-selected colaborador at once — the "Limpar" affordance, same intent as `MultiSelectDropdown`'s `onSelectNone` (named differently since there's no "select all" counterpart for an open-ended search). */
  onClear: () => void;
  /** Scopes results the same way Cliente/Função already narrow by empresa — omitted/empty means unscoped. */
  companyIds?: number[];
  clientIds?: number[];
  align?: "left" | "right";
  fullWidth?: boolean;
  showIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Every `EmployeeRow` seen so far (from search results or a direct
  // by-id fetch), keyed by id — lets the "Selecionados" section below show
  // a colaborador's name even when they've scrolled off the current
  // search's page or don't match the current query at all.
  const [knownEmployees, setKnownEmployees] = useState<Map<string, EmployeeRow>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function rememberEmployees(found: EmployeeRow[]) {
    if (found.length === 0) return;
    setKnownEmployees((prev) => {
      const next = new Map(prev);
      for (const row of found) next.set(String(row.id), row);
      return next;
    });
  }

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  // Holds off updating `debouncedSearch` (the effect below queries by this,
  // not `search` directly) until typing has paused — otherwise every
  // keystroke fires its own query against the db.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Loads (and replaces) page 0 whenever the dropdown opens or the query
  // changes — infinite scroll (see `loadMore`/`handleResultsScroll` below)
  // is what advances past it from there, not this effect re-running with a
  // different `page`.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPage(0);
    listEmployeesGlobal({ search: debouncedSearch, companyIds, clientIds, page: 0, pageSize: PAGE_SIZE })
      .then(({ rows: r, total: t }) => {
        if (cancelled) return;
        setRows(r);
        setTotal(t);
        rememberEmployees(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debouncedSearch, JSON.stringify(companyIds), JSON.stringify(clientIds)]);

  // Fetches whichever already-selected colaboradores haven't turned up in a
  // search result yet (typically: filters applied in an earlier session,
  // reopened here before their names have been searched for again) so the
  // "Selecionados" section can show a name instead of just an id.
  const selectedKey = Array.from(selected).sort().join(",");
  useEffect(() => {
    if (!open) return;
    const missingIds = Array.from(selected)
      .filter((id) => !knownEmployees.has(id))
      .map(Number);
    if (missingIds.length === 0) return;
    getEmployeesByIds(missingIds).then(rememberEmployees);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedKey]);

  const hasMore = rows.length < total;

  function loadMore() {
    if (loading || loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    listEmployeesGlobal({ search: debouncedSearch, companyIds, clientIds, page: nextPage, pageSize: PAGE_SIZE })
      .then(({ rows: r }) => {
        setRows((prev) => [...prev, ...r]);
        setPage(nextPage);
        rememberEmployees(r);
      })
      .finally(() => setLoadingMore(false));
  }

  function handleResultsScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD_PX) loadMore();
  }

  const label = selected.size === 0 ? "Nenhum colaborador" : `${selected.size} selecionado${selected.size > 1 ? "s" : ""}`;

  // Selected colaboradores are pinned above the search results (see the
  // "Selecionados" section below) regardless of the current query, so the
  // main list only needs whatever's left over — otherwise a name matching
  // both would render twice.
  const pinnedRows = Array.from(selected, (id) => knownEmployees.get(id))
    .filter((e): e is EmployeeRow => Boolean(e))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unpinnedRows = rows.filter((e) => !selected.has(String(e.id)));

  function renderEmployeeRow(e: EmployeeRow) {
    return (
      <label
        key={e.id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.3rem 0.2rem",
          fontSize: "0.85rem",
          cursor: "pointer",
        }}
      >
        <input type="checkbox" checked={selected.has(String(e.id))} onChange={() => onToggle(String(e.id))} />
        {e.name}
        {(() => {
          const matriculas = e.links.map((l) => l.matricula).filter(Boolean).join(", ");
          return matriculas && <span className="muted"> · {matriculas}</span>;
        })()}
      </label>
    );
  }

  return (
    <div
      style={
        fullWidth
          ? { position: "relative", width: "100%" }
          : { position: "relative", display: "inline-block", alignSelf: "flex-start" }
      }
      ref={rootRef}
    >
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setSearch("");
          setDebouncedSearch("");
          setOpen((o) => !o);
        }}
        style={fullWidth ? { width: "100%", display: "flex", alignItems: "center", textAlign: "left" } : undefined}
      >
        {showIcon && <Search size={15} style={{ marginRight: "0.4rem" }} />}
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            left: align === "left" ? 0 : undefined,
            right: align === "left" ? undefined : 0,
            top: "calc(100% + 0.4rem)",
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.6rem",
            minWidth: "320px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
            zIndex: 20,
          }}
        >
          <div style={{ position: "relative", marginBottom: "0.5rem" }}>
            <Search
              size={13}
              style={{ position: "absolute", left: "0.55rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
            />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome..."
              style={{ width: "100%", paddingLeft: "1.8rem", fontSize: "0.85rem" }}
            />
          </div>

          {selected.size > 0 && (
            <div style={{ marginBottom: "0.5rem", paddingBottom: "0.5rem", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.2rem" }}>
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  Selecionados ({selected.size})
                </span>
                <button type="button" className="ghost" style={{ padding: "0.15rem 0.4rem", fontSize: "0.75rem" }} onClick={onClear}>
                  Limpar
                </button>
              </div>
              <div className="scrollbar-hidden" style={{ display: "flex", flexDirection: "column", maxHeight: "8rem", overflowY: "auto" }}>
                {pinnedRows.map(renderEmployeeRow)}
              </div>
            </div>
          )}

          {/* The previous results stay on screen while a new search is in
              flight — swapped for the new list only once it arrives, rather
              than clearing to a "Buscando..." state first (which read as a
              flicker between two lists). "Buscando..."/"Nenhum encontrado"
              only apply to the very first query, before there's anything to
              keep showing. */}
          {loading && rows.length === 0 && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>
              Buscando...
            </p>
          )}
          {!loading && rows.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "6rem" }}>
              <p className="muted" style={{ fontSize: "0.82rem", margin: 0, textAlign: "center" }}>
                Nenhum colaborador encontrado.
              </p>
            </div>
          )}
          {unpinnedRows.length > 0 && (
            <div
              className="scrollbar-hidden"
              onScroll={handleResultsScroll}
              style={{ display: "flex", flexDirection: "column", maxHeight: "22rem", overflowY: "auto" }}
            >
              {unpinnedRows.map(renderEmployeeRow)}
              {loadingMore && (
                <p className="muted" style={{ fontSize: "0.78rem", margin: "0.4rem 0 0", textAlign: "center" }}>
                  Carregando mais...
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
