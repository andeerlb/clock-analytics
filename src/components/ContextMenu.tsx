import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label?: string;
  onClick?: () => void;
  submenu?: ContextMenuItem[];
  danger?: boolean;
  /** Grays the row out and blocks the click instead of omitting it — for an action that's conceptually always there but not currently possible (e.g. "Fazer pagamento" on a turno with no horário to compute a valor from), so the option stays discoverable instead of the menu silently shrinking depending on the row. */
  disabled?: boolean;
  /** Renders a horizontal divider instead of a row — every other field is ignored when this is set. */
  separator?: boolean;
  /** Fully custom row content (e.g. a color swatch) instead of a plain label — receives `close` to call once its own interaction is done (a color `<input>`'s `onChange`, for instance). Takes precedence over `label`/`onClick` when present. */
  render?: (close: () => void) => ReactNode;
}

const MENU_WIDTH = 220;

/** One level of a (possibly nested) menu — the top-level `ContextMenu` renders this once; a `submenu` item renders another one flush to its own right edge, opened on hover. */
function ContextMenuList({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.15rem",
        background: "var(--card-bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.3rem",
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
        width: MENU_WIDTH,
      }}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} style={{ height: 1, background: "var(--border)", margin: "0.3rem 0" }} />;
        }
        if (item.render) {
          return (
            <div key={i} style={{ padding: "0.35rem 0.6rem" }}>
              {item.render(onClose)}
            </div>
          );
        }
        return (
          <div key={i} style={{ position: "relative" }} onMouseEnter={() => setOpenSubmenu(item.submenu ? i : null)}>
            <button
              type="button"
              className="ghost"
              disabled={item.disabled}
              style={{
                display: "flex",
                width: "100%",
                justifyContent: "space-between",
                alignItems: "center",
                textAlign: "left",
                padding: "0.4rem 0.6rem",
                border: "none",
                color: item.disabled ? "var(--text-muted)" : item.danger ? "var(--danger)" : "inherit",
                opacity: item.disabled ? 0.5 : 1,
                cursor: item.disabled ? "not-allowed" : "pointer",
                pointerEvents: item.disabled ? "none" : undefined,
              }}
              onClick={() => {
                if (item.submenu) return;
                item.onClick?.();
                onClose();
              }}
            >
              <span>{item.label}</span>
              {item.submenu && <span style={{ opacity: 0.6 }}>▸</span>}
            </button>
            {item.submenu && openSubmenu === i && (
              <div style={{ position: "absolute", top: 0, left: "100%" }}>
                <ContextMenuList items={item.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A right-click context menu, portaled to `document.body` and positioned at
 * a fixed page coordinate (`x`/`y` — pass `e.clientX`/`e.clientY` from the
 * triggering `onContextMenu`), closing itself on an outside click, Escape,
 * or scroll — same mechanics as `AnchoredPopover`, just point-anchored
 * instead of element-anchored (a right-click has a cursor position, not an
 * element to measure).
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    // Skip the mousedown that opened this menu (the same physical click as
    // the contextmenu event) by registering on the next tick.
    const id = setTimeout(() => document.addEventListener("mousedown", onMouseDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    function onScroll() {
      onClose();
    }
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - 8);

  return createPortal(
    <div ref={menuRef} style={{ position: "fixed", top, left, zIndex: 1000 }}>
      <ContextMenuList items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}
