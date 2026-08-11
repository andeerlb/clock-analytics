import { Clock3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SCHEDULE_TIME_RULE_LABELS, type ScheduleTimeFilter, type ScheduleTimeRule } from "../lib/types";

const SCHEDULE_TIME_RULES: ScheduleTimeRule[] = ["start-before", "start-after", "end-before", "end-after"];

/**
 * The Pagamentos list's "Horário" filter — same popover recipe as
 * `MultiSelectDropdown`, but its two inputs (rule + reference time) are
 * edited as a draft and only applied on confirm, since re-querying on every
 * keystroke of a still-incomplete "HH:MM" would be noisy and often invalid
 * mid-edit.
 */
export default function ScheduleTimeFilterDropdown({
  value,
  onChange,
  align = "right",
}: {
  value: ScheduleTimeFilter | null;
  onChange: (v: ScheduleTimeFilter | null) => void;
  /** Same idea as `MultiSelectDropdown`'s `align` — "left" keeps the popover from overflowing past a container's left edge when the trigger sits near that edge (e.g. inside a narrow Drawer). */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [draftRule, setDraftRule] = useState<ScheduleTimeRule>(value?.rule ?? "start-after");
  const [draftTime, setDraftTime] = useState(value?.time ?? "12:00");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function openPopover() {
    setDraftRule(value?.rule ?? "start-after");
    setDraftTime(value?.time ?? "12:00");
    setOpen((o) => !o);
  }

  const label = value ? `${SCHEDULE_TIME_RULE_LABELS[value.rule]} ${value.time}` : "Horário";

  return (
    <div style={{ position: "relative", display: "inline-block", alignSelf: "flex-start" }} ref={rootRef}>
      <button type="button" className="secondary" onClick={openPopover}>
        <Clock3 size={15} style={{ marginRight: "0.4rem" }} />
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            left: align === "left" ? 0 : undefined,
            right: align === "left" ? undefined : 0,
            top: "calc(100% + 0.4rem)",
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.8rem",
            minWidth: "240px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
            zIndex: 20,
          }}
        >
          <div className="field" style={{ marginBottom: "0.6rem" }}>
            <label htmlFor="schedule-time-filter-rule">Considerar quando</label>
            <select
              id="schedule-time-filter-rule"
              value={draftRule}
              onChange={(e) => setDraftRule(e.target.value as ScheduleTimeRule)}
            >
              {SCHEDULE_TIME_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {SCHEDULE_TIME_RULE_LABELS[rule]}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: "0.8rem" }}>
            <label htmlFor="schedule-time-filter-time">Horário de referência</label>
            <input
              id="schedule-time-filter-time"
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
            <button
              type="button"
              className="ghost"
              style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Limpar
            </button>
            <button
              type="button"
              style={{ padding: "0.25rem 0.7rem", fontSize: "0.85rem" }}
              onClick={() => {
                onChange({ rule: draftRule, time: draftTime });
                setOpen(false);
              }}
              disabled={!draftTime}
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
