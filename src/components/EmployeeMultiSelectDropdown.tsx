import { Search } from "lucide-react";
import { useEffect, useRef, useState, type UIEvent } from "react";
import { listEmployeesGlobal, type EmployeeRow } from "../lib/db";

const PAGE_SIZE = 20;
/** How close (px) to the bottom of the results list triggers loading the next page. */
const LOAD_MORE_THRESHOLD_PX = 48;

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
  companyIds,
  clientIds,
  align = "right",
  fullWidth = false,
  showIcon = true,
}: {
  /** Employee ids, as strings — same convention as every other id-based filter Set in this app. */
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Scopes results the same way Cliente/Função already narrow by empresa — omitted/empty means unscoped. */
  companyIds?: number[];
  clientIds?: number[];
  align?: "left" | "right";
  fullWidth?: boolean;
  showIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Loads (and replaces) page 0 whenever the dropdown opens or the query
  // changes — infinite scroll (see `loadMore`/`handleResultsScroll` below)
  // is what advances past it from there, not this effect re-running with a
  // different `page`.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPage(0);
    listEmployeesGlobal({ search, companyIds, clientIds, page: 0, pageSize: PAGE_SIZE })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, JSON.stringify(companyIds), JSON.stringify(clientIds)]);

  const hasMore = rows.length < total;

  function loadMore() {
    if (loading || loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    listEmployeesGlobal({ search, companyIds, clientIds, page: nextPage, pageSize: PAGE_SIZE })
      .then(({ rows: r }) => {
        setRows((prev) => [...prev, ...r]);
        setPage(nextPage);
      })
      .finally(() => setLoadingMore(false));
  }

  function handleResultsScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD_PX) loadMore();
  }

  const label = selected.size === 0 ? "Nenhum colaborador" : `${selected.size} selecionado${selected.size > 1 ? "s" : ""}`;

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

          {loading && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>
              Buscando...
            </p>
          )}
          {!loading && rows.length === 0 && (
            <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>
              Nenhum colaborador encontrado{search.trim() ? " — não cadastrado na base" : ""}.
            </p>
          )}
          {!loading && rows.length > 0 && (
            <div
              className="scrollbar-hidden"
              onScroll={handleResultsScroll}
              style={{ display: "flex", flexDirection: "column", maxHeight: "22rem", overflowY: "auto" }}
            >
              {rows.map((e) => (
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
              ))}
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
