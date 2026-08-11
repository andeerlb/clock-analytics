import { useEffect, useState, type ReactNode } from "react";
import { getPaymentShiftHistory, type EffectivePaymentRules } from "../lib/db";
import {
  classifyShiftPeriod,
  formatCurrencyBRL,
  formatDate,
  formatDateTime,
  formatMinutesAsTime,
  parseTimeToMinutes,
  resolvePaymentValue,
  shiftDurationMinutes,
} from "../lib/format";
import type { PaymentShiftRow, PaymentShiftStatus } from "../lib/types";
import Drawer from "./Drawer";

const STATUS_LABEL: Record<PaymentShiftStatus, string> = {
  pendente: "Pendente",
  erro: "Erro",
  pago: "Pago",
};

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="drawer-detail-row" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", paddingTop: "0.3rem", paddingBottom: "0.3rem" }}>
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        {label}
      </span>
      <span style={{ textAlign: "right" }}>{children}</span>
    </div>
  );
}

function HistoryEntry({
  shift,
  rules,
  isLast,
}: {
  shift: PaymentShiftRow;
  rules: EffectivePaymentRules | null;
  isLast: boolean;
}) {
  const hasSchedule = shift.scheduleStartMinutes !== null && shift.scheduleEndMinutes !== null;
  const durationMinutes = hasSchedule
    ? shiftDurationMinutes(shift.scheduleStartMinutes!, shift.scheduleEndMinutes!)
    : null;
  const nightStart = rules ? parseTimeToMinutes(rules.nightStartTime) : null;
  const nightEnd = rules ? parseTimeToMinutes(rules.nightEndTime) : null;
  const period =
    rules && hasSchedule && nightStart !== null && nightEnd !== null
      ? classifyShiftPeriod(rules.nightShiftRule, nightStart, nightEnd, shift.scheduleStartMinutes!, shift.scheduleEndMinutes!)
      : null;
  const value =
    shift.amount ??
    (rules && durationMinutes !== null
      ? resolvePaymentValue(rules.valueRules, durationMinutes, {
          workDate: shift.workDate,
          local: shift.local,
          role: shift.role,
          scheduleStartMinutes: shift.scheduleStartMinutes,
          scheduleEndMinutes: shift.scheduleEndMinutes,
        })
      : null);
  return (
    <div
      style={{
        paddingBottom: "0.8rem",
        marginBottom: "0.8rem",
        borderBottom: isLast ? undefined : "1px solid var(--border)",
      }}
    >
      <DetailRow label="Status">{STATUS_LABEL[shift.status]}</DetailRow>
      <DetailRow label="Importado em">{formatDateTime(shift.importedAt)}</DetailRow>
      {shift.status === "erro" && shift.errorMessage && <DetailRow label="Erro">{shift.errorMessage}</DetailRow>}
      <DetailRow label="Data">{formatDate(shift.workDate)}</DetailRow>
      <DetailRow label="Local / Função">
        {shift.local} · {shift.role}
      </DetailRow>
      <DetailRow label="Horário">
        {hasSchedule ? `${formatMinutesAsTime(shift.scheduleStartMinutes!)} – ${formatMinutesAsTime(shift.scheduleEndMinutes!)}` : "—"}
      </DetailRow>
      {period && <DetailRow label="Turno">{period === "noturno" ? "Noturno" : "Diurno"}</DetailRow>}
      <DetailRow label="Horas trabalhadas">
        {durationMinutes !== null ? formatMinutesAsTime(durationMinutes) : "—"}
      </DetailRow>
      <DetailRow label="Valor">{value !== null ? formatCurrencyBRL(value) : "—"}</DetailRow>
    </div>
  );
}

/**
 * Read-only look at a shift's full status history — every row the append-
 * only chain (`previous_shift_id`) passed through before reaching the
 * current head, oldest first. Reached via the row's context menu's "Ver
 * histórico", always offered regardless of whether there's actually
 * anything to show — `shiftId === null` means this turno IS the first
 * state (no `previousShiftId`), so nothing is fetched and the panel just
 * says so instead of coming up empty with no explanation.
 */
export default function ShiftHistoryDrawer({
  open,
  shiftId,
  rules,
  onClose,
}: {
  open: boolean;
  /** The turno's `previousShiftId` — `null` means it genuinely has no earlier history, not "not loaded yet". */
  shiftId: number | null;
  rules: EffectivePaymentRules | null;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<PaymentShiftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || shiftId === null) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPaymentShiftHistory(shiftId)
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, shiftId]);

  return (
    <Drawer open={open} onClose={onClose} title="Histórico do turno">
      {loading && <p className="muted">Carregando...</p>}
      {error && <div className="error-box">{error}</div>}
      {!loading && !error && shiftId === null && (
        <p className="muted">Este turno não tem histórico — nenhuma alteração de status foi registrada para ele ainda.</p>
      )}
      {!loading &&
        !error &&
        shiftId !== null &&
        history.map((shift, i) => <HistoryEntry key={shift.id} shift={shift} rules={rules} isLast={i === history.length - 1} />)}
    </Drawer>
  );
}
