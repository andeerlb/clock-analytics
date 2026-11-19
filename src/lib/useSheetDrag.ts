import { useRef, type PointerEvent } from "react";
import { useMediaQuery } from "./useMediaQuery";

/** Where panels become bottom sheets (see the `max-width: 640px` blocks in App.css). */
export const SHEET_QUERY = "(max-width: 640px)";

/** Dragged at least this far down, the sheet closes on release... */
const CLOSE_DISTANCE_PX = 120;
/** ...or flicked down at least this fast (px/ms). */
const CLOSE_VELOCITY = 0.6;

/**
 * Drag-down-to-close for the panels that open from the bottom on a phone
 * (Drawer, the docked side panel, the assistant). Spread `handlers` on the
 * grab handle and the header; the element in `sheetRef` (the one whose
 * `transform` slides the sheet in) follows the finger, and on release it
 * either closes (`onClose`) or slides back. Presses on buttons, inputs and
 * links are left alone, so the header's own controls keep working. Does
 * nothing on wider screens.
 */
export function useSheetDrag<T extends HTMLElement>(onClose: () => void) {
  const enabled = useMediaQuery(SHEET_QUERY);
  const sheetRef = useRef<T | null>(null);
  const drag = useRef<{ startY: number; startT: number; lastY: number; lastT: number; dy: number } | null>(null);

  function onPointerDown(e: PointerEvent<HTMLElement>) {
    if (!enabled || !sheetRef.current || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='button'], [contenteditable]")) return;
    const now = performance.now();
    drag.current = { startY: e.clientY, startT: now, lastY: e.clientY, lastT: now, dy: 0 };
    sheetRef.current.style.transition = "none";
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    const sheet = sheetRef.current;
    if (!d || !sheet) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    d.lastY = e.clientY;
    d.lastT = performance.now();
    sheet.style.transform = `translateY(${d.dy}px)`;
  }

  function finish(e: PointerEvent<HTMLElement>, cancelled: boolean) {
    const d = drag.current;
    const sheet = sheetRef.current;
    drag.current = null;
    if (!d || !sheet) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const elapsed = Math.max(1, performance.now() - d.startT);
    const fast = d.dy / elapsed >= CLOSE_VELOCITY && d.dy > 24;
    // Hand the position back to the stylesheet with its transition on: it
    // animates from where the finger left it, closed or back in place.
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (!cancelled && (d.dy >= CLOSE_DISTANCE_PX || fast)) onClose();
  }

  return {
    enabled,
    sheetRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: PointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: PointerEvent<HTMLElement>) => finish(e, true),
    },
  };
}
