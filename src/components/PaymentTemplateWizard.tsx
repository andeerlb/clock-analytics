import { CheckSquare, ChevronLeft, ChevronRight, FolderOpen, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  copyPaymentSample,
  deletePaths,
  listSpreadsheetSheets,
  pickPaymentFile,
  previewSpreadsheet,
} from "../lib/api";
import {
  createPaymentTemplate,
  listClientOptions,
  updatePaymentTemplate,
  type ClientOption,
  type PaymentTemplateInput,
} from "../lib/db";
import { columnLetter, fileNameFromPath } from "../lib/format";
import {
  PAYMENT_TARGET_FIELDS,
  PAYMENT_TARGET_FIELD_LABELS,
  type PaymentFileKind,
  type PaymentTargetField,
  type PaymentTemplateRow,
} from "../lib/types";

const STEP_LABELS = ["Arquivo", "Estrutura", "Mapeamento", "Detalhes"];

const DELIMITER_OPTIONS = [
  { value: ",", label: "Vírgula (,)" },
  { value: ";", label: "Ponto e vírgula (;)" },
  { value: "\t", label: "Tabulação" },
  { value: "|", label: "Barra vertical (|)" },
];

const DATE_FORMAT_OPTIONS = ["DD/MM/YYYY", "DD/MM/YY", "YYYY-MM-DD", "MM/DD/YYYY"];

function fileKindFromPath(path: string): PaymentFileKind {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "ods") return "ods";
  if (ext === "xls") return "xls";
  return "xlsx";
}

export default function PaymentTemplateWizard({
  target,
  onClose,
  onSaved,
}: {
  /** `null` keeps the wizard unmounted/closed; `"new"` starts a blank template; a row edits it. */
  target: PaymentTemplateRow | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState(0);
  const [clients, setClients] = useState<ClientOption[]>([]);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<PaymentFileKind | null>(null);
  const [isNewFile, setIsNewFile] = useState(true);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [includedSheets, setIncludedSheets] = useState<Set<string>>(new Set());
  const [delimiter, setDelimiter] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState<Record<number, PaymentTargetField>>({});

  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<number | null>(null);
  const [decimalSeparator, setDecimalSeparator] = useState(",");
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listClientOptions().then(setClients);
  }, []);

  useEffect(() => {
    if (target === null) return;
    setStep(0);
    setError(null);
    setBusy(false);

    if (target === "new") {
      setFilePath(null);
      setFileKind(null);
      setIsNewFile(true);
      setSheets([]);
      setActiveSheet(null);
      setIncludedSheets(new Set());
      setDelimiter(null);
      setRows([]);
      setHeaderRow(1);
      setMapping({});
      setName("");
      setClientId(null);
      setDecimalSeparator(",");
      setDateFormat("DD/MM/YYYY");
      return;
    }

    setFilePath(target.sampleFilePath);
    setFileKind(target.fileKind);
    setIsNewFile(false);
    setName(target.name);
    setClientId(target.clientId);
    setDecimalSeparator(target.decimalSeparator);
    setDateFormat(target.dateFormat);
    loadFileForEdit(target);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [target, onClose]);

  async function loadFileForEdit(t: PaymentTemplateRow) {
    setLoadingPreview(true);
    setError(null);
    try {
      const sheetNames = await listSpreadsheetSheets(t.sampleFilePath);
      setSheets(sheetNames);
      // Only sheets the saved template actually included are pre-checked —
      // anything new in the workbook since it was created starts unchecked,
      // same as a brand new template would.
      setIncludedSheets(new Set(t.sheetNames.filter((s) => sheetNames.includes(s))));
      const sheet = t.sheetNames[0] ?? sheetNames[0] ?? null;
      setActiveSheet(sheet);
      const preview = await previewSpreadsheet(t.sampleFilePath, sheet, t.delimiter, 50);
      setRows(preview.rows);
      setDelimiter(t.delimiter ?? preview.delimiter);
      setHeaderRow(t.headerRow);
      const initialMapping: Record<number, PaymentTargetField> = {};
      for (const m of t.fieldMappings) {
        const index = letterToIndex(m.columnLetter);
        if (index !== null) initialMapping[index] = m.targetField;
      }
      setMapping(initialMapping);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function loadFile(path: string) {
    setLoadingPreview(true);
    setError(null);
    try {
      const sheetNames = await listSpreadsheetSheets(path);
      const firstSheet = sheetNames[0] ?? null;
      setSheets(sheetNames);
      setActiveSheet(firstSheet);
      // Everything starts included — flagging the few sheets that don't
      // belong (a training log, an absence sheet, ...) is less work than
      // hand-picking every payroll sheet in a large workbook.
      setIncludedSheets(new Set(sheetNames));
      const preview = await previewSpreadsheet(path, firstSheet, null, 50);
      setRows(preview.rows);
      setDelimiter(preview.delimiter);
      setHeaderRow(1);
      setMapping({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function refetchPreview(sheet: string | null, delim: string | null) {
    if (!filePath) return;
    setLoadingPreview(true);
    setError(null);
    try {
      const preview = await previewSpreadsheet(filePath, sheet, delim, 50);
      setRows(preview.rows);
      setHeaderRow(1);
      setMapping({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handlePickFile() {
    setError(null);
    const path = await pickPaymentFile();
    if (!path) return;
    setFilePath(path);
    setFileKind(fileKindFromPath(path));
    setIsNewFile(true);
    await loadFile(path);
  }

  function handleSheetClick(sheetName: string) {
    if (sheetName === activeSheet) return;
    setActiveSheet(sheetName);
    refetchPreview(sheetName, delimiter);
  }

  function toggleSheetIncluded(sheetName: string) {
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(sheetName)) next.delete(sheetName);
      else next.add(sheetName);
      return next;
    });
  }

  function handleDelimiterChange(newDelimiter: string) {
    setDelimiter(newDelimiter);
    refetchPreview(activeSheet, newDelimiter);
  }

  function setColumnMapping(colIndex: number, field: PaymentTargetField | "") {
    setMapping((prev) => {
      const next = { ...prev };
      if (!field) {
        delete next[colIndex];
        return next;
      }
      for (const key of Object.keys(next)) {
        const k = Number(key);
        if (k !== colIndex && next[k] === field) delete next[k];
      }
      next[colIndex] = field;
      return next;
    });
  }

  const colCount = useMemo(() => rows.reduce((max, r) => Math.max(max, r.length), 0), [rows]);
  const columns = useMemo(() => Array.from({ length: colCount }, (_, i) => i), [colCount]);
  const headerCells = useMemo(() => rows[headerRow - 1] ?? [], [rows, headerRow]);
  const sampleRows = useMemo(() => rows.slice(headerRow, headerRow + 8), [rows, headerRow]);

  const mappedFields = new Set(Object.values(mapping));
  const hasIdentifier = mappedFields.has("cpf") || mappedFields.has("matricula");
  const hasValor = mappedFields.has("valor");

  const canAdvance =
    step === 0
      ? filePath !== null
      : step === 1
        ? sheets.length === 0 || includedSheets.size > 0
        : step === 2
          ? hasIdentifier && hasValor
          : false;

  async function handleSave() {
    if (!filePath || !fileKind || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const editing = target !== null && target !== "new" ? target : null;
      let sampleFilePath = editing?.sampleFilePath ?? "";
      let sampleFileName = editing?.sampleFileName ?? "";
      const oldSamplePath = editing?.sampleFilePath ?? null;

      if (isNewFile) {
        sampleFilePath = await copyPaymentSample(filePath);
        sampleFileName = fileNameFromPath(filePath);
      }

      const fieldMappings = Object.entries(mapping).map(([indexStr, targetField]) => {
        const index = Number(indexStr);
        return {
          columnLetter: columnLetter(index),
          targetField,
          headerLabel: headerCells[index] ?? null,
        };
      });

      const input: PaymentTemplateInput = {
        name: name.trim(),
        clientId,
        fileKind,
        sheetNames: fileKind === "csv" ? [] : sheets.filter((s) => includedSheets.has(s)),
        headerRow,
        delimiter: fileKind === "csv" ? delimiter : null,
        decimalSeparator,
        dateFormat,
        sampleFilePath,
        sampleFileName,
        fieldMappings,
      };

      if (editing) {
        await updatePaymentTemplate(editing.id, input);
      } else {
        await createPaymentTemplate(input);
      }

      if (isNewFile && oldSamplePath) {
        await deletePaths([oldSamplePath]).catch(() => {});
      }

      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!target) return null;

  const isEditing = target !== "new";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={onClose}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.8rem 1.2rem",
          background: "var(--card-bg)",
          borderBottom: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <strong style={{ fontSize: "0.95rem" }}>
          {isEditing ? "Editar template de pagamento" : "Novo template de pagamento"}
        </strong>
        <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={onClose} aria-label="Fechar">
          <X size={18} />
        </button>
      </div>

      <div className="wizard-steps" onClick={(e) => e.stopPropagation()}>
        {STEP_LABELS.map((label, i) => (
          <span key={label} className={`wizard-step${i === step ? " active" : i < step ? " done" : ""}`}>
            {i + 1}. {label}
          </span>
        ))}
      </div>

      <div
        style={{ flex: 1, overflow: "auto", padding: "1.5rem", background: "var(--bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {error && <div className="error-box" style={{ marginBottom: "1rem" }}>{error}</div>}

        {step === 0 && (
          <div className="card" style={{ maxWidth: "32rem" }}>
            <div className="field">
              <label>Arquivo de exemplo</label>
              {filePath ? (
                <p className="muted" style={{ margin: "0.4rem 0" }}>
                  {isNewFile ? fileNameFromPath(filePath) : target !== "new" ? target.sampleFileName : ""}
                </p>
              ) : (
                <p className="muted" style={{ margin: "0.4rem 0" }}>Nenhum arquivo selecionado.</p>
              )}
              <button type="button" className="secondary" onClick={handlePickFile}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                {filePath ? "Trocar arquivo" : "Selecionar arquivo"}
              </button>
              <p className="field-hint">Formatos aceitos: CSV, XLSX, XLS ou ODS.</p>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            {fileKind === "csv" && (
              <div className="field" style={{ maxWidth: "16rem", marginBottom: "0.9rem" }}>
                <label>Delimitador</label>
                <select value={delimiter ?? ","} onChange={(e) => handleDelimiterChange(e.target.value)}>
                  {DELIMITER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {sheets.length > 1 && (
              <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem" }}>
                Todas as abas começam marcadas para importar — desmarque as que não são de
                pagamento (treinamento, faltas, etc.). Clique no nome da aba para visualizá-la
                aqui embaixo.
              </p>
            )}
            <p className="muted" style={{ marginTop: 0 }}>
              Clique na linha que é o cabeçalho real do arquivo.
            </p>
            {sheets.length > 1 && (
              <div className="sheet-tabs">
                {sheets.map((s) => {
                  const included = includedSheets.has(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`sheet-tab${s === activeSheet ? " active" : ""}${included ? "" : " excluded"}`}
                      onClick={() => handleSheetClick(s)}
                    >
                      <span
                        className="sheet-tab-check"
                        role="checkbox"
                        aria-checked={included}
                        aria-label={included ? `Não importar ${s}` : `Importar ${s}`}
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSheetIncluded(s);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleSheetIncluded(s);
                          }
                        }}
                      >
                        {included ? <CheckSquare size={13} /> : <Square size={13} />}
                      </span>
                      {s}
                    </button>
                  );
                })}
              </div>
            )}
            {loadingPreview && <p className="muted">Carregando...</p>}
            {!loadingPreview && rows.length === 0 && <p className="muted">Nenhuma linha encontrada.</p>}
            {!loadingPreview && rows.length > 0 && (
              <div className={`spreadsheet-grid-scroll${sheets.length > 1 ? " attached-to-tabs" : ""}`}>
                <table className="spreadsheet-grid">
                  <thead>
                    <tr>
                      <th className="corner">#</th>
                      {columns.map((c) => (
                        <th key={c}>{columnLetter(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr
                        key={i}
                        className={i + 1 === headerRow ? "header-row-selected" : ""}
                        onClick={() => setHeaderRow(i + 1)}
                      >
                        <td className="row-gutter">{i + 1}</td>
                        {columns.map((c) => (
                          <td key={c}>{row[c] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <p className="muted" style={{ marginTop: 0 }}>
              Para cada coluna, escolha a qual campo ela corresponde. É preciso mapear pelo menos um
              identificador (CPF ou Matrícula) e o Valor.
            </p>
            {rows.length === 0 && <p className="muted">Nenhuma linha encontrada.</p>}
            {rows.length > 0 && (
              <div className="spreadsheet-grid-scroll">
                <table className="spreadsheet-grid">
                  <thead>
                    <tr>
                      <th className="corner">#</th>
                      {columns.map((c) => {
                        const field = mapping[c];
                        return (
                          <th key={c} className={`mapping-header${field ? " is-mapped" : ""}`}>
                            <span className="header-label">
                              {columnLetter(c)} — {headerCells[c] || "(vazio)"}
                            </span>
                            <select
                              value={field ?? ""}
                              onChange={(e) =>
                                setColumnMapping(c, e.target.value as PaymentTargetField | "")
                              }
                            >
                              <option value="">Ignorar</option>
                              {PAYMENT_TARGET_FIELDS.map((f) => (
                                <option key={f} value={f}>
                                  {PAYMENT_TARGET_FIELD_LABELS[f]}
                                </option>
                              ))}
                            </select>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows.map((row, i) => (
                      <tr key={i}>
                        <td className="row-gutter">{headerRow + i + 1}</td>
                        {columns.map((c) => (
                          <td key={c}>{row[c] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="card" style={{ maxWidth: "32rem" }}>
            <div className="field" style={{ marginBottom: "1rem" }}>
              <label htmlFor="template-name">Nome do template</label>
              <input
                id="template-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex.: Folha mensal — Provedor X"
              />
            </div>
            <div className="field" style={{ marginBottom: "1rem" }}>
              <label htmlFor="template-client">Cliente</label>
              <select
                id="template-client"
                value={clientId ?? ""}
                onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Qualquer cliente (modelo global)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label htmlFor="template-decimal">Separador decimal</label>
                <select
                  id="template-decimal"
                  value={decimalSeparator}
                  onChange={(e) => setDecimalSeparator(e.target.value)}
                >
                  <option value=",">Vírgula (1.234,56)</option>
                  <option value=".">Ponto (1,234.56)</option>
                </select>
              </div>
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label htmlFor="template-date-format">Formato de data</label>
                <select
                  id="template-date-format"
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value)}
                >
                  {DATE_FORMAT_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="field-hint" style={{ marginTop: "1rem" }}>
              {columns.length} coluna(s) na planilha, {Object.keys(mapping).length} mapeada(s).
              {sheets.length > 1 && ` ${includedSheets.size} de ${sheets.length} aba(s) selecionada(s).`}
            </p>
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "0.8rem 1.2rem",
          background: "var(--card-bg)",
          borderTop: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="outline"
          onClick={() => setStep((s) => s - 1)}
          disabled={step === 0 || busy}
        >
          <ChevronLeft size={15} style={{ marginRight: "0.3rem" }} />
          Voltar
        </button>
        {step < STEP_LABELS.length - 1 ? (
          <button type="button" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance || busy}>
            Avançar
            <ChevronRight size={15} style={{ marginLeft: "0.3rem" }} />
          </button>
        ) : (
          <button type="button" onClick={handleSave} disabled={busy || !name.trim()}>
            {busy ? "Salvando..." : "Salvar"}
          </button>
        )}
      </div>
    </div>
  );
}

function letterToIndex(letter: string): number | null {
  if (!letter) return null;
  let n = 0;
  for (const char of letter.toUpperCase()) {
    const code = char.charCodeAt(0) - 65;
    if (code < 0 || code > 25) return null;
    n = n * 26 + (code + 1);
  }
  return n - 1;
}
