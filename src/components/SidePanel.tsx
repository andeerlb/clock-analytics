import { X, type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Matches `.side-column`'s width transition. */
const TRANSITION_MS = 260;
/** The gap on each side of the panel inside its column (12px left, 12px right), same as the assistant’s. */
const COLUMN_EXTRA = 24;

/**
 * The spot in the app layout, between the page and the assistant, where a
 * page's side panel is mounted. Provided by `AiAssistantProvider`, which
 * owns that layout.
 */
export const SidePanelSlotContext = createContext<HTMLElement | null>(null);

/**
 * A panel docked next to the page, same as the assistant: it takes its own
 * column and pushes the page aside instead of covering it, and stays open
 * until closed. Used for a page's filters, so the results stay visible
 * while they're being changed.
 */
export default function SidePanel({
  open,
  onClose,
  title,
  icon: Icon,
  iconTone,
  badge,
  actions,
  subheader,
  footer,
  children,
  width = 340,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Shown in a tile left of the title, same as the Drawer's header. */
  icon?: LucideIcon;
  /** Tints the icon tile — "danger" for a destructive action. */
  iconTone?: "danger";
  /** Pinned under the header, full width, outside the scrolling body — e.g. which record the panel is about. */
  subheader?: ReactNode;
  /** Short text next to the title, e.g. how many filters are active. */
  badge?: ReactNode;
  /** Extra icon buttons, shown before "Fechar". */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const slot = useContext(SidePanelSlotContext);
  // Stays mounted through the closing slide; `visible` is what drives it.
  const [rendered, setRendered] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    setVisible(false);
    const timeout = setTimeout(() => setRendered(false), TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [open]);

  // The column has to paint once at width 0 before `visible` flips, or the
  // browser merges both and nothing animates (same as the assistant).
  useEffect(() => {
    if (!open || !rendered) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open, rendered]);

  if (!rendered || !slot) return null;

  return createPortal(
    <>
    {/* Phone only (see App.css): the panel opens over the page there, so the page behind is frosted and a tap on it closes the panel. */}
    <div className={visible ? "sheet-scrim sheet-scrim-visible" : "sheet-scrim"} onClick={onClose} aria-hidden="true" />
    <div className={visible ? "side-column side-column-visible" : "side-column"} style={{ width: visible ? width + COLUMN_EXTRA : 0 }}>
      {/* Keys pressed in the panel stay in it: a page's own shortcuts
          (Conferência confirms the selected payment on Enter) must not
          fire from a filter button. */}
      <section className="side-panel" aria-label={title} style={{ width }} onKeyDown={(e) => e.stopPropagation()}>
        <header className="side-panel-header">
          <span className="side-panel-title">
            {Icon && (
              <span className={iconTone === "danger" ? "side-panel-icon side-panel-icon-danger" : "side-panel-icon"} aria-hidden="true">
                <Icon size={15} />
              </span>
            )}
            {title}
            {badge !== undefined && <span className="side-panel-badge">{badge}</span>}
          </span>
          <div className="side-panel-header-actions">
            {actions}
            <button type="button" className="side-panel-icon-button" aria-label="Fechar" title="Fechar" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        {subheader}
        <div className="side-panel-body">{children}</div>
        {footer && <footer className="side-panel-footer">{footer}</footer>}
      </section>
    </div>
    </>,
    slot,
  );
}
