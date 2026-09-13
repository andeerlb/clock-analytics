import { CircleHelp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import PaymentPdfTemplateHelpDrawer from "../components/PaymentPdfTemplateHelpDrawer";
import PaymentPdfPreviewDrawer from "../components/PaymentPdfPreviewDrawer";
import TemplateGridEditor, {
  FONT_FAMILIES,
  FONT_SIZES,
  type RowBadge,
  type TemplateGridEditorHandle,
} from "../components/TemplateGridEditor";
import { createPaymentPdfTemplate, getPaymentPdfTemplate, updatePaymentPdfTemplate } from "../lib/db";
import { isBindableField } from "../lib/paymentExportGrid";
import { buildPaymentPdfPreviewBytes } from "../lib/paymentPdfPreview";
import type { PaymentPdfTemplateExample } from "../lib/paymentPdfTemplateExamples";
import {
  PAYMENT_EXPORT_BINDABLE_FIELD_LABELS,
  type PaymentExportBindableField,
  type PaymentPdfTemplateConfig,
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

/** A labeled color swatch — same recipe as the Excel editor's, for the row-menu's separator/SOMA color pickers. */
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

export default function PaymentPdfTemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();
  const gridRef = useRef<TemplateGridEditorHandle>(null);

  const [name, setName] = useState("");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  const [initialGrid, setInitialGrid] = useState<TemplateGridData | null>(null);
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exampleTarget, setExampleTarget] = useState<PaymentPdfTemplateExample | null>(null);
  /** Preview bytes — a fresh array identity re-renders the preview drawer. */
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [previewGrid, setPreviewGrid] = useState<TemplateGridData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** Bumped by `applyExample` — remounts the grid editor with the example's `initialGrid`. */
  const [gridRevision, setGridRevision] = useState(0);

  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [groupBy, setGroupBy] = useState<PaymentExportBindableField[]>([]);

  const [separatorEnabled, setSeparatorEnabled] = useState(false);
  const [separatorRowIndex, setSeparatorRowIndex] = useState<number | null>(null);
  const [separatorColor, setSeparatorColor] = useState("#22c55e");

  const [subtotalEnabled, setSubtotalEnabled] = useState(false);
  const [subtotalRowIndex, setSubtotalRowIndex] = useState<number | null>(null);
  const [subtotalColor, setSubtotalColor] = useState("#facc15");
  const [groupHeaderRowIndex, setGroupHeaderRowIndex] = useState<number | null>(null);

  const [contextMenu, setContextMenu] = useState<OpenContextMenu | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    getPaymentPdfTemplate(Number(id))
      .then((t) => {
        setName(t.name);
        setInitialGrid(t.config.grid);
        setOrientation(t.config.orientation ?? "landscape");
        setDetailRowIndex(t.config.detailRowIndex);
        setGroupBy(t.config.groupBy);
        setSeparatorEnabled(t.config.separator?.enabled ?? false);
        setSeparatorRowIndex(t.config.separator?.rowIndex ?? null);
        setSubtotalEnabled(t.config.subtotal?.enabled ?? false);
        setSubtotalRowIndex(t.config.subtotal?.rowIndex ?? null);
        setGroupHeaderRowIndex(t.config.groupHeader?.rowIndex ?? null);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, isEditing]);

  // Same as the Excel editor: once the grid mounts right after loading, pull
  // whatever color is already painted on the separator/SOMA rows so the
  // pickers reflect the sheet instead of resetting to the default swatch.
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

  /** Right-click on a data cell — same structure as the Excel editor's, minus the Excel-only SOMA-grouping half of agrupamento. */
  function handleCellContextMenu(
    row: number,
    col: number,
    value: string,
    backgroundColor: string | null,
    fontColor: string | null,
    x: number,
    y: number,
  ) {
    const anchor = gridRef.current?.getAnchorCell() ?? null;
    const field = value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
    const isGroupField = field !== undefined && isBindableField(field) && groupBy.includes(field);

    const items: ContextMenuItem[] = [
      {
        label: "Inserir campo",
        submenu: ALL_FIELDS.map((f) => ({
          label: PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f],
          onClick: () => {
            gridRef.current?.setCellValue(row, col, `{{${f}}}`);
            // The very first field ever inserted, with no linha do turno
            // marked yet, almost certainly means "this is the row that
            // repeats" — same convenience as the Excel editor.
            if (detailRowIndex === null) setDetailRowIndex(row);
          },
        })),
      },
      {
        label: "Separar por (agrupamento)",
        submenu: [
          {
            label: isGroupField ? `Remover "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[field as PaymentExportBindableField]}" do agrupamento` : `Agrupar por "${field !== undefined && isBindableField(field) ? PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[field as PaymentExportBindableField] : "este campo"}"`,
            onClick: () => {
              if (field === undefined || !isBindableField(field)) return;
              setGroupBy((fields) => (fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field]));
            },
          },
          ...(groupBy.length > 0
            ? [{ label: "Limpar agrupamento", onClick: () => setGroupBy([]) }]
            : []),
        ],
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
    ];

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

  /** The "Agrupar" hidden-actions button — here a single grouping (the turnos one), so one toggle item is the whole menu. */
  function handleGroupingMenu(_row: number, _col: number, value: string, x: number, y: number) {
    const field = value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
    if (field === undefined || !isBindableField(field)) return;
    const enabled = groupBy.includes(field);
    setContextMenu({
      x,
      y,
      items: [
        {
          label: enabled ? "Remover do agrupamento de turnos" : "Separar turnos por este campo",
          onClick: () => setGroupBy((fields) => (enabled ? fields.filter((f) => f !== field) : [...fields, field])),
        },
      ],
    });
  }

  /** Right-click on a row's number gutter — structural edits plus the four row roles a PDF template has. */
  function handleRowContextMenu(row: number, x: number, y: number) {
    function insertRowAt(index: number) {
      gridRef.current?.insertRow(index);
      const shift = (value: number | null) => (value !== null && value >= index ? value + 1 : value);
      setDetailRowIndex(shift);
      setSeparatorRowIndex(shift);
      setSubtotalRowIndex(shift);
      setGroupHeaderRowIndex(shift);
    }
    function deleteRowAt(index: number) {
      const grid = gridRef.current?.getGrid();
      if (!grid || grid.rows.length <= 1) return;
      const nextGrid = { ...grid, rows: grid.rows.filter((_, r) => r !== index) };
      const remainingFields = fieldsPresentInGrid(nextGrid);
      gridRef.current?.deleteRow(index);
      setGroupBy((fields) => fields.filter((field) => remainingFields.has(field)));
      const shift = (value: number | null) => (value === index ? null : value !== null && value > index ? value - 1 : value);
      if (detailRowIndex === index) setDetailRowIndex(null); else setDetailRowIndex(shift);
      if (separatorRowIndex === index) setSeparatorEnabled(false);
      setSeparatorRowIndex(shift);
      if (subtotalRowIndex === index) setSubtotalEnabled(false);
      setSubtotalRowIndex(shift);
      setGroupHeaderRowIndex(shift);
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
      items.push({ label: "Desmarcar como separadora", onClick: () => setSeparatorEnabled(false) });
      items.push({ render: () => <ColorSwatchRow color={separatorColor} onChange={setSeparatorColor} /> });
    } else {
      items.push({
        label: "Marcar como Linha Separadora",
        onClick: () => {
          setSeparatorEnabled(true);
          setSeparatorRowIndex(row);
        },
      });
    }

    if (subtotalEnabled && subtotalRowIndex === row) {
      items.push({ label: "Desmarcar como SOMA", onClick: () => setSubtotalEnabled(false) });
      items.push({ render: () => <ColorSwatchRow color={subtotalColor} onChange={setSubtotalColor} /> });
    } else {
      items.push({
        label: "Marcar como Linha de SOMA",
        onClick: () => {
          setSubtotalEnabled(true);
          setSubtotalRowIndex(row);
        },
      });
    }

    if (groupHeaderRowIndex === row) {
      items.push({ label: "Desmarcar como cabeçalho de grupo", onClick: () => setGroupHeaderRowIndex(null) });
    } else {
      items.push({ label: "Marcar como Cabeçalho de Grupo", onClick: () => setGroupHeaderRowIndex(row) });
    }

    setContextMenu({ x, y, items });
  }

  useEffect(() => {
    if (!previewGrid || detailRowIndex === null) {
      setPreviewBytes(null);
      setPreviewError(null);
      return;
    }
    try {
      const presentFields = fieldsPresentInGrid(previewGrid);
      const config: PaymentPdfTemplateConfig = {
        grid: previewGrid,
        detailRowIndex,
        groupBy: groupBy.filter((field) => presentFields.has(field)),
        groupHeader: groupHeaderRowIndex !== null ? { enabled: true, rowIndex: groupHeaderRowIndex } : null,
        separator: separatorEnabled && separatorRowIndex !== null ? { enabled: true, rowIndex: separatorRowIndex } : null,
        subtotal: subtotalEnabled && subtotalRowIndex !== null ? { enabled: true, rowIndex: subtotalRowIndex } : null,
        orientation,
      };
      setPreviewBytes(buildPaymentPdfPreviewBytes(config));
      setPreviewError(null);
    } catch (e) {
      setPreviewBytes(null);
      setPreviewError(String(e instanceof Error ? e.message : e));
    }
  }, [previewGrid, detailRowIndex, groupBy, groupHeaderRowIndex, separatorEnabled, separatorRowIndex, subtotalEnabled, subtotalRowIndex, orientation]);

  /** Applies a help-drawer example: replaces the whole grid and every role/grouping state — nothing is persisted until "Salvar". */
  function applyExample() {
    if (!exampleTarget) return;
    const config = exampleTarget.config;
    setInitialGrid(structuredClone(config.grid));
    setGridRevision((revision) => revision + 1);
    setDetailRowIndex(config.detailRowIndex);
    setGroupBy([...config.groupBy]);
    setSeparatorEnabled(config.separator?.enabled ?? false);
    setSeparatorRowIndex(config.separator?.rowIndex ?? null);
    setSubtotalEnabled(config.subtotal?.enabled ?? false);
    setSubtotalRowIndex(config.subtotal?.rowIndex ?? null);
    setGroupHeaderRowIndex(config.groupHeader?.rowIndex ?? null);
    setOrientation(config.orientation ?? "landscape");
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
      setError("Marque qual linha representa um turno — clique com o botão direito no número da linha e escolha \"Marcar como Linha do Turno\".");
      return;
    }
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
    // A field selected through "Separar por" lives in config as well as in its
    // cell. Structural edits can remove the last such cell, so sanitize again
    // at the persistence boundary (same repair the Excel editor does).
    const presentFields = fieldsPresentInGrid(grid);
    const validGroupBy = groupBy.filter((field) => presentFields.has(field));
    const config: PaymentPdfTemplateConfig = {
      grid,
      detailRowIndex,
      groupBy: validGroupBy,
      groupHeader: groupHeaderRowIndex !== null ? { enabled: true, rowIndex: groupHeaderRowIndex } : null,
      separator: separatorEnabled && separatorRowIndex !== null ? { enabled: true, rowIndex: separatorRowIndex } : null,
      subtotal: subtotalEnabled && subtotalRowIndex !== null ? { enabled: true, rowIndex: subtotalRowIndex } : null,
      orientation,
    };

    setBusy(true);
    try {
      if (isEditing) {
        await updatePaymentPdfTemplate(Number(id), { name: name.trim(), config });
      } else {
        await createPaymentPdfTemplate({ name: name.trim(), config });
      }
      // Same history hygiene as the Excel editor — see that page's own comment.
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
    // Detail row badge is set last so it always wins if two roles were
    // (invalidly) left pointing at the same row while mid-edit.
    if (detailRowIndex !== null) map.set(detailRowIndex, { label: "T", color: DETAIL_BADGE_COLOR });
    return map;
  }, [detailRowIndex, separatorEnabled, separatorRowIndex, separatorColor, subtotalEnabled, subtotalRowIndex, subtotalColor, groupHeaderRowIndex]);

  // Which exact cell values currently drive agrupamento — shown as a small
  // marker directly on the grid cell (same visual as the Excel editor's).
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
        <h2>{isEditing ? "Editar template de PDF" : "Novo template de PDF"}</h2>
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
        Monte a página — texto, cor de fundo, negrito — e use o botão direito do mouse: numa célula,
        pra inserir um campo; no número da linha, pra marcar seu papel (turno, cabeçalho de grupo,
        separador, SOMA). Tudo acima da linha do turno vira o cabeçalho fixo, repetido no topo de
        cada página do PDF.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="field-row" style={{ alignItems: "end", marginBottom: "1rem", gap: "1rem" }}>
        <div className="field" style={{ maxWidth: 420, marginBottom: 0 }}>
          <label>Nome do template</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Recibo de pagamentos — Santo Amaro"
          />
        </div>
        <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
          <label>Orientação da página</label>
          <select value={orientation} onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")}>
            <option value="landscape">Paisagem</option>
            <option value="portrait">Retrato</option>
          </select>
        </div>
      </div>

      <div className="pdf-template-editor-layout">
        <div className="pdf-template-grid-column">
          <div className="card pdf-template-grid-card" style={{ padding: 0, overflow: "hidden" }}>
            <TemplateGridEditor
              key={gridRevision}
              ref={gridRef}
              initialGrid={initialGrid}
              onGridChange={setPreviewGrid}
              rowBadges={rowBadges}
              highlightExactValues={groupByHighlights}
              onCellContextMenu={handleCellContextMenu}
              onRowContextMenu={handleRowContextMenu}
              onGroupingMenu={handleGroupingMenu}
            />
          </div>
        </div>

        <PaymentPdfPreviewDrawer bytes={previewBytes} />
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
      {previewError && <div className="error-box">{previewError}</div>}
      <PaymentPdfTemplateHelpDrawer
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

