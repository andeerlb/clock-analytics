import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MONTH_NAMES, WEEKDAY_HEADER, gridStart, toIso, todayUtc } from "../lib/calendar";

const POPOVER_WIDTH = 248; // 15.5rem at the default 16px root size

/**
 * A single-date calendar popover — the same pt-BR/dark-theme month grid
 * `DateRangePicker` renders per panel (today's ring, the blanked-out
 * neighboring-month cells, the solid accent circle for the picked day),
 * pulled out on its own for inline single-date editing. Exists because the
 * native `<input type="date">` picker looks and behaves inconsistently
 * across OS/browsers (English month names, "Today"/"Clear" links, its own
 * unstyled popup) and clashes with the rest of the app.
 *
 * Rendered through a portal into `document.body`, positioned from
 * `anchorRef`'s own on-screen position, instead of `position: absolute`
 * inside the caller's own DOM location — a plain nested popover ended up
 * painted *behind* later rows when the trigger sits inside a table cell
 * (table rows don't establish the stacking context a naively-nested
 * absolute popover needs to reliably sit on top of later siblings). A
 * portal sidesteps that entirely.
 */
export default function DatePicker({
  value,
  anchorRef,
  onSelect,
  onClose,
}: {
  /** "YYYY-MM-DD", or "" to open on today's month. */
  value: string;
  anchorRef: RefObject<HTMLElement | null>;
  onSelect: (iso: string) => void;
  onClose: () => void;
}) {
  const [viewDate, setViewDate] = useState(() => new Date(`${value || toIso(todayUtc())}T00:00:00Z`));
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8),
    });
  }, [anchorRef]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClose, anchorRef]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A detached popover that no longer lines up with its trigger (because
  // the table underneath it scrolled) is worse than just closing it —
  // `true` catches scroll on any ancestor, not just `window`, since the
  // scrolling element here is usually `.table-scroll`, not the page itself.
  useEffect(() => {
    function onScroll() {
      onClose();
    }
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [onClose]);

  if (!pos) return null;

  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  const days: Date[] = [];
  const gridFirst = gridStart(year, month);
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridFirst);
    d.setUTCDate(gridFirst.getUTCDate() + i);
    days.push(d);
  }

  function changeMonth(delta: number) {
    setViewDate(new Date(Date.UTC(year, month + delta, 1)));
  }

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        background: "var(--card-bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "0.7rem",
        width: `${POPOVER_WIDTH}px`,
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
        zIndex: 1000,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.6rem" }}>
        <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={() => changeMonth(-1)} aria-label="Mês anterior">
          <ChevronLeft size={16} />
        </button>
        <strong style={{ fontSize: "0.9rem" }}>
          {MONTH_NAMES[month]} {year}
        </strong>
        <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={() => changeMonth(1)} aria-label="Próximo mês">
          <ChevronRight size={16} />
        </button>
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
          if (!inMonth) return <div key={iso} style={{ height: "2.2rem" }} />;

          const isSelected = iso === value;
          const isToday = iso === toIso(todayUtc());
          return (
            <div key={iso} style={{ display: "flex", justifyContent: "center", padding: "0.1rem 0" }}>
              <button
                type="button"
                onClick={() => onSelect(iso)}
                style={{
                  width: "2rem",
                  height: "2rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  fontSize: "0.82rem",
                  borderRadius: 999,
                  border: "none",
                  boxShadow: isToday && !isSelected ? "inset 0 0 0 1px var(--accent)" : "none",
                  fontWeight: isSelected || isToday ? 700 : 500,
                  background: isSelected ? "var(--accent)" : "transparent",
                  color: isSelected ? "var(--on-accent)" : isToday ? "var(--accent)" : "var(--text)",
                }}
              >
                {d.getUTCDate()}
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
