import { useEffect } from "react";

/**
 * Full-screen confirm dialog — same fixed-overlay recipe as
 * `PdfViewerModal`/`PaymentTemplateWizard` (dark backdrop, Escape to
 * cancel, clicking the backdrop cancels, clicking the card doesn't).
 */
export default function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  onConfirm,
  onCancel,
  danger = true,
  confirmDisabled = false,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Styles the confirm button as destructive — on by default, since this component is mainly used for deletions. */
  danger?: boolean;
  confirmDisabled?: boolean;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

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
      onClick={onCancel}
    >
      <div className="card" style={{ maxWidth: "26rem", margin: "1rem" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p className="muted">{message}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.2rem" }}>
          <button type="button" className="outline" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "danger" : undefined}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
