import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { deletePaymentShift, dismissCheckDiffs, listAllLatestShiftDiffs, type CheckDiffRow } from "../lib/db";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import ChangeDiffPanel from "./ChangeDiffPanel";
import Drawer from "./Drawer";

/**
 * "Você tem atualizações pendentes" tab, mounted once at the app root (see
 * `App.tsx`) — glued to the sidebar's right edge (`.sidebar-tab` in
 * App.css), not floating loose over the page. Shows up whenever the
 * automatic verification found ANYTHING on its last pass over ANY tracked
 * URL: a changed field, a possible new turno, a possible removal, an
 * unresolved row, or an error — pending or already auto-applied, anywhere
 * in the system (see `listAllLatestShiftDiffs`), not just on whatever
 * screen happens to be open right now. Refreshed on the same `trackedFiles`
 * signal `PaymentsPage` already uses to stay live (a fresh reference every
 * time a background check batch finishes). Hidden on the Verificação
 * automática page itself, which already shows all of this in full detail.
 *
 * Clicking stretches the tab like a rubber band anchored at the sidebar
 * edge, snaps it back, and fades it out (`.sidebar-tab-spring`) before the
 * Drawer takes over — reappears on its own once the Drawer closes, if
 * `rows` still has anything in it by then. The Drawer itself is grouped by
 * colaborador/turno (each card is already one turno — `ChangeDiffPanel`'s
 * own identity grouping does this for free) and offers the same
 * "Aceitar"/"Marcar como excluído" actions as the Pagamentos page's own
 * review Drawer — no need to go find the row over there just to act on
 * something spotted from here.
 */
export default function PendingChangesTab() {
  const location = useLocation();
  const { trackedFiles, reimportConfigs } = useRemoteFileUpdates();
  const [rows, setRows] = useState<CheckDiffRow[]>([]);
  const [open, setOpen] = useState(false);
  const [springing, setSpringing] = useState(false);

  const [acceptingShiftId, setAcceptingShiftId] = useState<number | null>(null);
  const [acceptedShiftIds, setAcceptedShiftIds] = useState<Set<number>>(new Set());
  const [markingShiftId, setMarkingShiftId] = useState<number | null>(null);
  const [markedShiftIds, setMarkedShiftIds] = useState<Set<number>>(new Set());
  const [dismissingIds, setDismissingIds] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  // A full-screen wizard/modal (e.g. PaymentTemplateWizard — `position:
  // fixed; inset: 0` at the same z-index as this tab) visually covers the
  // sidebar without removing it from the DOM, so measuring the sidebar's
  // own layout wouldn't notice anything changed. Instead this just asks the
  // browser what's actually on top at a point inside where the sidebar
  // would be — if it's not part of `.app-nav`, something is covering it, so
  // the tab glues to the real screen edge instead of the sidebar's (now
  // hidden) one. Polled rather than event-driven since a modal opening
  // doesn't fire any event this could listen for.
  const [sidebarCovered, setSidebarCovered] = useState(false);
  useEffect(() => {
    function checkSidebarCovered() {
      const el = document.elementFromPoint(110, window.innerHeight / 2);
      setSidebarCovered(!el?.closest(".app-nav"));
    }
    checkSidebarCovered();
    const interval = setInterval(checkSidebarCovered, 400);
    window.addEventListener("resize", checkSidebarCovered);
    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", checkSidebarCovered);
    };
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

  function handleClick() {
    setSpringing(true);
    setTimeout(() => {
      setSpringing(false);
      setOpen(true);
    }, 500);
  }

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

  const pending = rows.filter((r) => !r.applied);
  const applied = rows.filter((r) => r.applied);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={handleClick}
          disabled={springing}
          className={`sidebar-tab${springing ? " sidebar-tab-spring" : ""}`}
          title={`Você tem ${unseenRows.length} atualização${unseenRows.length === 1 ? "" : "ões"} pendente${unseenRows.length === 1 ? "" : "s"} — clique para revisar`}
          style={{
            left: sidebarCovered ? 0 : undefined,
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            border: "1px solid var(--border)",
            borderLeft: "none",
            borderRadius: "0 12px 12px 0",
            background: "var(--sidebar-bg)",
            color: "var(--text)",
            padding: "0.55rem 0.8rem 0.55rem 0.6rem",
            cursor: "pointer",
            boxShadow: "0 6px 16px -4px rgba(0, 0, 0, 0.5)",
          }}
        >
          <Bell size={16} style={{ color: "var(--warning)", flexShrink: 0 }} />
          <span
            style={{
              minWidth: 18,
              height: 18,
              padding: "0 4px",
              borderRadius: 9,
              fontSize: "0.7rem",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--danger)",
              color: "var(--bg)",
            }}
          >
            {unseenRows.length}
          </span>
        </button>
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
