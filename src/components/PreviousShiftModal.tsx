import { AlertCircle, CheckCircle2, Clock3 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getPaymentShift, type CompanyDetail } from "../lib/db";
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

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  pendente: { className: "badge warn", label: "Pendente", icon: Clock3 },
  erro: { className: "badge file-error", label: "Erro", icon: AlertCircle },
  pago: { className: "badge ok", label: "Pago", icon: CheckCircle2 },
};

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "1rem",
        padding: "0.4rem 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        {label}
      </span>
      <span style={{ textAlign: "right" }}>{children}</span>
    </div>
  );
}

/**
 * Read-only look at a superseded shift row — reached only via the "ver
 * status anterior" link on the `pago` row that replaced it, since
 * `listPaymentShiftsForEmployeeMonth` never returns non-head rows on its
 * own. Fetches by id itself, same self-contained recipe as `PdfViewerModal`.
 */
export default function PreviousShiftModal({
  shiftId,
  company,
  onClose,
}: {
  /** `null` keeps the modal unmounted/closed. */
  shiftId: number | null;
  company: CompanyDetail | null;
  onClose: () => void;
}) {
  const [shift, setShift] = useState<PaymentShiftRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shiftId === null) {
      setShift(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPaymentShift(shiftId)
      .then((row) => {
        if (!cancelled) setShift(row);
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
  }, [shiftId]);

  useEffect(() => {
    if (shiftId === null) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shiftId, onClose]);

  if (shiftId === null) return null;

  const hasSchedule = shift?.scheduleStartMinutes != null && shift?.scheduleEndMinutes != null;
  const durationMinutes = shift && hasSchedule
    ? shiftDurationMinutes(shift.scheduleStartMinutes!, shift.scheduleEndMinutes!)
    : null;
  const nightStart = company ? parseTimeToMinutes(company.nightStartTime) : null;
  const nightEnd = company ? parseTimeToMinutes(company.nightEndTime) : null;
  const period =
    shift && company && hasSchedule && nightStart !== null && nightEnd !== null
      ? classifyShiftPeriod(company.nightShiftRule, nightStart, nightEnd, shift.scheduleStartMinutes!, shift.scheduleEndMinutes!)
      : null;
  const value =
    shift?.amount ?? (company && durationMinutes !== null ? resolvePaymentValue(company.valueRules, durationMinutes) : null);
  const badge = shift ? STATUS_BADGE[shift.status] : null;
  const BadgeIcon = badge?.icon;

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
      onClick={onClose}
    >
      <div className="card" style={{ maxWidth: "26rem", margin: "1rem" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Registro anterior</h3>
        {loading && <p className="muted">Carregando...</p>}
        {error && <div className="error-box">{error}</div>}
        {shift && badge && BadgeIcon && (
          <div>
            <DetailRow label="Status">
              <span className={badge.className}>
                <BadgeIcon size={13} />
                {badge.label}
              </span>
            </DetailRow>
            {shift.status === "erro" && shift.errorMessage && <DetailRow label="Erro">{shift.errorMessage}</DetailRow>}
            <DetailRow label="Data">{formatDate(shift.workDate)}</DetailRow>
            <DetailRow label="Local / Função">
              {shift.local} · {shift.role}
            </DetailRow>
            <DetailRow label="Horário">
              {hasSchedule ? (
                <>
                  {formatMinutesAsTime(shift.scheduleStartMinutes!)} – {formatMinutesAsTime(shift.scheduleEndMinutes!)}
                  {period && (
                    <span className={period === "noturno" ? "badge info" : "badge neutral"} style={{ marginLeft: "0.5rem" }}>
                      {period === "noturno" ? "Noturno" : "Diurno"}
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Horas trabalhadas">
              {durationMinutes !== null ? formatMinutesAsTime(durationMinutes) : "—"}
            </DetailRow>
            <DetailRow label="Valor">{value !== null ? formatCurrencyBRL(value) : "—"}</DetailRow>
            <DetailRow label="Importado em">{formatDateTime(shift.importedAt)}</DetailRow>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.2rem" }}>
          <button type="button" className="outline" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
