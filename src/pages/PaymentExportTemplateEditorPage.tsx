import { Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import SpreadsheetGridEditor, {
  type GridSelection,
  type SpreadsheetGridEditorHandle,
} from "../components/SpreadsheetGridEditor";
import { createPaymentExportTemplate, getPaymentExportTemplate, updatePaymentExportTemplate } from "../lib/db";
import { columnLetter } from "../lib/format";
import {
  PAYMENT_EXPORT_BINDABLE_FIELD_LABELS,
  type PaymentExportBindableField,
  type PaymentExportTemplateConfig,
} from "../lib/types";

const ALL_FIELDS = Object.keys(PAYMENT_EXPORT_BINDABLE_FIELD_LABELS) as PaymentExportBindableField[];

export default function PaymentExportTemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();
  const gridRef = useRef<SpreadsheetGridEditorHandle>(null);

  const [name, setName] = useState("");
  const [initialGrid, setInitialGrid] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The grid's current selection (row/col) — read by every "usar
  // linha/coluna selecionada" button below, so the side panel never needs
  // to know about jspreadsheet-ce directly (see SpreadsheetGridEditor).
  const [selection, setSelection] = useState<GridSelection | null>(null);

  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [groupBy, setGroupBy] = useState<PaymentExportBindableField[]>([]);
  const [groupByFieldToAdd, setGroupByFieldToAdd] = useState<string>("");

  const [separatorEnabled, setSeparatorEnabled] = useState(false);
  const [separatorRowIndex, setSeparatorRowIndex] = useState<number | null>(null);

  const [subtotalEnabled, setSubtotalEnabled] = useState(false);
  const [subtotalRowIndex, setSubtotalRowIndex] = useState<number | null>(null);
  const [subtotalLabelText, setSubtotalLabelText] = useState("SOMA");
  const [subtotalLabelColumn, setSubtotalLabelColumn] = useState<number | null>(null);
  const [subtotalSumColumn, setSubtotalSumColumn] = useState<number | null>(null);

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

  function insertTokenAtSelection(field: PaymentExportBindableField) {
    // Uses the last selection PUSHED via onSelectionChange (same as the
    // row-role "marcar linha selecionada" buttons below), not a fresh
    // `getSelected()` query — jspreadsheet-ce clears its own live selection
    // once focus leaves the grid (e.g. clicking this very button, which
    // lives in the side panel), so re-querying it after the click would
    // always come back empty.
    if (!selection) {
      setError("Selecione uma célula na planilha antes de inserir o campo.");
      return;
    }
    setError(null);
    const cell = `${columnLetter(selection.col)}${selection.row + 1}`;
    gridRef.current?.setCellValue(cell, `{{${field}}}`);
  }

  function addGroupByField() {
    if (!groupByFieldToAdd) return;
    const field = groupByFieldToAdd as PaymentExportBindableField;
    setGroupBy((prev) => (prev.includes(field) ? prev : [...prev, field]));
    setGroupByFieldToAdd("");
  }

  function removeGroupByField(field: PaymentExportBindableField) {
    setGroupBy((prev) => prev.filter((f) => f !== field));
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

    const grid = gridRef.current?.getConfig() ?? {};
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
          <Save size={15} style={{ marginRight: "0.4rem" }} />
          {busy ? "Salvando..." : "Salvar"}
        </button>
      </div>
      <p className="page-subtitle">
        Monte a planilha como no Excel — texto, cor, largura de coluna, mesclagem — e use os
        campos ao lado pra marcar qual linha se repete por turno, o agrupamento, o separador e a
        linha de SOMA.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="import-layout">
        <div className="card" style={{ padding: "0.5rem", overflow: "auto" }}>
          <SpreadsheetGridEditor ref={gridRef} initialGrid={initialGrid} onSelectionChange={setSelection} />
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
            <h3 style={{ marginTop: 0 }}>Campos</h3>
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Selecione uma célula na planilha e clique num campo pra inserir o token nela.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {ALL_FIELDS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="badge neutral chip-filter"
                  onClick={() => insertTokenAtSelection(f)}
                >
                  {PAYMENT_EXPORT_BINDABLE_FIELD_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Linha de detalhe</h3>
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              A linha que se repete uma vez por turno — coloque os campos acima nela.
            </p>
            <p style={{ margin: "0.4rem 0" }}>
              {detailRowIndex !== null ? `Linha ${detailRowIndex + 1}` : "Nenhuma linha marcada"}
            </p>
            <button
              type="button"
              className="ghost"
              onClick={() => selection && setDetailRowIndex(selection.row)}
              disabled={!selection}
            >
              Marcar linha selecionada
            </button>
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
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Linha separadora</h3>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={separatorEnabled}
                onChange={(e) => setSeparatorEnabled(e.target.checked)}
              />
              Ativar separador entre grupos
            </label>
            {separatorEnabled && (
              <>
                <p style={{ margin: "0.4rem 0" }}>
                  {separatorRowIndex !== null ? `Linha ${separatorRowIndex + 1}` : "Nenhuma linha marcada"}
                </p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => selection && setSeparatorRowIndex(selection.row)}
                  disabled={!selection}
                >
                  Marcar linha selecionada
                </button>
              </>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Linha de SOMA</h3>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
              <input type="checkbox" checked={subtotalEnabled} onChange={(e) => setSubtotalEnabled(e.target.checked)} />
              Ativar subtotal por grupo
            </label>
            {subtotalEnabled && (
              <>
                <div className="field" style={{ marginTop: "0.6rem" }}>
                  <label>Texto do rótulo</label>
                  <input type="text" value={subtotalLabelText} onChange={(e) => setSubtotalLabelText(e.target.value)} />
                </div>
                <p style={{ margin: "0.4rem 0", fontSize: "0.85rem" }}>
                  Linha: {subtotalRowIndex !== null ? subtotalRowIndex + 1 : "não marcada"}
                  {" · "}
                  Coluna do rótulo: {subtotalLabelColumn !== null ? columnLetter(subtotalLabelColumn) : "não marcada"}
                  {" · "}
                  Coluna da soma: {subtotalSumColumn !== null ? columnLetter(subtotalSumColumn) : "não marcada"}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => selection && setSubtotalRowIndex(selection.row)}
                    disabled={!selection}
                  >
                    Usar linha selecionada
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => selection && setSubtotalLabelColumn(selection.col)}
                    disabled={!selection}
                  >
                    Usar coluna selecionada (rótulo)
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => selection && setSubtotalSumColumn(selection.col)}
                    disabled={!selection}
                  >
                    Usar coluna selecionada (soma)
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
