import { ChevronDown, ChevronUp, Info, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import TimeField from "./TimeField";
import {
  type PaymentValueRule,
  type PaymentValueRuleCondition,
  type PaymentValueRuleOperator,
  type ScheduleTimeRule,
} from "../lib/types";
import { listDistinctPaymentShiftLocals, listRolesGlobal } from "../lib/db";
import {
  formatCurrencyBRL,
  formatDateSlash,
  formatMinutesAsTime,
  matchingPaymentValueRuleIndex,
  parseTimeToMinutes,
  shiftDurationMinutes,
} from "../lib/format";

/**
 * "Qualquer duração" isn't a stored operator — it's saved as `>= 0`
 * (which every shift satisfies), exactly what an empty threshold already
 * meant before this editor, so no migration is needed. Loading maps `>= 0`
 * back to "any".
 */
export type WizardDurationOperator = PaymentValueRuleOperator | "any";

const DURATION_OPTIONS: { id: WizardDurationOperator; label: string }[] = [
  { id: "any", label: "Qualquer duração" },
  { id: "=", label: "Exatamente" },
  { id: ">=", label: "Pelo menos" },
  { id: "<=", label: "Até" },
  { id: ">", label: "Mais de" },
  { id: "<", label: "Menos de" },
  { id: "!=", label: "Diferente de" },
];

/** What a condition row filters on. "inicio"/"fim" are the two halves of the stored "horario" field. */
type ConditionKind = "funcao" | "local" | "data" | "inicio" | "fim";
const CONDITION_KINDS: { id: ConditionKind; label: string }[] = [
  { id: "funcao", label: "Função" },
  { id: "local", label: "Local" },
  { id: "data", label: "Data" },
  { id: "inicio", label: "Início" },
  { id: "fim", label: "Fim" },
];

/**
 * The form's editable draft of one condition narrowing a value-rule step —
 * see `PaymentValueRuleCondition` in types.ts for the saved shape. Matching
 * is always case-insensitive.
 */
export interface WizardValueCondition {
  field: PaymentValueRuleCondition["field"];
  /** Picked values (Função/Local/Data) — Data values are ISO dates ("2026-11-17"), the format a shift's date is compared in. Ignored for "horario". */
  values: string[];
  scheduleRule: ScheduleTimeRule;
  /** "HH:MM" — only for `field === "horario"`. */
  scheduleTime: string;
}

/**
 * The form's editable draft of one step in an if/else-if/else pay-value
 * chain — see `PaymentValueRule` in types.ts. Shared by a company's own
 * chain and a client's optional override (see `getEffectivePaymentRules`).
 * An `"else"` step ("Qualquer outro turno") with an empty `amount` means
 * "no fallback" and is dropped on save.
 */
export interface WizardValueRule {
  kind: "condition" | "else";
  conditions: WizardValueCondition[];
  operator: WizardDurationOperator;
  hours: string;
  minutes: string;
  amount: string;
}

function conditionKind(c: WizardValueCondition): ConditionKind {
  if (c.field === "horario") return c.scheduleRule.startsWith("start") ? "inicio" : "fim";
  return c.field;
}

function newCondition(kind: ConditionKind): WizardValueCondition {
  if (kind === "inicio") return { field: "horario", values: [], scheduleRule: "start-after", scheduleTime: "" };
  if (kind === "fim") return { field: "horario", values: [], scheduleRule: "end-before", scheduleTime: "" };
  return { field: kind, values: [], scheduleRule: "start-after", scheduleTime: "" };
}

function parseAmount(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  // Accepts "1.234,56", "1234,56" and "1234.56".
  const normalized = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function formatAmountInput(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

function isConditionValid(c: WizardValueCondition): boolean {
  return c.field === "horario" ? parseTimeToMinutes(c.scheduleTime) !== null : c.values.length > 0;
}

export function isValueRuleValid(r: WizardValueRule): boolean {
  if (r.kind === "else") return r.amount.trim() === "" || parseAmount(r.amount) !== null;
  return parseAmount(r.amount) !== null && r.conditions.every(isConditionValid);
}

export function isValueRulesValid(rules: WizardValueRule[]): boolean {
  return rules.every(isValueRuleValid);
}

/** Load-time conversion — the saved `PaymentValueRule[]` shape into this editor's draft shape. */
export function fromPaymentValueRules(rules: PaymentValueRule[]): WizardValueRule[] {
  return rules.map((r) => {
    const any = r.kind === "condition" && (r.thresholdMinutes === null || (r.operator === ">=" && r.thresholdMinutes === 0));
    return {
      kind: r.kind,
      conditions: r.conditions.map(
        (cond): WizardValueCondition =>
          cond.field === "horario"
            ? { field: "horario", values: [], scheduleRule: cond.scheduleRule, scheduleTime: formatMinutesAsTime(cond.scheduleMinutes) }
            : { field: cond.field, values: cond.values, scheduleRule: "start-after", scheduleTime: "" },
      ),
      operator: any ? "any" : (r.operator ?? "any"),
      hours: !any && r.thresholdMinutes !== null ? String(Math.floor(r.thresholdMinutes / 60)) : "",
      minutes: !any && r.thresholdMinutes !== null ? String(r.thresholdMinutes % 60) : "",
      amount: formatAmountInput(r.amount),
    };
  });
}

/** Submit-time conversion — this editor's draft shape back into the saved `PaymentValueRule[]` shape. */
export function toPaymentValueRules(rules: WizardValueRule[]): PaymentValueRule[] {
  return rules
    .filter((r) => !(r.kind === "else" && r.amount.trim() === ""))
    .map((r) => {
      const any = r.operator === "any";
      return {
        kind: r.kind,
        conditions:
          r.kind === "condition"
            ? r.conditions.map(
                (c): PaymentValueRuleCondition =>
                  c.field === "horario"
                    ? { field: "horario", scheduleRule: c.scheduleRule, scheduleMinutes: parseTimeToMinutes(c.scheduleTime) ?? 0 }
                    : { field: c.field, values: c.values, caseInsensitive: true },
              )
            : [],
        operator: r.kind === "condition" ? (any ? ">=" : (r.operator as PaymentValueRuleOperator)) : null,
        thresholdMinutes: r.kind === "condition" ? (any ? 0 : (Number(r.hours) || 0) * 60 + (Number(r.minutes) || 0)) : null,
        amount: parseAmount(r.amount) ?? 0,
      };
    });
}

function durationText(r: WizardValueRule): string | null {
  if (r.operator === "any") return null;
  const h = Number(r.hours) || 0;
  const m = Number(r.minutes) || 0;
  const hhmm = `${h}h${m ? String(m).padStart(2, "0") : ""}`;
  switch (r.operator) {
    case "=": return `${hhmm} exatas`;
    case ">=": return `${hhmm} ou mais`;
    case "<=": return `${hhmm} ou menos`;
    case ">": return `mais de ${hhmm}`;
    case "<": return `menos de ${hhmm}`;
    case "!=": return `diferente de ${hhmm}`;
  }
}

/** One rule as a readable sentence: "Caixa ou Mercearia · em Santo Amaro · 6h exatas". */
function RuleSentence({ rule }: { rule: WizardValueRule }) {
  const parts: ReactNode[] = rule.conditions.map((c, i) => {
    const kind = conditionKind(c);
    if (kind === "funcao") return <span key={i} className="vr-chip">{c.values.join(" ou ") || "Função?"}</span>;
    if (kind === "local") return <span key={i}>em <span className="vr-chip">{c.values.join(" ou ") || "Local?"}</span></span>;
    if (kind === "data") return <span key={i}>em <span className="vr-chip">{c.values.map((v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDateSlash(v) : v)).join(", ") || "Data?"}</span></span>;
    const verb = kind === "inicio" ? "começando" : "terminando";
    const when = c.scheduleRule.endsWith("after") ? "depois das" : "antes das";
    return <span key={i}>{verb} <span className="vr-chip">{when} {c.scheduleTime || "--:--"}</span></span>;
  });
  if (!parts.length) parts.push(<span key="all">Todo turno</span>);
  const dur = durationText(rule);
  if (dur) parts.push(<span key="dur" className="vr-chip vr-chip-dur">{dur}</span>);
  return (
    <div className="vr-sentence">
      {parts.map((p, i) => (
        <span key={i} className="vr-part">
          {i > 0 && <span className="vr-dot">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/** Chips + a free-text field with suggestions (known Funções/Locais); Enter or picking a suggestion adds it. */
function ValuesInput({ values, suggestions, onChange, placeholder }: { values: string[]; suggestions: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const left = suggestions.filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()));
  function add(raw: string) {
    const v = raw.trim();
    if (!v || values.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    onChange([...values, v]);
    setDraft("");
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  }
  return (
    <div className="vr-multi">
      {values.map((v) => (
        <span key={v} className="vr-chip">
          {v}
          <button type="button" aria-label={`Remover ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={draft}
        placeholder={values.length ? "+ outro" : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          // Picking a datalist suggestion fires a plain change with the full value.
          if (left.some((s) => s === v)) add(v);
          else setDraft(v);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
      />
      <datalist id={listId}>
        {left.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

function DatesInput({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="vr-multi">
      {values.map((v) => (
        <span key={v} className="vr-chip">
          {/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDateSlash(v) : v}
          <button type="button" aria-label="Remover data" onClick={() => onChange(values.filter((x) => x !== v))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        type="date"
        aria-label="Adicionar data"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v && !values.includes(v)) onChange([...values, v].sort());
        }}
      />
    </div>
  );
}

/**
 * "Valor do turno" — the if/else-if/else pay-value chain, shared by
 * `CompanyFormPage` (a company's own chain) and `ClientFormPage` (a client's
 * optional override). Each rule reads as one sentence; the pencil opens it
 * inline. "Qualquer outro turno" (the `else` step) is always the last row,
 * and "Testar um turno" shows which rule a sample shift would get.
 * `readOnly` lists the rules without any controls (a client looking at the
 * company rules it inherits).
 */
export default function PaymentValueRulesEditor({
  valueRules,
  onChange,
  readOnly = false,
  companyIds,
}: {
  valueRules: WizardValueRule[];
  onChange?: (rules: WizardValueRule[]) => void;
  readOnly?: boolean;
  /** Narrows the Função suggestions to these empresas' roles. */
  companyIds?: number[];
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [locals, setLocals] = useState<string[]>([]);
  const [roles, setRoles] = useState<{ companyId: number; name: string }[]>([]);
  const companyKey = (companyIds ?? []).join(",");

  useEffect(() => {
    if (readOnly) return;
    listDistinctPaymentShiftLocals().then(setLocals).catch(() => {});
    listRolesGlobal().then(setRoles).catch(() => {});
  }, [readOnly]);

  const roleNames = useMemo(() => {
    const scoped = companyIds && companyIds.length ? roles.filter((r) => companyIds.includes(r.companyId)) : roles;
    return Array.from(new Set(scoped.map((r) => r.name))).sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles, companyKey]);

  const conditionRules = valueRules.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "condition");
  const elseIndex = valueRules.findIndex((r) => r.kind === "else");
  const elseRule = elseIndex === -1 ? null : valueRules[elseIndex];

  function emit(next: WizardValueRule[]) {
    onChange?.(next);
  }
  function update(index: number, patch: Partial<WizardValueRule>) {
    emit(valueRules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function updateCondition(index: number, ci: number, patch: Partial<WizardValueCondition>) {
    const rule = valueRules[index];
    update(index, { conditions: rule.conditions.map((c, j) => (j === ci ? { ...c, ...patch } : c)) });
  }
  function addRule() {
    const rule: WizardValueRule = { kind: "condition", conditions: [newCondition("funcao")], operator: "any", hours: "", minutes: "", amount: "" };
    const at = elseIndex === -1 ? valueRules.length : elseIndex;
    emit([...valueRules.slice(0, at), rule, ...valueRules.slice(at)]);
    setEditing(at);
  }
  function removeRule(index: number) {
    emit(valueRules.filter((_, i) => i !== index));
    setEditing(null);
  }
  /** Moves a condition rule up/down among the condition rules (the else row always stays last). */
  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= valueRules.length || valueRules[target].kind === "else") return;
    const next = [...valueRules];
    [next[index], next[target]] = [next[target], next[index]];
    emit(next);
    if (editing === index) setEditing(target);
    else if (editing === target) setEditing(index);
  }
  function setElseAmount(text: string) {
    if (elseRule) emit(valueRules.map((r, i) => (i === elseIndex ? { ...r, amount: text } : r)));
    else emit([...valueRules, { kind: "else", conditions: [], operator: "any", hours: "", minutes: "", amount: text }]);
  }

  // ---- "Testar um turno" ----
  const [testRole, setTestRole] = useState("");
  const [testLocal, setTestLocal] = useState("");
  const [testStart, setTestStart] = useState("07:00");
  const [testEnd, setTestEnd] = useState("13:00");
  const [testDate, setTestDate] = useState(() => new Date().toISOString().slice(0, 10));
  const test = useMemo(() => {
    const start = parseTimeToMinutes(testStart);
    const end = parseTimeToMinutes(testEnd);
    if (start === null || end === null) return null;
    const saved = toPaymentValueRules(valueRules);
    const duration = shiftDurationMinutes(start, end);
    const savedIndex = matchingPaymentValueRuleIndex(saved, duration, {
      workDate: testDate,
      local: testLocal,
      role: testRole,
      scheduleStartMinutes: start,
      scheduleEndMinutes: end,
    });
    // `saved` drops an empty else row; map back to the draft index.
    const draftIndexes = valueRules.map((r, i) => ({ r, i })).filter((x) => !(x.r.kind === "else" && x.r.amount.trim() === "")).map((x) => x.i);
    return {
      duration,
      index: savedIndex === null ? null : draftIndexes[savedIndex],
      amount: savedIndex === null ? null : saved[savedIndex].amount,
    };
  }, [valueRules, testRole, testLocal, testStart, testEnd, testDate]);
  const fmtDuration = (m: number) => `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, "0") : ""}`;

  return (
    <div className="vr">
      {!readOnly && (
        <p className="vr-how">
          <Info size={13} />
          <span>
            As regras são lidas <b>de cima para baixo</b> e vale a <b>primeira</b> que combinar com o turno. Deixe as mais específicas em cima.
          </span>
        </p>
      )}

      <div className={`vr-list${readOnly ? " vr-list-readonly" : ""}`}>
        {conditionRules.map(({ r: rule, i }, pos) => {
          const open = !readOnly && editing === i;
          const amount = parseAmount(rule.amount);
          return (
            <div key={i} className={`vr-rule${test?.index === i && !readOnly ? " vr-rule-hit" : ""}${isValueRuleValid(rule) ? "" : " vr-rule-invalid"}`}>
              <div className="vr-row">
                <span className="vr-num">{pos + 1}</span>
                <RuleSentence rule={rule} />
                <span className="vr-amount">{amount === null ? "R$ —" : formatCurrencyBRL(amount)}</span>
                {!readOnly && (
                  <span className="vr-actions">
                    <button type="button" className="vr-icon" aria-label="Subir" title="Subir" disabled={pos === 0} onClick={() => move(i, -1)}>
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" className="vr-icon" aria-label="Descer" title="Descer" disabled={pos === conditionRules.length - 1} onClick={() => move(i, 1)}>
                      <ChevronDown size={14} />
                    </button>
                    <button type="button" className="vr-icon" aria-label={open ? "Fechar edição" : "Editar"} title={open ? "Fechar edição" : "Editar"} aria-expanded={open} onClick={() => setEditing(open ? null : i)}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" className="vr-icon" aria-label="Excluir regra" title="Excluir regra" onClick={() => removeRule(i)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </div>

              {open && (
                <div className="vr-editor">
                  <div>
                    <div className="vr-label">Quando o turno for</div>
                    <div className="vr-conds">
                      {rule.conditions.length === 0 && <p className="vr-hint">Sem condição: vale para todo turno.</p>}
                      {rule.conditions.map((c, ci) => {
                        const kind = conditionKind(c);
                        return (
                          <div key={ci} className="vr-cond">
                            <select
                              value={kind}
                              aria-label="Tipo de condição"
                              onChange={(e) => {
                                const next = [...rule.conditions];
                                next[ci] = newCondition(e.target.value as ConditionKind);
                                update(i, { conditions: next });
                              }}
                            >
                              {CONDITION_KINDS.map((k) => (
                                <option key={k.id} value={k.id}>
                                  {k.label}
                                </option>
                              ))}
                            </select>
                            {kind === "funcao" && (
                              <ValuesInput values={c.values} suggestions={roleNames} placeholder="Escolha ou digite uma função" onChange={(values) => updateCondition(i, ci, { values })} />
                            )}
                            {kind === "local" && (
                              <ValuesInput values={c.values} suggestions={locals} placeholder="Escolha ou digite um local" onChange={(values) => updateCondition(i, ci, { values })} />
                            )}
                            {kind === "data" && <DatesInput values={c.values} onChange={(values) => updateCondition(i, ci, { values })} />}
                            {(kind === "inicio" || kind === "fim") && (
                              <div className="vr-time">
                                <select
                                  value={c.scheduleRule.endsWith("after") ? "after" : "before"}
                                  aria-label="Antes ou depois"
                                  onChange={(e) => updateCondition(i, ci, { scheduleRule: `${kind === "inicio" ? "start" : "end"}-${e.target.value}` as ScheduleTimeRule })}
                                >
                                  <option value="after">depois das</option>
                                  <option value="before">antes das</option>
                                </select>
                                <TimeField value={c.scheduleTime} onChange={(v) => updateCondition(i, ci, { scheduleTime: v })} ariaLabel="Horário" />
                              </div>
                            )}
                            <button type="button" className="vr-icon" aria-label="Remover condição" title="Remover condição" onClick={() => update(i, { conditions: rule.conditions.filter((_, j) => j !== ci) })}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <button type="button" className="vr-add-cond" onClick={() => update(i, { conditions: [...rule.conditions, newCondition("local")] })}>
                      <Plus size={13} /> Condição
                    </button>
                  </div>

                  <div>
                    <div className="vr-label">E a pessoa trabalhou</div>
                    <div className="vr-duration">
                      <select value={rule.operator} aria-label="Duração" onChange={(e) => update(i, { operator: e.target.value as WizardDurationOperator })}>
                        {DURATION_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {rule.operator !== "any" && (
                        <span className="vr-hhmm">
                          <input inputMode="numeric" value={rule.hours} aria-label="Horas" placeholder="0" onChange={(e) => update(i, { hours: e.target.value.replace(/\D/g, "") })} /> h
                          <input inputMode="numeric" value={rule.minutes} aria-label="Minutos" placeholder="0" onChange={(e) => update(i, { minutes: e.target.value.replace(/\D/g, "").slice(0, 2) })} /> min
                        </span>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="vr-label">O turno vale</div>
                    <span className="vr-money">
                      <span>R$</span>
                      <input inputMode="decimal" value={rule.amount} placeholder="0,00" aria-label="Valor do turno" onChange={(e) => update(i, { amount: e.target.value })} />
                    </span>
                  </div>

                  <div className="vr-editor-foot">
                    {!isValueRuleValid(rule) && <span className="vr-hint">Preencha o valor e todas as condições.</span>}
                    <button type="button" onClick={() => setEditing(null)}>
                      Pronto
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className={`vr-rule vr-rule-else${test?.index === elseIndex && elseIndex !== -1 && !readOnly ? " vr-rule-hit" : ""}`}>
          <div className="vr-row">
            <span className="vr-num vr-num-else">·</span>
            <div className="vr-sentence">{conditionRules.length ? "Qualquer outro turno" : "Todo turno"}</div>
            {readOnly ? (
              <span className={`vr-amount${elseRule && parseAmount(elseRule.amount) !== null ? "" : " vr-amount-none"}`}>
                {elseRule && parseAmount(elseRule.amount) !== null ? formatCurrencyBRL(parseAmount(elseRule.amount)!) : "sem valor"}
              </span>
            ) : (
              <span className="vr-money vr-money-small">
                <span>R$</span>
                <input inputMode="decimal" value={elseRule?.amount ?? ""} placeholder="sem valor" aria-label="Valor de qualquer outro turno" onChange={(e) => setElseAmount(e.target.value)} />
              </span>
            )}
            {!readOnly && <span />}
          </div>
        </div>
      </div>

      {!readOnly && (
        <>
          <button type="button" className="outline vr-new" onClick={addRule}>
            <Plus size={14} /> Nova regra
          </button>

          <div className="vr-test">
            <div className="vr-test-head">
              <strong>Testar um turno</strong>
              <span>Veja qual regra vale e quanto o turno receberia.</span>
            </div>
            <div className="vr-test-fields">
              <label>
                Função
                <input list="vr-test-roles" value={testRole} onChange={(e) => setTestRole(e.target.value)} placeholder="Ex.: Caixa" />
                <datalist id="vr-test-roles">{roleNames.map((r) => <option key={r} value={r} />)}</datalist>
              </label>
              <label>
                Local
                <input list="vr-test-locals" value={testLocal} onChange={(e) => setTestLocal(e.target.value)} placeholder="Ex.: Loja 07" />
                <datalist id="vr-test-locals">{locals.map((l) => <option key={l} value={l} />)}</datalist>
              </label>
              <label>
                Início
                <TimeField value={testStart} onChange={setTestStart} ariaLabel="Início do turno de teste" />
              </label>
              <label>
                Fim
                <TimeField value={testEnd} onChange={setTestEnd} ariaLabel="Fim do turno de teste" />
              </label>
              <label>
                Data
                <input type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} />
              </label>
            </div>
            <div className={`vr-test-result${test && test.amount === null ? " vr-test-miss" : ""}`}>
              {!test ? (
                <span>Informe início e fim.</span>
              ) : test.amount === null ? (
                <>
                  <strong>Sem valor</strong>
                  <span>Turno de {fmtDuration(test.duration)}. Nenhuma regra combinou{elseRule ? "" : " e \"Qualquer outro turno\" está sem valor"}.</span>
                </>
              ) : (
                <>
                  <strong>{formatCurrencyBRL(test.amount)}</strong>
                  <span>
                    Turno de {fmtDuration(test.duration)}.{" "}
                    {test.index === elseIndex ? 'Vale "Qualquer outro turno".' : `Vale a regra ${conditionRules.findIndex((x) => x.i === test.index) + 1}.`}
                  </span>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
