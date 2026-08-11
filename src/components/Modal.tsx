import { X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** How long the exit animation (`modal-overlay-out`/`modal-card-out` in App.css) takes to play before the real `onClose` actually fires and unmounts the modal. */
const CLOSE_ANIMATION_MS = 180;

const ModalCloseContext = createContext<() => void>(() => {});

/**
 * Lets a modal's own buttons (a "Cancelar", a header "X", ...) trigger the
 * same animated exit `Modal` itself already plays for Escape/backdrop,
 * instead of calling their `onClose`/`onCancel` prop straight through —
 * which would unmount the modal instantly, skipping the exit transition
 * entirely, since the parent's conditional render (`{open && <Modal/>}`)
 * removes it from the tree the moment that prop fires.
 */
export function useModalClose(): () => void {
  return useContext(ModalCloseContext);
}

/**
 * Render-prop form of `useModalClose`, for a `fullScreen` surface's custom
 * body — one that needs the animated close in more than one spot (a header
 * X, a click-outside-the-content region) and would otherwise need a
 * separate named component per spot just to call the hook at the right
 * position in the tree.
 */
export function ModalClose({ children }: { children: (requestClose: () => void) => ReactNode }) {
  return children(useModalClose());
}

/**
 * Shared full-screen overlay recipe — every modal/overlay in the app
 * (`ConfirmModal`, `UpdateModal`, `ConfirmPaymentModal`, and — via
 * `fullScreen` — `PdfViewerModal`/`PaymentTemplateWizard`/
 * `EmployeeTemplateWizard`) renders through this instead of hand-rolling its
 * own overlay `<div>`, so the backdrop look and the close/scroll-lock
 * behavior can't drift between them. `title`/`footer` add the same bordered
 * header/footer treatment `Drawer` uses — the header's own close (X) button
 * means a modal using them doesn't also need `closeOnBackdrop`/Escape as its
 * only way out.
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
  width = "42rem",
  maxWidth = "90vw",
  maxHeight,
  /** For a full-screen surface (PDF viewer, template wizard) instead of a small centered card — `children` renders directly inside the overlay, full width/height, with its own internal layout (header + scroll area) and its own backdrop-click handling; `width`/`maxWidth`/`maxHeight` and the `.card` wrapper are skipped entirely. */
  fullScreen = false,
  /** Lower than the default 200 for a `fullScreen` surface — lets a real dialog (`ConfirmModal` etc., still 200) opened from within it stack visually on top instead of the two competing at the same layer. */
  zIndex = 200,
  title,
  footer,
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
  /** Renders a bordered header above `children` — the title plus a close (X) button, same recipe `Drawer` already uses — instead of leaving every modal to hand-roll its own `<h3>`+close button with a slightly different look each time. Omit for a modal that wants full control over its own top (e.g. one with no title at all); `children` then renders bare, exactly as before this prop existed. */
  title?: string;
  /** Renders a bordered footer below `children` (typically the Cancelar/Confirmar row) — same border-top/pinned-bottom treatment as `Drawer`'s footer. Only takes effect alongside `title`; a modal not using the structured header has no structured footer either, since the two are meant to bookend the same body region. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [closing, setClosing] = useState(false);

  function requestClose() {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, CLOSE_ANIMATION_MS);
  }

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
      if (e.key === "Escape") requestClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeOnEscape, closing]);

  if (fullScreen) {
    return createPortal(
      // `.modal-overlay`'s own `align-items: center` is right for the small
      // centered card the non-fullScreen path renders, but wrong here: a
      // fullScreen surface's children (header/body/footer, stacked directly
      // — no wrapping div of their own) need to stretch to the overlay's
      // full width, not shrink to their own content width and float
      // centered in a column.
      <div
        className={`modal-overlay${closing ? " modal-overlay-closing" : ""}`}
        style={{ zIndex, flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start" }}
        onClick={closeOnBackdrop ? requestClose : undefined}
      >
        <ModalCloseContext.Provider value={requestClose}>{children}</ModalCloseContext.Provider>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className={`modal-overlay${closing ? " modal-overlay-closing" : ""}`}
      style={{ zIndex }}
      onClick={closeOnBackdrop ? requestClose : undefined}
    >
      <div
        className={`card${closing ? " modal-card-closing" : ""}`}
        style={
          title !== undefined
            ? { width, maxWidth, maxHeight, padding: 0, display: "flex", flexDirection: "column", margin: "1rem" }
            : { width, maxWidth, maxHeight, overflowY: maxHeight ? "auto" : undefined, margin: "1rem" }
        }
        onClick={(e) => e.stopPropagation()}
      >
        <ModalCloseContext.Provider value={requestClose}>
          {title !== undefined ? (
            <>
              <div className="modal-header">
                <h3>{title}</h3>
                <button type="button" className="ghost" onClick={requestClose} aria-label="Fechar">
                  <X size={18} />
                </button>
              </div>
              <div className="modal-body" style={{ overflowY: maxHeight ? "auto" : undefined }}>
                {children}
              </div>
              {footer && <div className="modal-footer">{footer}</div>}
            </>
          ) : (
            children
          )}
        </ModalCloseContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
