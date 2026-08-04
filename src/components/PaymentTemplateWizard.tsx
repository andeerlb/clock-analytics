import { CheckSquare, ChevronLeft, ChevronRight, FolderOpen, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
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
  type PaymentTemplateGroup,
  type PaymentTemplateRow,
} from "../lib/types";

const STEP_LABELS = ["Arquivo", "Estrutura", "Mapeamento", "Detalhes"];

/** Stand-in group key for csv, which has no sheets to key groups off of — there's always exactly one implicit group. */
const CSV_GROUP_KEY = "__csv__";

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

  // Different sheets in the workbook can have genuinely different layouts,
  // so header row + column mapping are scoped to a GROUP, not the whole
  // template. `sheetGroupOf[sheet]` names which sheet's config it uses —
  // every sheet starts as its own standalone group (mapping to itself);
  // merging two sheets just points one at the other's key. csv has no
  // sheets, so it always resolves to CSV_GROUP_KEY via groupKeyOf below.
  const [sheetGroupOf, setSheetGroupOf] = useState<Record<string, string>>({});
  const [groupHeaderRow, setGroupHeaderRow] = useState<Record<string, number>>({});
  const [groupMapping, setGroupMapping] = useState<Record<string, Record<number, PaymentTargetField>>>({});

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
      setSheetGroupOf({});
      setGroupHeaderRow({});
      setGroupMapping({});
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

  /** Which group a sheet's header row/mapping should be read from — csv always has exactly one, implicit group. */
  function groupKeyOf(sheetName: string | null): string {
    if (fileKind === "csv" || sheetName === null) return CSV_GROUP_KEY;
    return sheetGroupOf[sheetName] ?? sheetName;
  }

  async function loadFileForEdit(t: PaymentTemplateRow) {
    setLoadingPreview(true);
    setError(null);
    try {
      const sheetNames = await listSpreadsheetSheets(t.sampleFilePath);
      setSheets(sheetNames);

      const newSheetGroupOf: Record<string, string> = {};
      const newGroupHeaderRow: Record<string, number> = {};
      const newGroupMapping: Record<string, Record<number, PaymentTargetField>> = {};
      const included = new Set<string>();

      for (const group of t.groups) {
        const repKey = group.sheetNames[0] ?? CSV_GROUP_KEY;
        newGroupHeaderRow[repKey] = group.headerRow;
        const m: Record<number, PaymentTargetField> = {};
        for (const fm of group.fieldMappings) {
          const index = letterToIndex(fm.columnLetter);
          if (index !== null) m[index] = fm.targetField;
        }
        newGroupMapping[repKey] = m;
        // Only sheets the saved template actually included are pre-checked
        // — anything new in the workbook since it was created starts
        // unchecked, same as a brand new template would.
        for (const s of group.sheetNames) {
          if (sheetNames.includes(s)) {
            newSheetGroupOf[s] = repKey;
            included.add(s);
          }
        }
      }

      setSheetGroupOf(newSheetGroupOf);
      setGroupHeaderRow(newGroupHeaderRow);
      setGroupMapping(newGroupMapping);
      setIncludedSheets(included);

      const firstGroupSheet = t.groups[0]?.sheetNames.find((s) => sheetNames.includes(s));
      const sheet = firstGroupSheet ?? sheetNames[0] ?? null;
      setActiveSheet(sheet);
      const preview = await previewSpreadsheet(t.sampleFilePath, sheet, t.delimiter, 50);
      setRows(preview.rows);
      setDelimiter(t.delimiter ?? preview.delimiter);
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
      // Everything starts included, and every sheet starts as its own
      // standalone group — flagging the few sheets that don't belong (a
      // training log, an absence sheet, ...) and merging the ones that
      // share a layout is less work than doing either from scratch.
      setIncludedSheets(new Set(sheetNames));
      setSheetGroupOf({});
      setGroupHeaderRow({});
      setGroupMapping({});
      const preview = await previewSpreadsheet(path, firstSheet, null, 50);
      setRows(preview.rows);
      setDelimiter(preview.delimiter);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function refetchRows(sheet: string | null, delim: string | null) {
    if (!filePath) return;
    setLoadingPreview(true);
    setError(null);
    try {
      const preview = await previewSpreadsheet(filePath, sheet, delim, 50);
      setRows(preview.rows);
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

  // Just switches which sheet's raw grid is being looked at — header
  // row/mapping are derived from whichever group that sheet belongs to,
  // so revisiting an already-configured sheet shows its real config
  // instead of resetting it.
  function handleSheetClick(sheetName: string) {
    if (sheetName === activeSheet) return;
    setActiveSheet(sheetName);
    refetchRows(sheetName, delimiter);
  }

  function toggleSheetIncluded(sheetName: string) {
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(sheetName)) next.delete(sheetName);
      else next.add(sheetName);
      return next;
    });
  }

  /** Merges `otherSheet` into the active sheet's group, or splits it back into its own fresh one if already merged. */
  function toggleSheetMerge(otherSheet: string) {
    if (!activeSheet) return;
    const activeKey = groupKeyOf(activeSheet);
    if (groupKeyOf(otherSheet) === activeKey) {
      setSheetGroupOf((prev) => ({ ...prev, [otherSheet]: otherSheet }));
      setGroupHeaderRow((prev) => ({ ...prev, [otherSheet]: 1 }));
      setGroupMapping((prev) => ({ ...prev, [otherSheet]: {} }));
    } else {
      setSheetGroupOf((prev) => ({ ...prev, [otherSheet]: activeKey }));
    }
  }

  function handleDelimiterChange(newDelimiter: string) {
    setDelimiter(newDelimiter);
    // Column boundaries just shifted, so whatever header row/mapping was
    // set for the csv's one implicit group no longer means anything.
    setGroupHeaderRow((prev) => ({ ...prev, [CSV_GROUP_KEY]: 1 }));
    setGroupMapping((prev) => ({ ...prev, [CSV_GROUP_KEY]: {} }));
    refetchRows(activeSheet, newDelimiter);
  }

  function handleHeaderRowClick(rowNumber: number) {
    const key = groupKeyOf(activeSheet);
    setGroupHeaderRow((prev) => ({ ...prev, [key]: rowNumber }));
    setGroupMapping((prev) => ({ ...prev, [key]: {} }));
  }

  function setColumnMapping(colIndex: number, field: PaymentTargetField | "") {
    const key = groupKeyOf(activeSheet);
    setGroupMapping((prev) => {
      const current = prev[key] ?? {};
      const next = { ...current };
      if (!field) {
        delete next[colIndex];
      } else {
        for (const k of Object.keys(next)) {
          const idx = Number(k);
          if (idx !== colIndex && next[idx] === field) delete next[idx];
        }
        next[colIndex] = field;
      }
      return { ...prev, [key]: next };
    });
  }

  function isGroupMappingValid(key: string): boolean {
    const fields = new Set(Object.values(groupMapping[key] ?? {}));
    return (fields.has("cpf") || fields.has("matricula")) && fields.has("valor");
  }

  const activeGroupKey = groupKeyOf(activeSheet);
  const headerRow = groupHeaderRow[activeGroupKey] ?? 1;
  const mapping = groupMapping[activeGroupKey] ?? {};

  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const columns = Array.from({ length: colCount }, (_, i) => i);
  const headerCells = rows[headerRow - 1] ?? [];
  const sampleRows = rows.slice(headerRow, headerRow + 8);

  // Every group among the sheets actually being imported — csv always has
  // just the one implicit group.
  const includedGroupKeys =
    fileKind === "csv"
      ? [CSV_GROUP_KEY]
      : Array.from(new Set(sheets.filter((s) => includedSheets.has(s)).map((s) => groupKeyOf(s))));

  const canAdvance =
    step === 0
      ? filePath !== null
      : step === 1
        ? sheets.length === 0 || includedSheets.size > 0
        : step === 2
          ? includedGroupKeys.length > 0 && includedGroupKeys.every(isGroupMappingValid)
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

      const groups: PaymentTemplateGroup[] = includedGroupKeys.map((key) => {
        const sheetNames =
          fileKind === "csv" ? [] : sheets.filter((s) => includedSheets.has(s) && groupKeyOf(s) === key);
        const m = groupMapping[key] ?? {};
        const fieldMappings = Object.entries(m).map(([indexStr, targetField]) => {
          const index = Number(indexStr);
          return {
            columnLetter: columnLetter(index),
            targetField,
            // Only the group currently in view has its raw grid cached —
            // header labels for the others are cosmetic (never used for
            // matching), so it's fine to leave them blank.
            headerLabel: key === activeGroupKey ? headerCells[index] ?? null : null,
          };
        });
        return { headerRow: groupHeaderRow[key] ?? 1, sheetNames, fieldMappings };
      });

      const input: PaymentTemplateInput = {
        name: name.trim(),
        clientId,
        fileKind,
        delimiter: fileKind === "csv" ? delimiter : null,
        decimalSeparator,
        dateFormat,
        sampleFilePath,
        sampleFileName,
        groups,
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
                        onClick={() => handleHeaderRowClick(i + 1)}
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
            {activeSheet && includedSheets.has(activeSheet) && includedSheets.size > 1 && (
              <div className="field" style={{ marginTop: "1rem" }}>
                <label>Estas abas usam a mesma estrutura de "{activeSheet}":</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.7rem", marginTop: "0.5rem" }}>
                  {sheets
                    .filter((s) => s !== activeSheet && includedSheets.has(s))
                    .map((s) => (
                      <label
                        key={s}
                        style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem", cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          checked={groupKeyOf(s) === activeGroupKey}
                          onChange={() => toggleSheetMerge(s)}
                        />
                        {s}
                      </label>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <p className="muted" style={{ marginTop: 0 }}>
              Para cada coluna, escolha a qual campo ela corresponde. É preciso mapear pelo menos um
              identificador (CPF ou Matrícula) e o Valor
              {includedGroupKeys.length > 1 ? " em cada configuração." : "."}
            </p>
            {includedGroupKeys.length > 1 && (
              <div className="sheet-tabs">
                {includedGroupKeys.map((key) => {
                  const memberCount = sheets.filter((s) => includedSheets.has(s) && groupKeyOf(s) === key).length;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`sheet-tab${key === activeGroupKey ? " active" : ""}`}
                      onClick={() => handleSheetClick(key)}
                    >
                      {key}
                      {memberCount > 1 ? ` (+${memberCount - 1})` : ""}
                      {!isGroupMappingValid(key) && (
                        <span
                          title="Faltam mapear CPF/Matrícula e Valor"
                          style={{ color: "var(--warning)", fontSize: "1.1em", lineHeight: 1 }}
                        >
                          •
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {rows.length === 0 && <p className="muted">Nenhuma linha encontrada.</p>}
            {rows.length > 0 && (
              <div className={`spreadsheet-grid-scroll${includedGroupKeys.length > 1 ? " attached-to-tabs" : ""}`}>
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
              {includedGroupKeys.length === 1
                ? "1 configuração de colunas."
                : `${includedGroupKeys.length} configurações de colunas diferentes.`}
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
