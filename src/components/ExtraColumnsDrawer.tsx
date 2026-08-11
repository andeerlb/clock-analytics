import { openUrl } from "@tauri-apps/plugin-opener";
import { Link2 } from "lucide-react";
import Drawer from "./Drawer";

/**
 * Read-only look at a payment shift's unmapped columns — whatever the
 * template left as "Ignorar", kept at import time instead of discarded
 * (see `AppliedPaymentRow.extraFields`/`payment_shifts.extra_data`). No
 * fetch needed — the data's already on the row, this just displays it.
 */
export default function ExtraColumnsDrawer({
  open,
  data,
  sourceUrl,
  onClose,
}: {
  open: boolean;
  /** `null` while the Drawer is closed/closing. */
  data: Record<string, string> | null;
  /** Only set when this shift came from a tracked URL import — turns the "Arquivo de origem" row into a link to it. A locally-picked file has no URL to link to, so that row just stays plain text. */
  sourceUrl: string | null;
  onClose: () => void;
}) {
  // Lexicographic order alone misorders past column Z ("AA" < "B") — sort
  // by letter count first so single-letter columns come before double.
  const entries = data ? Object.entries(data).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)) : [];

  function labelFor(key: string): string {
    if (/^[A-Z]+$/i.test(key)) return `Coluna ${key}`;
    if (key === "arquivo de origem") return "Arquivo de origem";
    if (key === "aba de origem") return "Aba de origem";
    if (key === "linha de origem") return "Linha de origem";
    return key;
  }

  return (
    <Drawer open={open} onClose={onClose} title="Colunas não mapeadas">
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
        Valores lidos do arquivo original em colunas que o template não usa — guardados aqui só para consulta.
      </p>
      {entries.map(([letter, value]) => (
        <div
          key={letter}
          className="drawer-detail-row"
          style={{ display: "flex", justifyContent: "space-between", gap: "1rem", paddingTop: "0.4rem", paddingBottom: "0.4rem" }}
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
    </Drawer>
  );
}
