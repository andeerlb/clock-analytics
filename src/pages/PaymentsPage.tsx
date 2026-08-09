import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FileDown,
  FileSpreadsheet,
  FolderOpen,
  History,
  Info,
  Layers,
  Moon,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import AnchoredPopover from "../components/AnchoredPopover";
import Avatar from "../components/Avatar";
import ConfirmModal from "../components/ConfirmModal";
import ConfirmPaymentModal from "../components/ConfirmPaymentModal";
import DatePicker from "../components/DatePicker";
import DateRangePicker from "../components/DateRangePicker";
import ExtraColumnsModal from "../components/ExtraColumnsModal";
import MultiSelectDropdown, { type MultiSelectOption } from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import ScheduleTimeFilterDropdown from "../components/ScheduleTimeFilterDropdown";
import ShiftHistoryModal from "../components/ShiftHistoryModal";
import { PAYMENTS_PAGE_SIZE_OPTIONS, usePaymentsFilters } from "../contexts/FiltersContext";
import { revealInFileManager } from "../lib/api";
import {
  deletePaymentShift,
  editPaymentShift,
  getCompany,
  getPaymentVisibleColumns,
  listClients,
  listCompanies,
  listPaymentExportTemplates,
  listPaymentShiftSummaries,
  listPaymentShiftsFlat,
  listPaymentShiftsForGroup,
  markPaymentShiftPaid,
  revertPaymentShiftToPending,
  setPaymentVisibleColumns,
  type ClientRow,
  type CompanyDetail,
  type CompanyRow,
  type ListPaymentShiftSummariesQuery,
  type PaymentShiftFlatRow,
  type PaymentShiftGroupRow,
} from "../lib/db";
import {
  centsMaskToAmount,
  formatCentsMask,
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
import { generatePaymentsReportPdf, type PaymentsReportResult } from "../lib/paymentsReport";
import type {
  PaymentExportTemplateListRow,
  PaymentShiftRow,
  PaymentShiftStatus,
  PaymentShiftSummaryRow,
  ShiftPeriod,
} from "../lib/types";

const STATUS_OPTIONS: MultiSelectOption<PaymentShiftStatus>[] = [
  { id: "pendente", label: "Pendente" },
  { id: "erro", label: "Erro" },
  { id: "pago", label: "Pago" },
];

/** A summary row matches once at least one of its shifts falls in a checked bucket — same "at least one" semantics as Status, and the same SQL-side HAVING pattern (see `shiftPeriodSql` in db.ts). */
const SHIFT_PERIOD_OPTIONS: MultiSelectOption<ShiftPeriod>[] = [
  { id: "diurno", label: "Diurno" },
  { id: "noturno", label: "Noturno" },
];

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  pendente: { className: "badge warn", label: "Pendente", icon: Clock3 },
  erro: { className: "badge file-error", label: "Erro", icon: AlertCircle },
  pago: { className: "badge ok", label: "Pago", icon: CheckCircle2 },
};

/** Every column a turno row can show — `identityOnly` ones only ever appear in the flat (desagrupado) table, since a grouped row's expanded turno table already shows its colaborador/cliente/empresa once, in the summary header above it. */
const FLAT_COLUMNS: MultiSelectOption<string>[] = [
  { id: "colaborador", label: "Colaborador" },
  { id: "cliente", label: "Cliente" },
  { id: "empresa", label: "Empresa" },
  { id: "data", label: "Data" },
  { id: "local", label: "Local" },
  { id: "funcao", label: "Função" },
  { id: "horario", label: "Horário" },
  { id: "horas", label: "H/trab." },
  { id: "valor", label: "Valor" },
  { id: "status", label: "Status" },
  { id: "importado", label: "Importado em" },
  { id: "extras", label: "Extras" },
];
const ALL_COLUMN_IDS = FLAT_COLUMNS.map((c) => c.id);
/** What a fresh install (no saved column preference yet) shows — everything except "Importado em", which is metadata most people don't need visible by default. */
const DEFAULT_VISIBLE_COLUMN_IDS = ALL_COLUMN_IDS.filter((id) => id !== "importado");
const IDENTITY_COLUMN_IDS = new Set(["colaborador", "cliente", "empresa"]);
const TURNO_COLUMNS = FLAT_COLUMNS.filter((c) => !IDENTITY_COLUMN_IDS.has(c.id));

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
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
      <span className="muted">R$</span>
      <input
        autoFocus
        type="text"
        inputMode="numeric"
        value={digits === "" ? "" : formatCentsMask(digits)}
        placeholder="Automático"
        onChange={(e) => {
          setDigits(e.target.value.replace(/\D/g, ""));
          setTouched(true);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        style={{ width: "6rem" }}
      />
    </span>
  );
}

const SCHEDULE_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const SCHEDULE_MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const SCHEDULE_POPOVER_WIDTH = 230;

/** One "HH" + "MM" pair of selects — Início and Fim are two of these side by side inside `EditableSchedule`'s popover. Explicit widths override the global `select` rule's generous padding (built for full-width filter dropdowns, not a 2-digit value) — without them, two "HH : MM" pairs don't fit the popover and visually run into each other. */
function TimeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [h, m] = value.split(":");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
      <select value={h} onChange={(e) => onChange(`${e.target.value}:${m}`)} aria-label="Hora" style={{ width: "4.2rem" }}>
        {SCHEDULE_HOURS.map((hh) => (
          <option key={hh} value={hh}>
            {hh}
          </option>
        ))}
      </select>
      <span className="muted">:</span>
      <select value={m} onChange={(e) => onChange(`${h}:${e.target.value}`)} aria-label="Minuto" style={{ width: "4.2rem" }}>
        {SCHEDULE_MINUTES.map((mm) => (
          <option key={mm} value={mm}>
            {mm}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Horário's own editable cell — one trigger opening one popover with
 * Início and Fim together (hora/minuto dropdowns, always 24h), the same
 * "connected" idea as `DateRangePicker`'s single popover with two linked
 * months, instead of two separate native `<input type="time">` fields each
 * rendering the OS's own (often 12h AM/PM) time control.
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
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div>
            <div className="muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
              Início
            </div>
            <TimeSelect value={draftStart} onChange={setDraftStart} />
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
              Fim
            </div>
            <TimeSelect value={draftEnd} onChange={setDraftEnd} />
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
 * One turno's cells (Data through Ações) — shared between the flat table
 * (which prepends Colaborador/Cliente/Empresa via `identity`) and a grouped
 * row's expanded turno table (no `identity`, since that's already the
 * group's own header). `visibleColumns` is an app-wide setting (see
 * `PaymentsPage`), not per-row state, but lives here since this is the only
 * place it changes what actually renders. Data/Local/Função/Horário/Valor
 * are always inline-editable for a `pendente`/`erro` shift — there's no
 * separate "modo edição" toggle to gate it.
 */
function ShiftRow({
  shift: s,
  companyId,
  groupRef,
  identity,
  company,
  visibleColumns,
  onCommitField,
  onPay,
  onRevert,
  onDelete,
  onViewHistory,
  onViewExtra,
}: {
  shift: PaymentShiftRow & { shiftPeriod: ShiftPeriod | null };
  companyId: number;
  groupRef: GroupRef;
  identity?: { employeeName: string; companyName: string; clientName: string };
  company: CompanyDetail | null;
  visibleColumns: Set<string>;
  onCommitField: (shift: PaymentShiftRow, groupRef: GroupRef, patch: ShiftFieldPatch) => void;
  onPay: (shift: PaymentShiftRow, companyId: number, groupRef: GroupRef) => void;
  onRevert: (shift: PaymentShiftRow, groupRef: GroupRef) => void;
  onDelete: (shift: PaymentShiftRow, groupRef: GroupRef) => void;
  onViewHistory: (shiftId: number, companyId: number) => void;
  onViewExtra: (data: Record<string, string>) => void;
}) {
  const badge = STATUS_BADGE[s.status];
  const BadgeIcon = badge.icon;
  const hasSchedule = s.scheduleStartMinutes !== null && s.scheduleEndMinutes !== null;
  const duration = hasSchedule ? shiftDurationMinutes(s.scheduleStartMinutes!, s.scheduleEndMinutes!) : null;
  const value =
    s.amount !== null
      ? s.amount
      : company && duration !== null
        ? resolvePaymentValue(company.valueRules, duration, {
            workDate: s.workDate,
            local: s.local,
            role: s.role,
            scheduleStartMinutes: s.scheduleStartMinutes,
            scheduleEndMinutes: s.scheduleEndMinutes,
          })
        : null;
  const canEdit = s.status === "pendente" || s.status === "erro";
  const col = (id: string) => visibleColumns.has(id);
  const patch = (p: ShiftFieldPatch) => onCommitField(s, groupRef, p);

  return (
    <tr>
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
                <>
                  {formatMinutesAsTime(s.scheduleStartMinutes!)} – {formatMinutesAsTime(s.scheduleEndMinutes!)}
                  {s.shiftPeriod && (
                    <span className={s.shiftPeriod === "noturno" ? "badge info" : "badge neutral"} style={{ marginLeft: "0.5rem" }}>
                      {s.shiftPeriod === "noturno" ? <Moon size={12} /> : <Sun size={12} />}
                      {s.shiftPeriod === "noturno" ? "Noturno" : "Diurno"}
                    </span>
                  )}
                </>
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
          <span className={badge.className}>
            <BadgeIcon size={13} />
            {badge.label}
          </span>
          {s.editedManually && (
            <span
              className="badge info"
              style={{ marginLeft: "0.4rem" }}
              title="Atualizado manualmente — uma reimportação não sobrescreve este turno enquanto 'Manter registros atualizados manualmente' estiver ativado (Configurações → Zona de risco → Pagamentos)."
            >
              <ShieldCheck size={12} />
            </span>
          )}
          {s.status === "erro" && s.errorMessage && (
            <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.25rem" }}>
              {s.errorMessage}
            </div>
          )}
        </td>
      )}
      {col("importado") && (
        <td className="muted" style={{ fontSize: "0.8rem" }}>
          {formatDateTimeAbbrevYY(s.importedAt)}
        </td>
      )}
      {col("extras") && (
        <td>
          {s.extraData && Object.keys(s.extraData).length > 0 ? (
            <button
              type="button"
              className="badge neutral"
              style={{ border: "none", cursor: "pointer" }}
              onClick={() => onViewExtra(s.extraData!)}
              title="Ver colunas não mapeadas lidas do arquivo"
            >
              <Info size={12} />
              {Object.keys(s.extraData).length}
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      )}
      <td>
        {(s.status === "pendente" || s.status === "erro") && (
          <button type="button" className="secondary" onClick={() => onPay(s, companyId, groupRef)}>
            Fazer pagamento
          </button>
        )}
        {s.status === "pago" && (
          <button
            type="button"
            className="ghost"
            style={{ padding: "0.4rem" }}
            onClick={() => onRevert(s, groupRef)}
            title="Voltar este turno para pendente"
          >
            <RotateCcw size={13} />
          </button>
        )}
        {s.previousShiftId !== null && (
          <button
            type="button"
            className="ghost"
            style={{ padding: "0.4rem" }}
            onClick={() => onViewHistory(s.previousShiftId!, companyId)}
            title="Ver histórico de status deste turno"
          >
            <History size={13} />
          </button>
        )}
        <button
          type="button"
          className="ghost"
          style={{ padding: "0.4rem" }}
          onClick={() => onDelete(s, groupRef)}
          title="Remover este turno e todo o seu histórico"
        >
          <Trash2 size={13} />
        </button>
      </td>
    </tr>
  );
}

export default function PaymentsPage() {
  const navigate = useNavigate();
  const {
    search,
    setSearch,
    selectedCompanyIds,
    setSelectedCompanyIds,
    selectedClientIds,
    setSelectedClientIds,
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

  const [summaries, setSummaries] = useState<PaymentShiftSummaryRow[]>([]);
  const [summariesTotal, setSummariesTotal] = useState(0);
  const [flatRows, setFlatRows] = useState<PaymentShiftFlatRow[]>([]);
  const [flatTotal, setFlatTotal] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
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

  const [companiesById, setCompaniesById] = useState<Map<number, CompanyDetail>>(new Map());
  const fetchedCompanyIds = useRef<Set<number>>(new Set());

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
  const [viewingHistory, setViewingHistory] = useState<{ shiftId: number; companyId: number } | null>(null);
  const [viewingExtraData, setViewingExtraData] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    Promise.all([listCompanies(), listClients()]).then(([companyRows, clientRows]) => {
      setCompanies(companyRows);
      setClients(clientRows);
    });
    getPaymentVisibleColumns().then((cols) => {
      if (cols) setVisibleColumns(new Set(cols));
    });
  }, []);

  useEffect(() => {
    listPaymentExportTemplates().then(setExportTemplates);
  }, []);

  function ensureCompaniesLoaded(ids: number[]) {
    const toFetch = Array.from(new Set(ids)).filter((id) => !fetchedCompanyIds.current.has(id));
    if (toFetch.length === 0) return;
    toFetch.forEach((id) => fetchedCompanyIds.current.add(id));
    Promise.all(toFetch.map((id) => getCompany(id))).then((fetched) => {
      setCompaniesById((prev) => {
        const next = new Map(prev);
        fetched.forEach((c) => next.set(c.id, c));
        return next;
      });
    });
  }

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
      search,
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      statuses: Array.from(selectedStatuses),
      shiftPeriods: Array.from(selectedShiftPeriods),
      scheduleTimeFilter,
    };
  }

  async function refetchFlat() {
    const { rows, total } = await listPaymentShiftsFlat({ ...baseQuery(), page, pageSize });
    setFlatRows(rows);
    setFlatTotal(total);
    ensureCompaniesLoaded(rows.map((r) => r.companyId));
  }

  async function refetchSummaries() {
    const { rows, total } = await listPaymentShiftSummaries({ ...baseQuery(), page, pageSize });
    setSummaries(rows);
    setSummariesTotal(total);
  }

  async function refetchGroup(employeeId: number, competencia: string) {
    const rows = await listPaymentShiftsForGroup(employeeId, competencia, baseQuery());
    setGroupRows((prev) => new Map(prev).set(groupKey(employeeId, competencia), rows));
  }

  // The table itself — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedKeys(new Set());
    setGroupRows(new Map());
    const run = grouped ? refetchSummaries() : refetchFlat();
    run.finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    grouped,
    search,
    selectedCompanyIds,
    selectedClientIds,
    periodStart,
    periodEnd,
    selectedStatuses,
    selectedShiftPeriods,
    scheduleTimeFilter,
    page,
    pageSize,
  ]);

  // A previously generated PDF reflects a specific set of filters — changing
  // any of them means the next "Gerar PDF" would produce different rows, so
  // the stale "PDF gerado com sucesso" banner (and any leftover error) no
  // longer applies. Deliberately excludes `grouped`/`page`/`pageSize`: those
  // change how the table is displayed, not which rows would end up in a
  // report.
  useEffect(() => {
    setGeneratedReport(null);
    setPdfError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedCompanyIds, selectedClientIds, periodStart, periodEnd, selectedStatuses, selectedShiftPeriods, scheduleTimeFilter]);

  async function afterMutation(groupRef: GroupRef) {
    if (groupRef === null) {
      await refetchFlat();
    } else {
      await Promise.all([refetchSummaries(), refetchGroup(groupRef.employeeId, groupRef.competencia)]);
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
          ensureCompaniesLoaded([s.companyId]);
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
      await markPaymentShiftPaid(payingShift.shift.id, amount);
      await afterMutation(payingShift.groupRef);
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
      await revertPaymentShiftToPending(revertingShift.shift.id);
      await afterMutation(revertingShift.groupRef);
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
    const company = companiesById.get(companyId);
    if (!company || s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
    const duration = shiftDurationMinutes(s.scheduleStartMinutes, s.scheduleEndMinutes);
    return resolvePaymentValue(company.valueRules, duration, {
      workDate: s.workDate,
      local: s.local,
      role: s.role,
      scheduleStartMinutes: s.scheduleStartMinutes,
      scheduleEndMinutes: s.scheduleEndMinutes,
    });
  }

  const clientOptions = useMemo(() => {
    const scoped =
      selectedCompanyIds.size > 0
        ? clients.filter((c) => selectedCompanyIds.has(String(c.companyId)))
        : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, selectedCompanyIds]);

  function toggleCompany(id: string) {
    const next = new Set(selectedCompanyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedCompanyIds(next);
    setSelectedClientIds(new Set());
    setPage(0);
  }
  function toggleClient(id: string) {
    const next = new Set(selectedClientIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedClientIds(next);
    setPage(0);
  }
  function toggleStatus(id: PaymentShiftStatus) {
    const next = new Set(selectedStatuses);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedStatuses(next);
    setPage(0);
  }
  function toggleShiftPeriod(id: ShiftPeriod) {
    const next = new Set(selectedShiftPeriods);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedShiftPeriods(next);
    setPage(0);
  }

  /** Every turno matching the current filters, not just the visible page — see `generatePaymentsReportPdf`. */
  async function handleGeneratePdf() {
    setPdfError(null);
    setGeneratedReport(null);
    setGeneratingPdf(true);
    try {
      const result = await generatePaymentsReportPdf(baseQuery());
      if (result.rowCount === 0) {
        setPdfError("Nenhum turno para os filtros selecionados.");
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
        setExportError("Nenhum turno para os filtros selecionados.");
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
    search.trim() ||
      selectedCompanyIds.size > 0 ||
      selectedClientIds.size > 0 ||
      periodStart ||
      periodEnd ||
      selectedStatuses.size < STATUS_OPTIONS.length ||
      selectedShiftPeriods.size < SHIFT_PERIOD_OPTIONS.length ||
      scheduleTimeFilter !== null,
  );
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
      {inlineEditError && <div className="error-box">{inlineEditError}</div>}

      <div className="card">
        <div className="field-row" style={{ marginBottom: 0, alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <label htmlFor="payments-search">Colaborador</label>
            <div style={{ position: "relative" }}>
              <Search
                size={14}
                style={{ position: "absolute", left: "0.65rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
              />
              <input
                id="payments-search"
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="Buscar por nome..."
                style={{ width: "100%", paddingLeft: "2rem" }}
              />
            </div>
          </div>
          <div className="field">
            <label>Empresa</label>
            <MultiSelectDropdown
              options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
              selected={selectedCompanyIds}
              onToggle={toggleCompany}
              onSelectAll={() => {
                setSelectedCompanyIds(new Set(companies.map((c) => String(c.id))));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedCompanyIds(new Set());
                setPage(0);
              }}
              icon={Building2}
              allLabel="Todas as empresas"
              noneLabel="Nenhuma empresa"
            />
          </div>
          <div className="field">
            <label>Cliente</label>
            <MultiSelectDropdown
              options={clientOptions.map((c) => ({ id: String(c.id), label: c.name }))}
              selected={selectedClientIds}
              onToggle={toggleClient}
              onSelectAll={() => {
                setSelectedClientIds(new Set(clientOptions.map((c) => String(c.id))));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedClientIds(new Set());
                setPage(0);
              }}
              icon={Users}
              allLabel="Todos os clientes"
              noneLabel="Nenhum cliente"
            />
          </div>
          <div className="field">
            <label>Período</label>
            <DateRangePicker
              startValue={periodStart}
              endValue={periodEnd}
              onChange={(start, end) => {
                setPeriod(start, end);
                setPage(0);
              }}
            />
          </div>
          <div className="field">
            <label>Horário</label>
            <ScheduleTimeFilterDropdown value={scheduleTimeFilter} onChange={setScheduleTimeFilter} />
          </div>
          <div className="field">
            <label>Diurno/Noturno</label>
            <MultiSelectDropdown
              options={SHIFT_PERIOD_OPTIONS}
              selected={selectedShiftPeriods}
              onToggle={toggleShiftPeriod}
              onSelectAll={() => {
                setSelectedShiftPeriods(new Set(SHIFT_PERIOD_OPTIONS.map((o) => o.id)));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedShiftPeriods(new Set());
                setPage(0);
              }}
              icon={Moon}
              allLabel="Diurno e noturno"
              noneLabel="Nenhum"
            />
          </div>
          <div className="field">
            <label>Status</label>
            <MultiSelectDropdown
              options={STATUS_OPTIONS}
              selected={selectedStatuses}
              onToggle={toggleStatus}
              onSelectAll={() => {
                setSelectedStatuses(new Set(STATUS_OPTIONS.map((o) => o.id)));
                setPage(0);
              }}
              onSelectNone={() => {
                setSelectedStatuses(new Set());
                setPage(0);
              }}
              allLabel="Todos os status"
              noneLabel="Nenhum status"
            />
          </div>
        </div>

        <div className="field-row" style={{ marginTop: "1rem", marginBottom: 0, alignItems: "center" }}>
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
              className="ghost"
              style={{ padding: "0.3rem" }}
              onClick={() => navigate("/payments/export-templates")}
              aria-label="Gerenciar templates de exportação"
              title="Gerenciar templates de exportação — criar, editar ou excluir"
            >
              <Settings2 size={15} />
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
            <button type="button" onClick={handleGeneratePdf} disabled={generatingPdf} title="Considera os filtros acima">
              <FileDown size={15} style={{ marginRight: "0.4rem" }} />
              {generatingPdf ? "Gerando..." : "Gerar PDF"}
            </button>
          </div>
        </div>

        {exportError && (
          <div className="error-box" style={{ marginTop: "1rem", marginBottom: 0 }}>
            {exportError}
          </div>
        )}

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
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => {
              setGrouped(e.target.checked);
              setPage(0);
            }}
          />
          <Layers size={14} />
          Agrupar por colaborador
        </label>
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
        {loading && (grouped ? summaries.length === 0 : flatRows.length === 0) && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Carregando...
          </p>
        )}
        {!loading && total === 0 && !hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum pagamento importado ainda.
          </p>
        )}
        {!loading && total === 0 && hasFilters && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum resultado para os filtros selecionados.
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
                                          <th>Ações</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {rows.map((r) => (
                                          <ShiftRow
                                            key={r.id}
                                            shift={r}
                                            companyId={s.companyId}
                                            groupRef={{ employeeId: s.employeeId, competencia: s.competencia }}
                                            company={companiesById.get(s.companyId) ?? null}
                                            visibleColumns={visibleColumns}
                                            onCommitField={commitField}
                                            onPay={(shift, companyId, groupRef) => setPayingShift({ shift, companyId, groupRef })}
                                            onRevert={(shift, groupRef) => setRevertingShift({ shift, groupRef })}
                                            onDelete={(shift, groupRef) => setDeletingShift({ shift, groupRef })}
                                            onViewHistory={(shiftId, companyId) => setViewingHistory({ shiftId, companyId })}
                                            onViewExtra={setViewingExtraData}
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
                    <th>Ações</th>
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
                      company={companiesById.get(r.companyId) ?? null}
                      visibleColumns={visibleColumns}
                      onCommitField={commitField}
                      onPay={(shift, companyId, groupRef) => setPayingShift({ shift, companyId, groupRef })}
                      onRevert={(shift, groupRef) => setRevertingShift({ shift, groupRef })}
                      onDelete={(shift, groupRef) => setDeletingShift({ shift, groupRef })}
                      onViewHistory={(shiftId, companyId) => setViewingHistory({ shiftId, companyId })}
                      onViewExtra={setViewingExtraData}
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

      <ShiftHistoryModal
        shiftId={viewingHistory?.shiftId ?? null}
        company={viewingHistory ? companiesById.get(viewingHistory.companyId) ?? null : null}
        onClose={() => setViewingHistory(null)}
      />
      <ExtraColumnsModal data={viewingExtraData} onClose={() => setViewingExtraData(null)} />

      <PdfViewerModal
        path={viewerPath}
        title={generatedReport?.title}
        allowDownload={false}
        onClose={() => setViewerPath(null)}
      />
    </div>
  );
}
