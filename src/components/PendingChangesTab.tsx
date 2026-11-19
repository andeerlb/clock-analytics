import { Bell, CheckCheck, ChevronDown, ChevronRight, Clock3 } from "lucide-react";
import { OPEN_PENDING_CHANGES_EVENT, setPendingChangesCount } from "../lib/pendingChanges";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAccess } from "../contexts/AuthContext";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { deletePaymentShift, dismissCheckDiffs, listAllLatestShiftDiffs, type CheckDiffRow } from "../lib/db";
import { formatCountdown, formatDateAbbrevYY, formatDateTime, formatPersonName, parseSqliteDateTime, resolveReimportConfigLabel } from "../lib/format";
import { READ_ONLY_TITLE } from "./AreaRoute";
import ChangeCards from "./ChangeCards";
import ConfirmModal from "./ConfirmModal";
import Drawer from "./Drawer";

/** Measured, since the sidebar can be collapsed. The floating card can be dragged anywhere EXCEPT over it: that column is real layout, not an overlay. */
function sidebarWidth(): number {
  return document.querySelector(".app-nav")?.getBoundingClientRect().width ?? 220;
}
/** Minimum gap kept between the card and the sidebar/viewport edges while dragging. */
const CARD_MARGIN = 8;
/** Above a full-screen wizard (PaymentTemplateWizard etc., z-index 100) — the old sidebar-edge tab used to tie with those and could get painted over — but below a real dialog (ConfirmModal/UpdateModal/Drawer's own overlay, z-index 200), which should never have this floating card sitting on top of it. */
const CARD_Z_INDEX = 150;

function clampCardPosition(top: number, left: number, width: number, height: number): { top: number; left: number } {
  const minLeft = sidebarWidth() + CARD_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - CARD_MARGIN);
  const minTop = CARD_MARGIN;
  const maxTop = Math.max(minTop, window.innerHeight - height - CARD_MARGIN);
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  };
}

/**
 * "Você tem atualizações pendentes" card, mounted once at the app root (see
 * `App.tsx`) — floats freely over the page (drag it anywhere by the card
 * itself; a plain click, no real movement, opens the Drawer instead — see
 * `handlePointerUp`'s movement threshold). Starts at the bottom, just
 * right of the sidebar, each fresh session (out of the way of page headers
 * and their actions); wherever it's dragged to afterward is where it stays
 * until the app restarts (position lives in plain component state, not
 * persisted). Can't be dragged over the sidebar — that's real layout, not
 * something floating over it — and always renders above every modal in the
 * app (`CARD_Z_INDEX`), including a full-screen wizard, which the OLD
 * sidebar-edge version could end up painted under.
 *
 * Shows up whenever the automatic verification found ANYTHING on its last
 * pass over ANY tracked URL: a changed field, a possible new turno, a
 * possible removal, an unresolved row, or an error — pending or already
 * auto-applied, anywhere in the system (see `listAllLatestShiftDiffs`), not
 * just on whatever screen happens to be open right now. Refreshed on the
 * same `trackedFiles` signal `PaymentsPage` already uses to stay live (a
 * fresh reference every time a background check batch finishes). Hidden on
 * the Verificação automática page itself, which already shows all of this
 * in full detail — and, same as before, hides entirely once nothing's
 * unseen (unless the Drawer is already open, which then just stays open).
 *
 * The Drawer itself is grouped by colaborador/turno (each card is already
 * one turno — the same `ChangeCards` Verificação automática uses)
 * and offers the same "Aceitar"/"Marcar como excluído" actions as the
 * Pagamentos page's own review Drawer — no need to go find the row over
 * there just to act on something spotted from here.
 */
export default function PendingChangesTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const { trackedFiles, reimportConfigs, checkingConfigIds } = useRemoteFileUpdates();
  // Not inside an AreaRoute: viewing is open to anyone who gets here, but
  // "Visto" needs "Editar" in Verificação automática or Pagamentos, and
  // accepting/deleting/reimporting needs "Editar" in Pagamentos.
  const { canEdit } = useAccess();
  const canChange = canEdit("pagamentos");
  const canDismiss = canChange || canEdit("verificacao");
  const dismissTitle = canDismiss ? undefined : READ_ONLY_TITLE;
  const [rows, setRows] = useState<CheckDiffRow[]>([]);
  const [open, setOpen] = useState(false);

  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [deleteShiftTarget, setDeleteShiftTarget] = useState<{ shiftId: number; who: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Drag state — `position` is `null` until the very first drag, meaning
  // "use the bottom-left default" (`bottom`/`left` in the style below);
  // once dragged, it switches to explicit pixel `top`/`left` and stays that
  // way for the rest of the session. `isDragging` is only for the cursor
  // style; `dragRef`/`movedRef` don't need to trigger re-renders, so they
  // stay in refs.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // The default spot is just right of the sidebar, at the bottom — kept in
  // sync with the sidebar's width, since it can be collapsed.
  const [navWidth, setNavWidth] = useState(sidebarWidth);
  useEffect(() => {
    const nav = document.querySelector(".app-nav");
    if (!nav) return;
    const observer = new ResizeObserver(() => setNavWidth(sidebarWidth()));
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; cardLeft: number; cardTop: number } | null>(null);
  const movedRef = useRef(false);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    movedRef.current = false;
    dragStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, cardLeft: rect.left, cardTop: rect.top };
    setIsDragging(true);
    el.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    const el = cardRef.current;
    if (!start || !el) return;
    const dx = e.clientX - start.pointerX;
    const dy = e.clientY - start.pointerY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    const rect = el.getBoundingClientRect();
    setPosition(clampCardPosition(start.cardTop + dy, start.cardLeft + dx, rect.width, rect.height));
  }

  function handlePointerUp() {
    setIsDragging(false);
    dragStartRef.current = null;
    if (!movedRef.current) setOpen(true);
  }

  // Re-clamps after a window resize — a position saved before shrinking the
  // window could otherwise land off-screen or over the sidebar.
  useEffect(() => {
    function handleResize() {
      const el = cardRef.current;
      if (!el) return;
      setPosition((prev) => {
        if (!prev) return prev;
        const rect = el.getBoundingClientRect();
        return clampCardPosition(prev.top, prev.left, rect.width, rect.height);
      });
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    listAllLatestShiftDiffs().then(setRows);
  }, [trackedFiles]);

  // Dismissing ("Visto") never removes a row from `rows` — it stays
  // browsable in the Drawer below — it only stops counting toward this
  // tab's own badge/alert, computed here from the unseen subset. If
  // everything's already been seen, the floating tab itself hides (nothing
  // new to alert about) UNLESS the Drawer is already open, in which case it
  // stays open rather than yanking itself shut mid-review.
  const unseenRows = rows.filter((r) => r.dismissedAt === null);

  // The phone menu shows this number (the floating card is hidden there)
  // and opens the review Drawer through an event.
  useEffect(() => {
    setPendingChangesCount(unseenRows.length);
  }, [unseenRows.length]);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_PENDING_CHANGES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PENDING_CHANGES_EVENT, onOpen);
  }, []);

  if (location.pathname === "/remote-updates/imports") return null;
  if (unseenRows.length === 0 && !open) return null;

  async function refreshRows() {
    setRows(await listAllLatestShiftDiffs());
  }

  /** Runs a card/group action with `key` marked busy, then reloads the list. */
  async function run(key: string, action: () => Promise<void>) {
    setBusyKeys((prev) => new Set(prev).add(key));
    setActionError(null);
    try {
      await action();
      await refreshRows();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleDeleteShift() {
    if (!deleteShiftTarget) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deletePaymentShift(deleteShiftTarget.shiftId);
      await refreshRows();
      setDeleteShiftTarget(null);
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setDeleting(false);
    }
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** "Reprocessar agora" on an 'unresolved' card — closes this Drawer first since the navigation takes over the screen anyway. */
  function handleReprocess(configId: number, periodStart: string | null, periodEnd: string | null) {
    setOpen(false);
    navigate("/import/payments", {
      state: { autoReimportConfigId: configId, autoReimportPeriodStart: periodStart, autoReimportPeriodEnd: periodEnd },
    });
  }

  const pending = rows.filter((r) => !r.applied);
  const applied = rows.filter((r) => r.applied);
  const dismissingAll = busyKeys.has("all");

  function renderGroups(groupRows: CheckDiffRow[], appliedGroup = false) {
    const groups = new Map<string, CheckDiffRow[]>();
    for (const row of groupRows) {
      const key = `${row.checkLogId}:${row.configId ?? "file"}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const sortedGroups = Array.from(groups.entries()).sort(([, a], [, b]) => {
      const priority = (entries: CheckDiffRow[]) => {
        if (entries.some((row) => row.changeKind === "error")) return 0;
        if (entries.some((row) => row.dismissedAt === null)) return 1;
        return 2;
      };
      return priority(a) - priority(b) || b[0].checkLogId - a[0].checkLogId;
    });

    return sortedGroups.map(([key, entries]) => {
      const first = entries[0];
      const config = first.configId === null ? undefined : reimportConfigs.find((item) => item.id === first.configId);
      const trackedFile = trackedFiles.find((item) => item.sourceUrl === first.sourceUrl);
      const fileName = trackedFile?.fileName || (() => {
        try { return decodeURIComponent(new URL(first.sourceUrl).pathname.split("/").pop() || "Arquivo rastreado"); }
        catch { return "Arquivo rastreado"; }
      })();
      const ruleLabel = config ? resolveReimportConfigLabel(config) : first.configLabel || "Verificação do arquivo";
      const period = first.periodStart && first.periodStart === first.periodEnd
        ? formatDateAbbrevYY(first.periodStart)
        : first.periodStart || first.periodEnd
          ? `${first.periodStart ? formatDateAbbrevYY(first.periodStart) : "início"} – ${first.periodEnd ? formatDateAbbrevYY(first.periodEnd) : "hoje"}`
          : "Todo o relatório";
      const nextAt = config && !config.checkDisabled
        ? (config.lastCheckedAt ? parseSqliteDateTime(config.lastCheckedAt).getTime() + config.checkIntervalMinutes * 60_000 : now)
        : null;
      const isChecking = config
        ? checkingConfigIds.has(config.id)
        : reimportConfigs.some((item) => item.sourceUrl === first.sourceUrl && checkingConfigIds.has(item.id));
      const groupUnseen = entries.filter((row) => row.dismissedAt === null);
      const groupSeenCount = entries.length - groupUnseen.length;
      const dismissingGroup = busyKeys.has(`g${key}`);
      const collapsed = collapsedGroups.has(key);
      const lastCheckTitle = config?.lastCheckedAt
        ? `Última análise: ${formatDateTime(config.lastCheckedAt)}`
        : "Esta configuração ainda não foi analisada";

      return (
        <section key={key} className="pc-group">
          <div className="pc-group-head">
            <button type="button" className="pc-group-toggle" onClick={() => toggleGroup(key)} aria-expanded={!collapsed}>
              <span className={/\.xlsx?$/i.test(fileName) ? "rv-file-ico" : "rv-file-ico rv-file-ico-other"} aria-hidden="true">
                {/\.(\w{2,4})$/.exec(fileName)?.[1].toUpperCase().slice(0, 3) ?? "URL"}
              </span>
              <span className="rv-text">
                <span className="pc-group-title">{fileName}</span>
                <span className="rv-small">
                  {ruleLabel} · {period}
                </span>
              </span>
              <span className={`rv-tag ${groupUnseen.length > 0 ? (appliedGroup ? "rv-tag-auto" : "rv-tag-alt") : "rv-tag-who"}`}>
                {groupUnseen.length > 0 ? `${groupUnseen.length} ${appliedGroup ? (groupUnseen.length === 1 ? "nova" : "novas") : groupUnseen.length === 1 ? "pendente" : "pendentes"}` : "Tudo visto"}
              </span>
              <ChevronDown size={15} className="pc-group-chevron" style={{ transform: collapsed ? "rotate(-90deg)" : undefined }} aria-hidden="true" />
            </button>
            <div className="pc-group-meta">
              <span title={lastCheckTitle} className={nextAt === null ? "pc-next pc-next-off" : "pc-next"}>
                <Clock3 size={12} />
                {isChecking ? "Conferindo agora…" : config?.checkDisabled ? "Conferência pausada" : nextAt === null ? "Sem próxima conferência" : `Próxima conferência em ${formatCountdown(nextAt - now)}`}
              </span>
              {groupSeenCount > 0 && groupUnseen.length > 0 && (
                <span className="rv-small">
                  {groupSeenCount} {groupSeenCount === 1 ? "vista" : "vistas"}
                </span>
              )}
              {groupUnseen.length > 0 && (
                <button
                  type="button"
                  className="settings-button settings-button-ghost pc-seen"
                  disabled={!canDismiss || dismissingGroup}
                  title={dismissTitle}
                  onClick={() => run(`g${key}`, () => dismissCheckDiffs(groupUnseen.map((row) => row.id)))}
                >
                  <CheckCheck size={13} /> {dismissingGroup ? "Marcando…" : "Marcar como visto"}
                </button>
              )}
            </div>
          </div>
          {!collapsed && (
            <div className="pc-group-body">
              <ChangeCards
                rows={entries}
                keyPrefix={`${key}:`}
                configFor={() => config}
                stateOf={(cardRows) =>
                  appliedGroup || cardRows.every((r) => r.applied) ? "applied" : cardRows.every((r) => r.dismissedAt !== null) ? "seen" : "pending"
                }
                canDismiss={canDismiss}
                canChange={canChange}
                busyKeys={busyKeys}
                run={run}
                onDeleteShift={setDeleteShiftTarget}
                onReprocess={handleReprocess}
              />
            </div>
          )}
        </section>
      );
    });
  }

  return (
    <>
      {!open && (
        <div
          ref={cardRef}
          className="pending-changes-card"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          title={`Você tem ${unseenRows.length} ${unseenRows.length === 1 ? "atualização pendente" : "atualizações pendentes"} — clique para revisar, ou arraste pra mover`}
          style={{
            position: "fixed",
            zIndex: CARD_Z_INDEX,
            cursor: isDragging ? "grabbing" : "grab",
            ...(position ? { top: position.top, left: position.left } : { bottom: 16, left: navWidth + 16 }),
          }}
        >
          <div className="pending-changes-card-icon">
            <Bell size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: "0.86rem" }}>
              {unseenRows.length} {unseenRows.length === 1 ? "atualização pendente" : "atualizações pendentes"}
            </div>
            <div className="muted" style={{ fontSize: "0.66rem", fontWeight: 700, letterSpacing: "0.05em", marginTop: "1px" }}>
              CLIQUE PARA REVISAR
            </div>
          </div>
          <ChevronRight size={16} className="muted" style={{ flexShrink: 0 }} />
        </div>
      )}

      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
          setActionError(null);
        }}
        title="Atualizações pendentes"
        width="min(480px, calc(100vw - 24px))"
        header={
          <div className="rv-drawer-head">
            <span className="pc-head-icon" aria-hidden="true">
              <Bell size={16} />
            </span>
            <div className="rv-text">
              <span className="rv-drawer-title">Atualizações pendentes</span>
              <span className="rv-drawer-sub">
                {unseenRows.length ? `${unseenRows.length} ${unseenRows.length === 1 ? "nova" : "novas"} nas planilhas acompanhadas` : "Tudo visto"}
              </span>
            </div>
          </div>
        }
        footer={
          <>
            <span className="rv-footer-note" />
            <button type="button" className="settings-button settings-button-primary" disabled={!canDismiss || dismissingAll || unseenRows.length === 0} title={dismissTitle} onClick={() => run("all", () => dismissCheckDiffs(unseenRows.map((row) => row.id)))}>
              <CheckCheck size={13} /> {dismissingAll ? "Marcando…" : `Marcar tudo como visto (${unseenRows.length})`}
            </button>
          </>
        }
      >
        <div className="pc-body">
          {actionError && <div className="error-box">{actionError}</div>}
          {pending.length > 0 && (
            <section className="pc-section">
              <span className="rv-section-label">Para revisar</span>
              {renderGroups(pending)}
            </section>
          )}
          {applied.length > 0 && (
            <section className="pc-section">
              <span className="rv-section-label">Aplicadas sozinho</span>
              {renderGroups(applied, true)}
            </section>
          )}
        </div>
      </Drawer>
      {deleteShiftTarget && (
        <ConfirmModal
          title="Excluir este turno?"
          message={`O turno${deleteShiftTarget.who ? ` de ${formatPersonName(deleteShiftTarget.who)}` : ""} saiu da planilha e vai ser excluído do Tá Pago também.`}
          confirmLabel={deleting ? "Excluindo..." : "Excluir turno"}
          confirmDisabled={deleting}
          onConfirm={handleDeleteShift}
          onCancel={() => setDeleteShiftTarget(null)}
        />
      )}
    </>
  );
}
