import { Bold, PaintBucket, Type } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { columnLetter } from "../lib/format";
import type { TemplateGridCell, TemplateGridData } from "../lib/types";

export interface TemplateGridEditorHandle {
  /** The current grid state — meant to be persisted as-is and passed back as `initialGrid` later (see `PaymentExportTemplateConfig.grid`). */
  getGrid: () => TemplateGridData;
  setCellValue: (row: number, col: number, value: string) => void;
  toggleCellBold: (row: number, col: number) => void;
  /** Paints every cell in `row` with `color` ("#rrggbb") — this is how a row visibly becomes "the separator"/"the SOMA row" in the sheet itself. */
  setRowBackgroundColor: (row: number, color: string) => void;
  /** The background color already on `row`'s first column, or `null` — used to pre-fill a color picker instead of always resetting to a default swatch. */
  getRowBackgroundColor: (row: number) => string | null;
}

/** A small colored tag shown in a row's number gutter (e.g. "D" for the detail row) — makes the current layout legible without needing a side panel. */
export interface RowBadge {
  label: string;
  color: string;
}

interface TemplateGridEditorProps {
  /** A previously-saved grid (from `getGrid()`), or `null`/`undefined` for a fresh blank starter grid. */
  initialGrid?: TemplateGridData | null;
  /** row index -> badge, for rows currently marked as a role (detail/separator/SOMA). */
  rowBadges?: Map<number, RowBadge>;
  /** Fires on right-clicking a data cell — the parent owns building/rendering the actual `ContextMenu` (this component knows nothing about "campos"/"agrupamento", only the grid). */
  onCellContextMenu?: (row: number, col: number, value: string, x: number, y: number) => void;
  /** Fires on right-clicking a row's number gutter. */
  onRowContextMenu?: (row: number, x: number, y: number) => void;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 8;
const DEFAULT_COL_WIDTH = 110;
const GUTTER_WIDTH = 36;

function blankCell(): TemplateGridCell {
  return { value: "", backgroundColor: null, fontColor: null, bold: false };
}

/** One Google-Sheets-style toolbar color control: an icon with a thin color-swatch bar underneath, a native `<input type="color">` invisibly overlaid on top so the whole icon opens the OS color picker on click. */
function ToolbarColorButton({
  icon,
  color,
  disabled,
  title,
  onChange,
}: {
  icon: ReactNode;
  color: string;
  disabled: boolean;
  title: string;
  onChange: (color: string) => void;
}) {
  return (
    <label
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        padding: "0.25rem 0.4rem",
        borderRadius: 6,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      title={title}
    >
      {icon}
      <span style={{ width: "1rem", height: "3px", borderRadius: 1, background: color }} />
      <input
        type="color"
        disabled={disabled}
        value={color}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: "absolute", inset: 0, opacity: 0, cursor: disabled ? "default" : "pointer" }}
      />
    </label>
  );
}

function blankGrid(): TemplateGridData {
  return {
    rows: Array.from({ length: DEFAULT_ROWS }, () => Array.from({ length: DEFAULT_COLS }, blankCell)),
    columnWidths: Array.from({ length: DEFAULT_COLS }, () => DEFAULT_COL_WIDTH),
  };
}

/**
 * The hand-built grid the export template is designed on — deliberately
 * minimal (text + background/text color + bold per cell, nothing else: no
 * formulas, no merges, no multi-sheet). A small toolbar above the grid
 * (Negrito/Cor do texto/Cor de fundo, acting on whatever cell is selected)
 * is the only chrome — deliberately not glued to the grid's own bordered
 * box, so it doesn't read as a box-inside-a-box. Replaces an earlier
 * jspreadsheet-ce-based editor: that pulled in a full spreadsheet engine
 * (toolbar, formulas, its own selection model) for far more than this
 * feature needs, and its side-panel "act on whatever's currently selected"
 * pattern was fragile — clicking a button outside the grid could act on a
 * stale/wrong row. Here, every domain action (insert a field, mark a row's
 * role) is triggered by right-clicking the exact cell/row it targets — see
 * `onCellContextMenu`/`onRowContextMenu` — so there's no "last selection"
 * to go stale.
 */
const TemplateGridEditor = forwardRef<TemplateGridEditorHandle, TemplateGridEditorProps>(function TemplateGridEditor(
  { initialGrid, rowBadges, onCellContextMenu, onRowContextMenu },
  ref,
) {
  const [grid, setGrid] = useState<TemplateGridData>(() => initialGrid ?? blankGrid());
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function updateCell(row: number, col: number, patch: Partial<TemplateGridCell>) {
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((r, ri) => (ri !== row ? r : r.map((c, ci) => (ci !== col ? c : { ...c, ...patch })))),
    }));
  }

  /**
   * Sets a cell's text and, if that cell was on the last row and/or last
   * column, grows the grid right there — so there's always at least one
   * spare row/column past whatever's been typed, the same "always leave
   * room to keep going" feel a real spreadsheet has, without a manual
   * "adicionar linha/coluna" button to remember to click.
   */
  function setCellText(row: number, col: number, value: string) {
    setGrid((g) => {
      const rows = g.rows.map((r, ri) => (ri !== row ? r : r.map((c, ci) => (ci !== col ? c : { ...c, value }))));
      const needsRow = row === rows.length - 1;
      const needsCol = col === g.columnWidths.length - 1;
      if (!needsRow && !needsCol) return { ...g, rows };
      const columnWidths = needsCol ? [...g.columnWidths, DEFAULT_COL_WIDTH] : g.columnWidths;
      const widenedRows = needsCol ? rows.map((r) => [...r, blankCell()]) : rows;
      const finalRows = needsRow ? [...widenedRows, Array.from({ length: columnWidths.length }, blankCell)] : widenedRows;
      return { rows: finalRows, columnWidths };
    });
  }

  useImperativeHandle(
    ref,
    () => ({
      getGrid: () => grid,
      setCellValue: (row, col, value) => setCellText(row, col, value),
      toggleCellBold: (row, col) => updateCell(row, col, { bold: !grid.rows[row]?.[col]?.bold }),
      setRowBackgroundColor: (row, color) => {
        setGrid((g) => ({
          ...g,
          rows: g.rows.map((r, ri) => (ri !== row ? r : r.map((c) => ({ ...c, backgroundColor: color })))),
        }));
      },
      getRowBackgroundColor: (row) => grid.rows[row]?.[0]?.backgroundColor ?? null,
    }),
    // Re-created whenever `grid` changes so every closure above reads fresh
    // state — this is a small grid (tens of cells), re-creating the handle
    // object on each change is not a real cost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid],
  );

  const colCount = grid.columnWidths.length;
  const templateColumns = `${GUTTER_WIDTH}px ${grid.columnWidths.map((w) => `${w}px`).join(" ")}`;
  const selectedCell = selected ? grid.rows[selected.row]?.[selected.col] : null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.2rem",
          padding: "0.5rem 0.7rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--sidebar-bg)",
        }}
      >
        <button
          type="button"
          className="ghost"
          onClick={() => selected && updateCell(selected.row, selected.col, { bold: !selectedCell?.bold })}
          disabled={!selected}
          title="Negrito"
          aria-pressed={Boolean(selectedCell?.bold)}
          style={{
            padding: "0.4rem 0.55rem",
            outline: selectedCell?.bold ? "2px solid var(--accent)" : "none",
            outlineOffset: -2,
          }}
        >
          <Bold size={14} />
        </button>
        <ToolbarColorButton
          icon={<Type size={14} />}
          title="Cor do texto"
          disabled={!selected}
          color={selectedCell?.fontColor ?? "#000000"}
          onChange={(color) => selected && updateCell(selected.row, selected.col, { fontColor: color })}
        />
        <ToolbarColorButton
          icon={<PaintBucket size={14} />}
          title="Cor de fundo"
          disabled={!selected}
          color={selectedCell?.backgroundColor ?? "#ffffff"}
          onChange={(color) => selected && updateCell(selected.row, selected.col, { backgroundColor: color })}
        />
      </div>
      <div style={{ overflow: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: templateColumns, width: "max-content" }}>
          <div style={{ background: "var(--card-bg-soft)" }} />
          {Array.from({ length: colCount }, (_, c) => (
            <div
              key={c}
              style={{
                background: "var(--card-bg-soft)",
                textAlign: "center",
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                padding: "0.25rem 0",
                borderLeft: "1px solid var(--border)",
              }}
            >
              {columnLetter(c)}
            </div>
          ))}

          {grid.rows.map((rowCells, r) => {
            const badge = rowBadges?.get(r);
            return (
              <div key={r} style={{ display: "contents" }}>
                <div
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onRowContextMenu?.(r, e.clientX, e.clientY);
                  }}
                  title={badge?.label}
                  style={{
                    background: badge ? badge.color : "var(--card-bg-soft)",
                    color: badge ? "#111" : "var(--text-muted)",
                    fontSize: "0.72rem",
                    fontWeight: badge ? 700 : 400,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderTop: "1px solid var(--border)",
                    cursor: "context-menu",
                  }}
                >
                  {badge ? badge.label : r + 1}
                </div>
                {rowCells.map((cell, c) => {
                  const isSelected = selected?.row === r && selected?.col === c;
                  return (
                    <div
                      key={c}
                      onClick={() => setSelected({ row: r, col: c })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected({ row: r, col: c });
                        onCellContextMenu?.(r, c, cell.value, e.clientX, e.clientY);
                      }}
                      style={{
                        borderTop: "1px solid var(--border)",
                        borderLeft: "1px solid var(--border)",
                        outline: isSelected ? "2px solid var(--accent)" : "none",
                        outlineOffset: -2,
                        background: cell.backgroundColor ?? "transparent",
                        minHeight: "1.9rem",
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      {isSelected ? (
                        <input
                          ref={inputRef}
                          autoFocus
                          value={cell.value}
                          onChange={(e) => setCellText(r, c, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (r + 1 < grid.rows.length) setSelected({ row: r + 1, col: c });
                            } else if (e.key === "Escape") {
                              setSelected(null);
                            }
                          }}
                          style={{
                            width: "100%",
                            height: "100%",
                            border: "none",
                            background: "transparent",
                            padding: "0 0.35rem",
                            fontWeight: cell.bold ? 700 : 400,
                            color: cell.fontColor ?? "inherit",
                          }}
                        />
                      ) : (
                        <span
                          style={{
                            padding: "0 0.35rem",
                            fontWeight: cell.bold ? 700 : 400,
                            color: cell.fontColor ?? "inherit",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {cell.value}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default TemplateGridEditor;
