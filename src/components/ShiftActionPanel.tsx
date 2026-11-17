import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CreditCard,
  History,
  Info,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  getPaymentShiftHistory,
  listEmployeePixKeys,
  type EffectivePaymentRules,
  type EmployeePixKeyRow,
  type ShiftFieldDiffRow,
} from "../lib/db";
import {
  centsMaskToAmount,
  describePaymentValueRule,
  diffFieldLabel,
  formatCurrencyBRL,
  formatDate,
  formatDateTime,
  formatDateTimeAbbrevYY,
  formatMinutesAsTime,
  matchingPaymentValueRuleIndex,
  scheduleDurationMinutes,
  shiftValue,
} from "../lib/format";
import { PIX_KEY_TYPE_LABELS } from "../lib/pix";
import type { PaymentShiftRow, PaymentShiftStatus } from "../lib/types";
import Avatar from "./Avatar";
import CurrencyInput from "./CurrencyInput";
import SidePanel from "./SidePanel";

export type ShiftActionKind = "pay" | "revert" | "history" | "delete";

export interface ShiftActionTarget {
  kind: ShiftActionKind;
  shift: PaymentShiftRow;
}

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string }> = {
  pendente: { className: "badge overwrite", label: "Pendente" },
  erro: { className: "badge file-error", label: "Erro" },
  pago: { className: "badge ok", label: "Pago" },
};

const HEADER: Record<ShiftActionKind, { title: string; icon: LucideIcon; danger?: boolean }> = {
  pay: { title: "Fazer pagamento", icon: CreditCard },
  revert: { title: "Voltar para pendente", icon: Undo2 },
  history: { title: "Histórico do turno", icon: History },
  delete: { title: "Remover turno", icon: Trash2, danger: true },
};

function scheduleText(s: PaymentShiftRow): string | null {
  if (s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
  return `${formatMinutesAsTime(s.scheduleStartMinutes)} – ${formatMinutesAsTime(s.scheduleEndMinutes)}`;
}

function weekday(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
}

/** Which turno the panel is about — the same strip on every action, so it's never ambiguous. */
function ShiftStrip({ shift }: { shift: PaymentShiftRow }) {
  const badge = STATUS_BADGE[shift.status];
  const duration = scheduleDurationMinutes(shift);
  const schedule = scheduleText(shift);
  const meta = [
    `${weekday(shift.workDate)}, ${formatDate(shift.workDate)}`,
    shift.local,
    shift.role,
    schedule ? `${schedule}${duration !== null ? ` (${formatMinutesAsTime(duration)})` : ""}` : null,
  ].filter(Boolean);
  return (
    <div className="sa-strip">
      <Avatar name={shift.employeeName} />
      <div className="sa-strip-text">
        <div className="sa-strip-name">
          <span>{shift.employeeName}</span>
          <span className={badge.className}>{badge.label}</span>
        </div>
        <div className="sa-strip-meta">{meta.join(" · ")}</div>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? "sa-copy sa-copy-done" : "sa-copy"}
      aria-label={label}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

function Notice({ tone, icon: Icon, children }: { tone: "warn" | "danger" | "info"; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className={`sa-notice sa-notice-${tone}`}>
      <Icon size={15} />
      <div>{children}</div>
    </div>
  );
}

/** Where the suggested Valor comes from, in words. */
function valueOrigin(shift: PaymentShiftRow, rules: EffectivePaymentRules | null): string {
  if (shift.amount !== null) return "Valor registrado no turno";
  const duration = scheduleDurationMinutes(shift);
  if (!rules || duration === null) return "Sem horário ou regra de valor: digite o valor.";
  const index = matchingPaymentValueRuleIndex(rules.valueRules, duration, shift);
  if (index === null) return "Nenhuma regra de valor se aplica a este turno: digite o valor.";
  return `Pela regra: ${describePaymentValueRule(rules.valueRules[index])}`;
}

interface HistoryEvent {
  row: PaymentShiftRow;
  title: string;
  tag: string | null;
  changes: { label: string; from: string | null; to: string }[];
}

/** Each step of the chain, oldest first, with only what changed from the step before it. */
function historyEvents(rowsNewestFirst: PaymentShiftRow[], rules: EffectivePaymentRules | null): HistoryEvent[] {
  const rows = [...rowsNewestFirst].reverse();
  const fields = (r: PaymentShiftRow) => {
    const value = shiftValue(r, rules?.valueRules ?? null);
    return [
      { label: "Status", text: STATUS_BADGE[r.status].label },
      { label: "Data", text: formatDate(r.workDate) },
      { label: "Local", text: r.local },
      { label: "Função", text: r.role },
      { label: "Horário", text: scheduleText(r) ?? "—" },
      { label: "Valor", text: value !== null ? formatCurrencyBRL(value) : "—" },
    ];
  };
  return rows.map((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    if (!prev) {
      const first = fields(row).filter((f) => ["Status", "Horário", "Valor"].includes(f.label));
      return {
        row,
        title: row.sourceFileName || row.sourceRowNumber !== null ? "Importado" : "Criado",
        tag: row.sourceFileName,
        changes: first.map((f) => ({ label: f.label, from: null, to: f.text })),
      };
    }
    const before = fields(prev);
    const changes = fields(row)
      .map((f, k) => ({ label: f.label, from: before[k].text, to: f.text }))
      .filter((c) => c.from !== c.to);
    let title: string;
    if (row.status !== prev.status) {
      title = row.status === "pago" ? "Pago" : row.status === "erro" ? "Marcado com erro" : "Voltou para pendente";
    } else if (row.editedManually && !prev.editedManually) {
      title = "Editado manualmente";
    } else if (!row.editedManually) {
      title = "Atualizado pela fonte";
    } else {
      title = "Alterado";
    }
    return { row, title, tag: null, changes };
  });
}

function useShiftHistory(shiftId: number | null) {
  const [rows, setRows] = useState<PaymentShiftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    setError(null);
    if (shiftId === null) return;
    let cancelled = false;
    getPaymentShiftHistory(shiftId)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      cancelled = true;
    };
  }, [shiftId]);
  return { rows, error };
}

/**
 * Every row action on Pagamentos (pagar, voltar para pendente, histórico,
 * remover) in one panel docked beside the table, same as the assistant —
 * the table stays visible, and the arrows move to the turno above/below
 * without closing it.
 */
export default function ShiftActionPanel({
  target,
  rules,
  changes,
  otherPending,
  valueFor,
  busy,
  error,
  payNext,
  onPayNextChange,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onOpenPay,
  onConfirmPay,
  onConfirmRevert,
  onConfirmDelete,
  onClose,
}: {
  target: ShiftActionTarget | null;
  rules: EffectivePaymentRules | null;
  /** What the automatic verification last found different for this turno. */
  changes: ShiftFieldDiffRow[];
  /** Other payable turnos of the same colaborador in the current list. */
  otherPending: PaymentShiftRow[];
  valueFor: (shift: PaymentShiftRow) => number | null;
  busy: boolean;
  error: string | null;
  /** After confirming a payment, open the next pending turno instead of closing. */
  payNext: boolean;
  onPayNextChange: (value: boolean) => void;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onOpenPay: (shift: PaymentShiftRow) => void;
  onConfirmPay: (amount: number) => void;
  onConfirmRevert: () => void;
  onConfirmDelete: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // Kept after `target` clears so the content doesn't vanish mid slide-out.
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);

  const shift = shown?.shift ?? null;
  const kind = shown?.kind ?? "history";
  const key = shown ? `${shown.kind}:${shown.shift.id}` : "";
  const suggested = shift ? shiftValue(shift, rules?.valueRules ?? null) : null;
  const suggestedDigits = suggested !== null ? String(Math.round(suggested * 100)) : "";

  const [digits, setDigits] = useState(suggestedDigits);
  const [pixKeys, setPixKeys] = useState<EmployeePixKeyRow[] | null>(null);
  const [pixError, setPixError] = useState<string | null>(null);
  const [pixIndex, setPixIndex] = useState(0);
  const [deleteAck, setDeleteAck] = useState(false);

  useEffect(() => {
    setDigits(suggestedDigits);
    setDeleteAck(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, suggestedDigits]);

  const employeeId = kind === "pay" && shift ? shift.employeeId : null;
  useEffect(() => {
    setPixKeys(null);
    setPixError(null);
    setPixIndex(0);
    if (employeeId === null) return;
    let cancelled = false;
    listEmployeePixKeys(employeeId)
      .then((k) => !cancelled && setPixKeys(k))
      .catch((e) => !cancelled && setPixError(String(e instanceof Error ? e.message : e)));
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const history = useShiftHistory((kind === "history" || kind === "delete") && shift ? shift.id : null);

  if (!shift) return null;
  const header = HEADER[kind];
  const amountValid = digits !== "";
  const firstName = shift.employeeName.split(" ")[0];

  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (kind === "pay") {
    const pix = pixKeys && pixKeys.length > 0 ? pixKeys[Math.min(pixIndex, pixKeys.length - 1)] : null;
    const edited = digits !== suggestedDigits && suggested !== null;
    const otherTotal = otherPending.reduce((sum, s) => sum + (valueFor(s) ?? 0), 0);
    body = (
      <>
        {changes.length > 0 && (
          <Notice tone="warn" icon={AlertTriangle}>
            <strong>A fonte mudou desde a importação</strong> (verificado em {formatDateTimeAbbrevYY(changes[0].checkedAt)})
            <div className="sa-diff">
              {changes.map((c, i) => (
                <div key={i}>
                  {diffFieldLabel(c.fieldName, c.columnLetter)}: <s>{c.oldValue ?? "—"}</s> → <strong>{c.newValue ?? "—"}</strong>
                </div>
              ))}
            </div>
          </Notice>
        )}
        <div className="sa-slip">
          <div className="sa-slip-row">
            <div className="sa-slip-main">
              <label className="sa-slip-label" htmlFor="shift-action-amount">
                Valor
              </label>
              <CurrencyInput
                id="shift-action-amount"
                size="lg"
                digits={digits}
                onChange={setDigits}
                autoFocus
                placeholder="0,00"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && amountValid && !busy) {
                    e.preventDefault();
                    onConfirmPay(centsMaskToAmount(digits));
                  }
                }}
              />
              <div className="sa-origin">
                {edited ? (
                  <>
                    Editado. Sugerido: {formatCurrencyBRL(suggested!)} ·{" "}
                    <button type="button" className="sa-link" onClick={() => setDigits(suggestedDigits)}>
                      Restaurar
                    </button>
                  </>
                ) : (
                  valueOrigin(shift, rules)
                )}
              </div>
            </div>
            <CopyButton text={amountValid ? centsMaskToAmount(digits).toFixed(2).replace(".", ",") : ""} label="Copiar valor" />
          </div>
          <div className="sa-slip-row">
            <div className="sa-slip-main">
              <div className="sa-slip-label">Chave PIX{pix ? ` · ${PIX_KEY_TYPE_LABELS[pix.keyType]}` : ""}</div>
              {pixKeys === null && !pixError && <div className="muted sa-small">Carregando chaves…</div>}
              {pixError && <div className="sa-small" style={{ color: "var(--danger)" }}>{pixError}</div>}
              {pixKeys !== null && pixKeys.length === 0 && <div className="muted sa-small">Nenhuma chave cadastrada para {firstName}.</div>}
              {pix && <div className="sa-pix-key">{pix.keyValue}</div>}
            </div>
            {pix ? (
              <CopyButton text={pix.keyValue} label="Copiar chave PIX" />
            ) : (
              pixKeys !== null && (
                <button type="button" className="sa-copy" onClick={() => navigate(`/employees/${shift.employeeId}`)}>
                  Cadastrar
                </button>
              )
            )}
          </div>
          {pixKeys && pixKeys.length > 1 && (
            <div className="sa-pix-options">
              {pixKeys.map((k, i) => (
                <button
                  key={k.id}
                  type="button"
                  className={k === pix ? "sa-pix-option sa-pix-option-on" : "sa-pix-option"}
                  aria-pressed={k === pix}
                  onClick={() => setPixIndex(i)}
                >
                  {PIX_KEY_TYPE_LABELS[k.keyType]}
                </button>
              ))}
            </div>
          )}
        </div>
        {otherPending.length > 0 && (
          <div className="sa-siblings">
            <span>
              {firstName} tem mais {otherPending.length} {otherPending.length === 1 ? "turno pendente" : "turnos pendentes"} nesta lista
              {otherTotal > 0 ? ` (${formatCurrencyBRL(otherTotal)})` : ""}
            </span>
            <button type="button" className="sa-copy" onClick={() => onOpenPay(otherPending[0])}>
              Ver
            </button>
          </div>
        )}
        <p className="muted sa-small">Confirmar cria um novo registro "Pago". O registro atual fica no histórico.</p>
      </>
    );
    footer = (
      <>
        <label className="sa-check">
          <input type="checkbox" checked={payNext} onChange={(e) => onPayNextChange(e.target.checked)} />
          Abrir o próximo pendente
        </label>
        <span className="sa-spacer" />
        <button type="button" onClick={() => onConfirmPay(centsMaskToAmount(digits))} disabled={!amountValid || busy}>
          {busy ? "Confirmando..." : "Confirmar pagamento"}
        </button>
      </>
    );
  } else if (kind === "revert") {
    const paid = shift.amount ?? valueFor(shift);
    body = (
      <>
        <div>
          <div className="sa-section-label">Pagamento que será desfeito</div>
          <div className="sa-paid-card">
            <div className="sa-paid-main">
              <div className="sa-paid-amount">{paid !== null ? formatCurrencyBRL(paid) : "—"}</div>
              <div className="muted sa-small">Pago em {formatDateTime(shift.importedAt)}</div>
            </div>
            <div className="sa-flow">
              <span className={STATUS_BADGE.pago.className}>Pago</span>
              <ArrowRight size={14} />
              <span className={STATUS_BADGE.pendente.className}>Pendente</span>
            </div>
          </div>
        </div>
        <Notice tone="info" icon={Info}>
          O registro do pagamento não é apagado: ele continua no histórico. O turno volta para os pendentes e pode ser pago de novo.
        </Notice>
      </>
    );
    footer = (
      <>
        <span className="sa-spacer" />
        <button type="button" className="outline" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button type="button" onClick={onConfirmRevert} disabled={busy}>
          {busy ? "Revertendo..." : "Voltar para pendente"}
        </button>
      </>
    );
  } else if (kind === "history") {
    const events = history.rows ? historyEvents(history.rows, rules).reverse() : null;
    body = (
      <>
        {history.error && <div className="error-box">{history.error}</div>}
        {!events && !history.error && <p className="muted">Carregando...</p>}
        {events && (
          <div className="sa-timeline">
            {events.map((ev, i) => (
              <div key={ev.row.id} className={i === 0 ? "sa-tl-item sa-tl-now" : "sa-tl-item"}>
                <span className="sa-tl-dot" />
                <div className="sa-tl-content">
                  <div className="sa-tl-head">
                    <span className="sa-tl-title">{ev.title}</span>
                    {i === 0 && <span className="sa-tag">Atual</span>}
                    {ev.tag && <span className="sa-tag" title={ev.tag}>{ev.tag}</span>}
                  </div>
                  <div className="sa-tl-when">{formatDateTime(ev.row.importedAt)}</div>
                  {ev.row.status === "erro" && ev.row.errorMessage && <div className="sa-small" style={{ color: "var(--danger)" }}>{ev.row.errorMessage}</div>}
                  {ev.changes.length > 0 && (
                    <div className="sa-tl-changes">
                      {ev.changes.map((c) => (
                        <div key={c.label}>
                          <span className="muted">{c.label}</span> {c.from !== null && <><s>{c.from}</s> →</>} <strong>{c.to}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {events && events.length > 1 && <p className="muted sa-small">Cada etapa mostra só o que mudou em relação à anterior.</p>}
      </>
    );
  } else {
    const paidAlready = shift.status === "pago";
    const paid = shift.amount ?? valueFor(shift);
    const earlier = history.rows ? history.rows.length - 1 : null;
    body = (
      <>
        {paidAlready && (
          <Notice tone="danger" icon={AlertTriangle}>
            <strong>Este turno já foi pago</strong>
            {paid !== null ? ` (${formatCurrencyBRL(paid)} em ${formatDateTime(shift.importedAt)})` : ""}. O registro do pagamento também será removido.
          </Notice>
        )}
        <div>
          <div className="sa-section-label">O que acontece</div>
          <ul className="sa-list">
            <li>
              Remove o turno
              {earlier !== null && earlier > 0 ? ` e ${earlier} ${earlier === 1 ? "registro anterior" : "registros anteriores"} do histórico` : ""}
              {paidAlready ? ", incluindo o pagamento" : ""}.
            </li>
            <li>Ele some de todas as listas, relatórios e exportações.</li>
            <li>Se for reimportado, a pré-visualização avisa que ele foi removido e você decide se traz de volta.</li>
          </ul>
        </div>
        {paidAlready && (
          <label className="sa-ack">
            <input type="checkbox" checked={deleteAck} onChange={(e) => setDeleteAck(e.target.checked)} />
            <span>Entendo que o pagamento{paid !== null ? ` de ${formatCurrencyBRL(paid)}` : ""} também será removido.</span>
          </label>
        )}
      </>
    );
    footer = (
      <>
        <span className="sa-spacer" />
        <button type="button" className="outline" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button type="button" className="danger" onClick={onConfirmDelete} disabled={busy || (paidAlready && !deleteAck)}>
          {busy ? "Removendo..." : "Remover turno"}
        </button>
      </>
    );
  }

  return (
    <SidePanel
      open={target !== null}
      onClose={onClose}
      title={header.title}
      icon={header.icon}
      iconTone={header.danger ? "danger" : undefined}
      width={400}
      actions={
        <>
          <button type="button" className="side-panel-icon-button" aria-label="Turno anterior" title="Turno anterior" onClick={onPrev} disabled={!canPrev}>
            <ChevronUp size={16} />
          </button>
          <button type="button" className="side-panel-icon-button" aria-label="Próximo turno" title="Próximo turno" onClick={onNext} disabled={!canNext}>
            <ChevronDown size={16} />
          </button>
        </>
      }
      subheader={<ShiftStrip shift={shift} />}
      footer={footer}
    >
      {body}
      {error && <div className="error-box" style={{ margin: 0 }}>{error}</div>}
    </SidePanel>
  );
}
