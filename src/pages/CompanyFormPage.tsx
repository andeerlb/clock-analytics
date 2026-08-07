import { Calculator, Moon, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import { createCompany, getCompany, updateCompany } from "../lib/db";
import { formatMinutesAsTime, maskCnpj, parseTimeToMinutes } from "../lib/format";
import {
  NIGHT_SHIFT_RULE_LABELS,
  PAYMENT_VALUE_RULE_OPERATOR_LABELS,
  SCHEDULE_TIME_RULE_LABELS,
  type NightShiftRule,
  type PaymentValueRule,
  type PaymentValueRuleCondition,
  type PaymentValueRuleOperator,
  type ScheduleTimeRule,
} from "../lib/types";

const NIGHT_SHIFT_RULES = Object.keys(NIGHT_SHIFT_RULE_LABELS) as NightShiftRule[];
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
interface WizardValueCondition {
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

/** The form's editable draft of one step in a company's optional pay-value chain — see `PaymentValueRule` in types.ts for the saved shape. Hours/minutes are kept as separate text inputs (not a single `thresholdMinutes`) so "7h20" is a natural pair of fields, combined into minutes only on save. */
interface WizardValueRule {
  kind: "condition" | "else";
  conditions: WizardValueCondition[];
  operator: PaymentValueRuleOperator;
  hours: string;
  minutes: string;
  amount: string;
}

function isValueRuleValid(r: WizardValueRule): boolean {
  return r.amount.trim() !== "" && !Number.isNaN(Number(r.amount)) && r.conditions.every(isConditionValid);
}

export default function CompanyFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [nightStartTime, setNightStartTime] = useState("22:00");
  const [nightEndTime, setNightEndTime] = useState("05:00");
  const [nightShiftRule, setNightShiftRule] = useState<NightShiftRule>("overlap");
  const [valueRules, setValueRules] = useState<WizardValueRule[]>([]);
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    getCompany(Number(id))
      .then((c) => {
        setName(c.name);
        setCnpj(maskCnpj(c.cnpj));
        setNightStartTime(c.nightStartTime);
        setNightEndTime(c.nightEndTime);
        setNightShiftRule(c.nightShiftRule);
        setValueRules(
          c.valueRules.map((r) => ({
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
          })),
        );
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, isEditing]);

  const hasElseValueRule = valueRules.some((r) => r.kind === "else");

  /** New condition rows always land right before the "senão" rule, if one exists — that one always stays last. */
  function addValueConditionRule() {
    const newRule: WizardValueRule = { kind: "condition", conditions: [], operator: ">=", hours: "", minutes: "", amount: "" };
    setValueRules((prev) => {
      const elseIndex = prev.findIndex((r) => r.kind === "else");
      if (elseIndex === -1) return [...prev, newRule];
      return [...prev.slice(0, elseIndex), newRule, ...prev.slice(elseIndex)];
    });
  }

  function addValueElseRule() {
    setValueRules((prev) => [...prev, { kind: "else", conditions: [], operator: ">=", hours: "", minutes: "", amount: "" }]);
  }

  function removeValueRule(index: number) {
    setValueRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateValueRule(index: number, patch: Partial<WizardValueRule>) {
    setValueRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addValueCondition(ruleIndex: number) {
    setValueRules((prev) =>
      prev.map((r, i) => (i === ruleIndex ? { ...r, conditions: [...r.conditions, newValueCondition()] } : r)),
    );
  }

  function removeValueCondition(ruleIndex: number, condIndex: number) {
    setValueRules((prev) =>
      prev.map((r, i) => (i === ruleIndex ? { ...r, conditions: r.conditions.filter((_, ci) => ci !== condIndex) } : r)),
    );
  }

  function updateValueCondition(ruleIndex: number, condIndex: number, patch: Partial<WizardValueCondition>) {
    setValueRules((prev) =>
      prev.map((r, i) =>
        i === ruleIndex ? { ...r, conditions: r.conditions.map((c, ci) => (ci === condIndex ? { ...c, ...patch } : c)) } : r,
      ),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const valueRuleInputs: PaymentValueRule[] = valueRules.map((r) => ({
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

      if (isEditing) {
        await updateCompany(Number(id), name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRuleInputs);
      } else {
        await createCompany(name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRuleInputs);
      }
      navigate("/companies");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/companies" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar empresa" : "Nova empresa"}</h2>
      </div>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <div className="card" style={{ maxWidth: "40rem" }}>
          <form onSubmit={handleSubmit}>
            <div className="field" style={{ marginBottom: "1rem" }}>
              <label htmlFor="company-name">Nome</label>
              <input
                id="company-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Razão social"
                required
                style={{ width: "100%" }}
              />
            </div>
            <div className="field" style={{ marginBottom: "1rem" }}>
              <label htmlFor="company-cnpj">CNPJ</label>
              <input
                id="company-cnpj"
                type="text"
                value={cnpj}
                onChange={(e) => setCnpj(maskCnpj(e.target.value))}
                placeholder="00.000.000/0000-00"
                inputMode="numeric"
                required
                style={{ width: "100%" }}
              />
            </div>
            <section className="glass-panel" style={{ marginBottom: "1.2rem" }}>
              <h3 className="glass-panel-heading">
                <Moon size={18} />
                Horário noturno
              </h3>
              <p className="glass-panel-desc">
                O horário entre o início e o fim do noturno define quais turnos de um colaborador
                contam como noturnos ao calcular pagamentos — o padrão (22:00–05:00) segue a CLT.
              </p>
              <div className="field-row" style={{ marginBottom: "1.2rem" }}>
                <div className="field" style={{ flex: "0 1 160px", marginBottom: 0 }}>
                  <label htmlFor="company-night-start">Início do noturno</label>
                  <input
                    id="company-night-start"
                    type="time"
                    value={nightStartTime}
                    onChange={(e) => setNightStartTime(e.target.value)}
                    required
                  />
                </div>
                <div className="field" style={{ flex: "0 1 160px", marginBottom: 0 }}>
                  <label htmlFor="company-night-end">Fim do noturno</label>
                  <input
                    id="company-night-end"
                    type="time"
                    value={nightEndTime}
                    onChange={(e) => setNightEndTime(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="company-night-rule">Considerar noturno quando</label>
                <select
                  id="company-night-rule"
                  value={nightShiftRule}
                  onChange={(e) => setNightShiftRule(e.target.value as NightShiftRule)}
                >
                  {NIGHT_SHIFT_RULES.map((rule) => (
                    <option key={rule} value={rule}>
                      {NIGHT_SHIFT_RULE_LABELS[rule]}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className="glass-panel" style={{ marginBottom: "1.2rem" }}>
              <h3 className="glass-panel-heading">
                <Calculator size={18} />
                Regras de valor por hora trabalhada
              </h3>
              <p className="glass-panel-desc">
                Decide o Valor de um turno a partir de condições de coluna (Data/Local/Função/
                Horário) e da duração (horas trabalhadas, somada do Horário) — avaliadas em
                ordem, a primeira que bater vence. Opcional: sem nenhuma regra, o Valor não é
                calculado.
              </p>

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
                                      onChange={(e) =>
                                        updateValueCondition(i, ci, { scheduleRule: e.target.value as ScheduleTimeRule })
                                      }
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
                          <span className="rule-card-else-label">
                            SENÃO — se nenhuma regra acima bater, usa este valor
                          </span>
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
            </section>

            <button type="submit" disabled={busy || valueRules.some((r) => !isValueRuleValid(r))}>
              {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
