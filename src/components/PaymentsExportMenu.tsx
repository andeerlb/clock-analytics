import { ChevronDown, Clock3, DollarSign, Download, Loader2, Table2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The one "Exportar" button of Pagamentos, replacing three separate ones:
 * the template export (Excel or PDF, picked in its own drawer) and the two
 * fixed reports, each with a line saying what it produces.
 */
export default function PaymentsExportMenu({
  onTemplateExport,
  onValueReport,
  onShiftReport,
  generatingValueReport,
  generatingShiftReport,
  shiftCount,
}: {
  onTemplateExport: () => void;
  onValueReport: () => void;
  onShiftReport: () => void;
  generatingValueReport: boolean;
  generatingShiftReport: boolean;
  /** How many shifts the current filters match, for the menu title; null while loading. */
  shiftCount: number | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const busy = generatingValueReport || generatingShiftReport;

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(action: () => void) {
    setOpen(false);
    action();
  }

  const items = [
    { key: "template", icon: Table2, title: "Planilha ou PDF com modelo", description: "Escolha o formato e o modelo de exportação.", action: onTemplateExport, busy: false },
    {
      key: "value",
      icon: DollarSign,
      title: "Relatório por valor",
      description: "PDF agrupado pelo valor de cada colaborador.",
      action: onValueReport,
      busy: generatingValueReport,
    },
    {
      key: "shift",
      icon: Clock3,
      title: "Relatório por turno",
      description: "PDF com um turno por linha, com os horários.",
      action: onShiftReport,
      busy: generatingShiftReport,
    },
  ];

  return (
    <div className="zip-split" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="secondary payments-export-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <Loader2 size={15} className="ai-spin" /> : <Download size={15} />}
        {busy ? "Gerando..." : "Exportar"}
        <ChevronDown size={14} strokeWidth={2.4} />
      </button>
      {open && (
        <div className="zip-menu" role="menu">
          <div className="zip-menu-title">
            {shiftCount === null ? "Com os turnos filtrados" : `Com ${shiftCount === 1 ? "o turno filtrado" : `os ${shiftCount} turnos filtrados`}`}
          </div>
          {items.map((item, index) => (
            <div key={item.key}>
              {index === 1 && (
                <>
                  <div className="payments-export-sep" />
                  <div className="zip-menu-title">Relatórios prontos</div>
                </>
              )}
              <button type="button" role="menuitem" className="zip-menu-option" onClick={() => pick(item.action)} disabled={item.busy}>
                <span className="payments-export-icon" aria-hidden="true">
                  {item.busy ? <Loader2 size={15} className="ai-spin" /> : <item.icon size={15} />}
                </span>
                <span className="zip-menu-text">
                  <span className="zip-menu-option-title">{item.title}</span>
                  <span className="zip-menu-option-description">{item.description}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
