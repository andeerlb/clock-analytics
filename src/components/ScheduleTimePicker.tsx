import { ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ScheduleTimeFilter, ScheduleTimeRule } from "../lib/types";

const DAY_MINUTES = 1440;
const STEP_MINUTES = 15;
const QUICK_TIMES = [360, 720, 1080, 1320];
/** Sample turnos for the "Exemplos" list — one by day, one in the afternoon, one across midnight. */
const EXAMPLES: [number, number][] = [
  [360, 840],
  [480, 1020],
  [1320, 360],
];
const DEFAULT_FILTER = { edge: "start" as const, dir: "after" as const, minutes: 720 };

type Edge = "start" | "end";
type Dir = "before" | "after";

function toMinutes(time: string): number | null {
  const m = time.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parts(filter: ScheduleTimeFilter | null): { edge: Edge; dir: Dir; minutes: number } {
  if (!filter) return DEFAULT_FILTER;
  return {
    edge: filter.rule.startsWith("start") ? "start" : "end",
    dir: filter.rule.endsWith("before") ? "before" : "after",
    minutes: toMinutes(filter.time) ?? DEFAULT_FILTER.minutes,
  };
}

/** "Começam depois das" — the closed field and the bar chip read the filter like this. */
export function scheduleTimeSentence(filter: ScheduleTimeFilter): string {
  const p = parts(filter);
  return `${p.edge === "start" ? "Começam" : "Terminam"} ${p.dir === "before" ? "antes" : "depois"} das ${filter.time}`;
}

/** The part of the day that passes the filter, as left/width percentages of the 24h ruler. */
function passingBand(dir: Dir, minutes: number): { left: number; width: number } {
  const pct = (minutes / DAY_MINUTES) * 100;
  return dir === "before" ? { left: 0, width: pct } : { left: pct, width: 100 - pct };
}

/**
 * The "Horário" filter of the Filtros panel: a sentence to complete
 * ("Turnos que começam depois das 12:00"), a 24h ruler showing which part
 * of the day passes, shortcuts and three sample turnos. Applied right away,
 * like the other fields; a typed time only counts once complete.
 *
 * Same comparison as `scheduleTimeConditionSql`: the turno's start (or end)
 * time of day against the reference, so a 22:00–06:00 turno ends at 06:00.
 */
export default function ScheduleTimePicker({
  value,
  onChange,
}: {
  value: ScheduleTimeFilter | null;
  onChange: (next: ScheduleTimeFilter | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // What the box shows; it reaches the filter on the first change.
  const [draft, setDraft] = useState(() => parts(value));
  const [timeText, setTimeText] = useState(() => toTime(parts(value).minutes));
  const [timeInvalid, setTimeInvalid] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (open) timeRef.current?.focus({ preventScroll: true });
  }, [open]);

  function openBox() {
    const p = parts(value);
    setDraft(p);
    setTimeText(toTime(p.minutes));
    setTimeInvalid(false);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function commit(next: { edge: Edge; dir: Dir; minutes: number }) {
    setDraft(next);
    if (document.activeElement !== timeRef.current) setTimeText(toTime(next.minutes));
    onChange({ rule: `${next.edge}-${next.dir}` as ScheduleTimeRule, time: toTime(next.minutes) });
  }

  function handleTimeInput(text: string) {
    let digits = text.replace(/\D/g, "").slice(0, 4);
    if (digits.length > 2) digits = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    setTimeText(digits);
    const minutes = toMinutes(digits);
    setTimeInvalid(digits.length === 5 && minutes === null);
    if (minutes !== null) commit({ ...draft, minutes });
  }

  function minutesFromPointer(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const snapped = Math.round(((x / rect.width) * DAY_MINUTES) / STEP_MINUTES) * STEP_MINUTES;
    return Math.min(DAY_MINUTES - STEP_MINUTES, snapped);
  }

  function handleTrackKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? STEP_MINUTES : -STEP_MINUTES;
    commit({ ...draft, minutes: Math.min(DAY_MINUTES - STEP_MINUTES, Math.max(0, draft.minutes + delta)) });
  }

  function handleBoxKey(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function passes([start, end]: [number, number]) {
    const t = draft.edge === "start" ? start : end;
    return draft.dir === "before" ? t < draft.minutes : t > draft.minutes;
  }

  const closedBand = value ? passingBand(parts(value).dir, parts(value).minutes) : null;
  const band = passingBand(draft.dir, draft.minutes);

  return (
    <div className={`emp-picker emp-picker-full${open ? " emp-picker-open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="emp-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openBox())}
      >
        {value ? (
          <span className="emp-picker-summary">
            {scheduleTimeSentence(value).replace(/ das .*$/, " das ")}
            <b className="schedule-trigger-time">{value.time}</b>
          </span>
        ) : (
          <span className="emp-picker-summary emp-picker-placeholder">Qualquer horário</span>
        )}
        {closedBand && (
          <span className="schedule-mini" aria-hidden="true">
            <i style={{ left: `${closedBand.left}%`, width: `${closedBand.width}%` }} />
          </span>
        )}
        <ChevronsUpDown size={14} className="emp-picker-muted" />
      </button>

      {open && (
        <div className="emp-picker-popover emp-picker-popover-right schedule-box" role="dialog" aria-label="Horário do turno" onKeyDown={handleBoxKey}>
          <div className="emp-picker-search picker-title">
            <span>Horário do turno</span>
            <kbd>Esc</kbd>
          </div>

          <div className="schedule-body">
            <div className="schedule-sentence">
              <span>Turnos que</span>
              <span className="schedule-seg" role="group" aria-label="Início ou fim do turno">
                {(["start", "end"] as const).map((edge) => (
                  <button key={edge} type="button" aria-pressed={draft.edge === edge} onClick={() => commit({ ...draft, edge })}>
                    {edge === "start" ? "começam" : "terminam"}
                  </button>
                ))}
              </span>
              <span className="schedule-seg" role="group" aria-label="Antes ou depois">
                {(["before", "after"] as const).map((dir) => (
                  <button key={dir} type="button" aria-pressed={draft.dir === dir} onClick={() => commit({ ...draft, dir })}>
                    {dir === "before" ? "antes" : "depois"}
                  </button>
                ))}
              </span>
              <span>das</span>
              <input
                ref={timeRef}
                type="text"
                inputMode="numeric"
                maxLength={5}
                className={timeInvalid ? "schedule-time schedule-time-invalid" : "schedule-time"}
                aria-label="Horário de referência"
                aria-invalid={timeInvalid}
                value={timeText}
                onChange={(e) => handleTimeInput(e.target.value)}
                onBlur={() => {
                  setTimeInvalid(false);
                  setTimeText(toTime(draft.minutes));
                }}
              />
            </div>

            <div className="schedule-ruler">
              <div
                ref={trackRef}
                className="schedule-track"
                role="slider"
                tabIndex={0}
                aria-label="Horário de referência"
                aria-valuemin={0}
                aria-valuemax={DAY_MINUTES - STEP_MINUTES}
                aria-valuenow={draft.minutes}
                aria-valuetext={toTime(draft.minutes)}
                onKeyDown={handleTrackKey}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  commit({ ...draft, minutes: minutesFromPointer(e) });
                }}
                onPointerMove={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) commit({ ...draft, minutes: minutesFromPointer(e) });
                }}
              >
                {/* Madrugada: 22h to 6h. */}
                <i className="schedule-night" style={{ left: 0, width: "25%" }} />
                <i className="schedule-night" style={{ left: "91.6667%", width: "8.3333%" }} />
                <i className="schedule-band" style={{ left: `${band.left}%`, width: `${band.width}%` }} />
                <i className="schedule-marker" style={{ left: `${(draft.minutes / DAY_MINUTES) * 100}%` }} />
              </div>
              <div className="schedule-ticks" aria-hidden="true">
                <span>00h</span>
                <span>06h</span>
                <span>12h</span>
                <span>18h</span>
                <span>24h</span>
              </div>
              <span className="schedule-legend">
                Entram os turnos que <b>{draft.edge === "start" ? "começam" : "terminam"}</b> na faixa clara.
              </span>
            </div>

            <div className="schedule-quick">
              {QUICK_TIMES.map((m) => (
                <button key={m} type="button" className={m === draft.minutes ? "period-preset period-preset-active" : "period-preset"} onClick={() => commit({ ...draft, minutes: m })}>
                  {toTime(m)}
                </button>
              ))}
            </div>

            <div className="schedule-examples">
              <span className="emp-picker-section">Exemplos</span>
              {EXAMPLES.map((ex) => {
                const ok = passes(ex);
                return (
                  <span key={ex.join("-")} className={ok ? "schedule-example schedule-example-in" : "schedule-example"}>
                    <span className="schedule-example-mark" aria-hidden="true">
                      ✓
                    </span>
                    Turno {toTime(ex[0])} – {toTime(ex[1])} {ok ? "entra" : "fica de fora"}
                  </span>
                );
              })}
              <span className="schedule-note">Turnos sem horário ficam de fora.</span>
            </div>
          </div>

          <div className="emp-picker-footer">
            <button
              type="button"
              className="emp-picker-clear"
              onClick={() => {
                onChange(null);
                close();
              }}
              disabled={!value}
            >
              Limpar
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
