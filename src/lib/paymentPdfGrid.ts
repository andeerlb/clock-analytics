import jsPDF from "jspdf";
import { formatCurrencyBRL, formatMinutesAsTime } from "./format";
import { fieldDisplayValue, groupKeyValue, isBindableField } from "./paymentExportGrid";
import type {
  CellBorderSide,
  TemplateGridCell,
  TemplateGridData,
} from "./types";
import type { PaymentPdfTemplateConfig } from "./types";
import type { PaymentShiftReportRow } from "./db";

/**
 * Everything `paymentPdfExport.ts` needs that has NO Tauri dependency — the
 * PDF counterpart of `paymentExportGrid.ts`, split out for the same reason:
 * the grid/style/token logic (the part most worth getting right) can be
 * exercised in plain Node against a real jsPDF document, without needing the
 * Tauri runtime `paymentPdfExport.ts` itself requires (SQL plugin, save
 * dialog, fs write).
 *
 * Unlike the Excel side there is no one-shot "write this row at this number"
 * API — a PDF page has a fixed height, so this file owns pagination: rows are
 * drawn through a `PdfGridPainter` that tracks the cursor, breaks pages, and
 * re-draws the template's static header block at the top of every new page.
 */

const TOKEN_RE = /\{\{(\w+)\}\}/g;
const EXACT_TOKEN_RE = /^\{\{(\w+)\}\}$/;

function generatedAtText(): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(new Date());
}

/** 96dpi screen px → mm — every grid geometry (column widths, row heights, border widths) comes in editor pixels. */
const PX_TO_MM = 25.4 / 96;
/** PostScript points → mm — jsPDF font sizes are in pt, grid font sizes are editor px. */
const PT_TO_MM = 25.4 / 72;
/** Same px→pt rule as `pxToExcelPoints` (96dpi px * 0.75) — grid font sizes ARE px, jsPDF wants pt. */
const PX_FONT_TO_PT = 0.75;

/**
 * jsPDF only embeds the 14 standard PDF fonts. Template cells can name any of
 * `TemplateGridEditor`'s FONT_FAMILIES, so each is approximated by its closest
 * standard face — the same rough-approximation spirit as `pxToExcelWidth`:
 * layout stays true, the exact glyph shapes do not.
 */
function fontFamilyToJsPdf(family: string | null): string {
  switch (family) {
    case "Times New Roman":
    case "Georgia":
      return "times";
    case "Courier New":
      return "courier";
    default:
      // Calibri, Arial, Arial Black, Verdana, Tahoma, Trebuchet MS, Comic
      // Sans MS — all sans-serifs; the closest standard face is Helvetica.
      return "helvetica";
  }
}

/** `"#rrggbb"` → `[r, g, b]` for jsPDF's numeric color setters (its string form wants no "#"). */
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(value.slice(0, 2), 16) || 0,
    parseInt(value.slice(2, 4), 16) || 0,
    parseInt(value.slice(4, 6), 16) || 0,
  ];
}

/**
 * A cell's raw template text → the display string actually drawn in the PDF.
 * Unlike the Excel side (`renderTemplateCell`) nothing here stays a native
 * value: a PDF has no number format, so exact `{{valor}}` tokens become their
 * pt-BR currency text right here (dates/hours were already display strings
 * there too).
 */
export function renderPdfCellText(rawValue: string, row: PaymentShiftReportRow, amount: number | null): string {
  const trimmed = rawValue.trim();
  const exact = trimmed.match(EXACT_TOKEN_RE);
  if (exact) {
    const field = exact[1];
    if (!isBindableField(field)) return rawValue;
    if (field === "valor") return amount !== null ? formatCurrencyBRL(amount) : "";
    if (field === "generatedAt") return generatedAtText();
    return fieldDisplayValue(field, row, amount);
  }
  if (!rawValue.includes("{{")) return rawValue;
  return rawValue.replace(TOKEN_RE, (whole, field: string) =>
    isBindableField(field) ? field === "generatedAt" ? generatedAtText() : fieldDisplayValue(field, row, amount) : whole,
  );
}

/** A group's already-computed totals — everything a SOMA row can print (a PDF has no live SUM formulas). */
export interface PdfGroupSums {
  valor: number;
  workedHoursMinutes: number;
}

/**
 * A SOMA row cell: `{{valorSoma}}` (legacy) and `{{soma:valor}}` print the
 * group's total amount, `{{soma:workedHours}}` its total duration; anything
 * else passes through verbatim so labels keep working.
 */
export function renderPdfSumCell(rawValue: string, sums: PdfGroupSums): string {
  const trimmed = rawValue.trim();
  if (trimmed === "{{valorSoma}}" || trimmed === "{{soma:valor}}") return formatCurrencyBRL(sums.valor);
  if (trimmed === "{{soma:workedHours}}") return formatMinutesAsTime(sums.workedHoursMinutes);
  return rawValue;
}

/** A shift's worked duration in minutes, or `null` — mirrors `paymentExportGrid`'s private helper without importing more surface. */
function workedMinutesOf(row: PaymentShiftReportRow): number | null {
  return row.scheduleStartMinutes !== null && row.scheduleEndMinutes !== null
    ? row.scheduleStartMinutes <= row.scheduleEndMinutes
      ? row.scheduleEndMinutes - row.scheduleStartMinutes
      : 24 * 60 - row.scheduleStartMinutes + row.scheduleEndMinutes
    : null;
}

/**
 * A group-header cell — the text-only counterpart of `renderGroupCell`. Group
 * tokens (`{{quantidade}}`, `{{soma:f}}`, `{{primeiro:f}}`, `{{ultimo:f}}`,
 * `{{lista:f}}`) render over the whole group's rows, whether they're the whole
 * cell or mixed into other text; any plain `{{field}}` token falls back to the
 * group's first row, same rule as the Excel side.
 */
export function renderPdfGroupCell(
  rawValue: string,
  rows: PaymentShiftReportRow[],
  amounts: Map<PaymentShiftReportRow, number | null>,
): string {
  if (rows.length === 0) return rawValue;
  if (!rawValue.includes("{{")) return rawValue;
  return rawValue.replace(/\{\{(\w+)(?::(\w+))?\}\}/g, (whole, name: string, field?: string) => {
    if (field === undefined) {
      // No ":field" part — either {{quantidade}} or a plain bindable field.
      if (name === "quantidade") return String(rows.length);
      return isBindableField(name) ? fieldDisplayValue(name, rows[0], amounts.get(rows[0]) ?? null) : whole;
    }
    if (!isBindableField(field)) return whole;
    if (name === "soma" && field === "valor") {
      return formatCurrencyBRL(rows.reduce((total, row) => total + (amounts.get(row) ?? 0), 0));
    }
    if (name === "soma" && field === "workedHours") {
      const minutes = rows.reduce((total, row) => {
        const m = workedMinutesOf(row);
        return total + (m !== null ? m : 0);
      }, 0);
      return formatMinutesAsTime(minutes);
    }
    if (name === "primeiro") return fieldDisplayValue(field, rows[0], amounts.get(rows[0]) ?? null);
    if (name === "ultimo") {
      const last = rows[rows.length - 1];
      return fieldDisplayValue(field, last, amounts.get(last) ?? null);
    }
    if (name === "lista") return rows.map((row) => fieldDisplayValue(field, row, amounts.get(row) ?? null)).join(", ");
    return whole;
  });
}

export { groupKeyValue as pdfGroupKeyValue };

const DEFAULT_ROW_HEIGHT_PX = 30;

export interface PdfGridPainterOptions {
  orientation: "portrait" | "landscape";
  /** Outer page margin in mm — the same generous-but-compact choice the hand-built report this file's painter replaced used to make. */
  pageMarginMm?: number;
}

export interface DrawTemplateRowOptions {
  /** Substitutes each cell's raw text — used for repeating detail/group-header/separator/SOMA rows; omitted for the static header block, which is drawn verbatim. */
  renderCell?: (colIndex: number, rawValue: string) => string;
  /**
   * Only true for the static header block. A repeating row caps every merge
   * anchored on it to its own single row (colSpan only, rowSpan forced to 1) —
   * a merge spanning rows would bleed into whatever the next repeated record
   * draws there, same rule as `writeTemplateRow` on the Excel side.
   */
  honorRowSpan?: boolean;
  /** Optional fallback fill for cells without their own background, used for zebra-striped detail rows. */
  rowBackgroundColor?: string;
}

/** jsPDF's standard fonts have uneven style support (courier has no italic) — degrade instead of throwing. */
function fontStyleFor(family: string, bold: boolean, italic: boolean): string {
  if (family === "courier") return bold ? "bold" : "normal";
  if (bold && italic) return "bolditalic";
  if (bold) return "bold";
  if (italic) return "italic";
  return "normal";
}

/** Total scaled width of the columns AFTER `c` within a `colSpan`-wide merge (callers add column `c`'s own width separately). */
function mergeColWidth(colW: number[], c: number, colSpan: number): number {
  let total = 0;
  for (let i = 1; i < colSpan; i++) total += colW[c + i] ?? 0;
  return total;
}

/**
 * Draws a `TemplateGridData` onto a jsPDF document, page by page. The grid's
 * pixel geometry is scaled down (never up) to fit the page's printable width,
 * then rows are painted top-down; when the cursor would run past the bottom
 * margin, a new page starts and the header-row block (set via `setHeaderRows`)
 * is re-drawn there first.
 */
export class PdfGridPainter {
  readonly doc: jsPDF;
  private readonly grid: TemplateGridData;
  private readonly margin: number;
  private readonly scale: number;
  /** Scaled left-edge x (mm) per column — `colX[c] + colW[c]` is column c's right edge. */
  private readonly colX: number[];
  private readonly colW: number[];
  private y: number;
  private headerRows: number[] = [];

  constructor(grid: TemplateGridData, options: PdfGridPainterOptions) {
    this.grid = grid;
    this.margin = options.pageMarginMm ?? 8;
    this.doc = new jsPDF({ orientation: options.orientation, unit: "mm", format: "a4" });
    const pageWidth = this.doc.internal.pageSize.getWidth();
    const gridWidthMm = grid.columnWidths.reduce((total, w) => total + w * PX_TO_MM, 0);
    const printableWidth = pageWidth - 2 * this.margin;
    this.scale = printableWidth / gridWidthMm;
    this.colX = [];
    this.colW = [];
    let x = this.margin;
    for (const w of grid.columnWidths) {
      const scaled = w * PX_TO_MM * this.scale;
      this.colX.push(x);
      this.colW.push(scaled);
      x += scaled;
    }
    this.y = this.margin;
  }

  /** The static block (rows above the detail row) to repeat at the top of every page — pass the indexes in top-down order. */
  setHeaderRows(rowIndexes: number[]) {
    this.headerRows = rowIndexes;
  }

  /** Scaled height (mm) of one template row. */
  private rowHeightMm(templateRowIndex: number): number {
    return Math.max(2, (this.grid.rowHeights?.[templateRowIndex] ?? DEFAULT_ROW_HEIGHT_PX) * PX_TO_MM * this.scale);
  }

  private pageBottom(): number {
    return this.doc.internal.pageSize.getHeight() - this.margin;
  }

  private startNewPage() {
    this.doc.addPage();
    this.y = this.margin;
    for (const r of this.headerRows) {
      this.drawRow(r);
    }
  }

  /** One cell's merge (anchored on `row`), or `null` — honoring `honorRowSpan` for the header block only. */
  private mergeAt(row: number, col: number, honorRowSpan: boolean): { colSpan: number; rowSpan: number } | null {
    const merge = (this.grid.merges ?? []).find((m) => m.row === row && m.col === col);
    if (!merge) return null;
    return { colSpan: merge.colSpan, rowSpan: honorRowSpan ? merge.rowSpan : 1 };
  }

  /** Whether the cell at `row`/`col` is covered by a merge anchored on an EARLIER row (only reachable within the header block — repeating rows cap rowSpan to 1). */
  private coveredByEarlierMerge(row: number, col: number): boolean {
    return (this.grid.merges ?? []).some(
      (m) => m.row < row && m.row + m.rowSpan > row && m.col <= col && m.col + m.colSpan > col,
    );
  }

  /**
   * Draws one template row (values, per-cell background/text color/bold/
   * italic/font/alignment, per-side borders, and any merge anchored on it) at
   * the cursor, paginating first if needed — including reserving room for a
   * rowSpan merge's lower rows, so a page break never lands inside one.
   */
  drawRow(templateRowIndex: number, options: DrawTemplateRowOptions = {}): void {
    const height = this.rowHeightMm(templateRowIndex);
    const honorRowSpan = options.honorRowSpan ?? false;

    // How far below this row a merge anchored on it reaches — only knowable
    // from the grid's own row heights, since those rows haven't been drawn yet.
    const spansDown = (col: number): number => {
      const merge = this.mergeAt(templateRowIndex, col, honorRowSpan);
      if (!merge || merge.rowSpan <= 1) return 0;
      let extra = 0;
      for (let r = templateRowIndex + 1; r < templateRowIndex + merge.rowSpan; r++) extra += this.rowHeightMm(r);
      return extra;
    };
    const maxSpanDown = this.grid.columnWidths.reduce((max, _, c) => Math.max(max, spansDown(c)), 0);
    if (this.y + height + maxSpanDown > this.pageBottom()) {
      this.startNewPage();
      // Re-check on the fresh page — a single row taller than a whole page
      // must still draw (clipped) rather than loop forever.
      if (this.y + height > this.pageBottom() && this.y > this.margin) return this.drawRow(templateRowIndex, options);
    }
    const top = this.y;

    const templateRow = this.grid.rows[templateRowIndex] ?? [];
    const cellRect = (c: number): { x: number; width: number; height: number } => {
      const merge = this.mergeAt(templateRowIndex, c, honorRowSpan);
      const width = merge ? this.colW[c] + mergeColWidth(this.colW, c, merge.colSpan) : this.colW[c];
      return { x: this.colX[c], width, height: height + spansDown(c) };
    };

    // Fills first (bottom layer), then text, then borders — so a cell's own
    // border is never painted over by a neighbour's fill.
    templateRow.forEach((cell, c) => {
      if (this.coveredByEarlierMerge(templateRowIndex, c)) return;
      const { x, width, height: fullHeight } = cellRect(c);
      const backgroundColor = cell.backgroundColor ?? options.rowBackgroundColor;
      if (backgroundColor) {
        const [r, g, b] = hexToRgb(backgroundColor);
        this.doc.setFillColor(r, g, b);
        this.doc.rect(x, top, width, fullHeight, "F");
      }
    });
    templateRow.forEach((cell, c) => {
      if (this.coveredByEarlierMerge(templateRowIndex, c)) return;
      const { x, width, height: fullHeight } = cellRect(c);
      const text = options.renderCell ? options.renderCell(c, cell.value) : cell.value;
      if (text !== "") this.drawText(text, cell, x, top, width, fullHeight);
    });
    templateRow.forEach((cell, c) => {
      if (this.coveredByEarlierMerge(templateRowIndex, c)) return;
      const { x, width, height: fullHeight } = cellRect(c);
      this.drawBorders(cell, x, top, width, fullHeight);
    });

    this.y = top + height;
  }

  /** Wrapped, aligned text inside one cell rectangle (1mm padding, vertically centered by default — the same defaults the grid editor shows). */
  private drawText(text: string, cell: TemplateGridCell, x: number, y: number, width: number, height: number) {
    const fontSizePt = Math.max(1, (cell.fontSize ?? 11) * PX_FONT_TO_PT * this.scale);
    const family = fontFamilyToJsPdf(cell.fontFamily);
    const style = fontStyleFor(family, cell.bold, cell.italic);
    this.doc.setFont(family, style);
    this.doc.setFontSize(fontSizePt);

    const pad = 1;
    const lines = this.doc.splitTextToSize(text, Math.max(1, width - 2 * pad)) as string[];
    const lineHeightMm = fontSizePt * PT_TO_MM * 1.15;
    const textHeight = lines.length * lineHeightMm;

    let firstBaseline: number;
    switch (cell.verticalAlign ?? "middle") {
      case "top":
        firstBaseline = y + pad + lineHeightMm * 0.8;
        break;
      case "bottom":
        firstBaseline = y + height - pad - textHeight + lineHeightMm * 0.8;
        break;
      default:
        firstBaseline = y + (height - textHeight) / 2 + lineHeightMm * 0.8;
    }

    const align = cell.horizontalAlign === "center" ? "center" : cell.horizontalAlign === "right" ? "right" : "left";
    const textX = align === "center" ? x + width / 2 : align === "right" ? x + width - pad : x + pad;

    const [r, g, b] = hexToRgb(cell.fontColor ?? "#444444");
    this.doc.setTextColor(r, g, b);
    this.doc.text(lines, textX, firstBaseline, { align, baseline: "alphabetic" });
  }

  /** Per-side border lines, honoring pattern (dashed/dotted/double) and free-form px width. */
  private drawBorders(cell: TemplateGridCell, x: number, y: number, width: number, height: number) {
    const border = cell.border;
    if (!border) return;
    const sides: Array<[CellBorderSide | null, "top" | "right" | "bottom" | "left"]> = [
      [border.top, "top"],
      [border.right, "right"],
      [border.bottom, "bottom"],
      [border.left, "left"],
    ];
    for (const [side, which] of sides) {
      if (!side) continue;
      const [r, g, b] = hexToRgb(side.color);
      this.doc.setDrawColor(r, g, b);
      const lineWidth = Math.max(0.1, side.width * PX_TO_MM * this.scale);
      this.doc.setLineWidth(lineWidth);
      if (side.pattern === "dashed") this.doc.setLineDashPattern([lineWidth * 3, lineWidth * 2], 0);
      else if (side.pattern === "dotted") this.doc.setLineDashPattern([lineWidth, lineWidth * 1.5], 0);
      else this.doc.setLineDashPattern([], 0);
      if (side.pattern === "double") {
        const offset = Math.max(0.2, lineWidth);
        this.drawBorderLine(which, x, y, width, height, -offset / 2);
        this.drawBorderLine(which, x, y, width, height, offset / 2);
      } else {
        this.drawBorderLine(which, x, y, width, height, 0);
      }
    }
    this.doc.setLineDashPattern([], 0);
  }

  private drawBorderLine(
    which: "top" | "right" | "bottom" | "left",
    x: number,
    y: number,
    width: number,
    height: number,
    offset: number,
  ) {
    if (which === "top") this.doc.line(x, y + offset, x + width, y + offset);
    else if (which === "bottom") this.doc.line(x, y + height + offset, x + width, y + height + offset);
    else if (which === "left") this.doc.line(x + offset, y, x + offset, y + height);
    else this.doc.line(x + width + offset, y, x + width + offset, y + height);
  }
}

/**
 * The whole "rows → painted PDF" flow shared by the real export
 * (`paymentPdfExport.ts`) and the editor's live preview: sorts by the
 * template's grouping (detail fields as a stable tiebreaker), draws the static
 * header block once (the painter re-draws it on every page break), then per
 * group the optional G row, one detail row per turno, and the trailing
 * separator/SOMA rows in the order they sit in the grid itself. Returns the
 * painter so the caller can either write `painter.doc` out or keep rendering.
 */
export function drawPdfDocument(
  config: PaymentPdfTemplateConfig,
  rows: PaymentShiftReportRow[],
  amounts: Map<PaymentShiftReportRow, number | null>,
): PdfGridPainter {
  const grid = config.grid;
  function groupKeyOf(row: PaymentShiftReportRow): string {
    return config.groupBy.map((f) => groupKeyValue(f, row, amounts.get(row) ?? null)).join(" ");
  }

  // Groups must be contiguous runs, so sort by the same key that decides
  // boundaries — same rule as the Excel export's sort (minus the independent
  // SOMA grouping, which PDF templates don't have), with the detail fields as
  // a stable tiebreaker inside each group.
  const sorted = [...rows].sort((a, b) => {
    const groupCompare = groupKeyOf(a).localeCompare(groupKeyOf(b), undefined, { numeric: true });
    if (groupCompare !== 0) return groupCompare;
    return (
      a.workDate.localeCompare(b.workDate) ||
      a.local.localeCompare(b.local) ||
      a.employeeName.localeCompare(b.employeeName) ||
      (a.scheduleStartMinutes ?? -1) - (b.scheduleStartMinutes ?? -1)
    );
  });

  const painter = new PdfGridPainter(grid, { orientation: config.orientation ?? "landscape" });

  // The static block (rows above the detail row) is written once at the top,
  // verbatim — and again at the top of every page the report spills onto.
  const headerRows: number[] = [];
  for (let r = 0; r < config.detailRowIndex && r < grid.rows.length; r++) headerRows.push(r);
  painter.setHeaderRows(headerRows);
  for (const r of headerRows) {
    painter.drawRow(r, {
      honorRowSpan: true,
      renderCell: (_c, raw) => raw.replace(TOKEN_RE, (whole, field: string) => field === "generatedAt" ? generatedAtText() : whole),
    });
  }

  // Each group: optional header row, one detail row per turno, then the
  // template's trailing rows (separator / SOMA) in the order they sit in the
  // grid itself — same layout-decides-the-order rule as the Excel export.
  const trailing = [
    ...(config.separator?.enabled
      ? [{ kind: "separator" as const, rowIndex: config.separator.rowIndex }]
      : []),
    ...(config.subtotal?.enabled
      ? [{ kind: "subtotal" as const, rowIndex: config.subtotal.rowIndex }]
      : []),
  ].sort((a, b) => a.rowIndex - b.rowIndex);

  let currentKey: string | null = null;
  let groupRows: PaymentShiftReportRow[] = [];
  let sums = { valor: 0, workedHoursMinutes: 0 };
  let detailRowCount = 0;

  function flushGroup() {
    if (groupRows.length === 0) return;
    if (config.groupHeader?.enabled) {
      painter.drawRow(config.groupHeader.rowIndex, {
        renderCell: (_c, raw) => renderPdfGroupCell(raw, groupRows, amounts),
      });
    }
    for (const row of groupRows) {
      const amount = amounts.get(row) ?? null;
      painter.drawRow(config.detailRowIndex, {
        renderCell: (_c, raw) => renderPdfCellText(raw, row, amount),
        rowBackgroundColor: detailRowCount % 2 === 1 ? "#f3f3f3" : "#ffffff",
      });
      detailRowCount += 1;
    }
    for (const trailingRow of trailing) {
      if (trailingRow.kind === "separator") {
        painter.drawRow(trailingRow.rowIndex);
      } else {
        painter.drawRow(trailingRow.rowIndex, {
          renderCell: (_c, raw) => renderPdfSumCell(raw, sums),
          rowBackgroundColor: grid.rows[trailingRow.rowIndex]?.find((cell) => cell.backgroundColor)?.backgroundColor ?? undefined,
        });
      }
    }
    groupRows = [];
    sums = { valor: 0, workedHoursMinutes: 0 };
  }

  for (const row of sorted) {
    const key = groupKeyOf(row);
    if (currentKey === null) currentKey = key;
    if (key !== currentKey) {
      flushGroup();
      currentKey = key;
    }
    groupRows.push(row);
    sums.valor += amounts.get(row) ?? 0;
    const start = row.scheduleStartMinutes;
    const end = row.scheduleEndMinutes;
    if (start !== null && end !== null) {
      sums.workedHoursMinutes += start <= end ? end - start : 24 * 60 - start + end;
    }
  }
  flushGroup();

  return painter;
}


