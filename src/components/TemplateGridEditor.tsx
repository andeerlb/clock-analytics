import { Bold, Combine, Eraser, Italic, PaintBucket, Type } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { columnLetter } from "../lib/format";
import type { TemplateGridCell, TemplateGridData, TemplateGridMerge } from "../lib/types";

export interface TemplateGridEditorHandle {
  /** The current grid state — meant to be persisted as-is and passed back as `initialGrid` later (see `PaymentExportTemplateConfig.grid`). */
  getGrid: () => TemplateGridData;
  setCellValue: (row: number, col: number, value: string) => void;
  toggleCellBold: (row: number, col: number) => void;
  toggleCellItalic: (row: number, col: number) => void;
  /** Applies an arbitrary patch to one cell — used for the right-click "Remover cor do texto"/"Remover cor de fundo" items (`{ fontColor: null }`/`{ backgroundColor: null }`), which don't fit any of the more specific methods above. */
  patchCell: (row: number, col: number, patch: Partial<TemplateGridCell>) => void;
  /** Paints every cell in `row` with `color` ("#rrggbb") — this is how a row visibly becomes "the separator"/"the SOMA row" in the sheet itself. */
  setRowBackgroundColor: (row: number, color: string) => void;
  /** The background color already on `row`'s first column, or `null` — used to pre-fill a color picker instead of always resetting to a default swatch. */
  getRowBackgroundColor: (row: number) => string | null;
  /** The current selection's size, or `null` if nothing is selected — lets the parent's right-click cell menu decide whether to offer "Mesclar células". */
  getSelectionRangeSize: () => { rows: number; cols: number } | null;
  /** Whether the current selection is exactly one existing merge (so the parent's menu can offer "Desmesclar" instead of "Mesclar"). */
  isSelectionMerged: () => boolean;
  /** Merges the current selection (if it spans more than one cell), or unmerges it (if it's already exactly one merge) — same action the toolbar's Mesclar/Desmesclar button performs. */
  toggleMergeSelection: () => void;
  /** `true` = ignore this column's fixed width at export time and size it to the longest actual value written into it; `false` = strictly use the fixed width (the default). */
  setColumnAutoFit: (col: number, autoFit: boolean) => void;
  getColumnAutoFit: (col: number) => boolean;
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
  /** Fires on right-clicking a data cell — the parent owns building/rendering the actual `ContextMenu` (this component knows nothing about "campos"/"agrupamento", only the grid). `backgroundColor`/`fontColor` are that cell's own current values, so the parent can conditionally offer "Remover cor..." without a separate round-trip query. */
  onCellContextMenu?: (
    row: number,
    col: number,
    value: string,
    backgroundColor: string | null,
    fontColor: string | null,
    x: number,
    y: number,
  ) => void;
  /** Fires on right-clicking a row's number gutter. */
  onRowContextMenu?: (row: number, x: number, y: number) => void;
  /** Fires on right-clicking a column's letter header. */
  onColumnContextMenu?: (col: number, x: number, y: number) => void;
  /** Cell values (exact match, e.g. `"{{workDate}}"`) that should get a visual marker — used to show which cells currently drive agrupamento, without a separate side-panel list. Domain-agnostic on purpose (this component doesn't know what "agrupamento" means, just "highlight any cell whose value is exactly one of these"). */
  highlightExactValues?: Set<string>;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 8;
const DEFAULT_COL_WIDTH = 110;
const DEFAULT_ROW_HEIGHT = 30;
const HEADER_ROW_HEIGHT = 26;
const GUTTER_WIDTH = 36;
const MIN_COL_WIDTH = 30;
const MIN_ROW_HEIGHT = 20;

const FONT_FAMILIES = [
  "Calibri",
  "Arial",
  "Arial Black",
  "Times New Roman",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Courier New",
  "Trebuchet MS",
  "Comic Sans MS",
];
const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36];

/** What the toolbar's "Limpar formatação" (Eraser) button resets a cell back to — every style property, `value` untouched. */
const RESET_FORMAT_PATCH: Partial<TemplateGridCell> = {
  backgroundColor: null,
  fontColor: null,
  bold: false,
  italic: false,
  fontFamily: null,
  fontSize: null,
};

/** One selected rectangle of cells, normalized so `r1<=r2`/`c1<=c2` always holds — the single primitive every selection-driven feature (range highlight, bulk formatting, Delete-to-clear, merge, "select whole row/column") is built on. */
interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function normalizeRange(a: { row: number; col: number }, b: { row: number; col: number }): CellRange {
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
}
function rangeIsSingleCell(r: CellRange): boolean {
  return r.r1 === r.r2 && r.c1 === r.c2;
}
function cellInRange(r: CellRange, row: number, col: number): boolean {
  return row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
}
function rangesEqual(a: CellRange, b: CellRange): boolean {
  return a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
}
function mergeToRange(m: TemplateGridMerge): CellRange {
  return { r1: m.row, c1: m.col, r2: m.row + m.rowSpan - 1, c2: m.col + m.colSpan - 1 };
}
function findMergeAt(merges: TemplateGridMerge[], row: number, col: number): TemplateGridMerge | null {
  return merges.find((m) => row >= m.row && row < m.row + m.rowSpan && col >= m.col && col < m.col + m.colSpan) ?? null;
}
/** True if `range` touches `m` but doesn't fully contain it — the guard that keeps a new merge from slicing an existing one instead of properly subsuming it. */
function partiallyOverlaps(range: CellRange, m: TemplateGridMerge): boolean {
  const mr = mergeToRange(m);
  const overlaps = range.r1 <= mr.r2 && range.r2 >= mr.r1 && range.c1 <= mr.c2 && range.c2 >= mr.c1;
  if (!overlaps) return false;
  const contained = range.r1 <= mr.r1 && range.r2 >= mr.r2 && range.c1 <= mr.c1 && range.c2 >= mr.c2;
  return !contained;
}

function blankCell(): TemplateGridCell {
  return { value: "", backgroundColor: null, fontColor: null, bold: false, italic: false, fontFamily: null, fontSize: null };
}

function blankGrid(): TemplateGridData {
  return {
    rows: Array.from({ length: DEFAULT_ROWS }, () => Array.from({ length: DEFAULT_COLS }, blankCell)),
    columnWidths: Array.from({ length: DEFAULT_COLS }, () => DEFAULT_COL_WIDTH),
    columnAutoFit: Array.from({ length: DEFAULT_COLS }, () => false),
    rowHeights: Array.from({ length: DEFAULT_ROWS }, () => DEFAULT_ROW_HEIGHT),
    merges: [],
  };
}

/** A saved grid may predate `columnAutoFit`/`rowHeights`/`merges`/italic/font family/font size (this feature is still being iterated on) — fills in sane defaults instead of crashing on the missing fields. */
function normalizeGrid(g: TemplateGridData): TemplateGridData {
  const rowHeights = g.rowHeights?.length === g.rows.length ? g.rowHeights : g.rows.map(() => DEFAULT_ROW_HEIGHT);
  const columnWidths = g.columnWidths ?? [];
  const columnAutoFit = g.columnAutoFit?.length === columnWidths.length ? g.columnAutoFit : columnWidths.map(() => false);
  const rows = g.rows.map((row) =>
    row.map((cell) => ({
      value: cell.value ?? "",
      backgroundColor: cell.backgroundColor ?? null,
      fontColor: cell.fontColor ?? null,
      bold: cell.bold ?? false,
      italic: cell.italic ?? false,
      fontFamily: cell.fontFamily ?? null,
      fontSize: cell.fontSize ?? null,
    })),
  );
  return { rows, columnWidths, columnAutoFit, rowHeights, merges: g.merges ?? [] };
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
      className="template-grid-color-button"
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
        // `<input type="color">` is a replaced element with its own
        // intrinsic minimum size — `inset:0` alone only positions it, it
        // does NOT shrink a native form control to fit a small container.
        // Left unset, the (invisible, opacity:0) input renders at its
        // normal native size and silently spills into whatever's next in
        // the toolbar, stealing its clicks. Explicit width/height forces it
        // to actually match this button's own small box.
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: disabled ? "default" : "pointer" }}
      />
    </label>
  );
}

/**
 * The hand-built grid the export template is designed on. A toolbar above
 * it (Negrito/Itálico/fonte/tamanho/cor do texto/cor de fundo/Mesclar,
 * acting on the current selection) is the only chrome — deliberately not
 * glued to the grid's own bordered box, so it doesn't read as a
 * box-inside-a-box. Replaces an earlier jspreadsheet-ce-based editor: that
 * pulled in a full spreadsheet engine for far more than this feature
 * needed, and its side-panel "act on whatever's currently selected" pattern
 * was fragile — clicking a button outside the grid could act on a stale
 * row. Structural actions (insert a field, mark a row's role) still work
 * the same way this replaced that: right-clicking the exact cell/row they
 * target, never a separately-tracked selection — see
 * `onCellContextMenu`/`onRowContextMenu`.
 */
const TemplateGridEditor = forwardRef<TemplateGridEditorHandle, TemplateGridEditorProps>(function TemplateGridEditor(
  { initialGrid, rowBadges, onCellContextMenu, onRowContextMenu, onColumnContextMenu, highlightExactValues },
  ref,
) {
  const [grid, setGrid] = useState<TemplateGridData>(() => (initialGrid ? normalizeGrid(initialGrid) : blankGrid()));
  const [range, setRange] = useState<CellRange | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const dragAnchorRef = useRef<{ row: number; col: number } | null>(null);
  const isDraggingRef = useRef(false);
  const colResizeRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null);
  const rowResizeRef = useRef<{ row: number; startY: number; startHeight: number } | null>(null);

  // One pair of window listeners covers every drag interaction (range
  // select, column resize, row resize) — whichever ref is populated decides
  // what a given drag actually does, and mouseup always clears all three so
  // releasing the button outside the grid still ends the drag cleanly.
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (colResizeRef.current) {
        const { col, startX, startWidth } = colResizeRef.current;
        const width = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
        setGrid((g) => ({ ...g, columnWidths: g.columnWidths.map((w, i) => (i === col ? width : w)) }));
      }
      if (rowResizeRef.current) {
        const { row, startY, startHeight } = rowResizeRef.current;
        const height = Math.max(MIN_ROW_HEIGHT, startHeight + (e.clientY - startY));
        setGrid((g) => ({ ...g, rowHeights: g.rowHeights.map((h, i) => (i === row ? height : h)) }));
      }
    }
    function onMouseUp() {
      colResizeRef.current = null;
      rowResizeRef.current = null;
      isDraggingRef.current = false;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function updateCell(row: number, col: number, patch: Partial<TemplateGridCell>) {
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((r, ri) => (ri !== row ? r : r.map((c, ci) => (ci !== col ? c : { ...c, ...patch })))),
    }));
  }

  function updateRange(r: CellRange, patch: Partial<TemplateGridCell>) {
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((row, ri) =>
        ri < r.r1 || ri > r.r2 ? row : row.map((cell, ci) => (ci < r.c1 || ci > r.c2 ? cell : { ...cell, ...patch })),
      ),
    }));
  }

  function clearRangeContents(r: CellRange) {
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((row, ri) =>
        ri < r.r1 || ri > r.r2 ? row : row.map((cell, ci) => (ci < r.c1 || ci > r.c2 ? cell : { ...cell, value: "" })),
      ),
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
      const columnAutoFit = needsCol ? [...g.columnAutoFit, false] : g.columnAutoFit;
      const widenedRows = needsCol ? rows.map((r) => [...r, blankCell()]) : rows;
      const finalRows = needsRow ? [...widenedRows, Array.from({ length: columnWidths.length }, blankCell)] : widenedRows;
      const rowHeights = needsRow ? [...g.rowHeights, DEFAULT_ROW_HEIGHT] : g.rowHeights;
      return { rows: finalRows, columnWidths, columnAutoFit, rowHeights, merges: g.merges };
    });
  }

  /** Selects exactly one cell (or, if it's part of an existing merge, that merge's whole span) without starting a drag — used for right-clicks and other "just move the selection here" actions where extending on mouse-move would be wrong. */
  function selectSingleCell(row: number, col: number) {
    const merge = findMergeAt(grid.merges, row, col);
    setRange(merge ? mergeToRange(merge) : { r1: row, c1: col, r2: row, c2: col });
    if (editingCell && (editingCell.row !== row || editingCell.col !== col)) setEditingCell(null);
  }

  function handleCellMouseDown(row: number, col: number, e: ReactMouseEvent) {
    // Only the left button starts a drag-select — a right-click (which also
    // fires mousedown before its own contextmenu event) must never start
    // one, or moving the mouse while the context menu is still open keeps
    // extending the selection into whatever's under the cursor.
    if (e.button !== 0) {
      selectSingleCell(row, col);
      return;
    }
    // Shift+click extends from wherever the last plain click landed
    // (dragAnchorRef, left untouched here) instead of starting a fresh
    // drag — the standard "click A1, shift+click A2" range-select gesture.
    if (e.shiftKey && dragAnchorRef.current) {
      setRange(normalizeRange(dragAnchorRef.current, { row, col }));
      setEditingCell(null);
      return;
    }
    dragAnchorRef.current = { row, col };
    isDraggingRef.current = true;
    wrapperRef.current?.focus();
    selectSingleCell(row, col);
  }

  function handleCellMouseEnter(row: number, col: number) {
    if (!isDraggingRef.current || !dragAnchorRef.current) return;
    setRange(normalizeRange(dragAnchorRef.current, { row, col }));
  }

  function selectRow(row: number) {
    setEditingCell(null);
    wrapperRef.current?.focus();
    setRange({ r1: row, c1: 0, r2: row, c2: grid.columnWidths.length - 1 });
  }

  function selectColumn(col: number) {
    setEditingCell(null);
    wrapperRef.current?.focus();
    setRange({ r1: 0, c1: col, r2: grid.rows.length - 1, c2: col });
  }

  function startColResize(col: number, e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    colResizeRef.current = { col, startX: e.clientX, startWidth: grid.columnWidths[col] };
  }
  function startRowResize(row: number, e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    rowResizeRef.current = { row, startY: e.clientY, startHeight: grid.rowHeights[row] };
  }

  function handleGridKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (editingCell) return; // the cell's own <input> handles its own keys (including Delete/Backspace as normal text editing)
    if (!range) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clearRangeContents(range);
    } else if ((e.key === "Enter" || e.key === "F2") && rangeIsSingleCell(range)) {
      e.preventDefault();
      setEditingCell({ row: range.r1, col: range.c1 });
    }
  }

  const anchorMerge = range ? findMergeAt(grid.merges, range.r1, range.c1) : null;
  const existingMergeForRange = range && anchorMerge && rangesEqual(mergeToRange(anchorMerge), range) ? anchorMerge : null;
  const canMerge = Boolean(range && !rangeIsSingleCell(range));

  function handleMergeClick() {
    if (!range) return;
    if (existingMergeForRange) {
      setGrid((g) => ({ ...g, merges: g.merges.filter((m) => m !== existingMergeForRange) }));
      return;
    }
    if (!canMerge) return;
    setGrid((g) => {
      if (g.merges.some((m) => partiallyOverlaps(range, m))) return g;
      const remaining = g.merges.filter((m) => {
        const mr = mergeToRange(m);
        const contained = range.r1 <= mr.r1 && range.r2 >= mr.r2 && range.c1 <= mr.c1 && range.c2 >= mr.c2;
        return !contained;
      });
      const newMerge: TemplateGridMerge = {
        row: range.r1,
        col: range.c1,
        rowSpan: range.r2 - range.r1 + 1,
        colSpan: range.c2 - range.c1 + 1,
      };
      return { ...g, merges: [...remaining, newMerge] };
    });
  }

  useImperativeHandle(
    ref,
    () => ({
      getGrid: () => grid,
      setCellValue: (row, col, value) => setCellText(row, col, value),
      toggleCellBold: (row, col) => updateCell(row, col, { bold: !grid.rows[row]?.[col]?.bold }),
      toggleCellItalic: (row, col) => updateCell(row, col, { italic: !grid.rows[row]?.[col]?.italic }),
      patchCell: (row, col, patch) => updateCell(row, col, patch),
      setRowBackgroundColor: (row, color) => {
        setGrid((g) => ({
          ...g,
          rows: g.rows.map((r, ri) => (ri !== row ? r : r.map((c) => ({ ...c, backgroundColor: color })))),
        }));
      },
      getRowBackgroundColor: (row) => grid.rows[row]?.[0]?.backgroundColor ?? null,
      getSelectionRangeSize: () => (range ? { rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1 } : null),
      isSelectionMerged: () => Boolean(existingMergeForRange),
      toggleMergeSelection: () => handleMergeClick(),
      setColumnAutoFit: (col, autoFit) => {
        setGrid((g) => ({ ...g, columnAutoFit: g.columnAutoFit.map((v, i) => (i === col ? autoFit : v)) }));
      },
      getColumnAutoFit: (col) => grid.columnAutoFit[col] ?? false,
    }),
    // Re-created whenever `grid`/`range` change so every closure above reads
    // fresh state — this is a small grid (tens of cells), re-creating the
    // handle object on each change is not a real cost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid, range],
  );

  const rowCount = grid.rows.length;
  const colCount = grid.columnWidths.length;
  const templateColumns = `${GUTTER_WIDTH}px ${grid.columnWidths.map((w) => `${w}px`).join(" ")}`;
  const templateRows = `${HEADER_ROW_HEIGHT}px ${grid.rowHeights.map((h) => `${h}px`).join(" ")}`;
  const anchorCell = range ? grid.rows[range.r1]?.[range.c1] : null;

  const coveredBy = new Map<string, TemplateGridMerge>();
  const anchorMergeAt = new Map<string, TemplateGridMerge>();
  for (const m of grid.merges) {
    anchorMergeAt.set(`${m.row},${m.col}`, m);
    for (let rr = m.row; rr < m.row + m.rowSpan; rr++) {
      for (let cc = m.col; cc < m.col + m.colSpan; cc++) {
        if (rr === m.row && cc === m.col) continue;
        coveredBy.set(`${rr},${cc}`, m);
      }
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.2rem",
          padding: "0.5rem 0.7rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--sidebar-bg)",
        }}
      >
        <button
          type="button"
          className="ghost"
          onClick={() => range && updateRange(range, { bold: !anchorCell?.bold })}
          disabled={!range}
          title="Negrito"
          aria-pressed={Boolean(anchorCell?.bold)}
          style={{ padding: "0.4rem 0.55rem", outline: anchorCell?.bold ? "2px solid var(--accent)" : "none", outlineOffset: -2 }}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => range && updateRange(range, { italic: !anchorCell?.italic })}
          disabled={!range}
          title="Itálico"
          aria-pressed={Boolean(anchorCell?.italic)}
          style={{ padding: "0.4rem 0.55rem", outline: anchorCell?.italic ? "2px solid var(--accent)" : "none", outlineOffset: -2 }}
        >
          <Italic size={14} />
        </button>
        <select
          value={anchorCell?.fontFamily ?? "Calibri"}
          onChange={(e) => range && updateRange(range, { fontFamily: e.target.value === "Calibri" ? null : e.target.value })}
          disabled={!range}
          title="Fonte"
          style={{ fontSize: "0.8rem", maxWidth: "9.5rem" }}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
        <select
          value={anchorCell?.fontSize ?? 11}
          onChange={(e) => range && updateRange(range, { fontSize: Number(e.target.value) === 11 ? null : Number(e.target.value) })}
          disabled={!range}
          title="Tamanho da fonte"
          style={{ fontSize: "0.8rem", width: "4rem" }}
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <ToolbarColorButton
          icon={<Type size={14} />}
          title="Cor do texto"
          disabled={!range}
          color={anchorCell?.fontColor ?? "#000000"}
          onChange={(color) => range && updateRange(range, { fontColor: color })}
        />
        <ToolbarColorButton
          icon={<PaintBucket size={14} />}
          title="Cor de fundo"
          disabled={!range}
          color={anchorCell?.backgroundColor ?? "#ffffff"}
          onChange={(color) => range && updateRange(range, { backgroundColor: color })}
        />
        <button
          type="button"
          className="ghost"
          onClick={handleMergeClick}
          disabled={!range || (!canMerge && !existingMergeForRange)}
          title={existingMergeForRange ? "Desmesclar células" : "Mesclar células"}
          aria-pressed={Boolean(existingMergeForRange)}
          style={{
            padding: "0.4rem 0.55rem",
            outline: existingMergeForRange ? "2px solid var(--accent)" : "none",
            outlineOffset: -2,
          }}
        >
          <Combine size={14} />
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => range && updateRange(range, RESET_FORMAT_PATCH)}
          disabled={!range}
          title="Limpar formatação (mantém o texto)"
          style={{ padding: "0.4rem 0.55rem" }}
        >
          <Eraser size={14} />
        </button>
      </div>
      <div
        ref={wrapperRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        style={{ overflow: "auto", outline: "none" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: templateColumns, gridTemplateRows: templateRows, width: "max-content" }}>
          <div style={{ gridColumn: 1, gridRow: 1, background: "var(--card-bg-soft)" }} />

          {Array.from({ length: colCount }, (_, c) => (
            <div
              key={`h${c}`}
              className="template-grid-selector template-grid-selector--column"
              onClick={() => selectColumn(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                onColumnContextMenu?.(c, e.clientX, e.clientY);
              }}
              style={{
                gridColumn: c + 2,
                gridRow: 1,
                position: "relative",
                background: "var(--card-bg-soft)",
                textAlign: "center",
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                padding: "0.25rem 0",
                borderLeft: "1px solid var(--border)",
              }}
            >
              {columnLetter(c)}
              <div
                onMouseDown={(e) => startColResize(c, e)}
                onClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", top: 0, bottom: 0, right: -3, width: 6, cursor: "col-resize" }}
              />
            </div>
          ))}

          {Array.from({ length: rowCount }, (_, r) => {
            const badge = rowBadges?.get(r);
            return (
              <div
                key={`g${r}`}
                className="template-grid-selector template-grid-selector--row"
                onClick={() => selectRow(r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onRowContextMenu?.(r, e.clientX, e.clientY);
                }}
                title={badge?.label}
                style={{
                  gridColumn: 1,
                  gridRow: r + 2,
                  position: "relative",
                  background: badge ? badge.color : "var(--card-bg-soft)",
                  color: badge ? "#111" : "var(--text-muted)",
                  fontSize: "0.72rem",
                  fontWeight: badge ? 700 : 400,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderTop: "1px solid var(--border)",
                }}
              >
                {badge ? badge.label : r + 1}
                <div
                  onMouseDown={(e) => startRowResize(r, e)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ position: "absolute", left: 0, right: 0, bottom: -3, height: 6, cursor: "row-resize" }}
                />
              </div>
            );
          })}

          {grid.rows.flatMap((rowCells, r) =>
            rowCells.map((cell, c) => {
              if (coveredBy.has(`${r},${c}`)) return null;
              const merge = anchorMergeAt.get(`${r},${c}`);
              const rowSpan = merge?.rowSpan ?? 1;
              const colSpan = merge?.colSpan ?? 1;
              const inRange = range ? cellInRange(range, r, c) : false;
              const isEditing = editingCell?.row === r && editingCell?.col === c;
              const isGrouped = highlightExactValues?.has(cell.value.trim()) ?? false;
              return (
                <div
                  key={`${r},${c}`}
                  onMouseDown={(e) => handleCellMouseDown(r, c, e)}
                  onMouseEnter={() => handleCellMouseEnter(r, c)}
                  onDoubleClick={() => setEditingCell({ row: r, col: c })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // Right-clicking inside the CURRENT selection keeps it
                    // intact (so "Mesclar células" in the menu can act on
                    // the whole thing) — only right-clicking outside it
                    // collapses the selection down to just this cell.
                    if (!range || !cellInRange(range, r, c)) selectSingleCell(r, c);
                    onCellContextMenu?.(r, c, cell.value, cell.backgroundColor, cell.fontColor, e.clientX, e.clientY);
                  }}
                  title={isGrouped ? "Usado no agrupamento" : undefined}
                  style={{
                    position: "relative",
                    gridColumn: `${c + 2} / span ${colSpan}`,
                    gridRow: `${r + 2} / span ${rowSpan}`,
                    borderTop: "1px solid var(--border)",
                    borderLeft: "1px solid var(--border)",
                    outline: inRange ? "2px solid var(--accent)" : "none",
                    outlineOffset: -2,
                    background: cell.backgroundColor ?? "transparent",
                    display: "flex",
                    alignItems: "center",
                    overflow: "hidden",
                  }}
                >
                  {isGrouped && (
                    <span
                      title="Usado no agrupamento"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 3,
                        background: "#a78bfa",
                      }}
                    />
                  )}
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      autoFocus
                      value={cell.value}
                      onChange={(e) => setCellText(r, c, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setEditingCell(null);
                          if (r + 1 < grid.rows.length) setRange({ r1: r + 1, c1: c, r2: r + 1, c2: c });
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingCell(null);
                        }
                      }}
                      style={{
                        width: "100%",
                        height: "100%",
                        border: "none",
                        background: "transparent",
                        padding: "0 0.35rem",
                        fontWeight: cell.bold ? 700 : 400,
                        fontStyle: cell.italic ? "italic" : "normal",
                        fontFamily: cell.fontFamily ?? "inherit",
                        fontSize: cell.fontSize ? `${cell.fontSize}pt` : "inherit",
                        color: cell.fontColor ?? "inherit",
                      }}
                    />
                  ) : (
                    <span
                      style={{
                        padding: "0 0.35rem",
                        fontWeight: cell.bold ? 700 : 400,
                        fontStyle: cell.italic ? "italic" : "normal",
                        fontFamily: cell.fontFamily ?? "inherit",
                        fontSize: cell.fontSize ? `${cell.fontSize}pt` : "inherit",
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
            }),
          )}
        </div>
      </div>
    </div>
  );
});

export default TemplateGridEditor;
