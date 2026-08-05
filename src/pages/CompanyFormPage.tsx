import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import { createCompany, getCompany, updateCompany } from "../lib/db";
import { maskCnpj } from "../lib/format";
import {
  NIGHT_SHIFT_RULE_LABELS,
  PAYMENT_VALUE_RULE_OPERATOR_LABELS,
  type NightShiftRule,
  type PaymentValueRule,
  type PaymentValueRuleOperator,
} from "../lib/types";

const NIGHT_SHIFT_RULES = Object.keys(NIGHT_SHIFT_RULE_LABELS) as NightShiftRule[];
const PAYMENT_VALUE_RULE_OPERATORS = Object.keys(PAYMENT_VALUE_RULE_OPERATOR_LABELS) as PaymentValueRuleOperator[];

/** The form's editable draft of one step in a company's optional pay-value chain — see `PaymentValueRule` in types.ts for the saved shape. Hours/minutes are kept as separate text inputs (not a single `thresholdMinutes`) so "7h20" is a natural pair of fields, combined into minutes only on save. */
interface WizardValueRule {
  kind: "condition" | "else";
  operator: PaymentValueRuleOperator;
  hours: string;
  minutes: string;
  amount: string;
}

function isValueRuleValid(r: WizardValueRule): boolean {
  return r.amount.trim() !== "" && !Number.isNaN(Number(r.amount));
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
    const newRule: WizardValueRule = { kind: "condition", operator: ">=", hours: "", minutes: "", amount: "" };
    setValueRules((prev) => {
      const elseIndex = prev.findIndex((r) => r.kind === "else");
      if (elseIndex === -1) return [...prev, newRule];
      return [...prev.slice(0, elseIndex), newRule, ...prev.slice(elseIndex)];
    });
  }

  function addValueElseRule() {
    setValueRules((prev) => [...prev, { kind: "else", operator: ">=", hours: "", minutes: "", amount: "" }]);
  }

  function removeValueRule(index: number) {
    setValueRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateValueRule(index: number, patch: Partial<WizardValueRule>) {
    setValueRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const valueRuleInputs: PaymentValueRule[] = valueRules.map((r) => ({
        kind: r.kind,
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
      <p className="page-subtitle">
        O horário entre o início e o fim do noturno define quais turnos de um colaborador contam
        como noturnos ao calcular pagamentos — o padrão (22:00–05:00) segue a CLT.
      </p>

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
            <div className="field-row" style={{ marginBottom: "1.2rem" }}>
              <div className="field" style={{ flex: "0 1 160px" }}>
                <label htmlFor="company-night-start">Início do noturno</label>
                <input
                  id="company-night-start"
                  type="time"
                  value={nightStartTime}
                  onChange={(e) => setNightStartTime(e.target.value)}
                  required
                />
              </div>
              <div className="field" style={{ flex: "0 1 160px" }}>
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
            <div className="field" style={{ marginBottom: "1.2rem" }}>
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

            <div className="field" style={{ marginBottom: "1.2rem" }}>
              <label>Regras de valor por hora trabalhada</label>
              <p className="field-hint" style={{ marginTop: 0 }}>
                Decide o Valor de um turno a partir da duração (horas trabalhadas, somada do
                Horário) — avaliadas em ordem, a primeira que bater vence. Opcional: sem nenhuma
                regra, o Valor não é calculado.
              </p>

              {valueRules.map((rule, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                    alignItems: "center",
                    marginBottom: "0.5rem",
                    padding: "0.6rem",
                    background: "var(--surface-container)",
                    borderRadius: 8,
                  }}
                >
                  <span className="muted" style={{ fontSize: "0.8rem" }}>{i + 1}.</span>
                  {rule.kind === "condition" ? (
                    <>
                      <span className="muted" style={{ fontSize: "0.85rem" }}>Se trabalhou</span>
                      <select
                        value={rule.operator}
                        onChange={(e) =>
                          updateValueRule(i, { operator: e.target.value as PaymentValueRuleOperator })
                        }
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
                    </>
                  ) : (
                    <span className="muted" style={{ fontSize: "0.85rem" }}>
                      Senão (qualquer outra duração)
                    </span>
                  )}
                  <span className="muted" style={{ fontSize: "0.85rem", marginLeft: "auto" }}>=</span>
                  <span className="muted" style={{ fontSize: "0.85rem" }}>R$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={rule.amount}
                    onChange={(e) => updateValueRule(i, { amount: e.target.value })}
                    placeholder="0,00"
                    style={{ width: "6rem" }}
                    aria-label="Valor"
                  />
                  <button
                    type="button"
                    className="ghost"
                    style={{ padding: "0.3rem" }}
                    onClick={() => removeValueRule(i)}
                    aria-label="Remover regra"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
                <button type="button" className="secondary" onClick={addValueConditionRule}>
                  <Plus size={14} style={{ marginRight: "0.3rem" }} />
                  Adicionar regra
                </button>
                {!hasElseValueRule && (
                  <button type="button" className="secondary" onClick={addValueElseRule}>
                    <Plus size={14} style={{ marginRight: "0.3rem" }} />
                    Adicionar "senão"
                  </button>
                )}
              </div>
            </div>

            <button type="submit" disabled={busy || valueRules.some((r) => !isValueRuleValid(r))}>
              {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
