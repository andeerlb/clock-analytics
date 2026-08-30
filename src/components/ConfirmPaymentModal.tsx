import { AlertTriangle, Check, Copy, Info, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { listEmployeePixKeys, type EmployeePixKeyRow, type ShiftFieldDiffRow } from "../lib/db";
import {
  centsMaskToAmount,
  diffFieldLabel,
  formatDate,
  formatDateTimeAbbrevYY,
  formatMinutesAsTime,
  shiftDurationMinutes,
} from "../lib/format";
import type { PaymentShiftRow } from "../lib/types";
import { PIX_KEY_TYPE_LABELS } from "../lib/pix";
import Avatar from "./Avatar";
import CurrencyInput from "./CurrencyInput";
import Modal, { useModalClose } from "./Modal";

/** Cancelar button — routed through `useModalClose` so it plays the same exit animation as the header's X/Escape/backdrop instead of unmounting instantly; `requestClose` still resolves to the same `onCancel` passed to `<Modal onClose={onCancel}>` below. */
function CancelButton({ busy }: { busy: boolean }) {
  const requestClose = useModalClose();
  return (
    <button type="button" className="outline" onClick={requestClose} disabled={busy}>
      Cancelar
    </button>
  );
}

/** A DATA/LOCAL/FUNÇÃO/TOTAL DE HORAS grid cell's small caps label — matches the uppercase letter-spacing style used elsewhere for this same "tiny label above a value" pattern (e.g. the pending-changes card's "CLIQUE PARA REVISAR"). */
function SummaryLabel({ children }: { children: string }) {
  return (
    <div className="muted" style={{ fontSize: "0.66rem", fontWeight: 700, letterSpacing: "0.05em", marginBottom: "0.15rem" }}>
      {children}
    </div>
  );
}

/**
 * "Fazer pagamento" confirm dialog, through the shared `Modal` overlay —
 * with an editable Valor field pre-filled from the company's rules.
 * Confirming always creates a brand-new `payment_shifts` row (see
 * `markPaymentShiftPaid`); this modal never touches `shift` itself.
 */
export default function ConfirmPaymentModal({
  shift,
  suggestedAmount,
  changes,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  shift: PaymentShiftRow;
  /** The company rules' computed estimate, or `null` when no rule matched — either way, still editable before confirming. */
  suggestedAmount: number | null;
  /** What the last automatic verification found different for this shift, if anything (see `listLatestFieldDiffsForShifts`) — purely informational, shown so the change isn't missed right before paying; confirming never re-checks the source itself. */
  changes: ShiftFieldDiffRow[];
  busy: boolean;
  error?: string | null;
  onConfirm: (amount: number) => void;
  onCancel: () => void;
}) {
  const [digits, setDigits] = useState(suggestedAmount !== null ? String(Math.round(suggestedAmount * 100)) : "");
  const [pixKeys, setPixKeys] = useState<EmployeePixKeyRow[]>([]);
  const [loadingPixKeys, setLoadingPixKeys] = useState(true);
  const [pixError, setPixError] = useState<string | null>(null);
  const [copiedPixId, setCopiedPixId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingPixKeys(true);
    setPixError(null);
    listEmployeePixKeys(shift.employeeId)
      .then((keys) => {
        if (!cancelled) setPixKeys(keys);
      })
      .catch((err) => {
        if (!cancelled) setPixError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!cancelled) setLoadingPixKeys(false);
      });
    return () => { cancelled = true; };
  }, [shift.employeeId]);

  async function copyPixKey(key: EmployeePixKeyRow) {
    try {
      await navigator.clipboard.writeText(key.keyValue);
      setCopiedPixId(key.id);
      window.setTimeout(() => setCopiedPixId((current) => current === key.id ? null : current), 1800);
    } catch {
      setPixError("Não foi possível copiar a chave PIX. Selecione o texto e copie manualmente.");
    }
  }

  const amountValid = digits !== "";
  const hasSchedule = shift.scheduleStartMinutes !== null && shift.scheduleEndMinutes !== null;
  const duration = hasSchedule ? shiftDurationMinutes(shift.scheduleStartMinutes!, shift.scheduleEndMinutes!) : null;

  return (
    <Modal
      onClose={onCancel}
      title="Fazer pagamento"
      footer={
        <>
          <CancelButton busy={busy} />
          <button type="button" onClick={() => onConfirm(centsMaskToAmount(digits))} disabled={!amountValid || busy}>
            Confirmar pagamento
          </button>
        </>
      }
    >
      <div style={{ background: "var(--surface-variant)", border: "1px solid var(--border)", borderRadius: 8, padding: "0.9rem 1rem", marginBottom: "1rem" }}>
        <div className="person-cell" style={{ fontWeight: 600, marginBottom: "0.9rem" }}>
          <Avatar name={shift.employeeName} />
          {shift.employeeName}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: "0.8rem", columnGap: "1rem" }}>
          <div>
            <SummaryLabel>DATA</SummaryLabel>
            <div>{formatDate(shift.workDate)}</div>
          </div>
          <div>
            <SummaryLabel>LOCAL</SummaryLabel>
            <div>{shift.local}</div>
          </div>
          <div>
            <SummaryLabel>FUNÇÃO</SummaryLabel>
            <div>{shift.role}</div>
          </div>
          <div>
            <SummaryLabel>TOTAL DE HORAS</SummaryLabel>
            <div>
              {duration !== null ? formatMinutesAsTime(duration) : "—"}
              {hasSchedule && (
                <span className="muted" style={{ fontSize: "0.82rem" }}>
                  {" "}
                  ({formatMinutesAsTime(shift.scheduleStartMinutes!)} - {formatMinutesAsTime(shift.scheduleEndMinutes!)})
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.45rem" }}>
          <KeyRound size={14} />
          Chaves PIX
        </div>
        {loadingPixKeys ? (
          <div className="muted" style={{ fontSize: "0.82rem" }}>Carregando chaves…</div>
        ) : pixError ? (
          <div className="error-box" style={{ margin: 0 }}>{pixError}</div>
        ) : pixKeys.length === 0 ? (
          <div className="info-box" style={{ margin: 0 }}>
            <Info size={14} style={{ flexShrink: 0 }} />
            <span>Nenhuma chave PIX cadastrada para este colaborador.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {pixKeys.map((key) => {
              const copied = copiedPixId === key.id;
              return (
                <button
                  key={key.id}
                  type="button"
                  className={`pix-copy-row${copied ? " copied" : ""}`}
                  onClick={() => copyPixKey(key)}
                  title={copied ? "Chave copiada" : `Clique para copiar: ${key.keyValue}`}
                  aria-label={`Copiar chave PIX ${key.keyValue}`}
                  style={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "6.5rem minmax(0, 1fr) auto",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.78rem 0.85rem",
                    textAlign: "left",
                  }}
                >
                  <span className="muted" style={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{PIX_KEY_TYPE_LABELS[key.keyType]}</span>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere", userSelect: "text", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.96rem", fontWeight: 650, letterSpacing: "0.025em" }}>{key.keyValue}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: copied ? "var(--success)" : "var(--text-muted)", fontSize: "0.74rem" }}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied && "Copiada"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {changes.length > 0 && (
        <div className="warning-box">
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.85rem" }}>
            <AlertTriangle size={14} />
            Mudança encontrada na fonte desde a importação
          </div>
          <div style={{ marginTop: "0.4rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {changes.map((c, i) => (
              <div key={i} style={{ fontSize: "0.8rem" }}>
                {diffFieldLabel(c.fieldName, c.columnLetter)}: <s>{c.oldValue ?? "—"}</s> → <strong>{c.newValue ?? "—"}</strong>
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
            Verificado em {formatDateTimeAbbrevYY(changes[0].checkedAt)}
          </div>
        </div>
      )}
      <div className="field" style={{ marginBottom: "1rem" }}>
        <label htmlFor="confirm-payment-amount">Valor</label>
        <CurrencyInput id="confirm-payment-amount" size="md" digits={digits} onChange={setDigits} autoFocus />
      </div>
      <div className="info-box">
        <Info size={14} style={{ flexShrink: 0, marginTop: "0.15rem" }} />
        <span>Isso criará um novo registro com status "Pago". O registro original será arquivado no histórico.</span>
      </div>
      {error && (
        <div className="error-box" style={{ marginTop: "0.8rem", marginBottom: 0 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}
