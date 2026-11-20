import { X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { READ_ONLY_TITLE } from "./AreaRoute";
import OptionPicker from "./OptionPicker";
import { ColumnQuestion, IgnoreQuestion, type GroupColumn } from "./TemplateColumns";
import { IdentifierOrderSection, moveIdentifier, SampleFileStep, SheetsStep, WizardDrawer } from "./TemplateWizardParts";
import { effectiveIdentifierOrder, identifierOrderFromSaved } from "./PaymentTemplateDetails";
import { downloadPaymentFileFromUrl, listSpreadsheetSheets, pickPaymentFile, previewSpreadsheet } from "../lib/api";
import { createEmployeeTemplate, updateEmployeeTemplate, type EmployeeTemplateInput } from "../lib/db";
import { uploadDropped } from "../lib/files";
import { columnLetter, fileNameFromPath } from "../lib/format";
import {
  checkEmployeeSheet,
  dataRowsOf,
  employeeHeaderRow,
  guessEmployeeMapping,
  headerSignature,
  headersOf,
  looksLikeEmployeeSheet,
} from "../lib/templateMapping";
import {
  EMPLOYEE_TARGET_FIELD_LABELS,
  type EmployeeTargetField,
  type EmployeeTemplateGroup,
  type EmployeeTemplateRow,
  type IdentifierField,
  type PaymentFileKind,
  IGNORED_COLUMN_FIELD,
  type IgnoredColumnField,
} from "../lib/types";

/** What a column answers in the wizard: a field, or "Ignorar". */
type ColumnAnswer = EmployeeTargetField | IgnoredColumnField;

/**
 * Builds a colaboradores template the same way the payment one is built:
 * Arquivo → Abas → Colunas ("Onde está cada informação?", prefilled from
 * the column names) → Conferir (each sheet read on its real rows) →
 * Detalhes (name, how an existing person is found, accepted formats).
 * Editing a saved template has no sample file: Abas → Colunas → Detalhes.
 * The header row isn't asked: it's spotted in the sample file (the row
 * with the most column names) and saved per group, so the import skips it.
 */

type WizardStep = "file" | "sheets" | "answers" | "check" | "details";
const STEP_LABEL_TEXT: Record<WizardStep, string> = {
  file: "Arquivo",
  sheets: "Abas",
  answers: "Colunas",
  check: "Conferir",
  details: "Detalhes",
};

/** Stand-in group key for csv, which has no sheets — there's always exactly one implicit group. */
const CSV_GROUP_KEY = "__csv__";
const FILE_EXTENSIONS = ["csv", "xlsx", "xls", "ods"];
const PREVIEW_ROWS = 500;
const IDENTIFIER_FIELDS: IdentifierField[] = ["cpf", "matricula", "nome"];

const QUESTIONS: { field: EmployeeTargetField; hint: string }[] = [
  { field: "nome", hint: "nome completo" },
  { field: "cpf", hint: "com ou sem pontos" },
  { field: "matricula", hint: "código interno" },
  { field: "pix", hint: "chave para pagamento" },
];

const DELIMITER_OPTIONS = [
  { value: ",", label: "Vírgula (,)" },
  { value: ";", label: "Ponto e vírgula (;)" },
  { value: "\t", label: "Tabulação" },
  { value: "|", label: "Barra vertical (|)" },
];

/** An employee template starts by finding people by CPF, then matrícula, then nome — narrowed to the columns it answers. */
const DEFAULT_ORDER: IdentifierField[] = ["cpf", "matricula", "nome"];

function fileKindFromPath(path: string): PaymentFileKind {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "ods") return "ods";
  if (ext === "xls") return "xls";
  return "xlsx";
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

function columnOf(mapping: Record<number, ColumnAnswer>, field: EmployeeTargetField): number | null {
  const entry = Object.entries(mapping).find(([, f]) => f === field);
  return entry ? Number(entry[0]) : null;
}

const fieldLabel = (f: ColumnAnswer) => (f === IGNORED_COLUMN_FIELD ? "Ignorada" : EMPLOYEE_TARGET_FIELD_LABELS[f]);

export default function EmployeeTemplateWizard({
  target,
  onClose,
  onSaved,
  readOnly = false,
}: {
  /** `null` keeps the wizard closed; `"new"` starts a blank template; a row edits it. */
  target: EmployeeTemplateRow | "new" | null;
  onClose: () => void;
  onSaved: () => void;
  /** View-only profile: the steps can be browsed, but there's no Salvar. */
  readOnly?: boolean;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<PaymentFileKind | null>(null);
  const [acceptedFileKinds, setAcceptedFileKinds] = useState<Set<PaymentFileKind>>(new Set());
  const [sheets, setSheets] = useState<string[]>([]);
  const [includedSheets, setIncludedSheets] = useState<Set<string>>(new Set());
  const [delimiter, setDelimiter] = useState<string | null>(null);
  const [sheetRows, setSheetRows] = useState<Record<string, string[][]>>({});

  // Same grouping as the payment wizard: `sheetGroupOf[sheet]` names the
  // sheet whose answers it uses (itself when it answers alone).
  const [sheetGroupOf, setSheetGroupOf] = useState<Record<string, string>>({});
  const [groupMapping, setGroupMapping] = useState<Record<string, Record<number, ColumnAnswer>>>({});
  const [groupFieldLabels, setGroupFieldLabels] = useState<Record<string, Record<number, string | null>>>({});
  /** The saved header row per group (1-indexed), used when there's no sample file to spot it in. */
  const [groupHeaderRow, setGroupHeaderRow] = useState<Record<string, number | null>>({});
  const [shareAnswers, setShareAnswers] = useState(true);
  const [separatedSheets, setSeparatedSheets] = useState<Set<string>>(new Set());
  const [answersTab, setAnswersTab] = useState<string | null>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [identifierOrder, setIdentifierOrder] = useState<IdentifierField[]>(DEFAULT_ORDER);

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = target !== null && target !== "new";
  const steps: WizardStep[] = [
    ...(isEditing ? [] : ["file" as const]),
    ...(fileKind === "csv" ? [] : ["sheets" as const]),
    "answers",
    ...(isEditing ? [] : ["check" as const]),
    "details",
  ];
  const currentStep = steps[stepIndex];

  useEffect(() => {
    if (target === null) return;
    setStepIndex(0);
    setError(null);
    setBusy(false);
    setFilePath(null);
    resetMapping([]);
    if (target === "new") {
      setFileKind(null);
      setAcceptedFileKinds(new Set());
      setDelimiter(null);
      setName("");
      setIdentifierOrder(DEFAULT_ORDER);
      return;
    }
    setFileKind(target.fileKind);
    setAcceptedFileKinds(new Set(target.acceptedFileKinds));
    setDelimiter(target.delimiter);
    setName(target.name);
    setIdentifierOrder(identifierOrderFromSaved(target.identifierPriority));
    hydrate(target);
  }, [target]);

  // Nothing floats over the wizard (see `body.wizard-open` in App.css).
  useEffect(() => {
    if (!target) return;
    document.body.classList.add("wizard-open");
    return () => document.body.classList.remove("wizard-open");
  }, [target]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [error]);

  function resetMapping(sheetNames: string[]) {
    setSheets(sheetNames);
    setIncludedSheets(new Set());
    setSheetRows({});
    setSheetGroupOf({});
    setGroupMapping({});
    setGroupFieldLabels({});
    setGroupHeaderRow({});
    setShareAnswers(true);
    setSeparatedSheets(new Set());
    setAnswersTab(null);
    setOpenCheck(null);
  }

  function hydrate(t: EmployeeTemplateRow) {
    const groupOf: Record<string, string> = {};
    const mapping: Record<string, Record<number, ColumnAnswer>> = {};
    const labels: Record<string, Record<number, string | null>> = {};
    const headerRows: Record<string, number | null> = {};
    const names: string[] = [];
    for (const g of t.groups) {
      const key = g.sheetNames[0] ?? g.excludedSheetNames[0] ?? CSV_GROUP_KEY;
      const m: Record<number, ColumnAnswer> = {};
      const l: Record<number, string | null> = {};
      for (const fm of g.fieldMappings) {
        const index = letterToIndex(fm.columnLetter);
        if (index !== null) {
          m[index] = fm.targetField;
          l[index] = fm.headerLabel;
        }
      }
      mapping[key] = m;
      labels[key] = l;
      headerRows[key] = g.headerRow;
      for (const s of g.sheetNames) {
        groupOf[s] = key;
        names.push(s);
      }
      for (const s of g.excludedSheetNames) {
        groupOf[s] = s;
        headerRows[s] = g.headerRow;
        names.push(s);
      }
    }
    setSheets(names);
    setSheetGroupOf(groupOf);
    setGroupMapping(mapping);
    setGroupFieldLabels(labels);
    setGroupHeaderRow(headerRows);
    setIncludedSheets(new Set(t.groups.flatMap((g) => g.sheetNames)));
  }

  /** Fresh answers for a just-loaded file, like the payment wizard: prefilled per sheet, identical sheets together, non-roster sheets unchecked. */
  function prefill(sheetNames: string[], rowsBySheet: Record<string, string[][]>) {
    const keys = sheetNames.length > 0 ? sheetNames : [CSV_GROUP_KEY];
    const groupOf: Record<string, string> = {};
    const mapping: Record<string, Record<number, ColumnAnswer>> = {};
    const labels: Record<string, Record<number, string | null>> = {};
    const anchorBySignature = new Map<string, string>();
    for (const key of keys) {
      const rows = rowsBySheet[key] ?? [];
      const signature = sheetNames.length > 0 ? headerSignature(rows) : null;
      const anchor = signature ? anchorBySignature.get(signature) : undefined;
      if (anchor) {
        groupOf[key] = anchor;
        continue;
      }
      if (signature) anchorBySignature.set(signature, key);
      groupOf[key] = key;
      const m = guessEmployeeMapping(rows);
      const headers = headersOf(rows);
      mapping[key] = m;
      labels[key] = Object.fromEntries(Object.keys(m).map((i) => [Number(i), headers[Number(i)] || null]));
    }
    setSheetGroupOf(sheetNames.length > 0 ? groupOf : {});
    setGroupMapping(mapping);
    setGroupFieldLabels(labels);
    setIncludedSheets(new Set(sheetNames.filter((s) => looksLikeEmployeeSheet(rowsBySheet[s] ?? []))));
  }

  async function loadFile(path: string) {
    setLoadingPreview(true);
    setError(null);
    try {
      const sheetNames = await listSpreadsheetSheets(path);
      resetMapping(sheetNames);
      const keys = sheetNames.length > 0 ? sheetNames : [CSV_GROUP_KEY];
      const previews = await Promise.all(keys.map((k) => previewSpreadsheet(path, k === CSV_GROUP_KEY ? null : k, null, PREVIEW_ROWS)));
      const rowsBySheet = Object.fromEntries(keys.map((k, i) => [k, previews[i].rows]));
      setSheetRows(rowsBySheet);
      setDelimiter(previews[0]?.delimiter ?? null);
      prefill(sheetNames, rowsBySheet);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function selectFile(path: string) {
    setError(null);
    setFilePath(path);
    const kind = fileKindFromPath(path);
    setFileKind(kind);
    setAcceptedFileKinds(new Set([kind]));
    await loadFile(path);
  }

  async function handlePickFile() {
    const path = await pickPaymentFile();
    if (path) await selectFile(path);
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ext || !FILE_EXTENSIONS.includes(ext)) {
      setError("Formato de arquivo não suportado. Use CSV, XLSX, XLS ou ODS.");
      return;
    }
    try {
      const [path] = await uploadDropped(e.dataTransfer, FILE_EXTENSIONS);
      if (path) await selectFile(path);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function handleDownload(url: string) {
    const result = await downloadPaymentFileFromUrl(url);
    await selectFile(result.path);
  }

  async function handleDelimiterChange(next: string) {
    if (!filePath) return;
    setDelimiter(next);
    setLoadingPreview(true);
    try {
      const preview = await previewSpreadsheet(filePath, null, next, PREVIEW_ROWS);
      const rowsBySheet = { [CSV_GROUP_KEY]: preview.rows };
      setSheetRows(rowsBySheet);
      prefill([], rowsBySheet);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  /* ---------- sheets and groups ---------- */

  function groupKeyOf(sheet: string): string {
    if (fileKind === "csv") return CSV_GROUP_KEY;
    return sheetGroupOf[sheet] ?? sheet;
  }

  function membersOf(key: string): string[] {
    return sheets.filter((s) => groupKeyOf(s) === key);
  }

  function toggleSheet(sheet: string) {
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(sheet)) next.delete(sheet);
      else next.add(sheet);
      return next;
    });
  }

  function renameSheet(oldName: string, raw: string): boolean {
    const newName = raw.trim();
    if (!newName || newName === oldName) return true;
    if (sheets.includes(newName)) {
      setError(`Já existe uma aba chamada "${newName}".`);
      return false;
    }
    setError(null);
    const swap = (s: string) => (s === oldName ? newName : s);
    const renameKeys = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [swap(k), v]));
    setSheets((prev) => prev.map(swap));
    setIncludedSheets((prev) => new Set([...prev].map(swap)));
    setSheetGroupOf((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [swap(k), swap(v)])));
    setGroupMapping(renameKeys);
    setGroupFieldLabels(renameKeys);
    setGroupHeaderRow(renameKeys);
    setSheetRows(renameKeys);
    setSeparatedSheets((prev) => new Set([...prev].map(swap)));
    if (answersTab === oldName) setAnswersTab(newName);
    return true;
  }

  function addSheet(): string {
    let n = 1;
    let sheet = "Nova aba";
    while (sheets.includes(sheet)) sheet = `Nova aba ${++n}`;
    setSheets((prev) => [...prev, sheet]);
    setSheetGroupOf((prev) => ({ ...prev, [sheet]: sheet }));
    setGroupMapping((prev) => ({ ...prev, [sheet]: {} }));
    setGroupFieldLabels((prev) => ({ ...prev, [sheet]: {} }));
    setIncludedSheets((prev) => new Set(prev).add(sheet));
    return sheet;
  }

  /** Takes `sheet` out of its group with a copy of the group's answers; returns the key it answers under afterwards. */
  function detachSheet(sheet: string): string {
    const key = groupKeyOf(sheet);
    const others = membersOf(key).filter((s) => s !== sheet);
    if (others.length === 0) return key;
    const newKey = key === sheet ? others[0] : sheet;
    const moving = key === sheet ? others : [sheet];
    setSheetGroupOf((prev) => {
      const next = { ...prev };
      for (const s of moving) next[s] = newKey;
      return next;
    });
    setGroupMapping((prev) => ({ ...prev, [newKey]: { ...(prev[key] ?? {}) } }));
    setGroupFieldLabels((prev) => ({ ...prev, [newKey]: { ...(prev[key] ?? {}) } }));
    setGroupHeaderRow((prev) => ({ ...prev, [newKey]: prev[key] ?? null }));
    return sheet;
  }

  function removeSheet(sheet: string) {
    detachSheet(sheet);
    setSheets((prev) => prev.filter((s) => s !== sheet));
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      next.delete(sheet);
      return next;
    });
    setSheetGroupOf((prev) => {
      const { [sheet]: _gone, ...rest } = prev;
      return rest;
    });
    setSheetRows((prev) => {
      const { [sheet]: _gone, ...rest } = prev;
      return rest;
    });
  }

  function mergeGroupInto(key: string, sourceKey: string) {
    if (key === sourceKey) return;
    const joining = membersOf(key);
    setSeparatedSheets((prev) => new Set([...prev].filter((s) => !joining.includes(s))));
    setSheetGroupOf((prev) => {
      const next = { ...prev };
      for (const s of sheets) if ((next[s] ?? s) === key) next[s] = sourceKey;
      return next;
    });
    setAnswersTab(sourceKey);
  }

  function splitFromTab(key: string, sheet: string) {
    const remaining = membersOf(key).filter((s) => s !== sheet);
    detachSheet(sheet);
    setSeparatedSheets((prev) => new Set(prev).add(sheet));
    if (key === sheet && remaining.length > 0) setAnswersTab(remaining[0]);
  }

  function similarSheetClasses(pool: string[]): string[][] {
    const bySignature = new Map<string, string[]>();
    for (const s of pool) {
      const signature = headerSignature(sheetRows[s] ?? []);
      if (!signature) continue;
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), s]);
    }
    return [...bySignature.values()].filter((c) => c.length > 1);
  }

  function applyShareAnswers(share: boolean) {
    setShareAnswers(share);
    const groupOf = { ...sheetGroupOf };
    const mapping = { ...groupMapping };
    const labels = { ...groupFieldLabels };
    for (const cls of similarSheetClasses(sheets)) {
      if (share) {
        const members = cls.filter((s) => !separatedSheets.has(s));
        if (members.length < 2) continue;
        const anchor = groupKeyOf(members[0]);
        for (const s of members) groupOf[s] = anchor;
      } else {
        for (const s of cls) {
          const key = groupKeyOf(s);
          if (key === s) continue;
          groupOf[s] = s;
          mapping[s] = { ...(groupMapping[key] ?? {}) };
          labels[s] = { ...(groupFieldLabels[key] ?? {}) };
        }
      }
    }
    setSheetGroupOf(groupOf);
    setGroupMapping(mapping);
    setGroupFieldLabels(labels);
  }

  /* ---------- answers ---------- */

  function sampleSheetOf(key: string): string | null {
    const pool = fileKind === "csv" ? [CSV_GROUP_KEY] : membersOf(key);
    const included = pool.filter((s) => fileKind === "csv" || includedSheets.has(s));
    return [...included, ...pool].find((s) => (sheetRows[s] ?? []).length > 0) ?? null;
  }

  function columnsOfGroup(key: string): GroupColumn[] {
    const sample = sampleSheetOf(key);
    if (sample) {
      const rows = sheetRows[sample];
      const headers = headersOf(rows);
      const width = rows.reduce((max, r) => Math.max(max, r.length), headers.length);
      return Array.from({ length: width }, (_, i) => ({ index: i, header: headers[i] || null }));
    }
    const labels = groupFieldLabels[key] ?? {};
    const mappedMax = Math.max(-1, ...Object.keys(groupMapping[key] ?? {}).map(Number));
    return Array.from({ length: Math.max(mappedMax + 6, 12) }, (_, i) => ({ index: i, header: null, savedName: labels[i]?.trim() || null }));
  }

  function exampleOf(key: string, col: number): { sheet: string; value: string } | null {
    const sample = sampleSheetOf(key);
    if (!sample) return null;
    const value = dataRowsOf(sheetRows[sample]).map((r) => (r[col] ?? "").trim()).find(Boolean);
    return value ? { sheet: sample === CSV_GROUP_KEY ? "no arquivo" : `em ${sample}`, value } : null;
  }

  /** "Ignorar": adds/removes column `col` of group `key` from the ignored ones (only an unanswered column can be ignored). */
  function toggleIgnored(key: string, col: number) {
    const header = columnsOfGroup(key).find((c) => c.index === col)?.header ?? null;
    const isIgnored = (groupMapping[key] ?? {})[col] === IGNORED_COLUMN_FIELD;
    setGroupMapping((prev) => {
      const current = { ...(prev[key] ?? {}) };
      if (current[col] === IGNORED_COLUMN_FIELD) delete current[col];
      else if (current[col] === undefined) current[col] = IGNORED_COLUMN_FIELD;
      return { ...prev, [key]: current };
    });
    setGroupFieldLabels((prev) => {
      const current = { ...(prev[key] ?? {}) };
      if (isIgnored) delete current[col];
      else current[col] = header;
      return { ...prev, [key]: current };
    });
  }

  /** Clears every "Ignorar" column of group `key`. */
  function clearIgnored(key: string) {
    const cols = Object.entries(groupMapping[key] ?? {})
      .filter(([, f]) => f === IGNORED_COLUMN_FIELD)
      .map(([c]) => Number(c));
    setGroupMapping((prev) => {
      const current = { ...(prev[key] ?? {}) };
      for (const c of cols) delete current[c];
      return { ...prev, [key]: current };
    });
    setGroupFieldLabels((prev) => {
      const current = { ...(prev[key] ?? {}) };
      for (const c of cols) delete current[c];
      return { ...prev, [key]: current };
    });
  }

  function setAnswer(key: string, field: EmployeeTargetField, col: number | null) {
    const header = col === null ? null : (columnsOfGroup(key).find((c) => c.index === col)?.header ?? null);
    const current = groupMapping[key] ?? {};
    setGroupMapping((prev) => {
      const m = { ...(prev[key] ?? {}) };
      for (const k of Object.keys(m)) if (m[Number(k)] === field) delete m[Number(k)];
      if (col !== null) m[col] = field;
      return { ...prev, [key]: m };
    });
    setGroupFieldLabels((prev) => {
      const l = { ...(prev[key] ?? {}) };
      for (const k of Object.keys(current)) if (current[Number(k)] === field) delete l[Number(k)];
      if (col !== null) l[col] = header;
      return { ...prev, [key]: l };
    });
  }

  function groupLabel(key: string): string {
    if (fileKind === "csv") return filePath ? fileNameFromPath(filePath) : "Arquivo";
    const members = membersOf(key).filter((s) => includedSheets.has(s));
    const names = members.length > 0 ? members : membersOf(key);
    return names.length > 1 ? `${names[0]} e mais ${names.length - 1}` : (names[0] ?? key);
  }

  const includedGroupKeys =
    fileKind === "csv" ? [CSV_GROUP_KEY] : Array.from(new Set(sheets.filter((s) => includedSheets.has(s)).map(groupKeyOf)));
  const allGroupKeys = fileKind === "csv" ? [CSV_GROUP_KEY] : Array.from(new Set(sheets.map(groupKeyOf)));

  /** A group needs at least one column that identifies the person. */
  function isGroupValid(key: string): boolean {
    const m = groupMapping[key] ?? {};
    return IDENTIFIER_FIELDS.some((f) => columnOf(m, f) !== null);
  }
  const pendingGroups = includedGroupKeys.filter((k) => !isGroupValid(k));
  const tabKey = answersTab && includedGroupKeys.includes(answersTab) ? answersTab : (includedGroupKeys[0] ?? null);
  const similarIncluded = filePath && fileKind !== "csv" ? similarSheetClasses(sheets.filter((s) => includedSheets.has(s))) : [];
  const sharing = (key: string) => membersOf(key).filter((s) => includedSheets.has(s));

  const checks = (fileKind === "csv" ? [CSV_GROUP_KEY] : sheets.filter((s) => includedSheets.has(s))).map((sheet) => {
    const rows = sheetRows[sheet] ?? [];
    const key = fileKind === "csv" ? CSV_GROUP_KEY : groupKeyOf(sheet);
    return {
      sheet,
      key,
      label: sheet === CSV_GROUP_KEY ? groupLabel(key) : sheet,
      shared: fileKind !== "csv" && membersOf(key).length > 1,
      result: rows.length > 0 ? checkEmployeeSheet(rows, groupMapping[key] ?? {}) : null,
    };
  });
  const badChecks = checks.filter((c) => c.result?.problem);
  const people = checks.reduce((n, c) => n + (c.result && !c.result.problem ? c.result.people : 0), 0);

  const mappedIdentifiers = IDENTIFIER_FIELDS.filter((f) => includedGroupKeys.some((k) => columnOf(groupMapping[k] ?? {}, f) !== null));
  const order = effectiveIdentifierOrder(identifierOrder, mappedIdentifiers);

  function answerSeparately(sheet: string, shared: boolean) {
    let key = groupKeyOf(sheet);
    if (shared) {
      key = detachSheet(sheet);
      setSeparatedSheets((prev) => new Set(prev).add(sheet));
    }
    setAnswersTab(key);
    setOpenCheck(null);
    setStepIndex(steps.indexOf("answers"));
  }

  function stepSummary(step: WizardStep): string {
    switch (step) {
      case "file":
        return filePath ? fileNameFromPath(filePath) : "escolha uma planilha";
      case "sheets":
        return `${includedSheets.size} de ${sheets.length} ${sheets.length === 1 ? "aba" : "abas"}`;
      case "answers":
        if (pendingGroups.length > 0) return "falta responder";
        return includedGroupKeys.length > 1 ? `${includedGroupKeys.length} grupos respondidos` : "respondido";
      case "check":
        if (badChecks.length > 0) return `${badChecks.length} ${badChecks.length === 1 ? "aba com problema" : "abas com problema"}`;
        return `${people} ${people === 1 ? "colaborador" : "colaboradores"}`;
      case "details":
        return name.trim() || "nome";
    }
  }

  function handleAdvance() {
    setError(null);
    if (currentStep === "file" && !filePath) return;
    if (currentStep === "sheets" && includedSheets.size === 0) {
      setError("Marque ao menos uma aba para importar.");
      return;
    }
    if (currentStep === "answers" && pendingGroups.length > 0) {
      setAnswersTab(pendingGroups[0]);
      setError(`Falta dizer onde está o Nome, o CPF ou a Matrícula: ${pendingGroups.map(groupLabel).join(", ")}.`);
      return;
    }
    if (currentStep === "check" && badChecks.length > 0) {
      setError("Resolva as abas com problema (ou desmarque-as em Abas) antes de continuar.");
      return;
    }
    setStepIndex((s) => s + 1);
  }

  /** The header row to save for group `key`: spotted in its sample sheet, else the saved one. */
  function headerRowOf(key: string): number | null {
    const sample = sampleSheetOf(key);
    if (sample) {
      const index = employeeHeaderRow(sheetRows[sample]);
      return index < 0 ? null : index + 1;
    }
    return groupHeaderRow[key] ?? null;
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Dê um nome ao template.");
      return;
    }
    if (!fileKind) return;
    setBusy(true);
    setError(null);
    try {
      const groups: EmployeeTemplateGroup[] = allGroupKeys.map((key) => {
        const m = groupMapping[key] ?? {};
        const labels = groupFieldLabels[key] ?? {};
        return {
          sheetNames: fileKind === "csv" ? [] : sheets.filter((s) => includedSheets.has(s) && groupKeyOf(s) === key),
          excludedSheetNames: fileKind === "csv" ? [] : sheets.filter((s) => !includedSheets.has(s) && groupKeyOf(s) === key),
          fieldMappings: Object.entries(m).map(([i, targetField]) => ({
            columnLetter: columnLetter(Number(i)),
            targetField,
            headerLabel: labels[Number(i)] ?? null,
          })),
          headerRow: headerRowOf(key),
        };
      });
      const input: EmployeeTemplateInput = {
        name: name.trim(),
        fileKind,
        acceptedFileKinds: Array.from(new Set([fileKind, ...acceptedFileKinds])),
        delimiter: fileKind === "csv" ? delimiter : null,
        identifierPriority: order.map((f) => ({ fields: [f], caseInsensitive: true })),
        groups,
      };
      if (target !== null && target !== "new") await updateEmployeeTemplate(target.id, input);
      else await createEmployeeTemplate(input);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const title = readOnly ? "Template de colaboradores" : isEditing ? "Editar template de colaboradores" : "Novo template de colaboradores";
  const kinds = fileKind === "csv" ? ["CSV"] : Array.from(new Set([fileKind, ...acceptedFileKinds])).filter(Boolean).map((k) => k!.toUpperCase());

  return (
    <WizardDrawer
      open={target !== null}
      onClose={onClose}
      title={title}
      subtitle={name.trim() || (filePath ? fileNameFromPath(filePath) : "Sem nome")}
      steps={steps.map((s, i) => ({ key: s, label: STEP_LABEL_TEXT[s], summary: i <= stepIndex || isEditing ? stepSummary(s) : "—" }))}
      stepIndex={stepIndex}
      onStep={(i) => {
        setError(null);
        setStepIndex(i);
      }}
      error={error}
      bodyRef={bodyRef}
      onBack={() => {
        setError(null);
        setStepIndex((s) => s - 1);
      }}
      backDisabled={busy}
      next={
        stepIndex < steps.length - 1
          ? { label: "Continuar", arrow: true, onClick: handleAdvance, disabled: busy || loadingPreview || (currentStep === "file" && !filePath) }
          : { label: busy ? "Salvando..." : "Salvar template", onClick: handleSave, disabled: readOnly || busy, title: readOnly ? READ_ONLY_TITLE : undefined }
      }
    >
      {currentStep === "file" && (
        <SampleFileStep
          filePath={filePath}
          fileKind={fileKind}
          loading={loadingPreview}
          sheets={sheets}
          onPick={handlePickFile}
          onDrop={handleDrop}
          onReset={() => setFilePath(null)}
          onDownload={handleDownload}
        />
      )}

      {currentStep === "sheets" && (
        <SheetsStep sheets={sheets} included={includedSheets} onToggle={toggleSheet} onRemove={removeSheet} onAdd={addSheet} onRename={renameSheet} />
      )}

      {currentStep === "answers" && (
        <div className="tmap">
          <h2 className="tmap-title">Onde está cada informação?</h2>
          <p className="tmap-lead">
            {filePath
              ? "Já preenchemos pelo nome das colunas. Confira. Basta uma coluna que identifique a pessoa."
              : "Sem arquivo de exemplo: as colunas aparecem pela letra, com o nome que tinham quando o modelo foi salvo."}
          </p>

          {fileKind === "csv" && filePath && (
            <div className="tmap-q">
              <label>Separador</label>
              <OptionPicker
                single
                showTiles={false}
                align="left"
                options={DELIMITER_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
                selected={new Set([delimiter ?? ","])}
                onToggle={handleDelimiterChange}
                title="Separador das colunas"
                allPlaceholder="Escolha o separador"
                searchPlaceholder="Buscar"
              />
            </div>
          )}

          {similarIncluded.length > 0 && (
            <div className="tmap-ask">
              <p>
                {similarIncluded.map((cls, i) => (
                  <span key={cls[0]}>
                    {i > 0 && "; "}
                    As abas <b>{cls.join(", ")}</b>
                  </span>
                ))}{" "}
                têm as mesmas colunas. Usar as mesmas respostas?
              </p>
              <div className="tmap-opts">
                <button type="button" className="tmap-choice" aria-pressed={shareAnswers} onClick={() => applyShareAnswers(true)}>
                  Sim, responder uma vez
                </button>
                <button type="button" className="tmap-choice" aria-pressed={!shareAnswers} onClick={() => applyShareAnswers(false)}>
                  Não, responder cada uma
                </button>
              </div>
            </div>
          )}

          {includedGroupKeys.length > 1 && (
            <div className="tmap-tabs" role="group" aria-label="Abas">
              {includedGroupKeys.map((key) => (
                <button key={key} type="button" aria-pressed={key === tabKey} title={sharing(key).join(", ")} onClick={() => setAnswersTab(key)}>
                  {groupLabel(key)}
                  {!isGroupValid(key) && <span className="tmap-dot" aria-label="falta responder" />}
                </button>
              ))}
            </div>
          )}

          {tabKey && fileKind !== "csv" && sharing(tabKey).length > 1 && (
            <div className="tmap-share">
              <span className="tmap-share-head">Estas respostas valem para {sharing(tabKey).length} abas · tire uma com ×</span>
              <div className="tmap-chips">
                {sharing(tabKey).map((s) => (
                  <span key={s} className="tmap-chip">
                    {s}
                    <button type="button" onClick={() => splitFromTab(tabKey, s)} aria-label={`Responder ${s} separado`} title="Responder separado">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {tabKey && fileKind !== "csv" && includedGroupKeys.length > 1 && (
            <div className="tmap-q">
              <label>
                Juntar
                <small>com outra aba</small>
              </label>
              <OptionPicker
                single
                showTiles={false}
                align="left"
                options={includedGroupKeys.filter((k) => k !== tabKey).map((k) => ({ id: k, label: groupLabel(k) }))}
                selected={new Set()}
                onToggle={(id) => mergeGroupInto(tabKey, id)}
                title="Usar as mesmas respostas de"
                allPlaceholder="Usar as mesmas respostas de..."
                searchPlaceholder="Buscar aba"
              />
            </div>
          )}

          {tabKey && (
            <div className="tmap-qs" key={tabKey}>
              {QUESTIONS.map((q) => (
                <ColumnQuestion
                  key={q.field}
                  label={EMPLOYEE_TARGET_FIELD_LABELS[q.field]}
                  hint={q.hint}
                  optional
                  columns={columnsOfGroup(tabKey)}
                  mapping={groupMapping[tabKey] ?? {}}
                  fieldLabel={fieldLabel}
                  value={columnOf(groupMapping[tabKey] ?? {}, q.field)}
                  onChange={(col) => setAnswer(tabKey, q.field, col)}
                  example={(col) => exampleOf(tabKey, col)}
                />
              ))}
              <IgnoreQuestion
                columns={columnsOfGroup(tabKey)}
                mapping={groupMapping[tabKey] ?? {}}
                ignoredField={IGNORED_COLUMN_FIELD as ColumnAnswer}
                onToggle={(col) => toggleIgnored(tabKey, col)}
                onClear={() => clearIgnored(tabKey)}
              />
            </div>
          )}
        </div>
      )}

      {currentStep === "check" && (
        <div className="tmap">
          <h2 className="tmap-title">Confere?</h2>
          <p className="tmap-lead">{fileKind === "csv" ? "Lemos o arquivo com as suas respostas." : "Lemos cada aba com as respostas dela."}</p>
          <div className="tmap-big">
            <div className="ok">
              <b>{people}</b>
              <span>{people === 1 ? "colaborador" : "colaboradores"}</span>
            </div>
            {badChecks.length > 0 && (
              <div className="bad">
                <b>{badChecks.length}</b>
                <span>{badChecks.length === 1 ? "aba com problema" : "abas com problema"}</span>
              </div>
            )}
          </div>
          <div className="tmap-per">
            {checks.map((c) => {
              const problem = c.result?.problem ?? null;
              const opened = openCheck === c.sheet;
              return (
                <div key={c.sheet} className={`tmap-ps${problem ? " bad" : ""}`}>
                  <div className="tmap-ps-head">
                    <span className="tmap-ico" aria-hidden="true">
                      {problem ? "!" : c.result ? "✓" : "–"}
                    </span>
                    <b>{c.label}</b>
                    <span className="tmap-res">
                      {!c.result
                        ? "sem dados no arquivo de exemplo"
                        : problem
                          ? problem.text
                          : `${c.result.people} ${c.result.people === 1 ? "colaborador" : "colaboradores"}`}
                    </span>
                  </div>
                  {problem && c.result && (
                    <>
                      <div className="tmap-ps-act">
                        <button type="button" className="tmap-link" onClick={() => setOpenCheck(opened ? null : c.sheet)}>
                          {opened ? "esconder exemplos" : "ver exemplos"}
                        </button>
                        <button type="button" className="tmap-link" onClick={() => answerSeparately(c.sheet, c.shared)}>
                          {c.shared ? "responder esta aba separado" : "corrigir as respostas"}
                        </button>
                      </div>
                      {opened && (
                        <div className="tmap-samples">
                          {c.result.samples.map((r, i) => (
                            <div key={i} className="tmap-sample-row">
                              <span>{r.who}</span>
                              <span className={problem.field === "cpf" ? "off" : undefined}>CPF: “{r.cpf}”</span>
                              <span />
                            </div>
                          ))}
                          <p className="tmap-hint">
                            {problem.field === "colaborador"
                              ? "Nenhuma linha desta aba tem valor nas colunas de Nome, CPF ou Matrícula."
                              : "A coluna de CPF desta aba não tem CPFs (11 dígitos)."}{" "}
                            {c.shared ? "Responda esta aba separado para escolher outra coluna." : "Escolha outra coluna em Colunas."}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {currentStep === "details" && (
        <div className="tmap">
          <h2 className="tmap-title">Últimos detalhes</h2>
          <p className="tmap-lead">Dê um nome e diga como achar quem já está cadastrado.</p>

          <section className="tdet-section">
            <h3>Nome</h3>
            <input type="text" className="tdet-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Cadastro mensal — Cliente X" aria-label="Nome do template" />
          </section>

          <IdentifierOrderSection
            title="Como achar quem já está cadastrado?"
            order={order}
            onMove={(i, dir) => setIdentifierOrder(moveIdentifier(identifierOrder, order, i, dir))}
          />

          <details className="tdet-more">
            <summary>Mais opções · aceita {kinds.join(", ")}</summary>
            <div className="tdet-more-body">
              {fileKind !== "csv" ? (
                <div className="tmap-q">
                  <label>
                    Também aceitar
                    <small>mesmas colunas, outro formato</small>
                  </label>
                  <div className="tmap-opts">
                    {(["xlsx", "xls", "ods"] as PaymentFileKind[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        className="tmap-choice"
                        aria-pressed={k === fileKind || acceptedFileKinds.has(k)}
                        disabled={k === fileKind}
                        title={k === fileKind ? "O formato do arquivo usado para montar o template" : undefined}
                        onClick={() =>
                          setAcceptedFileKinds((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          })
                        }
                      >
                        {k.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="tdet-sub">Arquivo CSV: não pode ser combinado com planilhas.</p>
              )}
              <p className="tdet-sub">A linha com os nomes das colunas (e o que vem acima dela) é pulada na importação.</p>
            </div>
          </details>
        </div>
      )}
    </WizardDrawer>
  );
}
