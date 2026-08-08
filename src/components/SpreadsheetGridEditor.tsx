import jspreadsheet from "jspreadsheet-ce";
import "jspreadsheet-ce/dist/jspreadsheet.css";
import "jspreadsheet-ce/dist/jspreadsheet.themes.css";
import "jsuites/dist/jsuites.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface SpreadsheetGridEditorHandle {
  /** The current grid state (data/style/mergeCells/columns/...) — opaque, meant to be persisted as-is and passed back as `initialGrid` later (see `PaymentExportTemplateConfig.grid`). */
  getConfig: () => Record<string, unknown>;
  /** Writes `value` into `cell` — used by the field-token palette to insert a `{{field}}` token into whichever cell was last selected (tracked by the caller via `onSelectionChange`, not re-queried here — jspreadsheet-ce clears its own live selection once focus leaves the grid, e.g. clicking a token button in the side panel, so asking it "what's selected" at that point always comes back empty). */
  setCellValue: (cell: string, value: string) => void;
}

/** The top-left corner of the current selection (0-based row/column) — enough for the editor page's "use this row/column" row-role and subtotal-column pickers, which only ever care about one anchor cell, not a whole range. */
export interface GridSelection {
  row: number;
  col: number;
}

interface SpreadsheetGridEditorProps {
  /** A previously-saved grid config (from `getConfig()`), or `null`/`undefined` for a fresh blank starter grid. */
  initialGrid?: Record<string, unknown> | null;
  /** Fires whenever the selection changes — `null` when nothing is selected. */
  onSelectionChange?: (selection: GridSelection | null) => void;
}

const BLANK_ROWS = 20;
const BLANK_COLS = 10;

function blankData(): string[][] {
  return Array.from({ length: BLANK_ROWS }, () => Array.from({ length: BLANK_COLS }, () => ""));
}

/**
 * Thin ref-based wrapper around jspreadsheet-ce — every direct call into the
 * library is isolated to this one file, so the rest of the app (the export
 * template editor page) only ever deals with a plain "grid config" object
 * and this small imperative handle, never the library's own instance/API
 * surface. `initialGrid`/`onSelectionChange` are only read on mount —
 * jspreadsheet owns the DOM/state from then on, same as any other
 * uncontrolled-widget wrapper (an editable grid re-rendering from React
 * props on every keystroke would fight the library and drop in-progress
 * edits).
 */
const SpreadsheetGridEditor = forwardRef<SpreadsheetGridEditorHandle, SpreadsheetGridEditorProps>(
  function SpreadsheetGridEditor({ initialGrid, onSelectionChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const worksheetRef = useRef<jspreadsheet.WorksheetInstance | null>(null);
    const initialGridRef = useRef(initialGrid);
    const onSelectionChangeRef = useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      // `jspreadsheet.destroy()` (in the cleanup below) deactivates the
      // instance but does NOT remove the table it inserted into `el` — so
      // under React 18 StrictMode's dev-only mount→cleanup→mount cycle, the
      // second mount would insert a second table alongside the first
      // (leftover) one instead of replacing it. Clearing the container
      // ourselves, on every mount, makes this idempotent regardless of how
      // many times the effect re-runs.
      el.replaceChildren();

      const startingGrid = (initialGridRef.current as jspreadsheet.WorksheetOptions | null) ?? {
        data: blankData(),
        minDimensions: [BLANK_COLS, BLANK_ROWS],
      };

      const worksheets = jspreadsheet(el, {
        worksheets: [startingGrid],
        onselection: (_instance, left, top) => {
          onSelectionChangeRef.current?.({ row: Number(top), col: Number(left) });
        },
      });
      worksheetRef.current = worksheets[0];

      return () => {
        jspreadsheet.destroy(el as jspreadsheet.JspreadsheetInstanceElement, true);
        el.replaceChildren();
        worksheetRef.current = null;
      };
      // Deliberately mount-once — see the doc comment above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      getConfig: () => (worksheetRef.current?.getConfig() ?? {}) as Record<string, unknown>,
      setCellValue: (cell, value) => {
        worksheetRef.current?.setValue(cell, value);
      },
    }));

    return <div ref={containerRef} />;
  },
);

export default SpreadsheetGridEditor;
