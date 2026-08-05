import {
  ArrowRight,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Filter,
  FolderOpen,
  GitBranch,
  Info,
  ListOrdered,
  Pencil,
  Plus,
  Route,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { listSpreadsheetSheets, pickPaymentFile, previewSpreadsheet } from "../lib/api";
import {
  createPaymentTemplate,
  listClients,
  listCompanies,
  updatePaymentTemplate,
  type ClientRow,
  type CompanyRow,
  type PaymentTemplateInput,
  type PaymentTemplateRuleInput,
} from "../lib/db";
import { columnLetter, fileNameFromPath } from "../lib/format";
import {
  DEFAULT_IDENTIFIER_PRIORITY,
  IDENTIFIER_FIELD_PRECEDENCE,
  PAYMENT_TARGET_FIELDS,
  PAYMENT_TARGET_FIELD_LABELS,
  REQUIRED_PAYMENT_FIELDS,
  type IdentifierAttempt,
  type IdentifierField,
  type PaymentFileKind,
  type PaymentTargetField,
  type PaymentTemplateGroup,
  type PaymentTemplateRow,
  type PaymentTemplateRuleKind,
} from "../lib/types";

const IDENTIFIER_FIELDS: IdentifierField[] = ["cpf", "matricula", "nome"];

/**
 * A file is only ever used transiently, to help build the mapping — it's
 * never persisted (see the payment_templates.sample_file_* migration this
 * replaced). Creating a template always starts from a real file, so it
 * always has all three steps; editing an already-saved template works
 * directly off the saved configuration, with no file involved at all, so
 * the "Arquivo" step doesn't apply there.
 */
type WizardStep = "file" | "mapping" | "details";
const STEP_LABEL_TEXT: Record<WizardStep, string> = {
  file: "Arquivo",
  mapping: "Mapeamento",
  details: "Detalhes",
};

/** Stand-in group key for csv, which has no sheets to key groups off of — there's always exactly one implicit group. */
const CSV_GROUP_KEY = "__csv__";

const SAMPLE_ROW_COUNT = 10;

const DELIMITER_OPTIONS = [
  { value: ",", label: "Vírgula (,)" },
  { value: ";", label: "Ponto e vírgula (;)" },
  { value: "\t", label: "Tabulação" },
  { value: "|", label: "Barra vertical (|)" },
];

const DATE_FORMAT_OPTIONS = ["DD/MM/YYYY", "DD/MM/YY", "YYYY-MM-DD", "MM/DD/YYYY"];

/** The wizard's editable draft of one step in a template's if/else-if/else routing chain — see `PaymentTemplateRule` in types.ts for the saved shape. */
interface WizardRule {
  kind: PaymentTemplateRuleKind;
  field: PaymentTargetField;
  /** Raw comma-separated input; ignored when `kind === "else"`. */
  valuesText: string;
  /** Ignored when `kind === "else"`. */
  caseInsensitive: boolean;
  companyId: number | null;
  clientId: number | null;
}

function isRuleValid(r: WizardRule): boolean {
  if (!r.companyId || !r.clientId) return false;
  if (r.kind === "else") return true;
  return r.valuesText.split(",").map((v) => v.trim()).filter(Boolean).length > 0;
}

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
  const [stepIndex, setStepIndex] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clientsAll, setClientsAll] = useState<ClientRow[]>([]);

  // `filePath !== null` doubles as "a real file is backing this session" —
  // always true partway through creating a new template (the "Arquivo"
  // step requires one before you can advance), always false while editing
  // an existing one (there's no "Arquivo" step there at all, see
  // `WizardStep`), so it's a reliable switch between the live grid and the
  // abstract, file-less column editor in the "Mapeamento" step below.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<PaymentFileKind | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [includedSheets, setIncludedSheets] = useState<Set<string>>(new Set());
  const [delimiter, setDelimiter] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);

  // Every sheet starts as its own standalone group (its own mapping);
  // `sheetGroupOf[sheet]` names which sheet's config it actually uses once
  // merged with another via the "estas abas usam o mesmo mapeamento de X"
  // checklist. No header-row concept: which rows are real data is decided
  // at import time by trying to parse each row's "data" field as a date,
  // not by a fixed row number picked here.
  const [sheetGroupOf, setSheetGroupOf] = useState<Record<string, string>>({});
  const [groupMapping, setGroupMapping] = useState<Record<string, Record<number, PaymentTargetField>>>({});
  // Cosmetic header hint per mapped column — captured from the live grid
  // when a file is present, or carried straight over from the saved
  // template's `headerLabel` when editing without one. Never used for
  // matching, only to help a human recognize which column is which.
  const [groupFieldLabels, setGroupFieldLabels] = useState<Record<string, Record<number, string | null>>>({});
  // How many blank columns past the last already-mapped one are revealed in
  // the file-less grid (editing mode) — lets you map a brand new column by
  // picking a field for it, same interaction as the live grid's header
  // select, just without real data underneath. Reset per active group.
  const [extraColumns, setExtraColumns] = useState(0);
  // Which column's select was last focused — purely a visual highlight
  // (tinted header + column, small pencil icon) so it's obvious which
  // column you're currently mapping in a wide table.
  const [focusedColumn, setFocusedColumn] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [rules, setRules] = useState<WizardRule[]>([]);
  const [identifierAttempts, setIdentifierAttempts] = useState<IdentifierAttempt[]>(DEFAULT_IDENTIFIER_PRIORITY);

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = target !== null && target !== "new";
  const steps: WizardStep[] = isEditing ? ["mapping", "details"] : ["file", "mapping", "details"];
  const currentStep = steps[stepIndex];

  useEffect(() => {
    listCompanies().then(setCompanies);
    listClients().then(setClientsAll);
  }, []);

  useEffect(() => {
    if (target === null) return;
    setStepIndex(0);
    setError(null);
    setBusy(false);

    if (target === "new") {
      setFilePath(null);
      setFileKind(null);
      setSheets([]);
      setActiveSheet(null);
      setIncludedSheets(new Set());
      setDelimiter(null);
      setRows([]);
      setSheetGroupOf({});
      setGroupMapping({});
      setGroupFieldLabels({});
      setExtraColumns(0);
      setName("");
      setDateFormat("DD/MM/YYYY");
      setRules([]);
      setIdentifierAttempts(DEFAULT_IDENTIFIER_PRIORITY.map((a) => [...a]));
      return;
    }

    setFilePath(null);
    setFileKind(target.fileKind);
    setDelimiter(target.delimiter);
    setName(target.name);
    setDateFormat(target.dateFormat);
    setRules(
      target.rules.map((r) => ({
        kind: r.kind,
        field: r.field ?? PAYMENT_TARGET_FIELDS[0],
        valuesText: r.values.join(", "),
        caseInsensitive: r.caseInsensitive,
        companyId: r.companyId,
        clientId: r.clientId,
      })),
    );
    setIdentifierAttempts(target.identifierPriority.map((a) => [...a]));
    hydrateFromTemplate(target);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [target, onClose]);

  /** Which group a sheet's mapping should be read from — csv always has exactly one, implicit group. */
  function groupKeyOf(sheetName: string | null): string {
    if (fileKind === "csv" || sheetName === null) return CSV_GROUP_KEY;
    return sheetGroupOf[sheetName] ?? sheetName;
  }

  /** Rebuilds the wizard's grouping/mapping state straight from a saved template — no file, no I/O. */
  function hydrateFromTemplate(t: PaymentTemplateRow) {
    const newSheetGroupOf: Record<string, string> = {};
    const newGroupMapping: Record<string, Record<number, PaymentTargetField>> = {};
    const newGroupFieldLabels: Record<string, Record<number, string | null>> = {};
    const sheetNames: string[] = [];

    for (const group of t.groups) {
      const repKey = group.sheetNames[0] ?? CSV_GROUP_KEY;
      const m: Record<number, PaymentTargetField> = {};
      const labels: Record<number, string | null> = {};
      for (const fm of group.fieldMappings) {
        const index = letterToIndex(fm.columnLetter);
        if (index !== null) {
          m[index] = fm.targetField;
          labels[index] = fm.headerLabel;
        }
      }
      newGroupMapping[repKey] = m;
      newGroupFieldLabels[repKey] = labels;
      for (const s of group.sheetNames) {
        newSheetGroupOf[s] = repKey;
        sheetNames.push(s);
      }
    }

    setSheets(sheetNames);
    setSheetGroupOf(newSheetGroupOf);
    setGroupMapping(newGroupMapping);
    setGroupFieldLabels(newGroupFieldLabels);
    setIncludedSheets(new Set(sheetNames));
    setActiveSheet(sheetNames[0] ?? null);
    setRows([]);
    setExtraColumns(0);
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
      setSheetGroupOf({});
      setGroupMapping({});
      setGroupFieldLabels({});
      setExtraColumns(0);
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
    await loadFile(path);
  }

  // Just switches which sheet's config is being looked at — the mapping is
  // derived from whichever group that sheet belongs to, so revisiting an
  // already-configured sheet shows its real config instead of resetting
  // it.
  function handleSheetClick(sheetName: string) {
    if (sheetName === activeSheet) return;
    setActiveSheet(sheetName);
    setExtraColumns(0);
    setFocusedColumn(null);
    refetchRows(sheetName, delimiter);
  }

  /** Includes or excludes a single sheet from the import — independent of whatever it's mirroring, since that's just where its mapping comes from, not a shared identity. */
  function toggleSheetIncluded(sheet: string) {
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(sheet)) next.delete(sheet);
      else next.add(sheet);
      return next;
    });
  }

  /** "Espelhar mapeamento": the active sheet (and anyone already sharing its mapping) adopts `sourceSheet`'s mapping instead of its own. */
  function mirrorActiveSheet(sourceSheet: string) {
    if (!activeSheet) return;
    const activeKey = groupKeyOf(activeSheet);
    const sourceKey = groupKeyOf(sourceSheet);
    if (sourceKey === activeKey) return;

    // `groupKeyOf` only follows one hop, so if the active sheet was itself
    // anchoring other sheets, repointing just it would strand them
    // pointing at a key that's no longer self-referential. Repoint every
    // sheet that currently resolves to activeKey in one pass instead.
    setSheetGroupOf((prev) => {
      const next = { ...prev };
      for (const s of sheets) {
        if ((next[s] ?? s) === activeKey) next[s] = sourceKey;
      }
      return next;
    });
  }

  /** Splits the active sheet back out into its own independent mapping, keeping whatever it was mirroring as a starting point (used by the "própria" option, and implicitly by any manual edit — see `setColumnMapping`). */
  function detachActiveSheet() {
    if (!activeSheet) return;
    const sourceKey = groupKeyOf(activeSheet);
    if (sourceKey === activeSheet) return;
    setSheetGroupOf((prev) => ({ ...prev, [activeSheet]: activeSheet }));
    setGroupMapping((prev) => ({ ...prev, [activeSheet]: { ...(prev[sourceKey] ?? {}) } }));
    setGroupFieldLabels((prev) => ({ ...prev, [activeSheet]: { ...(prev[sourceKey] ?? {}) } }));
  }

  function handleDelimiterChange(newDelimiter: string) {
    setDelimiter(newDelimiter);
    // Column boundaries just shifted, so whatever mapping was set for the
    // csv's one implicit group no longer means anything.
    setGroupMapping((prev) => ({ ...prev, [CSV_GROUP_KEY]: {} }));
    setGroupFieldLabels((prev) => ({ ...prev, [CSV_GROUP_KEY]: {} }));
    refetchRows(activeSheet, newDelimiter);
  }

  function setColumnMapping(colIndex: number, field: PaymentTargetField | "", headerLabel?: string | null) {
    const sourceKey = groupKeyOf(activeSheet);
    // Editing while mirroring another sheet's mapping forks it into the
    // active sheet's own independent group first — the mirrored sheet
    // keeps its mapping untouched, only the active one changes. Below,
    // reading from `sourceKey` and writing to `targetKey` in the same
    // pass is what makes that fork carry over the mirrored values instead
    // of starting the active sheet from a blank mapping.
    const isMirroring = activeSheet !== null && fileKind !== "csv" && sourceKey !== activeSheet;
    const targetKey = isMirroring ? activeSheet : sourceKey;

    if (isMirroring) {
      setSheetGroupOf((prev) => ({ ...prev, [activeSheet]: activeSheet }));
    }

    setGroupMapping((prev) => {
      const current = { ...(prev[sourceKey] ?? {}) };
      if (!field) {
        delete current[colIndex];
      } else {
        for (const k of Object.keys(current)) {
          const idx = Number(k);
          if (idx !== colIndex && current[idx] === field) delete current[idx];
        }
        current[colIndex] = field;
      }
      return { ...prev, [targetKey]: current };
    });
    setGroupFieldLabels((prev) => {
      const current = { ...(prev[sourceKey] ?? {}) };
      if (!field) {
        delete current[colIndex];
      } else if (headerLabel !== undefined) {
        current[colIndex] = headerLabel;
      }
      return { ...prev, [targetKey]: current };
    });
  }

  function isGroupMappingValid(key: string): boolean {
    const fields = new Set(Object.values(groupMapping[key] ?? {}));
    const hasIdentifier = IDENTIFIER_FIELD_PRECEDENCE.some((f) => fields.has(f));
    return hasIdentifier && REQUIRED_PAYMENT_FIELDS.every((f) => fields.has(f));
  }

  const hasElseRule = rules.some((r) => r.kind === "else");

  /** New "condition" rows always land right before the "senão" rule, if one exists — that one always stays last. */
  function addConditionRule() {
    const newRule: WizardRule = {
      kind: "condition",
      field: PAYMENT_TARGET_FIELDS[0],
      valuesText: "",
      caseInsensitive: true,
      companyId: null,
      clientId: null,
    };
    setRules((prev) => {
      const elseIndex = prev.findIndex((r) => r.kind === "else");
      if (elseIndex === -1) return [...prev, newRule];
      return [...prev.slice(0, elseIndex), newRule, ...prev.slice(elseIndex)];
    });
  }

  function addElseRule() {
    setRules((prev) => [
      ...prev,
      {
        kind: "else",
        field: PAYMENT_TARGET_FIELDS[0],
        valuesText: "",
        caseInsensitive: true,
        companyId: null,
        clientId: null,
      },
    ]);
  }

  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateRule(index: number, patch: Partial<WizardRule>) {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addIdentifierAttempt() {
    setIdentifierAttempts((prev) => [...prev, []]);
  }

  function removeIdentifierAttempt(index: number) {
    setIdentifierAttempts((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleIdentifierField(index: number, field: IdentifierField) {
    setIdentifierAttempts((prev) =>
      prev.map((attempt, i) =>
        i === index
          ? attempt.includes(field)
            ? attempt.filter((f) => f !== field)
            : [...attempt, field]
          : attempt,
      ),
    );
  }

  function moveIdentifierAttempt(index: number, direction: -1 | 1) {
    setIdentifierAttempts((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const isIdentifierPriorityValid = identifierAttempts.length > 0 && identifierAttempts.every((a) => a.length > 0);

  const activeGroupKey = groupKeyOf(activeSheet);
  const mapping = groupMapping[activeGroupKey] ?? {};

  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const columns = Array.from({ length: colCount }, (_, i) => i);
  // Best-effort cosmetic hint for the mapping grid's column labels — not a
  // "real" header, just whatever the first row happens to contain.
  const firstRowHint = rows[0] ?? [];
  const sampleRows = rows.slice(0, SAMPLE_ROW_COUNT);

  // Same grid, no live data: the file-less editing mode only knows about
  // already-mapped columns, plus however many blank ones `extraColumns`
  // has revealed past the last mapped one — picking a field for a blank
  // one is how a new column gets mapped, exactly like clicking a live
  // grid's header select.
  const mappedMaxIndex = Math.max(-1, ...Object.keys(mapping).map(Number));
  const noFileColumns = Array.from({ length: mappedMaxIndex + 1 + extraColumns }, (_, i) => i);

  // Every group among the sheets actually being imported — csv always has
  // just the one implicit group.
  const includedGroupKeys =
    fileKind === "csv"
      ? [CSV_GROUP_KEY]
      : Array.from(new Set(sheets.filter((s) => includedSheets.has(s)).map((s) => groupKeyOf(s))));

  // Read-only readout of the row-validity filter — there's nothing to
  // configure here, it's just whichever column each included group already
  // has mapped to "data" (see the `PaymentTemplateGroup` doc comment).
  const dataFilterEntries = includedGroupKeys.map((key) => {
    const m = groupMapping[key] ?? {};
    const index = Object.entries(m).find(([, field]) => field === "data")?.[0];
    return { key, columnLabel: index !== undefined ? columnLetter(Number(index)) : null };
  });

  // Every other included sheet — candidates for "espelhar mapeamento"
  // (including whichever one the active sheet currently mirrors, if any,
  // so that value shows up selected in the dropdown below).
  const mirrorOptions = sheets.filter((s) => s !== activeSheet && includedSheets.has(s));
  const mirroringSheet = activeSheet && activeGroupKey !== activeSheet ? activeGroupKey : "";

  /** Validates the current step and either advances or blocks with an explanation — an attempt to advance always gets a reaction, not just a silently-disabled button. */
  function handleAdvance() {
    setError(null);
    if (currentStep === "file" && filePath === null) {
      setError("Selecione um arquivo antes de avançar.");
      return;
    }
    if (currentStep === "mapping") {
      if (sheets.length > 0 && includedSheets.size === 0) {
        setError("Selecione ao menos uma aba para importar.");
        return;
      }
      if (includedGroupKeys.length === 0) {
        setError("Nenhuma configuração de colunas para mapear.");
        return;
      }
      const invalidKey = includedGroupKeys.find((k) => !isGroupMappingValid(k));
      if (invalidKey) {
        setError(
          `"${invalidKey}": mapeie um identificador (CPF, Matrícula ou Nome) e os campos Local, Data, Função e Horário antes de avançar.`,
        );
        return;
      }
    }
    setStepIndex((s) => s + 1);
  }

  async function handleSave() {
    if (!fileKind || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const editing = target !== null && target !== "new" ? target : null;

      const groups: PaymentTemplateGroup[] = includedGroupKeys.map((key) => {
        const sheetNames =
          fileKind === "csv" ? [] : sheets.filter((s) => includedSheets.has(s) && groupKeyOf(s) === key);
        const m = groupMapping[key] ?? {};
        const labels = groupFieldLabels[key] ?? {};
        const fieldMappings = Object.entries(m).map(([indexStr, targetField]) => {
          const index = Number(indexStr);
          return {
            columnLetter: columnLetter(index),
            targetField,
            headerLabel: labels[index] ?? null,
          };
        });
        return { sheetNames, fieldMappings };
      });

      const ruleInputs: PaymentTemplateRuleInput[] = rules.map((r) => ({
        kind: r.kind,
        field: r.kind === "condition" ? r.field : null,
        values:
          r.kind === "condition"
            ? r.valuesText.split(",").map((v) => v.trim()).filter(Boolean)
            : [],
        caseInsensitive: r.caseInsensitive,
        companyId: r.companyId!,
        clientId: r.clientId!,
      }));

      const input: PaymentTemplateInput = {
        name: name.trim(),
        fileKind,
        delimiter: fileKind === "csv" ? delimiter : null,
        dateFormat,
        identifierPriority: identifierAttempts,
        groups,
        rules: ruleInputs,
      };

      if (editing) {
        await updatePaymentTemplate(editing.id, input);
      } else {
        await createPaymentTemplate(input);
      }

      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Checklist of other included sheets that can be merged into (or split out of) the active sheet's group. */
  if (!target) return null;

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
        {steps.map((s, i) => (
          <span key={s} className={`wizard-step${i === stepIndex ? " active" : i < stepIndex ? " done" : ""}`}>
            {i + 1}. {STEP_LABEL_TEXT[s]}
          </span>
        ))}
      </div>

      <div
        style={{ flex: 1, overflow: "auto", padding: "1.5rem", background: "var(--bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {error && <div className="error-box" style={{ marginBottom: "1rem" }}>{error}</div>}

        {currentStep === "file" && (
          <div className="card" style={{ maxWidth: "32rem" }}>
            <div className="field">
              <label>Arquivo de exemplo</label>
              {filePath ? (
                <p className="muted" style={{ margin: "0.4rem 0" }}>{fileNameFromPath(filePath)}</p>
              ) : (
                <p className="muted" style={{ margin: "0.4rem 0" }}>Nenhum arquivo selecionado.</p>
              )}
              <button type="button" className="secondary" onClick={handlePickFile}>
                <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                {filePath ? "Trocar arquivo" : "Selecionar arquivo"}
              </button>
              <p className="field-hint">
                Formatos aceitos: CSV, XLSX, XLS ou ODS. Usado só para montar o mapeamento agora —
                não é guardado. Depois de salvo, o template só armazena a configuração de colunas.
              </p>
            </div>
          </div>
        )}

        {currentStep === "mapping" && (
          <div style={{ display: "flex", gap: "1.2rem", alignItems: "flex-start" }}>
            {sheets.length > 1 && (
              <aside className="mapping-sidebar">
                <div className="mapping-sidebar-header">
                  <strong>Mapeamento por aba</strong>
                  <p className="muted">Selecione a aba para configurar</p>
                </div>
                <nav className="mapping-sidebar-nav">
                  {sheets.map((s) => {
                    const included = includedSheets.has(s);
                    const groupKey = groupKeyOf(s);
                    const mirroring = groupKey !== s ? groupKey : null;
                    return (
                      <button
                        key={s}
                        type="button"
                        className={`mapping-sidebar-item${s === activeSheet ? " active" : ""}${included ? "" : " excluded"}`}
                        onClick={() => handleSheetClick(s)}
                      >
                        <span
                          className="mapping-sidebar-check"
                          role="checkbox"
                          aria-checked={included}
                          aria-label={included ? `Remover "${s}" da importação` : `Incluir "${s}" na importação`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSheetIncluded(s);
                          }}
                        >
                          {included ? <CheckSquare size={14} /> : <Square size={14} />}
                        </span>
                        <span className="mapping-sidebar-label">
                          {s}
                          {mirroring && <span className="mapping-sidebar-mirroring"> → {mirroring}</span>}
                        </span>
                        {included && !isGroupMappingValid(groupKey) && (
                          <span
                            className="mapping-sidebar-warn"
                            title="Faltam mapear um identificador e/ou Local, Data, Função, Horário"
                          >
                            •
                          </span>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </aside>
            )}

            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="wizard-instructions">
                <h4>
                  <Info size={16} />
                  Instruções de mapeamento
                </h4>
                <p>
                  Para cada coluna da planilha, escolha na lista qual campo do sistema ela
                  representa — ou deixe como "Ignorar" se a coluna não for usada. Se outra aba já
                  tem a mesma estrutura, use "Espelhar mapeamento" abaixo em vez de mapear tudo de
                  novo.
                </p>
              </div>

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
                <div className="mapping-mirror-toolbar">
                  <span className="mapping-mirror-toolbar-label">Espelhar mapeamento:</span>
                  <select
                    value={mirroringSheet}
                    onChange={(e) => {
                      if (e.target.value) mirrorActiveSheet(e.target.value);
                      else detachActiveSheet();
                    }}
                  >
                    <option value="">Própria (não espelhada)</option>
                    {mirrorOptions.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!filePath ? (
                <div className="spreadsheet-grid-scroll">
                  <table className="spreadsheet-grid">
                    <thead>
                      <tr>
                        <th className="corner">#</th>
                        {noFileColumns.map((c) => {
                          const field = mapping[c];
                          const label = groupFieldLabels[activeGroupKey]?.[c];
                          const focused = c === focusedColumn;
                          return (
                            <th
                              key={c}
                              className={`mapping-header${field ? " is-mapped" : ""}${focused ? " focused" : ""}`}
                            >
                              <span className="header-label">
                                {columnLetter(c)}
                                {label ? ` — ${label}` : ""}
                                {focused && <Pencil size={12} />}
                              </span>
                              <select
                                value={field ?? ""}
                                onFocus={() => setFocusedColumn(c)}
                                onChange={(e) => setColumnMapping(c, e.target.value as PaymentTargetField | "")}
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
                        <th className="corner">
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.2rem" }}
                            onClick={() => setExtraColumns((n) => n + 1)}
                            title="Adicionar coluna"
                            aria-label="Adicionar coluna"
                          >
                            <Plus size={14} />
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td
                          className="row-gutter muted"
                          colSpan={noFileColumns.length + 2}
                          style={{ fontStyle: "italic" }}
                        >
                          Editando a configuração já salva — sem dados de exemplo.
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <>
                  {loadingPreview && <p className="muted">Carregando...</p>}
                  {!loadingPreview && rows.length === 0 && <p className="muted">Nenhuma linha encontrada.</p>}
                  {!loadingPreview && rows.length > 0 && (
                    <div className="spreadsheet-grid-scroll">
                      <table className="spreadsheet-grid">
                        <thead>
                          <tr>
                            <th className="corner">#</th>
                            {columns.map((c) => {
                              const field = mapping[c];
                              const focused = c === focusedColumn;
                              return (
                                <th
                                  key={c}
                                  className={`mapping-header${field ? " is-mapped" : ""}${focused ? " focused" : ""}`}
                                >
                                  <span className="header-label">
                                    {columnLetter(c)} — {firstRowHint[c] || "(vazio)"}
                                    {focused && <Pencil size={12} />}
                                  </span>
                                  <select
                                    value={field ?? ""}
                                    onFocus={() => setFocusedColumn(c)}
                                    onChange={(e) =>
                                      setColumnMapping(
                                        c,
                                        e.target.value as PaymentTargetField | "",
                                        firstRowHint[c] ?? null,
                                      )
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
                              <td className="row-gutter">{i + 1}</td>
                              {columns.map((c) => (
                                <td key={c} className={c === focusedColumn ? "col-focused" : undefined}>
                                  {row[c] ?? ""}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {currentStep === "details" && (
          <div className="details-layout">
            <aside className="details-sidebar">
              <div className="glass-panel">
                <div className="field-code">
                  <label htmlFor="template-name">Nome do template</label>
                  <input
                    id="template-name"
                    className="glass-input"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex.: Folha mensal — Provedor X"
                  />
                </div>
                <div className="field-code">
                  <label htmlFor="template-date-format">Formato de data</label>
                  <select
                    id="template-date-format"
                    className="glass-input"
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

                <h4 className="glass-panel-heading" style={{ marginTop: "1.2rem" }}>
                  <Filter size={16} />
                  Filtro de linha válida
                </h4>
                <p className="glass-panel-desc">
                  Tipo de filtro: Data (único disponível por enquanto). Uma linha só é
                  considerada válida quando a coluna abaixo consegue ser interpretada como data,
                  no formato configurado acima.
                </p>
                <div className="filter-entries">
                  {dataFilterEntries.map((e) => (
                    <div key={e.key} className="filter-entry">
                      <span>{e.key}</span>
                      <span className="filter-entry-col">coluna {e.columnLabel ?? "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </aside>

            <div className="details-main">
              <section className="glass-panel">
                <h3 className="glass-panel-heading">
                  <ListOrdered size={18} />
                  Prioridade de identificação
                </h3>
                <p className="glass-panel-desc">
                  Cada tentativa é um conjunto de campos que precisam bater juntos, no mesmo
                  colaborador — tentadas em ordem, a primeira que encontrar um colaborador vence.
                  Pelo menos uma tentativa é obrigatória.
                </p>

                {identifierAttempts.map((attempt, i) => (
                  <div key={i} className="identifier-attempt-row">
                    {i > 0 && <div className="identifier-attempt-connector" />}
                    <div className="logic-card identifier-attempt">
                      <div className={`identifier-attempt-num${i === 0 ? " first" : ""}`}>{i + 1}</div>
                      <div className="identifier-attempt-fields">
                        {IDENTIFIER_FIELDS.map((f) => (
                          <label
                            key={f}
                            className={`identifier-field-pill${attempt.includes(f) ? " checked" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={attempt.includes(f)}
                              onChange={() => toggleIdentifierField(i, f)}
                            />
                            {PAYMENT_TARGET_FIELD_LABELS[f]}
                          </label>
                        ))}
                      </div>
                      <div className="logic-card-actions">
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => moveIdentifierAttempt(i, -1)}
                          disabled={i === 0}
                          aria-label="Mover para cima"
                          title="Mover para cima"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => moveIdentifierAttempt(i, 1)}
                          disabled={i === identifierAttempts.length - 1}
                          aria-label="Mover para baixo"
                          title="Mover para baixo"
                        >
                          <ChevronDown size={14} />
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => removeIdentifierAttempt(i)}
                          aria-label="Remover tentativa"
                          title="Remover tentativa"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {identifierAttempts.length === 0 && (
                  <p className="field-hint" style={{ marginTop: "0.6rem" }}>
                    Nenhuma tentativa cadastrada — pelo menos uma é obrigatória para salvar.
                  </p>
                )}

                <button
                  type="button"
                  className="glow-button"
                  style={{ marginTop: "1rem" }}
                  onClick={addIdentifierAttempt}
                >
                  <Plus size={14} />
                  Adicionar tentativa
                </button>
              </section>

              <section className="glass-panel">
                <h3 className="glass-panel-heading">
                  <Route size={18} />
                  Regras de roteamento (Empresa/Cliente)
                </h3>
                <p className="glass-panel-desc">
                  Decide, linha a linha, a Empresa/Cliente de destino a partir do valor de um
                  campo já mapeado — avaliadas em ordem, a primeira que bater vence. Sempre
                  obrigatório, mesmo se o arquivo sempre pertencer a um único cliente (nesse
                  caso, use só uma regra "senão").
                </p>

                <div className="rule-list">
                  {rules.map((rule, i) => (
                    <div key={i} className={`logic-card rule-card${rule.kind === "else" ? " rule-card-else" : ""}`}>
                      <div className="rule-card-icon">
                        {rule.kind === "else" ? <GitBranch size={18} /> : <ArrowRight size={18} />}
                      </div>
                      <div className="rule-card-grid">
                        {rule.kind === "condition" ? (
                          <>
                            <div className="field-code">
                              <label>Se [Campo]</label>
                              <select
                                className="glass-input"
                                value={rule.field}
                                onChange={(e) => updateRule(i, { field: e.target.value as PaymentTargetField })}
                              >
                                {PAYMENT_TARGET_FIELDS.map((f) => (
                                  <option key={f} value={f}>
                                    {PAYMENT_TARGET_FIELD_LABELS[f]}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field-code">
                              <label>== [Valores possíveis]</label>
                              <input
                                className="glass-input"
                                type="text"
                                value={rule.valuesText}
                                onChange={(e) => updateRule(i, { valuesText: e.target.value })}
                                placeholder="Ex.: FLV, Mercearia"
                              />
                              <label className="field-code-checkbox">
                                <input
                                  type="checkbox"
                                  checked={rule.caseInsensitive}
                                  onChange={(e) => updateRule(i, { caseInsensitive: e.target.checked })}
                                />
                                Ignorar maiúsculas/minúsculas
                              </label>
                            </div>
                          </>
                        ) : (
                          <span className="rule-card-else-label">
                            SENÃO — se nenhuma regra acima bater, usa esta
                          </span>
                        )}
                        <div className="field-code consequence">
                          <label>Então [Empresa]</label>
                          <select
                            className="glass-input"
                            value={rule.companyId ?? ""}
                            onChange={(e) =>
                              updateRule(i, {
                                companyId: e.target.value ? Number(e.target.value) : null,
                                clientId: null,
                              })
                            }
                          >
                            <option value="">Selecione</option>
                            {companies.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field-code consequence">
                          <label>E [Cliente]</label>
                          <select
                            className="glass-input"
                            value={rule.clientId ?? ""}
                            onChange={(e) =>
                              updateRule(i, { clientId: e.target.value ? Number(e.target.value) : null })
                            }
                            disabled={!rule.companyId}
                          >
                            <option value="">Selecione</option>
                            {clientsAll
                              .filter((c) => c.companyId === rule.companyId)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                        </div>
                        <div className="rule-card-delete">
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.4rem" }}
                            onClick={() => removeRule(i)}
                            aria-label="Remover regra"
                            title="Remover regra"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {rules.length === 0 && (
                  <p className="field-hint" style={{ marginTop: "0.6rem" }}>
                    Nenhuma regra cadastrada — pelo menos uma é obrigatória para salvar.
                  </p>
                )}

                <div style={{ display: "flex", gap: "0.6rem", marginTop: "1rem" }}>
                  <button type="button" className="glow-button" onClick={addConditionRule}>
                    <Plus size={14} />
                    Adicionar regra
                  </button>
                  {!hasElseRule && (
                    <button type="button" className="glow-button" onClick={addElseRule}>
                      <Plus size={14} />
                      Adicionar "senão"
                    </button>
                  )}
                </div>
              </section>
            </div>
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
          onClick={() => setStepIndex((s) => s - 1)}
          disabled={stepIndex === 0 || busy}
        >
          <ChevronLeft size={15} style={{ marginRight: "0.3rem" }} />
          Voltar
        </button>
        {stepIndex < steps.length - 1 ? (
          <button type="button" onClick={handleAdvance} disabled={busy}>
            Avançar
            <ChevronRight size={15} style={{ marginLeft: "0.3rem" }} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSave}
            disabled={
              busy ||
              !name.trim() ||
              rules.length === 0 ||
              rules.some((r) => !isRuleValid(r)) ||
              !isIdentifierPriorityValid
            }
          >
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
