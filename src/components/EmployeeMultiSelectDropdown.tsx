import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { colorForName, initials } from "../lib/avatar";
import { getEmployeesByIds, listEmployeesGlobal, type EmployeeRow } from "../lib/db";
import { formatCpfPartial, formatPersonName } from "../lib/format";

const PAGE_SIZE = 20;
/** How close (px) to the bottom of the results list triggers loading the next page. */
const LOAD_MORE_THRESHOLD_PX = 48;
/** Idle time after the last keystroke before the typed search actually queries the db — long enough to type a full name without firing a query per letter. */
const SEARCH_DEBOUNCE_MS = 300;
/** Gap kept between the bottom of the open box and the bottom of the window. */
const WINDOW_MARGIN_PX = 12;
/** Below this, the list keeps this height and the box runs past the window instead of becoming unusable. */
const MIN_LIST_HEIGHT_PX = 180;
/** How many selected colaboradores show as stacked initials on the closed field. */
const STACK_SIZE = 3;
/** Selected rows shown before "Mostrar mais"; up to one more than this shows them all, since hiding a single row isn't worth a click. */
const SELECTED_PREVIEW = 3;

function MiniAvatar({ name }: { name: string }) {
  return (
    <span className="emp-picker-avatar" style={{ background: colorForName(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** "•••.456.789-•• · Hospital Santa Clara (+1) · mat. 123": what tells two people with the same name apart. */
function employeeMeta(e: EmployeeRow): string {
  const parts: string[] = [];
  const cpf = formatCpfPartial(e.cpf);
  if (cpf) parts.push(cpf);
  const first = e.links[0];
  if (first) {
    const clients = new Set(e.links.map((l) => l.clientName));
    parts.push(clients.size > 1 ? `${first.clientName} (+${clients.size - 1})` : first.clientName);
    const matriculas = e.links.map((l) => l.matricula).filter(Boolean);
    if (matriculas.length > 0) parts.push(`mat. ${matriculas.join(", ")}`);
  }
  return parts.join(" · ");
}

/**
 * The "Colaborador" filter — search-as-you-type against the real employee
 * directory (`listEmployeesGlobal`), with more than one pickable. Unlike a
 * plain text filter, only a colaborador that actually exists in the
 * database can ever be selected — typing a name that never turns up a
 * suggestion tells the user it isn't registered, which a freeform
 * substring match can't.
 *
 * The closed field shows who is selected (stacked initials plus a name).
 * Opening it grows a box out of the field itself, with the search where
 * the summary was and the selected ones pinned above the results; it never
 * closes on pick. Arrow keys move through the list, Enter toggles,
 * Backspace on an empty search removes the last one picked, Esc closes.
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
  /** Deselects every currently-selected colaborador at once. */
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
  /** Keyboard position in the combined (selected + results) list; -1 is none. */
  const [cursor, setCursor] = useState(-1);
  const [showAllSelected, setShowAllSelected] = useState(false);
  // Every `EmployeeRow` seen so far (from search results or a direct
  // by-id fetch), keyed by id — lets the selected ones show a name even
  // when they don't match the current query at all.
  const [knownEmployees, setKnownEmployees] = useState<Map<string, EmployeeRow>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  /** The list grows down to the bottom of the window and only scrolls past that. */
  const [listMaxHeight, setListMaxHeight] = useState<number | undefined>(undefined);

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
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Holds off updating `debouncedSearch` (the effect below queries by this,
  // not `search` directly) until typing has paused.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Loads (and replaces) page 0 whenever the dropdown opens or the query
  // changes — infinite scroll (`loadMore`) advances past it from there.
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

  // Fetches whichever selected colaboradores haven't turned up in a search
  // yet — also while closed, since the closed field shows their names.
  const selectedKey = Array.from(selected).sort().join(",");
  useEffect(() => {
    const missingIds = Array.from(selected)
      .filter((id) => !knownEmployees.has(id))
      .map(Number);
    if (missingIds.length === 0) return;
    getEmployeesByIds(missingIds).then(rememberEmployees);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

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

  // Selected colaboradores are pinned above the results regardless of the
  // query, so the results only need whatever's left — otherwise a name
  // matching both would render twice.
  const selectedRows = Array.from(selected, (id) => knownEmployees.get(id))
    .filter((e): e is EmployeeRow => Boolean(e))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unpinnedRows = rows.filter((e) => !selected.has(String(e.id)));
  const collapsible = selectedRows.length > SELECTED_PREVIEW + 1;
  const visibleSelectedRows = collapsible && !showAllSelected ? selectedRows.slice(0, SELECTED_PREVIEW) : selectedRows;
  const listRows = [...visibleSelectedRows, ...unpinnedRows];

  // Fits the list to the room left below it, before paint so it never
  // flashes at the wrong height; redone when the window is resized.
  useLayoutEffect(() => {
    if (!open) return;
    function fit() {
      const list = listRef.current;
      if (!list) return;
      const footerHeight = footerRef.current?.offsetHeight ?? 0;
      // Inside the Filtros panel the box ends where its scrolling area does, not at the window's bottom.
      const area = list.closest(".side-panel-body");
      const bottom = area ? Math.min(window.innerHeight, area.getBoundingClientRect().bottom) : window.innerHeight;
      const room = bottom - list.getBoundingClientRect().top - footerHeight - WINDOW_MARGIN_PX;
      setListMaxHeight(Math.max(MIN_LIST_HEIGHT_PX, Math.floor(room)));
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  // Keeps the keyboard row in view as it moves.
  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function openPopover() {
    setShowAllSelected(false);
    setSearch("");
    setDebouncedSearch("");
    setCursor(-1);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(listRows.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = listRows[cursor];
      if (row) onToggle(String(row.id));
    } else if (e.key === "Backspace" && search === "" && selected.size > 0) {
      e.preventDefault();
      onToggle(Array.from(selected)[selected.size - 1]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  const firstSelected = selectedRows[0];
  let summary: string;
  if (selected.size === 0) summary = "Todos os colaboradores";
  else if (!firstSelected) summary = `${selected.size} selecionado${selected.size > 1 ? "s" : ""}`;
  else if (selected.size === 1) summary = formatPersonName(firstSelected.name);
  else summary = `${formatPersonName(firstSelected.name).split(" ")[0]} e mais ${selected.size - 1}`;

  function renderRow(e: EmployeeRow, index: number) {
    const id = String(e.id);
    const isSelected = selected.has(id);
    const meta = employeeMeta(e);
    return (
      <div
        key={id}
        role="option"
        aria-selected={isSelected}
        data-index={index}
        className={index === cursor ? "emp-picker-row emp-picker-row-active" : "emp-picker-row"}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={() => {
          setCursor(index);
          onToggle(id);
        }}
      >
        <MiniAvatar name={e.name} />
        <span className="emp-picker-who">
          <span className="emp-picker-name">{formatPersonName(e.name)}</span>
          {meta && <span className="emp-picker-meta">{meta}</span>}
        </span>
        <span className="emp-picker-tick" aria-hidden="true">
          <Check size={11} strokeWidth={3.5} />
        </span>
      </div>
    );
  }

  return (
    <div className={`emp-picker${fullWidth ? " emp-picker-full" : ""}${open ? " emp-picker-open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="emp-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        {showIcon && selected.size === 0 && <Search size={14} className="emp-picker-muted" />}
        {selectedRows.length > 0 && (
          <span className="emp-picker-stack">
            {selectedRows.slice(0, STACK_SIZE).map((e) => (
              <MiniAvatar key={e.id} name={e.name} />
            ))}
          </span>
        )}
        <span className={selected.size === 0 ? "emp-picker-summary emp-picker-placeholder" : "emp-picker-summary"}>{summary}</span>
        <ChevronsUpDown size={14} className="emp-picker-muted" />
      </button>

      {open && (
        <div className={`emp-picker-popover emp-picker-popover-${align}`}>
          <div className="emp-picker-search">
            <Search size={14} className="emp-picker-muted" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor(e.target.value ? 0 : -1);
              }}
              onKeyDown={handleSearchKey}
              placeholder="Buscar por nome ou CPF"
              aria-label="Buscar colaborador"
            />
            <kbd>Esc</kbd>
          </div>

          <div ref={listRef} className="emp-picker-list" style={{ maxHeight: listMaxHeight }} role="listbox" aria-multiselectable="true" onScroll={handleResultsScroll}>
            {selectedRows.length > 0 && (
              <>
                <div className="emp-picker-section">
                  Selecionados <span>{selected.size}</span>
                </div>
                {visibleSelectedRows.map((e, i) => renderRow(e, i))}
                {collapsible && (
                  <button
                    type="button"
                    className="emp-picker-more"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setShowAllSelected((v) => !v);
                      setCursor(-1);
                    }}
                  >
                    {showAllSelected ? "Mostrar menos" : `Mostrar mais ${selectedRows.length - SELECTED_PREVIEW}`}
                  </button>
                )}
                {unpinnedRows.length > 0 && <div className="emp-picker-section">Todos</div>}
              </>
            )}
            {unpinnedRows.map((e, i) => renderRow(e, visibleSelectedRows.length + i))}

            {/* The previous results stay on screen while a new search is in
                flight; these only apply before there's anything to keep. */}
            {loading && rows.length === 0 && <p className="emp-picker-empty">Buscando...</p>}
            {!loading && rows.length === 0 && (
              <p className="emp-picker-empty">
                {debouncedSearch ? `Nenhum colaborador com “${debouncedSearch}”. Confira o nome ou o cadastro em Colaboradores.` : "Nenhum colaborador encontrado."}
              </p>
            )}
            {loadingMore && <p className="emp-picker-empty">Carregando mais...</p>}
          </div>

          <div ref={footerRef} className="emp-picker-footer">
            <button type="button" className="emp-picker-clear" onClick={onClear} disabled={selected.size === 0}>
              Limpar seleção
            </button>
            <button type="button" className="emp-picker-done" onClick={close}>
              Pronto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
