import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MONTH_NAMES, WEEKDAY_HEADER, gridStart, toIso, todayUtc } from "../lib/calendar";
import { formatDateSlash } from "../lib/format";

/**
 * A calendar date picker in pt-BR — the native `<input type="date">`
 * picker's locale follows the OS/webview, not the app, and on Linux
 * (WebKitGTK) that's not stylable via CSS at all, so it shows up in English
 * regardless of the rest of the UI. This renders its own popover instead.
 * `value`/`onChange` use the same ISO ("YYYY-MM-DD") shape the native input
 * did, so callers don't need to change how they store the date.
 */
export default function DatePicker({
  id,
  value,
  onChange,
  placeholder = "Selecionar",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => (value ? new Date(`${value}T00:00:00Z`) : todayUtc()));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) setViewDate(new Date(`${value}T00:00:00Z`));
  }, [value]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();

  const days: Date[] = [];
  const start = gridStart(year, month);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    days.push(d);
  }

  function changeMonth(delta: number) {
    setViewDate(new Date(Date.UTC(year, month + delta, 1)));
  }

  function selectDay(d: Date) {
    onChange(toIso(d));
    setOpen(false);
  }

  return (
    <div style={{ position: "relative" }} ref={rootRef}>
      <button
        type="button"
        id={id}
        className="secondary"
        style={{ width: "100%", justifyContent: "flex-start", display: "flex", alignItems: "center" }}
        onClick={() => setOpen((o) => !o)}
      >
        <Calendar size={15} style={{ marginRight: "0.5rem", flexShrink: 0 }} />
        {value ? formatDateSlash(value) : <span className="muted">{placeholder}</span>}
      </button>
      {open && (
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
              const selected = iso === value;
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

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.6rem" }}>
            <button
              type="button"
              className="ghost"
              style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
              onClick={() => selectDay(todayUtc())}
            >
              Hoje
            </button>
            <button
              type="button"
              className="ghost"
              style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Limpar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
