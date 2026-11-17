import { ArrowRight, Moon, Sun } from "lucide-react";
import { useState } from "react";
import TimeField from "./TimeField";
import { classifyShiftPeriod, parseTimeToMinutes, shiftDurationMinutes } from "../lib/format";
import type { NightShiftRule } from "../lib/types";

/** CLT's night window. */
const CLT_START = "22:00";
const CLT_END = "05:00";

/**
 * The five rules as short choices, each with a one-line explanation and a
 * mini diagram (shift bar over the night band; `mark` points at the edge
 * the rule looks at).
 */
const RULES: { id: NightShiftRule; title: string; text: string; shift: [number, number]; mark?: "start" | "end"; common?: boolean }[] = [
  { id: "start-in-range", title: "Começa na noite", text: "O início do turno cai dentro do horário noturno.", shift: [44, 74], mark: "start" },
  { id: "end-in-range", title: "Termina na noite", text: "O fim do turno cai dentro do horário noturno.", shift: [30, 60], mark: "end" },
  { id: "start-or-end-in-range", title: "Começa ou termina na noite", text: "Basta o início ou o fim cair no horário noturno.", shift: [30, 60], mark: "end" },
  { id: "overlap", title: "Encosta na noite", text: "Qualquer pedaço do turno passa pelo horário noturno.", shift: [35, 55], common: true },
  { id: "majority-overlap", title: "Metade ou mais na noite", text: "Pelo menos metade das horas do turno são no horário noturno.", shift: [52, 82] },
];

/** Position (0–100%) on a 24h line that starts at 12:00, so a night window crossing midnight stays in one piece. */
function linePos(minutes: number): number {
  return ((((minutes - 720) % 1440) + 1440) % 1440) / 1440 * 100;
}

/** One or two [left, right] segments (a range crossing the line's 12:00 edge splits in two). */
function lineSegments(start: number, end: number): [number, number][] {
  const a = linePos(start);
  const b = linePos(end);
  if (start === end) return [];
  return b > a ? [[a, b]] : [[a, 100], [0, b]];
}

function formatDuration(minutes: number): string {
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? String(minutes % 60).padStart(2, "0") : ""}`;
}

/** Minutes of [shiftStart, shiftEnd) that fall in the night window — for the test's explanation line only. */
function nightMinutes(shiftStart: number, shiftEnd: number, nightStart: number, nightEnd: number): number {
  const duration = shiftDurationMinutes(shiftStart, shiftEnd);
  let count = 0;
  for (let k = 0; k < duration; k++) {
    const m = (shiftStart + k) % 1440;
    if (nightStart <= nightEnd ? m >= nightStart && m < nightEnd : m >= nightStart || m < nightEnd) count++;
  }
  return count;
}

/**
 * "Horário noturno": the night window (with a CLT shortcut and a 24h
 * timeline), the rule that decides when a shift counts as noturno (five
 * choices with mini diagrams) and "Testar um turno", which runs the real
 * `classifyShiftPeriod`. Shared by `CompanyFormPage` and `ClientFormPage`
 * (the client's own override). `readOnly` shows the same summary without
 * controls (a client looking at the company's window it inherits).
 */
export default function NightShiftRuleFields({
  nightStartTime,
  nightEndTime,
  nightShiftRule,
  onChange,
  idPrefix,
  readOnly = false,
}: {
  nightStartTime: string;
  nightEndTime: string;
  nightShiftRule: NightShiftRule;
  onChange?: (patch: Partial<{ nightStartTime: string; nightEndTime: string; nightShiftRule: NightShiftRule }>) => void;
  idPrefix: string;
  readOnly?: boolean;
}) {
  const [testStart, setTestStart] = useState("20:00");
  const [testEnd, setTestEnd] = useState("02:00");

  const ns = parseTimeToMinutes(nightStartTime);
  const ne = parseTimeToMinutes(nightEndTime);
  const ts = parseTimeToMinutes(testStart);
  const te = parseTimeToMinutes(testEnd);
  const rule = RULES.find((r) => r.id === nightShiftRule) ?? RULES[3];

  const timeline = (
    <div className="ns-timeline">
      <div className="ns-bar">
        {ns !== null && ne !== null && lineSegments(ns, ne).map(([l, r], i) => <span key={`n${i}`} className="ns-night" style={{ left: `${l}%`, width: `${r - l}%` }} />)}
        {!readOnly && ts !== null && te !== null && lineSegments(ts, te).map(([l, r], i) => <span key={`s${i}`} className="ns-shift" style={{ left: `${l}%`, width: `${Math.max(0.6, r - l)}%` }} />)}
      </div>
      <div className="ns-axis">
        <span>12:00</span>
        <span>18:00</span>
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
      </div>
      <div className="ns-legend">
        <span><i className="ns-legend-night" />Noturno</span>
        <span><i className="ns-legend-day" />Diurno</span>
        {!readOnly && <span><i className="ns-legend-shift" />Turno de teste</span>}
      </div>
    </div>
  );

  if (readOnly) {
    return (
      <div className="ns">
        <p className="ns-summary">
          Das <b>{nightStartTime}</b> às <b>{nightEndTime}</b> · {rule.title.toLowerCase()}
        </p>
        {timeline}
      </div>
    );
  }

  let verdict: { night: boolean; text: string } | null = null;
  if (ns !== null && ne !== null && ts !== null && te !== null && ts !== te) {
    const period = classifyShiftPeriod(nightShiftRule, ns, ne, ts, te);
    const duration = shiftDurationMinutes(ts, te);
    const inNight = nightMinutes(ts, te, ns, ne);
    verdict = {
      night: period === "noturno",
      text: `Turno de ${formatDuration(duration)}, com ${formatDuration(inNight)} no horário noturno (${nightStartTime}–${nightEndTime}).`,
    };
  }

  return (
    <div className="ns">
      <div className="ns-window">
        <div className="field">
          <label htmlFor={`${idPrefix}-night-start`}>Começa às</label>
          <TimeField id={`${idPrefix}-night-start`} value={nightStartTime} onChange={(v) => onChange?.({ nightStartTime: v })} required />
        </div>
        <ArrowRight size={16} className="ns-arrow" aria-hidden="true" />
        <div className="field">
          <label htmlFor={`${idPrefix}-night-end`}>Termina às</label>
          <TimeField id={`${idPrefix}-night-end`} value={nightEndTime} onChange={(v) => onChange?.({ nightEndTime: v })} required />
        </div>
        {(nightStartTime !== CLT_START || nightEndTime !== CLT_END) && (
          <button type="button" className="ns-clt" onClick={() => onChange?.({ nightStartTime: CLT_START, nightEndTime: CLT_END })}>
            Usar o padrão da CLT (22:00 às 05:00)
          </button>
        )}
      </div>

      {timeline}

      <div className="ns-rules-label" id={`${idPrefix}-night-rule-label`}>Um turno conta como noturno quando</div>
      <div className="ns-rules" role="radiogroup" aria-labelledby={`${idPrefix}-night-rule-label`}>
        {RULES.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={nightShiftRule === r.id} className="ns-rule" onClick={() => onChange?.({ nightShiftRule: r.id })}>
            <span className="ns-radio" aria-hidden="true" />
            <strong>
              {r.title}
              {r.common && <span className="ns-common">mais comum</span>}
            </strong>
            <small>{r.text}</small>
            <span className="ns-mini" aria-hidden="true">
              <span className="ns-mini-night" />
              <span className="ns-mini-shift" style={{ left: `${r.shift[0]}%`, width: `${r.shift[1] - r.shift[0]}%` }} />
              {r.mark && <span className="ns-mini-mark" style={{ left: `${r.mark === "start" ? r.shift[0] : r.shift[1]}%` }} />}
            </span>
          </button>
        ))}
      </div>

      <div className="ns-test">
        <strong>Testar um turno</strong>
        <span className="ns-test-times">
          das <TimeField value={testStart} onChange={setTestStart} ariaLabel="Início do turno de teste" /> às{" "}
          <TimeField value={testEnd} onChange={setTestEnd} ariaLabel="Fim do turno de teste" />
        </span>
        {verdict && (
          <span className={`ns-verdict ${verdict.night ? "ns-verdict-night" : "ns-verdict-day"}`}>
            {verdict.night ? <Moon size={13} /> : <Sun size={13} />}
            {verdict.night ? "Noturno" : "Diurno"}
          </span>
        )}
        <span className="ns-why">{verdict ? verdict.text : "Informe horários no formato 00:00."}</span>
      </div>
    </div>
  );
}
