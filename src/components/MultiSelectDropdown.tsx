import { ListFilter, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import AnchoredPopover from "./AnchoredPopover";

export interface MultiSelectOption<T extends string> {
  id: T;
  label: string;
}

/** Fixed popover width — see `AnchoredPopover`'s own `width` prop. Wide enough for this component's column/status-style labels without feeling cramped. */
const POPOVER_WIDTH = 220;

/**
 * A checklist that starts fully selected and narrows down as options are
 * unchecked — used for the employee detail page's per-day filter and the
 * Cartão Ponto list's empresa/cliente/período/status filters. Callers
 * decide what "matches" means for each option (and whether narrowing is an
 * inclusive OR over what's checked, or a plain "must be one of these" for a
 * single-valued field like empresa/cliente); this component only owns the
 * popover/selection UI.
 *
 * The popover itself is an `AnchoredPopover` (portaled to `document.body`,
 * positioned off the trigger's own on-screen rect) rather than a plain
 * nested `position: absolute` child — a trigger placed inside any
 * `overflow: hidden`/`auto` ancestor (e.g. `PaymentReconciliationScreen`'s
 * collapsing toolbar) would otherwise clip the popover the moment it grew
 * past that ancestor's bounds, instead of floating freely above the page.
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
  align = "right",
  fullWidth = false,
  showIcon = true,
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
  /** Which edge the popover hangs from — "right" (default) suits a trigger near a row's right edge; "left" keeps it from overflowing past a container's left edge when the trigger itself sits near that edge (e.g. inside a narrow Drawer). */
  align?: "left" | "right";
  /** Stretches the trigger button to fill its container instead of sizing to its label text — for a field that should visually fill its row/cell (e.g. inside a Drawer's field grid), as opposed to sitting inline in a toolbar. */
  fullWidth?: boolean;
  /** Hides the icon inside the trigger — for callers that show it next to the field's own label instead. */
  showIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label =
    options.length === 0
      ? noneLabel
      : selected.size === options.length
        ? allLabel
        : selected.size === 0
          ? noneLabel
          : (countLabel ?? ((n, total) => `${n} de ${total}`))(selected.size, options.length);

  return (
    <div style={fullWidth ? { width: "100%" } : { display: "inline-block", alignSelf: "flex-start" }}>
      <button
        ref={triggerRef}
        type="button"
        className="secondary"
        onClick={() => setOpen((o) => !o)}
        disabled={options.length === 0}
        style={fullWidth ? { width: "100%", display: "flex", alignItems: "center", textAlign: "left" } : undefined}
      >
        {showIcon && <Icon size={15} style={{ marginRight: "0.4rem" }} />}
        {label}
      </button>
      {open && (
        <AnchoredPopover anchorRef={triggerRef} width={POPOVER_WIDTH} align={align} onClose={() => setOpen(false)}>
          <div style={{ maxHeight: "320px", overflowY: "auto" }}>
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
        </AnchoredPopover>
      )}
    </div>
  );
}
