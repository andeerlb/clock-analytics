import { Columns3, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface PickerColumn {
  id: string;
  /** Full name, as listed in the picker. */
  name: string;
  group: string;
  /** An example of what the column shows. */
  sample: string;
  /** Always on; shown with "Sempre" instead of a switch. */
  locked?: boolean;
}

/**
 * Which columns a table shows: grouped switches with an example of each
 * column's content, "Restaurar padrão" and "Mostrar todas" in the footer.
 */
export default function ColumnPicker({
  columns,
  visible,
  defaults,
  onChange,
}: {
  columns: PickerColumn[];
  visible: Set<string>;
  defaults: string[];
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  const shownCount = columns.filter((c) => visible.has(c.id)).length;
  const isDefault = defaults.length === shownCount && defaults.every((id) => visible.has(id));
  const locked = columns.filter((c) => c.locked).map((c) => c.id);

  function toggle(id: string) {
    const next = new Set(visible);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  let lastGroup: string | null = null;

  return (
    <div className="column-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="column-picker-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Columns3 size={14} />
        Colunas
        <span className="column-picker-count">
          {shownCount} de {columns.length}
        </span>
      </button>
      {open && (
        <div className="column-picker-box" role="dialog" aria-label="Colunas da tabela">
          <div className="column-picker-head">
            <strong>Colunas da tabela</strong>
            <span>
              {shownCount} de {columns.length} visíveis
            </span>
          </div>
          <div className="column-picker-list">
            {columns.map((c) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              const on = visible.has(c.id);
              return (
                <div key={c.id}>
                  {header && <div className="emp-picker-section">{header}</div>}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-disabled={c.locked || undefined}
                    className={c.locked ? "column-picker-option column-picker-option-locked" : "column-picker-option"}
                    onClick={() => !c.locked && toggle(c.id)}
                  >
                    <span className="column-picker-text">
                      <span className="column-picker-name">{c.name}</span>
                      <span className="column-picker-sample">{c.sample}</span>
                    </span>
                    {c.locked ? (
                      <span className="column-picker-lock">
                        <Lock size={11} />
                        Sempre
                      </span>
                    ) : (
                      <span className="column-picker-switch" aria-hidden="true" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="emp-picker-footer">
            <span className="picker-footer-actions">
              <button type="button" className="emp-picker-clear" onClick={() => onChange(new Set([...defaults, ...locked]))} disabled={isDefault}>
                Restaurar padrão
              </button>
              <button type="button" className="emp-picker-clear" onClick={() => onChange(new Set(columns.map((c) => c.id)))} disabled={shownCount === columns.length}>
                Mostrar todas
              </button>
            </span>
            <button
              type="button"
              className="emp-picker-done"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              Pronto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
