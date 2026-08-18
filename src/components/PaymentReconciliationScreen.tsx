import { listen } from "@tauri-apps/api/event";
import { Filter, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePaymentsFilters } from "../contexts/FiltersContext";
import {
  countPaymentShiftsPendingAudit,
  deletePaymentAudit,
  listPaymentAuditsForShiftIds,
  listPaymentShiftsForReportPage,
  markPaymentShiftAuditError,
  PAYMENT_SHIFTS_CHANGED_EVENT,
  recordPaymentAudit,
  undoPaymentShiftAuditError,
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
import MultiSelectDropdown from "./MultiSelectDropdown";
import PaymentsFiltersDrawer, { type PaymentsFiltersValue } from "./PaymentsFiltersDrawer";

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string }> = {
  pendente: { className: "badge warn", label: "Pendente" },
  erro: { className: "badge file-error", label: "Erro" },
  pago: { className: "badge ok", label: "Pago" },
};

/** Columns most useful for matching a paid shift against a bank statement — the rest of `FLAT_COLUMNS` starts off unchecked, same picker mechanics as the main page's but a smaller default and never touching `payment_settings.visible_columns_json`. */
const DEFAULT_VISIBLE_COLUMN_IDS = new Set(["colaborador", "data", "local", "valor", "status"]);

/** Rows fetched per scroll chunk — see `loadMore`/the `IntersectionObserver` sentinel below. */
const PAGE_SIZE = 50;

/** Scroll *distance* (px), not position — how much downward scroll it takes to fully collapse the title bar + toolbar away. Larger than `EXPAND_DISTANCE` so hiding reads as a deliberate, gradual retreat rather than snapping away. See `handleScroll` below. */
const COLLAPSE_DISTANCE = 320;
/** Same idea in the opposite direction — how much upward scroll it takes to fully bring the title bar + toolbar back. Shorter than `COLLAPSE_DISTANCE`: wanting the toolbar back (to hit "Filtros", say) should feel responsive, not like undoing the same slow retreat. */
const EXPAND_DISTANCE = 90;

type AuditedInfo = { result: PaymentAuditResult; note: string | null; auditedAt: string };

/**
 * "Conferência de Pagamentos" — a full-screen review flow that replaces the
 * user's external spreadsheet for checking paid shifts against the bank.
 * Confirmar is a pure audit label: it only ever records a verdict (see
 * `recordPaymentAudit`), never touching `payment_shifts`. Marcar erro is a
 * real state transition — the bank statement didn't match, so the shift is
 * kicked back to `erro` (via `markPaymentShiftAuditError`) the same way any
 * other `erro` shift works: editable and payable again from the Pagamentos
 * page. Desfazer reverses whichever of those actually happened: for a
 * `confirmado` row that's just `deletePaymentAudit`; for an `erro` row it
 * first restores the `pago` state (`undoPaymentShiftAuditError`) and then
 * clears the audit, so "Desfazer" always lands back exactly where the row
 * started. Because Marcar erro changes the row's own status, whether it
 * stays visible after acting is entirely up to the active filters (same as
 * any other shift) — this screen doesn't special-case it. Non-`pago` rows
 * can appear too (whatever the active filters currently include) but are
 * read-only otherwise, since there's nothing to reconcile against a bank
 * for a shift that hasn't been paid yet.
 *
 * Always runs in its own detached OS window (`open_reconciliation_window`,
 * mounted by `PaymentReconciliationWindowPage`), never as an in-app modal —
 * so its `usePaymentsFilters()` is that window's own `FiltersProvider`
 * instance, seeded once from the main window's filters at open time (see
 * `PaymentReconciliationWindowPage`) and independent from then on, not the
 * main window's live state.
 *
 * Rows load a page at a time (`listPaymentShiftsForReportPage`), not all at
 * once — `PaymentReconciliationScreen` grew a real infinite-scroll list
 * once "Conferência" started being used against months with hundreds of
 * turnos. `countPaymentShiftsPendingAudit` backs the "N pendente(s) de
 * conferência" badge for the same reason: it can't be derived from `rows`
 * anymore once `rows` is only ever a prefix of what matches the filters.
 * `PAYMENT_SHIFTS_CHANGED_EVENT` keeps this list (and its counterpart in
 * `PaymentsPage`) in sync across windows — confirming/marking erro here
 * broadcasts, and a payment made in `PaymentsPage` refreshes this list the
 * same way.
 */
export default function PaymentReconciliationScreen({
  companies,
  clients,
  roles,
  locals,
}: {
  companies: CompanyRow[];
  clients: ClientRow[];
  roles: RoleRow[];
  locals: string[];
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

  const [rows, setRows] = useState<PaymentShiftReportRow[]>([]);
  const [rowsTotal, setRowsTotal] = useState<number | null>(null);
  const [nextPage, setNextPage] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [audits, setAudits] = useState<Map<number, AuditedInfo>>(new Map());
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [showAudited, setShowAudited] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_COLUMN_IDS));
  const [focusedShiftId, setFocusedShiftId] = useState<number | null>(null);
  const [actingShiftId, setActingShiftId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  const collapsibleInnerRef = useRef<HTMLDivElement | null>(null);
  const collapseRafRef = useRef(0);
  /** Current collapse amount (0 = fully expanded, 1 = fully collapsed) — persists across scroll events, not derived from absolute `scrollTop`, so it responds to scroll *direction* the same way no matter how far down the list you are. See `handleScroll`. */
  const collapseProgressRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const latestScrollTopRef = useRef(0);

  const exhausted = rowsTotal !== null && rows.length >= rowsTotal;

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

  function mergeAudits(prev: Map<number, AuditedInfo>, auditRows: { paymentShiftId: number; result: PaymentAuditResult; note: string | null; auditedAt: string }[]) {
    const next = new Map(prev);
    for (const a of auditRows) next.set(a.paymentShiftId, { result: a.result, note: a.note, auditedAt: a.auditedAt });
    return next;
  }

  // Resets and loads the first page on mount AND whenever the filters
  // change (via the "Filtros" button below) — filters here are this
  // window's once-seeded, independent `usePaymentsFilters()` copy (see the
  // module doc comment), not a snapshot taken only at mount.
  useEffect(() => {
    let cancelled = false;
    setRows([]);
    setRowsTotal(null);
    setNextPage(0);
    setAudits(new Map());
    setPendingCount(null);
    setListError(null);
    (async () => {
      try {
        const [pageResult, pending] = await Promise.all([
          listPaymentShiftsForReportPage(baseQuery(), 0, PAGE_SIZE),
          countPaymentShiftsPendingAudit(baseQuery()),
        ]);
        if (cancelled) return;
        setRows(pageResult.rows);
        setRowsTotal(pageResult.total);
        setNextPage(1);
        setPendingCount(pending);
        const auditRows = await listPaymentAuditsForShiftIds(pageResult.rows.map((r) => r.id));
        if (cancelled) return;
        setAudits((prev) => mergeAudits(prev, auditRows));
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

  async function loadMore() {
    if (loadingMore || rowsTotal === null || rows.length >= rowsTotal) return;
    setLoadingMore(true);
    try {
      const pageResult = await listPaymentShiftsForReportPage(baseQuery(), nextPage, PAGE_SIZE);
      setRows((prev) => [...prev, ...pageResult.rows]);
      setRowsTotal(pageResult.total);
      setNextPage((p) => p + 1);
      const auditRows = await listPaymentAuditsForShiftIds(pageResult.rows.map((r) => r.id));
      setAudits((prev) => mergeAudits(prev, auditRows));
    } catch (e) {
      setListError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingMore(false);
    }
  }

  // Loads the next page once the sentinel at the bottom of the table
  // scrolls into view — re-subscribes whenever the guard conditions change
  // so the observer's callback always closes over fresh state. Same idiom
  // `RemoteUpdatesPage`'s "Ver histórico completo" uses.
  useEffect(() => {
    if (exhausted) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "150px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, exhausted, loadingMore]);

  /**
   * Re-fetches exactly the window already loaded (page 0 at `rows.length`
   * rows, instead of `PAGE_SIZE`) plus the pending count — used after
   * `markPaymentShiftAuditError`/`undoPaymentShiftAuditError`, both of
   * which change a row's actual `payment_shifts.status`, so whether the
   * result still belongs in this list is up to the active filters (same as
   * any other status change elsewhere in the app), not something this
   * screen decides for itself by patching local state. Also what
   * `PAYMENT_SHIFTS_CHANGED_EVENT` triggers, for a change made in another
   * window (or `PaymentsPage`, in this same one). Keeps scroll position
   * stable — re-fetches the already-scrolled-to prefix instead of
   * restarting from page 0 at `PAGE_SIZE` rows.
   */
  async function refreshLoadedWindow(): Promise<void> {
    if (rowsTotal === null) return;
    const size = Math.max(rows.length, PAGE_SIZE);
    const [pageResult, pending] = await Promise.all([
      listPaymentShiftsForReportPage(baseQuery(), 0, size),
      countPaymentShiftsPendingAudit(baseQuery()),
    ]);
    setRows(pageResult.rows);
    setRowsTotal(pageResult.total);
    setNextPage(Math.ceil(pageResult.rows.length / PAGE_SIZE));
    setPendingCount(pending);
    const auditRows = await listPaymentAuditsForShiftIds(pageResult.rows.map((r) => r.id));
    setAudits((prev) => mergeAudits(prev, auditRows));
  }

  // Always current — set every render so the event listener below (only
  // ever subscribed once) can call whatever `refreshLoadedWindow` closure
  // is fresh at the moment the event actually arrives.
  const refreshLoadedWindowRef = useRef(refreshLoadedWindow);
  refreshLoadedWindowRef.current = refreshLoadedWindow;

  // Cross-window/cross-screen sync: a payment confirmed/marked erro/undone
  // here, or a payment made/edited/reverted from `PaymentsPage` — in this
  // window or, once "Destacar" is used, another one entirely — broadcasts
  // this event (see `notifyPaymentShiftsChanged` in `db.ts`), and every
  // open reconciliation list refreshes in response.
  useEffect(() => {
    const unlisten = listen(PAYMENT_SHIFTS_CHANGED_EVENT, () => {
      refreshLoadedWindowRef.current().catch(() => {});
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

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

  const visibleRows = useMemo(
    () => rows.filter((r) => r.status !== "pago" || showAudited || !audits.has(r.id)),
    [rows, audits, showAudited],
  );

  // Focus/navigation ranges over every *visible, already-loaded* row, not
  // just the actionable ones — a pendente/erro row (or an already-audited
  // one, once "Mostrar itens já conferidos" is on) can still be selected
  // and arrowed through, same as clicking it; what changes per row is only
  // which actions are enabled once it's focused (see `focusedActionable`/
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
      // Every successful Confirmar is a fresh pendente→confirmado
      // transition — a `pago` row's audit is only ever absent or
      // `confirmado` (see `canConfirm`'s gate below), never `erro`, since
      // Marcar erro always moves the row off `pago` first.
      setPendingCount((prev) => (prev !== null ? Math.max(0, prev - 1) : prev));
      advanceFocusIfHidden(shiftId);
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActingShiftId(null);
    }
  }

  /**
   * "Marcar erro" — unlike Confirmar, this actually transitions the shift
   * (`markPaymentShiftAuditError`: a new `erro` row, same append-only shape
   * `revertPaymentShiftToPending` uses) before recording the audit verdict
   * against that NEW row's id, then refetches so the active filters decide
   * whether it's still visible here — no local patch-and-hide, same as any
   * other status change in this app.
   */
  async function handleErrorSubmit(shift: PaymentShiftReportRow) {
    if (actingShiftId !== null) return;
    setActingShiftId(shift.id);
    setActionError(null);
    try {
      const newShiftId = await markPaymentShiftAuditError(shift.id);
      await recordPaymentAudit(newShiftId, "erro", null);
      await refreshLoadedWindow();
      setFocusedShiftId(newShiftId);
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setActingShiftId(null);
    }
  }

  /**
   * "Desfazer" — clears whichever verdict (confirmado or erro) is currently
   * recorded, back to unaudited. A `confirmado` row was never touched, so
   * clearing the audit alone puts it back exactly as it was; an `erro` row
   * DID transition (see `handleErrorSubmit`), so this first restores `pago`
   * via `undoPaymentShiftAuditError` before clearing the audit, and
   * refetches for the same reason `handleErrorSubmit` does — whether the
   * restored row still matches the active filters isn't this screen's call.
   * Triggered from the row's right-click menu (see `onContextMenu` below)
   * or the U shortcut, not a persistent button.
   */
  async function handleUndoAudit(row: PaymentShiftReportRow) {
    if (actingShiftId !== null) return;
    setActingShiftId(row.id);
    setActionError(null);
    try {
      if (row.status === "erro") {
        const restoredShiftId = await undoPaymentShiftAuditError(row.id);
        await deletePaymentAudit(row.id);
        await refreshLoadedWindow();
        setFocusedShiftId(restoredShiftId);
      } else {
        await deletePaymentAudit(row.id);
        setAudits((prev) => {
          const next = new Map(prev);
          next.delete(row.id);
          return next;
        });
        // Mirror of `handleConfirm`'s decrement — undoing a `confirmado`
        // verdict always puts a `pago` row back into "pendente de
        // conferência" (only a `confirmado` audit ever reaches this branch).
        setPendingCount((prev) => (prev !== null ? prev + 1 : prev));
      }
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
  // ones — see the comment above the focus-reset effect); Y/Enter confirms,
  // N/Backspace marks erro, and U undoes whichever verdict is already
  // recorded on the focused row directly, same as clicking the equivalent
  // button/menu item — all no-ops while the focused row can't take that
  // action. Same scoped attach/detach recipe as PdfViewerModal's own
  // page-navigation shortcuts.
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
      } else if (e.key === "u" || e.key === "U") {
        e.preventDefault();
        if (focusedRow && focusedAudit) handleUndoAudit(focusedRow);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedShiftId, visibleRows, actingShiftId, focusedCanConfirm, focusedCanMarkError, focusedAudit]);

  /**
   * Collapses the title bar + toolbar (everything above the table) away as
   * the list scrolls, leaving only the sticky column-header row — the same
   * "collapsing toolbar" effect Android's `CollapsingToolbarLayout` and a
   * lot of scroll-heavy mobile apps use, so a long conferência list has more
   * room once you're actually scrolling through it.
   *
   * Driven by scroll *delta*, not absolute `scrollTop` — collapsing 1
   * `COLLAPSE_DISTANCE` worth of downward scroll, expanding 1
   * `EXPAND_DISTANCE` worth of upward scroll, from wherever
   * `collapseProgressRef` currently sits. That's what makes "scroll up a
   * little" bring the toolbar back no matter how far down the list you
   * are — tying this to `scrollTop` directly (as an earlier version did)
   * only ever expanded once you scrolled all the way back near the top,
   * since `scrollTop` stays huge everywhere else in a long list. Snapped
   * back to fully expanded outright at `scrollTop <= 0` as a safety net,
   * so drifting delta math can never leave it stuck slightly collapsed
   * right at the top.
   *
   * `rAF`-throttled since `onScroll` fires far more often than a frame
   * needs (the latest `scrollTop` is stashed in a ref between frames so a
   * throttled-away event's position isn't lost, only coalesced), and
   * applied via refs (mutating the DOM directly) rather than `useState` so
   * scrolling doesn't re-render this whole screen every frame.
   *
   * The two bars move as a single rigid unit, not two independently-cropped
   * pieces — `collapsibleInnerRef` (both bars, in normal flow) slides
   * upward via `translateY` by up to its own full natural height
   * (`scrollHeight`, measured fresh each frame — cheap for a two-row
   * header, and `transform` doesn't itself affect layout so this can't
   * self-distort), while the outer `collapsibleRef` shrinks its own
   * `height` by that same amount so the table below reclaims the freed
   * space. An earlier version shrank only the outer height (a CSS
   * grid-rows `1fr` → `0fr` trick) without the matching inner translate —
   * since `overflow: hidden` then clips from the bottom of whatever's
   * inside, that made the *lower* bar (the toolbar) disappear well before
   * the title bar above it had moved at all, instead of both retreating
   * together.
   */
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    latestScrollTopRef.current = e.currentTarget.scrollTop;
    if (collapseRafRef.current) return;
    collapseRafRef.current = requestAnimationFrame(() => {
      collapseRafRef.current = 0;
      const scrollTop = latestScrollTopRef.current;
      const delta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      let progress = collapseProgressRef.current;
      if (scrollTop <= 0) {
        progress = 0;
      } else if (delta > 0) {
        progress = Math.min(1, progress + delta / COLLAPSE_DISTANCE);
      } else if (delta < 0) {
        progress = Math.max(0, progress + delta / EXPAND_DISTANCE);
      }
      collapseProgressRef.current = progress;

      const outer = collapsibleRef.current;
      const inner = collapsibleInnerRef.current;
      if (outer && inner) {
        const naturalHeight = inner.scrollHeight;
        outer.style.height = `${(1 - progress) * naturalHeight}px`;
        outer.style.opacity = String(1 - progress);
        inner.style.transform = `translateY(-${progress * naturalHeight}px)`;
      }
    });
  }

  return (
    <>
      <div ref={collapsibleRef} style={{ overflow: "hidden" }}>
        <div ref={collapsibleInnerRef}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              padding: "0.8rem 1.2rem",
              background: "var(--card-bg)",
              borderBottom: "1px solid var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <strong style={{ fontSize: "0.95rem" }}>Conferência de Pagamentos</strong>
              <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.78rem" }}>
                Atalhos: ↑ / ↓ navegar · Enter ou Y confirmar · Backspace ou N marcar erro · U desfazer · clique direito num item para ver todas as ações
              </p>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.8rem",
              padding: "0.8rem 1.2rem",
              background: "var(--card-bg)",
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
              {pendingCount === null
                ? "Carregando..."
                : pendingCount === 0
                  ? "Tudo conferido"
                  : `${pendingCount} pendente${pendingCount === 1 ? "" : "s"} de conferência`}
            </span>
          </div>
        </div>
      </div>

      {/* No `padding-top` here (only `padding-bottom`, for breathing room
          under the last row) — the table's `thead` is `position: sticky`
          inside this same scrolling container (see `.reconciliation-table`
          in App.css), so any padding placed *before* it would just sit
          there un-stuck, showing through as a gap with no background of its
          own once scrolled — exactly the blurred-desktop seam this avoided.
          The loading/error/empty states below aren't sticky, so they get
          their own `marginTop` instead. */}
      <div style={{ flex: 1, overflow: "auto", paddingBottom: "1.2rem", minHeight: 0 }} onClick={(e) => e.stopPropagation()} onScroll={handleScroll}>
        {listError && <div className="error-box" style={{ margin: "1.2rem 1.2rem 1rem" }}>Não foi possível carregar os pagamentos: {listError}</div>}
        {actionError && <div className="error-box" style={{ margin: "1.2rem 1.2rem 1rem" }}>{actionError}</div>}
        {rowsTotal === null && !listError && <p className="muted" style={{ margin: "1.2rem" }}>Carregando...</p>}
        {rowsTotal !== null && visibleRows.length === 0 && (
          <p className="muted" style={{ margin: "1.2rem" }}>{rowsTotal === 0 ? "Nenhum turno para os filtros selecionados." : "Nada pendente de conferência."}</p>
        )}
        {rowsTotal !== null && visibleRows.length > 0 && (
          <div className="table-scroll">
            <table className="reconciliation-table">
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
                  // Both actions only ever apply to a `pago` row — once
                  // Marcar erro fires, the row's own status moves off
                  // `pago` (see the module doc comment), so `canMarkError`
                  // doubles as "hasn't already been marked erro" without
                  // needing to also check `audit`.
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
                      shortcut: "Enter / Y",
                      disabled: !canConfirm || actingShiftId === r.id,
                      onClick: () => handleConfirm(r.id),
                    },
                    {
                      label: "Marcar erro",
                      shortcut: "Backspace / N",
                      disabled: !canMarkError || actingShiftId === r.id,
                      onClick: () => handleErrorSubmit(r),
                    },
                    {
                      label: "Desfazer",
                      shortcut: "U",
                      disabled: !audit || actingShiftId === r.id,
                      onClick: () => handleUndoAudit(r),
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
            {!exhausted && (
              <div ref={sentinelRef} className="muted" style={{ textAlign: "center", padding: "0.8rem", fontSize: "0.8rem" }}>
                {loadingMore ? "Carregando mais..." : ""}
              </div>
            )}
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
    </>
  );
}
