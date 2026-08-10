import { Plus, Trash2 } from "lucide-react";
import {
  PAYMENT_VALUE_RULE_OPERATOR_LABELS,
  SCHEDULE_TIME_RULE_LABELS,
  type PaymentValueRule,
  type PaymentValueRuleCondition,
  type PaymentValueRuleOperator,
  type ScheduleTimeRule,
} from "../lib/types";
import { formatMinutesAsTime, parseTimeToMinutes } from "../lib/format";

const PAYMENT_VALUE_RULE_OPERATORS = Object.keys(PAYMENT_VALUE_RULE_OPERATOR_LABELS) as PaymentValueRuleOperator[];
const SCHEDULE_TIME_RULES = Object.keys(SCHEDULE_TIME_RULE_LABELS) as ScheduleTimeRule[];
const VALUE_CONDITION_FIELDS: PaymentValueRuleCondition["field"][] = ["data", "local", "funcao", "horario"];
const VALUE_CONDITION_FIELD_LABELS: Record<PaymentValueRuleCondition["field"], string> = {
  data: "Data",
  local: "Local",
  funcao: "Função",
  horario: "Horário",
};

/**
 * The form's editable draft of one column condition narrowing a value-rule
 * step — see `PaymentValueRuleCondition` in types.ts for the saved shape.
 * Always case-insensitive (no toggle in this UI, unlike the template
 * routing rules' editor) — a simpler default that covers the realistic
 * case without another checkbox per row.
 */
export interface WizardValueCondition {
  field: PaymentValueRuleCondition["field"];
  /** Comma-separated — ignored when `field === "horario"`. */
  valuesText: string;
  scheduleRule: ScheduleTimeRule;
  /** "HH:MM" — ignored unless `field === "horario"`. */
  scheduleTime: string;
}

function newValueCondition(): WizardValueCondition {
  return { field: "local", valuesText: "", scheduleRule: "start-after", scheduleTime: "" };
}

function isConditionValid(c: WizardValueCondition): boolean {
  return c.field === "horario" ? parseTimeToMinutes(c.scheduleTime) !== null : c.valuesText.trim() !== "";
}

/**
 * The form's editable draft of one step in an if/else-if/else pay-value
 * chain — see `PaymentValueRule` in types.ts for the saved shape. Used by
 * both a company's own chain and a client's optional override (same shape
 * either way, see `getEffectivePaymentRules` in db.ts for how the two are
 * resolved). Hours/minutes are kept as separate text inputs (not a single
 * `thresholdMinutes`) so "7h20" is a natural pair of fields, combined into
 * minutes only on save.
 */
export interface WizardValueRule {
  kind: "condition" | "else";
  conditions: WizardValueCondition[];
  operator: PaymentValueRuleOperator;
  hours: string;
  minutes: string;
  amount: string;
}

export function isValueRuleValid(r: WizardValueRule): boolean {
  return r.amount.trim() !== "" && !Number.isNaN(Number(r.amount)) && r.conditions.every(isConditionValid);
}

export function isValueRulesValid(rules: WizardValueRule[]): boolean {
  return rules.every(isValueRuleValid);
}

/** Load-time conversion — the saved `PaymentValueRule[]` shape into this editor's draft shape. */
export function fromPaymentValueRules(rules: PaymentValueRule[]): WizardValueRule[] {
  return rules.map((r) => ({
    kind: r.kind,
    conditions: r.conditions.map(
      (cond): WizardValueCondition =>
        cond.field === "horario"
          ? { field: "horario", valuesText: "", scheduleRule: cond.scheduleRule, scheduleTime: formatMinutesAsTime(cond.scheduleMinutes) }
          : { field: cond.field, valuesText: cond.values.join(", "), scheduleRule: "start-after", scheduleTime: "" },
    ),
    operator: r.operator ?? ">=",
    hours: r.thresholdMinutes !== null ? String(Math.floor(r.thresholdMinutes / 60)) : "",
    minutes: r.thresholdMinutes !== null ? String(r.thresholdMinutes % 60) : "",
    amount: String(r.amount),
  }));
}

/** Submit-time conversion — this editor's draft shape back into the saved `PaymentValueRule[]` shape. */
export function toPaymentValueRules(rules: WizardValueRule[]): PaymentValueRule[] {
  return rules.map((r) => ({
    kind: r.kind,
    conditions:
      r.kind === "condition"
        ? r.conditions.map(
            (c): PaymentValueRuleCondition =>
              c.field === "horario"
                ? { field: "horario", scheduleRule: c.scheduleRule, scheduleMinutes: parseTimeToMinutes(c.scheduleTime) ?? 0 }
                : {
                    field: c.field,
                    values: c.valuesText.split(",").map((v) => v.trim()).filter(Boolean),
                    caseInsensitive: true,
                  },
          )
        : [],
    operator: r.kind === "condition" ? r.operator : null,
    thresholdMinutes: r.kind === "condition" ? (Number(r.hours) || 0) * 60 + (Number(r.minutes) || 0) : null,
    amount: Number(r.amount) || 0,
  }));
}

/**
 * The if/else-if/else pay-value chain editor — shared by `CompanyFormPage`
 * (a company's own chain, always present) and `ClientFormPage` (a client's
 * optional override, empty meaning "inherit the company's", see
 * `EffectivePaymentRules` in db.ts). Renders only the rule list + add
 * buttons — the surrounding `<section><h3>` heading/description stays in
 * each page, since the copy differs slightly between the two.
 */
export default function PaymentValueRulesEditor({
  valueRules,
  onChange,
}: {
  valueRules: WizardValueRule[];
  onChange: (rules: WizardValueRule[]) => void;
}) {
  const hasElseValueRule = valueRules.some((r) => r.kind === "else");

  /** New condition rows always land right before the "senão" rule, if one exists — that one always stays last. */
  function addValueConditionRule() {
    const newRule: WizardValueRule = { kind: "condition", conditions: [], operator: ">=", hours: "", minutes: "", amount: "" };
    const elseIndex = valueRules.findIndex((r) => r.kind === "else");
    onChange(
      elseIndex === -1
        ? [...valueRules, newRule]
        : [...valueRules.slice(0, elseIndex), newRule, ...valueRules.slice(elseIndex)],
    );
  }

  function addValueElseRule() {
    onChange([...valueRules, { kind: "else", conditions: [], operator: ">=", hours: "", minutes: "", amount: "" }]);
  }

  function removeValueRule(index: number) {
    onChange(valueRules.filter((_, i) => i !== index));
  }

  function updateValueRule(index: number, patch: Partial<WizardValueRule>) {
    onChange(valueRules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addValueCondition(ruleIndex: number) {
    onChange(valueRules.map((r, i) => (i === ruleIndex ? { ...r, conditions: [...r.conditions, newValueCondition()] } : r)));
  }

  function removeValueCondition(ruleIndex: number, condIndex: number) {
    onChange(
      valueRules.map((r, i) => (i === ruleIndex ? { ...r, conditions: r.conditions.filter((_, ci) => ci !== condIndex) } : r)),
    );
  }

  function updateValueCondition(ruleIndex: number, condIndex: number, patch: Partial<WizardValueCondition>) {
    onChange(
      valueRules.map((r, i) =>
        i === ruleIndex ? { ...r, conditions: r.conditions.map((c, ci) => (ci === condIndex ? { ...c, ...patch } : c)) } : r,
      ),
    );
  }

  return (
    <>
      <div className="rule-list">
        {valueRules.map((rule, i) => (
          <div key={i} className="chain-row">
            {i > 0 && <div className="chain-connector" />}
            <div className={`logic-card rule-card${rule.kind === "else" ? " rule-card-else" : ""}`}>
              <div className={`chain-num${i === 0 ? " first" : ""}`}>{i + 1}</div>
              <div className="value-rule-card-grid">
                {rule.kind === "condition" ? (
                  <>
                    {rule.conditions.map((cond, ci) => (
                      <div className="field-code" key={ci}>
                        <label>{ci === 0 ? "Se [Coluna]" : "E [Coluna]"}</label>
                        <select
                          className="glass-input"
                          value={cond.field}
                          onChange={(e) =>
                            updateValueCondition(i, ci, {
                              field: e.target.value as PaymentValueRuleCondition["field"],
                            })
                          }
                        >
                          {VALUE_CONDITION_FIELDS.map((f) => (
                            <option key={f} value={f}>
                              {VALUE_CONDITION_FIELD_LABELS[f]}
                            </option>
                          ))}
                        </select>
                        {cond.field === "horario" ? (
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            <select
                              className="glass-input"
                              value={cond.scheduleRule}
                              onChange={(e) => updateValueCondition(i, ci, { scheduleRule: e.target.value as ScheduleTimeRule })}
                              aria-label="Comparação de horário"
                            >
                              {SCHEDULE_TIME_RULES.map((r) => (
                                <option key={r} value={r}>
                                  {SCHEDULE_TIME_RULE_LABELS[r]}
                                </option>
                              ))}
                            </select>
                            <input
                              className="glass-input"
                              type="time"
                              value={cond.scheduleTime}
                              onChange={(e) => updateValueCondition(i, ci, { scheduleTime: e.target.value })}
                              aria-label="Horário de referência"
                            />
                          </div>
                        ) : (
                          <input
                            className="glass-input"
                            type="text"
                            value={cond.valuesText}
                            onChange={(e) => updateValueCondition(i, ci, { valuesText: e.target.value })}
                            placeholder="Ex.: valor1, valor2"
                            aria-label="Valores (um ou mais, separados por vírgula)"
                          />
                        )}
                        <button
                          type="button"
                          className="ghost"
                          style={{ alignSelf: "flex-start", padding: "0.2rem" }}
                          onClick={() => removeValueCondition(i, ci)}
                          aria-label="Remover condição"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="glow-button" style={{ alignSelf: "flex-start" }} onClick={() => addValueCondition(i)}>
                      <Plus size={12} />
                      Condição de coluna
                    </button>
                    <div className="field-code">
                      <label>{rule.conditions.length > 0 ? "E, se trabalhou" : "Se trabalhou"}</label>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <select
                          className="glass-input"
                          value={rule.operator}
                          onChange={(e) => updateValueRule(i, { operator: e.target.value as PaymentValueRuleOperator })}
                          style={{ width: "auto" }}
                          aria-label="Operador"
                        >
                          {PAYMENT_VALUE_RULE_OPERATORS.map((op) => (
                            <option key={op} value={op}>
                              {PAYMENT_VALUE_RULE_OPERATOR_LABELS[op]}
                            </option>
                          ))}
                        </select>
                        <input
                          className="glass-input"
                          type="number"
                          min="0"
                          value={rule.hours}
                          onChange={(e) => updateValueRule(i, { hours: e.target.value })}
                          placeholder="0"
                          style={{ width: "4rem" }}
                          aria-label="Horas"
                        />
                        <span className="muted" style={{ fontSize: "0.85rem" }}>h</span>
                        <input
                          className="glass-input"
                          type="number"
                          min="0"
                          max="59"
                          value={rule.minutes}
                          onChange={(e) => updateValueRule(i, { minutes: e.target.value })}
                          placeholder="0"
                          style={{ width: "4rem" }}
                          aria-label="Minutos"
                        />
                        <span className="muted" style={{ fontSize: "0.85rem" }}>min</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <span className="rule-card-else-label">SENÃO — se nenhuma regra acima bater, usa este valor</span>
                )}
                <div className="field-code consequence">
                  <label>Então [Valor]</label>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <span className="muted" style={{ fontSize: "0.85rem" }}>R$</span>
                    <input
                      className="glass-input"
                      type="number"
                      min="0"
                      step="0.01"
                      value={rule.amount}
                      onChange={(e) => updateValueRule(i, { amount: e.target.value })}
                      placeholder="0,00"
                      aria-label="Valor"
                    />
                  </div>
                </div>
              </div>
              <div className="rule-card-delete">
                <button
                  type="button"
                  className="ghost"
                  style={{ padding: "0.4rem" }}
                  onClick={() => removeValueRule(i)}
                  aria-label="Remover regra"
                  title="Remover regra"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.6rem", marginTop: valueRules.length > 0 ? "1rem" : 0 }}>
        <button type="button" className="glow-button" onClick={addValueConditionRule}>
          <Plus size={14} />
          Adicionar regra
        </button>
        {!hasElseValueRule && (
          <button type="button" className="glow-button" onClick={addValueElseRule}>
            <Plus size={14} />
            Adicionar "senão"
          </button>
        )}
      </div>
    </>
  );
}
