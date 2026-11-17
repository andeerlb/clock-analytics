import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Eye,
  FolderOpen,
  Info,
  List,
  ListFilter,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAiAssistant } from "../components/AiAssistant";
import Avatar from "../components/Avatar";
import Drawer from "../components/Drawer";
import ExtraColumnsDrawer from "../components/ExtraColumnsDrawer";
import ColumnPicker from "../components/ColumnPicker";
import Pagination from "../components/Pagination";
import PageHeader from "../components/PageHeader";
import PaymentExportDrawer from "../components/PaymentExportDrawer";
import PaymentsExportMenu from "../components/PaymentsExportMenu";
import PaymentsFiltersPanel, { PaymentsFilterChips, usePaymentsActiveFilterCount } from "../components/PaymentsFiltersPanel";
import PdfViewerModal from "../components/PdfViewerModal";
import PillButton from "../components/PillButton";
import ShiftPanel, { type LastPayment, type ShiftEditFields, type ShiftPanelTab } from "../components/ShiftPanel";
import TableScroll from "../components/TableScroll";
import { PAYMENT_SHIFT_STATUSES, PAYMENTS_PAGE_SIZE_OPTIONS, SHIFT_PERIODS, usePaymentsFilters } from "../contexts/FiltersContext";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { openReconciliationWindow, revealInFileManager } from "../lib/api";
import {
  deletePaymentShift,
  editPaymentShift,
  getEffectivePaymentRules,
  getPaymentShift,
  getPaymentVisibleColumns,
  listClients,
  listCompanies,
  listDistinctPaymentShiftLocals,
  listLatestFieldDiffsForShifts,
  listPaymentExportTemplates,
  listPaymentPdfTemplates,
  listPaymentShiftSummaries,
  listPaymentShiftsFlat,
  listPaymentShiftsForGroup,
  listRolesGlobal,
  countPaymentShiftsByStatus,
  markPaymentShiftPaid,
  PAYMENT_SHIFTS_CHANGED_EVENT,
  revertPaymentShiftToPending,
  setPaymentVisibleColumns,
  type ClientRow,
  type CompanyRow,
  type EffectivePaymentRules,
  type EmployeePixKeyRow,
  type ListPaymentShiftSummariesQuery,
  type PaymentShiftFlatRow,
  type PaymentShiftGroupRow,
  type RoleRow,
  type ShiftFieldDiffRow,
} from "../lib/db";
import {
  diffFieldLabel,
  formatCurrencyBRL,
  formatDate,
  formatDateAbbrevYY,
  formatDateTimeAbbrevYY,
  formatMinutesAsTime,
  scheduleDurationMinutes,
  shiftValue,
} from "../lib/format";
import { generatePaymentsExportXlsx, type PaymentExportResult } from "../lib/paymentExport";
import { withMissingValueShiftIds } from "../lib/paymentShiftValue";
import { orAll } from "../lib/filterSets";
import { generatePaymentsPdfExport, type PaymentPdfExportResult } from "../lib/paymentPdfExport";
import { ALL_COLUMN_IDS, ALWAYS_VISIBLE_COLUMN_ID, FLAT_COLUMNS, PAYMENT_PICKER_COLUMNS } from "../lib/paymentColumns";
import { generatePaymentsReportPdf, generatePaymentsShiftReportPdf, type PaymentsReportResult } from "../lib/paymentsReport";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import type {
  PaymentExportTemplateListRow,
  PaymentPdfTemplateListRow,
  PaymentShiftRow,
  PaymentShiftStatus,
  PaymentShiftSummaryRow,
  ShiftPeriod,
} from "../lib/types";

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string }> = {
  pendente: { className: "badge overwrite", label: "Pendente" },
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
 * header). Read-only: clicking the row opens the turno's side panel
 * (`ShiftPanel`), where it's paid, edited, and everything else.
 */
function ShiftRow({
  shift: s,
  identity,
  rules,
  visibleColumns,
  changes,
  onOpen,
  onViewExtra,
  active,
}: {
  shift: PaymentShiftRow & { shiftPeriod: ShiftPeriod | null };
  identity?: { employeeName: string; companyName: string; clientName: string };
  rules: EffectivePaymentRules | null;
  visibleColumns: Set<string>;
  /** What the last automatic verification found different for this shift (if anything) — see `listLatestFieldDiffsForShifts`. */
  changes: ShiftFieldDiffRow[];
  onOpen: () => void;
  onViewExtra: (data: Record<string, string>, sourceUrl: string | null) => void;
  /** This row's turno is the one open in the panel (or was, last) — kept highlighted. */
  active: boolean;
}) {
  const badge = STATUS_BADGE[s.status];
  const duration = scheduleDurationMinutes(s);
  const hasSchedule = duration !== null;
  const value = shiftValue(s, rules?.valueRules ?? null);
  // A pending change (found by the automatic verification, not yet
  // reviewed) blocks paying/editing until it's reviewed in the panel; one
  // already applied by auto-apply is only informational.
  const isBlocked = changes.some((c) => !c.applied);
  const hasApplied = changes.some((c) => c.applied);
  const col = (id: string) => visibleColumns.has(id);

  return (
    <tr
      className={active ? "row-active payments-row-clickable" : "payments-row-clickable"}
      onClick={onOpen}
      style={isBlocked ? { background: "var(--warning-soft)" } : hasApplied ? { background: "var(--accent-soft)" } : undefined}
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
          {formatDateAbbrevYY(s.workDate)}
        </td>
      )}
      {col("local") && (
        <td>
          {s.local}
        </td>
      )}
      {col("funcao") && (
        <td>
          {s.role}
        </td>
      )}
      {col("horario") && (
        <td>
          {hasSchedule ? (
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
              )}
        </td>
      )}
      {col("horas") && <td>{duration !== null ? formatMinutesAsTime(duration) : "—"}</td>}
      {col("valor") && (
        <td>
          {value !== null ? formatCurrencyBRL(value) : "—"}
        </td>
      )}
      {col("status") && (
        <td>
          <span className={badge.className} title={s.status === "erro" ? s.errorMessage ?? undefined : undefined}>
            {badge.label}
          </span>
          {s.status === "erro" && s.errorMessage && (
            <span className="payments-error-reason" title={s.errorMessage}>
              {s.errorMessage}
            </span>
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
          {(() => {
            const extra = displayExtraData(s);
            if (!s.editedManually && !extra) return <span className="muted">—</span>;
            return (
              <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem" }}>
                {extra && (
                  <span onClick={(e) => e.stopPropagation()}>
                    <PillButton onClick={() => onViewExtra(extra, s.sourceUrl)} title="Ver colunas não mapeadas lidas do arquivo">
                      <Info size={12} />
                      {Object.keys(extra).length}
                    </PillButton>
                  </span>
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

const FILTERS_OPEN_KEY = "payments-filters-open";

function readFiltersOpen(): boolean {
  try {
    return localStorage.getItem(FILTERS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
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
    selectedCompanyIds,
    selectedClientIds,
    selectedRoleIds,
    selectedLocals,
    periodStart,
    periodEnd,
    selectedStatuses,
    setSelectedStatuses,
    selectedShiftPeriods,
    scheduleTimeFilter,
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
  const [viewerPath, setViewerPath] = useState<string | null>(null);

  const [generatingLegacyPdf, setGeneratingLegacyPdf] = useState(false);
  const [legacyPdfError, setLegacyPdfError] = useState<string | null>(null);
  const [generatedLegacyPdf, setGeneratedLegacyPdf] = useState<PaymentsReportResult | null>(null);
  const [revealingLegacyPdf, setRevealingLegacyPdf] = useState(false);
  const [generatingShiftPdf, setGeneratingShiftPdf] = useState(false);
  const [shiftPdfError, setShiftPdfError] = useState<string | null>(null);
  const [generatedShiftPdf, setGeneratedShiftPdf] = useState<PaymentsReportResult | null>(null);
  const [revealingShiftPdf, setRevealingShiftPdf] = useState(false);

  const [exportTemplates, setExportTemplates] = useState<PaymentExportTemplateListRow[]>([]);
  const [generatingExport, setGeneratingExport] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  /** PDF-template export — same pattern as the Excel one above, separate state so one failing doesn't clear the other's success message. */
  const [pdfTemplates, setPdfTemplates] = useState<PaymentPdfTemplateListRow[]>([]);
  const [selectedPdfTemplateId, setSelectedPdfTemplateId] = useState("");
  const [generatingPdfExport, setGeneratingPdfExport] = useState(false);
  const [pdfExportError, setPdfExportError] = useState<string | null>(null);
  const [generatedPdfExport, setGeneratedPdfExport] = useState<PaymentPdfExportResult | null>(null);
  const [revealingPdfExport, setRevealingPdfExport] = useState(false);

  /** The single "Exportar" drawer — format (Excel/PDF) and template are picked in there, selection state kept here so it survives reopening. */
  const [exportDrawerOpen, setExportDrawerOpen] = useState(false);
  const [revealingExport, setRevealingExport] = useState(false);
  const [generatedExport, setGeneratedExport] = useState<PaymentExportResult | null>(null);

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_COLUMN_IDS));

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [groupRows, setGroupRows] = useState<Map<string, PaymentShiftGroupRow[]>>(new Map());
  const [loadingGroups, setLoadingGroups] = useState<Set<string>>(new Set());

  const [rulesByPair, setRulesByPair] = useState<Map<string, EffectivePaymentRules>>(new Map());
  const fetchedRulePairKeys = useRef<Set<string>>(new Set());

  // Each table/group load takes a ticket, and only the newest ticket's
  // response is applied: a filter or page change (or the cross-window
  // refetch) can start a second load before the first one returns, and
  // without this a slower, older response landing last would overwrite the
  // newer one.
  const tableRequest = useRef(0);
  const groupRequests = useRef<Map<string, number>>(new Map());
  function nextGroupRequest(key: string): number {
    const ticket = (groupRequests.current.get(key) ?? 0) + 1;
    groupRequests.current.set(key, ticket);
    return ticket;
  }

  const [shiftDiffs, setShiftDiffs] = useState<Map<number, ShiftFieldDiffRow[]>>(new Map());

  // The turno open in the docked `ShiftPanel` — clicking a row opens it;
  // the panel's arrows move it to the row above/below on the same tab.
  const [openShift, setOpenShift] = useState<{ shift: PaymentShiftRow; companyId: number; groupRef: GroupRef } | null>(null);
  const [panelTab, setPanelTab] = useState<ShiftPanelTab>("pay");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastPayment, setLastPayment] = useState<LastPayment | null>(null);
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

  // Which row stays highlighted — the turno open in the panel, kept lit
  // after closing it so you don't lose track of which row it was.
  const [activeShiftId, setActiveShiftId] = useState<number | null>(null);
  const { askAboutShift } = useAiAssistant();
  function handleInvestigate(shift: PaymentShiftRow) {
    askAboutShift({ shiftId: shift.id, employeeId: shift.employeeId, employeeName: shift.employeeName, workDate: shift.workDate });
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
      // Colaborador is always shown now, even if an older saved choice turned it off.
      if (cols) setVisibleColumns(new Set([ALWAYS_VISIBLE_COLUMN_ID, ...cols]));
    });
  }, []);

  useEffect(() => {
    listPaymentExportTemplates().then(setExportTemplates);
  }, []);

  useEffect(() => {
    listPaymentPdfTemplates().then(setPdfTemplates);
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
    )
      .then((fetched) => {
        setRulesByPair((prev) => {
          const next = new Map(prev);
          fetched.forEach(([key, rules]) => next.set(key, rules));
          return next;
        });
      })
      .catch(() => {
        // Forget these pairs so the next load tries again, instead of
        // leaving their Valor blank until the page is reopened.
        toFetch.forEach((_, key) => fetchedRulePairKeys.current.delete(key));
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

  function baseQuery(): Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize"> {
    return {
      employeeIds: Array.from(selectedEmployeeIds, Number),
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      roleIds: Array.from(selectedRoleIds, Number),
      locals: Array.from(selectedLocals),
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      statuses: orAll(selectedStatuses, PAYMENT_SHIFT_STATUSES),
      shiftPeriods: orAll(selectedShiftPeriods, SHIFT_PERIODS),
      scheduleTimeFilter,
      attention,
      analytics,
      analyticsWeekday,
      analyticsTimeBucket,
      analyticsShiftIds,
    };
  }

  /** `baseQuery()` plus, for "turnos sem valor", the ids that are really without a value — see `withMissingValueShiftIds`. What every list and export actually queries with. */
  function tableQuery(): Promise<Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">> {
    return withMissingValueShiftIds(baseQuery());
  }

  async function refetchFlat() {
    const ticket = ++tableRequest.current;
    const { rows, total } = await listPaymentShiftsFlat({ ...(await tableQuery()), page, pageSize });
    if (ticket !== tableRequest.current) return;
    setFlatRows(rows);
    setFlatTotal(total);
    ensureRulesLoaded(rows.map((r) => ({ clientId: r.clientId, companyId: r.companyId })));
    refreshShiftDiffs(rows.map((r) => r.id));
  }

  async function refetchSummaries() {
    const ticket = ++tableRequest.current;
    const { rows, total } = await listPaymentShiftSummaries({ ...(await tableQuery()), page, pageSize });
    if (ticket !== tableRequest.current) return;
    setSummaries(rows);
    setSummariesTotal(total);
  }

  async function refetchGroup(employeeId: number, competencia: string) {
    const key = groupKey(employeeId, competencia);
    const ticket = nextGroupRequest(key);
    const rows = await listPaymentShiftsForGroup(employeeId, competencia, await tableQuery());
    if (ticket !== groupRequests.current.get(key)) return;
    setGroupRows((prev) => new Map(prev).set(key, rows));
    refreshShiftDiffs(rows.map((r) => r.id));
  }

  // The table itself — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    setExpandedKeys(new Set());
    setGroupRows(new Map());
    // Any group load still in flight was for the old filters.
    groupRequests.current = new Map();
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
  refetchTableRef.current = () => {
    // A payment confirmed elsewhere moves a shift between status tabs.
    setStatusCountsTick((t) => t + 1);
    return grouped ? refetchSummaries() : refetchFlat();
  };
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
  // itself) — changing any of them means the next export would produce
  // a different document, so the stale "PDF gerado com sucesso" banner (and
  // any leftover error) no longer applies. Deliberately excludes
  // `page`/`pageSize`: those change how the table is paginated on screen,
  // not which rows (or how they're grouped) end up in a report.
  useEffect(() => {
    setGeneratedLegacyPdf(null);
    setLegacyPdfError(null);
    setGeneratedShiftPdf(null);
    setShiftPdfError(null);
    setGeneratedPdfExport(null);
    setPdfExportError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmployeeIds, selectedCompanyIds, selectedClientIds, selectedRoleIds, periodStart, periodEnd, selectedStatuses, selectedShiftPeriods, scheduleTimeFilter, grouped]);

  // "Fazer pagamento" opened directly by an assistant button (`?pay=<id>`).
  // Only opens the same confirmation as the row's own menu: nothing is paid
  // until the user confirms it. The shift may not be in the current table, so
  // its value rules are loaded here for the suggested amount.
  const payParam = searchParams.get("pay");
  useEffect(() => {
    const shiftId = Number(payParam);
    if (!payParam || !Number.isSafeInteger(shiftId)) return;
    let cancelled = false;
    (async () => {
      try {
        const shift = await getPaymentShift(shiftId);
        if (shift.status === "pago") throw new Error("Este turno já foi pago.");
        const rules = await getEffectivePaymentRules(shift.clientId, shift.companyId);
        if (cancelled) return;
        setRulesByPair((prev) => new Map(prev).set(`${shift.clientId}:${shift.companyId}`, rules));
        setPanelTab("pay");
        openShiftPanel(shift, shift.companyId, grouped ? { employeeId: shift.employeeId, competencia: shift.workDate.slice(0, 7) } : null);
      } catch (e) {
        if (!cancelled) setListError(String(e));
      } finally {
        if (!cancelled) setSearchParams({}, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payParam]);

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
      // Accepting may replace the turno with a new row — the panel's copy
      // would be stale, so close it if it was showing this one.
      closePanelIfShowing(reviewingShift.shift.id);
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
      closePanelIfShowing(reviewingShift.shift.id);
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
      const ticket = nextGroupRequest(key);
      tableQuery()
        .then((query) => listPaymentShiftsForGroup(s.employeeId, s.competencia, query))
        .then((rows) => {
          if (ticket !== groupRequests.current.get(key)) return;
          setGroupRows((prev) => new Map(prev).set(key, rows));
          ensureRulesLoaded([{ clientId: s.clientId, companyId: s.companyId }]);
          refreshShiftDiffs(rows.map((r) => r.id));
        })
        .catch((e) => setListError(String(e instanceof Error ? e.message : e)))
        .finally(() => {
          setLoadingGroups((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        });
    }
  }

  function isPayable(shift: PaymentShiftRow): boolean {
    return (shift.status === "pendente" || shift.status === "erro") && !(shiftDiffs.get(shift.id) ?? []).some((c) => !c.applied);
  }

  function openShiftPanel(shift: PaymentShiftRow, companyId: number, groupRef: GroupRef) {
    setActionError(null);
    setActiveShiftId(shift.id);
    setOpenShift({ shift, companyId, groupRef });
  }

  function closePanelIfShowing(shiftId: number) {
    setOpenShift((prev) => (prev && prev.shift.id === shiftId ? null : prev));
  }

  function closeShiftPanel() {
    setOpenShift(null);
    setActionError(null);
  }

  // Every turno row on screen, in table order — what the panel's arrows
  // walk through. Grouped view: only the rows of expanded groups, since
  // those are the ones visible.
  const panelRows: { shift: PaymentShiftRow; companyId: number; groupRef: GroupRef }[] = grouped
    ? summaries.flatMap((s) =>
        expandedKeys.has(groupKey(s.employeeId, s.competencia))
          ? (groupRows.get(groupKey(s.employeeId, s.competencia)) ?? []).map((r) => ({
              shift: r,
              companyId: s.companyId,
              groupRef: { employeeId: s.employeeId, competencia: s.competencia },
            }))
          : [],
      )
    : flatRows.map((r) => ({ shift: r, companyId: r.companyId, groupRef: null }));
  const foundIndex = openShift ? panelRows.findIndex((r) => r.shift.id === openShift.shift.id) : -1;
  // Where the open turno was last seen in the list. After paying (or any
  // change) it may drop out of a filtered list — the arrows then continue
  // from the spot it left instead of going dead.
  const panelAnchor = useRef(-1);
  if (foundIndex >= 0) panelAnchor.current = foundIndex;
  const prevRow = openShift ? (foundIndex >= 0 ? panelRows[foundIndex - 1] : panelRows[panelAnchor.current - 1]) : undefined;
  const nextRow = openShift ? (foundIndex >= 0 ? panelRows[foundIndex + 1] : panelRows[panelAnchor.current]) : undefined;

  /** After a change appends a new row for the open turno, keep the panel on that new row. */
  async function followNewRow(newShiftId: number) {
    if (!openShift) return;
    const current = openShift;
    await afterMutation(current.groupRef);
    const fresh = await getPaymentShift(newShiftId);
    setActiveShiftId(newShiftId);
    setOpenShift((prev) => (prev && prev.shift.id === current.shift.id ? { ...current, shift: fresh } : prev));
  }

  async function runPanelAction(action: () => Promise<void>) {
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActionBusy(false);
    }
  }

  function handleConfirmPayment(amount: number, pixKey: EmployeePixKeyRow | null) {
    if (!openShift) return;
    const id = openShift.shift.id;
    // "Pagar" always appends a brand-new row instead of touching the open
    // one (see `markPaymentShiftPaid`) — the panel follows it and shows the
    // paid state.
    return runPanelAction(async () => {
      const newShiftId = await markPaymentShiftPaid(id, amount);
      setLastPayment({ shiftId: newShiftId, pixKey });
      await followNewRow(newShiftId);
    });
  }

  function handleConfirmRevert() {
    if (!openShift) return;
    const id = openShift.shift.id;
    return runPanelAction(async () => {
      const newShiftId = await revertPaymentShiftToPending(id);
      setLastPayment(null);
      await followNewRow(newShiftId);
    });
  }

  function handleSaveShift(fields: ShiftEditFields) {
    if (!openShift) return;
    const id = openShift.shift.id;
    return runPanelAction(async () => {
      const newShiftId = await editPaymentShift(id, fields);
      await followNewRow(newShiftId);
    });
  }

  function handleConfirmDelete() {
    if (!openShift) return;
    const current = openShift;
    return runPanelAction(async () => {
      await deletePaymentShift(current.shift.id);
      await afterMutation(current.groupRef);
      setOpenShift(null);
    });
  }

  function shiftValueFor(s: PaymentShiftRow, companyId: number): number | null {
    return shiftValue(s, rulesByPair.get(`${s.clientId}:${companyId}`)?.valueRules ?? null);
  }


  const [filtersOpen, setFiltersOpen] = useState(readFiltersOpen);
  const activeFilterCount = usePaymentsActiveFilterCount() + (attention !== undefined ? 1 : 0) + (analytics !== undefined ? 1 : 0);

  function toggleFilters(open: boolean) {
    setFiltersOpen(open);
    try {
      localStorage.setItem(FILTERS_OPEN_KEY, open ? "1" : "0");
    } catch {
      /* only a convenience */
    }
  }

  /** Any filter change from this page drops a filter that came from Análises (`?attention=`/`?analytics=`), same as applying the old Drawer did. */
  function clearAnalysisFilter() {
    if (searchParams.toString()) setSearchParams({});
  }

  function selectStatusTab(statuses: PaymentShiftStatus[]) {
    clearAnalysisFilter();
    setSelectedStatuses(new Set(statuses));
    setPage(0);
  }

  // Counts for the status tabs and "Conferência": same filters, any status.
  const [statusCounts, setStatusCounts] = useState<Record<PaymentShiftStatus, number> | null>(null);
  const [statusCountsTick, setStatusCountsTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    withMissingValueShiftIds(baseQuery())
      .then((query) => countPaymentShiftsByStatus(query))
      .then((counts) => !cancelled && setStatusCounts(counts))
      .catch(() => !cancelled && setStatusCounts(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedEmployeeIds,
    selectedCompanyIds,
    selectedClientIds,
    selectedRoleIds,
    selectedLocals,
    periodStart,
    periodEnd,
    selectedShiftPeriods,
    scheduleTimeFilter,
    searchParams,
    statusCountsTick,
  ]);

  /** Every turno matching the current filters, not just the visible page — see `generatePaymentsExportXlsx`/`generatePaymentsPdfExport`. */
  async function handleGenerateExport(templateId: number) {
    setExportError(null);
    setGeneratedExport(null);
    setGeneratingExport(true);
    try {
      const result = await generatePaymentsExportXlsx(templateId, await tableQuery());
      if (result.rowCount === 0) {
        setExportError(noReportRowsMessage(result.matchedCount));
      } else if (result.path) {
        setGeneratedExport(result);
        setExportDrawerOpen(false);
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

  /** Same shape as `handleGenerateExport`, but for a PDF template — the template-driven replacement of the old fixed-layout "Gerar PDF" report. */
  async function handleGeneratePdfExport(templateId: number) {
    setPdfExportError(null);
    setGeneratedPdfExport(null);
    setGeneratingPdfExport(true);
    try {
      const result = await generatePaymentsPdfExport(templateId, await tableQuery());
      if (result.rowCount === 0) {
        setPdfExportError(noReportRowsMessage(result.matchedCount));
      } else if (result.path) {
        setGeneratedPdfExport(result);
        setExportDrawerOpen(false);
      }
    } catch (e) {
      setPdfExportError(String(e instanceof Error ? e.message : e));
    } finally {
      setGeneratingPdfExport(false);
    }
  }

  async function handleGenerateLegacyPdf() {
    setLegacyPdfError(null);
    setGeneratedLegacyPdf(null);
    setGeneratingLegacyPdf(true);
    try {
      const result = await generatePaymentsReportPdf(await tableQuery(), grouped);
      if (result.rowCount === 0) setLegacyPdfError(noReportRowsMessage(result.matchedCount));
      else if (result.path) setGeneratedLegacyPdf(result);
    } catch (e) {
      setLegacyPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setGeneratingLegacyPdf(false);
    }
  }

  async function handleGenerateShiftPdf() {
    setShiftPdfError(null);
    setGeneratedShiftPdf(null);
    setGeneratingShiftPdf(true);
    try {
      const result = await generatePaymentsShiftReportPdf(await tableQuery(), grouped);
      if (result.rowCount === 0) setShiftPdfError(noReportRowsMessage(result.matchedCount));
      else if (result.path) setGeneratedShiftPdf(result);
    } catch (e) {
      setShiftPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setGeneratingShiftPdf(false);
    }
  }

  async function handleRevealLegacyPdf() {
    if (!generatedLegacyPdf?.path) return;
    setRevealingLegacyPdf(true);
    try {
      await revealInFileManager(generatedLegacyPdf.path);
    } catch (e) {
      setLegacyPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setRevealingLegacyPdf(false);
    }
  }

  async function handleRevealShiftPdf() {
    if (!generatedShiftPdf?.path) return;
    setRevealingShiftPdf(true);
    try {
      await revealInFileManager(generatedShiftPdf.path);
    } catch (e) {
      setShiftPdfError(String(e instanceof Error ? e.message : e));
    } finally {
      setRevealingShiftPdf(false);
    }
  }

  async function handleRevealPdfExport() {
    if (!generatedPdfExport?.path) return;
    setRevealingPdfExport(true);
    try {
      await revealInFileManager(generatedPdfExport.path);
    } catch (e) {
      setPdfExportError(String(e instanceof Error ? e.message : e));
    } finally {
      setRevealingPdfExport(false);
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
      selectedStatuses.size > 0 ||
      selectedShiftPeriods.size > 0 ||
      scheduleTimeFilter !== null ||
      attention !== undefined ||
      analytics !== undefined,
  );
  const total = grouped ? summariesTotal : flatTotal;
  /** Shifts the current filters match, status tab included — the count in the bar (in grouped mode `total` counts groups, not shifts). */
  const shiftCount = statusCounts ? orAll(selectedStatuses, PAYMENT_SHIFT_STATUSES).reduce((sum, s) => sum + statusCounts[s], 0) : null;
  const statusTabs: { label: string; statuses: PaymentShiftStatus[]; dot?: string }[] = [
    // "Todos" is no status filter at all (an empty set), not the three picked.
    { label: "Todos", statuses: [] },
    { label: "Pendentes", statuses: ["pendente"], dot: "var(--warning)" },
    { label: "Com erro", statuses: ["erro"], dot: "var(--danger)" },
    { label: "Pagos", statuses: ["pago"], dot: "var(--success)" },
  ];
  const isTab = (statuses: PaymentShiftStatus[]) => statuses.length === selectedStatuses.size && statuses.every((s) => selectedStatuses.has(s));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader
        title="Pagamentos"
        subtitle={
          grouped
            ? "Turnos importados, agrupados por colaborador e competência. Clique num colaborador para ver os turnos do mês."
            : "Turnos importados, um turno por linha."
        }
        actions={
          <div className="payments-head-actions">
            <PaymentsExportMenu
              onTemplateExport={() => setExportDrawerOpen(true)}
              onValueReport={handleGenerateLegacyPdf}
              onShiftReport={handleGenerateShiftPdf}
              generatingValueReport={generatingLegacyPdf}
              generatingShiftReport={generatingShiftPdf}
              shiftCount={shiftCount}
            />
            <button
              type="button"
              className="payments-reconcile"
              onClick={() => openReconciliationWindow().catch(() => {})}
              title="Conferência de Pagamentos — considera os filtros desta tela"
            >
              <ClipboardCheck size={15} />
              Conferência
              {statusCounts && statusCounts.pendente > 0 && (
                <small>
                  {statusCounts.pendente} {statusCounts.pendente === 1 ? "pendente" : "pendentes"}
                </small>
              )}
            </button>
          </div>
        }
      />
      {exportError && <div className="error-box">{exportError}</div>}
      {pdfExportError && <div className="error-box">{pdfExportError}</div>}
      {legacyPdfError && <div className="error-box">{legacyPdfError}</div>}
      {shiftPdfError && <div className="error-box">{shiftPdfError}</div>}
      {attention && (
        <div className="info-box">
          Filtro da análise: {attention === "pending-audit" ? "pagamentos aguardando conferência" : "turnos sem valor definido"}.
          <button type="button" className="ghost payments-analysis-clear" onClick={clearAnalysisFilter}>
            Remover
          </button>
        </div>
      )}
      {analytics && (
        <div className="info-box">
          Filtro da análise: {{ "journey-over-12h": "jornadas acima de 12h", "journey-under-4h": "jornadas abaixo de 4h", "rest-under-11h": "intervalos inferiores a 11h", heatmap: "célula do mapa de calor" }[analytics]}.
          <button type="button" className="ghost payments-analysis-clear" onClick={clearAnalysisFilter}>
            Remover
          </button>
        </div>
      )}

      <div className="library-bar">
        <button
          type="button"
          className={filtersOpen ? "library-filters-button library-filters-button-on" : "library-filters-button"}
          aria-expanded={filtersOpen}
          onClick={() => toggleFilters(!filtersOpen)}
        >
          <ListFilter size={15} />
          Filtros
          {activeFilterCount > 0 && <span className="library-filters-count">{activeFilterCount}</span>}
        </button>
        <span className="library-bar-sep" aria-hidden="true" />
        <PaymentsFilterChips companies={companies} clients={clients} roles={roles} onOpen={() => toggleFilters(true)} onChange={clearAnalysisFilter} />
        <span className="library-bar-count">
          {shiftCount !== null && (
            <>
              <b>{shiftCount}</b> {shiftCount === 1 ? "turno" : "turnos"}
            </>
          )}
        </span>
      </div>

      <div className="payments-notices">
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

        {generatedPdfExport && generatedPdfExport.path && (
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
              PDF gerado com sucesso: {generatedPdfExport.title} ({generatedPdfExport.rowCount} turno(s))
            </span>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" className="outline" onClick={() => setViewerPath(generatedPdfExport.path)}>
                <Eye size={15} style={{ marginRight: "0.4rem" }} />
                Abrir PDF
              </button>
              <button type="button" className="outline" onClick={handleRevealPdfExport} disabled={revealingPdfExport}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                Abrir no explorador
              </button>
            </div>
          </div>
        )}

        {generatedLegacyPdf && generatedLegacyPdf.path && (
          <div className="success-box" style={{ marginTop: "1rem", marginBottom: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <CheckCircle2 size={16} />
              Relatório por valor gerado com sucesso: {generatedLegacyPdf.title} ({generatedLegacyPdf.rowCount} turno(s))
            </span>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" className="outline" onClick={() => setViewerPath(generatedLegacyPdf.path)}>
                <Eye size={15} style={{ marginRight: "0.4rem" }} /> Abrir PDF
              </button>
              <button type="button" className="outline" onClick={handleRevealLegacyPdf} disabled={revealingLegacyPdf}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} /> Abrir no explorador
              </button>
            </div>
          </div>
        )}

        {generatedShiftPdf && generatedShiftPdf.path && (
          <div className="success-box" style={{ marginTop: "1rem", marginBottom: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <CheckCircle2 size={16} />
              Relatório por turno gerado com sucesso: {generatedShiftPdf.title} ({generatedShiftPdf.rowCount} turno(s))
            </span>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" className="outline" onClick={() => setViewerPath(generatedShiftPdf.path)}>
                <Eye size={15} style={{ marginRight: "0.4rem" }} /> Abrir PDF
              </button>
              <button type="button" className="outline" onClick={handleRevealShiftPdf} disabled={revealingShiftPdf}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} /> Abrir no explorador
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="payments-view-row">
        <div className="payments-tabs" role="tablist" aria-label="Status">
          {statusTabs.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={isTab(tab.statuses)}
              className="payments-tab"
              onClick={() => selectStatusTab(tab.statuses)}
            >
              {tab.dot && <i style={{ background: tab.dot }} />}
              {tab.label}
              {statusCounts && <span className="payments-tab-count">{orAll(new Set(tab.statuses), PAYMENT_SHIFT_STATUSES).reduce((sum, st) => sum + statusCounts[st], 0)}</span>}
            </button>
          ))}
        </div>
        <div className="payments-view-right">
          <div className="payments-segmented" role="group" aria-label="Exibição">
            <button
              type="button"
              aria-pressed={!grouped}
              onClick={() => {
                setGrouped(false);
                setPage(0);
              }}
            >
              <List size={14} />
              Turnos
            </button>
            <button
              type="button"
              aria-pressed={grouped}
              onClick={() => {
                setGrouped(true);
                setPage(0);
              }}
            >
              <Users size={14} />
              Por colaborador
            </button>
          </div>
          <ColumnPicker
            columns={PAYMENT_PICKER_COLUMNS}
            visible={visibleColumns}
            defaults={DEFAULT_VISIBLE_COLUMN_IDS}
            onChange={(next) => {
              next.add(ALWAYS_VISIBLE_COLUMN_ID);
              setVisibleColumns(next);
              setPaymentVisibleColumns(Array.from(next));
            }}
          />
        </div>
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
            <TableScroll>
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
                              {s.pendente > 0 && <span className="badge overwrite">{s.pendente} pendente</span>}
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
                                            active={r.id === activeShiftId}
                                            onOpen={() => openShiftPanel(r, s.companyId, { employeeId: s.employeeId, competencia: s.competencia })}
                                            rules={rulesByPair.get(`${s.clientId}:${s.companyId}`) ?? null}
                                            visibleColumns={visibleColumns}
                                            changes={shiftDiffs.get(r.id) ?? []}
                                            onViewExtra={(data, sourceUrl) => setViewingExtraData({ data, sourceUrl })}
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
            </TableScroll>

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
            <TableScroll>
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
                      active={r.id === activeShiftId}
                      onOpen={() => openShiftPanel(r, r.companyId, null)}
                      identity={{ employeeName: r.employeeName, companyName: r.companyName, clientName: r.clientName }}
                      rules={rulesByPair.get(`${r.clientId}:${r.companyId}`) ?? null}
                      visibleColumns={visibleColumns}
                      changes={shiftDiffs.get(r.id) ?? []}
                      onViewExtra={(data, sourceUrl) => setViewingExtraData({ data, sourceUrl })}
                    />
                  ))}
                </tbody>
              </table>
            </TableScroll>

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

      <ShiftPanel
        shift={openShift?.shift ?? null}
        tab={panelTab}
        onTabChange={setPanelTab}
        rules={openShift ? rulesByPair.get(`${openShift.shift.clientId}:${openShift.companyId}`) ?? null : null}
        changes={openShift ? shiftDiffs.get(openShift.shift.id) ?? [] : []}
        otherPending={
          openShift
            ? panelRows
                .filter((r) => r.shift.employeeId === openShift.shift.employeeId && r.shift.id !== openShift.shift.id && isPayable(r.shift))
                .map((r) => r.shift)
            : []
        }
        valueFor={(shift) => shiftValueFor(shift, shift.companyId)}
        busy={actionBusy}
        error={actionError}
        lastPayment={lastPayment}
        canPrev={prevRow !== undefined}
        canNext={nextRow !== undefined}
        onPrev={() => prevRow && openShiftPanel(prevRow.shift, prevRow.companyId, prevRow.groupRef)}
        onNext={() => nextRow && openShiftPanel(nextRow.shift, nextRow.companyId, nextRow.groupRef)}
        onOpenShift={(shift) => {
          const row = panelRows.find((r) => r.shift.id === shift.id);
          if (row) openShiftPanel(row.shift, row.companyId, row.groupRef);
        }}
        onAskAi={() => openShift && handleInvestigate(openShift.shift)}
        onReview={() => openShift && setReviewingShift({ shift: openShift.shift, groupRef: openShift.groupRef })}
        onConfirmPay={handleConfirmPayment}
        onConfirmRevert={handleConfirmRevert}
        onSave={handleSaveShift}
        onConfirmDelete={handleConfirmDelete}
        onClose={closeShiftPanel}
      />
      <ExtraColumnsDrawer
        open={viewingExtraData !== null}
        data={viewingExtraData?.data ?? null}
        sourceUrl={viewingExtraData?.sourceUrl ?? null}
        onClose={() => setViewingExtraData(null)}
      />

      <PaymentExportDrawer
        open={exportDrawerOpen}
        onClose={() => setExportDrawerOpen(false)}
        excelTemplates={exportTemplates}
        pdfTemplates={pdfTemplates}
        selectedExcelTemplateId={selectedExportTemplateId}
        selectedPdfTemplateId={selectedPdfTemplateId}
        onSelectExcelTemplate={setSelectedExportTemplateId}
        onSelectPdfTemplate={setSelectedPdfTemplateId}
        exportingExcel={generatingExport}
        exportingPdf={generatingPdfExport}
        excelError={exportError}
        pdfError={pdfExportError}
        onExport={(format, templateId) => {
          if (format === "excel") handleGenerateExport(templateId);
          else handleGeneratePdfExport(templateId);
        }}
        onManageTemplates={() => {
          setExportDrawerOpen(false);
          navigate("/payments/export-templates");
        }}
      />

      <PdfViewerModal
        path={viewerPath}
        title={generatedLegacyPdf?.path === viewerPath ? generatedLegacyPdf.title : generatedPdfExport?.title}
        allowDownload={false}
        onClose={() => setViewerPath(null)}
      />

      <Drawer
        open={reviewingShift !== null}
        onClose={() => {
          setReviewingShift(null);
          setAcceptError(null);
        }}
        title={reviewingShift ? reviewingShift.shift.employeeName : ""}
        subtitle={reviewingShift ? `Alterações na planilha · ${formatDate(reviewingShift.shift.workDate)}` : undefined}
        icon={RefreshCw}
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

      <PaymentsFiltersPanel
        open={filtersOpen}
        onClose={() => toggleFilters(false)}
        onChange={clearAnalysisFilter}
        companies={companies}
        clients={clients}
        roles={roles}
        locals={locals}
      />

    </div>
  );
}
