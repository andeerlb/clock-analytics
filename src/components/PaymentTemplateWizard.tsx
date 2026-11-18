import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Info,
  Link2,
  RefreshCw,
  Table2,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { READ_ONLY_TITLE, useReadOnly } from "./AreaRoute";
import Modal, { useModalClose } from "./Modal";
import OptionPicker, { type PickerOption } from "./OptionPicker";
import PaymentTemplateDetails, {
  detailsProblem,
  effectiveIdentifierOrder,
  identifierOrderFromSaved,
  routesFromSaved,
  statusFromSaved,
  type Destination,
  type RouteDraft,
  type RuleTest,
  type StatusDraft,
} from "./PaymentTemplateDetails";

/** Header X, routed through `useModalClose` instead of the raw `onClose` prop so it plays the same animated exit `Modal` already uses for Escape/backdrop. */
function CloseButton() {
  const requestClose = useModalClose();
  return (
    <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={requestClose} aria-label="Fechar">
      <X size={18} />
    </button>
  );
}
import {
  addRecentPaymentFile,
  downloadPaymentFileFromUrl,
  listRecentPaymentFiles,
  listSpreadsheetSheets,
  pickPaymentFile,
  previewSpreadsheet,
} from "../lib/api";
import {
  createPaymentTemplate,
  listClients,
  listCompanies,
  listDistinctPaymentShiftLocals,
  listRolesGlobal,
  updatePaymentTemplate,
  type ClientRow,
  type CompanyRow,
  type PaymentTemplateInput,
  type PaymentTemplateRuleInput,
  type PaymentTemplateStatusRuleInput,
} from "../lib/db";
import { uploadDropped } from "../lib/files";
import { columnLetter, fileNameFromPath } from "../lib/format";
import {
  checkSheet,
  dataRowsOf,
  detectDateFormat,
  guessMapping,
  headerSignature,
  headersOf,
  looksLikeShiftSheet,
} from "../lib/templateMapping";
import {
  DEFAULT_IDENTIFIER_PRIORITY,
  IDENTIFIER_FIELD_PRECEDENCE,
  PAYMENT_TARGET_FIELD_LABELS,
  REQUIRED_PAYMENT_FIELDS,
  SHEET_NAME_RULE_FIELD,
  type IdentifierField,
  type PaymentFileKind,
  type PaymentRuleField,
  type PaymentShiftStatus,
  type PaymentTargetField,
  type PaymentTemplateGroup,
  type PaymentTemplateRow,
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
type WizardStep = "file" | "sheets" | "answers" | "check" | "details";
const STEP_LABEL_TEXT: Record<WizardStep, string> = {
  file: "Arquivo",
  sheets: "Abas",
  answers: "Colunas",
  check: "Conferir",
  details: "Detalhes",
};

/** "Onde está cada informação?" — Colaborador stands for whichever identifier columns (nome/CPF/matrícula) are answered. */
const QUESTIONS: { field: PaymentTargetField | "colaborador"; label: string; hint?: string; optional?: boolean }[] = [
  { field: "colaborador", label: "Colaborador", hint: "nome, CPF ou matrícula" },
  { field: "data", label: "Data" },
  { field: "local", label: "Local" },
  { field: "funcao", label: "Função" },
  { field: "horario", label: "Horário" },
  { field: "status", label: "Status", hint: "opcional", optional: true },
];

/** How many rows of each sheet are read to prefill and check the answers. */
const PREVIEW_ROWS = 500;

/** Stand-in group key for csv, which has no sheets to key groups off of — there's always exactly one implicit group. */
const CSV_GROUP_KEY = "__csv__";

/** What the Arquivo step accepts, by extension (same list the desktop drop handler checked). */
const PAYMENT_FILE_EXTENSIONS = ["csv", "xlsx", "xls", "ods"];

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
  /** Every format an import accepts for this template, beyond `fileKind` itself (see "Formatos aceitos" in the Detalhes step) — xlsx/xls/ods can be freely combined, but never with csv. */
  const [acceptedFileKinds, setAcceptedFileKinds] = useState<Set<PaymentFileKind>>(new Set());
  const [sheets, setSheets] = useState<string[]>([]);
  const [editingSheetName, setEditingSheetName] = useState<string | null>(null);
  const [editingSheetNameDraft, setEditingSheetNameDraft] = useState("");
  const [includedSheets, setIncludedSheets] = useState<Set<string>>(new Set());
  const [delimiter, setDelimiter] = useState<string | null>(null);
  /** The sample file's rows per sheet (csv: under `CSV_GROUP_KEY`) — what prefills and checks the answers. Empty while editing a saved template. */
  const [sheetRows, setSheetRows] = useState<Record<string, string[][]>>({});

  // Sheets answering together form a group: `sheetGroupOf[sheet]` names the
  // sheet whose answers it uses (itself when it answers alone). Sheets with
  // identical column names start together only because "Usar as mesmas
  // respostas?" defaults to yes, and the Conferir step reads every sheet on
  // its own rows, so a shared answer that doesn't fit one of them shows up
  // there. No header-row concept on import: a row is a shift when its
  // "data" column parses as a date.
  const [sheetGroupOf, setSheetGroupOf] = useState<Record<string, string>>({});
  const [groupMapping, setGroupMapping] = useState<Record<string, Record<number, PaymentTargetField>>>({});
  // Cosmetic header hint per mapped column — captured from the file's
  // header row, or carried over from the saved template's `headerLabel`
  // when editing without one. Never used for matching.
  const [groupFieldLabels, setGroupFieldLabels] = useState<Record<string, Record<number, string | null>>>({});
  /** The answer to "Usar as mesmas respostas?" for sheets with identical columns. */
  const [shareAnswers, setShareAnswers] = useState(true);
  /** Sheets taken out of their shared group ("responder esta aba separado") — sharing again leaves them alone. */
  const [separatedSheets, setSeparatedSheets] = useState<Set<string>>(new Set());
  /** Which group's answers the Colunas step shows. */
  const [answersTab, setAnswersTab] = useState<string | null>(null);
  /** Extra identifier questions revealed with "Também identificar por", per group (`${group}:${field}`). */
  const [revealedIdentifiers, setRevealedIdentifiers] = useState<Set<string>>(new Set());
  /** The Conferir step's sheet whose sample rows are open. */
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [routes, setRoutes] = useState<RouteDraft[]>([]);
  const [routeFallback, setRouteFallback] = useState<Destination>({ companyId: null, clientId: null });
  const [statusDrafts, setStatusDrafts] = useState<StatusDraft[]>([]);
  const [statusFallback, setStatusFallback] = useState<PaymentShiftStatus>("pendente");
  const [identifierOrder, setIdentifierOrder] = useState<IdentifierField[]>(identifierOrderFromSaved(DEFAULT_IDENTIFIER_PRIORITY));
  /** Known Funções/Locais from the database, offered in the rule pickers. */
  const [knownRoles, setKnownRoles] = useState<string[]>([]);
  const [knownLocals, setKnownLocals] = useState<string[]>([]);

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlDownloading, setUrlDownloading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const isEditing = target !== null && target !== "new";
  const readOnly = useReadOnly();
  // csv has no sheets to pick; a saved template has no sample rows to check.
  const steps: WizardStep[] = [
    ...(isEditing ? [] : ["file" as const]),
    ...(fileKind === "csv" ? [] : ["sheets" as const]),
    "answers",
    ...(isEditing ? [] : ["check" as const]),
    "details",
  ];
  const currentStep = steps[stepIndex];

  useEffect(() => {
    listCompanies().then(setCompanies);
    listClients().then(setClientsAll);
    listRolesGlobal()
      .then((roles) => setKnownRoles(Array.from(new Set(roles.map((r) => r.name)))))
      .catch(() => {});
    listDistinctPaymentShiftLocals().then(setKnownLocals).catch(() => {});
  }, []);

  useEffect(() => {
    if (target === null) return;
    setStepIndex(0);
    setError(null);
    setBusy(false);

    if (target === "new") {
      setFilePath(null);
      setFileKind(null);
      setAcceptedFileKinds(new Set());
      setDelimiter(null);
      resetMappingState([]);
      setName("");
      setDateFormat("DD/MM/YYYY");
      setRoutes([]);
      setRouteFallback({ companyId: null, clientId: null });
      setStatusDrafts([]);
      setStatusFallback("pendente");
      setIdentifierOrder(identifierOrderFromSaved(DEFAULT_IDENTIFIER_PRIORITY));
      return;
    }

    setFilePath(null);
    setFileKind(target.fileKind);
    setAcceptedFileKinds(new Set(target.acceptedFileKinds));
    setDelimiter(target.delimiter);
    setName(target.name);
    setDateFormat(target.dateFormat);
    const savedRoutes = routesFromSaved(target.rules);
    setRoutes(savedRoutes.routes);
    setRouteFallback(savedRoutes.fallback);
    const savedStatus = statusFromSaved(target.statusRules);
    setStatusDrafts(savedStatus.rules);
    setStatusFallback(savedStatus.fallback);
    setIdentifierOrder(identifierOrderFromSaved(target.identifierPriority));
    hydrateFromTemplate(target);
  }, [target]);


  useEffect(() => {
    if (!target) return;
    listRecentPaymentFiles().then(setRecentFiles);
  }, [target]);

  /** Drag-and-drop on the Arquivo step's dropzone: the dropped file is uploaded, then handled like a picked one. */
  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ext || !PAYMENT_FILE_EXTENSIONS.includes(ext)) {
      setError("Formato de arquivo não suportado. Use CSV, XLSX, XLS ou ODS.");
      return;
    }
    try {
      const [path] = await uploadDropped(event.dataTransfer, PAYMENT_FILE_EXTENSIONS);
      if (path) selectFile(path);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

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
      const repKey = group.sheetNames[0] ?? group.excludedSheetNames[0] ?? CSV_GROUP_KEY;
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
      for (const s of group.excludedSheetNames) {
        newSheetGroupOf[s] = s;
        sheetNames.push(s);
      }
    }

    resetMappingState(sheetNames);
    setSheetGroupOf(newSheetGroupOf);
    setGroupMapping(newGroupMapping);
    setGroupFieldLabels(newGroupFieldLabels);
    setIncludedSheets(new Set(t.groups.flatMap((g) => g.sheetNames)));
  }

  /** Clears everything the Abas/Colunas/Conferir steps hold, keeping `sheetNames` as the list of sheets. */
  function resetMappingState(sheetNames: string[]) {
    setSheets(sheetNames);
    setEditingSheetName(null);
    setEditingSheetNameDraft("");
    setIncludedSheets(new Set());
    setSheetRows({});
    setSheetGroupOf({});
    setGroupMapping({});
    setGroupFieldLabels({});
    setShareAnswers(true);
    setSeparatedSheets(new Set());
    setAnswersTab(null);
    setRevealedIdentifiers(new Set());
    setOpenCheck(null);
  }

  /**
   * Fresh answers for a just-loaded file: every sheet prefilled from its
   * own column names, sheets with identical column names answering
   * together (the "Usar as mesmas respostas?" default), and sheets that
   * don't look like shifts at all left unchecked.
   */
  function prefillFromRows(sheetNames: string[], rowsBySheet: Record<string, string[][]>) {
    const keys = sheetNames.length > 0 ? sheetNames : [CSV_GROUP_KEY];
    const nextGroupOf: Record<string, string> = {};
    const nextMapping: Record<string, Record<number, PaymentTargetField>> = {};
    const nextLabels: Record<string, Record<number, string | null>> = {};
    const anchorBySignature = new Map<string, string>();
    for (const key of keys) {
      const rows = rowsBySheet[key] ?? [];
      const signature = sheetNames.length > 0 ? headerSignature(rows) : null;
      const anchor = signature ? anchorBySignature.get(signature) : undefined;
      if (anchor) {
        nextGroupOf[key] = anchor;
        continue;
      }
      if (signature) anchorBySignature.set(signature, key);
      nextGroupOf[key] = key;
      const mapping = guessMapping(rows);
      const headers = headersOf(rows);
      nextMapping[key] = mapping;
      nextLabels[key] = Object.fromEntries(Object.keys(mapping).map((i) => [Number(i), headers[Number(i)] || null]));
    }
    setSheetGroupOf(sheetNames.length > 0 ? nextGroupOf : {});
    setGroupMapping(nextMapping);
    setGroupFieldLabels(nextLabels);
    setIncludedSheets(new Set(sheetNames.filter((s) => looksLikeShiftSheet(rowsBySheet[s] ?? []))));
  }

  async function loadFile(path: string) {
    setLoadingPreview(true);
    setError(null);
    try {
      const sheetNames = await listSpreadsheetSheets(path);
      resetMappingState(sheetNames);
      const keys = sheetNames.length > 0 ? sheetNames : [CSV_GROUP_KEY];
      const previews = await Promise.all(
        keys.map((k) => previewSpreadsheet(path, k === CSV_GROUP_KEY ? null : k, null, PREVIEW_ROWS)),
      );
      const rowsBySheet = Object.fromEntries(keys.map((k, i) => [k, previews[i].rows]));
      setSheetRows(rowsBySheet);
      setDelimiter(previews[0]?.delimiter ?? null);
      prefillFromRows(sheetNames, rowsBySheet);
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

  /** "Baixar por URL" in the Arquivo step — same direct-download-link download `Importar Pagamentos`'s URL tab uses, just to get a sample file for the mapping instead of an actual import. The downloaded copy's local path already carries the right extension (see `download_payment_file_from_url` in commands.rs), so `selectFile` picks it up exactly like a locally-chosen file from here on. */
  async function handleDownloadFromUrl() {
    const targetUrl = urlInput.trim();
    if (!targetUrl) return;
    setUrlError(null);
    setUrlDownloading(true);
    try {
      const result = await downloadPaymentFileFromUrl(targetUrl);
      await selectFile(result.path);
    } catch (e) {
      setUrlError(String(e instanceof Error ? e.message : e));
    } finally {
      setUrlDownloading(false);
    }
  }

  async function handlePickFile() {
    const path = await pickPaymentFile();
    if (!path) return;
    await selectFile(path);
  }

  function startEditingSheetName(sheetName: string) {
    setEditingSheetName(sheetName);
    setEditingSheetNameDraft(sheetName);
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
    setSheetRows((prev) => {
      if (!(oldName in prev)) return prev;
      const { [oldName]: moved, ...rest } = prev;
      return { ...rest, [newName]: moved };
    });
    setSeparatedSheets((prev) => {
      if (!prev.has(oldName)) return prev;
      const next = new Set(prev);
      next.delete(oldName);
      next.add(newName);
      return next;
    });
    if (answersTab === oldName) setAnswersTab(newName);
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
    setIncludedSheets((prev) => new Set(prev).add(sheetName));
    setEditingSheetName(sheetName);
    setEditingSheetNameDraft(sheetName);
  }

  /** Sheets currently answering with group `key`. */
  function membersOf(key: string): string[] {
    return sheets.filter((s) => groupKeyOf(s) === key);
  }

  /**
   * Takes `sheet` out of its group, keeping the group's answers as its
   * starting point. When `sheet` is the group's anchor, the other members
   * move to a new anchor instead, so they keep pointing at a live group.
   * Returns the key `sheet` answers under afterwards.
   */
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
    return sheet;
  }

  /** Every sheet of group `key` joins group `sourceKey` and uses its answers ("Mesmas respostas que outra aba"); its own answers are dropped. */
  function mergeGroupInto(key: string, sourceKey: string) {
    if (key === sourceKey) return;
    const joining = membersOf(key);
    // Joining a group by hand undoes an earlier "responder separado".
    setSeparatedSheets((prev) => new Set([...prev].filter((s) => !joining.includes(s))));
    setSheetGroupOf((prev) => {
      const next = { ...prev };
      for (const s of sheets) if ((next[s] ?? s) === key) next[s] = sourceKey;
      return next;
    });
    setAnswersTab(sourceKey);
  }

  /** "Usar as mesmas respostas?" — sheets with identical column names answer once together (yes) or each on its own (no). */
  function applyShareAnswers(share: boolean) {
    setShareAnswers(share);
    const nextGroupOf = { ...sheetGroupOf };
    const nextMapping = { ...groupMapping };
    const nextLabels = { ...groupFieldLabels };
    for (const cls of similarSheetClasses(sheets)) {
      if (share) {
        const members = cls.filter((s) => !separatedSheets.has(s));
        if (members.length < 2) continue;
        const anchor = groupKeyOf(members[0]);
        for (const s of members) nextGroupOf[s] = anchor;
      } else {
        for (const s of cls) {
          const key = groupKeyOf(s);
          if (key === s) continue;
          nextGroupOf[s] = s;
          nextMapping[s] = { ...(groupMapping[key] ?? {}) };
          nextLabels[s] = { ...(groupFieldLabels[key] ?? {}) };
        }
      }
    }
    setSheetGroupOf(nextGroupOf);
    setGroupMapping(nextMapping);
    setGroupFieldLabels(nextLabels);
  }

  /** Groups of 2+ sheets (among `pool`) whose column names are identical. */
  function similarSheetClasses(pool: string[]): string[][] {
    const bySignature = new Map<string, string[]>();
    for (const s of pool) {
      const signature = headerSignature(sheetRows[s] ?? []);
      if (!signature) continue;
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), s]);
    }
    return [...bySignature.values()].filter((c) => c.length > 1);
  }

  /** "Remover" in the Abas step: the sheet leaves the template altogether (unchecking keeps it, as ignored). */
  function removeSheet(sheet: string) {
    detachSheet(sheet);
    setSheets((prev) => prev.filter((s) => s !== sheet));
    setIncludedSheets((prev) => {
      const next = new Set(prev);
      next.delete(sheet);
      return next;
    });
    setSheetGroupOf((prev) => {
      const { [sheet]: _removed, ...rest } = prev;
      return rest;
    });
    setSheetRows((prev) => {
      const { [sheet]: _removed, ...rest } = prev;
      return rest;
    });
  }

  async function handleDelimiterChange(newDelimiter: string) {
    if (!filePath) return;
    setDelimiter(newDelimiter);
    setLoadingPreview(true);
    setError(null);
    try {
      // Column boundaries just shifted, so the answers start over.
      const preview = await previewSpreadsheet(filePath, null, newDelimiter, PREVIEW_ROWS);
      const rowsBySheet = { [CSV_GROUP_KEY]: preview.rows };
      setSheetRows(rowsBySheet);
      prefillFromRows([], rowsBySheet);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }

  /** Answers one question for group `key`: column `colIndex` holds `field` (`null` clears whichever column held it). */
  function setAnswer(key: string, field: PaymentTargetField, colIndex: number | null) {
    const headerLabel = colIndex === null ? null : (columnsOfGroup(key).find((c) => c.index === colIndex)?.header ?? null);
    setGroupMapping((prev) => {
      const current = { ...(prev[key] ?? {}) };
      for (const k of Object.keys(current)) {
        if (current[Number(k)] === field) delete current[Number(k)];
      }
      if (colIndex !== null) current[colIndex] = field;
      return { ...prev, [key]: current };
    });
    setGroupFieldLabels((prev) => {
      const current = { ...(prev[key] ?? {}) };
      const mapping = groupMapping[key] ?? {};
      for (const k of Object.keys(mapping)) {
        if (mapping[Number(k)] === field) delete current[Number(k)];
      }
      if (colIndex !== null) current[colIndex] = headerLabel;
      return { ...prev, [key]: current };
    });
  }

  /** The Colaborador question's "é: Nome / CPF / Matrícula" — same column, read as another kind of identifier. */
  function changeIdentifierKind(key: string, from: IdentifierField, to: IdentifierField) {
    const mapping = groupMapping[key] ?? {};
    const col = Object.entries(mapping).find(([, f]) => f === from)?.[0];
    if (col === undefined || from === to) return;
    setGroupMapping((prev) => {
      const current = { ...(prev[key] ?? {}) };
      for (const k of Object.keys(current)) if (current[Number(k)] === to) delete current[Number(k)];
      current[Number(col)] = to;
      return { ...prev, [key]: current };
    });
  }

  /** Rows of the group's first sheet that has sample data — where its examples and column names come from. */
  function sampleSheetOf(key: string): string | null {
    const pool = fileKind === "csv" ? [CSV_GROUP_KEY] : membersOf(key);
    const included = pool.filter((s) => fileKind === "csv" || includedSheets.has(s));
    return [...included, ...pool].find((s) => (sheetRows[s] ?? []).length > 0) ?? null;
  }

  /** The columns a question can point at, for group `key`: the sample sheet's columns, or (no sample) A, B, C... with the saved names. */
  function columnsOfGroup(key: string): { index: number; header: string | null }[] {
    const sample = sampleSheetOf(key);
    if (sample) {
      const rows = sheetRows[sample];
      const headers = headersOf(rows);
      const width = rows.reduce((max, r) => Math.max(max, r.length), headers.length);
      return Array.from({ length: width }, (_, i) => ({ index: i, header: headers[i] || null }));
    }
    const labels = groupFieldLabels[key] ?? {};
    const mappedMax = Math.max(-1, ...Object.keys(groupMapping[key] ?? {}).map(Number));
    // Older templates saved "" (or a stray space) when the column had no name.
    // Without a sample the letter is what identifies a column; the saved name
    // is only a hint (old templates saved whatever the first row held, often
    // a data value like a store name). Older ones also saved "" for none.
    return Array.from({ length: Math.max(mappedMax + 6, 12) }, (_, i) => ({ index: i, header: null, savedName: labels[i]?.trim() || null }));
  }

  /** First value under column `col` in the group's sample sheet, for "ex. em ABA: ...". */
  function exampleOf(key: string, col: number): { sheet: string; value: string } | null {
    const sample = sampleSheetOf(key);
    if (!sample) return null;
    const value = dataRowsOf(sheetRows[sample]).map((r) => (r[col] ?? "").trim()).find(Boolean);
    return value ? { sheet: sample === CSV_GROUP_KEY ? "no arquivo" : `em ${sample}`, value } : null;
  }

  /** The included sheets answering with group `key` (the chips under the tabs). */
  function sharingSheets(key: string): string[] {
    return membersOf(key).filter((s) => includedSheets.has(s));
  }

  /** The × on a chip: `sheet` gets its own answers (and its own tab), while the tab stays on the group it left. */
  function splitFromTab(key: string, sheet: string) {
    const remaining = membersOf(key).filter((s) => s !== sheet);
    detachSheet(sheet);
    setSeparatedSheets((prev) => new Set(prev).add(sheet));
    // The group was keyed by `sheet` itself: the others now live under a new key.
    if (key === sheet && remaining.length > 0) setAnswersTab(remaining[0]);
  }

  /** "UNIDADE CENTRO e mais 3" — a group named by the sheets it covers. */
  function groupLabel(key: string): string {
    if (fileKind === "csv") return filePath ? fileNameFromPath(filePath) : "Arquivo";
    const members = membersOf(key).filter((s) => includedSheets.has(s));
    const names = members.length > 0 ? members : membersOf(key);
    return names.length > 1 ? `${names[0]} e mais ${names.length - 1}` : (names[0] ?? key);
  }

  function isGroupMappingValid(key: string): boolean {
    const fields = new Set(Object.values(groupMapping[key] ?? {}));
    const hasIdentifier = IDENTIFIER_FIELD_PRECEDENCE.some((f) => fields.has(f));
    return hasIdentifier && REQUIRED_PAYMENT_FIELDS.every((f) => fields.has(f));
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

  // Every group among the sheets actually being imported — csv always has
  // just the one implicit group.
  const includedGroupKeys =
    fileKind === "csv"
      ? [CSV_GROUP_KEY]
      : Array.from(new Set(sheets.filter((s) => includedSheets.has(s)).map((s) => groupKeyOf(s))));

  const allGroupKeys =
    fileKind === "csv" ? [CSV_GROUP_KEY] : Array.from(new Set(sheets.map((s) => groupKeyOf(s))));

  const pendingGroups = includedGroupKeys.filter((k) => !isGroupMappingValid(k));
  const tabKey = answersTab && includedGroupKeys.includes(answersTab) ? answersTab : (includedGroupKeys[0] ?? null);
  /** Included sheets with identical column names, when they can be compared (a sample file is loaded). */
  const similarIncluded = filePath && fileKind !== "csv" ? similarSheetClasses(sheets.filter((s) => includedSheets.has(s))) : [];

  /** One result per included sheet with sample rows, each read with its own group's answers. */
  const checks = (fileKind === "csv" ? [CSV_GROUP_KEY] : sheets.filter((s) => includedSheets.has(s))).map((sheet) => {
    const rows = sheetRows[sheet] ?? [];
    const key = fileKind === "csv" ? CSV_GROUP_KEY : groupKeyOf(sheet);
    return {
      sheet,
      key,
      label: sheet === CSV_GROUP_KEY ? groupLabel(key) : sheet,
      shared: fileKind !== "csv" && membersOf(key).length > 1,
      result: rows.length > 0 ? checkSheet(rows, groupMapping[key] ?? {}, dateFormat) : null,
    };
  });
  const badChecks = checks.filter((c) => c.result?.problem);

  /** Identifier columns answered in any included group — what "Como achar o colaborador?" orders. */
  const mappedIdentifiers = IDENTIFIER_FIELDS.filter((f) => includedGroupKeys.some((k) => columnOf(groupMapping[k] ?? {}, f) !== null));

  /** Values a rule can compare `field` against: what the sample file has in that column (or the sheet names), plus the database's Funções/Locais. */
  function suggestionsFor(field: PaymentRuleField): string[] {
    if (field === SHEET_NAME_RULE_FIELD) return sheets.filter((s) => includedSheets.has(s));
    const found = new Set<string>(field === "funcao" ? knownRoles : field === "local" ? knownLocals : []);
    for (const { sheet, key } of checks) {
      const col = columnOf(groupMapping[key] ?? {}, field as PaymentTargetField);
      if (col === null) continue;
      for (const row of dataRowsOf(sheetRows[sheet] ?? [])) {
        const v = (row[col] ?? "").trim();
        if (v) found.add(v);
        if (found.size >= 300) break;
      }
    }
    return Array.from(found);
  }

  /** "responder esta aba separado" / "corrigir as respostas" in Conferir: back to Colunas on that sheet's answers. */
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

  /** Validates the current step and either advances or blocks with an explanation — an attempt to advance always gets a reaction, not just a silently-disabled button. */
  function handleAdvance() {
    setError(null);
    if (currentStep === "file" && filePath === null) {
      setError("Selecione um arquivo antes de avançar.");
      return;
    }
    if (currentStep === "file" && loadingPreview) return;
    if (currentStep === "sheets" && includedSheets.size === 0) {
      setError("Marque ao menos uma aba para importar.");
      return;
    }
    if (currentStep === "answers") {
      if (includedGroupKeys.length === 0) {
        setError("Nenhuma aba para responder.");
        return;
      }
      if (pendingGroups.length > 0) {
        setAnswersTab(pendingGroups[0]);
        setError(`Falta responder: ${pendingGroups.map(groupLabel).join(", ")}.`);
        return;
      }
      // Reads the dates the way most of the sample's "Data" values parse,
      // before Conferir checks them (still changeable in Detalhes).
      if (filePath) {
        const values = checks.flatMap(({ sheet, key }) => {
          const col = Object.entries(groupMapping[key] ?? {}).find(([, f]) => f === "data")?.[0];
          return col === undefined ? [] : dataRowsOf(sheetRows[sheet] ?? []).map((r) => r[Number(col)] ?? "");
        });
        setDateFormat((current) => detectDateFormat(values, DATE_FORMAT_OPTIONS, current));
      }
    }
    if (currentStep === "check" && badChecks.length > 0) {
      setError("Resolva as abas com problema (ou desmarque-as em Abas) antes de continuar.");
      return;
    }
    setStepIndex((s) => s + 1);
  }

  async function handleSave() {
    if (!fileKind || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const editing = target !== null && target !== "new" ? target : null;

      const groups: PaymentTemplateGroup[] = allGroupKeys.map((key) => {
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
        return { sheetNames, excludedSheetNames, fieldMappings };
      });

      const test = (t: RuleTest) => ({ field: t.field, values: t.values, caseInsensitive: true });
      const ruleInputs: PaymentTemplateRuleInput[] = routes.map((r) => ({
        kind: "condition" as const,
        conditions: r.tests.map(test),
        companyId: r.companyId!,
        clientId: r.clientId!,
      }));
      if (routeFallback.companyId !== null && routeFallback.clientId !== null) {
        ruleInputs.push({ kind: "else", conditions: [], companyId: routeFallback.companyId, clientId: routeFallback.clientId });
      }

      const statusRuleInputs: PaymentTemplateStatusRuleInput[] = statusDrafts.map((r) => ({
        kind: "condition" as const,
        conditions: r.tests.map(test),
        status: r.status,
      }));
      if (statusRuleInputs.length > 0) statusRuleInputs.push({ kind: "else", conditions: [], status: statusFallback });

      const input: PaymentTemplateInput = {
        name: name.trim(),
        fileKind,
        acceptedFileKinds: Array.from(new Set([fileKind, ...acceptedFileKinds])),
        delimiter: fileKind === "csv" ? delimiter : null,
        dateFormat,
        identifierPriority: effectiveIdentifierOrder(identifierOrder, mappedIdentifiers).map((f) => ({ fields: [f], caseInsensitive: true })),
        groups,
        rules: ruleInputs,
        statusRules: statusRuleInputs,
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
    <Modal fullScreen zIndex={100} onClose={onClose}>
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
          {readOnly ? "Template de pagamento" : isEditing ? "Editar template de pagamento" : "Novo template de pagamento"}
        </strong>
        <CloseButton />
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
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
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

              <div className="glass-panel" style={{ marginTop: "1rem" }}>
                <h4 className="glass-panel-heading" style={{ fontSize: "0.85rem" }}>
                  <Link2 size={16} />
                  Ou baixar por URL
                </h4>
                <p className="glass-panel-desc">
                  Link de download direto e anônimo (sem exigir login) para um arquivo Excel
                  (.xlsx/.xls) ou OpenDocument (.ods).
                </p>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input
                    type="url"
                    className="glass-input"
                    placeholder="https://exemplo.com/arquivo.xlsx"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    disabled={urlDownloading}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleDownloadFromUrl}
                    disabled={!urlInput.trim() || urlDownloading}
                  >
                    {urlDownloading ? "Baixando..." : "Baixar arquivo"}
                  </button>
                </div>
                {urlError && (
                  <div className="error-box" style={{ marginTop: "0.6rem" }}>
                    {urlError}
                  </div>
                )}
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

        {currentStep === "sheets" && (
          <div className="tmap">
            <h2 className="tmap-title">Quais abas importar?</h2>
            <p className="tmap-lead">
              {includedSheets.size} de {sheets.length} {sheets.length === 1 ? "aba marcada" : "abas marcadas"}. Dois cliques no nome
              para renomear.
            </p>
            <div className="tmap-sheets">
              {sheets.map((s) => {
                const on = includedSheets.has(s);
                return (
                  <div key={s} className={`tmap-sheet${on ? "" : " off"}`} onClick={() => toggleSheetIncluded(s)}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleSheetIncluded(s)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={on ? `Não importar "${s}"` : `Importar "${s}"`}
                    />
                    {editingSheetName === s ? (
                      <input
                        autoFocus
                        type="text"
                        className="tmap-rename"
                        value={editingSheetNameDraft}
                        onChange={(e) => setEditingSheetNameDraft(e.target.value)}
                        onBlur={() => renameSheet(s, editingSheetNameDraft)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            renameSheet(s, editingSheetNameDraft);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setEditingSheetName(null);
                            setEditingSheetNameDraft("");
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="tmap-sheet-name"
                        title="Dois cliques para renomear"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startEditingSheetName(s);
                        }}
                      >
                        {s}
                      </span>
                    )}
                    <button
                      type="button"
                      className="tmap-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSheet(s);
                      }}
                      aria-label={`Remover "${s}"`}
                    >
                      Remover
                    </button>
                  </div>
                );
              })}
              <button type="button" className="tmap-addline" onClick={addNewSheet}>
                + Adicionar aba
              </button>
            </div>
          </div>
        )}

        {currentStep === "answers" && (
          <div className="tmap">
            <h2 className="tmap-title">Onde está cada informação?</h2>
            <p className="tmap-lead">
              {filePath
                ? "Já preenchemos pelo nome das colunas. Confira."
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
                  onToggle={(id) => handleDelimiterChange(id)}
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
                  <button
                    key={key}
                    type="button"
                    aria-pressed={key === tabKey}
                    title={membersOf(key).filter((s) => includedSheets.has(s)).join(", ")}
                    onClick={() => setAnswersTab(key)}
                  >
                    {groupLabel(key)}
                    {!isGroupMappingValid(key) && <span className="tmap-dot" aria-label="falta responder" />}
                  </button>
                ))}
              </div>
            )}

            {tabKey && fileKind !== "csv" && sharingSheets(tabKey).length > 1 && (
              <div className="tmap-share">
                <span className="tmap-share-head">
                  Estas respostas valem para {sharingSheets(tabKey).length} abas · tire uma com ×
                </span>
                <div className="tmap-chips">
                  {sharingSheets(tabKey).map((s) => (
                    <span key={s} className="tmap-chip">
                      {s}
                      <button
                        type="button"
                        onClick={() => splitFromTab(tabKey, s)}
                        aria-label={`Responder ${s} separado`}
                        title="Responder separado"
                      >
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
                {QUESTIONS.map((q) =>
                  q.field === "colaborador" ? (
                    <IdentifierQuestions
                      key="colaborador"
                      columns={columnsOfGroup(tabKey)}
                      mapping={groupMapping[tabKey] ?? {}}
                      revealed={IDENTIFIER_FIELDS.filter((f) => revealedIdentifiers.has(`${tabKey}:${f}`))}
                      onReveal={(f) => setRevealedIdentifiers((prev) => new Set(prev).add(`${tabKey}:${f}`))}
                      onHide={(f) =>
                        setRevealedIdentifiers((prev) => {
                          const next = new Set(prev);
                          next.delete(`${tabKey}:${f}`);
                          return next;
                        })
                      }
                      onAnswer={(f, col) => setAnswer(tabKey, f, col)}
                      onChangeKind={(from, to) => changeIdentifierKind(tabKey, from, to)}
                      example={(col) => exampleOf(tabKey, col)}
                    />
                  ) : (
                    <ColumnQuestion
                      key={q.field}
                      label={q.label}
                      hint={q.hint}
                      optional={q.optional}
                      columns={columnsOfGroup(tabKey)}
                      mapping={groupMapping[tabKey] ?? {}}
                      value={columnOf(groupMapping[tabKey] ?? {}, q.field)}
                      onChange={(col) => setAnswer(tabKey, q.field as PaymentTargetField, col)}
                      example={(col) => exampleOf(tabKey, col)}
                    />
                  ),
                )}
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
                <b>{checks.reduce((n, c) => n + (c.result && !c.result.problem ? c.result.shifts : 0), 0)}</b>
                <span>turnos certos</span>
              </div>
              {badChecks.length > 0 && (
                <div className="bad">
                  <b>{badChecks.length}</b>
                  <span>{badChecks.length === 1 ? "aba com problema" : "abas com problema"}</span>
                </div>
              )}
            </div>
            {badChecks.some((c) => c.result?.problem?.field === "data") && (
              <div className="tmap-q">
                <label>
                  Formato das datas
                  <small>se as datas estão certas</small>
                </label>
                <OptionPicker
                  single
                  showTiles={false}
                  align="left"
                  options={DATE_FORMAT_OPTIONS.map((f) => ({ id: f, label: f }))}
                  selected={new Set([dateFormat])}
                  onToggle={setDateFormat}
                  title="Formato das datas"
                  allPlaceholder="Escolha o formato"
                  searchPlaceholder="Buscar"
                />
              </div>
            )}
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
                            : `${c.result.shifts} ${c.result.shifts === 1 ? "turno" : "turnos"}`}
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
                                <span className={problem.field === "data" ? "off" : undefined}>data: “{r.date}”</span>
                                <span className={problem.field === "horario" ? "off" : undefined}>horário: “{r.schedule}”</span>
                              </div>
                            ))}
                            <p className="tmap-hint">
                              {problem.field === "colaborador"
                                ? "Nenhuma linha desta aba tem valor na coluna de Colaborador."
                                : `A coluna de ${problem.field === "data" ? "Data" : "Horário"} desta aba não tem ${
                                    problem.field === "data" ? `datas no formato ${dateFormat}` : "horários como 08:00 às 16:00"
                                  }.`}{" "}
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
          <PaymentTemplateDetails
            name={name}
            onName={setName}
            routes={routes}
            onRoutes={setRoutes}
            fallback={routeFallback}
            onFallback={setRouteFallback}
            statusRules={statusDrafts}
            onStatusRules={setStatusDrafts}
            statusFallback={statusFallback}
            onStatusFallback={setStatusFallback}
            identifierOrder={identifierOrder}
            onIdentifierOrder={setIdentifierOrder}
            mappedIdentifiers={mappedIdentifiers}
            dateFormat={dateFormat}
            onDateFormat={setDateFormat}
            dateFormats={DATE_FORMAT_OPTIONS}
            fileKind={fileKind}
            acceptedFileKinds={acceptedFileKinds}
            onToggleFileKind={toggleAcceptedFileKind}
            companies={companies}
            clients={clientsAll}
            suggestionsFor={suggestionsFor}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          // Room on the right for the assistant's floating button, which
          // sits above fullscreen surfaces and would cover "Avançar"/"Salvar".
          padding: "0.8rem 4.8rem 0.8rem 1.2rem",
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
        <span className="tmap-note">
          {currentStep === "answers" && pendingGroups.length > 0
            ? `Falta responder: ${pendingGroups.map(groupLabel).join(", ")}`
            : currentStep === "check" && badChecks.length > 0
              ? "Resolva as abas com problema ou desmarque-as"
              : currentStep === "details"
                ? (detailsProblem(name, routes, routeFallback) ?? "")
                : ""}
        </span>
        {stepIndex < steps.length - 1 ? (
          <button type="button" onClick={handleAdvance} disabled={busy || loadingPreview}>
            Avançar
            <ChevronRight size={15} style={{ marginLeft: "0.3rem" }} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSave}
            title={readOnly ? READ_ONLY_TITLE : undefined}
            disabled={readOnly || busy || detailsProblem(name, routes, routeFallback) !== null}
          >
            {busy ? "Salvando..." : "Salvar"}
          </button>
        )}
      </div>
    </Modal>
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

/** Which column group `mapping` answers `field` with, or `null`. */
function columnOf(mapping: Record<number, PaymentTargetField>, field: PaymentTargetField): number | null {
  const entry = Object.entries(mapping).find(([, f]) => f === field);
  return entry ? Number(entry[0]) : null;
}

/** `header`: the column's name in the sample file. `savedName`: the name kept in a saved template, shown only as a hint. */
type GroupColumn = { index: number; header: string | null; savedName?: string | null };

/** A column chooser in the app's picker style: the column's name, its letter on the right. */
function ColumnPicker({
  columns,
  value,
  placeholder,
  noneLabel,
  usedBy,
  onChange,
}: {
  columns: GroupColumn[];
  value: number | null;
  placeholder: string;
  /** Adds a first "no column" option (e.g. "Não tem"). */
  noneLabel?: string;
  /** What other questions already point at each column — a column holds one answer, picking it here moves it. */
  usedBy: Record<number, string>;
  onChange: (col: number | null) => void;
}) {
  const options: PickerOption[] = [
    ...(noneLabel ? [{ id: "none", label: noneLabel }] : []),
    ...columns.map((c) => {
      const parts = [
        c.header ? `coluna ${columnLetter(c.index)}` : null,
        c.savedName ? `“${c.savedName}”` : null,
        usedBy[c.index] ? `já é ${usedBy[c.index]}` : null,
      ];
      return {
        id: String(c.index),
        label: c.header ?? `Coluna ${columnLetter(c.index)}`,
        meta: parts.filter(Boolean).join(" · ") || undefined,
      };
    }),
  ];
  return (
    <OptionPicker
      single
      showTiles={false}
      align="left"
      options={options}
      selected={new Set(value === null ? [] : [String(value)])}
      onToggle={(id) => onChange(id === "none" ? null : Number(id))}
      title="Colunas"
      allPlaceholder={placeholder}
      searchPlaceholder="Buscar coluna"
    />
  );
}

function ColumnQuestion({
  label,
  hint,
  optional,
  columns,
  mapping,
  value,
  onChange,
  example,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  columns: GroupColumn[];
  /** The group's answers, to flag columns another question already uses. */
  mapping: Record<number, PaymentTargetField>;
  value: number | null;
  onChange: (col: number | null) => void;
  example: (col: number) => { sheet: string; value: string } | null;
  children?: ReactNode;
}) {
  const ex = value === null ? null : example(value);
  const usedBy: Record<number, string> = {};
  for (const [col, field] of Object.entries(mapping)) {
    if (Number(col) !== value) usedBy[Number(col)] = QUESTION_LABEL[field];
  }
  return (
    <div className={`tmap-q${!optional && value === null ? " miss" : ""}`}>
      <label>
        {label}
        {hint && <small>{hint}</small>}
      </label>
      <div className="tmap-pick">
        <ColumnPicker
          columns={columns}
          value={value}
          placeholder={optional ? "Não tem" : "Escolha a coluna"}
          noneLabel={optional ? "Não tem" : undefined}
          usedBy={usedBy}
          onChange={onChange}
        />
        {ex && (
          <span className="tmap-ex">
            ex. {ex.sheet}: {ex.value}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

const IDENTIFIER_ORDER: IdentifierField[] = ["nome", "cpf", "matricula"];

/** How a column's current answer is named in the pickers ("já é Função"). */
const QUESTION_LABEL: Record<PaymentTargetField, string> = {
  nome: "Colaborador (nome)",
  cpf: "Colaborador (CPF)",
  matricula: "Colaborador (matrícula)",
  data: "Data",
  local: "Local",
  funcao: "Função",
  horario: "Horário",
  status: "Status",
};

/** Reads a header to tell which kind of identifier a column holds, for a first Colaborador answer. */
function identifierKindOf(header: string | null): IdentifierField {
  const h = (header ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  if (/\bCPF\b/.test(h)) return "cpf";
  if (/MATRIC|CHAPA/.test(h)) return "matricula";
  return "nome";
}

/**
 * The Colaborador question: one column that says who worked the shift, read
 * as Nome, CPF or Matrícula. More identifier columns are optional ("Também
 * identificar por") — the import tries them in the order set in Detalhes.
 */
function IdentifierQuestions({
  columns,
  mapping,
  revealed,
  onReveal,
  onHide,
  onAnswer,
  onChangeKind,
  example,
}: {
  columns: GroupColumn[];
  mapping: Record<number, PaymentTargetField>;
  revealed: IdentifierField[];
  onReveal: (f: IdentifierField) => void;
  onHide: (f: IdentifierField) => void;
  onAnswer: (f: IdentifierField, col: number | null) => void;
  onChangeKind: (from: IdentifierField, to: IdentifierField) => void;
  example: (col: number) => { sheet: string; value: string } | null;
}) {
  const mapped = IDENTIFIER_ORDER.filter((f) => columnOf(mapping, f) !== null);
  const main = mapped[0] ?? null;
  const extras = IDENTIFIER_ORDER.filter((f) => f !== main && (mapped.includes(f) || revealed.includes(f)));
  const offered = IDENTIFIER_ORDER.filter((f) => f !== main && !extras.includes(f));

  return (
    <>
      <ColumnQuestion
        label="Colaborador"
        hint="nome, CPF ou matrícula"
        columns={columns}
        mapping={mapping}
        value={main ? columnOf(mapping, main) : null}
        onChange={(col) => {
          if (col === null) return;
          onAnswer(main ?? identifierKindOf(columns.find((c) => c.index === col)?.header ?? null), col);
        }}
        example={example}
      >
        {main && (
          <span className="tmap-kinds" role="group" aria-label="A coluna tem">
            {IDENTIFIER_ORDER.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={f === main}
                onClick={() => onChangeKind(main, f)}
                disabled={f !== main && mapped.includes(f)}
              >
                {PAYMENT_TARGET_FIELD_LABELS[f]}
              </button>
            ))}
            {offered.length > 0 && (
              <span className="tmap-also">
                · também identificar por{" "}
                {offered.map((f, i) => (
                  <span key={f}>
                    {i > 0 && " ou "}
                    <button type="button" className="tmap-link" onClick={() => onReveal(f)}>
                      {PAYMENT_TARGET_FIELD_LABELS[f]}
                    </button>
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
      </ColumnQuestion>
      {extras.map((f) => (
        <ColumnQuestion
          key={f}
          label={PAYMENT_TARGET_FIELD_LABELS[f]}
          hint="também identifica"
          optional
          columns={columns}
          mapping={mapping}
          value={columnOf(mapping, f)}
          onChange={(col) => {
            onAnswer(f, col);
            if (col === null) onHide(f);
          }}
          example={example}
        />
      ))}
    </>
  );
}
