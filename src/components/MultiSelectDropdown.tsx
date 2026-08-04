import { ListFilter, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface MultiSelectOption<T extends string> {
  id: T;
  label: string;
}

/**
 * A checklist that starts fully selected and narrows down as options are
 * unchecked — the "mostra tudo, tira o que não quer ver" pattern used for
 * both the Cartão de Ponto's per-day filter and the Relatórios per-period
 * and cliente filters. Callers decide what "matches" means for each
 * option; this component only owns the popover/selection UI.
 */
export default function MultiSelectDropdown<T extends string>({
  options,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  icon: Icon = ListFilter,
  allLabel = "Todos selecionados",
  noneLabel = "Nenhum selecionado",
  countLabel,
}: {
  options: MultiSelectOption<T>[];
  selected: Set<T>;
  onToggle: (id: T) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  icon?: LucideIcon;
  allLabel?: string;
  noneLabel?: string;
  countLabel?: (selectedCount: number, total: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const label =
    options.length === 0
      ? noneLabel
      : selected.size === options.length
        ? allLabel
        : selected.size === 0
          ? noneLabel
          : (countLabel ?? ((n, total) => `${n} de ${total}`))(selected.size, options.length);

  return (
    <div style={{ position: "relative" }} ref={rootRef}>
      <button type="button" className="secondary" onClick={() => setOpen((o) => !o)} disabled={options.length === 0}>
        <Icon size={15} style={{ marginRight: "0.4rem" }} />
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 0.4rem)",
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.6rem",
            minWidth: "220px",
            maxHeight: "320px",
            overflowY: "auto",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
            zIndex: 20,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
            <button
              type="button"
              className="ghost"
              style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
              onClick={onSelectAll}
            >
              Selecionar todos
            </button>
            <button
              type="button"
              className="ghost"
              style={{ padding: "0.15rem 0.4rem", fontSize: "0.78rem" }}
              onClick={onSelectNone}
            >
              Limpar
            </button>
          </div>
          {options.map((opt) => (
            <label
              key={opt.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.3rem 0.2rem",
                fontSize: "0.88rem",
                cursor: "pointer",
              }}
            >
              <input type="checkbox" checked={selected.has(opt.id)} onChange={() => onToggle(opt.id)} />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
