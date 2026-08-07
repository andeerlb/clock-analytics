import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  FolderOpen,
  Info,
  ListOrdered,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Table2,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  addRecentPaymentFile,
  listRecentPaymentFiles,
  listSpreadsheetSheets,
  pickPaymentFile,
  previewSpreadsheet,
} from "../lib/api";
import { createEmployeeTemplate, updateEmployeeTemplate, type EmployeeTemplateInput } from "../lib/db";
import { columnLetter, fileNameFromPath } from "../lib/format";
import {
  EMPLOYEE_TARGET_FIELDS,
  EMPLOYEE_TARGET_FIELD_LABELS,
  REQUIRED_EMPLOYEE_FIELDS,
  type EmployeeTargetField,
  type EmployeeTemplateGroup,
  type EmployeeTemplateRow,
  type IdentifierAttempt,
  type IdentifierField,
  type PaymentFileKind,
} from "../lib/types";

const IDENTIFIER_FIELDS: IdentifierField[] = ["cpf", "matricula", "nome"];

/** Unlike payment templates' 3-tentativa default, an employee template starts with just CPF — matrícula/nome are opt-in per template instead of always pre-populated. */
const DEFAULT_EMPLOYEE_IDENTIFIER_PRIORITY: IdentifierAttempt[] = [{ fields: ["cpf"], caseInsensitive: true }];

/**
 * A file is only ever used transiently, to help build the mapping — it's
 * never persisted. Creating a template always starts from a real file, so
 * it always has all three steps; editing an already-saved template works
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

function fileKindFromPath(path: string): PaymentFileKind {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "ods") return "ods";
  if (ext === "xls") return "xls";
  return "xlsx";
}

export default function EmployeeTemplateWizard({
  target,
  onClose,
  onSaved,
}: {
  /** `null` keeps the wizard unmounted/closed; `"new"` starts a blank template; a row edits it. */
  target: EmployeeTemplateRow | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);

  // `filePath !== null` doubles as "a real file is backing this session" —
  // always true partway through creating a new template (the "Arquivo"
  // step requires one before you can advance), always false while editing
  // an existing one (there's no "Arquivo" step there at all, see
  // `WizardStep`), so it's a reliable switch between the live grid and the
  // abstract, file-less column editor in the "Mapeamento" step below.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<PaymentFileKind | null>(null);
  /** Every format an import accepts for this template, beyond `fileKind` itself (see "Formatos aceitos" in the Detalhes step) — xlsx/xls/ods can be freely combined, but never with csv. */
  const [acceptedFileKinds, setAcceptedFileKinds] = useState<Set<PaymentFileKind>>(new Set());
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [editingSheetName, setEditingSheetName] = useState<string | null>(null);
  const [editingSheetNameDraft, setEditingSheetNameDraft] = useState("");
  const [includedSheets, setIncludedSheets] = useState<Set<string>>(new Set());
  const [delimiter, setDelimiter] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);

  // Every sheet starts as its own standalone group (its own mapping);
  // `sheetGroupOf[sheet]` names which sheet's config it actually uses once
  // merged with another via the "estas abas usam o mesmo mapeamento de X"
  // checklist.
  const [sheetGroupOf, setSheetGroupOf] = useState<Record<string, string>>({});
  const [groupMapping, setGroupMapping] = useState<Record<string, Record<number, EmployeeTargetField>>>({});
  // Cosmetic header hint per mapped column — captured from the live grid
  // when a file is present, or carried straight over from the saved
  // template's `headerLabel` when editing without one. Never used for
  // matching, only to help a human recognize which column is which.
  const [groupFieldLabels, setGroupFieldLabels] = useState<Record<string, Record<number, string | null>>>({});
  // 1-indexed physical row where each group's header/title ends — rows up
  // to and including it are skipped at import time (see
  // ImportEmployeesPage.tsx). `null`/absent means no header row marked.
  const [groupHeaderRow, setGroupHeaderRow] = useState<Record<string, number | null>>({});
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
  const [identifierAttempts, setIdentifierAttempts] = useState<IdentifierAttempt[]>(
    DEFAULT_EMPLOYEE_IDENTIFIER_PRIORITY,
  );

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const isEditing = target !== null && target !== "new";
  const steps: WizardStep[] = isEditing ? ["mapping", "details"] : ["file", "mapping", "details"];
  const currentStep = steps[stepIndex];

  useEffect(() => {
    if (target === null) return;
    setStepIndex(0);
    setError(null);
    setBusy(false);

    if (target === "new") {
      setFilePath(null);
      setFileKind(null);
      setAcceptedFileKinds(new Set());
      setSheets([]);
      setActiveSheet(null);
      setEditingSheetName(null);
      setEditingSheetNameDraft("");
      setIncludedSheets(new Set());
      setDelimiter(null);
      setRows([]);
      setSheetGroupOf({});
      setGroupMapping({});
      setGroupFieldLabels({});
      setGroupHeaderRow({});
      setExtraColumns(0);
      setName("");
      setIdentifierAttempts(DEFAULT_EMPLOYEE_IDENTIFIER_PRIORITY.map((a) => ({ ...a, fields: [...a.fields] })));
      return;
    }

    setFilePath(null);
    setFileKind(target.fileKind);
    setAcceptedFileKinds(new Set(target.acceptedFileKinds));
    setDelimiter(target.delimiter);
    setName(target.name);
    setIdentifierAttempts(target.identifierPriority.map((a) => ({ ...a, fields: [...a.fields] })));
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

  useEffect(() => {
    if (!target) return;
    listRecentPaymentFiles().then(setRecentFiles);
  }, [target]);

  // OS-level drag-and-drop for the Arquivo step — Tauri intercepts this at
  // the whole-webview level (not a DOM dragover/drop target), so it's only
  // acted on while the wizard is open and actually on that step.
  useEffect(() => {
    if (!target || currentStep !== "file") return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          setDragOver(false);
          const path = event.payload.paths[0];
          if (!path) return;
          const ext = path.split(".").pop()?.toLowerCase();
          if (!ext || !["csv", "xlsx", "xls", "ods"].includes(ext)) {
            setError("Formato de arquivo não suportado. Use CSV, XLSX, XLS ou ODS.");
            return;
          }
          selectFile(path);
        } else if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else {
          setDragOver(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [target, currentStep]);

  /** Which group a sheet's mapping should be read from — csv always has exactly one, implicit group. */
  function groupKeyOf(sheetName: string | null): string {
    if (fileKind === "csv" || sheetName === null) return CSV_GROUP_KEY;
    return sheetGroupOf[sheetName] ?? sheetName;
  }

  /** Rebuilds the wizard's grouping/mapping state straight from a saved template — no file, no I/O. */
  function hydrateFromTemplate(t: EmployeeTemplateRow) {
    const newSheetGroupOf: Record<string, string> = {};
    const newGroupMapping: Record<string, Record<number, EmployeeTargetField>> = {};
    const newGroupFieldLabels: Record<string, Record<number, string | null>> = {};
    const newGroupHeaderRow: Record<string, number | null> = {};
    const sheetNames: string[] = [];

    for (const group of t.groups) {
      const repKey = group.sheetNames[0] ?? group.excludedSheetNames[0] ?? CSV_GROUP_KEY;
      const m: Record<number, EmployeeTargetField> = {};
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
      newGroupHeaderRow[repKey] = group.headerRow;
      for (const s of group.sheetNames) {
        newSheetGroupOf[s] = repKey;
        sheetNames.push(s);
      }
      for (const s of group.excludedSheetNames) {
        newSheetGroupOf[s] = s;
        sheetNames.push(s);
      }
    }

    setSheets(sheetNames);
    setSheetGroupOf(newSheetGroupOf);
    setGroupMapping(newGroupMapping);
    setGroupFieldLabels(newGroupFieldLabels);
    setGroupHeaderRow(newGroupHeaderRow);
    setIncludedSheets(new Set(t.groups.flatMap((g) => g.sheetNames)));
    setActiveSheet(sheetNames[0] ?? null);
    setEditingSheetName(null);
    setEditingSheetNameDraft("");
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
      setEditingSheetName(null);
      setEditingSheetNameDraft("");
      // Everything starts included — flagging the few sheets that don't
      // belong is less work than hand-picking every roster sheet in a
      // large workbook.
      setIncludedSheets(new Set(sheetNames));
      setSheetGroupOf({});
      setGroupMapping({});
      setGroupFieldLabels({});
      setGroupHeaderRow({});
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

  /** Common path for picking via dialog, dropping, or clicking a recent file — always the same load + recent-list bookkeeping. */
  async function selectFile(path: string) {
    setError(null);
    setFilePath(path);
    const kind = fileKindFromPath(path);
    setFileKind(kind);
    setAcceptedFileKinds(new Set([kind]));
    await loadFile(path);
    addRecentPaymentFile(path)
      .then(() => listRecentPaymentFiles())
      .then(setRecentFiles)
      .catch(() => {});
  }

  async function handlePickFile() {
    const path = await pickPaymentFile();
    if (!path) return;
    await selectFile(path);
  }

  // Just switches which sheet's config is being looked at — the mapping is
  // derived from whichever group that sheet belongs to, so revisiting an
  // already-configured sheet shows its real config instead of resetting
  // it.
  function handleSheetClick(sheetName: string) {
    if (sheetName === activeSheet) return;
    setEditingSheetName(null);
    setEditingSheetNameDraft("");
    setActiveSheet(sheetName);
    setExtraColumns(0);
    setFocusedColumn(null);
    refetchRows(sheetName, delimiter);
  }

  function startEditingSheetName(sheetName: string) {
    setEditingSheetName(sheetName);
    setEditingSheetNameDraft(sheetName);
    setActiveSheet(sheetName);
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

  function renameSheet(oldName: string, rawNewName: string) {
    const newName = rawNewName.trim();
    if (!newName || newName === oldName) {
      setEditingSheetName(null);
      setEditingSheetNameDraft("");
      return;
    }
    if (sheets.includes(newName)) {
      setError(`Já existe uma aba chamada "${newName}".`);
      setEditingSheetName(oldName);
      setEditingSheetNameDraft(oldName);
      return;
    }

    setError(null);
    setSheets((prev) => prev.map((sheet) => (sheet === oldName ? newName : sheet)));
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(oldName)) {
        next.delete(oldName);
        next.add(newName);
      }
      return next;
    });
    setSheetGroupOf((prev) => {
      const next: Record<string, string> = {};
      for (const [sheet, groupKey] of Object.entries(prev)) {
        const renamedSheet = sheet === oldName ? newName : sheet;
        const renamedGroupKey = groupKey === oldName ? newName : groupKey;
        next[renamedSheet] = renamedGroupKey;
      }
      if (!prev[oldName]) next[newName] = newName;
      return next;
    });
    setGroupMapping((prev) => {
      if (!(oldName in prev)) return prev;
      const next = { ...prev };
      if (newName !== oldName) {
        next[newName] = next[oldName] ?? {};
        delete next[oldName];
      }
      return next;
    });
    setGroupFieldLabels((prev) => {
      if (!(oldName in prev)) return prev;
      const next = { ...prev };
      if (newName !== oldName) {
        next[newName] = next[oldName] ?? {};
        delete next[oldName];
      }
      return next;
    });
    setGroupHeaderRow((prev) => {
      if (!(oldName in prev)) return prev;
      const next = { ...prev };
      if (newName !== oldName) {
        next[newName] = next[oldName] ?? null;
        delete next[oldName];
      }
      return next;
    });
    if (activeSheet === oldName) {
      setActiveSheet(newName);
    }
    setEditingSheetName(null);
    setEditingSheetNameDraft("");
  }

  function addNewSheet() {
    const baseName = "Nova aba";
    let suffix = 1;
    let sheetName = baseName;
    while (sheets.includes(sheetName)) {
      suffix += 1;
      sheetName = `${baseName} ${suffix}`;
    }
    setSheets((prev) => [...prev, sheetName]);
    setSheetGroupOf((prev) => ({ ...prev, [sheetName]: sheetName }));
    setGroupMapping((prev) => ({ ...prev, [sheetName]: {} }));
    setGroupFieldLabels((prev) => ({ ...prev, [sheetName]: {} }));
    setGroupHeaderRow((prev) => ({ ...prev, [sheetName]: null }));
    setIncludedSheets((prev) => new Set(prev).add(sheetName));
    setActiveSheet(sheetName);
    setEditingSheetName(null);
    setEditingSheetNameDraft("");
    setExtraColumns(0);
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
    setGroupHeaderRow((prev) => ({ ...prev, [activeSheet]: prev[sourceKey] ?? null }));
  }

  function handleDelimiterChange(newDelimiter: string) {
    setDelimiter(newDelimiter);
    // Column boundaries just shifted, so whatever mapping was set for the
    // csv's one implicit group no longer means anything.
    setGroupMapping((prev) => ({ ...prev, [CSV_GROUP_KEY]: {} }));
    setGroupFieldLabels((prev) => ({ ...prev, [CSV_GROUP_KEY]: {} }));
    refetchRows(activeSheet, newDelimiter);
  }

  function setColumnMapping(colIndex: number, field: EmployeeTargetField | "", headerLabel?: string | null) {
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

  /** Marks (or clears) which physical row is the active group's last header/title row — forks off a mirrored mapping first, same as `setColumnMapping`, since this is also a per-group edit. */
  function setHeaderRow(value: number | null) {
    const sourceKey = groupKeyOf(activeSheet);
    const isMirroring = activeSheet !== null && fileKind !== "csv" && sourceKey !== activeSheet;
    const targetKey = isMirroring ? activeSheet : sourceKey;

    if (isMirroring) {
      setSheetGroupOf((prev) => ({ ...prev, [activeSheet]: activeSheet }));
      setGroupMapping((prev) => ({ ...prev, [activeSheet]: { ...(prev[sourceKey] ?? {}) } }));
      setGroupFieldLabels((prev) => ({ ...prev, [activeSheet]: { ...(prev[sourceKey] ?? {}) } }));
    }

    setGroupHeaderRow((prev) => ({ ...prev, [targetKey]: value }));
  }

  function isGroupMappingValid(key: string): boolean {
    const fields = new Set(Object.values(groupMapping[key] ?? {}));
    return REQUIRED_EMPLOYEE_FIELDS.every((f) => fields.has(f));
  }

  function addIdentifierAttempt() {
    setIdentifierAttempts((prev) => [...prev, { fields: [], caseInsensitive: true }]);
  }

  function removeIdentifierAttempt(index: number) {
    setIdentifierAttempts((prev) => prev.filter((_, i) => i !== index));
  }

  /** `fileKind` itself is never toggled off here — the checkbox for it is disabled-checked in the UI, this only ever runs for the other xlsx/xls/ods kinds. */
  function toggleAcceptedFileKind(kind: PaymentFileKind) {
    setAcceptedFileKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function toggleIdentifierField(index: number, field: IdentifierField) {
    setIdentifierAttempts((prev) =>
      prev.map((attempt, i) =>
        i === index
          ? {
              ...attempt,
              fields: attempt.fields.includes(field)
                ? attempt.fields.filter((f) => f !== field)
                : [...attempt.fields, field],
            }
          : attempt,
      ),
    );
  }

  function toggleIdentifierCaseInsensitive(index: number) {
    setIdentifierAttempts((prev) =>
      prev.map((attempt, i) => (i === index ? { ...attempt, caseInsensitive: !attempt.caseInsensitive } : attempt)),
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

  const isIdentifierPriorityValid =
    identifierAttempts.length > 0 && identifierAttempts.every((a) => a.fields.length > 0);

  const activeGroupKey = groupKeyOf(activeSheet);
  const mapping = groupMapping[activeGroupKey] ?? {};
  const activeHeaderRow = groupHeaderRow[activeGroupKey] ?? null;

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

  const allGroupKeys =
    fileKind === "csv" ? [CSV_GROUP_KEY] : Array.from(new Set(sheets.map((s) => groupKeyOf(s))));

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
        setError(`"${invalidKey}": mapeie CPF e Nome antes de avançar.`);
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

      const groups: EmployeeTemplateGroup[] = allGroupKeys.map((key) => {
        const sheetNames = fileKind === "csv" ? [] : sheets.filter((s) => includedSheets.has(s) && groupKeyOf(s) === key);
        const excludedSheetNames = fileKind === "csv" ? [] : sheets.filter((s) => !includedSheets.has(s) && groupKeyOf(s) === key);
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
        return { sheetNames, excludedSheetNames, fieldMappings, headerRow: groupHeaderRow[key] ?? null };
      });

      const input: EmployeeTemplateInput = {
        name: name.trim(),
        fileKind,
        acceptedFileKinds: Array.from(new Set([fileKind, ...acceptedFileKinds])),
        delimiter: fileKind === "csv" ? delimiter : null,
        identifierPriority: identifierAttempts,
        groups,
      };

      if (editing) {
        await updateEmployeeTemplate(editing.id, input);
      } else {
        await createEmployeeTemplate(input);
      }

      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

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
          {isEditing ? "Editar template de colaboradores" : "Novo template de colaboradores"}
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
        style={{ flex: 1, overflow: "auto", padding: "1.5rem", background: "var(--bg)", display: "flex", flexDirection: "column", minHeight: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {error && <div className="error-box" style={{ marginBottom: "1rem" }}>{error}</div>}

        {currentStep === "file" && (
          <div className="details-layout">
            <div className="details-main">
              <div>
                <h2 className="file-step-title">Importar arquivo fonte</h2>
                <p className="glass-panel-desc" style={{ marginBottom: 0 }}>
                  Selecione um arquivo para servir de base para o mapeamento deste template.
                </p>
              </div>

              {filePath && (
                <div className="glass-panel file-status-card">
                  <div className="file-status-icon">
                    <CheckCircle2 size={26} />
                  </div>
                  <div className="file-status-info">
                    <p className="file-status-label">Arquivo carregado</p>
                    <div className="file-status-name">
                      <Table2 size={16} />
                      {fileNameFromPath(filePath)}
                    </div>
                  </div>
                  <button type="button" className="glow-button" onClick={handlePickFile}>
                    <RefreshCw size={14} />
                    Trocar arquivo
                  </button>
                </div>
              )}

              <div
                className={`file-dropzone${dragOver ? " drag-over" : ""}`}
                onClick={handlePickFile}
                role="button"
                tabIndex={0}
              >
                <div className="file-dropzone-icon">
                  <UploadCloud size={28} />
                </div>
                <h3>Arraste e solte um arquivo aqui</h3>
                <p className="glass-panel-desc">
                  Ou clique para navegar. O arquivo será usado só para montar o mapeamento agora —
                  não é guardado; depois de salvo, o template só armazena a configuração de
                  colunas.
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePickFile();
                  }}
                >
                  <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                  Selecionar arquivo
                </button>
              </div>
            </div>

            <aside className="details-sidebar">
              <div className="glass-panel">
                <h4 className="glass-panel-heading">
                  <Info size={16} />
                  Guia de preparação
                </h4>
                <p className="glass-panel-desc">Formatos suportados:</p>
                <div className="file-format-pills">
                  {["CSV", "XLSX", "XLS", "ODS"].map((f) => (
                    <span key={f} className="file-format-pill">
                      .{f}
                    </span>
                  ))}
                </div>
              </div>

              {recentFiles.length > 0 && (
                <div className="glass-panel">
                  <h4 className="glass-panel-heading" style={{ fontSize: "0.85rem" }}>
                    Arquivos recentes
                  </h4>
                  <div className="recent-files-list">
                    {recentFiles.map((p) => (
                      <button key={p} type="button" className="recent-file-item" onClick={() => selectFile(p)}>
                        <FileText size={16} />
                        <span className="recent-file-name">{fileNameFromPath(p)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}

        {currentStep === "mapping" && (
          <div style={{ display: "flex", gap: "1.2rem", alignItems: "stretch", minHeight: 0, flex: 1 }}>
            {sheets.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", flex: "0 0 256px", minHeight: 0, alignSelf: "stretch" }}>
                <aside className="mapping-sidebar">
                  <div className="mapping-sidebar-header">
                    <strong>{sheets.length === 1 ? "Aba do arquivo" : "Mapeamento por aba"}</strong>
                    <p className="muted">
                      {sheets.length === 1 ? "Aba carregada neste template" : "Selecione a aba para configurar"}
                    </p>
                  </div>
                  <nav className="mapping-sidebar-nav">
                    {sheets.map((s) => {
                      const included = includedSheets.has(s);
                      const groupKey = groupKeyOf(s);
                      const mirroring = groupKey !== s ? groupKey : null;
                      const isEditing = editingSheetName === s;
                      return (
                        <button
                          key={s}
                          type="button"
                          className={`mapping-sidebar-item${s === activeSheet ? " active" : ""}${included ? "" : " excluded"}`}
                          onClick={() => handleSheetClick(s)}
                          onDoubleClick={() => startEditingSheetName(s)}
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
                            {isEditing ? (
                              <input
                                autoFocus
                                type="text"
                                value={editingSheetNameDraft}
                                onChange={(e) => setEditingSheetNameDraft(e.target.value)}
                                onBlur={() => renameSheet(s, editingSheetNameDraft)}
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    renameSheet(s, editingSheetNameDraft);
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    setEditingSheetName(null);
                                    setEditingSheetNameDraft("");
                                  }
                                }}
                                style={{ width: "100%" }}
                              />
                            ) : (
                              s
                            )}
                            {mirroring && <span className="mapping-sidebar-mirroring"> → {mirroring}</span>}
                          </span>
                          {included && !isGroupMappingValid(groupKey) && (
                            <span className="mapping-sidebar-warn" title="Faltam mapear CPF e/ou Nome">
                              •
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </nav>
                </aside>

                <div style={{ display: "flex", justifyContent: "center", marginTop: "0.6rem" }}>
                  <button type="button" className="ghost" onClick={addNewSheet}>
                    <Plus size={12} style={{ marginRight: "0.25rem" }} />
                    Adicionar aba
                  </button>
                </div>
              </div>
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
                <>
                  <div className="field" style={{ maxWidth: "22rem", marginBottom: "0.9rem" }}>
                    <label htmlFor="header-row">Linha do cabeçalho</label>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <input
                        id="header-row"
                        type="number"
                        min={1}
                        value={activeHeaderRow ?? ""}
                        onChange={(e) => setHeaderRow(e.target.value ? Math.max(1, Number(e.target.value)) : null)}
                        placeholder="Nenhuma"
                        style={{ width: "6rem" }}
                      />
                      {activeHeaderRow !== null && (
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => setHeaderRow(null)}
                          aria-label="Remover marcação de cabeçalho"
                          title="Remover marcação de cabeçalho"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <p className="field-hint">
                      Sem um arquivo de exemplo carregado não é possível clicar na linha — informe o
                      número diretamente. Linhas até esta (inclusive) são ignoradas ao importar.
                    </p>
                  </div>
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
                                onChange={(e) => setColumnMapping(c, e.target.value as EmployeeTargetField | "")}
                              >
                                <option value="">Ignorar</option>
                                {EMPLOYEE_TARGET_FIELDS.map((f) => (
                                  <option key={f} value={f}>
                                    {EMPLOYEE_TARGET_FIELD_LABELS[f]}
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
                </>
              ) : (
                <>
                  <p className="field-hint" style={{ marginBottom: "0.9rem" }}>
                    {activeHeaderRow !== null ? (
                      <>
                        Cabeçalho até a linha {activeHeaderRow} — linhas até ela são ignoradas ao
                        importar.{" "}
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0 0.3rem" }}
                          onClick={() => setHeaderRow(null)}
                        >
                          Remover marcação
                        </button>
                      </>
                    ) : (
                      "Clique no número de uma linha na tabela abaixo para marcar onde o cabeçalho termina."
                    )}
                  </p>
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
                                        e.target.value as EmployeeTargetField | "",
                                        firstRowHint[c] ?? null,
                                      )
                                    }
                                  >
                                    <option value="">Ignorar</option>
                                    {EMPLOYEE_TARGET_FIELDS.map((f) => (
                                      <option key={f} value={f}>
                                        {EMPLOYEE_TARGET_FIELD_LABELS[f]}
                                      </option>
                                    ))}
                                  </select>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {sampleRows.map((row, i) => {
                            const rowNumber = i + 1;
                            const isHeaderRow = rowNumber === activeHeaderRow;
                            const isBeforeHeader = activeHeaderRow !== null && rowNumber <= activeHeaderRow;
                            return (
                              <tr key={i} className={isBeforeHeader ? "row-header-skip" : undefined}>
                                <td
                                  className={`row-gutter row-gutter-clickable${isHeaderRow ? " row-gutter-active" : ""}`}
                                  onClick={() => setHeaderRow(isHeaderRow ? null : rowNumber)}
                                  title={
                                    isHeaderRow
                                      ? "Linha marcada como cabeçalho — clique para desmarcar"
                                      : "Clique para marcar esta linha como cabeçalho"
                                  }
                                >
                                  {rowNumber}
                                </td>
                                {columns.map((c) => (
                                  <td key={c} className={c === focusedColumn ? "col-focused" : undefined}>
                                    {row[c] ?? ""}
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
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
                    placeholder="Ex.: Colaboradores — Cliente X"
                  />
                </div>
                <div className="field-code">
                  <label>Formatos aceitos</label>
                  {fileKind === "csv" ? (
                    <p className="glass-panel-desc" style={{ margin: 0 }}>
                      CSV — um arquivo de texto delimitado não pode ser combinado com planilhas.
                    </p>
                  ) : (
                    <>
                      <p className="glass-panel-desc" style={{ margin: "0 0 0.4rem" }}>
                        Este template foi montado com um arquivo {fileKind?.toUpperCase()}. Um arquivo Excel
                        (XLSX/XLS) ou ODS com as mesmas colunas é lido exatamente do mesmo jeito — marque
                        abaixo se, além de {fileKind?.toUpperCase()}, este template também deve aceitar
                        algum dos outros na hora de importar.
                      </p>
                      {(["xlsx", "xls", "ods"] as PaymentFileKind[]).map((k) => (
                        <label key={k} className="field-code-checkbox">
                          <input
                            type="checkbox"
                            checked={k === fileKind || acceptedFileKinds.has(k)}
                            disabled={k === fileKind}
                            onChange={() => toggleAcceptedFileKind(k)}
                          />
                          {k.toUpperCase()}
                        </label>
                      ))}
                    </>
                  )}
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
                  colaborador — tentadas em ordem, a primeira que encontrar um colaborador já
                  cadastrado vence. Pelo menos uma tentativa é obrigatória.
                </p>

                {identifierAttempts.map((attempt, i) => (
                  <div key={i} className="chain-row">
                    {i > 0 && <div className="chain-connector" />}
                    <div className="logic-card identifier-attempt">
                      <div className={`chain-num${i === 0 ? " first" : ""}`}>{i + 1}</div>
                      <div className="identifier-attempt-fields">
                        {IDENTIFIER_FIELDS.map((f) => (
                          <label
                            key={f}
                            className={`identifier-field-pill${attempt.fields.includes(f) ? " checked" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={attempt.fields.includes(f)}
                              onChange={() => toggleIdentifierField(i, f)}
                            />
                            {EMPLOYEE_TARGET_FIELD_LABELS[f]}
                          </label>
                        ))}
                        <label className="field-code-checkbox">
                          <input
                            type="checkbox"
                            checked={attempt.caseInsensitive}
                            onChange={() => toggleIdentifierCaseInsensitive(i)}
                          />
                          Ignorar maiúsculas/minúsculas
                        </label>
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
            disabled={busy || !name.trim() || !isIdentifierPriorityValid}
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
