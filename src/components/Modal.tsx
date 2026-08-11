import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Shared full-screen overlay recipe — every modal/overlay in the app
 * (`ConfirmModal`, `UpdateModal`, `ExtraColumnsModal`, `ShiftHistoryModal`,
 * `ConfirmPaymentModal`, and — via `fullScreen` — `PdfViewerModal`/
 * `PaymentTemplateWizard`/`EmployeeTemplateWizard`) renders through this
 * instead of hand-rolling its own overlay `<div>`, so the backdrop look and
 * the close/scroll-lock behavior can't drift between them.
 *
 * Portaled to `document.body` (like `EmployeePicker`/`RolePicker`/
 * `ContextMenu`'s popovers) rather than rendered in place: a modal mounted
 * deep in the tree — e.g. `UpdateModal` inside `Sidebar`, itself inside
 * `.app-shell` — only reliably covers the whole viewport and stacks above
 * everything else if it isn't a descendant of any ancestor that might
 * establish its own containing block or stacking context (a `transform`,
 * `filter`, `will-change`, or a positioned+z-indexed element upstream) —
 * `position: fixed` and a high `z-index` alone don't protect against that.
 * A portal sidesteps the question entirely: the overlay is a top-level
 * child of `<body>`, not nested under whatever happened to render it.
 *
 * Locks the page behind it from scrolling while mounted, restoring whatever
 * was there before on unmount, and closes on Escape/backdrop-click (either
 * skippable via `closeOnEscape`/`closeOnBackdrop`, e.g. while a download/save
 * is in flight and closing mid-action would be wrong).
 */
export default function Modal({
  onClose,
  closeOnEscape = true,
  closeOnBackdrop = true,
  width = "28rem",
  maxWidth = "90vw",
  maxHeight,
  /** For a full-screen surface (PDF viewer, template wizard) instead of a small centered card — `children` renders directly inside the overlay, full width/height, with its own internal layout (header + scroll area) and its own backdrop-click handling; `width`/`maxWidth`/`maxHeight` and the `.card` wrapper are skipped entirely. */
  fullScreen = false,
  /** Lower than the default 200 for a `fullScreen` surface — lets a real dialog (`ConfirmModal` etc., still 200) opened from within it stack visually on top instead of the two competing at the same layer. */
  zIndex = 200,
  children,
}: {
  onClose: () => void;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  width?: string;
  maxWidth?: string;
  /** Set alongside `overflowY: "auto"` content inside `children` for a modal whose body can outgrow the viewport (e.g. a long history list) — omitted, the card just grows with its content. */
  maxHeight?: string;
  fullScreen?: boolean;
  zIndex?: number;
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

  if (fullScreen) {
    return createPortal(
      <div className="modal-overlay" style={{ zIndex, flexDirection: "column" }} onClick={closeOnBackdrop ? onClose : undefined}>
        {children}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="modal-overlay" style={{ zIndex }} onClick={closeOnBackdrop ? onClose : undefined}>
      <div
        className="card"
        style={{ width, maxWidth, maxHeight, overflowY: maxHeight ? "auto" : undefined, margin: "1rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
