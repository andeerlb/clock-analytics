import { Check, Filter, Moon, Sun, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePaymentsFilters } from "../contexts/FiltersContext";
import {
  deletePaymentAudit,
  listPaymentAuditsForShiftIds,
  listPaymentShiftsForReport,
  recordPaymentAudit,
  revertPaymentShiftToPending,
  type ClientRow,
  type CompanyRow,
  type ListPaymentShiftSummariesQuery,
  type PaymentShiftReportRow,
  type RoleRow,
} from "../lib/db";
import { formatCurrencyBRL, formatDateAbbrevYY, formatDateTimeAbbrevYY, formatMinutesAsTime, shiftDurationMinutes } from "../lib/format";
import { FLAT_COLUMNS } from "../lib/paymentColumns";
import { PAYMENT_AUDIT_RESULT_LABELS, type PaymentAuditResult, type PaymentShiftStatus } from "../lib/types";
import Avatar from "./Avatar";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import Modal, { useModalClose } from "./Modal";
import MultiSelectDropdown from "./MultiSelectDropdown";
import PaymentsFiltersDrawer, { type PaymentsFiltersValue } from "./PaymentsFiltersDrawer";

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string }> = {
  pendente: { className: "badge warn", label: "Pendente" },
  erro: { className: "badge file-error", label: "Erro" },
  pago: { className: "badge ok", label: "Pago" },
};

const AUDIT_BADGE_CLASS: Record<PaymentAuditResult, string> = {
  confirmado: "badge ok",
  erro: "badge file-error",
};

/** Columns most useful for matching a paid shift against a bank statement — the rest of `FLAT_COLUMNS` starts off unchecked, same picker mechanics as the main page's but a smaller default and never touching `payment_settings.visible_columns_json`. */
const DEFAULT_VISIBLE_COLUMN_IDS = new Set(["colaborador", "data", "local", "valor", "status"]);

type AuditedInfo = { result: PaymentAuditResult; note: string | null; auditedAt: string };

/** Header X, routed through `useModalClose` — same recipe `PaymentTemplateWizard`'s own `CloseButton` uses for a `fullScreen` surface. */
function CloseButton() {
  const requestClose = useModalClose();
  return (
    <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={requestClose} aria-label="Fechar">
      <X size={18} />
    </button>
  );
}

/**
 * "Conferência de Pagamentos" — a full-screen review flow that replaces the
 * user's external spreadsheet for checking paid shifts against the bank:
 * for each `pago` shift, Confirmar records nothing but the audit fact
 * itself (see `recordPaymentAudit`), while Erro also reverts the shift back
 * to `pendente` (reusing `revertPaymentShiftToPending` as-is) so it re-enters
 * the normal payment queue. Non-`pago` rows can appear too (whatever the
 * active filters currently include) but are read-only, since there's
 * nothing to reconcile against a bank for a shift that hasn't been paid
 * yet.
 *
 * Filters are the SAME live `usePaymentsFilters()` state the Pagamentos
 * page itself reads/writes — not a snapshot — so changing them here (via
 * its own "Filtros" button) both refetches this list immediately and is
 * what the page itself shows once this modal closes.
 */
export default function PaymentReconciliationModal({
  companies,
  clients,
  roles,
  locals,
  onClose,
}: {
  companies: CompanyRow[];
  clients: ClientRow[];
  roles: RoleRow[];
  locals: string[];
  onClose: () => void;
}) {
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
  } = usePaymentsFilters();

  const [rows, setRows] = useState<PaymentShiftReportRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [audits, setAudits] = useState<Map<number, AuditedInfo>>(new Map());
  const [showAudited, setShowAudited] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_COLUMN_IDS));
  const [focusedShiftId, setFocusedShiftId] = useState<number | null>(null);
  const [actingShiftId, setActingShiftId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

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
    };
  }

  // Refetches on mount AND whenever the filters change (via the "Filtros"
  // button below) — unlike the first version of this modal, filters here
  // are the live, shared `usePaymentsFilters()` state, not a snapshot.
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setListError(null);
    (async () => {
      try {
        const reportRows = await listPaymentShiftsForReport(baseQuery());
        if (cancelled) return;
        setRows(reportRows);
        const auditRows = await listPaymentAuditsForShiftIds(reportRows.map((r) => r.id));
        if (cancelled) return;
        setAudits(new Map(auditRows.map((a) => [a.paymentShiftId, { result: a.result, note: a.note, auditedAt: a.auditedAt }])));
      } catch (e) {
        if (!cancelled) setListError(String(e instanceof Error ? e.message : e));
      }
    })();
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
    selectedStatuses,
    selectedShiftPeriods,
    scheduleTimeFilter,
  ]);

  function handleApplyFilters(next: PaymentsFiltersValue) {
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
    setFiltersDrawerOpen(false);
  }

  const eligibleUnaudited = useMemo(
    () => (rows ?? []).filter((r) => r.status === "pago" && !audits.has(r.id)),
    [rows, audits],
  );
  const visibleRows = useMemo(
    () => (rows ?? []).filter((r) => r.status !== "pago" || showAudited || !audits.has(r.id)),
    [rows, audits, showAudited],
  );

  // Focus/navigation ranges over every *visible* row, not just the
  // actionable ones — a pendente/erro row (or an already-audited one, once
  // "Mostrar itens já conferidos" is on) can still be selected and arrowed
  // through, same as clicking it; what changes per row is only which
  // actions are enabled once it's focused (see `focusedActionable`/
  // `focusedCanMarkError` below), not whether it's reachable at all.
  useEffect(() => {
    if (focusedShiftId !== null && visibleRows.some((r) => r.id === focusedShiftId)) return;
    setFocusedShiftId(visibleRows[0]?.id ?? null);
  }, [visibleRows, focusedShiftId]);

  // Confirmar/Marcar erro/Desfazer never move focus themselves — whichever
  // row was focused (by an earlier click, right-click, or arrow key) before
  // the action stays focused after it, so acting on a row never yanks focus
  // out from under you onto a different one. Arrow keys remain the only way
  // focus moves.
  async function handleConfirm(shiftId: number) {
    if (actingShiftId !== null) return;
    setActingShiftId(shiftId);
    setActionError(null);
    try {
      await recordPaymentAudit(shiftId, "confirmado", null);
      setAudits((prev) => new Map(prev).set(shiftId, { result: "confirmado", note: null, auditedAt: new Date().toISOString() }));
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActingShiftId(null);
    }
  }

  async function handleErrorSubmit(shift: PaymentShiftReportRow) {
    if (actingShiftId !== null) return;
    setActingShiftId(shift.id);
    setActionError(null);
    try {
      await recordPaymentAudit(shift.id, "erro", null);
      await revertPaymentShiftToPending(shift.id);
      setAudits((prev) => new Map(prev).set(shift.id, { result: "erro", note: null, auditedAt: new Date().toISOString() }));
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActingShiftId(null);
    }
  }

  /**
   * "Desconfirmar" — only offered for a `confirmado` verdict, where undoing
   * really does put the shift back exactly how it was (still `pago`,
   * nothing else ever changed). An `erro` verdict already triggered a real
   * revert to `pendente` via `revertPaymentShiftToPending`, which can't be
   * undone by deleting the audit row alone — see `deletePaymentAudit`'s own
   * doc comment — so that badge stays as a permanent record instead.
   * Triggered from the row's right-click menu (see `onContextMenu` below),
   * not a persistent button.
   */
  async function handleUndoConfirm(shiftId: number) {
    if (actingShiftId !== null) return;
    setActingShiftId(shiftId);
    setActionError(null);
    try {
      await deletePaymentAudit(shiftId);
      setAudits((prev) => {
        const next = new Map(prev);
        next.delete(shiftId);
        return next;
      });
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActingShiftId(null);
    }
  }

  function moveFocus(delta: number) {
    if (visibleRows.length === 0) return;
    const idx = visibleRows.findIndex((r) => r.id === focusedShiftId);
    const nextIdx = idx === -1 ? 0 : Math.min(Math.max(idx + delta, 0), visibleRows.length - 1);
    setFocusedShiftId(visibleRows[nextIdx].id);
  }

  const focusedRow = focusedShiftId !== null ? visibleRows.find((r) => r.id === focusedShiftId) ?? null : null;
  const focusedAudit = focusedRow ? audits.get(focusedRow.id) ?? null : null;
  const focusedActionable = focusedRow?.status === "pago" && !focusedAudit;
  const focusedCanMarkError = focusedRow?.status === "pago" && focusedAudit?.result !== "erro";

  // Arrow keys move focus across every visible row (not just actionable
  // ones — see the comment above the focus-reset effect); Y/Enter confirms
  // and N/Backspace marks erro on the focused row directly, same as
  // clicking the equivalent button — both no-ops while the focused row
  // can't take that action. Same scoped attach/detach recipe as
  // PdfViewerModal's own page-navigation shortcuts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(-1);
      } else if (e.key === "Enter" || e.key === "y" || e.key === "Y") {
        e.preventDefault();
        if (focusedShiftId !== null && focusedActionable) handleConfirm(focusedShiftId);
      } else if (e.key === "Backspace" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (focusedRow && focusedCanMarkError) handleErrorSubmit(focusedRow);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedShiftId, visibleRows, actingShiftId, focusedActionable, focusedCanMarkError]);

  return (
    <Modal fullScreen zIndex={100} onClose={onClose} closeOnEscape={!filtersDrawerOpen}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.8rem 1.2rem",
          background: "var(--card-bg)",
          borderBottom: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <strong style={{ fontSize: "0.95rem" }}>Conferência de Pagamentos</strong>
        <CloseButton />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.8rem",
          padding: "0.8rem 1.2rem",
          borderBottom: "1px solid var(--border)",
          flexWrap: "wrap",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="secondary" onClick={() => setFiltersDrawerOpen(true)}>
          <Filter size={15} style={{ marginRight: "0.4rem" }} />
          Filtros
        </button>
        <MultiSelectDropdown
          options={FLAT_COLUMNS}
          selected={visibleColumns}
          onToggle={(id) =>
            setVisibleColumns((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectAll={() => setVisibleColumns(new Set(FLAT_COLUMNS.map((c) => c.id)))}
          onSelectNone={() => setVisibleColumns(new Set())}
          allLabel="Configurar colunas"
          noneLabel="Nenhuma coluna"
          countLabel={(n) => `Colunas (${n})`}
          align="left"
        />
        <label className="drawer-checkbox-field" style={{ width: "auto" }}>
          <input type="checkbox" checked={showAudited} onChange={(e) => setShowAudited(e.target.checked)} />
          Mostrar itens já conferidos
        </label>
        <span className="muted" style={{ fontSize: "0.85rem", marginLeft: "auto" }}>
          {eligibleUnaudited.length === 0
            ? rows === null
              ? "Carregando..."
              : "Tudo conferido"
            : `${eligibleUnaudited.length} pendente${eligibleUnaudited.length === 1 ? "" : "s"} de conferência`}
        </span>
      </div>

      <div
        className="muted"
        style={{ padding: "0.5rem 1.2rem", borderBottom: "1px solid var(--border)", fontSize: "0.78rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        Atalhos: ↑ / ↓ navegar · Enter ou Y confirmar · Backspace ou N marcar erro · clique direito num item para ver todas as ações
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "1.2rem", minHeight: 0 }} onClick={(e) => e.stopPropagation()}>
        {listError && <div className="error-box" style={{ marginBottom: "1rem" }}>Não foi possível carregar os pagamentos: {listError}</div>}
        {actionError && <div className="error-box" style={{ marginBottom: "1rem" }}>{actionError}</div>}
        {rows === null && !listError && <p className="muted">Carregando...</p>}
        {rows !== null && visibleRows.length === 0 && (
          <p className="muted">{rows.length === 0 ? "Nenhum turno para os filtros selecionados." : "Nada pendente de conferência."}</p>
        )}
        {rows !== null && visibleRows.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {FLAT_COLUMNS.filter((c) => visibleColumns.has(c.id)).map((c) => (
                    <th key={c.id}>{c.label}</th>
                  ))}
                  <th>Conferência</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const hasSchedule = r.scheduleStartMinutes !== null && r.scheduleEndMinutes !== null;
                  const duration = hasSchedule ? shiftDurationMinutes(r.scheduleStartMinutes!, r.scheduleEndMinutes!) : null;
                  const audit = audits.get(r.id) ?? null;
                  const actionable = r.status === "pago" && !audit;
                  const col = (id: string) => visibleColumns.has(id);
                  // Every possible action always appears — one that doesn't
                  // currently apply to this row is `disabled` rather than
                  // omitted, so the full set of things this menu can do
                  // stays discoverable no matter which row you right-click
                  // (same convention the Pagamentos table's own row menu
                  // uses for "Fazer pagamento"/"Ver histórico").
                  // Marcar erro stays available even on an already-`confirmado`
                  // row — "achei que tinha batido, mas na verdade não bateu" is
                  // a real correction, not just an initial verdict, and
                  // `recordPaymentAudit` upserts so it just overwrites the
                  // existing audit. An `erro` row is the one terminal state:
                  // it already reverted the shift to `pendente`, so there's
                  // nothing left here to mark.
                  const canMarkError = r.status === "pago" && audit?.result !== "erro";
                  const rowActions: ContextMenuItem[] = [
                    {
                      label: "Confirmar",
                      disabled: !actionable || actingShiftId === r.id,
                      onClick: () => handleConfirm(r.id),
                    },
                    {
                      label: "Marcar erro",
                      disabled: !canMarkError || actingShiftId === r.id,
                      onClick: () => handleErrorSubmit(r),
                    },
                    {
                      label: "Desfazer confirmação",
                      disabled: audit?.result !== "confirmado" || actingShiftId === r.id,
                      onClick: () => handleUndoConfirm(r.id),
                    },
                  ];
                  return (
                    <tr
                      key={r.id}
                      className={r.id === focusedShiftId ? "row-active" : undefined}
                      style={{ cursor: "pointer" }}
                      onClick={() => setFocusedShiftId(r.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setFocusedShiftId(r.id);
                        setContextMenu({ x: e.clientX, y: e.clientY, items: rowActions });
                      }}
                    >
                      {col("colaborador") && (
                        <td>
                          <div className="person-cell">
                            <Avatar name={r.employeeName} />
                            {r.employeeName}
                          </div>
                        </td>
                      )}
                      {col("cliente") && <td>{r.clientName}</td>}
                      {col("empresa") && <td>{r.companyName}</td>}
                      {col("data") && <td>{formatDateAbbrevYY(r.workDate)}</td>}
                      {col("local") && <td>{r.local}</td>}
                      {col("funcao") && <td>{r.role}</td>}
                      {col("horario") && (
                        <td>
                          {hasSchedule && (
                            <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
                              <span>
                                {formatMinutesAsTime(r.scheduleStartMinutes!)} – {formatMinutesAsTime(r.scheduleEndMinutes!)}
                              </span>
                              {r.shiftPeriod && (
                                <span
                                  className={r.shiftPeriod === "noturno" ? "badge info" : "badge neutral"}
                                  title={r.shiftPeriod === "noturno" ? "Noturno" : "Diurno"}
                                >
                                  {r.shiftPeriod === "noturno" ? <Moon size={12} /> : <Sun size={12} />}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                      )}
                      {col("horas") && <td>{duration !== null && formatMinutesAsTime(duration)}</td>}
                      {col("valor") && <td>{r.amount !== null && formatCurrencyBRL(r.amount)}</td>}
                      {col("status") && (
                        <td>
                          <span className={STATUS_BADGE[r.status].className}>{STATUS_BADGE[r.status].label}</span>
                        </td>
                      )}
                      {col("importado") && (
                        <td className="muted" style={{ fontSize: "0.8rem" }}>
                          {formatDateTimeAbbrevYY(r.importedAt)}
                        </td>
                      )}
                      {col("extras") && (
                        <td className="muted" title={r.extraData ? Object.entries(r.extraData).map(([k, v]) => `${k}: ${v}`).join("\n") : undefined}>
                          {r.extraData && `${Object.keys(r.extraData).length} coluna(s)`}
                        </td>
                      )}
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                          {actionable && (
                            <button
                              type="button"
                              className="ghost"
                              title="Confirmar (bateu com o banco)"
                              style={{ color: "var(--success)", padding: "0.3rem" }}
                              disabled={actingShiftId === r.id}
                              onClick={() => handleConfirm(r.id)}
                            >
                              <Check size={16} />
                            </button>
                          )}
                          {canMarkError && (
                            <button
                              type="button"
                              className="ghost"
                              title="Marcar erro (não bateu com o banco)"
                              style={{ color: "var(--danger)", padding: "0.3rem" }}
                              disabled={actingShiftId === r.id}
                              onClick={() => handleErrorSubmit(r)}
                            >
                              <X size={16} />
                            </button>
                          )}
                          {audit && (
                            <span
                              className={AUDIT_BADGE_CLASS[audit.result]}
                              title={
                                audit.result === "confirmado"
                                  ? `Confirmado em ${formatDateTimeAbbrevYY(audit.auditedAt)} — clique com o botão direito para desfazer`
                                  : `Marcado como erro em ${formatDateTimeAbbrevYY(audit.auditedAt)}${audit.note ? ` — ${audit.note}` : ""}`
                              }
                            >
                              {PAYMENT_AUDIT_RESULT_LABELS[audit.result]}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
        showGroupedToggle={false}
      />

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
    </Modal>
  );
}
