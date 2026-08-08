import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import TemplateGridEditor, { type RowBadge, type TemplateGridEditorHandle } from "../components/TemplateGridEditor";
import { createPaymentExportTemplate, getPaymentExportTemplate, updatePaymentExportTemplate } from "../lib/db";
import { columnLetter } from "../lib/format";
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

/** A labeled color swatch — the custom row a right-click row-menu shows once that row already holds the separator/SOMA role, so its color can be changed without leaving the menu. */
function ColorSwatchRow({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
      Cor
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
  const [groupByFieldToAdd, setGroupByFieldToAdd] = useState<string>("");

  const [separatorEnabled, setSeparatorEnabled] = useState(false);
  const [separatorRowIndex, setSeparatorRowIndex] = useState<number | null>(null);
  const [separatorColor, setSeparatorColor] = useState("#22c55e");

  const [subtotalEnabled, setSubtotalEnabled] = useState(false);
  const [subtotalRowIndex, setSubtotalRowIndex] = useState<number | null>(null);
  const [subtotalLabelText, setSubtotalLabelText] = useState("SOMA");
  const [subtotalLabelColumn, setSubtotalLabelColumn] = useState<number | null>(null);
  const [subtotalSumColumn, setSubtotalSumColumn] = useState<number | null>(null);
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
        setSubtotalLabelText(t.config.subtotal?.labelText ?? "SOMA");
        setSubtotalLabelColumn(t.config.subtotal?.labelCellColumn ?? null);
        setSubtotalSumColumn(t.config.subtotal?.sumCellColumn ?? null);
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

  function markSeparatorRow(row: number) {
    setSeparatorEnabled(true);
    setSeparatorRowIndex(row);
    const existing = gridRef.current?.getRowBackgroundColor(row);
    const color = existing ?? separatorColor;
    setSeparatorColor(color);
    gridRef.current?.setRowBackgroundColor(row, color);
  }

  function handleSeparatorColorChange(color: string) {
    setSeparatorColor(color);
    if (separatorRowIndex !== null) gridRef.current?.setRowBackgroundColor(separatorRowIndex, color);
  }

  function markSubtotalRow(row: number) {
    setSubtotalEnabled(true);
    setSubtotalRowIndex(row);
    const existing = gridRef.current?.getRowBackgroundColor(row);
    const color = existing ?? subtotalColor;
    setSubtotalColor(color);
    gridRef.current?.setRowBackgroundColor(row, color);
  }

  function handleSubtotalColorChange(color: string) {
    setSubtotalColor(color);
    if (subtotalRowIndex !== null) gridRef.current?.setRowBackgroundColor(subtotalRowIndex, color);
  }

  /** Right-click on a data cell — every action here targets exactly this cell, never a separately-tracked "selection" (see `TemplateGridEditor`'s own doc comment for why that matters). */
  function handleCellContextMenu(row: number, col: number, value: string, x: number, y: number) {
    const items: ContextMenuItem[] = [
      {
        label: "Inserir campo",
        submenu: ALL_FIELDS.map((f) => ({
          label: PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f],
          onClick: () => gridRef.current?.setCellValue(row, col, `{{${f}}}`),
        })),
      },
      { label: "Negrito", onClick: () => gridRef.current?.toggleCellBold(row, col) },
      { label: "Itálico", onClick: () => gridRef.current?.toggleCellItalic(row, col) },
    ];

    const exactField = value.trim().match(/^\{\{(\w+)\}\}$/)?.[1];
    if (exactField && isBindableField(exactField) && !groupBy.includes(exactField)) {
      items.push({ separator: true });
      items.push({
        label: `Agrupar por "${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[exactField]}"`,
        onClick: () => setGroupBy((prev) => [...prev, exactField]),
      });
    }

    if (subtotalEnabled && subtotalRowIndex === row) {
      items.push({ separator: true });
      items.push({ label: "Usar esta coluna como rótulo da SOMA", onClick: () => setSubtotalLabelColumn(col) });
      items.push({ label: "Usar esta coluna como coluna da soma", onClick: () => setSubtotalSumColumn(col) });
    }

    setContextMenu({ x, y, items });
  }

  /** Right-click on a row's number gutter — marks/unmarks that exact row's role. */
  function handleRowContextMenu(row: number, x: number, y: number) {
    const items: ContextMenuItem[] = [];

    if (detailRowIndex === row) {
      items.push({ label: "Desmarcar linha de detalhe", onClick: () => setDetailRowIndex(null) });
    } else {
      items.push({ label: "Marcar como Linha de Detalhe", onClick: () => setDetailRowIndex(row) });
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

  function removeGroupByField(field: PaymentExportBindableField) {
    setGroupBy((prev) => prev.filter((f) => f !== field));
  }

  function addGroupByField() {
    if (!groupByFieldToAdd) return;
    const field = groupByFieldToAdd as PaymentExportBindableField;
    setGroupBy((prev) => (prev.includes(field) ? prev : [...prev, field]));
    setGroupByFieldToAdd("");
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) {
      setError("Dê um nome ao template.");
      return;
    }
    if (detailRowIndex === null) {
      setError("Marque qual linha é a linha de detalhe (a que se repete por turno).");
      return;
    }
    if (separatorEnabled && separatorRowIndex === null) {
      setError("Marque qual linha é a linha separadora, ou desative o separador.");
      return;
    }
    if (subtotalEnabled && (subtotalRowIndex === null || subtotalLabelColumn === null || subtotalSumColumn === null)) {
      setError("Marque a linha da SOMA e as colunas de rótulo/soma, ou desative a linha de SOMA.");
      return;
    }
    // Marking the same physical row for two roles is never intentional —
    // it silently breaks the export (whichever role isn't the detail row
    // "wins" the export logic, but the row's actual content, e.g. the
    // {{tokens}} typed into what was meant to be the detail row, never
    // gets treated as such).
    if (separatorEnabled && separatorRowIndex === detailRowIndex) {
      setError("A linha separadora não pode ser a mesma linha marcada como linha de detalhe.");
      return;
    }
    if (subtotalEnabled && subtotalRowIndex === detailRowIndex) {
      setError("A linha de SOMA não pode ser a mesma linha marcada como linha de detalhe.");
      return;
    }
    if (separatorEnabled && subtotalEnabled && separatorRowIndex === subtotalRowIndex) {
      setError("A linha separadora e a linha de SOMA não podem ser a mesma linha.");
      return;
    }

    const grid = gridRef.current?.getGrid() ?? { rows: [], columnWidths: [], rowHeights: [], merges: [] };
    const config: PaymentExportTemplateConfig = {
      grid,
      detailRowIndex,
      groupBy,
      separator: separatorEnabled && separatorRowIndex !== null ? { enabled: true, rowIndex: separatorRowIndex } : null,
      subtotal:
        subtotalEnabled && subtotalRowIndex !== null && subtotalLabelColumn !== null && subtotalSumColumn !== null
          ? {
              enabled: true,
              rowIndex: subtotalRowIndex,
              labelCellColumn: subtotalLabelColumn,
              labelText: subtotalLabelText.trim() || "SOMA",
              sumField: "valor",
              sumCellColumn: subtotalSumColumn,
            }
          : null,
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
    if (detailRowIndex !== null) map.set(detailRowIndex, { label: "D", color: DETAIL_BADGE_COLOR });
    return map;
  }, [detailRowIndex, separatorEnabled, separatorRowIndex, separatorColor, subtotalEnabled, subtotalRowIndex, subtotalColor]);

  if (loading) {
    return (
      <div>
        <BackButton fallback="/payments/export-templates" />
        <p className="muted">Carregando...</p>
      </div>
    );
  }

  const availableGroupByOptions = ALL_FIELDS.filter((f) => !groupBy.includes(f));

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
        célula, pra inserir um campo; no número da linha, pra marcar seu papel (detalhe,
        separador, SOMA).
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="import-layout">
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <TemplateGridEditor
            ref={gridRef}
            initialGrid={initialGrid}
            rowBadges={rowBadges}
            onCellContextMenu={handleCellContextMenu}
            onRowContextMenu={handleRowContextMenu}
          />
        </div>

        <div className="import-side">
          <div className="card">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Nome do template</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Padaria e açougue santo amaro"
              />
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Agrupamento</h3>
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Um novo grupo (com separador/SOMA) começa sempre que um destes campos mudar, na
              ordem abaixo.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.6rem" }}>
              {groupBy.length === 0 && (
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  Sem agrupamento.
                </span>
              )}
              {groupBy.map((f) => (
                <span
                  key={f}
                  className="badge neutral"
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                >
                  {PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f]}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => removeGroupByField(f)}
                    aria-label={`Remover ${PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f]}`}
                    style={{ padding: 0 }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="field-row" style={{ marginBottom: 0 }}>
              <select value={groupByFieldToAdd} onChange={(e) => setGroupByFieldToAdd(e.target.value)}>
                <option value="">Adicionar campo...</option>
                {availableGroupByOptions.map((f) => (
                  <option key={f} value={f}>
                    {PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f]}
                  </option>
                ))}
              </select>
              <button type="button" className="ghost" onClick={addGroupByField} disabled={!groupByFieldToAdd}>
                Adicionar
              </button>
            </div>
            <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.5rem", marginBottom: 0 }}>
              Ou clique com o botão direito numa célula que já tenha um campo inserido → "Agrupar
              por este campo".
            </p>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Papéis das linhas</h3>
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Marcados com o botão direito do mouse no número da linha.
            </p>
            <p style={{ margin: "0.5rem 0", fontSize: "0.85rem" }}>
              <strong>Linha de detalhe:</strong>{" "}
              {detailRowIndex !== null ? `linha ${detailRowIndex + 1}` : "não marcada"}
            </p>
            <p style={{ margin: "0.5rem 0", fontSize: "0.85rem" }}>
              <strong>Linha separadora:</strong>{" "}
              {separatorEnabled && separatorRowIndex !== null ? `linha ${separatorRowIndex + 1}` : "desativada"}
            </p>
            <p style={{ margin: "0.5rem 0", fontSize: "0.85rem" }}>
              <strong>Linha de SOMA:</strong>{" "}
              {subtotalEnabled && subtotalRowIndex !== null
                ? `linha ${subtotalRowIndex + 1} — rótulo: ${
                    subtotalLabelColumn !== null ? columnLetter(subtotalLabelColumn) : "não marcada"
                  }, soma: ${subtotalSumColumn !== null ? columnLetter(subtotalSumColumn) : "não marcada"}`
                : "desativada"}
            </p>
            {subtotalEnabled && (
              <div className="field" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
                <label>Texto do rótulo da SOMA</label>
                <input type="text" value={subtotalLabelText} onChange={(e) => setSubtotalLabelText(e.target.value)} />
              </div>
            )}
          </div>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
