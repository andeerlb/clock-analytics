import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import type { ShiftFieldDiffRow } from "../lib/db";
import {
  centsMaskToAmount,
  diffFieldLabel,
  formatCentsMask,
  formatDate,
  formatDateTimeAbbrevYY,
  formatMinutesAsTime,
} from "../lib/format";
import type { PaymentShiftRow } from "../lib/types";

/**
 * "Fazer pagamento" confirm dialog — same fixed-overlay recipe as
 * `ConfirmModal`, but with an editable Valor field pre-filled from the
 * company's rules. Confirming always creates a brand-new `payment_shifts`
 * row (see `markPaymentShiftPaid`); this modal never touches `shift` itself.
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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const amountValid = digits !== "";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <div className="card" style={{ maxWidth: "26rem", margin: "1rem" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Fazer pagamento</h3>
        <p className="muted">
          {formatDate(shift.workDate)} · {shift.local} · {shift.role}
          {shift.scheduleStartMinutes !== null && shift.scheduleEndMinutes !== null && (
            <>
              {" · "}
              {formatMinutesAsTime(shift.scheduleStartMinutes)} – {formatMinutesAsTime(shift.scheduleEndMinutes)}
            </>
          )}
        </p>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Isso cria um novo registro com status "Pago". O registro atual não será alterado, ficando disponível como
          histórico.
        </p>
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
        <div className="field">
          <label htmlFor="confirm-payment-amount">Valor</label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span className="muted">R$</span>
            <input
              id="confirm-payment-amount"
              type="text"
              inputMode="numeric"
              autoFocus
              value={digits === "" ? "" : formatCentsMask(digits)}
              onChange={(e) => setDigits(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </div>
        {error && (
          <div className="error-box" style={{ marginTop: "0.8rem" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.2rem" }}>
          <button type="button" className="outline" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onConfirm(centsMaskToAmount(digits))}
            disabled={!amountValid || busy}
          >
            Confirmar pagamento
          </button>
        </div>
      </div>
    </div>
  );
}
