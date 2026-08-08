import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import TemplateGridEditor, {
  FONT_FAMILIES,
  FONT_SIZES,
  type RowBadge,
  type TemplateGridEditorHandle,
} from "../components/TemplateGridEditor";
import { createPaymentExportTemplate, getPaymentExportTemplate, updatePaymentExportTemplate } from "../lib/db";
import { isBindableField } from "../lib/paymentExportGrid";
import {
  PAYMENT_EXPORT_BINDABLE_FIELD_LABELS,
  type PaymentExportBindableField,
  type PaymentExportTemplateConfig,
  type TemplateGridData,
} from "../lib/types";

const ALL_FIELDS = Object.keys(PAYMENT_EXPORT_BINDABLE_FIELD_LABELS) as PaymentExportBindableField[];
const DETAIL_BADGE_COLOR = "#60a5fa";

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

  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [groupBy, setGroupBy] = useState<PaymentExportBindableField[]>([]);

  const [separatorEnabled, setSeparatorEnabled] = useState(false);
  const [separatorRowIndex, setSeparatorRowIndex] = useState<number | null>(null);
  const [separatorColor, setSeparatorColor] = useState("#22c55e");

  const [subtotalEnabled, setSubtotalEnabled] = useState(false);
  const [subtotalRowIndex, setSubtotalRowIndex] = useState<number | null>(null);
  const [subtotalColor, setSubtotalColor] = useState("#facc15");

  const [contextMenu, setContextMenu] = useState<OpenContextMenu | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    getPaymentExportTemplate(Number(id))
      .then((t) => {
        setName(t.name);
        setInitialGrid(t.config.grid);
        setDetailRowIndex(t.config.detailRowIndex);
        setGroupBy(t.config.groupBy);
        setSeparatorEnabled(t.config.separator?.enabled ?? false);
        setSeparatorRowIndex(t.config.separator?.rowIndex ?? null);
        setSubtotalEnabled(t.config.subtotal?.enabled ?? false);
        setSubtotalRowIndex(t.config.subtotal?.rowIndex ?? null);
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
    ];

    const exactField = value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
    if (exactField && isBindableField(exactField)) {
      items.push({ separator: true });
      const alreadyGrouped = groupBy.includes(exactField);
      items.push({
        label: alreadyGrouped
          ? `Remover "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}" do agrupamento`
          : `Agrupar por "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}"`,
        onClick: () =>
          setGroupBy((prev) => (alreadyGrouped ? prev.filter((f) => f !== exactField) : [...prev, exactField])),
      });
    }

    // The SOMA row has no separate "which column" config — whichever
    // cell(s) hold the literal {{valorSoma}} token get the computed total
    // at export time (same mechanism as the detail row's {{field}}
    // tokens). Typing it by hand works too; this is just a shortcut.
    if (subtotalEnabled && subtotalRowIndex === row) {
      items.push({ separator: true });
      items.push({ label: "Somar nessa coluna", onClick: () => gridRef.current?.setCellValue(row, col, "{{valorSoma}}") });
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
    const items: ContextMenuItem[] = [];

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

    setContextMenu({ x, y, items });
  }

  /** Right-click on a column's letter header — fixed width (the default, whatever's set by dragging) vs. auto-fit to the longest value actually exported into that column. */
  function handleColumnContextMenu(col: number, x: number, y: number) {
    const autoFit = gridRef.current?.getColumnAutoFit(col) ?? false;
    setContextMenu({
      x,
      y,
      items: [
        { label: autoFit ? "✓ Ajustar ao maior registro" : "Ajustar ao maior registro", onClick: () => gridRef.current?.setColumnAutoFit(col, true) },
        { label: !autoFit ? "✓ Usar tamanho fixo" : "Usar tamanho fixo", onClick: () => gridRef.current?.setColumnAutoFit(col, false) },
      ],
    });
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
    const config: PaymentExportTemplateConfig = {
      grid,
      detailRowIndex,
      groupBy,
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
      navigate("/payments/export-templates");
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
    // Detail row badge is set last so it always wins if two roles were
    // (invalidly) left pointing at the same row while mid-edit — the
    // detail row is the one thing every template must have.
    if (detailRowIndex !== null) map.set(detailRowIndex, { label: "T", color: DETAIL_BADGE_COLOR });
    return map;
  }, [detailRowIndex, separatorEnabled, separatorRowIndex, separatorColor, subtotalEnabled, subtotalRowIndex, subtotalColor]);

  // Which exact cell values currently drive agrupamento — shown as a small
  // marker directly on the grid cell instead of a side-panel list (see
  // TemplateGridEditor's own `highlightExactValues`).
  const groupByHighlights = useMemo(() => new Set(groupBy.map((f) => `{{${f}}}`)), [groupBy]);

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
        <button type="button" onClick={handleSave} disabled={busy}>
          {busy ? "Salvando..." : "Salvar"}
        </button>
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
          ref={gridRef}
          initialGrid={initialGrid}
          rowBadges={rowBadges}
          highlightExactValues={groupByHighlights}
          onCellContextMenu={handleCellContextMenu}
          onRowContextMenu={handleRowContextMenu}
          onColumnContextMenu={handleColumnContextMenu}
        />
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
