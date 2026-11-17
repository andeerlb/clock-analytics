import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, type LucideIcon } from "lucide-react";

/**
 * The app's side sheet: a floating panel that slides in over the page
 * (12px from the window's edges, rounded, same look as "Atualizações
 * pendentes"). Its header is an icon tile, the title and an optional
 * one-line subtitle — pass `icon`/`subtitle`, or a fully custom `header`.
 * Stays mounted briefly after `open` turns false so the slide-out
 * transition can play before unmounting.
 */
export default function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  width = "min(560px, calc(100vw - 24px))",
  side = "right",
  header,
  className,
  icon: Icon,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Shown in a tile left of the title. */
  icon?: LucideIcon;
  /** Short line under the title, e.g. how many items the sheet lists. */
  subtitle?: ReactNode;
  /** Replaces the plain `title` heading (kept as the accessible name) with richer content, e.g. an icon and a subtitle. */
  header?: ReactNode;
  /** Extra class on the panel, for a screen-specific look. */
  className?: string;
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
    // Backdrop click still dismisses this Drawer (that's the intended
    // behavior), but the event itself doesn't propagate any further — same
    // reasoning as AnchoredPopover/ContextMenu's own stopPropagation, so a
    // Drawer opened from inside a fullScreen Modal doesn't also close that
    // Modal via React's portal-follows-the-component-tree bubbling.
    <div
      className={`drawer-overlay${visible ? " drawer-overlay-visible" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`drawer-panel drawer-panel-${side}${visible ? " drawer-panel-visible" : ""}${className ? ` ${className}` : ""}`}
        style={{ width }}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          {header ?? (
            <div className="drawer-head">
              {Icon && (
                <span className="drawer-head-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
              )}
              <div className="drawer-head-text">
                <span className="drawer-head-title">{title}</span>
                {subtitle && <span className="drawer-head-sub">{subtitle}</span>}
              </div>
            </div>
          )}
          <button type="button" className="ghost drawer-close" onClick={onClose} aria-label="Fechar" title="Fechar">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
