import { Search, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listEmployeesGlobal, type EmployeeRow } from "../lib/db";

const PAGE_SIZE = 8;
const POPOVER_WIDTH = 288; // 18rem at the default 16px root size
/** Idle time after the last keystroke before the typed search actually queries the db — long enough to type a full name without firing a query per letter. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * A single-colaborador combobox, scoped to one client **and** one company —
 * search box + paginated results, backed directly by `listEmployeesGlobal`
 * (already filters/paginates in SQL). Both are required, not just
 * `clientId`: a cliente can be linked to more than one empresa, and the
 * results here need to match whichever empresa the caller already resolved
 * (e.g. a payment-import row's routing rule) — otherwise this could offer
 * (and let you link to) a colaborador who actually belongs to a different
 * empresa of that same cliente.
 *
 * Unlike `MultiSelectDropdown`, this is a plain search-and-pick, not a
 * checklist: picking an option calls `onSelect` and closes the popover,
 * there's no persisted "selected" display here — the caller re-renders
 * whatever picked it into something else once resolved (see the
 * "colaborador não encontrado" preview row in ImportPaymentsPage).
 *
 * The popover is portaled to `document.body` and positioned with `fixed`
 * coordinates computed from the trigger button — unlike `MultiSelectDropdown`/
 * `DateRangePicker`, this one is meant to sit inside a table cell, and a
 * plain `position: absolute` popover gets clipped by the table's own
 * `overflow-x: auto` scroll container otherwise.
 */
export default function EmployeePicker({
  clientId,
  companyId,
  onSelect,
  placeholder = "Vincular colaborador...",
  disabled = false,
}: {
  clientId: number;
  companyId: number;
  onSelect: (employee: EmployeeRow) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Fixed-position coordinates don't track the trigger while scrolling —
  // simplest correct behavior is to close instead of drifting out of place.
  // Scrolling *inside* the popover itself (the results list) is exempt —
  // that's not an anchor-drift case, and "scroll" is captured here (not
  // bubbled), so without this check scrolling the results would close the
  // very popover being scrolled.
  useEffect(() => {
    if (!open) return;
    function onScroll(e: Event) {
      if (e.target instanceof Node && popoverRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listEmployeesGlobal({ search: debouncedSearch, clientIds: [clientId], companyIds: [companyId], page, pageSize: PAGE_SIZE })
      .then(({ rows: r, total: t }) => {
        if (cancelled) return;
        setRows(r);
        setTotal(t);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debouncedSearch, clientId, companyId, page]);

  function toggleOpen() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estimatedHeight = 320;
    const openUp = rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight;
    const left = Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8);
    setCoords({
      top: openUp ? rect.top - 8 : rect.bottom + 8,
      left: Math.max(8, left),
      openUp,
    });
    setSearch("");
    setDebouncedSearch("");
    setPage(0);
    setOpen(true);
  }

  function pick(employee: EmployeeRow) {
    setOpen(false);
    onSelect(employee);
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={toggleOpen}
        disabled={disabled}
        ref={triggerRef}
        style={{ fontSize: "0.82rem" }}
      >
        <UserPlus size={13} style={{ marginRight: "0.35rem" }} />
        {placeholder}
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: "fixed",
              top: coords.openUp ? undefined : coords.top,
              bottom: coords.openUp ? window.innerHeight - coords.top : undefined,
              left: coords.left,
              background: "var(--card-bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "0.6rem",
              width: `${POPOVER_WIDTH}px`,
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
              zIndex: 100,
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
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="Buscar por nome..."
                style={{ width: "100%", paddingLeft: "1.8rem", fontSize: "0.85rem" }}
              />
            </div>

            {/* The previous results stay on screen while a new page/search is
                in flight — swapped for the new list only once it arrives,
                rather than clearing to "Carregando..." first (which read as
                a flicker between two lists). */}
            {loading && rows.length === 0 && <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>Carregando...</p>}
            {!loading && rows.length === 0 && (
              <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>
                Nenhum colaborador encontrado.
              </p>
            )}
            {rows.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", maxHeight: "14rem", overflowY: "auto" }}>
                {rows.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="ghost"
                    onClick={() => pick(e)}
                    style={{
                      textAlign: "left",
                      padding: "0.4rem 0.5rem",
                      fontSize: "0.85rem",
                    }}
                  >
                    {e.name}
                    {(() => {
                      const matricula = e.links.find((l) => l.clientId === clientId && l.companyId === companyId)?.matricula;
                      return matricula && <span className="muted"> · {matricula}</span>;
                    })()}
                  </button>
                ))}
              </div>
            )}

            {pageCount > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="ghost"
                  style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Anterior
                </button>
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  Página {page + 1} de {pageCount}
                </span>
                <button
                  type="button"
                  className="ghost"
                  style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                >
                  Próxima
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
