import { ChevronDown, Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReportMode } from "../contexts/FiltersContext";

const MODES: { id: ReportMode; title: string; description: string; tree: { text: string; file?: boolean }[] }[] = [
  {
    id: "per-employee",
    title: "Um PDF por colaborador",
    description: "Cada espelho em um arquivo próprio.",
    tree: [
      { text: "Empresa/" },
      { text: "  Cliente/" },
      { text: "    Colaborador - período.pdf", file: true },
      { text: "    Colaborador - período.pdf", file: true },
    ],
  },
  {
    id: "per-client",
    title: "Um PDF por cliente",
    description: "Junta os espelhos de cada cliente num único arquivo.",
    tree: [
      { text: "Empresa/" },
      { text: "  Cliente/" },
      { text: "    Cliente - Consolidado.pdf", file: true },
    ],
  },
];

/**
 * "Gerar zip" with the zip layout picked from its own arrow: the menu shows
 * how the folders will look in each mode instead of just naming it.
 */
export default function ZipExportButton({
  mode,
  onModeChange,
  onGenerate,
  busy,
  total,
}: {
  mode: ReportMode;
  onModeChange: (mode: ReportMode) => void;
  onGenerate: () => void;
  busy: boolean;
  /** How many imports the current filters match; null while loading. */
  total: number | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        arrowRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const empty = total === 0;
  let detail = "";
  if (busy) detail = "";
  else if (empty) detail = "Nenhum espelho";
  else if (total !== null) detail = `${total} ${total === 1 ? "espelho" : "espelhos"}`;

  return (
    <div className="zip-split" ref={rootRef}>
      <button type="button" className="zip-split-main" onClick={onGenerate} disabled={busy || empty || total === null}>
        {busy ? <Loader2 size={15} className="ai-spin" /> : <Download size={15} />}
        {busy ? "Gerando..." : "Gerar zip"}
        {detail && <small>{detail}</small>}
      </button>
      <button
        ref={arrowRef}
        type="button"
        className="zip-split-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Como montar o zip"
        title="Como montar o zip"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
      >
        <ChevronDown size={14} strokeWidth={2.4} />
      </button>
      {open && (
        <div className="zip-menu" role="menu">
          <div className="zip-menu-title">Como montar o zip</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m.id}
              className="zip-menu-option"
              onClick={() => {
                onModeChange(m.id);
                setOpen(false);
              }}
            >
              <span className="zip-menu-radio" aria-hidden="true" />
              <span className="zip-menu-text">
                <span className="zip-menu-option-title">{m.title}</span>
                <span className="zip-menu-option-description">{m.description}</span>
                <span className="zip-menu-tree" aria-hidden="true">
                  {m.tree.map((line, i) => (
                    <span key={i} className={line.file ? "zip-menu-tree-file" : undefined}>
                      {line.text}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
