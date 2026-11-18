import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import OptionPicker from "./OptionPicker";
import type { ClientRow, CompanyRow } from "../lib/db";
import {
  PAYMENT_SHIFT_STATUS_LABELS,
  PAYMENT_TARGET_FIELD_LABELS,
  SHEET_NAME_RULE_FIELD,
  type IdentifierAttempt,
  type IdentifierField,
  type PaymentFileKind,
  type PaymentRuleField,
  type PaymentShiftStatus,
  type PaymentTemplateRule,
  type PaymentStatusRule,
} from "../lib/types";

/**
 * The payment template wizard's last step ("Detalhes"): a name, where each
 * shift goes (empresa/cliente), how the person is found, the optional
 * status rules and, folded away, date format and accepted file kinds.
 * Rules read as sentences, like "Valor do turno" in Empresa/Cliente; the
 * pencil opens one in place. Matching always ignores case.
 */

/** One field test of a rule — all of a rule's tests must match. */
export interface RuleTest {
  field: PaymentRuleField;
  values: string[];
}

/** "Se Função for Caixa ou Remoto → Cliente X (Empresa Y)". */
export interface RouteDraft {
  tests: RuleTest[];
  companyId: number | null;
  clientId: number | null;
}

/** The "Qualquer outro turno" destination; both empty means none. */
export interface Destination {
  companyId: number | null;
  clientId: number | null;
}

/** "Se Status for pago → Pago". An empty `values` means "the field is empty". */
export interface StatusDraft {
  tests: RuleTest[];
  status: PaymentShiftStatus;
}

const RULE_FIELDS: PaymentRuleField[] = ["funcao", "local", SHEET_NAME_RULE_FIELD, "status", "nome", "cpf", "matricula", "data", "horario"];
const STATUSES: PaymentShiftStatus[] = ["pendente", "pago", "erro"];
const IDENTIFIER_DEFAULT_ORDER: IdentifierField[] = ["cpf", "matricula", "nome"];

export function fieldLabel(field: PaymentRuleField): string {
  return field === SHEET_NAME_RULE_FIELD ? "Aba" : PAYMENT_TARGET_FIELD_LABELS[field];
}

/* ---------- conversions between the saved template and these drafts ---------- */

export function routesFromSaved(rules: PaymentTemplateRule[]): { routes: RouteDraft[]; fallback: Destination } {
  const elseRule = rules.find((r) => r.kind === "else");
  return {
    routes: rules
      .filter((r) => r.kind === "condition")
      .map((r) => ({ tests: r.conditions.map((c) => ({ field: c.field, values: [...c.values] })), companyId: r.companyId, clientId: r.clientId })),
    fallback: { companyId: elseRule?.companyId ?? null, clientId: elseRule?.clientId ?? null },
  };
}

export function statusFromSaved(rules: PaymentStatusRule[]): { rules: StatusDraft[]; fallback: PaymentShiftStatus } {
  return {
    rules: rules
      .filter((r) => r.kind === "condition")
      .map((r) => ({ tests: r.conditions.map((c) => ({ field: c.field, values: [...c.values] })), status: r.status })),
    fallback: rules.find((r) => r.kind === "else")?.status ?? "pendente",
  };
}

/** Saved attempts → one order of identifier fields (attempts that combined fields are read in order). */
export function identifierOrderFromSaved(attempts: IdentifierAttempt[]): IdentifierField[] {
  const order: IdentifierField[] = [];
  for (const a of attempts) for (const f of a.fields) if (!order.includes(f)) order.push(f);
  for (const f of IDENTIFIER_DEFAULT_ORDER) if (!order.includes(f)) order.push(f);
  return order;
}

/** The order shown and saved: only the identifier columns the template answers. */
export function effectiveIdentifierOrder(order: IdentifierField[], mapped: IdentifierField[]): IdentifierField[] {
  const shown = order.filter((f) => mapped.includes(f));
  return shown.length > 0 ? shown : order;
}

function isTestComplete(t: RuleTest): boolean {
  return t.values.length > 0;
}

export function isRouteComplete(r: RouteDraft): boolean {
  return r.companyId !== null && r.clientId !== null && r.tests.length > 0 && r.tests.every(isTestComplete);
}

/** Why "Salvar" is blocked on this step, or `null`. */
export function detailsProblem(name: string, routes: RouteDraft[], fallback: Destination): string | null {
  if (!name.trim()) return "Dê um nome ao template";
  if (routes.some((r) => !isRouteComplete(r))) return "Complete as regras de empresa e cliente";
  if ((fallback.companyId === null) !== (fallback.clientId === null)) return "Escolha empresa e cliente em “Qualquer outro turno”";
  if (routes.length === 0 && fallback.companyId === null) return "Diga para qual empresa e cliente vão os turnos";
  return null;
}

/* ---------- small pieces ---------- */

function ValuesPicker({ field, values, suggestions, onChange, emptyLabel }: { field: PaymentRuleField; values: string[]; suggestions: string[]; onChange: (v: string[]) => void; emptyLabel?: string }) {
  const all = [...suggestions];
  for (const v of values) if (!all.some((s) => s.toLowerCase() === v.toLowerCase())) all.push(v);
  const options = all.sort((a, b) => a.localeCompare(b)).map((v) => ({ id: v, label: v }));
  const selected = new Set(options.filter((o) => values.some((v) => v.toLowerCase() === o.id.toLowerCase())).map((o) => o.id));
  const label = fieldLabel(field).toLowerCase();
  return (
    <OptionPicker
      showTiles={false}
      align="left"
      options={options}
      selected={selected}
      onToggle={(id) => (selected.has(id) ? onChange(values.filter((v) => v.toLowerCase() !== id.toLowerCase())) : onChange([...values, id]))}
      onSelectAll={() => onChange(options.map((o) => o.id))}
      onClear={() => onChange([])}
      onCreate={(text) => onChange([...values, text])}
      title={fieldLabel(field)}
      allPlaceholder={emptyLabel ?? `Escolha ou digite ${label}`}
      searchPlaceholder={`Buscar ou digitar ${label}`}
      selectAllLabel="Selecionar todos"
    />
  );
}

function FieldPicker({ value, onChange }: { value: PaymentRuleField; onChange: (f: PaymentRuleField) => void }) {
  return (
    <OptionPicker
      single
      showTiles={false}
      align="left"
      options={RULE_FIELDS.map((f) => ({ id: f, label: fieldLabel(f) }))}
      selected={new Set([value])}
      onToggle={(id) => onChange(id as PaymentRuleField)}
      title="Campo"
      allPlaceholder="Campo"
      searchPlaceholder="Buscar campo"
    />
  );
}

function StatusPicker({ value, onChange }: { value: PaymentShiftStatus; onChange: (s: PaymentShiftStatus) => void }) {
  return (
    <OptionPicker
      single
      showTiles={false}
      align="left"
      options={STATUSES.map((s) => ({ id: s, label: PAYMENT_SHIFT_STATUS_LABELS[s] }))}
      selected={new Set([value])}
      onToggle={(id) => onChange(id as PaymentShiftStatus)}
      title="Status"
      allPlaceholder="Status"
      searchPlaceholder="Buscar"
    />
  );
}

function DestinationPickers({ value, onChange, companies, clients, allowNone }: { value: Destination; onChange: (d: Destination) => void; companies: CompanyRow[]; clients: ClientRow[]; allowNone?: boolean }) {
  const companyOptions = [...(allowNone ? [{ id: "none", label: "Nenhuma" }] : []), ...companies.map((c) => ({ id: String(c.id), label: c.name }))];
  const clientOptions = clients.filter((c) => c.companyId === value.companyId).map((c) => ({ id: String(c.id), label: c.name }));
  return (
    <div className="tdet-two">
      <OptionPicker
        single
        showTiles={false}
        align="left"
        options={companyOptions}
        selected={new Set(value.companyId === null ? [] : [String(value.companyId)])}
        onToggle={(id) => onChange({ companyId: id === "none" ? null : Number(id), clientId: null })}
        title="Empresa"
        allPlaceholder="Empresa"
        searchPlaceholder="Buscar empresa"
      />
      {value.companyId === null ? (
        <span className="tdet-placeholder">Cliente</span>
      ) : (
        <OptionPicker
          single
          showTiles={false}
          align="left"
          options={clientOptions}
          selected={new Set(value.clientId === null ? [] : [String(value.clientId)])}
          onToggle={(id) => onChange({ ...value, clientId: Number(id) })}
          title="Cliente"
          allPlaceholder="Cliente"
          searchPlaceholder="Buscar cliente"
        />
      )}
    </div>
  );
}

function TestsSentence({ tests }: { tests: RuleTest[] }) {
  return (
    <div className="vr-sentence">
      {tests.map((t, i) => (
        <span key={i} className="vr-part">
          {i > 0 && <span className="vr-dot">e</span>}
          {fieldLabel(t.field)} <span className="vr-chip">{t.values.length ? t.values.join(" ou ") : "?"}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------- the step ---------- */

export default function PaymentTemplateDetails({
  name,
  onName,
  routes,
  onRoutes,
  fallback,
  onFallback,
  statusRules,
  onStatusRules,
  statusFallback,
  onStatusFallback,
  identifierOrder,
  onIdentifierOrder,
  mappedIdentifiers,
  dateFormat,
  onDateFormat,
  dateFormats,
  fileKind,
  acceptedFileKinds,
  onToggleFileKind,
  companies,
  clients,
  suggestionsFor,
}: {
  name: string;
  onName: (v: string) => void;
  routes: RouteDraft[];
  onRoutes: (v: RouteDraft[]) => void;
  fallback: Destination;
  onFallback: (v: Destination) => void;
  statusRules: StatusDraft[];
  onStatusRules: (v: StatusDraft[]) => void;
  statusFallback: PaymentShiftStatus;
  onStatusFallback: (v: PaymentShiftStatus) => void;
  identifierOrder: IdentifierField[];
  onIdentifierOrder: (v: IdentifierField[]) => void;
  /** Identifier columns answered in Colunas (any included sheet). */
  mappedIdentifiers: IdentifierField[];
  dateFormat: string;
  onDateFormat: (v: string) => void;
  dateFormats: string[];
  fileKind: PaymentFileKind | null;
  acceptedFileKinds: Set<PaymentFileKind>;
  onToggleFileKind: (k: PaymentFileKind) => void;
  companies: CompanyRow[];
  clients: ClientRow[];
  /** Known values for a field (from the sample file and the database), offered in the pickers. */
  suggestionsFor: (field: PaymentRuleField) => string[];
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const companyName = (id: number | null) => companies.find((c) => c.id === id)?.name ?? "";
  const clientName = (id: number | null) => clients.find((c) => c.id === id)?.name ?? "";

  function updateRoute(i: number, patch: Partial<RouteDraft>) {
    onRoutes(routes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function moveRoute(i: number, dir: -1 | 1) {
    const next = [...routes];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onRoutes(next);
    setEditing(null);
  }
  function updateStatusRule(i: number, patch: Partial<StatusDraft>) {
    onStatusRules(statusRules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const order = effectiveIdentifierOrder(identifierOrder, mappedIdentifiers);
  function moveIdentifier(i: number, dir: -1 | 1) {
    const next = [...order];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onIdentifierOrder([...next, ...identifierOrder.filter((f) => !next.includes(f))]);
  }

  const kinds = fileKind === "csv" ? ["CSV"] : Array.from(new Set([fileKind, ...acceptedFileKinds])).filter(Boolean).map((k) => k!.toUpperCase());

  return (
    <div className="tmap">
      <h2 className="tmap-title">Últimos detalhes</h2>
      <p className="tmap-lead">Dê um nome e diga para onde vai cada turno.</p>

      <section className="tdet-section">
        <h3>Nome</h3>
        <input type="text" className="tdet-input" value={name} onChange={(e) => onName(e.target.value)} placeholder="Ex.: Escalas mensais — Cliente X" aria-label="Nome do template" />
      </section>

      <section className="tdet-section">
        <h3>Para qual empresa e cliente vai cada turno?</h3>
        <p className="tdet-sub">Lidas de cima para baixo; vale a primeira que combinar. Se o arquivo é sempre de um só cliente, basta "{routes.length ? "Qualquer outro turno" : "Todo turno"}".</p>
        <div className="vr-list">
          {routes.map((r, i) => {
            const open = editing === i;
            const complete = isRouteComplete(r);
            return (
              <div key={i} className={`vr-rule${complete ? "" : " vr-rule-invalid"}`}>
                <div className="vr-row">
                  <span className="vr-num">{i + 1}</span>
                  <TestsSentence tests={r.tests} />
                  <span className={`tdet-dest${r.clientId === null ? " missing" : ""}`}>
                    {r.clientId === null ? (
                      "falta o destino"
                    ) : (
                      <>
                        → {clientName(r.clientId)} <small>{companyName(r.companyId)}</small>
                      </>
                    )}
                  </span>
                  <span className="vr-actions">
                    <button type="button" className="vr-icon" aria-label="Subir" title="Subir" disabled={i === 0} onClick={() => moveRoute(i, -1)}>
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" className="vr-icon" aria-label="Descer" title="Descer" disabled={i === routes.length - 1} onClick={() => moveRoute(i, 1)}>
                      <ChevronDown size={14} />
                    </button>
                    <button type="button" className="vr-icon" aria-label={open ? "Fechar edição" : "Editar"} title={open ? "Fechar edição" : "Editar"} aria-expanded={open} onClick={() => setEditing(open ? null : i)}>
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="vr-icon"
                      aria-label="Excluir regra"
                      title="Excluir regra"
                      onClick={() => {
                        onRoutes(routes.filter((_, j) => j !== i));
                        setEditing(null);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                {open && (
                  <div className="vr-editor">
                    <div>
                      <div className="vr-label">Quando o turno tiver</div>
                      <div className="vr-conds">
                        {r.tests.map((t, ti) => (
                          <div key={ti} className="vr-cond">
                            <FieldPicker
                              value={t.field}
                              onChange={(field) => updateRoute(i, { tests: r.tests.map((x, k) => (k === ti ? { field, values: field === x.field ? x.values : [] } : x)) })}
                            />
                            <ValuesPicker
                              field={t.field}
                              values={t.values}
                              suggestions={suggestionsFor(t.field)}
                              onChange={(values) => updateRoute(i, { tests: r.tests.map((x, k) => (k === ti ? { ...x, values } : x)) })}
                            />
                            <button
                              type="button"
                              className="vr-icon"
                              aria-label="Remover condição"
                              title="Remover condição"
                              disabled={r.tests.length === 1}
                              onClick={() => updateRoute(i, { tests: r.tests.filter((_, k) => k !== ti) })}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button type="button" className="vr-add-cond" onClick={() => updateRoute(i, { tests: [...r.tests, { field: "local", values: [] }] })}>
                        <Plus size={13} /> Condição
                      </button>
                    </div>
                    <div>
                      <div className="vr-label">Vai para</div>
                      <DestinationPickers value={r} onChange={(d) => updateRoute(i, d)} companies={companies} clients={clients} />
                    </div>
                    <div className="vr-editor-foot">
                      {!complete && <span className="vr-hint">Escolha os valores, a empresa e o cliente.</span>}
                      <button type="button" onClick={() => setEditing(null)}>
                        Pronto
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="vr-rule">
            <div className="vr-row tdet-else-row">
              <span className="vr-num vr-num-else">·</span>
              <div className="vr-sentence">{routes.length ? "Qualquer outro turno" : "Todo turno"}</div>
              <DestinationPickers value={fallback} onChange={onFallback} companies={companies} clients={clients} allowNone />
            </div>
          </div>
        </div>
        <button
          type="button"
          className="outline vr-new"
          onClick={() => {
            onRoutes([...routes, { tests: [{ field: "funcao", values: [] }], companyId: null, clientId: null }]);
            setEditing(routes.length);
          }}
        >
          <Plus size={14} /> Nova regra
        </button>
      </section>

      <section className="tdet-section">
        <h3>Como achar o colaborador?</h3>
        {order.length === 1 ? (
          <p className="tdet-once">
            Pelo <b>{PAYMENT_TARGET_FIELD_LABELS[order[0]]}</b>, a única coluna de colaborador respondida em Colunas.
          </p>
        ) : (
          <>
            <p className="tdet-sub">Tenta na ordem e para no primeiro que encontrar alguém. Maiúsculas não importam.</p>
            <div className="tdet-ids">
              {order.map((f, i) => (
                <div key={f} className="tdet-id">
                  <span className="vr-num">{i + 1}</span>
                  <span className="tdet-id-text">
                    {i === 0 ? "Procurar pelo" : "Se não achar, pelo"} <b>{PAYMENT_TARGET_FIELD_LABELS[f]}</b>
                  </span>
                  <button type="button" className="vr-icon" aria-label="Subir" title="Subir" disabled={i === 0} onClick={() => moveIdentifier(i, -1)}>
                    <ChevronUp size={14} />
                  </button>
                  <button type="button" className="vr-icon" aria-label="Descer" title="Descer" disabled={i === order.length - 1} onClick={() => moveIdentifier(i, 1)}>
                    <ChevronDown size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="tdet-section">
        <h3>Status do turno</h3>
        {statusRules.length === 0 ? (
          <div className="tdet-empty">
            <span>
              Todo turno entra como <b>{PAYMENT_SHIFT_STATUS_LABELS.pendente}</b>.
            </span>
            <button type="button" className="tmap-link" onClick={() => onStatusRules([{ tests: [{ field: "status", values: [] }], status: "pago" }])}>
              Definir pelo valor de uma coluna
            </button>
          </div>
        ) : (
          <>
            <p className="tdet-sub">Lidas de cima para baixo. Sem valor escolhido, a regra vale quando o campo está vazio.</p>
            <div className="vr-list">
              {statusRules.map((r, i) => (
                <div key={i} className="vr-rule">
                  <div className="tdet-status-row">
                    <span className="vr-num">{i + 1}</span>
                    <div className="tdet-status-tests">
                      {r.tests.map((t, ti) => (
                        <div key={ti} className="tdet-status-test">
                          <FieldPicker
                            value={t.field}
                            onChange={(field) => updateStatusRule(i, { tests: r.tests.map((x, k) => (k === ti ? { field, values: field === x.field ? x.values : [] } : x)) })}
                          />
                          <ValuesPicker
                            field={t.field}
                            values={t.values}
                            suggestions={suggestionsFor(t.field)}
                            emptyLabel="vazio"
                            onChange={(values) => updateStatusRule(i, { tests: r.tests.map((x, k) => (k === ti ? { ...x, values } : x)) })}
                          />
                        </div>
                      ))}
                    </div>
                    <span className="tdet-arrow">→</span>
                    <StatusPicker value={r.status} onChange={(status) => updateStatusRule(i, { status })} />
                    <button type="button" className="vr-icon" aria-label="Excluir regra" title="Excluir regra" onClick={() => onStatusRules(statusRules.filter((_, j) => j !== i))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <div className="vr-rule">
                <div className="tdet-status-row">
                  <span className="vr-num vr-num-else">·</span>
                  <div className="vr-sentence">Qualquer outro turno</div>
                  <span className="tdet-arrow">→</span>
                  <StatusPicker value={statusFallback} onChange={onStatusFallback} />
                  <span />
                </div>
              </div>
            </div>
            <button type="button" className="outline vr-new" onClick={() => onStatusRules([...statusRules, { tests: [{ field: "status", values: [] }], status: "pago" }])}>
              <Plus size={14} /> Nova regra
            </button>
          </>
        )}
      </section>

      <details className="tdet-more">
        <summary>
          Mais opções · datas {dateFormat} · aceita {kinds.join(", ")}
        </summary>
        <div className="tdet-more-body">
          <div className="tmap-q">
            <label>
              Datas
              <small>formato na planilha</small>
            </label>
            <OptionPicker
              single
              showTiles={false}
              align="left"
              options={dateFormats.map((f) => ({ id: f, label: f }))}
              selected={new Set([dateFormat])}
              onToggle={onDateFormat}
              title="Formato das datas"
              allPlaceholder="Escolha o formato"
              searchPlaceholder="Buscar"
            />
          </div>
          {fileKind !== "csv" && (
            <div className="tmap-q">
              <label>
                Também aceitar
                <small>mesmas colunas, outro formato</small>
              </label>
              <div className="tmap-opts">
                {(["xlsx", "xls", "ods"] as PaymentFileKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="tmap-choice"
                    aria-pressed={k === fileKind || acceptedFileKinds.has(k)}
                    disabled={k === fileKind}
                    title={k === fileKind ? "O formato do arquivo usado para montar o template" : undefined}
                    onClick={() => onToggleFileKind(k)}
                  >
                    {k.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="tdet-sub">Linhas cuja Data não está nesse formato são ignoradas na importação (títulos, totais, linhas em branco).</p>
        </div>
      </details>
    </div>
  );
}
