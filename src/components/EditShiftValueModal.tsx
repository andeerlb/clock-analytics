import { useEffect, useState } from "react";
import { formatDate, formatMinutesAsTime } from "../lib/format";
import type { PaymentShiftRow } from "../lib/types";

/**
 * "Editar valor" confirm dialog — same fixed-overlay recipe as
 * `ConfirmPaymentModal`, but for manually overriding a `pendente`/`erro`
 * shift's Valor instead of marking it paid. Confirming always creates a
 * brand-new `payment_shifts` row (see `editPaymentShiftValue`); this modal
 * never touches `shift` itself, and the shift keeps its current status.
 */
export default function EditShiftValueModal({
  shift,
  currentValue,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  shift: PaymentShiftRow;
  /** The value currently shown for this shift (stored `amount` or the live estimate) — either way, still editable before confirming. */
  currentValue: number | null;
  busy: boolean;
  error?: string | null;
  onConfirm: (amount: number) => void;
  onCancel: () => void;
}) {
  const [amountText, setAmountText] = useState(currentValue !== null ? currentValue.toFixed(2) : "");

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
        <h3 style={{ marginTop: 0 }}>Editar valor</h3>
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
          Isso cria um novo registro com o status atual ("{shift.status === "erro" ? "Erro" : "Pendente"}") e o valor
          informado. O registro atual não será alterado, ficando disponível como histórico.
        </p>
        <div className="field">
          <label htmlFor="edit-value-amount">Valor</label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span className="muted">R$</span>
            <input
              id="edit-value-amount"
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
            Salvar valor
          </button>
        </div>
      </div>
    </div>
  );
}
