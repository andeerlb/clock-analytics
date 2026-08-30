import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Eye,
  FileDown,
  FileSpreadsheet,
  Filter,
  FolderOpen,
  Info,
  Moon,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AnchoredPopover from "../components/AnchoredPopover";
import Avatar from "../components/Avatar";
import ConfirmModal from "../components/ConfirmModal";
import ConfirmPaymentModal from "../components/ConfirmPaymentModal";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import CurrencyInput from "../components/CurrencyInput";
import DatePicker from "../components/DatePicker";
import Drawer from "../components/Drawer";
import ExtraColumnsDrawer from "../components/ExtraColumnsDrawer";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import PaymentsFiltersDrawer, { SHIFT_PERIOD_OPTIONS, STATUS_OPTIONS, type PaymentsFiltersValue } from "../components/PaymentsFiltersDrawer";
import PdfViewerModal from "../components/PdfViewerModal";
import PillButton from "../components/PillButton";
import ShiftHistoryDrawer from "../components/ShiftHistoryDrawer";
import TimeField from "../components/TimeField";
import { PAYMENTS_PAGE_SIZE_OPTIONS, usePaymentsFilters } from "../contexts/FiltersContext";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { openReconciliationWindow, revealInFileManager } from "../lib/api";
import {
  deletePaymentShift,
  editPaymentShift,
  getEffectivePaymentRules,
  getPaymentVisibleColumns,
  listClients,
  listCompanies,
  listDistinctPaymentShiftLocals,
  listLatestFieldDiffsForShifts,
  listPaymentExportTemplates,
  listPaymentShiftSummaries,
  listPaymentShiftsFlat,
  listPaymentShiftsForGroup,
  listRolesGlobal,
  markPaymentShiftPaid,
  PAYMENT_SHIFTS_CHANGED_EVENT,
  revertPaymentShiftToPending,
  setPaymentVisibleColumns,
  type ClientRow,
  type CompanyRow,
  type EffectivePaymentRules,
  type ListPaymentShiftSummariesQuery,
  type PaymentShiftFlatRow,
  type PaymentShiftGroupRow,
  type RoleRow,
  type ShiftFieldDiffRow,
} from "../lib/db";
import {
  centsMaskToAmount,
  diffFieldLabel,
  formatCurrencyBRL,
  formatDate,
  formatDateAbbrevYY,
  formatDateTimeAbbrevYY,
  formatMinutesAsTime,
  parseTimeToMinutes,
  resolvePaymentValue,
  shiftDurationMinutes,
} from "../lib/format";
import { generatePaymentsExportXlsx, type PaymentExportResult } from "../lib/paymentExport";
import { ALL_COLUMN_IDS, FLAT_COLUMNS } from "../lib/paymentColumns";
import { generatePaymentsReportPdf, type PaymentsReportResult } from "../lib/paymentsReport";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import type {
  PaymentExportTemplateListRow,
  PaymentShiftRow,
  PaymentShiftStatus,
  PaymentShiftSummaryRow,
  ShiftPeriod,
} from "../lib/types";

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string }> = {
  pendente: { className: "badge warn", label: "Pendente" },
  erro: { className: "badge file-error", label: "Erro" },
  pago: { className: "badge ok", label: "Pago" },
};

/** What a fresh install (no saved column preference yet) shows — everything except "Importado em", which is metadata most people don't need visible by default. */
const DEFAULT_VISIBLE_COLUMN_IDS = ALL_COLUMN_IDS.filter((id) => id !== "importado");
const IDENTITY_COLUMN_IDS = new Set(["colaborador", "cliente", "empresa"]);
const TURNO_COLUMNS = FLAT_COLUMNS.filter((c) => !IDENTITY_COLUMN_IDS.has(c.id));

/**
 * The "Gerar PDF"/"Exportar Excel" empty-result message — `matchedCount`
 * (turnos matching the filters, before the report's own "has a value" cut)
 * vs. an always-zero `rowCount` at this point is what tells apart "no
 * turno matches these filters at all" from "turnos matched, but none has a
 * payment value yet to report" — collapsing both into one generic "Nenhum
 * turno" message reads as a bug when turnos are plainly visible in the
 * table (see `generatePaymentsReportPdf`/`generatePaymentsExportXlsx`).
 */
function noReportRowsMessage(matchedCount: number): string {
  return matchedCount === 0
    ? "Nenhum turno para os filtros selecionados."
    : "Os turnos encontrados ainda não têm um valor de pagamento definido, então não há nada para incluir no relatório. Configure uma regra de valor para o cliente/empresa ou informe o valor manualmente em cada turno.";
}

/** "2026-02" -> "fev/2026" */
function formatCompetencia(competencia: string): string {
  const date = new Date(`${competencia}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function groupKey(employeeId: number, competencia: string): string {
  return `${employeeId}:${competencia}`;
}

/** Where a row action came from — `null` for a flat (desagrupado) row, or the group it's nested under so a mutation can refresh exactly that group plus the summary counts. */
type GroupRef = { employeeId: number; competencia: string } | null;

/** A patch to one or more of a shift's own editable fields — whichever keys are present overwrite that field, everything else carries over from the shift's current value (see `commitField` in `PaymentsPage`). */
type ShiftFieldPatch = Partial<{
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  amount: number | null;
}>;

/**
 * A cell that's plain text until clicked (only when `editable`), then swaps
 * to a text input — commits on blur or Enter, discards on Escape. Used for
 * every single-value editable text column (Local/Função). Data, Horário,
 * and Valor each have their own variant (`EditableDateCell`,
 * `EditableSchedule`, `EditableCurrencyCell`) since none of them are a
 * plain string a native text input handles well.
 */
function EditableCell({
  editable,
  value,
  display,
  onCommit,
}: {
  editable: boolean;
  value: string;
  display: ReactNode;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editable) return <>{display}</>;

  if (!editing) {
    return (
      <span
        className="editable-value"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {display}
      </span>
    );
  }

  function commit() {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  }

  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      style={{ width: "100%" }}
    />
  );
}

/** Data's own editable cell — opens the custom `DatePicker` popover instead of a native `<input type="date">`, which renders with the OS/browser's own (often English, always visually inconsistent) date control. */
function EditableDateCell({
  editable,
  value,
  display,
  onCommit,
}: {
  editable: boolean;
  /** "YYYY-MM-DD" */
  value: string;
  display: ReactNode;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);

  if (!editable) return <>{display}</>;

  if (!editing) {
    return (
      <span ref={triggerRef} className="editable-value" onClick={() => setEditing(true)}>
        {display}
      </span>
    );
  }

  return (
    <span ref={triggerRef} className="editable-value" onClick={(e) => e.stopPropagation()}>
      {display}
      <DatePicker
        value={value}
        anchorRef={triggerRef}
        onSelect={(iso) => {
          setEditing(false);
          if (iso !== value) onCommit(iso);
        }}
        onClose={() => setEditing(false)}
      />
    </span>
  );
}

/**
 * Valor's own editable cell — a live "1.234,56" mask as digits are typed
 * (cents-first, like a checkout amount field) instead of a native
 * `<input type="number">`, which shows a spinner that makes no sense for a
 * currency value and doesn't format the number at all while typing. Only
 * commits if the digits actually changed from what the field opened with
 * (`touched`) — comparing the *parsed amount* instead would wrongly freeze
 * a still-automatic value into a manual override just from opening and
 * closing the field without editing it, since the field opens pre-filled
 * with the live estimate, not literally `null`.
 */
function EditableCurrencyCell({
  editable,
  value,
  display,
  onCommit,
}: {
  editable: boolean;
  /** The live estimate or stored amount currently shown — just the initial seed for the mask, not what change-detection compares against. */
  value: number | null;
  display: ReactNode;
  onCommit: (amount: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [digits, setDigits] = useState("");
  const [touched, setTouched] = useState(false);

  if (!editable) return <>{display}</>;

  if (!editing) {
    return (
      <span
        className="editable-value"
        onClick={() => {
          setDigits(value !== null ? String(Math.round(value * 100)) : "");
          setTouched(false);
          setEditing(true);
        }}
      >
        {display}
      </span>
    );
  }

  function commit() {
    setEditing(false);
    if (!touched) return;
    onCommit(digits === "" ? null : centsMaskToAmount(digits));
  }

  return (
    <CurrencyInput
      size="sm"
      autoFocus
      digits={digits}
      placeholder="Automático"
      onChange={(d) => {
        setDigits(d);
        setTouched(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

const SCHEDULE_POPOVER_WIDTH = 230;

/**
 * Horário's own editable cell — one trigger opening one popover with
 * Início and Fim together (`TimeField`, always 24h), the same "connected"
 * idea as `DateRangePicker`'s single popover with two linked months, instead
 * of two separate native `<input type="time">` fields each rendering the
 * OS's own (often 12h AM/PM) time control.
 */
function EditableSchedule({
  editable,
  startTime,
  endTime,
  display,
  onCommit,
}: {
  editable: boolean;
  /** "HH:MM", or "" when there's no schedule. */
  startTime: string;
  endTime: string;
  display: ReactNode;
  onCommit: (startTime: string, endTime: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftStart, setDraftStart] = useState(startTime || "00:00");
  const [draftEnd, setDraftEnd] = useState(endTime || "00:00");
  const triggerRef = useRef<HTMLSpanElement>(null);

  if (!editable) return <>{display}</>;

  if (!editing) {
    return (
      <span
        ref={triggerRef}
        className="editable-value"
        onClick={() => {
          setDraftStart(startTime || "00:00");
          setDraftEnd(endTime || "00:00");
          setEditing(true);
        }}
      >
        {display}
      </span>
    );
  }

  function commit() {
    setEditing(false);
    if (draftStart !== startTime || draftEnd !== endTime) onCommit(draftStart, draftEnd);
  }

  return (
    <span ref={triggerRef} className="editable-value" onClick={(e) => e.stopPropagation()}>
      {display}
      <AnchoredPopover anchorRef={triggerRef} width={SCHEDULE_POPOVER_WIDTH} onClose={() => setEditing(false)}>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <div>
            <div className="muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
              Início
            </div>
            <TimeField ariaLabel="Início" value={draftStart} onChange={setDraftStart} />
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
              Fim
            </div>
            <TimeField ariaLabel="Fim" value={draftEnd} onChange={setDraftEnd} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.8rem" }}>
          <button type="button" className="outline" style={{ flex: 1, minWidth: 0, padding: "0.5em 0" }} onClick={() => setEditing(false)}>
            Cancelar
          </button>
          <button type="button" style={{ flex: 1, minWidth: 0, padding: "0.5em 0", boxShadow: "none" }} onClick={commit}>
            Confirmar
          </button>
        </div>
      </AnchoredPopover>
    </span>
  );
}

/**
 * The "extras" badge/modal shows a turno's unmapped columns AND its import
 * provenance (arquivo/aba/linha de origem) together, same as before these
 * were split into real columns (`sourceFileName`/`sourceSheetName`/
 * `sourceRowNumber`) for `findPaymentShiftByPosition` to index — this just
 * puts them back together for display. `null` when there's nothing at all
 * to show (a manually-created shift with no import origin and no unmapped
 * columns).
 */
function displayExtraData(s: PaymentShiftRow): Record<string, string> | null {
  const merged: Record<string, string> = { ...s.extraData };
  if (s.sourceFileName) merged["arquivo de origem"] = s.sourceFileName;
  if (s.sourceSheetName) merged["aba de origem"] = s.sourceSheetName;
  if (s.sourceRowNumber !== null) merged["linha de origem"] = String(s.sourceRowNumber);
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * One turno's visible-column cells — shared between the flat table (which
 * prepends Colaborador/Cliente/Empresa via `identity`) and a grouped row's
 * expanded turno table (no `identity`, since that's already the group's own
 * header). `visibleColumns` is an app-wide setting (see `PaymentsPage`), not
 * per-row state, but lives here since this is the only place it changes what
 * actually renders. Data/Local/Função/Horário/Valor are always inline-editable
 * for a `pendente`/`erro` shift — there's no separate "modo edição" toggle to
 * gate it. Row actions (pagar/reverter/excluir/histórico/revisar) aren't a
 * visible column at all — right-clicking the row opens them as a
 * `ContextMenu` instead (see `rowActions` below).
 */
function ShiftRow({
  shift: s,
  companyId,
  groupRef,
  identity,
  rules,
  visibleColumns,
  changes,
  onCommitField,
  onPay,
  onRevert,
  onDelete,
  onViewHistory,
  onViewExtra,
  onReview,
  onRowContextMenu,
  activeShiftId,
  onRowMouseDown,
}: {
  shift: PaymentShiftRow & { shiftPeriod: ShiftPeriod | null };
  companyId: number;
  groupRef: GroupRef;
  identity?: { employeeName: string; companyName: string; clientName: string };
  rules: EffectivePaymentRules | null;
  visibleColumns: Set<string>;
  /** What the last automatic verification found different for this shift (if anything) — see `listLatestFieldDiffsForShifts`. */
  changes: ShiftFieldDiffRow[];
  onCommitField: (shift: PaymentShiftRow, groupRef: GroupRef, patch: ShiftFieldPatch) => void;
  onPay: (shift: PaymentShiftRow, companyId: number, groupRef: GroupRef) => void;
  onRevert: (shift: PaymentShiftRow, groupRef: GroupRef) => void;
  onDelete: (shift: PaymentShiftRow, groupRef: GroupRef) => void;
  /** `shiftId` is the row's own `previousShiftId` — `null` when it genuinely has no earlier history, still opens the Drawer, just shows that instead of a list. */
  onViewHistory: (shiftId: number | null, companyId: number, clientId: number) => void;
  onViewExtra: (data: Record<string, string>, sourceUrl: string | null) => void;
  /** Opens the review Drawer — the only other thing (besides "Ver histórico") a blocked row's right-click menu offers, and an optional "ver o que mudou" for an already-auto-applied one. */
  onReview: (shift: PaymentShiftRow, groupRef: GroupRef) => void;
  /** Right-clicking anywhere on the row opens this row's actions (same set the old Ações column used to render as buttons) as a context menu instead — see `ContextMenu`. Also marks this row "active" (see `activeShiftId`), same as picking any of the items themselves. */
  onRowContextMenu: (e: MouseEvent, items: ContextMenuItem[], shiftId: number) => void;
  /** The shift id last right-clicked (or whose action is still open in a Drawer/modal) — kept highlighted so closing that Drawer/modal doesn't leave you wondering which row it was for. `null` once cleared. */
  activeShiftId: number | null;
  /** A left-click landing on a *different* row than `activeShiftId` clears the highlight — same row is a no-op, so editing a field on the already-active row doesn't flicker it off. */
  onRowMouseDown: (shiftId: number) => void;
}) {
  const badge = STATUS_BADGE[s.status];
  const hasSchedule = s.scheduleStartMinutes !== null && s.scheduleEndMinutes !== null;
  const duration = hasSchedule ? shiftDurationMinutes(s.scheduleStartMinutes!, s.scheduleEndMinutes!) : null;
  const value =
    s.amount !== null
      ? s.amount
      : rules && duration !== null
        ? resolvePaymentValue(rules.valueRules, duration, {
            workDate: s.workDate,
            local: s.local,
            role: s.role,
            scheduleStartMinutes: s.scheduleStartMinutes,
            scheduleEndMinutes: s.scheduleEndMinutes,
          })
        : null;
  // A pending change (found by the automatic verification, not yet
  // reviewed/accepted) blocks every other row action — the only thing left
  // to do with the row is review it (see `onReview`). One already applied
  // by auto-apply is purely informational: doesn't block anything, just
  // offers a way to see what changed.
  const pendingChanges = changes.filter((c) => !c.applied);
  const appliedChanges = changes.filter((c) => c.applied);
  const isBlocked = pendingChanges.length > 0;
  const canEdit = !isBlocked && (s.status === "pendente" || s.status === "erro");
  const col = (id: string) => visibleColumns.has(id);
  const patch = (p: ShiftFieldPatch) => onCommitField(s, groupRef, p);

  // Same actions the old Ações column rendered as buttons, now offered
  // through a right-click menu instead (see `onRowContextMenu`) — a blocked
  // row only offers "Revisar alteração" plus "Ver histórico", nothing else.
  // Two items are always present but individually `disabled` rather than
  // omitted when they don't currently apply, so the option stays
  // discoverable instead of the menu's shape shifting row to row:
  // "Fazer pagamento" needs an horário to compute horas/valor from, and
  // "Ver histórico" needs an earlier state in the chain (`previousShiftId`).
  const rowActions: ContextMenuItem[] = [
    ...(isBlocked
      ? [{ label: "Revisar alteração", onClick: () => onReview(s, groupRef) }]
      : [
          ...(appliedChanges.length > 0 ? [{ label: "Ver o que mudou", onClick: () => onReview(s, groupRef) }] : []),
          ...(s.status === "pendente" || s.status === "erro"
            ? [{ label: "Fazer pagamento", disabled: !hasSchedule, onClick: () => onPay(s, companyId, groupRef) }]
            : []),
          ...(s.status === "pago" ? [{ label: "Voltar para pendente", onClick: () => onRevert(s, groupRef) }] : []),
        ]),
    { label: "Ver histórico", disabled: s.previousShiftId === null, onClick: () => onViewHistory(s.previousShiftId, companyId, s.clientId) },
    ...(isBlocked ? [] : [{ label: "Remover turno", danger: true, onClick: () => onDelete(s, groupRef) }]),
  ];

  return (
    <tr
      className={s.id === activeShiftId ? "row-active" : undefined}
      onMouseDownCapture={(e) => {
        if (e.button === 0) onRowMouseDown(s.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu(e, rowActions, s.id);
      }}
      style={isBlocked ? { background: "var(--warning-soft)" } : appliedChanges.length > 0 ? { background: "var(--accent-soft)" } : undefined}
    >
      {identity && col("colaborador") && (
        <td>
          <div className="person-cell">
            <Avatar name={identity.employeeName} />
            {identity.employeeName}
          </div>
        </td>
      )}
      {identity && col("cliente") && <td>{identity.clientName}</td>}
      {identity && col("empresa") && <td>{identity.companyName}</td>}
      {col("data") && (
        <td>
          <EditableDateCell editable={canEdit} value={s.workDate} display={formatDateAbbrevYY(s.workDate)} onCommit={(v) => patch({ workDate: v })} />
        </td>
      )}
      {col("local") && (
        <td>
          <EditableCell editable={canEdit} value={s.local} display={s.local} onCommit={(v) => patch({ local: v })} />
        </td>
      )}
      {col("funcao") && (
        <td>
          <EditableCell editable={canEdit} value={s.role} display={s.role} onCommit={(v) => patch({ role: v })} />
        </td>
      )}
      {col("horario") && (
        <td>
          <EditableSchedule
            editable={canEdit}
            startTime={s.scheduleStartMinutes !== null ? formatMinutesAsTime(s.scheduleStartMinutes) : ""}
            endTime={s.scheduleEndMinutes !== null ? formatMinutesAsTime(s.scheduleEndMinutes) : ""}
            display={
              hasSchedule ? (
                <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
                  <span>
                    {formatMinutesAsTime(s.scheduleStartMinutes!)} – {formatMinutesAsTime(s.scheduleEndMinutes!)}
                  </span>
                  {s.shiftPeriod && (
                    <span
                      className={s.shiftPeriod === "noturno" ? "badge info" : "badge neutral"}
                      title={s.shiftPeriod === "noturno" ? "Noturno" : "Diurno"}
                    >
                      {s.shiftPeriod === "noturno" ? <Moon size={12} /> : <Sun size={12} />}
                    </span>
                  )}
                </span>
              ) : (
                "—"
              )
            }
            onCommit={(start, end) =>
              patch({
                scheduleStartMinutes: start ? parseTimeToMinutes(start) : null,
                scheduleEndMinutes: end ? parseTimeToMinutes(end) : null,
              })
            }
          />
        </td>
      )}
      {col("horas") && <td>{duration !== null ? formatMinutesAsTime(duration) : "—"}</td>}
      {col("valor") && (
        <td>
          <EditableCurrencyCell
            editable={canEdit}
            value={value}
            display={value !== null ? formatCurrencyBRL(value) : "—"}
            onCommit={(amount) => patch({ amount })}
          />
        </td>
      )}
      {col("status") && (
        <td>
          <span className={badge.className} title={s.status === "erro" ? s.errorMessage ?? undefined : undefined}>
            {badge.label}
          </span>
        </td>
      )}
      {col("importado") && (
        <td className="muted" style={{ fontSize: "0.8rem" }}>
          {formatDateTimeAbbrevYY(s.importedAt)}
        </td>
      )}
      {col("extras") && (
        <td>
          {(() => {
            const extra = displayExtraData(s);
            if (!s.editedManually && !extra) return <span className="muted">—</span>;
            return (
              <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem" }}>
                {extra && (
                  <PillButton onClick={() => onViewExtra(extra, s.sourceUrl)} title="Ver colunas não mapeadas lidas do arquivo">
                    <Info size={12} />
                    {Object.keys(extra).length}
                  </PillButton>
                )}
                {s.editedManually && (
                  <span
                    className="badge info"
                    title={
                      s.status === "pago"
                        ? "Atualizado manualmente — o histórico deste turno inclui um campo corrigido à mão (Data/Local/Função/Horário/Valor)."
                        : "Atualizado manualmente — uma reimportação não sobrescreve este turno enquanto 'Manter registros atualizados manualmente' estiver ativado (Configurações → Zona de risco → Pagamentos)."
                    }
                  >
                    <ShieldCheck size={13} />
                  </span>
                )}
              </span>
            );
          })()}
        </td>
      )}
    </tr>
  );
}

export default function PaymentsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const attentionParam = searchParams.get("attention");
  const attention = attentionParam === "pending-audit" || attentionParam === "missing-amount" ? attentionParam : undefined;
  const analyticsParam = searchParams.get("analytics");
  const analytics = analyticsParam === "journey-over-12h" || analyticsParam === "journey-under-4h" || analyticsParam === "rest-under-11h" || analyticsParam === "heatmap" ? analyticsParam : undefined;
  const analyticsWeekday = searchParams.has("weekday") ? Number(searchParams.get("weekday")) : undefined;
  const analyticsTimeBucket = searchParams.has("bucket") ? Number(searchParams.get("bucket")) : undefined;
  const analyticsShiftIds = (searchParams.get("ids") || "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  const {
    selectedEmployeeIds,
    setSelectedEmployeeIds,
    selectedCompanyIds,
    setSelectedCompanyIds,
    selectedClientIds,
    setSelectedClientIds,
    selectedRoleIds,
    setSelectedRoleIds,
    selectedLocals,
    setSelectedLocals,
    periodStart,
    periodEnd,
    setPeriod,
    selectedStatuses,
    setSelectedStatuses,
    selectedShiftPeriods,
    setSelectedShiftPeriods,
    scheduleTimeFilter,
    setScheduleTimeFilter,
    grouped,
    setGrouped,
    page,
    setPage,
    pageSize,
    setPageSize,
    selectedExportTemplateId,
    setSelectedExportTemplateId,
  } = usePaymentsFilters();
  const { trackedFiles, reimportConfigs } = useRemoteFileUpdates();

  const [summaries, setSummaries] = useState<PaymentShiftSummaryRow[]>([]);
  const [summariesTotal, setSummariesTotal] = useState(0);
  const [flatRows, setFlatRows] = useState<PaymentShiftFlatRow[]>([]);
  const [flatTotal, setFlatTotal] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [locals, setLocals] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [revealingPdf, setRevealingPdf] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<PaymentsReportResult | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);

  const [exportTemplates, setExportTemplates] = useState<PaymentExportTemplateListRow[]>([]);
  const [generatingExport, setGeneratingExport] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [revealingExport, setRevealingExport] = useState(false);
  const [generatedExport, setGeneratedExport] = useState<PaymentExportResult | null>(null);

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_COLUMN_IDS));

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [groupRows, setGroupRows] = useState<Map<string, PaymentShiftGroupRow[]>>(new Map());
  const [loadingGroups, setLoadingGroups] = useState<Set<string>>(new Set());

  const [rulesByPair, setRulesByPair] = useState<Map<string, EffectivePaymentRules>>(new Map());
  const fetchedRulePairKeys = useRef<Set<string>>(new Set());

  const [shiftDiffs, setShiftDiffs] = useState<Map<number, ShiftFieldDiffRow[]>>(new Map());

  const [payingShift, setPayingShift] = useState<{ shift: PaymentShiftRow; companyId: number; groupRef: GroupRef } | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [revertingShift, setRevertingShift] = useState<{ shift: PaymentShiftRow; groupRef: GroupRef } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [deletingShift, setDeletingShift] = useState<{ shift: PaymentShiftRow; groupRef: GroupRef } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [inlineEditError, setInlineEditError] = useState<string | null>(null);
  const [viewingHistory, setViewingHistory] = useState<{ shiftId: number | null; companyId: number; clientId: number } | null>(
    null,
  );
  const [viewingExtraData, setViewingExtraData] = useState<{ data: Record<string, string>; sourceUrl: string | null } | null>(
    null,
  );

  // "Revisar alteração" Drawer — the last automatic verification found a
  // pending (or already auto-applied) change for this shift (see
  // `shiftDiffs`). A pending one blocks every other row action until
  // resolved here (see `ShiftRow`'s `isBlocked`).
  const [reviewingShift, setReviewingShift] = useState<{ shift: PaymentShiftRow; groupRef: GroupRef } | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [markingReviewDeleted, setMarkingReviewDeleted] = useState(false);

  // Right-click menu for a turno row — replaces the old always-visible
  // Ações column (see `ShiftRow`'s `rowActions`).
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  // Which row's action is "in flight" — set on right-click and kept lit
  // (`.row-active`, see `ShiftRow`) through whatever Drawer/modal the picked
  // action opens, so closing it doesn't leave you guessing which turno it
  // was for. Cleared only by a left-click landing on a *different* row.
  const [activeShiftId, setActiveShiftId] = useState<number | null>(null);
  function handleRowContextMenu(e: MouseEvent, items: ContextMenuItem[], shiftId: number) {
    setActiveShiftId(shiftId);
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }
  function handleRowMouseDown(shiftId: number) {
    setActiveShiftId((prev) => (prev === shiftId ? prev : null));
  }

  useEffect(() => {
    Promise.all([listCompanies(), listClients(), listRolesGlobal(), listDistinctPaymentShiftLocals()]).then(
      ([companyRows, clientRows, roleRows, localValues]) => {
        setCompanies(companyRows);
        setClients(clientRows);
        setRoles(roleRows);
        setLocals(localValues);
      },
    );
    getPaymentVisibleColumns().then((cols) => {
      if (cols) setVisibleColumns(new Set(cols));
    });
  }, []);

  useEffect(() => {
    listPaymentExportTemplates().then(setExportTemplates);
  }, []);

  function ensureRulesLoaded(pairs: { clientId: number; companyId: number }[]) {
    const toFetch = new Map(
      pairs
        .map((p) => [`${p.clientId}:${p.companyId}`, p] as const)
        .filter(([key]) => !fetchedRulePairKeys.current.has(key)),
    );
    if (toFetch.size === 0) return;
    toFetch.forEach((_, key) => fetchedRulePairKeys.current.add(key));
    Promise.all(
      Array.from(toFetch.entries(), async ([key, p]) => [key, await getEffectivePaymentRules(p.clientId, p.companyId)] as const),
    ).then((fetched) => {
      setRulesByPair((prev) => {
        const next = new Map(prev);
        fetched.forEach(([key, rules]) => next.set(key, rules));
        return next;
      });
    });
  }

  /** Refreshed on every load of `flatRows`/a group's rows, not cached long-term like `rulesByPair` — the background verification keeps running while this page is open, so what it last found can change out from under an already-loaded row. */
  async function refreshShiftDiffs(ids: number[]) {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) return;
    const rows = await listLatestFieldDiffsForShifts(uniqueIds);
    setShiftDiffs((prev) => {
      const next = new Map(prev);
      for (const id of uniqueIds) next.delete(id);
      for (const row of rows) {
        const list = next.get(row.shiftId) ?? [];
        list.push(row);
        next.set(row.shiftId, list);
      }
      return next;
    });
  }

  // `trackedFiles` is a fresh array every time a background check batch
  // finishes (`RemoteFileUpdatesContext.refreshTrackedState`, run after
  // every scheduled tick or forced check) — reacting to it here is what
  // makes a change the automatic verification finds show up on an
  // already-open Pagamentos page without the user touching a filter or
  // reloading. Only re-fetches the diff annotations for whatever's already
  // on screen, never the shift rows themselves — the check is read-only by
  // design (see `computeReimportDiff`), so there's never new shift data to
  // pull, only a possibly-updated verdict on existing rows.
  useEffect(() => {
    const visibleIds = grouped
      ? Array.from(groupRows.values()).flatMap((rows) => rows.map((r) => r.id))
      : flatRows.map((r) => r.id);
    refreshShiftDiffs(visibleIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedFiles]);

  function toggleColumn(id: string) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setPaymentVisibleColumns(Array.from(next));
      return next;
    });
  }

  function baseQuery(): Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize"> {
    return {
      employeeIds: Array.from(selectedEmployeeIds, Number),
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      roleIds: Array.from(selectedRoleIds, Number),
      locals: Array.from(selectedLocals),
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      statuses: Array.from(selectedStatuses),
      shiftPeriods: Array.from(selectedShiftPeriods),
      scheduleTimeFilter,
      attention,
      analytics,
      analyticsWeekday,
      analyticsTimeBucket,
      analyticsShiftIds,
    };
  }

  async function refetchFlat() {
    const { rows, total } = await listPaymentShiftsFlat({ ...baseQuery(), page, pageSize });
    setFlatRows(rows);
    setFlatTotal(total);
    ensureRulesLoaded(rows.map((r) => ({ clientId: r.clientId, companyId: r.companyId })));
    refreshShiftDiffs(rows.map((r) => r.id));
  }

  async function refetchSummaries() {
    const { rows, total } = await listPaymentShiftSummaries({ ...baseQuery(), page, pageSize });
    setSummaries(rows);
    setSummariesTotal(total);
  }

  async function refetchGroup(employeeId: number, competencia: string) {
    const rows = await listPaymentShiftsForGroup(employeeId, competencia, baseQuery());
    setGroupRows((prev) => new Map(prev).set(groupKey(employeeId, competencia), rows));
    refreshShiftDiffs(rows.map((r) => r.id));
  }

  // The table itself — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    setExpandedKeys(new Set());
    setGroupRows(new Map());
    const run = grouped ? refetchSummaries() : refetchFlat();
    run
      .catch((e) => {
        if (!cancelled) setListError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    grouped,
    selectedEmployeeIds,
    selectedCompanyIds,
    selectedClientIds,
    selectedRoleIds,
    selectedLocals,
    periodStart,
    periodEnd,
    selectedStatuses,
    selectedShiftPeriods,
    scheduleTimeFilter,
    attention,
    analytics,
    analyticsWeekday,
    analyticsTimeBucket,
    searchParams,
    page,
    pageSize,
  ]);

  // Cross-window sync: refreshes this table when a payment is
  // confirmed/marked erro/undone in "Conferência de Pagamentos" — its own
  // detached window (see `notifyPaymentShiftsChanged` in `db.ts` and
  // `PaymentReconciliationScreen`'s own listener for the other half of
  // this). A ref, not a dependency
  // list, since the listener is only ever subscribed once but needs
  // whichever `refetchFlat`/`refetchSummaries` closure (over `grouped`/
  // filters/page) is current at the moment the event actually arrives.
  const refetchTableRef = useRef(() => (grouped ? refetchSummaries() : refetchFlat()));
  refetchTableRef.current = () => (grouped ? refetchSummaries() : refetchFlat());
  useEffect(() => {
    const unlisten = listen(PAYMENT_SHIFTS_CHANGED_EVENT, () => {
      refetchTableRef.current().catch(() => {});
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // A previously generated PDF reflects a specific set of filters (and,
  // since it now adds a per-colaborador subtotal when grouped, `grouped`
  // itself) — changing any of them means the next "Gerar PDF" would produce
  // a different document, so the stale "PDF gerado com sucesso" banner (and
  // any leftover error) no longer applies. Deliberately excludes
  // `page`/`pageSize`: those change how the table is paginated on screen,
  // not which rows (or how they're grouped) end up in a report.
  useEffect(() => {
    setGeneratedReport(null);
    setPdfError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmployeeIds, selectedCompanyIds, selectedClientIds, selectedRoleIds, periodStart, periodEnd, selectedStatuses, selectedShiftPeriods, scheduleTimeFilter, grouped]);

  async function afterMutation(groupRef: GroupRef) {
    if (groupRef === null) {
      await refetchFlat();
    } else {
      await Promise.all([refetchSummaries(), refetchGroup(groupRef.employeeId, groupRef.competencia)]);
    }
  }

  /** "Aceitar e atualizar" in the review Drawer — re-checks the shift's own config fresh and writes the change, same as an unattended auto-apply pass would, scoped to just this one shift (see `acceptShiftChange`). */
  async function handleAcceptChange() {
    if (!reviewingShift) return;
    const changes = shiftDiffs.get(reviewingShift.shift.id) ?? [];
    const configId = changes.find((c) => c.changeKind === "field" && !c.applied)?.configId ?? null;
    const config = configId !== null ? reimportConfigs.find((rc) => rc.id === configId) : undefined;
    if (!config) {
      setAcceptError("Não foi possível encontrar a configuração de reimportação que encontrou essa mudança — pode ter sido removida.");
      return;
    }
    setAccepting(true);
    setAcceptError(null);
    try {
      await acceptShiftChange(config, reviewingShift.shift.id);
      await refreshShiftDiffs([reviewingShift.shift.id]);
      await afterMutation(reviewingShift.groupRef);
      setReviewingShift(null);
    } catch (e) {
      setAcceptError(String(e instanceof Error ? e.message : e));
    } finally {
      setAccepting(false);
    }
  }

  /** "Marcar como excluído" from inside the review Drawer — same soft-delete `deletePaymentShift` uses everywhere else, just reachable straight from a pending 'removed' review instead of the row's own (hidden, while blocked) Remover button. */
  async function handleMarkReviewDeleted() {
    if (!reviewingShift) return;
    setMarkingReviewDeleted(true);
    try {
      await deletePaymentShift(reviewingShift.shift.id);
      await afterMutation(reviewingShift.groupRef);
      setReviewingShift(null);
    } finally {
      setMarkingReviewDeleted(false);
    }
  }

  function toggleGroup(s: PaymentShiftSummaryRow) {
    const key = groupKey(s.employeeId, s.competencia);
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!groupRows.has(key)) {
      setLoadingGroups((prev) => new Set(prev).add(key));
      listPaymentShiftsForGroup(s.employeeId, s.competencia, baseQuery())
        .then((rows) => {
          setGroupRows((prev) => new Map(prev).set(key, rows));
          ensureRulesLoaded([{ clientId: s.clientId, companyId: s.companyId }]);
          refreshShiftDiffs(rows.map((r) => r.id));
        })
        .finally(() => {
          setLoadingGroups((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        });
    }
  }

  async function handleConfirmPayment(amount: number) {
    if (!payingShift) return;
    setPaying(true);
    setPayError(null);
    try {
      // "Pagar" always appends a brand-new row instead of touching
      // `payingShift.shift` itself (see `markPaymentShiftPaid`'s own doc
      // comment) — without re-pointing `activeShiftId` at it, the highlight
      // this action was for would vanish the moment the list refetches,
      // since no row still has the old id.
      const newShiftId = await markPaymentShiftPaid(payingShift.shift.id, amount);
      await afterMutation(payingShift.groupRef);
      setActiveShiftId(newShiftId);
      setPayingShift(null);
    } catch (e) {
      setPayError(String(e instanceof Error ? e.message : e));
    } finally {
      setPaying(false);
    }
  }

  async function handleConfirmRevert() {
    if (!revertingShift) return;
    setReverting(true);
    setRevertError(null);
    try {
      // Same append-only move as "Pagar" — re-point the highlight at the
      // new head row (see the comment in `handleConfirmPayment`).
      const newShiftId = await revertPaymentShiftToPending(revertingShift.shift.id);
      await afterMutation(revertingShift.groupRef);
      setActiveShiftId(newShiftId);
      setRevertingShift(null);
    } catch (e) {
      setRevertError(String(e instanceof Error ? e.message : e));
    } finally {
      setReverting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingShift) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePaymentShift(deletingShift.shift.id);
      await afterMutation(deletingShift.groupRef);
      setDeletingShift(null);
    } catch (e) {
      setDeleteError(String(e instanceof Error ? e.message : e));
    } finally {
      setDeleting(false);
    }
  }

  /** Fields not in `patch` carry over from `shift`'s own current value — an inline edit only ever touches the one column the user clicked on. */
  function commitField(shift: PaymentShiftRow, groupRef: GroupRef, patch: ShiftFieldPatch) {
    setInlineEditError(null);
    editPaymentShift(shift.id, {
      workDate: patch.workDate !== undefined ? patch.workDate : shift.workDate,
      local: patch.local !== undefined ? patch.local : shift.local,
      role: patch.role !== undefined ? patch.role : shift.role,
      scheduleStartMinutes: patch.scheduleStartMinutes !== undefined ? patch.scheduleStartMinutes : shift.scheduleStartMinutes,
      scheduleEndMinutes: patch.scheduleEndMinutes !== undefined ? patch.scheduleEndMinutes : shift.scheduleEndMinutes,
      amount: patch.amount !== undefined ? patch.amount : shift.amount,
    })
      .then(() => afterMutation(groupRef))
      .catch((e) => setInlineEditError(String(e instanceof Error ? e.message : e)));
  }

  function shiftValueFor(s: PaymentShiftRow, companyId: number): number | null {
    if (s.amount !== null) return s.amount;
    const rules = rulesByPair.get(`${s.clientId}:${companyId}`);
    if (!rules || s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(s.scheduleStartMinutes, s.scheduleEndMinutes);
    return resolvePaymentValue(rules.valueRules, duration, {
      workDate: s.workDate,
      local: s.local,
      role: s.role,
      scheduleStartMinutes: s.scheduleStartMinutes,
      scheduleEndMinutes: s.scheduleEndMinutes,
    });
  }

  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);

  function handleApplyFilters(next: PaymentsFiltersValue) {
    setSearchParams({});
    setSelectedEmployeeIds(next.employeeIds);
    setSelectedCompanyIds(next.companyIds);
    setSelectedClientIds(next.clientIds);
    setSelectedRoleIds(next.roleIds);
    setSelectedLocals(next.locals);
    setPeriod(next.periodStart, next.periodEnd);
    setSelectedStatuses(next.statuses);
    setSelectedShiftPeriods(next.shiftPeriods);
    setScheduleTimeFilter(next.scheduleTimeFilter);
    setGrouped(next.grouped);
    setPage(0);
    setFiltersDrawerOpen(false);
  }

  /** Every turno matching the current filters, not just the visible page — see `generatePaymentsReportPdf`. */
  async function handleGeneratePdf() {
    setPdfError(null);
    setGeneratedReport(null);
    setGeneratingPdf(true);
    try {
      const result = await generatePaymentsReportPdf(baseQuery(), grouped);
      if (result.rowCount === 0) {
        setPdfError(noReportRowsMessage(result.matchedCount));
      } else if (result.path) {
        // `path === null` with rows > 0 means the user cancelled the save
        // dialog — nothing to show, same as LibraryPage's "Gerar zip".
        setGeneratedReport(result);
      }
    } catch (e) {
      setPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function handleRevealPdf() {
    if (!generatedReport?.path) return;
    setRevealingPdf(true);
    try {
      await revealInFileManager(generatedReport.path);
    } catch (e) {
      setPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setRevealingPdf(false);
    }
  }

  /** Same shape as `handleGeneratePdf`, but a template has to be chosen first — see "Exportar Excel" below. */
  async function handleGenerateExport() {
    if (!selectedExportTemplateId) return;
    setExportError(null);
    setGeneratedExport(null);
    setGeneratingExport(true);
    try {
      const result = await generatePaymentsExportXlsx(Number(selectedExportTemplateId), baseQuery());
      if (result.rowCount === 0) {
        setExportError(noReportRowsMessage(result.matchedCount));
      } else if (result.path) {
        setGeneratedExport(result);
      }
    } catch (e) {
      setExportError(String(e instanceof Error ? e.message : e));
    } finally {
      setGeneratingExport(false);
    }
  }

  async function handleRevealExport() {
    if (!generatedExport?.path) return;
    setRevealingExport(true);
    try {
      await revealInFileManager(generatedExport.path);
    } catch (e) {
      setExportError(String(e instanceof Error ? e.message : e));
    } finally {
      setRevealingExport(false);
    }
  }

  const hasFilters = Boolean(
    selectedEmployeeIds.size > 0 ||
      selectedCompanyIds.size > 0 ||
      selectedClientIds.size > 0 ||
      selectedRoleIds.size > 0 ||
      selectedLocals.size > 0 ||
      periodStart ||
      periodEnd ||
      selectedStatuses.size < STATUS_OPTIONS.length ||
      selectedShiftPeriods.size < SHIFT_PERIOD_OPTIONS.length ||
      scheduleTimeFilter !== null ||
      attention !== undefined ||
      analytics !== undefined,
  );
  /** How many filter categories are currently applied — shown as a count badge on the "Filtros" button so it's clear at a glance the list isn't unfiltered, without opening the Drawer. */
  const activeFilterCount = [
    selectedEmployeeIds.size > 0,
    selectedCompanyIds.size > 0,
    selectedClientIds.size > 0,
    selectedRoleIds.size > 0,
    selectedLocals.size > 0,
    Boolean(periodStart || periodEnd),
    selectedStatuses.size < STATUS_OPTIONS.length,
    selectedShiftPeriods.size < SHIFT_PERIOD_OPTIONS.length,
    scheduleTimeFilter !== null,
    attention !== undefined,
    analytics !== undefined,
  ].filter(Boolean).length;
  const total = grouped ? summariesTotal : flatTotal;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="page-header">
        <h2>Pagamentos</h2>
      </div>
      <p className="page-subtitle">
        {grouped
          ? "Turnos importados, agrupados por colaborador e competência. Clique num colaborador para expandir os turnos individuais daquele mês."
          : "Turnos importados, um turno por linha."}
      </p>
      {pdfError && <div className="error-box">{pdfError}</div>}
      {exportError && <div className="error-box">{exportError}</div>}
      {inlineEditError && <div className="error-box">{inlineEditError}</div>}
      {attention && (
        <div className="info-box">
          Filtro da análise: {attention === "pending-audit" ? "pagamentos aguardando conferência" : "turnos sem valor definido"}.
        </div>
      )}
      {analytics && (
        <div className="info-box">
          Filtro da análise: {{ "journey-over-12h": "jornadas acima de 12h", "journey-under-4h": "jornadas abaixo de 4h", "rest-under-11h": "intervalos inferiores a 11h", heatmap: "célula do mapa de calor" }[analytics]}.
        </div>
      )}

      <div className="card">
        <div className="field-row" style={{ marginBottom: 0, alignItems: "center" }}>
          <button type="button" className="secondary" onClick={() => setFiltersDrawerOpen(true)}>
            <Filter size={15} style={{ marginRight: "0.4rem" }} />
            {activeFilterCount > 0 ? `Filtros (${activeFilterCount})` : "Filtros"}
          </button>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.6rem", alignItems: "center" }}>
            {exportTemplates.length > 0 && (
              <select
                value={selectedExportTemplateId}
                onChange={(e) => setSelectedExportTemplateId(e.target.value)}
                title="Template de exportação Excel"
              >
                <option value="">Selecione um template...</option>
                {exportTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => navigate("/payments/export-templates")}
              title="Gerenciar templates de exportação — criar, editar ou excluir"
            >
              <Settings2 size={15} style={{ marginRight: "0.4rem" }} />
              Templates
            </button>
            {exportTemplates.length > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={handleGenerateExport}
                disabled={generatingExport || !selectedExportTemplateId}
                title="Considera os filtros acima"
              >
                <FileSpreadsheet size={15} style={{ marginRight: "0.4rem" }} />
                {generatingExport ? "Exportando..." : "Exportar Excel"}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => openReconciliationWindow().catch(() => {})}
              title="Conferência de Pagamentos — considera os filtros acima"
            >
              <ClipboardCheck size={15} style={{ marginRight: "0.4rem" }} />
              Conferência
            </button>
            <button type="button" onClick={handleGeneratePdf} disabled={generatingPdf} title="Considera os filtros acima">
              <FileDown size={15} style={{ marginRight: "0.4rem" }} />
              {generatingPdf ? "Gerando..." : "Gerar PDF"}
            </button>
          </div>
        </div>

        {generatedExport && generatedExport.path && (
          <div
            className="success-box"
            style={{
              marginTop: "1rem",
              marginBottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <CheckCircle2 size={16} />
              Excel gerado com sucesso: {generatedExport.title} ({generatedExport.rowCount} turno(s))
            </span>
            <button type="button" className="outline" onClick={handleRevealExport} disabled={revealingExport}>
              <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
              Abrir no explorador
            </button>
          </div>
        )}

        {generatedReport && generatedReport.path && (
          <div
            className="success-box"
            style={{
              marginTop: "1rem",
              marginBottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <CheckCircle2 size={16} />
              PDF gerado com sucesso: {generatedReport.title} ({generatedReport.rowCount} turno(s))
            </span>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" className="outline" onClick={() => setViewerPath(generatedReport.path)}>
                <Eye size={15} style={{ marginRight: "0.4rem" }} />
                Abrir PDF
              </button>
              <button type="button" className="outline" onClick={handleRevealPdf} disabled={revealingPdf}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                Abrir no explorador
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "0.8rem", margin: "1rem 0" }}>
        <MultiSelectDropdown
          options={FLAT_COLUMNS}
          selected={visibleColumns}
          onToggle={toggleColumn}
          onSelectAll={() => {
            setVisibleColumns(new Set(ALL_COLUMN_IDS));
            setPaymentVisibleColumns(ALL_COLUMN_IDS);
          }}
          onSelectNone={() => {
            setVisibleColumns(new Set());
            setPaymentVisibleColumns([]);
          }}
          icon={Settings2}
          allLabel="Configurar colunas"
          noneLabel="Nenhuma coluna"
          countLabel={(n) => `Colunas (${n})`}
        />
      </div>

      <div className="card table-card">
        {listError && (
          <div className="error-box" style={{ margin: "1.4rem" }}>
            Não foi possível carregar os pagamentos: {listError}
          </div>
        )}
        {loading && (grouped ? summaries.length === 0 : flatRows.length === 0) && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Carregando...
          </p>
        )}
        {!loading && !listError && total === 0 && !hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum pagamento importado ainda.
          </p>
        )}
        {!loading && !listError && total === 0 && hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum resultado para os filtros selecionados. Considere ajustar os filtros ou{" "}
            <Link to="/import/payments">importar um novo pagamento</Link>.
          </p>
        )}

        {total > 0 && grouped && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "2rem" }} />
                    <th>Colaborador</th>
                    <th>Cliente</th>
                    <th>Empresa</th>
                    <th>Competência</th>
                    <th style={{ textAlign: "right" }}>Turnos</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => {
                    const key = groupKey(s.employeeId, s.competencia);
                    const isExpanded = expandedKeys.has(key);
                    const rows = groupRows.get(key);
                    const isLoadingGroup = loadingGroups.has(key);
                    return (
                      <Fragment key={key}>
                        <tr style={{ cursor: "pointer" }} onClick={() => toggleGroup(s)}>
                          <td>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          <td>
                            <div className="person-cell">
                              <Avatar name={s.employeeName} />
                              {s.employeeName}
                            </div>
                          </td>
                          <td>{s.clientName}</td>
                          <td>{s.companyName}</td>
                          <td>{formatCompetencia(s.competencia)}</td>
                          <td style={{ textAlign: "right" }}>{s.total}</td>
                          <td>
                            <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                              {s.pendente > 0 && <span className="badge warn">{s.pendente} pendente</span>}
                              {s.erro > 0 && <span className="badge file-error">{s.erro} erro</span>}
                              {s.pago > 0 && <span className="badge ok">{s.pago} pago</span>}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={7} style={{ padding: 0, background: "var(--surface-container)" }}>
                              {isLoadingGroup && !rows && (
                                <p className="muted" style={{ padding: "1rem" }}>
                                  Carregando turnos...
                                </p>
                              )}
                              {rows && (
                                <div style={{ padding: "0.8rem 1rem" }} onClick={(e) => e.stopPropagation()}>
                                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
                                    {rows.length} de {s.total} turno(s)
                                  </p>
                                  <div className="table-scroll">
                                    <table>
                                      <thead>
                                        <tr>
                                          {TURNO_COLUMNS.filter((c) => visibleColumns.has(c.id)).map((c) => (
                                            <th key={c.id}>{c.label}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {rows.map((r) => (
                                          <ShiftRow
                                            key={r.id}
                                            shift={r}
                                            companyId={s.companyId}
                                            groupRef={{ employeeId: s.employeeId, competencia: s.competencia }}
                                            rules={rulesByPair.get(`${s.clientId}:${s.companyId}`) ?? null}
                                            visibleColumns={visibleColumns}
                                            changes={shiftDiffs.get(r.id) ?? []}
                                            onCommitField={commitField}
                                            onPay={(shift, companyId, groupRef) => setPayingShift({ shift, companyId, groupRef })}
                                            onRevert={(shift, groupRef) => setRevertingShift({ shift, groupRef })}
                                            onDelete={(shift, groupRef) => setDeletingShift({ shift, groupRef })}
                                            onViewHistory={(shiftId, companyId, clientId) => setViewingHistory({ shiftId, companyId, clientId })}
                                            onViewExtra={(data, sourceUrl) => setViewingExtraData({ data, sourceUrl })}
                                            onReview={(shift, groupRef) => setReviewingShift({ shift, groupRef })}
                                            onRowContextMenu={handleRowContextMenu}
                                            activeShiftId={activeShiftId}
                                            onRowMouseDown={handleRowMouseDown}
                                          />
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {total > PAYMENTS_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(total, page * pageSize + pageSize)} de ${total}`}
                pageSize={pageSize}
                pageSizeOptions={PAYMENTS_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
              />
            )}
          </>
        )}

        {total > 0 && !grouped && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {FLAT_COLUMNS.filter((c) => visibleColumns.has(c.id)).map((c) => (
                      <th key={c.id}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flatRows.map((r) => (
                    <ShiftRow
                      key={r.id}
                      shift={r}
                      companyId={r.companyId}
                      groupRef={null}
                      identity={{ employeeName: r.employeeName, companyName: r.companyName, clientName: r.clientName }}
                      rules={rulesByPair.get(`${r.clientId}:${r.companyId}`) ?? null}
                      visibleColumns={visibleColumns}
                      changes={shiftDiffs.get(r.id) ?? []}
                      onCommitField={commitField}
                      onPay={(shift, companyId, groupRef) => setPayingShift({ shift, companyId, groupRef })}
                      onRevert={(shift, groupRef) => setRevertingShift({ shift, groupRef })}
                      onDelete={(shift, groupRef) => setDeletingShift({ shift, groupRef })}
                      onViewHistory={(shiftId, companyId, clientId) => setViewingHistory({ shiftId, companyId, clientId })}
                      onViewExtra={(data, sourceUrl) => setViewingExtraData({ data, sourceUrl })}
                      onReview={(shift, groupRef) => setReviewingShift({ shift, groupRef })}
                      onRowContextMenu={handleRowContextMenu}
                      activeShiftId={activeShiftId}
                      onRowMouseDown={handleRowMouseDown}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {total > PAYMENTS_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(total, page * pageSize + pageSize)} de ${total}`}
                pageSize={pageSize}
                pageSizeOptions={PAYMENTS_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
              />
            )}
          </>
        )}
      </div>

      {payingShift && (
        <ConfirmPaymentModal
          shift={payingShift.shift}
          suggestedAmount={shiftValueFor(payingShift.shift, payingShift.companyId)}
          changes={shiftDiffs.get(payingShift.shift.id) ?? []}
          busy={paying}
          error={payError}
          onConfirm={handleConfirmPayment}
          onCancel={() => {
            setPayingShift(null);
            setPayError(null);
          }}
        />
      )}

      {revertingShift && (
        <ConfirmModal
          title="Voltar para pendente"
          message={`Isso cria um novo registro com status "Pendente" para ${formatDate(revertingShift.shift.workDate)} · ${revertingShift.shift.local}. O registro pago atual não será alterado, ficando disponível no histórico.`}
          confirmLabel={reverting ? "Revertendo..." : "Voltar para pendente"}
          confirmDisabled={reverting}
          danger={false}
          error={revertError}
          onConfirm={handleConfirmRevert}
          onCancel={() => {
            setRevertingShift(null);
            setRevertError(null);
          }}
        />
      )}

      {deletingShift && (
        <ConfirmModal
          title="Remover turno"
          message={`Isso remove o registro de ${formatDate(deletingShift.shift.workDate)} · ${deletingShift.shift.local} e todo o seu histórico (pagamentos, reversões e edições anteriores) — não aparece mais em nenhuma lista, relatório ou exportação. Se esse turno for reimportado depois, a pré-visualização vai avisar que ele já foi removido, para você decidir se quer trazê-lo de volta.`}
          confirmLabel={deleting ? "Removendo..." : "Remover"}
          confirmDisabled={deleting}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setDeletingShift(null);
            setDeleteError(null);
          }}
        />
      )}

      <ShiftHistoryDrawer
        open={viewingHistory !== null}
        shiftId={viewingHistory?.shiftId ?? null}
        rules={viewingHistory ? rulesByPair.get(`${viewingHistory.clientId}:${viewingHistory.companyId}`) ?? null : null}
        onClose={() => setViewingHistory(null)}
      />
      <ExtraColumnsDrawer
        open={viewingExtraData !== null}
        data={viewingExtraData?.data ?? null}
        sourceUrl={viewingExtraData?.sourceUrl ?? null}
        onClose={() => setViewingExtraData(null)}
      />

      <PdfViewerModal
        path={viewerPath}
        title={generatedReport?.title}
        allowDownload={false}
        onClose={() => setViewerPath(null)}
      />

      <Drawer
        open={reviewingShift !== null}
        onClose={() => {
          setReviewingShift(null);
          setAcceptError(null);
        }}
        title={reviewingShift ? `${reviewingShift.shift.employeeName} — ${formatDate(reviewingShift.shift.workDate)}` : ""}
      >
        {reviewingShift &&
          (() => {
            const changes = shiftDiffs.get(reviewingShift.shift.id) ?? [];
            const fieldChanges = changes.filter((c) => c.changeKind === "field");
            const removedChange = changes.find((c) => c.changeKind === "removed");
            const isBlocked = changes.some((c) => !c.applied);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
                <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                  {reviewingShift.shift.local} · {reviewingShift.shift.role}
                  {reviewingShift.shift.scheduleStartMinutes !== null && reviewingShift.shift.scheduleEndMinutes !== null && (
                    <>
                      {" · "}
                      {formatMinutesAsTime(reviewingShift.shift.scheduleStartMinutes)} –{" "}
                      {formatMinutesAsTime(reviewingShift.shift.scheduleEndMinutes)}
                    </>
                  )}
                </p>

                {removedChange && (
                  <div className="warning-box">
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
                      <Trash2 size={14} style={{ flexShrink: 0 }} />
                      {removedChange.message}
                    </div>
                    {removedChange.applied ? (
                      <span className="badge neutral" style={{ marginTop: "0.5rem", display: "inline-flex" }}>
                        Excluído automaticamente
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        style={{ marginTop: "0.5rem" }}
                        disabled={markingReviewDeleted}
                        onClick={handleMarkReviewDeleted}
                      >
                        {markingReviewDeleted ? "Marcando…" : "Marcar como excluído"}
                      </button>
                    )}
                  </div>
                )}

                {fieldChanges.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>Campos alterados</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      {fieldChanges.map((c, i) => (
                        <div key={i} style={{ fontSize: "0.82rem" }}>
                          <div className="muted" style={{ fontSize: "0.75rem" }}>
                            {diffFieldLabel(c.fieldName, c.columnLetter)}
                          </div>
                          <span
                            style={{
                              background: "var(--danger-soft)",
                              color: "var(--danger)",
                              textDecoration: "line-through",
                              padding: "0.05rem 0.35rem",
                              borderRadius: 4,
                            }}
                          >
                            {c.oldValue || "(vazio)"}
                          </span>
                          {" → "}
                          <span
                            style={{
                              background: "var(--success-soft)",
                              color: "var(--success)",
                              padding: "0.05rem 0.35rem",
                              borderRadius: 4,
                            }}
                          >
                            {c.newValue || "(vazio)"}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="muted" style={{ fontSize: "0.72rem", marginTop: "0.6rem" }}>
                      Verificado em {formatDateTimeAbbrevYY(fieldChanges[0].checkedAt)}
                    </p>
                  </div>
                )}

                {acceptError && <div className="error-box">{acceptError}</div>}

                {isBlocked && fieldChanges.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAcceptChange}
                    disabled={accepting}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {accepting ? "Aplicando..." : "Aceitar e atualizar"}
                  </button>
                )}
                {!isBlocked && changes.length > 0 && (
                  <span className="badge neutral" style={{ alignSelf: "flex-start" }}>
                    Já aplicado automaticamente
                  </span>
                )}
              </div>
            );
          })()}
      </Drawer>

      <PaymentsFiltersDrawer
        open={filtersDrawerOpen}
        onClose={() => setFiltersDrawerOpen(false)}
        value={{
          employeeIds: selectedEmployeeIds,
          companyIds: selectedCompanyIds,
          clientIds: selectedClientIds,
          roleIds: selectedRoleIds,
          locals: selectedLocals,
          periodStart,
          periodEnd,
          statuses: selectedStatuses,
          shiftPeriods: selectedShiftPeriods,
          scheduleTimeFilter,
          grouped,
        }}
        onApply={handleApplyFilters}
        companies={companies}
        clients={clients}
        roles={roles}
        locals={locals}
      />

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
