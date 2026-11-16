import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MONTH_NAMES, gridStart, toIso, todayUtc } from "../lib/calendar";

export interface PeriodPreset {
  label: string;
  start: string;
  end: string;
}

const SHORT_MONTHS = ["jan.", "fev.", "mar.", "abr.", "maio", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];
const WEEKDAY_LETTERS = ["D", "S", "T", "Q", "Q", "S", "S"];
const DAY_MS = 86_400_000;

function parseIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toSlash(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** "16/11/2026" (or "16/11/26", "1/11/2026") -> "2026-11-16"; null if it isn't a real date. */
function fromSlash(text: string): string | null {
  const match = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return toIso(date);
}

/** "1 a 16 de nov.", "28 de out. a 16 de nov.", with the year only when it isn't the current one. */
export function formatPeriodShort(start: string, end: string): string {
  const currentYear = todayUtc().getUTCFullYear();
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const year = (y: number) => (y === currentYear ? "" : ` ${y}`);
  if (start === end) return `${sd} de ${SHORT_MONTHS[sm - 1]}${year(sy)}`;
  if (sy === ey && sm === em) return `${sd} a ${ed} de ${SHORT_MONTHS[em - 1]}${year(ey)}`;
  if (sy === ey) return `${sd} de ${SHORT_MONTHS[sm - 1]} a ${ed} de ${SHORT_MONTHS[em - 1]}${year(ey)}`;
  return `${sd} de ${SHORT_MONTHS[sm - 1]} ${sy} a ${ed} de ${SHORT_MONTHS[em - 1]} ${ey}`;
}

function dayCount(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / DAY_MS) + 1;
}

function monthOf(iso: string): Date {
  const d = parseIso(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * The "Período" field of the filters panel. Closed, it reads like a
 * sentence ("Mês atual 1 a 16 de nov.", plus the day count); opened, it
 * grows into a box like the other pickers, with Início/Fim you can type
 * into, the shortcuts and a single month that fits the panel. The filter
 * only changes once both ends are set.
 */
export default function PeriodPicker({
  start,
  end,
  onChange,
  presets,
}: {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  presets: PeriodPreset[];
}) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);
  /** Which end the next calendar click sets. */
  const [editing, setEditing] = useState<"start" | "end">("start");
  const [view, setView] = useState(() => monthOf(end || toIso(todayUtc())));
  const [hover, setHover] = useState<string | null>(null);
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const todayIso = toIso(todayUtc());

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (open) boxRef.current?.focus({ preventScroll: true });
  }, [open]);

  // The typed fields follow the draft whenever it changes from elsewhere
  // (a click on the calendar, a shortcut).
  useEffect(() => setStartText(draftStart ? toSlash(draftStart) : ""), [draftStart]);
  useEffect(() => setEndText(draftEnd ? toSlash(draftEnd) : ""), [draftEnd]);

  function openBox() {
    setDraftStart(start);
    setDraftEnd(end);
    setEditing("start");
    setHover(null);
    setView(monthOf(end || toIso(todayUtc())));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function apply(nextStart: string, nextEnd: string) {
    const [a, b] = nextEnd < nextStart ? [nextEnd, nextStart] : [nextStart, nextEnd];
    setDraftStart(a);
    setDraftEnd(b);
    if (a !== start || b !== end) onChange(a, b);
  }

  function pickDay(iso: string) {
    if (editing === "start") {
      setDraftStart(iso);
      setDraftEnd("");
      setEditing("end");
    } else {
      apply(draftStart, iso);
      setEditing("start");
    }
    setHover(null);
  }

  function commitTyped(which: "start" | "end") {
    const parsed = fromSlash(which === "start" ? startText : endText);
    if (!parsed) {
      // Back to what was there: a half-typed date never reaches the filter.
      setStartText(draftStart ? toSlash(draftStart) : "");
      setEndText(draftEnd ? toSlash(draftEnd) : "");
      return;
    }
    const nextStart = which === "start" ? parsed : draftStart;
    const nextEnd = which === "end" ? parsed : draftEnd;
    setView(monthOf(parsed));
    if (nextStart && nextEnd) apply(nextStart, nextEnd);
    else if (which === "start") {
      setDraftStart(parsed);
      setEditing("end");
    } else setDraftEnd(parsed);
  }

  function handleBoxKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  const matchedPreset = presets.find((p) => p.start === start && p.end === end);
  const totalDays = start && end ? dayCount(start, end) : 0;

  // The 6x7 grid, trimmed to the weeks that actually hold this month.
  const year = view.getUTCFullYear();
  const month = view.getUTCMonth();
  const firstCell = gridStart(year, month);
  const cells: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(firstCell);
    d.setUTCDate(firstCell.getUTCDate() + i);
    if (i % 7 === 0 && i > 0 && d.getUTCMonth() !== month) break;
    cells.push(toIso(d));
  }

  // While picking the end, hovering previews the range from the start.
  const previewEnd = editing === "end" && draftStart && !draftEnd ? hover : null;
  const rangeLow = previewEnd && previewEnd < draftStart ? previewEnd : draftStart;
  const rangeHigh = previewEnd ? (previewEnd < draftStart ? draftStart : previewEnd) : draftEnd;

  return (
    <div className={`emp-picker emp-picker-full${open ? " emp-picker-open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="emp-picker-trigger period-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openBox())}
      >
        <CalendarDays size={15} className="emp-picker-muted" />
        <span className="period-trigger-main">
          {start && end ? (
            <>
              {matchedPreset && <span className="period-trigger-preset">{matchedPreset.label}</span>}
              <span className={matchedPreset ? "period-trigger-dates" : "period-trigger-dates period-trigger-dates-solo"}>
                {formatPeriodShort(start, end)}
              </span>
            </>
          ) : matchedPreset ? (
            // A preset with no dates ("Todo o período" on Pagamentos) reads like the other fields' "no filter" text.
            <span className="emp-picker-placeholder">{matchedPreset.label}</span>
          ) : (
            <span className="emp-picker-placeholder">Escolha o período</span>
          )}
        </span>
        {totalDays > 0 && (
          <span className="period-days">
            {totalDays} {totalDays === 1 ? "dia" : "dias"}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={boxRef}
          tabIndex={-1}
          role="dialog"
          aria-label="Período"
          className="emp-picker-popover emp-picker-popover-right period-box"
          onKeyDown={handleBoxKey}
        >
          <div className="period-ends">
            <label className={editing === "start" ? "period-end period-end-active" : "period-end"}>
              <span>Início</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="dd/mm/aaaa"
                value={startText}
                onFocus={() => setEditing("start")}
                onChange={(e) => setStartText(e.target.value)}
                onBlur={() => commitTyped("start")}
                onKeyDown={(e) => e.key === "Enter" && commitTyped("start")}
              />
            </label>
            <ArrowRight size={14} className="emp-picker-muted" />
            <label className={editing === "end" ? "period-end period-end-active" : "period-end"}>
              <span>Fim</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="dd/mm/aaaa"
                value={endText}
                onFocus={() => setEditing("end")}
                onChange={(e) => setEndText(e.target.value)}
                onBlur={() => commitTyped("end")}
                onKeyDown={(e) => e.key === "Enter" && commitTyped("end")}
              />
            </label>
          </div>

          <div className="period-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={p.start === draftStart && p.end === draftEnd ? "period-preset period-preset-active" : "period-preset"}
                onClick={() => {
                  apply(p.start, p.end);
                  setEditing("start");
                  if (p.end) setView(monthOf(p.end));
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="period-cal-head">
            <strong>
              {MONTH_NAMES[month]} de {year}
            </strong>
            <span className="period-nav">
              <button type="button" aria-label="Mês anterior" onClick={() => setView(new Date(Date.UTC(year, month - 1, 1)))}>
                <ChevronLeft size={15} />
              </button>
              <button type="button" aria-label="Próximo mês" onClick={() => setView(new Date(Date.UTC(year, month + 1, 1)))}>
                <ChevronRight size={15} />
              </button>
            </span>
          </div>

          <div className="period-grid" onMouseLeave={() => setHover(null)}>
            {WEEKDAY_LETTERS.map((letter, i) => (
              <span key={i} className="period-dow">
                {letter}
              </span>
            ))}
            {cells.map((iso) => {
              const classes = ["period-day"];
              if (parseIso(iso).getUTCMonth() !== month) classes.push("period-day-out");
              if (iso > todayIso) classes.push("period-day-future");
              if (iso === todayIso) classes.push("period-day-today");
              if (rangeLow && rangeHigh && iso >= rangeLow && iso <= rangeHigh) classes.push(previewEnd ? "period-day-preview" : "period-day-in");
              if (iso === rangeLow && (rangeHigh || previewEnd)) classes.push("period-day-start");
              if (iso === rangeHigh) classes.push("period-day-end");
              if (iso === draftStart && !draftEnd && !previewEnd) classes.push("period-day-start", "period-day-end");
              return (
                <span key={iso} className={classes.join(" ")}>
                  <button type="button" onClick={() => pickDay(iso)} onMouseEnter={() => setHover(iso)}>
                    {Number(iso.slice(8))}
                  </button>
                </span>
              );
            })}
          </div>

          <div className="emp-picker-footer">
            <span className="period-summary">
              {draftStart && draftEnd
                ? `${dayCount(draftStart, draftEnd)} ${dayCount(draftStart, draftEnd) === 1 ? "dia" : "dias"} · ${formatPeriodShort(draftStart, draftEnd)}`
                : "Escolha o fim do período"}
            </span>
            <button type="button" className="emp-picker-done" onClick={close}>
              Pronto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
