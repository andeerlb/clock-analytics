import { useEffect, useState } from "react";
import { formatMinutesAsTime, parseTimeToMinutes } from "../lib/format";
import type { PaymentShiftRow } from "../lib/types";

export interface EditShiftFields {
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  amount: number | null;
}

/**
 * "Editar turno" confirm dialog — same fixed-overlay recipe as
 * `ConfirmPaymentModal`, but for manually overriding a `pendente`/`erro`
 * shift's own data (Data/Local/Função/Horário/Valor) instead of marking it
 * paid. Confirming always creates a brand-new `payment_shifts` row (see
 * `editPaymentShift`); this modal never touches `shift` itself, and the
 * shift keeps its current status.
 *
 * Valor left blank submits `amount: null` ("keep computing it live from the
 * company's rules"), not zero — clearing a manual override back to
 * automatic is a deliberate choice, distinct from fixing Local/Função/Data/
 * Horário without ever having touched Valor at all.
 */
export default function EditShiftModal({
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
  onConfirm: (fields: EditShiftFields) => void;
  onCancel: () => void;
}) {
  const [workDate, setWorkDate] = useState(shift.workDate);
  const [local, setLocal] = useState(shift.local);
  const [role, setRole] = useState(shift.role);
  const [startTime, setStartTime] = useState(
    shift.scheduleStartMinutes !== null ? formatMinutesAsTime(shift.scheduleStartMinutes) : "",
  );
  const [endTime, setEndTime] = useState(
    shift.scheduleEndMinutes !== null ? formatMinutesAsTime(shift.scheduleEndMinutes) : "",
  );
  const [amountText, setAmountText] = useState(currentValue !== null ? currentValue.toFixed(2) : "");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const scheduleValid =
    (startTime === "" && endTime === "") || (parseTimeToMinutes(startTime) !== null && parseTimeToMinutes(endTime) !== null);
  const amountNumber = amountText.trim() === "" ? null : Number(amountText);
  const amountValid = amountNumber === null || (!Number.isNaN(amountNumber) && amountNumber >= 0);
  const valid = workDate.trim() !== "" && local.trim() !== "" && role.trim() !== "" && scheduleValid && amountValid;

  function handleConfirm() {
    onConfirm({
      workDate,
      local: local.trim(),
      role: role.trim(),
      scheduleStartMinutes: startTime ? parseTimeToMinutes(startTime) : null,
      scheduleEndMinutes: endTime ? parseTimeToMinutes(endTime) : null,
      amount: amountNumber !== null ? Math.round(amountNumber * 100) / 100 : null,
    });
  }

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
      <div className="card" style={{ maxWidth: "28rem", margin: "1rem" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Editar turno</h3>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Isso cria um novo registro com o status atual ("{shift.status === "erro" ? "Erro" : "Pendente"}") e os
          dados informados. O registro atual não será alterado, ficando disponível como histórico.
        </p>
        <div className="field-row">
          <div className="field" style={{ flex: "0 1 10rem" }}>
            <label htmlFor="edit-shift-date">Data</label>
            <input id="edit-shift-date" type="date" autoFocus value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "1 1 12rem" }}>
            <label htmlFor="edit-shift-local">Local</label>
            <input id="edit-shift-local" type="text" value={local} onChange={(e) => setLocal(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="edit-shift-role">Função</label>
          <input id="edit-shift-role" type="text" value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
        <div className="field-row">
          <div className="field" style={{ flex: "0 1 10rem" }}>
            <label htmlFor="edit-shift-start">Início</label>
            <input id="edit-shift-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "0 1 10rem" }}>
            <label htmlFor="edit-shift-end">Fim</label>
            <input id="edit-shift-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="edit-shift-amount">Valor</label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span className="muted">R$</span>
            <input
              id="edit-shift-amount"
              type="number"
              min="0"
              step="0.01"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder="Calculado automaticamente"
            />
          </div>
          <p className="field-hint" style={{ marginTop: "0.3rem" }}>
            Deixe em branco para continuar calculando pelas regras da empresa.
          </p>
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
          <button type="button" onClick={handleConfirm} disabled={!valid || busy}>
            Salvar turno
          </button>
        </div>
      </div>
    </div>
  );
}
