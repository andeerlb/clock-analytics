import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MONTH_NAMES, WEEKDAY_HEADER, addMonthsIso, gridStart, toIso, todayUtc } from "../lib/calendar";
import { formatDateSlash } from "../lib/format";

type Field = "start" | "end";

const segmentStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  border: "none",
  boxShadow: "none",
  background: "transparent",
  color: "var(--text)",
  fontSize: "0.92em",
  padding: "0.55em 0.7em",
};

/**
 * "De"/"Até" as one visual control instead of two unrelated inputs — a
 * single bordered pill with both dates and a "→" between them. Always has
 * a value on both sides (no clearing to empty): this drives report
 * generation, which needs a bounded period to work with, not an optional
 * narrowing filter. Picking a date on either side keeps the range valid
 * and capped at one calendar month by pushing the other side along with
 * it, rather than rejecting the pick.
 */
export default function DateRangePicker({
  startValue,
  endValue,
  onChange,
}: {
  startValue: string;
  endValue: string;
  onChange: (start: string, end: string) => void;
}) {
  const [openField, setOpenField] = useState<Field | null>(null);
  const [viewDate, setViewDate] = useState(() => todayUtc());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenField(null);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function openPicker(field: Field) {
    setViewDate(new Date(`${(field === "start" ? startValue : endValue) || toIso(todayUtc())}T00:00:00Z`));
    setOpenField((f) => (f === field ? null : field));
  }

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

  function selectDay(d: Date) {
    const iso = toIso(d);
    if (openField === "start") {
      let nextEnd = endValue < iso ? iso : endValue;
      const maxEnd = addMonthsIso(iso, 1);
      if (nextEnd > maxEnd) nextEnd = maxEnd;
      onChange(iso, nextEnd);
      // Picking the start is naturally followed by picking the end — keep
      // the popover open and hand it straight to the "Até" side instead of
      // making the user reopen it themselves.
      setViewDate(new Date(`${nextEnd}T00:00:00Z`));
      setOpenField("end");
    } else {
      let nextStart = startValue > iso ? iso : startValue;
      const minStart = addMonthsIso(iso, -1);
      if (nextStart < minStart) nextStart = minStart;
      onChange(nextStart, iso);
      setOpenField(null);
    }
  }

  const selectedValue = openField === "start" ? startValue : endValue;

  return (
    <div style={{ position: "relative" }} ref={rootRef}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--surface-container)",
        }}
      >
        <Calendar size={14} style={{ marginLeft: "0.7em", flexShrink: 0, color: "var(--text-muted)" }} />
        <button type="button" onClick={() => openPicker("start")} style={segmentStyle}>
          {formatDateSlash(startValue)}
        </button>
        <span className="muted">→</span>
        <button type="button" onClick={() => openPicker("end")} style={segmentStyle}>
          {formatDateSlash(endValue)}
        </button>
      </div>
      {openField && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 0.4rem)",
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.7rem",
            width: "17.5rem",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
            zIndex: 20,
          }}
        >
          <div className="muted" style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
            {openField === "start" ? "Data inicial" : "Data final"} · período de até 1 mês
          </div>

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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "0.15rem", marginBottom: "0.2rem" }}>
            {WEEKDAY_HEADER.map((w) => (
              <div key={w} className="muted" style={{ textAlign: "center", fontSize: "0.72rem" }}>
                {w}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "0.15rem" }}>
            {days.map((d) => {
              const iso = toIso(d);
              const inMonth = d.getUTCMonth() === month;
              const selected = iso === selectedValue;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => selectDay(d)}
                  style={{
                    padding: "0.4rem 0",
                    fontSize: "0.82rem",
                    borderRadius: 6,
                    border: "none",
                    boxShadow: "none",
                    fontWeight: selected ? 700 : 500,
                    background: selected ? "var(--accent)" : "transparent",
                    color: selected ? "var(--on-accent)" : inMonth ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  {d.getUTCDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
