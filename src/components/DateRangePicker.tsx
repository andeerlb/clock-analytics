import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MONTH_NAMES, WEEKDAY_HEADER, addMonthsIso, gridStart, toIso, todayUtc } from "../lib/calendar";
import { formatDateSlash } from "../lib/format";

type Phase = "start" | "end";
type Bounds = [string, string];

const PANEL_WIDTH = "15.5rem";

/**
 * A single trigger opens one popover with two linked month calendars (like
 * MUI X's range picker) — one pair of arrows on the outer edges advances
 * both panels together, and hovering after picking the start previews the
 * range before the second click commits it. Replaces the earlier two
 * separate "De"/"Até" buttons, which read as unrelated fields rather than
 * one range.
 *
 * `maxSpanMonths`, when set, keeps the range valid and capped by pushing
 * the other side along with whichever side was just picked — used where a
 * bounded period is a hard requirement (report generation), not just a
 * narrowing filter. Since both sides are always non-empty in that mode,
 * `onChange` fires right after picking the start.
 *
 * Without `maxSpanMonths`, picking a start is only held as a local draft
 * (not reported via `onChange`) until the end is picked too, so a consumer
 * that filters/queries on every change (like a table's period filter)
 * doesn't act on a half-picked range. Reopening an already-complete range
 * starts a fresh pick on the next click, same as MUI's behavior.
 */
export default function DateRangePicker({
  startValue,
  endValue,
  onChange,
  maxSpanMonths,
  allowClear = true,
  startPlaceholder = "dd/mm/aaaa",
  endPlaceholder = "dd/mm/aaaa",
}: {
  startValue: string;
  endValue: string;
  onChange: (start: string, end: string) => void;
  maxSpanMonths?: number;
  allowClear?: boolean;
  startPlaceholder?: string;
  endPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("start");
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [hoverIso, setHoverIso] = useState<string | null>(null);
  const [leftMonth, setLeftMonth] = useState(() => todayUtc());
  // Anchored to whichever side has room — a field near the right edge of
  // the screen (like the last one in a filter row) would otherwise have
  // its popover run off-screen and get clipped by the window.
  const [align, setAlign] = useState<"left" | "right">("left");
  const rootRef = useRef<HTMLDivElement>(null);
  const POPOVER_WIDTH = 560;

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function openPicker() {
    if (open) {
      setOpen(false);
      return;
    }
    setDraftStart(startValue);
    setDraftEnd(endValue);
    setPhase(startValue && !endValue ? "end" : "start");
    setHoverIso(null);
    const base = startValue || toIso(todayUtc());
    setLeftMonth(new Date(`${base}T00:00:00Z`));
    if (rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setAlign(rect.left + POPOVER_WIDTH > window.innerWidth ? "right" : "left");
    }
    setOpen(true);
  }

  function changeMonths(delta: number) {
    setLeftMonth((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)));
  }

  function selectDay(iso: string) {
    if (phase === "start") {
      if (maxSpanMonths !== undefined) {
        let nextEnd = draftEnd || iso;
        if (nextEnd < iso) nextEnd = iso;
        const maxEnd = addMonthsIso(iso, maxSpanMonths);
        if (nextEnd > maxEnd) nextEnd = maxEnd;
        setDraftStart(iso);
        setDraftEnd(nextEnd);
        onChange(iso, nextEnd);
      } else {
        setDraftStart(iso);
        setDraftEnd("");
      }
      setLeftMonth(new Date(`${iso}T00:00:00Z`));
      setPhase("end");
    } else {
      let s = draftStart;
      let e = iso;
      if (e < s) [s, e] = [e, s];
      if (maxSpanMonths !== undefined) {
        const minStart = addMonthsIso(e, -maxSpanMonths);
        if (s < minStart) s = minStart;
      }
      setDraftStart(s);
      setDraftEnd(e);
      setHoverIso(null);
      onChange(s, e);
      setOpen(false);
    }
  }

  function clear() {
    onChange("", "");
    setOpen(false);
  }

  // The current preview range: the committed draft, or — while the end is
  // still being picked — the start extended to whichever day is hovered.
  const bounds: Bounds | null = draftStart
    ? draftStart <= (draftEnd || hoverIso || draftStart)
      ? [draftStart, draftEnd || hoverIso || draftStart]
      : [draftEnd || hoverIso || draftStart, draftStart]
    : null;

  const rightMonth = new Date(Date.UTC(leftMonth.getUTCFullYear(), leftMonth.getUTCMonth() + 1, 1));

  const displayStart = startValue ? formatDateSlash(startValue) : startPlaceholder;
  const displayEnd = endValue ? formatDateSlash(endValue) : endPlaceholder;

  return (
    <div style={{ position: "relative" }} ref={rootRef}>
      <button
        type="button"
        onClick={openPicker}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5em",
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--surface-container)",
          color: "var(--text)",
          fontSize: "0.92em",
          padding: "0.55em 0.7em",
          boxShadow: "none",
        }}
      >
        <Calendar size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
        <span className={startValue ? undefined : "muted"}>{displayStart}</span>
        <span className="muted">→</span>
        <span className={endValue ? undefined : "muted"}>{displayEnd}</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            left: align === "left" ? 0 : "auto",
            right: align === "left" ? "auto" : 0,
            top: "calc(100% + 0.4rem)",
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.7rem",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
            zIndex: 20,
          }}
        >
          {maxSpanMonths !== undefined && (
            <div className="muted" style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
              Período de até {maxSpanMonths} mês{maxSpanMonths > 1 ? "es" : ""}
            </div>
          )}
          <div style={{ display: "flex", gap: "1rem" }}>
            <MonthPanel
              monthDate={leftMonth}
              bounds={bounds}
              hoverIso={hoverIso}
              onPrev={() => changeMonths(-1)}
              onSelect={selectDay}
              onHover={setHoverIso}
              showPrev
            />
            <MonthPanel
              monthDate={rightMonth}
              bounds={bounds}
              hoverIso={hoverIso}
              onNext={() => changeMonths(1)}
              onSelect={selectDay}
              onHover={setHoverIso}
              showNext
            />
          </div>
          {allowClear && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.4rem" }}>
              <button type="button" className="ghost" style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }} onClick={clear}>
                Limpar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MonthPanel({
  monthDate,
  bounds,
  hoverIso,
  onPrev,
  onNext,
  onSelect,
  onHover,
  showPrev,
  showNext,
}: {
  monthDate: Date;
  bounds: Bounds | null;
  hoverIso: string | null;
  onPrev?: () => void;
  onNext?: () => void;
  onSelect: (iso: string) => void;
  onHover: (iso: string | null) => void;
  showPrev?: boolean;
  showNext?: boolean;
}) {
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const days: Date[] = [];
  const gridFirst = gridStart(year, month);
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridFirst);
    d.setUTCDate(gridFirst.getUTCDate() + i);
    days.push(d);
  }
  const todayIso = toIso(todayUtc());

  return (
    <div style={{ width: PANEL_WIDTH }} onMouseLeave={() => onHover(null)}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.6rem" }}>
        {showPrev ? (
          <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={onPrev} aria-label="Mês anterior">
            <ChevronLeft size={16} />
          </button>
        ) : (
          <span style={{ width: "2rem" }} />
        )}
        <strong style={{ fontSize: "0.9rem" }}>
          {MONTH_NAMES[month]} {year}
        </strong>
        {showNext ? (
          <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={onNext} aria-label="Próximo mês">
            <ChevronRight size={16} />
          </button>
        ) : (
          <span style={{ width: "2rem" }} />
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: "0.2rem" }}>
        {WEEKDAY_HEADER.map((w) => (
          <div key={w} className="muted" style={{ textAlign: "center", fontSize: "0.72rem" }}>
            {w}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {days.map((d) => {
          const iso = toIso(d);
          const inMonth = d.getUTCMonth() === month;
          const dow = d.getUTCDay();

          // Leading/trailing days from the neighboring month are left blank
          // instead of shown dimmed — with two linked panels, that month is
          // already visible in the other calendar, so repeating its days
          // here (and having the range band bleed into them) only confuses
          // which panel a click actually lands in.
          if (!inMonth) return <div key={iso} style={{ height: "2.2rem" }} />;

          const inBounds = bounds && iso >= bounds[0] && iso <= bounds[1];
          const isEndpoint = bounds && (iso === bounds[0] || iso === bounds[1]);
          const isRange = bounds && bounds[0] !== bounds[1];
          const showBand = isRange && inBounds;
          const roundLeft = dow === 0 || (bounds && iso === bounds[0]);
          const roundRight = dow === 6 || (bounds && iso === bounds[1]);
          const isToday = iso === todayIso;
          const isHovered = iso === hoverIso;

          return (
            <div
              key={iso}
              style={{
                background: showBand ? "var(--accent-soft)" : "transparent",
                borderRadius: showBand
                  ? `${roundLeft ? "999px" : "0"} ${roundRight ? "999px" : "0"} ${roundRight ? "999px" : "0"} ${roundLeft ? "999px" : "0"}`
                  : 0,
                display: "flex",
                justifyContent: "center",
                padding: "0.1rem 0",
              }}
            >
              <button
                type="button"
                onClick={() => onSelect(iso)}
                onMouseEnter={() => onHover(iso)}
                style={{
                  width: "2rem",
                  height: "2rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  lineHeight: 1,
                  fontSize: "0.82rem",
                  borderRadius: 999,
                  border: "none",
                  boxShadow: isToday && !isEndpoint ? "inset 0 0 0 1px var(--accent)" : "none",
                  fontWeight: isEndpoint || isToday ? 700 : 500,
                  background: isEndpoint ? "var(--accent)" : isHovered ? "var(--surface-container)" : "transparent",
                  color: isEndpoint ? "var(--on-accent)" : isToday ? "var(--accent)" : "var(--text)",
                }}
              >
                {d.getUTCDate()}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
