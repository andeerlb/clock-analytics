import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Slide-in side panel (right or left), with a dimming overlay — the desktop
 * equivalent of a mobile bottom sheet. Stays mounted briefly after `open`
 * turns false so the slide-out transition can play before unmounting.
 */
export default function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  width = "min(460px, 92vw)",
  side = "right",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Rendered below the scrollable body, pinned to the bottom of the panel — for action buttons that should stay reachable without scrolling (e.g. "Aplicar filtros"). Omit for a Drawer with no persistent actions. */
  footer?: ReactNode;
  /** Any valid CSS width — defaults to a comfortable panel on wide windows, nearly full-width on narrow ones. */
  width?: string;
  side?: "left" | "right";
}) {
  const [rendered, setRendered] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    setVisible(false);
    const timeout = setTimeout(() => setRendered(false), 220);
    return () => clearTimeout(timeout);
  }, [open]);

  // Separate effect, keyed on `rendered` rather than `open`: the panel must
  // actually paint once at its off-screen position before the "visible"
  // class flips the transform, or the browser coalesces both into a single
  // paint and the slide-in transition never plays. A single
  // requestAnimationFrame isn't reliably late enough for that first paint to
  // land, so this waits two.
  useEffect(() => {
    if (!open || !rendered) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open, rendered]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Same lock `Modal` uses — without it the page underneath still scrolls
  // with the wheel/trackpad while the Drawer is open, which reads as a bug
  // since the dimmed overlay looks like it should be blocking that.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!rendered) return null;

  // Portaled to `document.body`, same reasoning as `Modal` — a Drawer
  // mounted deep in the tree (e.g. inside `PaymentsPage`) only reliably
  // covers the whole viewport and stacks above everything else this way,
  // not just via `position: fixed` + a high `z-index`.
  return createPortal(
    <div className={`drawer-overlay${visible ? " drawer-overlay-visible" : ""}`} onClick={onClose}>
      <div
        className={`drawer-panel drawer-panel-${side}${visible ? " drawer-panel-visible" : ""}`}
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h3>{title}</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
