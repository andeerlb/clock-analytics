import { useEffect } from "react";

/**
 * Read-only look at a payment shift's unmapped columns — whatever the
 * template left as "Ignorar", kept at import time instead of discarded
 * (see `AppliedPaymentRow.extraFields`/`payment_shifts.extra_data`). No
 * fetch needed — the data's already on the row, this just displays it.
 */
export default function ExtraColumnsModal({
  data,
  onClose,
}: {
  /** `null` keeps the modal unmounted/closed. */
  data: Record<string, string> | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!data) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [data, onClose]);

  if (!data) return null;

  // Lexicographic order alone misorders past column Z ("AA" < "B") — sort
  // by letter count first so single-letter columns come before double.
  const entries = Object.entries(data).sort(([a], [b]) => a.length - b.length || a.localeCompare(b));

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
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: "26rem", margin: "1rem", maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Colunas não mapeadas</h3>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Valores lidos do arquivo original em colunas que o template não usa — guardados aqui só
          para consulta.
        </p>
        {entries.map(([letter, value]) => (
          <div
            key={letter}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              padding: "0.4rem 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              Coluna {letter}
            </span>
            <span style={{ textAlign: "right" }}>{value}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.2rem" }}>
          <button type="button" className="outline" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
