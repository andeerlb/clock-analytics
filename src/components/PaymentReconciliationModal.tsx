import { Filter, Moon, Sun, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePaymentsFilters } from "../contexts/FiltersContext";
import {
  deletePaymentAudit,
  listPaymentAuditsForShiftIds,
  listPaymentShiftsForReport,
  recordPaymentAudit,
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
 * user's external spreadsheet for checking paid shifts against the bank.
 * This is purely a review/audit screen, not an actions screen: for each
 * `pago` shift, both Confirmar and Marcar erro only ever record a verdict
 * (see `recordPaymentAudit`) — neither one touches `payment_shifts` itself,
 * so a wrong verdict is always freely correctable by clicking the other
 * button (or "Desfazer" to clear it back to unaudited), with nothing else
 * in the system to undo alongside it. Reverting a shift back to `pendente`
 * for re-payment stays the Pagamentos page's own separate, deliberate
 * "Voltar para pendente" action — this screen never triggers it. Non-`pago`
 * rows can appear too (whatever the active filters currently include) but
 * are read-only, since there's nothing to reconcile against a bank for a
 * shift that hasn't been paid yet.
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

  /**
   * Only relevant with "Mostrar itens já conferidos" OFF — that's the only
   * case where auditing `shiftId` actually removes it from `visibleRows`
   * (with the toggle on, the row stays right where it is, badge in place of
   * the buttons, and keeping focus on it — i.e. doing nothing here — is
   * exactly right). Moves focus to whatever row is about to take this one's
   * place once it's filtered out, computed from the CURRENT `visibleRows`
   * (before the audit that's about to hide it lands) so it lines up with
   * the list's next render — without this, focus would fall through to the
   * generic reset effect above, which has no notion of "where this row
   * was" and would jump all the way back to the top of the list instead.
   */
  function advanceFocusIfHidden(shiftId: number) {
    if (showAudited) return;
    const idx = visibleRows.findIndex((r) => r.id === shiftId);
    if (idx === -1) return;
    const remaining = visibleRows.filter((r) => r.id !== shiftId);
    const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
    setFocusedShiftId(next ? next.id : null);
  }

  async function handleConfirm(shiftId: number) {
    if (actingShiftId !== null) return;
    setActingShiftId(shiftId);
    setActionError(null);
    try {
      await recordPaymentAudit(shiftId, "confirmado", null);
      setAudits((prev) => new Map(prev).set(shiftId, { result: "confirmado", note: null, auditedAt: new Date().toISOString() }));
      advanceFocusIfHidden(shiftId);
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
      setAudits((prev) => new Map(prev).set(shift.id, { result: "erro", note: null, auditedAt: new Date().toISOString() }));
      advanceFocusIfHidden(shift.id);
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActingShiftId(null);
    }
  }

  /**
   * "Desfazer" — clears whichever verdict (confirmado or erro) is currently
   * recorded, back to unaudited. Safe either way: neither verdict ever
   * touched `payment_shifts` itself (see the module doc comment above), so
   * there's nothing else to reverse alongside the audit row. Triggered from
   * the row's right-click menu (see `onContextMenu` below), not a
   * persistent button.
   */
  async function handleUndoAudit(shiftId: number) {
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
  // Same per-action logic as the row's own buttons/menu: disabled exactly
  // when it would be a no-op given the row's current verdict.
  const focusedCanConfirm = focusedRow?.status === "pago" && focusedAudit?.result !== "confirmado";
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
        if (focusedShiftId !== null && focusedCanConfirm) handleConfirm(focusedShiftId);
      } else if (e.key === "Backspace" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (focusedRow && focusedCanMarkError) handleErrorSubmit(focusedRow);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedShiftId, visibleRows, actingShiftId, focusedCanConfirm, focusedCanMarkError]);

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
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const hasSchedule = r.scheduleStartMinutes !== null && r.scheduleEndMinutes !== null;
                  const duration = hasSchedule ? shiftDurationMinutes(r.scheduleStartMinutes!, r.scheduleEndMinutes!) : null;
                  const audit = audits.get(r.id) ?? null;
                  // Each action is disabled exactly when it would be a
                  // no-op given the row's CURRENT verdict — re-confirming an
                  // already-`confirmado` row (or re-marking an already-`erro`
                  // one) does nothing new, while the OTHER verdict and
                  // "Desfazer" stay available to correct it (purely an audit
                  // label — see the module doc comment — so switching either
                  // direction via `recordPaymentAudit`'s upsert is always
                  // safe).
                  const canConfirm = r.status === "pago" && audit?.result !== "confirmado";
                  const canMarkError = r.status === "pago" && audit?.result !== "erro";
                  const col = (id: string) => visibleColumns.has(id);
                  // Every possible action always appears in the right-click
                  // menu (the only place any of this is reachable via mouse
                  // — see the toolbar's shortcuts legend for the keyboard
                  // equivalents) — one that doesn't currently apply to this
                  // row is `disabled` rather than omitted, so the full set
                  // of things this menu can do stays discoverable no matter
                  // which row you right-click (same convention the
                  // Pagamentos table's own row menu uses for "Fazer
                  // pagamento"/"Ver histórico").
                  const rowActions: ContextMenuItem[] = [
                    {
                      label: "Confirmar",
                      disabled: !canConfirm || actingShiftId === r.id,
                      onClick: () => handleConfirm(r.id),
                    },
                    {
                      label: "Marcar erro",
                      disabled: !canMarkError || actingShiftId === r.id,
                      onClick: () => handleErrorSubmit(r),
                    },
                    {
                      label: "Desfazer",
                      disabled: !audit || actingShiftId === r.id,
                      onClick: () => handleUndoAudit(r.id),
                    },
                  ];
                  // The audit verdict colors the whole row — confirmado
                  // green, erro red — instead of a dedicated column. Plain
                  // CSS classes (not an inline style), specifically so
                  // App.css's own `:hover`/`.row-active` combos for these
                  // classes can still take over the background — an inline
                  // style would out-specificity every class-based rule
                  // unconditionally, silently swallowing both the hover and
                  // focus cues on any audited row (see the rules themselves
                  // in App.css for the actual colors/priority).
                  const rowClassName = [
                    r.id === focusedShiftId && "row-active",
                    audit?.result === "confirmado" && "row-confirmado",
                    audit?.result === "erro" && "row-erro",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <tr
                      key={r.id}
                      className={rowClassName || undefined}
                      style={{ cursor: "pointer" }}
                      title={audit ? `${PAYMENT_AUDIT_RESULT_LABELS[audit.result]} em ${formatDateTimeAbbrevYY(audit.auditedAt)}` : undefined}
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
