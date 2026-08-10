import { useEffect, type ReactNode } from "react";

/**
 * Shared full-screen overlay recipe — dark backdrop, centered card, Escape
 * and backdrop-click to close (either skippable via `closeOnEscape`/
 * `closeOnBackdrop`, e.g. while a download/save is in flight and closing
 * mid-action would be wrong). Locks the page behind it from scrolling while
 * mounted, restoring whatever was there before on unmount — the one thing
 * every hand-rolled overlay in this codebase (`ConfirmModal`, `UpdateModal`,
 * etc.) has been skipping.
 */
export default function Modal({
  onClose,
  closeOnEscape = true,
  closeOnBackdrop = true,
  width = "28rem",
  maxWidth = "90vw",
  children,
}: {
  onClose: () => void;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  width?: string;
  maxWidth?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (!closeOnEscape) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape, onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div className="card" style={{ width, maxWidth, margin: "1rem" }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
