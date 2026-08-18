import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Positions `children` via a portal into `document.body`, anchored to
 * `anchorRef`'s on-screen position (`position: fixed`) — shared by every
 * inline popover editor (`DatePicker`, Horário's inline range editor) that
 * needs to escape a table cell's stacking context: a plain nested
 * `position: absolute` popover can end up painted *behind* later table
 * rows, since a `<tr>`/`<td>` doesn't establish the stacking context a
 * naively-nested absolute popover needs to reliably sit on top of later
 * siblings. A portal sidesteps that entirely.
 *
 * Closes itself on a click outside (either the popover or the anchor),
 * Escape, or any *other* scrolling — `true` on the scroll listener catches
 * any scrollable ancestor (usually `.table-scroll`, not the page itself),
 * since a detached popover that no longer lines up with its trigger is
 * worse than just closing. Scrolling *inside the popover's own content*
 * (e.g. `MultiSelectDropdown`'s checkbox list, once it's got enough options
 * to need its own `overflow-y: auto`) is excluded from that, or the
 * popover would slam shut the moment you tried to scroll through it.
 */
export default function AnchoredPopover({
  anchorRef,
  width,
  align = "left",
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  width: number;
  /** Which edge of the anchor the popover's own edge lines up with — "left" (default) for a trigger near a container's left edge; "right" keeps the popover from overflowing past a container's right edge when the trigger itself sits near that edge (e.g. a toolbar's last button). */
  align?: "left" | "right";
  onClose: () => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = align === "right" ? rect.right - width : rect.left;
    setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [anchorRef, width, align]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClose, anchorRef]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    function onScroll(e: Event) {
      if (popoverRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [onClose]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={popoverRef}
      // React bubbles portaled events through the *component* tree, not the
      // DOM tree — without this, a click inside the popover still reaches
      // whatever onClick a real DOM ancestor further up the JSX (e.g. a
      // fullScreen Modal's backdrop-click-to-close) happens to have, even
      // though this div isn't actually nested inside it in the DOM.
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: `${width}px`,
        background: "var(--card-bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "0.7rem",
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
        zIndex: 1000,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
