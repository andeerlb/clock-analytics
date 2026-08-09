import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Bold,
  ChevronDown,
  Combine,
  Eraser,
  Grid3x3,
  Italic,
  PaintBucket,
  Type,
  type LucideIcon,
} from "lucide-react";
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
import type {
  CellBorderSide,
  CellHorizontalAlign,
  CellVerticalAlign,
  TemplateGridCell,
  TemplateGridCellBorder,
  TemplateGridData,
  TemplateGridMerge,
} from "../lib/types";

/**
 * Which side(s) a border toolbar/menu action paints, always relative to the
 * SELECTION's own edges (not each individual cell's) — "left" only paints
 * the selection's leftmost column, "outline" only its outer rectangle,
 * "inner"/"innerHorizontal"/"innerVertical" only the lines BETWEEN cells
 * inside it, same distinction Excel/Sheets' own border-position grid makes.
 * "all" paints every side of every cell (outer rectangle + every inner
 * line); "none" clears every side of every cell.
 */
export type BorderApplyKind =
  | "all"
  | "inner"
  | "innerHorizontal"
  | "innerVertical"
  | "outline"
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "none";

export interface TemplateGridEditorHandle {
  /** The current grid state — meant to be persisted as-is and passed back as `initialGrid` later (see `PaymentExportTemplateConfig.grid`). */
  getGrid: () => TemplateGridData;
  setCellValue: (row: number, col: number, value: string) => void;
  toggleCellBold: (row: number, col: number) => void;
  toggleCellItalic: (row: number, col: number) => void;
  /** Applies an arbitrary patch to one cell — used for the right-click "Remover cor do texto"/"Remover cor de fundo" items (`{ fontColor: null }`/`{ backgroundColor: null }`), which don't fit any of the more specific methods above. */
  patchCell: (row: number, col: number, patch: Partial<TemplateGridCell>) => void;
  /** Applies an arbitrary patch to every cell in the current selection (a no-op if nothing is selected) — how the right-click menu's bulk formatting items (cor de fundo/texto, fonte, tamanho, negrito, itálico) act on a multi-cell range instead of a single cell. */
  patchSelection: (patch: Partial<TemplateGridCell>) => void;
  /** The current selection's anchor cell (its top-left), or `null` if nothing is selected — used to read the "current" bold/italic/color/font state to show in the right-click menu before a bulk edit. */
  getAnchorCell: () => TemplateGridCell | null;
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
  /** Same border-painting logic the toolbar's own border menu uses, exposed so the parent's cell context menu can offer the same actions without duplicating the per-cell-vs-outline logic. `brush: null` clears the sides `kind` targets instead of painting them. No-op if nothing is selected. */
  applyBorderToSelection: (kind: BorderApplyKind, brush: CellBorderSide | null) => void;
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
  /**
   * The "Agrupar" hidden-actions button — there are two independent
   * groupings a field can join (the turno/detail-row grouping, and the
   * SOMA's own — see `PaymentExportTemplateConfig.subtotalGroupBy`), so
   * this opens a small menu to pick which one, the same way
   * `onCellContextMenu` opens its (much bigger) menu. This component only
   * confirms the selected cell's value has the `{{word}}` shape before
   * firing it — it has no idea `word` is a real bindable field, or that
   * "turno vs. SOMA" is even a meaningful distinction (that's the parent's
   * domain, same as everywhere else in this component).
   */
  onGroupingMenu?: (row: number, col: number, value: string, x: number, y: number) => void;
  /** Cell values (exact match, e.g. `"{{workDate}}"`) that should get a visual marker — used to show which cells currently drive agrupamento, without a separate side-panel list. Domain-agnostic on purpose (this component doesn't know what "agrupamento" means, just "highlight any cell whose value is exactly one of these"). */
  highlightExactValues?: Set<string>;
  /** Same idea as `highlightExactValues`, rendered as a second, differently-positioned/colored marker — lets two independent groupings (e.g. turno vs. SOMA) be told apart on a cell that's marked by both. */
  secondaryHighlightExactValues?: Set<string>;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 8;
const DEFAULT_COL_WIDTH = 110;
const DEFAULT_ROW_HEIGHT = 30;
const HEADER_ROW_HEIGHT = 26;
const GUTTER_WIDTH = 36;
const MIN_COL_WIDTH = 30;
const MIN_ROW_HEIGHT = 20;

export const FONT_FAMILIES = [
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
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36];

/** No border on any side — the shape every cell starts with, and what "Nenhuma" (border menu) / "Limpar formatação" reset a cell's `border` back to. */
const NO_BORDER = { top: null, right: null, bottom: null, left: null };

/** What the toolbar's "Limpar formatação" (Eraser) button resets a cell back to — every style property, `value` untouched. */
const RESET_FORMAT_PATCH: Partial<TemplateGridCell> = {
  backgroundColor: null,
  fontColor: null,
  bold: false,
  italic: false,
  fontFamily: null,
  fontSize: null,
  border: NO_BORDER,
  horizontalAlign: null,
  verticalAlign: null,
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
  return {
    value: "",
    backgroundColor: null,
    fontColor: null,
    bold: false,
    italic: false,
    fontFamily: null,
    fontSize: null,
    border: { ...NO_BORDER },
    horizontalAlign: null,
    verticalAlign: null,
  };
}

function blankGrid(): TemplateGridData {
  return {
    rows: Array.from({ length: DEFAULT_ROWS }, () => Array.from({ length: DEFAULT_COLS }, blankCell)),
    columnWidths: Array.from({ length: DEFAULT_COLS }, () => DEFAULT_COL_WIDTH),
    // "Ajustar ao maior registro" is the default for a fresh column — a
    // fixed width is something the user opts into, by dragging the column
    // narrower/wider themselves (see `startColResize`, which switches that
    // one column to fixed the moment a drag starts, using wherever it ends
    // up), not something they have to remember to turn on first.
    columnAutoFit: Array.from({ length: DEFAULT_COLS }, () => true),
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
      border: cell.border ?? { ...NO_BORDER },
      horizontalAlign: cell.horizontalAlign ?? null,
      verticalAlign: cell.verticalAlign ?? null,
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

const BORDER_PATTERN_OPTIONS: Array<{ value: CellBorderSide["pattern"]; label: string }> = [
  { value: "solid", label: "Sólida" },
  { value: "dashed", label: "Tracejada" },
  { value: "dotted", label: "Pontilhada" },
  { value: "double", label: "Dupla" },
];

/** `CellBorderSide` -> the CSS `border-*` shorthand value it renders as — `undefined` (not `"none"`) so it falls back to the grid's own default line color/width instead of erasing it. */
function borderSideToCss(side: CellBorderSide | null): string | undefined {
  if (!side) return undefined;
  return `${side.width}px ${side.pattern} ${side.color}`;
}

/** A 16x16 icon depicting which lines of a 2x2 cell block `kind` paints — every icon shares the same faint base grid (what's already there) with the lines `kind` would add/keep drawn bold on top, the same visual language Excel/Sheets' own border-position picker uses. "none" instead shows the base grid struck through, since it doesn't "add" anything. */
function BorderPositionIcon({ kind }: { kind: BorderApplyKind }) {
  const BASE: Array<[number, number, number, number]> = [
    [1, 1, 15, 1],
    [1, 15, 15, 15],
    [1, 1, 1, 15],
    [15, 1, 15, 15],
    [1, 8, 15, 8],
    [8, 1, 8, 15],
  ];
  const HIGHLIGHT: Record<Exclude<BorderApplyKind, "none">, Array<[number, number, number, number]>> = {
    all: BASE,
    inner: [
      [1, 8, 15, 8],
      [8, 1, 8, 15],
    ],
    innerHorizontal: [[1, 8, 15, 8]],
    innerVertical: [[8, 1, 8, 15]],
    outline: [
      [1, 1, 15, 1],
      [1, 15, 15, 15],
      [1, 1, 1, 15],
      [15, 1, 15, 15],
    ],
    top: [[1, 1, 15, 1]],
    bottom: [[1, 15, 15, 15]],
    left: [[1, 1, 1, 15]],
    right: [[15, 1, 15, 15]],
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      {BASE.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text-muted)" strokeWidth={1} opacity={0.4} />
      ))}
      {kind === "none" ? (
        <line x1={1} y1={1} x2={15} y2={15} stroke="var(--danger)" strokeWidth={1.5} />
      ) : (
        HIGHLIGHT[kind].map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={1.75} />
        ))
      )}
    </svg>
  );
}

const BORDER_POSITION_GRID: Array<{ kind: BorderApplyKind; title: string }> = [
  { kind: "all", title: "Todas as bordas" },
  { kind: "inner", title: "Bordas internas" },
  { kind: "innerHorizontal", title: "Bordas horizontais internas" },
  { kind: "innerVertical", title: "Bordas verticais internas" },
  { kind: "outline", title: "Borda externa" },
  { kind: "top", title: "Borda superior" },
  { kind: "right", title: "Borda direita" },
  { kind: "bottom", title: "Borda inferior" },
  { kind: "left", title: "Borda esquerda" },
  { kind: "none", title: "Sem borda" },
];

/**
 * The toolbar's Excel/Sheets-style "Bordas" control: a small popover with
 * the current pattern/thickness/color "brush" on top and a 5x2 icon grid of
 * where to paint it below (Todas/Interna/Interna H/Interna V/Externa/
 * Topo/Direita/Baixo/Esquerda/Nenhuma). Deliberately doesn't reuse
 * `ToolbarColorButton` — a border action needs a brush chosen (or at least
 * defaulted) before a position icon does anything, whereas every other
 * color button applies the instant the OS picker changes. Thickness is a
 * free number (not a "fina/média/grossa" preset) per how this app's own
 * grid already treats every other size (row height, column width, font
 * size) — see `CellBorderSide.width`'s own doc comment for how that maps
 * back onto Excel's fixed named border weights at export time.
 */
function borderSidesEqual(a: CellBorderSide | null, b: CellBorderSide | null): boolean {
  if (a === null || b === null) return a === b;
  return a.width === b.width && a.pattern === b.pattern && a.color === b.color;
}

/**
 * Whether a given position icon should render "active" for `border` —
 * derived straight from the anchor cell's own sides (not the popover's
 * local brush state) so it stays correct even without opening the popover.
 * "all" only lights up when all four sides are actually the SAME brush
 * (not just all non-null) — and whenever "all" is active, the four
 * individual side icons deliberately don't also light up, so "Todas" reads
 * as one state instead of five icons all claiming the same thing at once.
 * `inner`/`innerHorizontal`/`innerVertical`/`outline` are range-level
 * concepts (they depend on where a cell sits within a multi-cell
 * selection, not on one cell's sides in isolation), so they're never shown
 * as active.
 */
function isBorderPositionActive(kind: BorderApplyKind, border: TemplateGridCellBorder | null): boolean {
  if (!border) return false;
  const { top, right, bottom, left } = border;
  const allUniform = Boolean(top) && borderSidesEqual(top, right) && borderSidesEqual(right, bottom) && borderSidesEqual(bottom, left);
  switch (kind) {
    case "all":
      return allUniform;
    case "none":
      return !top && !right && !bottom && !left;
    case "top":
      return Boolean(top) && !allUniform;
    case "right":
      return Boolean(right) && !allUniform;
    case "bottom":
      return Boolean(bottom) && !allUniform;
    case "left":
      return Boolean(left) && !allUniform;
    default:
      return false;
  }
}

/** Which single side `isBorderPositionActive` actually checked to call `kind` active — used to compare against a freshly-typed brush so re-clicking an active position can tell "same brush again" (remove) apart from "I changed the width/color, apply that instead" (update). `null` for kinds with no single representative side. */
function sideForKind(kind: BorderApplyKind, border: TemplateGridCellBorder | null): CellBorderSide | null {
  if (!border) return null;
  switch (kind) {
    case "all":
    case "top":
      return border.top;
    case "right":
      return border.right;
    case "bottom":
      return border.bottom;
    case "left":
      return border.left;
    default:
      return null;
  }
}

/** For a single cell, "Interna"/"Interna H"/"Interna V"/"Contorno" aren't distinct actions — a 1-cell selection has no inside, so those degenerate to exactly "Nenhuma"/"Nenhuma"/"Nenhuma"/"Todas" respectively. Disabled in that case (same as Excel/Sheets' own border menu) instead of left clickable-but-confusing, since clicking "Contorno" would otherwise light up "Todas" — a different icon than the one actually clicked. */
const RANGE_ONLY_KINDS: BorderApplyKind[] = ["inner", "innerHorizontal", "innerVertical", "outline"];

function BorderMenu({
  disabled,
  anchorBorder,
  isSingleCell,
  onApply,
  onLiveUpdate,
}: {
  disabled: boolean;
  /** The current selection's anchor cell's own border — used to pre-fill the brush and highlight which positions are already set on it, reopen to reopen, the same "reflect what's already there" pattern the bold/italic/color controls already follow. `null` when nothing is selected, or when the selection spans more than one cell (see `RANGE_ONLY_KINDS`'s own doc comment). */
  anchorBorder: TemplateGridCellBorder | null;
  /** Whether the current selection is exactly one cell — see `RANGE_ONLY_KINDS`. */
  isSingleCell: boolean;
  /** `brush: null` clears the sides `kind` targets instead of painting them — how clicking an already-active position a second time removes it. */
  onApply: (kind: BorderApplyKind, brush: CellBorderSide | null) => void;
  /** Fired on every pattern/thickness/color edit (not just on a position click) — restyles whatever border already exists on the selection with the new brush immediately, same as the color/font-size controls elsewhere in this toolbar apply the moment their value changes rather than waiting for a separate confirmation. */
  onLiveUpdate: (brush: CellBorderSide) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState<CellBorderSide["pattern"]>("solid");
  // Kept as free-typed text, not a clamped number, so that clearing the
  // field to type a fresh value (an empty string, briefly unparseable)
  // doesn't get silently snapped back to "1" by a controlled input on every
  // keystroke — see `apply`'s own clamping, which only happens once, when
  // the value is actually used.
  const [widthText, setWidthText] = useState("1");
  const [color, setColor] = useState("#000000");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // Re-reads whatever's already on the selection every time the popover
  // opens, so reopening it on a cell that already has a border shows that
  // border's own pattern/thickness/color instead of always resetting to the
  // same default brush.
  useEffect(() => {
    if (!open) return;
    const existing = anchorBorder?.top ?? anchorBorder?.right ?? anchorBorder?.bottom ?? anchorBorder?.left ?? null;
    if (existing) {
      setPattern(existing.pattern);
      setWidthText(String(existing.width));
      setColor(existing.color);
    }
    // Only re-sync at the moment it opens — once open, the fields are the
    // user's own to edit, not something that should jump around under them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function clampWidth(text: string): number {
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.min(12, parsed)) : 1;
  }

  function apply(kind: BorderApplyKind) {
    const brush: CellBorderSide = { width: clampWidth(widthText), pattern, color };

    // Clicking a position that's already active on the selection WITH THE
    // SAME brush removes it — lets "click it again" work as an undo without
    // a separate trip to "Nenhuma". But if the user changed the
    // pattern/thickness/color first, that's a request to UPDATE the border
    // to the new brush, not to clear it — comparing against the brush
    // actually on the cell (not just "is this position active at all") is
    // what tells those two apart. Only meaningful for the positions
    // `isBorderPositionActive` can actually judge in isolation
    // (all/top/right/bottom/left); "none" is already a no-op either way, and
    // inner/innerHorizontal/innerVertical/outline never report active (see
    // that function's own doc comment), so they always just paint.
    if (kind !== "none" && isBorderPositionActive(kind, anchorBorder)) {
      const current = sideForKind(kind, anchorBorder);
      if (current && borderSidesEqual(current, brush)) {
        onApply(kind, null);
        setOpen(false);
        return;
      }
    }
    onApply(kind, brush);
    setOpen(false);
  }

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="ghost"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Borda"
        style={{ display: "inline-flex", alignItems: "center", padding: "0.4rem 0.55rem" }}
      >
        <Grid3x3 size={14} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: "0.25rem",
            zIndex: 20,
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "0.5rem",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            width: "14rem",
          }}
        >
          <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.4rem" }}>
            <select
              value={pattern}
              onChange={(e) => {
                const next = e.target.value as CellBorderSide["pattern"];
                setPattern(next);
                onLiveUpdate({ width: clampWidth(widthText), pattern: next, color });
              }}
              style={{ fontSize: "0.78rem", flex: 1, minWidth: 0 }}
              title="Estilo da linha"
            >
              {BORDER_PATTERN_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={12}
              value={widthText}
              onChange={(e) => {
                const text = e.target.value;
                setWidthText(text);
                // Skip the live update while the field is transiently
                // unparseable (e.g. momentarily empty between keystrokes) —
                // clamping it here the way `apply`/`clampWidth` do for a
                // real submit would silently snap it to 1 mid-edit, the
                // exact "field fights you while typing" bug this same
                // field used to have.
                const parsed = Number(text);
                if (Number.isFinite(parsed) && parsed > 0) {
                  onLiveUpdate({ width: Math.max(1, Math.min(12, parsed)), pattern, color });
                }
              }}
              title="Espessura (px)"
              className="template-grid-number-input"
              style={{ fontSize: "0.78rem", width: "2.6rem", flexShrink: 0 }}
            />
            <input
              type="color"
              value={color}
              onChange={(e) => {
                const next = e.target.value;
                setColor(next);
                onLiveUpdate({ width: clampWidth(widthText), pattern, color: next });
              }}
              title="Cor da borda"
              style={{ width: "1.8rem", height: "1.8rem", padding: 0, flexShrink: 0 }}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.15rem" }}>
            {BORDER_POSITION_GRID.map((b) => {
              const rangeOnlyDisabled = isSingleCell && RANGE_ONLY_KINDS.includes(b.kind);
              return (
                <button
                  key={b.kind}
                  type="button"
                  className="ghost"
                  onClick={() => apply(b.kind)}
                  disabled={rangeOnlyDisabled}
                  title={rangeOnlyDisabled ? `${b.title} (só faz sentido com mais de uma célula selecionada)` : b.title}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0.3rem",
                    opacity: rangeOnlyDisabled ? 0.35 : 1,
                  }}
                >
                  <BorderPositionIcon kind={b.kind} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A compact "current state icon + chevron" toolbar button that expands into
 * a row of icon options on click — how the toolbar's horizontal/vertical
 * alignment controls stay one small button each instead of three
 * permanently-visible ones, matching Google Sheets' own alignment buttons.
 */
function AlignMenu<T extends string>({
  disabled,
  title,
  currentIcon: CurrentIcon,
  options,
}: {
  disabled: boolean;
  title: string;
  currentIcon: LucideIcon;
  options: Array<{ value: T; icon: LucideIcon; title: string; active: boolean; onClick: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="ghost"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.1rem", padding: "0.4rem 0.4rem" }}
      >
        <CurrentIcon size={14} />
        <ChevronDown size={10} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: "0.25rem",
            zIndex: 20,
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "0.3rem",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            display: "flex",
            gap: "0.15rem",
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="ghost"
              onClick={() => {
                o.onClick();
                setOpen(false);
              }}
              title={o.title}
              aria-pressed={o.active}
              style={{ padding: "0.35rem 0.5rem", outline: o.active ? "2px solid var(--accent)" : "none", outlineOffset: -2 }}
            >
              <o.icon size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
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
  {
    initialGrid,
    rowBadges,
    onCellContextMenu,
    onRowContextMenu,
    onColumnContextMenu,
    onGroupingMenu,
    highlightExactValues,
    secondaryHighlightExactValues,
  },
  ref,
) {
  const [grid, setGrid] = useState<TemplateGridData>(() => (initialGrid ? normalizeGrid(initialGrid) : blankGrid()));
  const [range, setRange] = useState<CellRange | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // A one-line reminder shown next to the "hidden actions" buttons below
  // when clicked with no selection to act on — auto-clears itself so it
  // reads as a transient nudge, not a persistent error state.
  const [hiddenActionHint, setHiddenActionHint] = useState<string | null>(null);
  const hiddenActionHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (hiddenActionHintTimeoutRef.current) clearTimeout(hiddenActionHintTimeoutRef.current);
    };
  }, []);

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

  /**
   * Paints (or clears) borders across every cell in `r` per `kind`. Unlike
   * `updateRange`, this can't apply one flat patch to every cell — every
   * `kind` besides "all"/"none" depends on where a given cell sits relative
   * to the SELECTION's own edges (e.g. "left" only touches column `r.c1`,
   * "inner" touches every side except those on the selection's outer
   * rectangle), so each cell's border is computed individually instead.
   * `brush: null` clears the sides `kind` targets instead of painting them
   * — same per-side logic either way, just assigning `null` instead of a
   * brush object, which is how the border menu implements "click an
   * already-active position again to remove it".
   */
  function applyBorderToRange(r: CellRange, kind: BorderApplyKind, brush: CellBorderSide | null) {
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((row, ri) => {
        if (ri < r.r1 || ri > r.r2) return row;
        return row.map((cell, ci) => {
          if (ci < r.c1 || ci > r.c2) return cell;
          if (kind === "none") return { ...cell, border: { ...NO_BORDER } };
          const border = { ...cell.border };
          const isTop = ri === r.r1;
          const isBottom = ri === r.r2;
          const isLeft = ci === r.c1;
          const isRight = ci === r.c2;
          switch (kind) {
            case "all":
              border.top = brush;
              border.right = brush;
              border.bottom = brush;
              border.left = brush;
              break;
            case "inner":
              if (!isTop) border.top = brush;
              if (!isBottom) border.bottom = brush;
              if (!isLeft) border.left = brush;
              if (!isRight) border.right = brush;
              break;
            case "innerHorizontal":
              if (!isTop) border.top = brush;
              if (!isBottom) border.bottom = brush;
              break;
            case "innerVertical":
              if (!isLeft) border.left = brush;
              if (!isRight) border.right = brush;
              break;
            case "outline":
              if (isTop) border.top = brush;
              if (isBottom) border.bottom = brush;
              if (isLeft) border.left = brush;
              if (isRight) border.right = brush;
              break;
            case "top":
              if (isTop) border.top = brush;
              break;
            case "bottom":
              if (isBottom) border.bottom = brush;
              break;
            case "left":
              if (isLeft) border.left = brush;
              break;
            case "right":
              if (isRight) border.right = brush;
              break;
          }
          return { ...cell, border };
        });
      }),
    }));
  }

  /**
   * Re-paints whichever sides ALREADY have a border in `r` with `brush`,
   * leaving sides that don't have one alone — how editing pattern/
   * thickness/color in the border menu updates an already-applied border
   * live, the instant you change the field, the same way the color swatches
   * elsewhere in this toolbar apply on change instead of needing a second
   * click. A cell with no border at all is left untouched (there's nothing
   * here yet to restyle — that's what the position icons in the menu are
   * for), so this is safe to call on every keystroke without accidentally
   * painting a border where the user never asked for one.
   */
  function remapBorderBrush(r: CellRange, brush: CellBorderSide) {
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((row, ri) => {
        if (ri < r.r1 || ri > r.r2) return row;
        return row.map((cell, ci) => {
          if (ci < r.c1 || ci > r.c2) return cell;
          const { top, right, bottom, left } = cell.border;
          if (!top && !right && !bottom && !left) return cell;
          return {
            ...cell,
            border: {
              top: top ? brush : null,
              right: right ? brush : null,
              bottom: bottom ? brush : null,
              left: left ? brush : null,
            },
          };
        });
      }),
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
      const columnAutoFit = needsCol ? [...g.columnAutoFit, true] : g.columnAutoFit;
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
    // extending the selection into whatever's under the cursor. But a
    // right-click landing INSIDE the current selection must leave it alone
    // (same "don't collapse a range you right-clicked inside" rule the
    // contextmenu handler applies) — collapsing here unconditionally would
    // wipe the range before that handler ever got a chance to check it,
    // since mousedown always fires before contextmenu.
    if (e.button !== 0) {
      if (!range || !cellInRange(range, row, col)) selectSingleCell(row, col);
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
    // `preventScroll` matters here, not just as a nicety — without it, the
    // browser's default focus-triggered scroll-into-view can shift the
    // page's scroll position mid-interaction (e.g. between a double-click's
    // two physical clicks, which fire this same handler twice), landing the
    // second click on a completely different cell than the first and
    // silently opening edit mode on the wrong one.
    wrapperRef.current?.focus({ preventScroll: true });
    selectSingleCell(row, col);
  }

  function handleCellMouseEnter(row: number, col: number) {
    if (!isDraggingRef.current || !dragAnchorRef.current) return;
    setRange(normalizeRange(dragAnchorRef.current, { row, col }));
  }

  function selectRow(row: number) {
    setEditingCell(null);
    // `preventScroll` matters here, not just as a nicety — without it, the
    // browser's default focus-triggered scroll-into-view can shift the
    // page's scroll position mid-interaction (e.g. between a double-click's
    // two physical clicks, which fire this same handler twice), landing the
    // second click on a completely different cell than the first and
    // silently opening edit mode on the wrong one.
    wrapperRef.current?.focus({ preventScroll: true });
    setRange({ r1: row, c1: 0, r2: row, c2: grid.columnWidths.length - 1 });
  }

  function selectColumn(col: number) {
    setEditingCell(null);
    // `preventScroll` matters here, not just as a nicety — without it, the
    // browser's default focus-triggered scroll-into-view can shift the
    // page's scroll position mid-interaction (e.g. between a double-click's
    // two physical clicks, which fire this same handler twice), landing the
    // second click on a completely different cell than the first and
    // silently opening edit mode on the wrong one.
    wrapperRef.current?.focus({ preventScroll: true });
    setRange({ r1: 0, c1: col, r2: grid.rows.length - 1, c2: col });
  }

  function startColResize(col: number, e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    colResizeRef.current = { col, startX: e.clientX, startWidth: grid.columnWidths[col] };
    // Dragging a column's own handle is an explicit "I want exactly this
    // width" — switches it off "ajustar ao maior registro" right away so
    // the width the drag ends on actually sticks, instead of the column
    // silently snapping back to auto-fit at export time.
    setGrid((g) => ({ ...g, columnAutoFit: g.columnAutoFit.map((v, i) => (i === col ? false : v)) }));
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
  const anchorCell = range ? grid.rows[range.r1]?.[range.c1] : null;

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

  /**
   * The "hidden actions" row's own click handler — a cell/row/column right
   * click only ever fires with a concrete target already under the cursor,
   * but a toolbar button has no such thing to go on, so it borrows the
   * current selection's anchor as that target instead. Reuses
   * `onCellContextMenu`/`onRowContextMenu`/`onColumnContextMenu` verbatim
   * (same callbacks the actual right-clicks call) rather than duplicating
   * any menu-building logic — whatever conditions the parent already
   * applies there (e.g. "Agrupar por" only for a cell holding an exact
   * `{{field}}` token) apply here for free, so a button never offers
   * something its own right-click equivalent wouldn't.
   */
  function handleHiddenAction(kind: "cell" | "row" | "column", e: ReactMouseEvent<HTMLButtonElement>) {
    if (hiddenActionHintTimeoutRef.current) clearTimeout(hiddenActionHintTimeoutRef.current);
    if (!range) {
      const message =
        kind === "cell"
          ? "Selecione uma célula para usar isso."
          : kind === "row"
            ? "Selecione uma célula na linha que deseja usar."
            : "Selecione uma célula na coluna que deseja usar.";
      setHiddenActionHint(message);
      hiddenActionHintTimeoutRef.current = setTimeout(() => setHiddenActionHint(null), 3000);
      return;
    }
    setHiddenActionHint(null);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left;
    const y = rect.bottom + 4;
    if (kind === "cell") {
      const cell = grid.rows[range.r1][range.c1];
      onCellContextMenu?.(range.r1, range.c1, cell.value, cell.backgroundColor, cell.fontColor, x, y);
    } else if (kind === "row") {
      onRowContextMenu?.(range.r1, x, y);
    } else {
      onColumnContextMenu?.(range.c1, x, y);
    }
  }

  /**
   * "Agrupar" — opens the parent's small "which grouping" menu (turno vs.
   * SOMA) for the selected cell's field, same pattern as the three
   * menu-opening buttons above. Two distinct reasons it might not be able
   * to act, each with its own nudge: nothing selected at all, vs. a cell
   * selected but its value isn't an exact `{{field}}` token to group by.
   */
  function handleGroupingMenuClick(e: ReactMouseEvent<HTMLButtonElement>) {
    if (hiddenActionHintTimeoutRef.current) clearTimeout(hiddenActionHintTimeoutRef.current);
    if (!range) {
      setHiddenActionHint("Selecione uma célula para agrupar.");
      hiddenActionHintTimeoutRef.current = setTimeout(() => setHiddenActionHint(null), 3000);
      return;
    }
    const cell = grid.rows[range.r1][range.c1];
    if (!/^\{\{\w+\}\}$/.test(cell.value.trim())) {
      setHiddenActionHint('Selecione uma célula com um campo (ex: "{{local}}") para agrupar.');
      hiddenActionHintTimeoutRef.current = setTimeout(() => setHiddenActionHint(null), 3000);
      return;
    }
    setHiddenActionHint(null);
    const rect = e.currentTarget.getBoundingClientRect();
    onGroupingMenu?.(range.r1, range.c1, cell.value, rect.left, rect.bottom + 4);
  }

  useImperativeHandle(
    ref,
    () => ({
      getGrid: () => grid,
      setCellValue: (row, col, value) => setCellText(row, col, value),
      toggleCellBold: (row, col) => updateCell(row, col, { bold: !grid.rows[row]?.[col]?.bold }),
      toggleCellItalic: (row, col) => updateCell(row, col, { italic: !grid.rows[row]?.[col]?.italic }),
      patchCell: (row, col, patch) => updateCell(row, col, patch),
      patchSelection: (patch) => {
        if (range) updateRange(range, patch);
      },
      getAnchorCell: () => anchorCell ?? null,
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
      applyBorderToSelection: (kind, brush) => {
        if (range) applyBorderToRange(range, kind, brush);
      },
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
        <BorderMenu
          disabled={!range}
          // Only meaningful for a single selected cell — for a multi-cell
          // range, "Contorno"/"Interna"/etc. only ever paint SOME of the
          // anchor cell's own 4 sides (e.g. just its top+left, since it's
          // one corner of a bigger rectangle), and showing that as if the
          // user had individually clicked "Topo"/"Esquerda" would be
          // actively misleading about what they actually did.
          anchorBorder={range && rangeIsSingleCell(range) ? (anchorCell?.border ?? null) : null}
          isSingleCell={Boolean(range && rangeIsSingleCell(range))}
          onApply={(kind, brush) => range && applyBorderToRange(range, kind, brush)}
          onLiveUpdate={(brush) => range && remapBorderBrush(range, brush)}
        />
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 0.15rem" }} />
        <AlignMenu<CellHorizontalAlign>
          disabled={!range}
          title="Alinhamento horizontal"
          currentIcon={
            anchorCell?.horizontalAlign === "center" ? AlignCenter : anchorCell?.horizontalAlign === "right" ? AlignRight : AlignLeft
          }
          options={[
            {
              value: "left",
              icon: AlignLeft,
              title: "Alinhar à esquerda",
              active: (anchorCell?.horizontalAlign ?? "left") === "left",
              onClick: () => range && updateRange(range, { horizontalAlign: null }),
            },
            {
              value: "center",
              icon: AlignCenter,
              title: "Centralizar",
              active: anchorCell?.horizontalAlign === "center",
              onClick: () => range && updateRange(range, { horizontalAlign: "center" }),
            },
            {
              value: "right",
              icon: AlignRight,
              title: "Alinhar à direita",
              active: anchorCell?.horizontalAlign === "right",
              onClick: () => range && updateRange(range, { horizontalAlign: "right" }),
            },
          ]}
        />
        <AlignMenu<CellVerticalAlign>
          disabled={!range}
          title="Alinhamento vertical"
          currentIcon={
            anchorCell?.verticalAlign === "top"
              ? AlignVerticalJustifyStart
              : anchorCell?.verticalAlign === "bottom"
                ? AlignVerticalJustifyEnd
                : AlignVerticalJustifyCenter
          }
          options={[
            {
              value: "top",
              icon: AlignVerticalJustifyStart,
              title: "Alinhar ao topo",
              active: anchorCell?.verticalAlign === "top",
              onClick: () => range && updateRange(range, { verticalAlign: "top" }),
            },
            {
              value: "middle",
              icon: AlignVerticalJustifyCenter,
              title: "Alinhar ao meio",
              active: (anchorCell?.verticalAlign ?? "middle") === "middle",
              onClick: () => range && updateRange(range, { verticalAlign: null }),
            },
            {
              value: "bottom",
              icon: AlignVerticalJustifyEnd,
              title: "Alinhar à base",
              active: anchorCell?.verticalAlign === "bottom",
              onClick: () => range && updateRange(range, { verticalAlign: "bottom" }),
            },
          ]}
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
      {/*
        Every action here already exists as a right-click (on a cell/the
        row-number gutter/the column-letter header) — this row exists
        purely so those aren't undiscoverable. Each button reopens the
        exact same menu its right-click equivalent would, anchored at the
        current selection instead of the cursor; with nothing selected, it
        nudges the user to select something instead of silently doing
        nothing.
      */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          // Deliberately never wraps — a second, ragged line here would
          // read as broken/misaligned against the toolbar row above it.
          // Narrower than this needs a horizontal scrollbar on the row
          // itself instead, same "stay one clean line" rule the sticky
          // grid headers below already follow.
          flexWrap: "nowrap",
          overflowX: "auto",
          gap: "0.4rem",
          padding: "0.4rem 0.7rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--sidebar-bg)",
        }}
      >
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", flexShrink: 0 }}>Mais ações:</span>
        <button
          type="button"
          className="ghost"
          onClick={handleGroupingMenuClick}
          style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, gap: "0.15rem", padding: "0.3rem 0.55rem", fontSize: "0.8rem" }}
          title='Agrupar por linha (turno) ou por SOMA a célula selecionada (precisa conter um campo, ex: "{{local}}")'
        >
          Agrupar
          <ChevronDown size={12} />
        </button>
        <button
          type="button"
          className="ghost"
          onClick={(e) => handleHiddenAction("cell", e)}
          style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, gap: "0.15rem", padding: "0.3rem 0.55rem", fontSize: "0.8rem" }}
          title="Inserir campo, agrupar, somar coluna — as mesmas opções do botão direito numa célula"
        >
          Célula
          <ChevronDown size={12} />
        </button>
        <button
          type="button"
          className="ghost"
          onClick={(e) => handleHiddenAction("row", e)}
          style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, gap: "0.15rem", padding: "0.3rem 0.55rem", fontSize: "0.8rem" }}
          title="Marcar linha do turno/separadora/SOMA — as mesmas opções do botão direito no número da linha"
        >
          Linha
          <ChevronDown size={12} />
        </button>
        <button
          type="button"
          className="ghost"
          onClick={(e) => handleHiddenAction("column", e)}
          style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, gap: "0.15rem", padding: "0.3rem 0.55rem", fontSize: "0.8rem" }}
          title="Ajustar ao maior registro / tamanho fixo — as mesmas opções do botão direito na letra da coluna"
        >
          Coluna
          <ChevronDown size={12} />
        </button>
        {hiddenActionHint && (
          <span style={{ fontSize: "0.78rem", color: "var(--danger)", flexShrink: 0, whiteSpace: "nowrap" }}>
            {hiddenActionHint}
          </span>
        )}
      </div>
      <div
        ref={wrapperRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        // A bounded height is what makes this the actual scrolling
        // container — sticky headers stick relative to their nearest
        // scrolling ancestor, so without a cap here a tall grid would just
        // grow this div past the viewport and scroll the whole PAGE
        // instead, taking the "sticky" header row/gutter along with it.
        style={{ overflow: "auto", outline: "none", maxHeight: "70vh" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: templateColumns, gridTemplateRows: templateRows, width: "max-content" }}>
          <div
            style={{
              gridColumn: 1,
              gridRow: 1,
              background: "var(--card-bg-soft)",
              position: "sticky",
              top: 0,
              left: 0,
              zIndex: 3,
            }}
          />

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
                position: "sticky",
                top: 0,
                zIndex: 2,
                background: "var(--card-bg-soft)",
                textAlign: "center",
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                padding: "0.25rem 0",
                borderLeft: "1px solid var(--border)",
                borderRight: c === colCount - 1 ? "1px solid var(--border)" : undefined,
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
                  position: "sticky",
                  left: 0,
                  zIndex: 2,
                  background: badge ? badge.color : "var(--card-bg-soft)",
                  color: badge ? "#111" : "var(--text-muted)",
                  fontSize: "0.72rem",
                  fontWeight: badge ? 700 : 400,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderTop: "1px solid var(--border)",
                  borderBottom: r === rowCount - 1 ? "1px solid var(--border)" : undefined,
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
              const isSecondaryGrouped = secondaryHighlightExactValues?.has(cell.value.trim()) ?? false;
              const groupedTitle = [isGrouped && "Usado no agrupamento", isSecondaryGrouped && "Usado no agrupamento da SOMA"]
                .filter(Boolean)
                .join(" / ");
              const hasCustomBorder = Boolean(cell.border.top || cell.border.right || cell.border.bottom || cell.border.left);
              return (
                <div
                  key={`${r},${c}`}
                  className="template-grid-cell"
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
                  title={groupedTitle || undefined}
                  style={{
                    position: "relative",
                    // Adjacent grid cells each draw their own border right up
                    // to the shared pixel boundary between them — with every
                    // cell at the same (implicit) stacking order, whichever
                    // one is LATER in DOM order (i.e. the cell below/to the
                    // right) paints last and silently covers the earlier
                    // cell's line at that shared edge. A cell with a custom
                    // border needs to win that fight regardless of its
                    // position, or its own right/bottom sides render UNDER
                    // its neighbors' plain default gridlines and never show.
                    zIndex: hasCustomBorder ? 1 : undefined,
                    gridColumn: `${c + 2} / span ${colSpan}`,
                    gridRow: `${r + 2} / span ${rowSpan}`,
                    borderTop: borderSideToCss(cell.border.top) ?? "1px solid var(--border)",
                    borderLeft: borderSideToCss(cell.border.left) ?? "1px solid var(--border)",
                    borderRight:
                      borderSideToCss(cell.border.right) ?? (c + colSpan - 1 === colCount - 1 ? "1px solid var(--border)" : undefined),
                    borderBottom:
                      borderSideToCss(cell.border.bottom) ?? (r + rowSpan - 1 === rowCount - 1 ? "1px solid var(--border)" : undefined),
                    outline: inRange ? "2px solid var(--accent)" : "none",
                    outlineOffset: -2,
                    background: cell.backgroundColor ?? "transparent",
                    display: "flex",
                    alignItems: cell.verticalAlign === "top" ? "flex-start" : cell.verticalAlign === "bottom" ? "flex-end" : "center",
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
                  {isSecondaryGrouped && (
                    <span
                      title="Usado no agrupamento da SOMA"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: 0,
                        height: 3,
                        background: "#2dd4bf",
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
                        textAlign: cell.horizontalAlign ?? "left",
                      }}
                    />
                  ) : (
                    <span
                      style={{
                        width: "100%",
                        minWidth: 0,
                        padding: "0 0.35rem",
                        fontWeight: cell.bold ? 700 : 400,
                        fontStyle: cell.italic ? "italic" : "normal",
                        fontFamily: cell.fontFamily ?? "inherit",
                        fontSize: cell.fontSize ? `${cell.fontSize}pt` : "inherit",
                        color: cell.fontColor ?? "inherit",
                        textAlign: cell.horizontalAlign ?? "left",
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
