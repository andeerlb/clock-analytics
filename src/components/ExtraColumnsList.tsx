import type { ExtraColumnEntry } from "../lib/extraColumns";

/**
 * "Outras colunas da planilha": one line per column the template left
 * unmapped — its letter, its header (or "Coluna E" in grey when the file had
 * none) and its value. Shared by the Extras hover card in Pagamentos and the
 * turno panel's Dados tab, so both read the same.
 */
export default function ExtraColumnsList({ entries }: { entries: ExtraColumnEntry[] }) {
  return (
    <span className="xcol-list">
      {entries.map((e) => (
        <span key={e.key} className="xcol-row">
          <span className="xcol-letter">{e.letter ?? "·"}</span>
          <span className={e.header ? "xcol-name" : "xcol-name xcol-name-unknown"}>{e.header ?? `Coluna ${e.letter}`}</span>
          <span className="xcol-value">{e.value}</span>
        </span>
      ))}
    </span>
  );
}
