import { CircleHelp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import PaymentExportTemplateHelpDrawer from "../components/PaymentExportTemplateHelpDrawer";
import TemplateGridEditor, {
  FONT_FAMILIES,
  FONT_SIZES,
  type RowBadge,
  type TemplateGridEditorHandle,
} from "../components/TemplateGridEditor";
import { createPaymentExportTemplate, getPaymentExportTemplate, updatePaymentExportTemplate } from "../lib/db";
import { isBindableField } from "../lib/paymentExportGrid";
import type { PaymentExportTemplateExample } from "../lib/paymentExportTemplateExamples";
import {
  PAYMENT_EXPORT_BINDABLE_FIELD_LABELS,
  type PaymentExportBindableField,
  type PaymentExportTemplateConfig,
  type TemplateGridData,
} from "../lib/types";

const ALL_FIELDS = Object.keys(PAYMENT_EXPORT_BINDABLE_FIELD_LABELS) as PaymentExportBindableField[];
const DETAIL_BADGE_COLOR = "#60a5fa";

/** Fields still represented by an exact token somewhere in the visible grid. */
function fieldsPresentInGrid(grid: TemplateGridData): Set<PaymentExportBindableField> {
  const fields = new Set<PaymentExportBindableField>();
  for (const row of grid.rows) {
    for (const cell of row) {
      const field = cell.value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
      if (field && isBindableField(field)) fields.add(field);
    }
  }
  return fields;
}

interface OpenContextMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** A labeled color swatch — used both by the right-click row-menu (once a row already holds the separator/SOMA role, so its color can be changed without leaving the menu) and by the cell context menu's bulk "Cor de fundo"/"Cor do texto" rows. */
function ColorSwatchRow({
  label = "Cor",
  color,
  onChange,
}: {
  label?: string;
  color: string;
  onChange: (color: string) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
      {label}
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "1.8rem", height: "1.8rem", padding: 0 }}
      />
    </label>
  );
}

export default function PaymentExportTemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();
  const gridRef = useRef<TemplateGridEditorHandle>(null);

  const [name, setName] = useState("");
  const [initialGrid, setInitialGrid] = useState<TemplateGridData | null>(null);
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exampleTarget, setExampleTarget] = useState<PaymentExportTemplateExample | null>(null);
  const [gridRevision, setGridRevision] = useState(0);

  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [groupBy, setGroupBy] = useState<PaymentExportBindableField[]>([]);
  /** Independent from `groupBy` — see `PaymentExportTemplateConfig.subtotalGroupBy`'s own doc comment. Initialized to mirror `groupBy` (old behavior: one SOMA per turno-group) and only diverges once the user explicitly toggles a field via the cell context menu. */
  const [subtotalGroupBy, setSubtotalGroupBy] = useState<PaymentExportBindableField[]>([]);

  const [separatorEnabled, setSeparatorEnabled] = useState(false);
  const [separatorRowIndex, setSeparatorRowIndex] = useState<number | null>(null);
  const [separatorColor, setSeparatorColor] = useState("#22c55e");

  const [subtotalEnabled, setSubtotalEnabled] = useState(false);
  const [subtotalRowIndex, setSubtotalRowIndex] = useState<number | null>(null);
  const [subtotalColor, setSubtotalColor] = useState("#facc15");
  const [groupHeaderRowIndex, setGroupHeaderRowIndex] = useState<number | null>(null);
  const [consolidatedRowIndex, setConsolidatedRowIndex] = useState<number | null>(null);
  const [outlineEnabled, setOutlineEnabled] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);

  const [contextMenu, setContextMenu] = useState<OpenContextMenu | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    getPaymentExportTemplate(Number(id))
      .then((t) => {
        setName(t.name);
        setInitialGrid(t.config.grid);
        setDetailRowIndex(t.config.detailRowIndex);
        setGroupBy(t.config.groupBy);
        setSubtotalGroupBy(t.config.subtotalGroupBy ?? t.config.groupBy);
        setSeparatorEnabled(t.config.separator?.enabled ?? false);
        setSeparatorRowIndex(t.config.separator?.rowIndex ?? null);
        setSubtotalEnabled(t.config.subtotal?.enabled ?? false);
        setSubtotalRowIndex(t.config.subtotal?.rowIndex ?? null);
        setGroupHeaderRowIndex(t.config.groupHeader?.rowIndex ?? null);
        setConsolidatedRowIndex(t.config.consolidated?.rowIndex ?? null);
        setOutlineEnabled(t.config.outline?.enabled ?? false);
        setOutlineCollapsed(t.config.outline?.collapsed ?? false);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, isEditing]);

  // The grid only mounts once `loading` turns false (see the early return
  // below) — right after that, pull whatever color is already painted on
  // the separator/SOMA rows (if this template already had them marked), so
  // the pickers reflect the sheet instead of always resetting to the
  // default swatch.
  useEffect(() => {
    if (loading) return;
    if (separatorRowIndex !== null) {
      const color = gridRef.current?.getRowBackgroundColor(separatorRowIndex);
      if (color) setSeparatorColor(color);
    }
    if (subtotalRowIndex !== null) {
      const color = gridRef.current?.getRowBackgroundColor(subtotalRowIndex);
      if (color) setSubtotalColor(color);
    }
    // Only on the mount right after loading finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Marking a row (or changing its color) only paints its role badge in the
  // row-number gutter — see `rowBadges` below — it never touches the actual
  // data cells' backgroundColor, so the user's own cell formatting in that
  // row is left alone.
  function markSeparatorRow(row: number) {
    setSeparatorEnabled(true);
    setSeparatorRowIndex(row);
  }

  function handleSeparatorColorChange(color: string) {
    setSeparatorColor(color);
  }

  function markSubtotalRow(row: number) {
    setSubtotalEnabled(true);
    setSubtotalRowIndex(row);
  }

  function handleSubtotalColorChange(color: string) {
    setSubtotalColor(color);
  }

  /** Right-click on a data cell. Formatting items (bold/italic/font/color) act on the whole current selection; structural items ("Inserir campo", agrupamento, SOMA shortcut, cor removal) always target exactly `row`/`col` — the cell actually clicked. */
  function handleCellContextMenu(
    row: number,
    col: number,
    value: string,
    backgroundColor: string | null,
    fontColor: string | null,
    x: number,
    y: number,
  ) {
    // Every formatting item below acts on the whole current selection (via
    // `patchSelection`), not just this one right-clicked cell — so
    // multi-selecting a range and right-clicking applies bold/italic/font/
    // color to every cell in it at once, same as Excel/Sheets. A plain
    // single-cell click is just a range of one, so this reads right either
    // way. `anchor` is that range's top-left cell, used to pre-fill
    // checkmarks/swatches with its current formatting.
    const anchor = gridRef.current?.getAnchorCell() ?? null;

    const items: ContextMenuItem[] = [
      {
        label: "Inserir campo",
        submenu: ALL_FIELDS.map((f) => ({
          label: PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f],
          onClick: () => {
            gridRef.current?.setCellValue(row, col, `{{${f}}}`);
            // The very first field ever inserted, with no linha do turno
            // marked yet, almost certainly means "this is the row that
            // repeats" — saves the extra right-click-on-the-row-number
            // step for the common case, without overriding a row the user
            // already chose deliberately.
            if (detailRowIndex === null) setDetailRowIndex(row);
          },
        })),
      },
      { separator: true },
      { label: "Negrito", onClick: () => gridRef.current?.patchSelection({ bold: !anchor?.bold }) },
      { label: "Itálico", onClick: () => gridRef.current?.patchSelection({ italic: !anchor?.italic }) },
      {
        label: "Fonte",
        submenu: FONT_FAMILIES.map((f) => ({
          label: f,
          onClick: () => gridRef.current?.patchSelection({ fontFamily: f === "Calibri" ? null : f }),
        })),
      },
      {
        label: "Tamanho da fonte",
        submenu: FONT_SIZES.map((s) => ({
          label: String(s),
          onClick: () => gridRef.current?.patchSelection({ fontSize: s === 11 ? null : s }),
        })),
      },
      { render: () => <ColorSwatchRow label="Cor do texto" color={anchor?.fontColor ?? "#000000"} onChange={(c) => gridRef.current?.patchSelection({ fontColor: c })} /> },
      { render: () => <ColorSwatchRow label="Cor de fundo" color={anchor?.backgroundColor ?? "#ffffff"} onChange={(c) => gridRef.current?.patchSelection({ backgroundColor: c })} /> },
      {
        label: "Alinhamento horizontal",
        submenu: [
          { label: "Esquerda", onClick: () => gridRef.current?.patchSelection({ horizontalAlign: "left" }) },
          { label: "Centralizado", onClick: () => gridRef.current?.patchSelection({ horizontalAlign: "center" }) },
          { label: "Direita", onClick: () => gridRef.current?.patchSelection({ horizontalAlign: "right" }) },
          { label: "Justificado", onClick: () => gridRef.current?.patchSelection({ horizontalAlign: "justify" }) },
        ],
      },
      {
        label: "Alinhamento vertical",
        submenu: [
          { label: "Topo", onClick: () => gridRef.current?.patchSelection({ verticalAlign: "top" }) },
          { label: "Meio", onClick: () => gridRef.current?.patchSelection({ verticalAlign: "middle" }) },
          { label: "Base", onClick: () => gridRef.current?.patchSelection({ verticalAlign: "bottom" }) },
        ],
      },
      {
        label: "Borda",
        // Uses a fixed 1px sólida preta brush — the toolbar's own "Bordas"
        // button (with pattern/thickness/color pickers) is where a
        // different look is chosen; this is just the same quick
        // position shortcuts available without leaving the cell menu.
        submenu: [
          { label: "Todas", onClick: () => gridRef.current?.applyBorderToSelection("all", { width: 1, pattern: "solid", color: "#000000" }) },
          {
            label: "Internas",
            onClick: () => gridRef.current?.applyBorderToSelection("inner", { width: 1, pattern: "solid", color: "#000000" }),
          },
          {
            label: "Contorno",
            onClick: () => gridRef.current?.applyBorderToSelection("outline", { width: 1, pattern: "solid", color: "#000000" }),
          },
          { label: "Topo", onClick: () => gridRef.current?.applyBorderToSelection("top", { width: 1, pattern: "solid", color: "#000000" }) },
          {
            label: "Direita",
            onClick: () => gridRef.current?.applyBorderToSelection("right", { width: 1, pattern: "solid", color: "#000000" }),
          },
          {
            label: "Baixo",
            onClick: () => gridRef.current?.applyBorderToSelection("bottom", { width: 1, pattern: "solid", color: "#000000" }),
          },
          {
            label: "Esquerda",
            onClick: () => gridRef.current?.applyBorderToSelection("left", { width: 1, pattern: "solid", color: "#000000" }),
          },
          {
            label: "Nenhuma",
            onClick: () => gridRef.current?.applyBorderToSelection("none", { width: 1, pattern: "solid", color: "#000000" }),
          },
        ],
      },
    ];

    if (row === groupHeaderRowIndex || row === consolidatedRowIndex) {
      items.unshift(
        {
          label: "Inserir resumo do bloco",
          submenu: [
            { label: "Quantidade de turnos", onClick: () => gridRef.current?.setCellValue(row, col, "{{quantidade}}") },
            { label: "Somar valores", onClick: () => gridRef.current?.setCellValue(row, col, "{{soma:valor}}") },
            { label: "Somar horas trabalhadas", onClick: () => gridRef.current?.setCellValue(row, col, "{{soma:workedHours}}") },
            {
              label: "Listar valores únicos",
              submenu: ALL_FIELDS.map((field) => ({ label: PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[field], onClick: () => gridRef.current?.setCellValue(row, col, `{{lista:${field}}}`) })),
            },
            {
              label: "Primeiro registro",
              submenu: ALL_FIELDS.map((field) => ({ label: PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[field], onClick: () => gridRef.current?.setCellValue(row, col, `{{primeiro:${field}}}`) })),
            },
            {
              label: "Último registro",
              submenu: ALL_FIELDS.map((field) => ({ label: PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[field], onClick: () => gridRef.current?.setCellValue(row, col, `{{ultimo:${field}}}`) })),
            },
          ],
        },
        { separator: true },
      );
    }

    const exactField = value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
    if (exactField && isBindableField(exactField)) {
      items.push({ separator: true });
      const alreadyGrouped = groupBy.includes(exactField);
      items.push({
        label: alreadyGrouped
          ? `Não separar mais por "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}"`
          : `Separar blocos por "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}"`,
        onClick: () =>
          setGroupBy((prev) => (alreadyGrouped ? prev.filter((f) => f !== exactField) : [...prev, exactField])),
      });
      // Independent from the turno grouping above — lets a SOMA total a
      // wider (or narrower) group than the detail rows it's summing, e.g.
      // a single "soma geral" for the whole export while the turno rows
      // themselves still break per colaborador. Offered whenever there's a
      // SOMA row at all, not just while right-clicking it, since the field
      // being toggled lives on a detail-row cell, not the SOMA row itself.
      if (subtotalEnabled) {
        const alreadySubtotalGrouped = subtotalGroupBy.includes(exactField);
        items.push({
          label: alreadySubtotalGrouped
            ? `Não calcular mais subtotal por "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}"`
            : `Calcular subtotal por "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}"`,
          onClick: () =>
            setSubtotalGroupBy((prev) =>
              alreadySubtotalGrouped ? prev.filter((f) => f !== exactField) : [...prev, exactField],
            ),
        });
      }
    }

    // A subtotal cell sums the numeric field used by the detail row in the
    // same column. This keeps the action spreadsheet-like while supporting
    // both money and worked-duration columns.
    if (subtotalEnabled && subtotalRowIndex === row && detailRowIndex !== null) {
      const detailToken = gridRef.current?.getGrid().rows[detailRowIndex]?.[col]?.value.trim();
      const summableField = detailToken === "{{valor}}" ? "valor" : detailToken === "{{workedHours}}" ? "workedHours" : null;
      if (summableField) {
        const sumToken = `{{soma:${summableField}}}`;
        items.push({ separator: true });
        items.push({
          label: summableField === "valor" ? "Somar valores desta coluna" : "Somar horas desta coluna",
          onClick: () => gridRef.current?.setCellValue(row, col, sumToken),
        });
      }
    }

    if (backgroundColor || fontColor) {
      items.push({ separator: true });
      if (fontColor) {
        items.push({ label: "Remover cor do texto", onClick: () => gridRef.current?.patchCell(row, col, { fontColor: null }) });
      }
      if (backgroundColor) {
        items.push({
          label: "Remover cor de fundo",
          onClick: () => gridRef.current?.patchCell(row, col, { backgroundColor: null }),
        });
      }
    }

    // Right-clicking INSIDE an already-selected multi-cell range (see
    // TemplateGridEditor's own onContextMenu — it only collapses the
    // selection down to this one cell when the click lands outside the
    // current range) keeps that whole range selected, so this reads its
    // real size instead of always seeing a 1x1 selection.
    const rangeSize = gridRef.current?.getSelectionRangeSize();
    const isMerged = gridRef.current?.isSelectionMerged() ?? false;
    if (isMerged || (rangeSize && (rangeSize.rows > 1 || rangeSize.cols > 1))) {
      items.push({ separator: true });
      items.push({
        label: isMerged ? "Desmesclar células" : "Mesclar células",
        onClick: () => gridRef.current?.toggleMergeSelection(),
      });
    }

    setContextMenu({ x, y, items });
  }

  /** Right-click on a row's number gutter — marks/unmarks that exact row's role. */
  function handleRowContextMenu(row: number, x: number, y: number) {
    function insertRowAt(index: number) {
      gridRef.current?.insertRow(index);
      const shift = (value: number | null) => (value !== null && value >= index ? value + 1 : value);
      setDetailRowIndex(shift);
      setSeparatorRowIndex(shift);
      setSubtotalRowIndex(shift);
      setGroupHeaderRowIndex(shift);
      setConsolidatedRowIndex(shift);
    }
    function deleteRowAt(index: number) {
      const grid = gridRef.current?.getGrid();
      if (!grid || grid.rows.length <= 1) return;
      const nextGrid = { ...grid, rows: grid.rows.filter((_, row) => row !== index) };
      const remainingFields = fieldsPresentInGrid(nextGrid);
      gridRef.current?.deleteRow(index);
      setGroupBy((fields) => fields.filter((field) => remainingFields.has(field)));
      setSubtotalGroupBy((fields) => fields.filter((field) => remainingFields.has(field)));
      const shift = (value: number | null) => (value === index ? null : value !== null && value > index ? value - 1 : value);
      if (detailRowIndex === index) setDetailRowIndex(null); else setDetailRowIndex(shift);
      if (separatorRowIndex === index) setSeparatorEnabled(false);
      setSeparatorRowIndex(shift);
      if (subtotalRowIndex === index) setSubtotalEnabled(false);
      setSubtotalRowIndex(shift);
      setGroupHeaderRowIndex(shift);
      setConsolidatedRowIndex(shift);
    }
    const items: ContextMenuItem[] = [
      { label: "Inserir linha acima", onClick: () => insertRowAt(row) },
      { label: "Inserir linha abaixo", onClick: () => insertRowAt(row + 1) },
      { label: "Excluir linha", onClick: () => deleteRowAt(row) },
      { separator: true },
    ];

    if (detailRowIndex === row) {
      items.push({ label: "Desmarcar linha do turno", onClick: () => setDetailRowIndex(null) });
    } else {
      items.push({ label: "Marcar como Linha do Turno", onClick: () => setDetailRowIndex(row) });
    }

    items.push({ separator: true });
    if (separatorEnabled && separatorRowIndex === row) {
      items.push({
        label: "Desmarcar linha separadora",
        onClick: () => {
          setSeparatorEnabled(false);
          setSeparatorRowIndex(null);
        },
      });
      items.push({ render: () => <ColorSwatchRow color={separatorColor} onChange={handleSeparatorColorChange} /> });
    } else {
      items.push({ label: "Marcar como Linha Separadora", onClick: () => markSeparatorRow(row) });
    }

    items.push({ separator: true });
    if (subtotalEnabled && subtotalRowIndex === row) {
      items.push({
        label: "Desmarcar linha de SOMA",
        onClick: () => {
          setSubtotalEnabled(false);
          setSubtotalRowIndex(null);
        },
      });
      items.push({ render: () => <ColorSwatchRow color={subtotalColor} onChange={handleSubtotalColorChange} /> });
    } else {
      items.push({ label: "Marcar como Linha de SOMA", onClick: () => markSubtotalRow(row) });
    }

    items.push({ separator: true });
    items.push({
      label: groupHeaderRowIndex === row ? "Desmarcar cabeçalho do bloco" : "Marcar como Cabeçalho do Bloco",
      onClick: () => setGroupHeaderRowIndex(groupHeaderRowIndex === row ? null : row),
    });
    items.push({
      label: consolidatedRowIndex === row ? "Desmarcar linha consolidada" : "Marcar como Linha Consolidada",
      onClick: () => setConsolidatedRowIndex(consolidatedRowIndex === row ? null : row),
    });

    setContextMenu({ x, y, items });
  }

  /** Right-click on a column's letter header — fixed width (the default, whatever's set by dragging) vs. auto-fit to the longest value actually exported into that column. */
  function handleColumnContextMenu(col: number, x: number, y: number) {
    const autoFit = gridRef.current?.getColumnAutoFit(col) ?? false;
    function deleteColumnAt(index: number) {
      const editor = gridRef.current;
      const grid = editor?.getGrid();
      if (!editor || !grid || grid.columnWidths.length <= 1) return;
      const nextGrid = { ...grid, rows: grid.rows.map((row) => row.filter((_, column) => column !== index)) };
      const remainingFields = fieldsPresentInGrid(nextGrid);
      editor.deleteColumn(index);
      setGroupBy((fields) => fields.filter((field) => remainingFields.has(field)));
      setSubtotalGroupBy((fields) => fields.filter((field) => remainingFields.has(field)));
    }
    setContextMenu({
      x,
      y,
      items: [
        { label: "Inserir coluna à esquerda", onClick: () => gridRef.current?.insertColumn(col) },
        { label: "Inserir coluna à direita", onClick: () => gridRef.current?.insertColumn(col + 1) },
        { label: "Excluir coluna", onClick: () => deleteColumnAt(col) },
        { separator: true },
        { label: autoFit ? "✓ Ajustar ao maior registro" : "Ajustar ao maior registro", onClick: () => gridRef.current?.setColumnAutoFit(col, true) },
        { label: !autoFit ? "✓ Usar tamanho fixo" : "Usar tamanho fixo", onClick: () => gridRef.current?.setColumnAutoFit(col, false) },
      ],
    });
  }

  /**
   * The grid's "Agrupar" hidden-actions button — there are two independent
   * groupings a field can join (see `PaymentExportTemplateConfig.subtotalGroupBy`'s
   * own doc comment), so this opens a small menu to pick which one instead
   * of guessing. Same two toggle actions the big cell context menu already
   * offers inline (`handleCellContextMenu`'s own "Agrupar por"/"Agrupar
   * SOMA por" items) — kept as their own smaller menu here so the single
   * most-reached-for action isn't buried among a dozen other cell actions.
   * `field` is only ever a real bindable field in practice (the grid only
   * checked the `{{ }}` shape, not this whitelist — see
   * `TemplateGridEditorHandle.onGroupingMenu`'s own doc comment); the
   * `isBindableField` check here is just defensive.
   */
  function handleGroupingMenu(_row: number, _col: number, value: string, x: number, y: number) {
    const field = value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
    if (!field || !isBindableField(field)) return;
    const fieldLabel = PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[field];
    const alreadyGrouped = groupBy.includes(field);
    const items: ContextMenuItem[] = [
      {
        label: alreadyGrouped ? `Não separar mais por "${fieldLabel}"` : `Separar blocos por "${fieldLabel}"`,
        onClick: () => setGroupBy((prev) => (alreadyGrouped ? prev.filter((f) => f !== field) : [...prev, field])),
      },
    ];
    if (subtotalEnabled) {
      const alreadySubtotalGrouped = subtotalGroupBy.includes(field);
      items.push({
        label: alreadySubtotalGrouped ? `Não calcular mais subtotal por "${fieldLabel}"` : `Calcular subtotal por "${fieldLabel}"`,
        onClick: () =>
          setSubtotalGroupBy((prev) => (alreadySubtotalGrouped ? prev.filter((f) => f !== field) : [...prev, field])),
      });
    }
    setContextMenu({ x, y, items });
  }

  function handleGroupOptionsMenu(x: number, y: number) {
    setContextMenu({
      x,
      y,
      items: [
        {
          label: "Agrupamento recolhível no Excel",
          selected: outlineEnabled,
          onClick: () => {
            setOutlineEnabled((enabled) => {
              if (enabled) setOutlineCollapsed(false);
              return !enabled;
            });
          },
        },
        {
          label: "Iniciar grupos recolhidos",
          selected: outlineCollapsed,
          disabled: !outlineEnabled,
          onClick: () => setOutlineCollapsed((collapsed) => !collapsed),
        },
      ],
    });
  }

  function applyExample() {
    if (!exampleTarget) return;
    const config = exampleTarget.config;
    setInitialGrid(structuredClone(config.grid));
    setGridRevision((revision) => revision + 1);
    setDetailRowIndex(config.detailRowIndex);
    setGroupBy([...config.groupBy]);
    setSubtotalGroupBy([...(config.subtotalGroupBy ?? config.groupBy)]);
    setSeparatorEnabled(config.separator?.enabled ?? false);
    setSeparatorRowIndex(config.separator?.rowIndex ?? null);
    setSubtotalEnabled(config.subtotal?.enabled ?? false);
    setSubtotalRowIndex(config.subtotal?.rowIndex ?? null);
    setGroupHeaderRowIndex(config.groupHeader?.rowIndex ?? null);
    setConsolidatedRowIndex(config.consolidated?.rowIndex ?? null);
    setOutlineEnabled(config.outline?.enabled ?? false);
    setOutlineCollapsed(config.outline?.collapsed ?? false);
    setError(null);
    setExampleTarget(null);
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) {
      setError("Dê um nome ao template.");
      return;
    }
    if (detailRowIndex === null) {
      setError("Marque qual linha é a linha do turno (a que se repete por turno).");
      return;
    }
    if (separatorEnabled && separatorRowIndex === null) {
      setError("Marque qual linha é a linha separadora, ou desative o separador.");
      return;
    }
    if (subtotalEnabled && subtotalRowIndex === null) {
      setError("Marque qual linha é a linha de SOMA, ou desative a linha de SOMA.");
      return;
    }
    const assignedRows = [
      ["turno", detailRowIndex],
      ["separadora", separatorEnabled ? separatorRowIndex : null],
      ["SOMA", subtotalEnabled ? subtotalRowIndex : null],
      ["cabeçalho do bloco", groupHeaderRowIndex],
      ["consolidada", consolidatedRowIndex],
    ] as const;
    const duplicateRole = assignedRows.find(([, row], index) => row !== null && assignedRows.some(([, other], otherIndex) => otherIndex !== index && other === row));
    if (duplicateRole) {
      setError(`A linha ${duplicateRole[0]} não pode ter outro papel ao mesmo tempo.`);
      return;
    }
    // Marking the same physical row for two roles is never intentional —
    // it silently breaks the export (whichever role isn't the detail row
    // "wins" the export logic, but the row's actual content, e.g. the
    // {{tokens}} typed into what was meant to be the detail row, never
    // gets treated as such).
    if (separatorEnabled && separatorRowIndex === detailRowIndex) {
      setError("A linha separadora não pode ser a mesma linha marcada como linha do turno.");
      return;
    }
    if (subtotalEnabled && subtotalRowIndex === detailRowIndex) {
      setError("A linha de SOMA não pode ser a mesma linha marcada como linha do turno.");
      return;
    }
    if (separatorEnabled && subtotalEnabled && separatorRowIndex === subtotalRowIndex) {
      setError("A linha separadora e a linha de SOMA não podem ser a mesma linha.");
      return;
    }

    const grid = gridRef.current?.getGrid() ?? { rows: [], columnWidths: [], columnAutoFit: [], rowHeights: [], merges: [] };
    // A field selected through "Separar por" lives in config as well as in
    // its cell. Structural edits can remove the last such cell, so sanitize
    // again at the persistence boundary (also repairs older orphaned configs).
    const presentFields = fieldsPresentInGrid(grid);
    const validGroupBy = groupBy.filter((field) => presentFields.has(field));
    const validSubtotalGroupBy = subtotalGroupBy.filter((field) => presentFields.has(field));
    const config: PaymentExportTemplateConfig = {
      grid,
      detailRowIndex,
      groupBy: validGroupBy,
      groupHeader: groupHeaderRowIndex !== null ? { enabled: true, rowIndex: groupHeaderRowIndex } : null,
      outline: { enabled: outlineEnabled, collapsed: outlineCollapsed },
      consolidated: consolidatedRowIndex !== null ? { enabled: true, rowIndex: consolidatedRowIndex } : null,
      subtotalGroupBy: validSubtotalGroupBy,
      separator: separatorEnabled && separatorRowIndex !== null ? { enabled: true, rowIndex: separatorRowIndex } : null,
      subtotal: subtotalEnabled && subtotalRowIndex !== null ? { enabled: true, rowIndex: subtotalRowIndex } : null,
    };

    setBusy(true);
    try {
      if (isEditing) {
        await updatePaymentExportTemplate(Number(id), { name: name.trim(), config });
      } else {
        await createPaymentExportTemplate({ name: name.trim(), config });
      }
      // A plain push here would leave this editor page as a dangling
      // history entry between the list and itself, so the list's own
      // "Voltar" (a bare `navigate(-1)`, see `BackButton`) would land right
      // back on this editor instead of wherever the list itself was reached
      // from. Going back one entry instead (same fallback rule
      // `BackButton` uses) lands on the list's own original entry, keeping
      // history exactly as deep as it was before this editor was opened —
      // `replace` alone would still leave one extra hop behind.
      if ((window.history.state?.idx ?? 0) > 0) {
        navigate(-1);
      } else {
        navigate("/payments/export-templates", { replace: true });
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const rowBadges = useMemo(() => {
    const map = new Map<number, RowBadge>();
    if (separatorEnabled && separatorRowIndex !== null) map.set(separatorRowIndex, { label: "S", color: separatorColor });
    if (subtotalEnabled && subtotalRowIndex !== null) map.set(subtotalRowIndex, { label: "Σ", color: subtotalColor });
    if (groupHeaderRowIndex !== null) map.set(groupHeaderRowIndex, { label: "G", color: "#a78bfa" });
    if (consolidatedRowIndex !== null) map.set(consolidatedRowIndex, { label: "C", color: "#f97316" });
    // Detail row badge is set last so it always wins if two roles were
    // (invalidly) left pointing at the same row while mid-edit — the
    // detail row is the one thing every template must have.
    if (detailRowIndex !== null) map.set(detailRowIndex, { label: "T", color: DETAIL_BADGE_COLOR });
    return map;
  }, [detailRowIndex, separatorEnabled, separatorRowIndex, separatorColor, subtotalEnabled, subtotalRowIndex, subtotalColor, groupHeaderRowIndex, consolidatedRowIndex]);

  // Which exact cell values currently drive agrupamento — shown as a small
  // marker directly on the grid cell instead of a side-panel list (see
  // TemplateGridEditor's own `highlightExactValues`).
  const groupByHighlights = useMemo(() => new Set(groupBy.map((f) => `{{${f}}}`)), [groupBy]);
  const subtotalGroupByHighlights = useMemo(
    () => new Set(subtotalGroupBy.map((f) => `{{${f}}}`)),
    [subtotalGroupBy],
  );

  if (loading) {
    return (
      <div>
        <BackButton fallback="/payments/export-templates" />
        <p className="muted">Carregando...</p>
      </div>
    );
  }

  return (
    <div>
      <BackButton fallback="/payments/export-templates" />
      <div className="page-header">
        <h2>{isEditing ? "Editar template de exportação" : "Novo template de exportação"}</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="button" className="secondary" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={15} /> Como criar meu template
          </button>
          <button type="button" onClick={handleSave} disabled={busy}>
            {busy ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
      <p className="page-subtitle">
        Monte a planilha — texto, cor de fundo, negrito — e use o botão direito do mouse: numa
        célula, pra inserir um campo; no número da linha, pra marcar seu papel (turno,
        separador, SOMA).
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="field" style={{ maxWidth: 420, marginBottom: "1rem" }}>
        <label>Nome do template</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: Padaria e açougue santo amaro"
        />
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <TemplateGridEditor
          key={gridRevision}
          ref={gridRef}
          initialGrid={initialGrid}
          rowBadges={rowBadges}
          highlightExactValues={groupByHighlights}
          secondaryHighlightExactValues={subtotalGroupByHighlights}
          onCellContextMenu={handleCellContextMenu}
          onRowContextMenu={handleRowContextMenu}
          onColumnContextMenu={handleColumnContextMenu}
          onGroupingMenu={handleGroupingMenu}
          onGroupOptionsMenu={handleGroupOptionsMenu}
        />
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
      <PaymentExportTemplateHelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onApplyExample={(example) => {
          setHelpOpen(false);
          setExampleTarget(example);
        }}
      />
      {exampleTarget && (
        <ConfirmModal
          title="Substituir o layout atual?"
          message={`Usar o exemplo “${exampleTarget.title}” apagará todas as células, formatações, papéis de linha e configurações de agrupamento que estão atualmente no editor. Essa ação só será gravada definitivamente quando você salvar o template.`}
          confirmLabel="Substituir pelo exemplo"
          cancelLabel="Manter meu layout"
          danger
          onConfirm={applyExample}
          onCancel={() => setExampleTarget(null)}
        />
      )}
    </div>
  );
}
