import { useEffect, useState } from "react";
import { formatDate, formatMinutesAsTime } from "../lib/format";
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
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  shift: PaymentShiftRow;
  /** The company rules' computed estimate, or `null` when no rule matched — either way, still editable before confirming. */
  suggestedAmount: number | null;
  busy: boolean;
  error?: string | null;
  onConfirm: (amount: number) => void;
  onCancel: () => void;
}) {
  const [amountText, setAmountText] = useState(suggestedAmount !== null ? suggestedAmount.toFixed(2) : "");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const amount = Number(amountText);
  const amountValid = amountText.trim() !== "" && !Number.isNaN(amount) && amount >= 0;

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
        <div className="field">
          <label htmlFor="confirm-payment-amount">Valor</label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span className="muted">R$</span>
            <input
              id="confirm-payment-amount"
              type="number"
              min="0"
              step="0.01"
              autoFocus
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
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
            onClick={() => onConfirm(Math.round(amount * 100) / 100)}
            disabled={!amountValid || busy}
          >
            Confirmar pagamento
          </button>
        </div>
      </div>
    </div>
  );
}
