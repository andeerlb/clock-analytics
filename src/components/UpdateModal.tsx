import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import Modal, { useModalClose } from "./Modal";
import { LATEST_RELEASE_URL } from "../lib/updateCheck";

/** "Fechar"/"Depois" buttons, routed through `useModalClose` so they play the same exit animation as Escape/backdrop/header-X instead of unmounting instantly — `requestClose` still resolves to the same `handleClose` passed to `<Modal onClose={handleClose}>` below (so `update.close()` still runs). */
function DismissButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const requestClose = useModalClose();
  return (
    <button type="button" className="outline" onClick={requestClose} disabled={disabled}>
      {label}
    </button>
  );
}

type Phase = "prompt" | "downloading" | "installing" | "error";

/**
 * "Nova versão disponível" — downloads, installs and relaunches in place
 * via the Tauri updater, shared by the Sidebar's passive check and
 * Configurações' "Procurar atualização" button (both just call
 * `checkForUpdate()` and hand the result here).
 *
 * Only works for the bundle types the updater actually knows how to
 * self-replace (AppImage on Linux, msi/nsis on Windows, the .app bundle on
 * macOS) — a .deb/.rpm install still sees this prompt (the manifest only
 * keys by OS/arch, not install method) but `downloadAndInstall` fails
 * there, so any error falls back to the same GitHub release link
 * Configurações always offers, instead of leaving the user stuck.
 */
export default function UpdateModal({ update, onClose }: { update: Update; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({
    downloaded: 0,
    total: null,
  });
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "downloading" || phase === "installing";

  function handleClose() {
    update.close();
    onClose();
  }

  async function handleUpdate() {
    setError(null);
    setPhase("downloading");
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          downloaded = 0;
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress((p) => ({ ...p, downloaded }));
        } else if (event.event === "Finished") {
          setPhase("installing");
        }
      });
      await relaunch();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setPhase("error");
    }
  }

  const progressPct =
    progress.total !== null ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <Modal onClose={handleClose} closeOnEscape={!busy} closeOnBackdrop={!busy}>
      <h3 style={{ marginTop: 0 }}>Nova versão disponível</h3>
      <p className="muted">
        {update.currentVersion} → <strong>{update.version}</strong>
      </p>

      {update.body && (
        <div
          className="muted"
          style={{
            fontSize: "0.9rem",
            whiteSpace: "pre-wrap",
            maxHeight: "60vh",
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "0.8rem 1rem",
            marginBottom: "0.8rem",
          }}
        >
          {update.body}
        </div>
      )}

      {phase === "downloading" && (
        <div style={{ marginTop: "0.6rem" }}>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.4rem" }}>
            Baixando atualização{progressPct !== null ? ` — ${progressPct}%` : "..."}
          </p>
          <div style={{ height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${progressPct ?? 15}%`,
                background: "var(--accent)",
                transition: "width 0.2s ease",
              }}
            />
          </div>
        </div>
      )}
      {phase === "installing" && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Instalando e reiniciando...
        </p>
      )}

      {error && (
        <div className="error-box" style={{ marginTop: "0.8rem" }}>
          Não foi possível atualizar automaticamente ({error}). Baixe a nova versão manualmente no GitHub.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.2rem" }}>
        {phase === "error" ? (
          <>
            <DismissButton label="Fechar" />
            <button type="button" onClick={() => openUrl(LATEST_RELEASE_URL)}>
              Abrir no GitHub
            </button>
          </>
        ) : (
          <>
            <DismissButton label="Depois" disabled={busy} />
            <button type="button" onClick={handleUpdate} disabled={busy}>
              {phase === "downloading" ? "Baixando..." : phase === "installing" ? "Instalando..." : "Atualizar agora"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
