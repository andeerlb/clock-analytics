import { openUrl } from "@tauri-apps/plugin-opener";
import { Link2 } from "lucide-react";
import Modal from "./Modal";

/**
 * Read-only look at a payment shift's unmapped columns — whatever the
 * template left as "Ignorar", kept at import time instead of discarded
 * (see `AppliedPaymentRow.extraFields`/`payment_shifts.extra_data`). No
 * fetch needed — the data's already on the row, this just displays it.
 */
export default function ExtraColumnsModal({
  data,
  sourceUrl,
  onClose,
}: {
  /** `null` keeps the modal unmounted/closed. */
  data: Record<string, string> | null;
  /** Only set when this shift came from a tracked URL import — turns the "Arquivo de origem" row into a link to it. A locally-picked file has no URL to link to, so that row just stays plain text. */
  sourceUrl: string | null;
  onClose: () => void;
}) {
  if (!data) return null;

  // Lexicographic order alone misorders past column Z ("AA" < "B") — sort
  // by letter count first so single-letter columns come before double.
  const entries = Object.entries(data).sort(([a], [b]) => a.length - b.length || a.localeCompare(b));

  function labelFor(key: string): string {
    if (/^[A-Z]+$/i.test(key)) return `Coluna ${key}`;
    if (key === "arquivo de origem") return "Arquivo de origem";
    if (key === "aba de origem") return "Aba de origem";
    if (key === "linha de origem") return "Linha de origem";
    return key;
  }

  return (
    <Modal onClose={onClose} width="26rem" maxHeight="80vh">
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
            {labelFor(letter)}
          </span>
          {letter === "arquivo de origem" && sourceUrl ? (
            <button
              type="button"
              className="link-button"
              onClick={() => openUrl(sourceUrl)}
              title={sourceUrl}
              style={{ display: "flex", alignItems: "center", gap: "0.3rem", textAlign: "right" }}
            >
              <Link2 size={12} style={{ flexShrink: 0 }} />
              {value}
            </button>
          ) : (
            <span style={{ textAlign: "right" }}>{value}</span>
          )}
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.2rem" }}>
        <button type="button" className="outline" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}
