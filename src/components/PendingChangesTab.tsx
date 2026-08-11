import { Bell, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { deletePaymentShift, dismissCheckDiffs, listAllLatestShiftDiffs, type CheckDiffRow } from "../lib/db";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import ChangeDiffPanel from "./ChangeDiffPanel";
import Drawer from "./Drawer";

/** `.app-nav`'s own width (App.css) — the floating card can be dragged anywhere EXCEPT over the sidebar; that column is real layout, not an overlay, so this is the one thing that never moves either. */
const SIDEBAR_WIDTH = 220;
/** Minimum gap kept between the card and the sidebar/viewport edges while dragging. */
const CARD_MARGIN = 8;
/** Above a full-screen wizard (PaymentTemplateWizard etc., z-index 100) — the old sidebar-edge tab used to tie with those and could get painted over — but below a real dialog (ConfirmModal/UpdateModal/Drawer's own overlay, z-index 200), which should never have this floating card sitting on top of it. */
const CARD_Z_INDEX = 150;

function clampCardPosition(top: number, left: number, width: number, height: number): { top: number; left: number } {
  const minLeft = SIDEBAR_WIDTH + CARD_MARGIN;
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
 * `handlePointerUp`'s movement threshold). Starts in the top-right corner
 * each fresh session; wherever it's dragged to afterward is where it stays
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
 * one turno — `ChangeDiffPanel`'s own identity grouping does this for free)
 * and offers the same "Aceitar"/"Marcar como excluído" actions as the
 * Pagamentos page's own review Drawer — no need to go find the row over
 * there just to act on something spotted from here.
 */
export default function PendingChangesTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const { trackedFiles, reimportConfigs } = useRemoteFileUpdates();
  const [rows, setRows] = useState<CheckDiffRow[]>([]);
  const [open, setOpen] = useState(false);

  const [acceptingShiftId, setAcceptingShiftId] = useState<number | null>(null);
  const [acceptedShiftIds, setAcceptedShiftIds] = useState<Set<number>>(new Set());
  const [markingShiftId, setMarkingShiftId] = useState<number | null>(null);
  const [markedShiftIds, setMarkedShiftIds] = useState<Set<number>>(new Set());
  const [dismissingIds, setDismissingIds] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  // Drag state — `position` is `null` until the very first drag, meaning
  // "use the CSS top-right default" (`top`/`right` in the style below);
  // once dragged, it switches to explicit pixel `top`/`left` and stays that
  // way for the rest of the session. `isDragging` is only for the cursor
  // style; `dragRef`/`movedRef` don't need to trigger re-renders, so they
  // stay in refs.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
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

  if (location.pathname === "/remote-updates/imports") return null;
  if (unseenRows.length === 0 && !open) return null;

  async function refreshRows() {
    setRows(await listAllLatestShiftDiffs());
  }

  /** Mirrors `PaymentsPage.handleAcceptChange` — re-downloads that shift's own config fresh and writes just this one turno's pending field change (see `acceptShiftChange`). */
  async function handleAccept(shiftId: number) {
    const configId = rows.find((r) => r.matchedShiftId === shiftId && r.changeKind === "field" && !r.applied)?.configId ?? null;
    const config = configId !== null ? reimportConfigs.find((c) => c.id === configId) : undefined;
    if (!config) {
      setActionError("Não foi possível encontrar a configuração de reimportação que encontrou essa mudança — pode ter sido removida.");
      return;
    }
    setAcceptingShiftId(shiftId);
    setActionError(null);
    try {
      await acceptShiftChange(config, shiftId);
      setAcceptedShiftIds((prev) => new Set(prev).add(shiftId));
      await refreshRows();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setAcceptingShiftId(null);
    }
  }

  /** Mirrors `PaymentsPage.handleMarkReviewDeleted` — same soft-delete `deletePaymentShift` uses everywhere else. */
  async function handleMarkDeleted(shiftId: number) {
    setMarkingShiftId(shiftId);
    setActionError(null);
    try {
      await deletePaymentShift(shiftId);
      setMarkedShiftIds((prev) => new Set(prev).add(shiftId));
      await refreshRows();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setMarkingShiftId(null);
    }
  }

  /** "Visto" — acknowledges this card/line's diff rows (see `dismissCheckDiffs`) so it stops counting toward this tab's badge. Never suppresses a future occurrence: a later check finding the same problem again writes a brand-new, undismissed row. */
  async function handleDismiss(rowIds: number[]) {
    setDismissingIds((prev) => new Set([...prev, ...rowIds]));
    setActionError(null);
    try {
      await dismissCheckDiffs(rowIds);
      await refreshRows();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setDismissingIds((prev) => {
        const next = new Set(prev);
        rowIds.forEach((id) => next.delete(id));
        return next;
      });
    }
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

  return (
    <>
      {!open && (
        <div
          ref={cardRef}
          className="pending-changes-card"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          title={`Você tem ${unseenRows.length} atualização${unseenRows.length === 1 ? "" : "ões"} pendente${unseenRows.length === 1 ? "" : "s"} — clique para revisar, ou arraste pra mover`}
          style={{
            position: "fixed",
            zIndex: CARD_Z_INDEX,
            cursor: isDragging ? "grabbing" : "grab",
            ...(position ? { top: position.top, left: position.left } : { top: 16, right: 16 }),
          }}
        >
          <div className="pending-changes-card-icon">
            <Bell size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: "0.86rem" }}>
              {unseenRows.length} atualização{unseenRows.length === 1 ? "" : "ões"} pendente{unseenRows.length === 1 ? "" : "s"}
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
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
          {actionError && <div className="error-box">{actionError}</div>}
          {pending.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                Pendentes ({pending.length})
              </div>
              <ChangeDiffPanel
                rows={pending}
                onAccept={handleAccept}
                acceptingShiftId={acceptingShiftId}
                acceptedShiftIds={acceptedShiftIds}
                onMarkDeleted={handleMarkDeleted}
                markingShiftId={markingShiftId}
                markedShiftIds={markedShiftIds}
                onDismiss={handleDismiss}
                dismissingIds={dismissingIds}
                onReprocess={handleReprocess}
              />
            </div>
          )}
          {applied.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                Aplicadas automaticamente ({applied.length})
              </div>
              <ChangeDiffPanel rows={applied} onDismiss={handleDismiss} dismissingIds={dismissingIds} />
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}
