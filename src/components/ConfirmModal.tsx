import type { ReactNode } from "react";
import Modal from "./Modal";

/** Full-screen confirm dialog, through the shared `Modal` overlay — Escape/backdrop-click cancels, clicking the card doesn't. */
export default function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  onConfirm,
  onCancel,
  danger = true,
  confirmDisabled = false,
  error,
  children,
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
  /** Shown inside the modal instead of closing it on failure — the caller keeps the modal open (and its own busy/error state) so the user can retry. */
  error?: string | null;
  /** Extra content between the message and the confirm/cancel row — e.g. a follow-up checkbox for a sub-choice tied to this same confirmation. */
  children?: ReactNode;
}) {
  return (
    <Modal onClose={onCancel}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p className="muted">{message}</p>
      {children}
      {error && (
        <div className="error-box" style={{ marginTop: "0.8rem" }}>
          {error}
        </div>
      )}
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
    </Modal>
  );
}
