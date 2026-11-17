import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { colorForName } from "../lib/avatar";

export interface PickerOption {
  id: string;
  label: string;
  /** Second line, e.g. a CNPJ. */
  meta?: string;
  /** Options sharing a group are listed under its name; keep them adjacent. */
  group?: string;
}

/** Below this many options the box has no search, only a title. */
const SEARCH_THRESHOLD = 7;
const STACK_SIZE = 3;
const WINDOW_MARGIN_PX = 12;
const MIN_LIST_HEIGHT_PX = 180;

function tileInitials(label: string): string {
  const words = label.split(/\s+/).filter((w) => w && !/^(de|da|do|das|dos|e|-|&)$/i.test(w));
  if (words.length === 0) return "?";
  return (words[0][0] + (words[1]?.[0] ?? words[0][1] ?? "")).toUpperCase();
}

function Tile({ label }: { label: string }) {
  return (
    <span className="emp-picker-avatar picker-tile" style={{ background: colorForName(label) }} aria-hidden="true">
      {tileInitials(label)}
    </span>
  );
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * A multi-select for a short, fully loaded list (empresas, clientes) with
 * the same look and behavior as the Colaborador picker: the field grows
 * into the box, the list fits the room below, arrow keys move, Enter
 * toggles, Esc closes. Search only shows up once the list is long enough
 * to need it.
 *
 * `single` turns it into a one-of-many picker (e.g. the payment import's
 * Template): picking a row closes the box, there's no "select all"/"clear"
 * footer, and the closed field shows the chosen option's `meta` on its
 * right.
 */
export default function OptionPicker({
  options,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  title,
  allPlaceholder,
  searchPlaceholder,
  selectAllLabel,
  align = "right",
  single = false,
  showTiles = true,
}: {
  options: PickerOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  /** Shown at the top of the box when there's no search. */
  title: string;
  /** Closed field text when nothing is selected, e.g. "Todas as empresas". */
  allPlaceholder: string;
  searchPlaceholder: string;
  selectAllLabel?: string;
  align?: "left" | "right";
  single?: boolean;
  /** The colored initials before each option — off for short fixed lists (operators, "antes/depois"). */
  showTiles?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [listMaxHeight, setListMaxHeight] = useState<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  const searchable = options.length >= SEARCH_THRESHOLD;
  const query = normalize(search.trim());
  const visible = query ? options.filter((o) => normalize(o.label).includes(query) || (o.meta && normalize(o.meta).includes(query))) : options;
  const chosen = options.filter((o) => selected.has(o.id));

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    else boxRef.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function fit() {
      const list = listRef.current;
      if (!list) return;
      const footerHeight = footerRef.current?.offsetHeight ?? 0;
      // Inside a side panel or sheet (Filtros) the box ends where its scrolling area does, not at the window's bottom.
      const area = list.closest(".side-panel-body, .drawer-body");
      const bottom = area ? Math.min(window.innerHeight, area.getBoundingClientRect().bottom) : window.innerHeight;
      const room = bottom - list.getBoundingClientRect().top - footerHeight - WINDOW_MARGIN_PX;
      setListMaxHeight(Math.max(MIN_LIST_HEIGHT_PX, Math.floor(room)));
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function openBox() {
    setSearch("");
    setCursor(-1);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pick(id: string) {
    onToggle(id);
    if (single) close();
  }

  function handleKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(visible.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" || (e.key === " " && !searchable)) {
      const option = visible[cursor];
      if (option) {
        e.preventDefault();
        pick(option.id);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  let summary: string;
  if (chosen.length === 0) summary = allPlaceholder;
  else if (chosen.length === 1) summary = chosen[0].label;
  else summary = `${chosen[0].label} e mais ${chosen.length - 1}`;

  let lastGroup: string | undefined;

  return (
    <div className={`emp-picker emp-picker-full${open ? " emp-picker-open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="emp-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openBox())}
      >
        {showTiles && chosen.length > 0 && (
          <span className="emp-picker-stack">
            {chosen.slice(0, STACK_SIZE).map((o) => (
              <Tile key={o.id} label={o.label} />
            ))}
          </span>
        )}
        <span className={chosen.length === 0 ? "emp-picker-summary emp-picker-placeholder" : "emp-picker-summary"}>{summary}</span>
        {single && chosen[0]?.meta && <span className="emp-picker-muted emp-picker-trigger-meta">{chosen[0].meta}</span>}
        <ChevronsUpDown size={14} className="emp-picker-muted" />
      </button>

      {open && (
        <div ref={boxRef} tabIndex={-1} className={`emp-picker-popover emp-picker-popover-${align}`} onKeyDown={searchable ? undefined : handleKey}>
          {searchable ? (
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
                onKeyDown={handleKey}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
              <kbd>Esc</kbd>
            </div>
          ) : (
            <div className="emp-picker-search picker-title">
              <span>{title}</span>
              <kbd>Esc</kbd>
            </div>
          )}

          <div ref={listRef} className="emp-picker-list" style={{ maxHeight: listMaxHeight }} role="listbox" aria-multiselectable={!single}>
            {visible.map((o, index) => {
              const header = o.group !== undefined && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              const isSelected = selected.has(o.id);
              return (
                <div key={o.id}>
                  {header && <div className="emp-picker-section">{header}</div>}
                  <div
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    className={index === cursor ? "emp-picker-row emp-picker-row-active" : "emp-picker-row"}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setCursor(index);
                      pick(o.id);
                    }}
                  >
                    {showTiles && <Tile label={o.label} />}
                    <span className="emp-picker-who">
                      <span className="emp-picker-name">{o.label}</span>
                      {o.meta && <span className="emp-picker-meta">{o.meta}</span>}
                    </span>
                    <span className="emp-picker-tick" aria-hidden="true">
                      <Check size={11} strokeWidth={3.5} />
                    </span>
                  </div>
                </div>
              );
            })}
            {visible.length === 0 && <p className="emp-picker-empty">{search ? `Nada encontrado com “${search}”.` : "Nenhuma opção cadastrada."}</p>}
          </div>

          {!single && (
            <div ref={footerRef} className="emp-picker-footer">
              <span className="picker-footer-actions">
                <button type="button" className="emp-picker-clear" onClick={onSelectAll} disabled={options.length === 0 || chosen.length === options.length}>
                  {selectAllLabel}
                </button>
                <button type="button" className="emp-picker-clear" onClick={onClear} disabled={chosen.length === 0}>
                  Limpar seleção
                </button>
              </span>
              <button type="button" className="emp-picker-done" onClick={close}>
                Pronto
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
