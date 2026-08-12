import TimeField from "./TimeField";
import { NIGHT_SHIFT_RULE_LABELS, type NightShiftRule } from "../lib/types";

const NIGHT_SHIFT_RULES = Object.keys(NIGHT_SHIFT_RULE_LABELS) as NightShiftRule[];

/**
 * The night-shift window (início/fim) + rule select, shared by
 * `CompanyFormPage` (always shown, a company always has one) and
 * `ClientFormPage` (shown only while its own "sobrescrever" toggle is on —
 * that on/off logic stays local to each page, not here, since only the
 * client side needs it). `idPrefix` keeps `<label htmlFor>`/`<input id>`
 * pairs unique when both a company's and a client's fields could
 * conceivably render on the same page.
 */
export default function NightShiftRuleFields({
  nightStartTime,
  nightEndTime,
  nightShiftRule,
  onChange,
  idPrefix,
}: {
  nightStartTime: string;
  nightEndTime: string;
  nightShiftRule: NightShiftRule;
  onChange: (patch: Partial<{ nightStartTime: string; nightEndTime: string; nightShiftRule: NightShiftRule }>) => void;
  idPrefix: string;
}) {
  return (
    <>
      <div className="field-row" style={{ marginBottom: "1.2rem" }}>
        <div className="field" style={{ flex: "0 1 160px", marginBottom: 0 }}>
          <label htmlFor={`${idPrefix}-night-start`}>Início do noturno</label>
          <TimeField
            id={`${idPrefix}-night-start`}
            value={nightStartTime}
            onChange={(v) => onChange({ nightStartTime: v })}
            required
          />
        </div>
        <div className="field" style={{ flex: "0 1 160px", marginBottom: 0 }}>
          <label htmlFor={`${idPrefix}-night-end`}>Fim do noturno</label>
          <TimeField
            id={`${idPrefix}-night-end`}
            value={nightEndTime}
            onChange={(v) => onChange({ nightEndTime: v })}
            required
          />
        </div>
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`${idPrefix}-night-rule`}>Considerar noturno quando</label>
        <select
          id={`${idPrefix}-night-rule`}
          value={nightShiftRule}
          onChange={(e) => onChange({ nightShiftRule: e.target.value as NightShiftRule })}
        >
          {NIGHT_SHIFT_RULES.map((rule) => (
            <option key={rule} value={rule}>
              {NIGHT_SHIFT_RULE_LABELS[rule]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
