import { CornerDownLeft, Plus, Search, UserPlus } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { listEmployeesGlobal, type EmployeeRow } from "../lib/db";
import Avatar from "./Avatar";

const PAGE_SIZE = 30;
const POPOVER_WIDTH = 340;
/** Idle time after the last keystroke before the typed search actually queries the db — long enough to type a full name without firing a query per letter. */
const SEARCH_DEBOUNCE_MS = 300;
/** At most this many "Parecidos" shown above the full list. */
const SIMILAR_LIMIT = 5;
/** How close to the bottom of the list (px) scrolling loads the next page. */
const LOAD_MORE_THRESHOLD_PX = 40;

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** Name words worth comparing — no initials ("P."), no "da"/"de"/"dos". */
function nameWords(name: string): string[] {
  return normalize(name)
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(DA|DE|DO|DAS|DOS|E)$/.test(w));
}

/** "12345678901" / "123.456.789-01" -> "123.456.***-01" — enough to tell two people with the same name apart. */
function maskCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.***-${digits.slice(9)}`;
}

/**
 * A single-colaborador picker, scoped to one client **and** one company —
 * backed directly by `listEmployeesGlobal` (already filters/paginates in
 * SQL). Both are required, not just `clientId`: a cliente can be linked to
 * more than one empresa, and the results here need to match whichever
 * empresa the caller already resolved (e.g. a payment-import row's routing
 * rule) — otherwise this could offer (and let you link to) a colaborador
 * who actually belongs to a different empresa of that same cliente.
 *
 * Same box as the Empresa/Template pickers (`emp-picker-*` classes): search
 * with Esc, arrow keys + Enter, colored initials, the matrícula and a
 * partly masked CPF under each name, and the list keeps loading as you
 * scroll. With `rawName` (the name read from the spreadsheet) it shows it
 * on top and lists "Parecidos" first: same first name, ranked by how many
 * of the other name words also match. `onRegister` adds a "Cadastrar novo"
 * button to the footer.
 *
 * The popover is portaled to `document.body` and positioned with `fixed`
 * coordinates computed from the trigger button — it's meant to sit inside a
 * table cell, and a plain `position: absolute` popover gets clipped by the
 * table's own `overflow-x: auto` scroll container otherwise.
 */
export default function EmployeePicker({
  clientId,
  companyId,
  onSelect,
  placeholder = "Vincular colaborador...",
  disabled = false,
  rawName,
  contextLabel,
  onRegister,
}: {
  clientId: number;
  companyId: number;
  onSelect: (employee: EmployeeRow) => void;
  placeholder?: string;
  disabled?: boolean;
  /** The name as read from the source (e.g. the spreadsheet) — shown on top and used for "Parecidos". */
  rawName?: string;
  /** Whose colaboradores are listed, e.g. "STO AMARO · FC". */
  contextLabel?: string;
  onRegister?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [similar, setSimilar] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Holds off updating `debouncedSearch` (the effect below queries by this,
  // not `search` directly) until typing has paused — otherwise every
  // keystroke fires its own query against the db.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
      setCursor(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Page 0 replaces the list (new search / reopen); later pages append —
  // the list grows as it's scrolled instead of paging.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listEmployeesGlobal({ search: debouncedSearch, clientIds: [clientId], companyIds: [companyId], page, pageSize: PAGE_SIZE })
      .then(({ rows: r, total: t }) => {
        if (cancelled) return;
        setRows((prev) => (page === 0 ? r : [...prev, ...r]));
        setTotal(t);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debouncedSearch, clientId, companyId, page]);

  // "Parecidos": everyone sharing the spreadsheet name's first word, ranked
  // by how many of its other words they also have. Only with an empty search.
  useEffect(() => {
    if (!open || !rawName) return;
    const words = nameWords(rawName);
    if (words.length === 0) {
      setSimilar([]);
      return;
    }
    let cancelled = false;
    listEmployeesGlobal({ search: words[0], clientIds: [clientId], companyIds: [companyId], page: 0, pageSize: 200 }).then(({ rows: r }) => {
      if (cancelled) return;
      const rest = words.slice(1);
      const scored = r
        .map((e) => {
          const theirs = nameWords(e.name);
          if (theirs[0] !== words[0]) return null;
          return { e, score: rest.filter((w) => theirs.includes(w)).length };
        })
        .filter((x): x is { e: EmployeeRow; score: number } => x !== null && (rest.length === 0 || x.score > 0))
        .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
      setSimilar(scored.slice(0, SIMILAR_LIMIT).map((x) => x.e));
    });
    return () => {
      cancelled = true;
    };
  }, [open, rawName, clientId, companyId]);

  const showSimilar = !debouncedSearch.trim() && similar.length > 0;
  const similarIds = new Set(similar.map((e) => e.id));
  const rest = showSimilar ? rows.filter((e) => !similarIds.has(e.id)) : rows;
  const flat = showSimilar ? [...similar, ...rest] : rest;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function toggleOpen() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estimatedHeight = 440;
    const openUp = rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight;
    const left = Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8);
    setCoords({
      top: openUp ? rect.top - 6 : rect.bottom + 6,
      left: Math.max(8, left),
      openUp,
    });
    setSearch("");
    setDebouncedSearch("");
    setPage(0);
    setCursor(0);
    setRows([]);
    setSimilar([]);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pick(employee: EmployeeRow) {
    setOpen(false);
    onSelect(employee);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      const employee = flat[cursor];
      if (employee) {
        e.preventDefault();
        pick(employee);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function handleListScroll() {
    const list = listRef.current;
    if (!list || loading || rows.length >= total) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MORE_THRESHOLD_PX) setPage((p) => p + 1);
  }

  function renderRow(employee: EmployeeRow, index: number) {
    const matricula = employee.links.find((l) => l.clientId === clientId && l.companyId === companyId)?.matricula;
    const meta = [matricula && `Matrícula ${matricula}`, employee.cpf && `CPF ${maskCpf(employee.cpf)}`].filter(Boolean).join(" · ");
    return (
      <div
        key={employee.id}
        role="option"
        aria-selected={index === cursor}
        data-index={index}
        className={index === cursor ? "emp-picker-row emp-picker-row-active" : "emp-picker-row"}
        onMouseDown={(ev) => ev.preventDefault()}
        onMouseEnter={() => setCursor(index)}
        onClick={() => pick(employee)}
      >
        <Avatar name={employee.name} />
        <span className="emp-picker-who">
          <span className="emp-picker-name">{employee.name}</span>
          {meta && <span className="emp-picker-meta">{meta}</span>}
        </span>
        {index === cursor && <CornerDownLeft size={13} className="emp-picker-muted" aria-hidden="true" />}
      </div>
    );
  }

  const query = debouncedSearch.trim();

  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={toggleOpen}
        disabled={disabled}
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
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
            className="emp-picker-popover employee-picker-box"
            role="dialog"
            aria-label="Vincular colaborador"
            style={{
              position: "fixed",
              top: coords.openUp ? undefined : coords.top,
              bottom: coords.openUp ? window.innerHeight - coords.top : undefined,
              left: coords.left,
              width: POPOVER_WIDTH,
              zIndex: 100,
            }}
          >
            {(rawName || contextLabel) && (
              <div className="employee-picker-context">
                {rawName && (
                  <div>
                    Na planilha: <b>{rawName}</b>
                  </div>
                )}
                {contextLabel && <div>Colaboradores de {contextLabel}</div>}
              </div>
            )}
            <div className="emp-picker-search">
              <Search size={14} className="emp-picker-muted" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Buscar por nome ou CPF"
                aria-label="Buscar por nome ou CPF"
              />
              <kbd>Esc</kbd>
            </div>

            <div ref={listRef} className="emp-picker-list" role="listbox" onScroll={handleListScroll}>
              {showSimilar && (
                <>
                  <div className="emp-picker-section">Parecidos com o nome da planilha</div>
                  {similar.map((e, i) => renderRow(e, i))}
                  <div className="emp-picker-section">Todos</div>
                </>
              )}
              {rest.map((e, i) => renderRow(e, (showSimilar ? similar.length : 0) + i))}
              {loading && rows.length === 0 && <p className="emp-picker-empty">Carregando...</p>}
              {!loading && flat.length === 0 && (
                <p className="emp-picker-empty">
                  {query ? `Ninguém com “${query}”${contextLabel ? ` em ${contextLabel}` : ""}.` : "Nenhum colaborador cadastrado."}
                </p>
              )}
            </div>

            <div className="emp-picker-footer">
              <span className="emp-picker-meta">
                {query
                  ? `${total} encontrado${total === 1 ? "" : "s"}`
                  : `${total} colaborador${total === 1 ? "" : "es"}`}
              </span>
              {onRegister && (
                <button
                  type="button"
                  className="emp-picker-clear employee-picker-new"
                  onClick={() => {
                    setOpen(false);
                    onRegister();
                  }}
                >
                  <Plus size={13} />
                  Cadastrar novo
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
