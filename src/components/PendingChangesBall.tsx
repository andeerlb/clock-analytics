import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { listAllLatestShiftDiffs, type CheckDiffRow } from "../lib/db";
import ChangeDiffPanel from "./ChangeDiffPanel";
import Drawer from "./Drawer";

/**
 * Global "found something" indicator, mounted once at the app root (see
 * `App.tsx`) — bounces whenever the automatic verification has any pending
 * or just-applied change ANYWHERE in the system (see
 * `listAllLatestShiftDiffs`), not just on whatever screen happens to be
 * open right now. Refreshed on the same `trackedFiles` signal
 * `PaymentsPage` already uses to stay live (a fresh reference every time a
 * background check batch finishes). Hidden on the Verificação automática
 * page itself, which already shows all of this in full detail.
 *
 * Clicking opens a read-only summary grouped by colaborador/turno (each
 * card is already one turno — `ChangeDiffPanel`'s own identity grouping
 * does this for free) — the actual "Aceitar"/"Marcar como excluído"
 * actions live on the Pagamentos page, not here.
 */
export default function PendingChangesBall() {
  const location = useLocation();
  const { trackedFiles } = useRemoteFileUpdates();
  const [rows, setRows] = useState<CheckDiffRow[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    listAllLatestShiftDiffs().then(setRows);
  }, [trackedFiles]);

  if (location.pathname === "/remote-updates/imports") return null;
  if (rows.length === 0) return null;

  const pending = rows.filter((r) => !r.applied);
  const applied = rows.filter((r) => r.applied);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${rows.length} mudança${rows.length === 1 ? "" : "s"} encontrada${rows.length === 1 ? "" : "s"} pela verificação automática — clique para revisar`}
        style={{
          position: "fixed",
          right: "1.75rem",
          bottom: "1.75rem",
          zIndex: 100,
          width: 56,
          height: 68,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <span style={{ position: "relative", display: "inline-flex" }}>
          <span className="ball-bounce" style={{ fontSize: "2.2rem", lineHeight: 1, display: "inline-block" }}>
            ⚽
          </span>
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -10,
              minWidth: 19,
              height: 19,
              padding: "0 4px",
              borderRadius: 10,
              fontSize: "0.68rem",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--danger)",
              color: "var(--bg)",
              border: "1.5px solid var(--bg)",
            }}
          >
            {rows.length}
          </span>
        </span>
        <span
          className="ball-bounce-shadow"
          style={{ width: 26, height: 6, borderRadius: "50%", background: "#000", marginTop: 4 }}
        />
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title="Atualizações encontradas">
        <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
          {pending.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                Pendentes ({pending.length})
              </div>
              <ChangeDiffPanel rows={pending} />
            </div>
          )}
          {applied.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                Aplicadas automaticamente ({applied.length})
              </div>
              <ChangeDiffPanel rows={applied} />
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}
