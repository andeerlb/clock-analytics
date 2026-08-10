import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileText,
  FolderOpen,
  History,
  Link2,
  PlusCircle,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import Drawer from "../components/Drawer";
import EmployeePicker from "../components/EmployeePicker";
import Pagination from "../components/Pagination";
import PickFilesButton from "../components/PickFilesButton";
import { useRemoteFileUpdates, type RemoteUpdateFlag } from "../contexts/RemoteFileUpdatesContext";
import type { EmployeeFormNavState } from "./EmployeeFormPage";
import {
  applyPaymentTemplate,
  downloadPaymentFileFromUrl,
  hashPaymentFile,
  listDirFiles,
  pickFolder,
  pickPaymentFiles,
  type AppliedPaymentRow,
} from "../lib/api";
import {
  addEmployeeAlias,
  DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  deletePaymentShift,
  findDuplicatePaymentShifts,
  findEmployeeByAttempts,
  findPaymentShiftByPosition,
  getPaymentTemplate,
  listHeadShiftsForSourceUrl,
  listImportFiles,
  listPaymentTemplates,
  logSourceFile,
  markSourceFileSaved,
  savePaymentShifts,
  type DuplicatePaymentShiftMatch,
  type EmployeeRow,
  type PaymentShiftInput,
  type SourceUrlHeadShift,
} from "../lib/db";
import {
  fileNameFromPath,
  formatDate,
  formatDateTime,
  formatMinutesAsTime,
  parseDateWithFormat,
  parseScheduleToMinutes,
  resolvePaymentRoute,
  resolvePaymentStatus,
  safeDecodeFileName,
  withSheetNameField,
} from "../lib/format";
import {
  PAYMENT_SHIFT_STATUS_LABELS,
  type IdentifierAttempt,
  type ImportFileRow,
  type ImportStatus,
  type PaymentFileKind,
  type PaymentShiftStatus,
  type PaymentTemplateListRow,
  type PaymentTemplateRow,
} from "../lib/types";

const STATUS_BADGE: Record<ImportStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { className: "badge ok", label: "Sucesso", icon: CheckCircle2 },
  warning: { className: "badge overwrite", label: "Com alertas", icon: AlertTriangle },
  error: { className: "badge file-error", label: "Falha", icon: AlertCircle },
};

/** Which badge color reflects the shift's resolved payment status — see `resolvePaymentStatus`. */
const PAYMENT_STATUS_BADGE_CLASS: Record<PaymentShiftStatus, string> = {
  pendente: "badge neutral",
  erro: "badge file-error",
  pago: "badge ok",
};

const PAYMENT_FILE_KIND_LABELS: Record<PaymentFileKind, string> = {
  csv: "CSV",
  xlsx: "Excel (XLSX)",
  xls: "Excel (XLS)",
  ods: "ODS",
};

/** ["xlsx","ods"] -> "Excel (XLSX) ou ODS" — how a template's `acceptedFileKinds` reads in an error/status message. */
function formatFileKindList(kinds: PaymentFileKind[]): string {
  const labels = kinds.map((k) => PAYMENT_FILE_KIND_LABELS[k]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} ou ${labels[labels.length - 1]}`;
}

/**
 * Every row lands in exactly one bucket — this is both what the toolbar
 * counts and what the toolbar's chips filter by (see `rowFilter`).
 * "valid"/"duplicate"/"deleted"/"duplicate-in-file" are the only ones with
 * a resolved `employee`. "duplicate" means an exact match already exists
 * in `payment_shifts` (see `findDuplicatePaymentShifts`) — offered as
 * "reprocessar", not excluded outright. "deleted" is the same idea but the
 * match was soft-deleted ("Remover" on the Pagamentos table never
 * physically deletes a shift, precisely so this can happen) — surfaced for
 * review instead of either silently recreating it or hiding the fact it
 * once existed, and just as unselected-by-default as "duplicate".
 * "duplicate-in-file" means this row is byte-for-byte identical to an
 * earlier candidate row in this same import batch — a source-file
 * artifact, not importable at all, since keeping both would just
 * double-import the same shift within one run.
 */
type RowCategory = "valid" | "duplicate" | "deleted" | "duplicate-in-file" | "not-found" | "unresolved-route" | "skipped";
type RowFilter = RowCategory | "error" | "all" | "selected";

interface PaymentPreviewRow {
  fileHash: string;
  fileName: string;
  sheetName: string | null;
  rowNumber: number;
  employee: EmployeeRow | null;
  /** Raw "nome" column text, shown when `employee` couldn't be resolved so it's clear whether the name was even read from the file. */
  nameRaw: string;
  local: string;
  role: string;
  /** Raw Horário text, kept only to display when `parseScheduleToMinutes` can't make sense of it. */
  scheduleRaw: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  /** `null` when the mapped "data" column didn't parse (category "skipped") — shown as `workDateRaw` instead. */
  workDate: string | null;
  /** Raw "data" column text, for display when `workDate` is null. */
  workDateRaw: string;
  isDuplicate: boolean;
  /** No rule in the template's routing chain matched this row's field value — `employee` is always `null` when this is `true` (the lookup never runs without a resolved client). */
  unresolvedRoute: boolean;
  /** The route's resolved client, if any — `null` unless a routing rule matched. Kept on the row (not just used transiently) so a "colaborador não encontrado" row's "vincular colaborador" picker knows which client to search within. */
  resolvedClientId: number | null;
  /** Display name for `resolvedClientId`, straight from the matched rule — `null` alongside it. */
  resolvedClientName: string | null;
  /** The route's resolved company, alongside `resolvedClientId` — same routing rule, so "Cadastrar colaborador" can hand off exactly which client/empresa this row already resolved to, instead of leaving them to pick blind. */
  resolvedCompanyId: number | null;
  /** Display name for `resolvedCompanyId`, straight from the matched rule — `null` alongside it. */
  resolvedCompanyName: string | null;
  /** Resolved from the template's status rules, falling back to `"pendente"` when none match (or none are configured) — see `resolvePaymentStatus`. */
  paymentStatus: PaymentShiftStatus;
  /** Every non-blank column the template left unmapped on this row — kept for history/audit instead of discarded. */
  extraFields: Record<string, string>;
  category: RowCategory;
  /** Set alongside `isDuplicate`/`category === "duplicate"` — the current payment_shifts row this one matches (see `findDuplicatePaymentShifts`), linked via `previousShiftId` if reprocessed. `null` for every other category. */
  matchedShiftId: number | null;
  /** Whether that matched row was a deliberate manual action (editar valor/fazer pagamento/voltar para pendente), not an import — combined with the `keepManualEdits` setting, this decides whether the row can even be selected for reprocessing. */
  matchedEditedManually: boolean;
  /** Whether the match was only found by walking the matched shift's history — its own Local/Função/Horário/Data have since been hand-edited away from what's still in this file (see `findDuplicatePaymentShifts`). Only meaningful alongside `matchedEditedManually`. */
  matchedIdentityChanged: boolean;
}

/**
 * Only the template's genuinely unmapped columns — row position/aba/arquivo
 * used to be stuffed in here too (as "linha de origem"/"aba de origem"/
 * "arquivo de origem" text), but that made them unqueryable JSON. They're
 * real, indexed columns now (`PaymentShiftInput.sourceRowNumber`/
 * `sourceSheetName`, and `sourceFileId` for the file itself) — still shown
 * in the same "extra" modal on the Pagamentos screen, just reconstructed
 * from those columns at read time instead of stored here (see
 * `PaymentsPage.tsx`'s `displayExtraData`).
 */
function buildExtraData(row: PaymentPreviewRow): Record<string, string> | null {
  return Object.keys(row.extraFields).length > 0 ? row.extraFields : null;
}

/** Applies one `findDuplicatePaymentShifts` result to its row — shared by every place that runs the check (initial processing, "vincular colaborador", "cadastrar colaborador"), so the "deleted" vs "duplicate" split can't drift between them. */
function applyDuplicateMatch(row: PaymentPreviewRow, match: DuplicatePaymentShiftMatch) {
  row.isDuplicate = true;
  row.category = match.deleted ? "deleted" : "duplicate";
  row.matchedShiftId = match.shiftId;
  row.matchedEditedManually = match.editedManually;
  row.matchedIdentityChanged = match.identityChanged;
}

interface PaymentFileResult {
  fileHash: string;
  fileName: string;
  /** Which entry in `paths` produced this — lets `handleSave` look up `urlSourceByPath` per file. */
  path: string;
  rows: PaymentPreviewRow[];
  error: string | null;
}

type ImportMode = "local" | "url";

/** Where a downloaded (not locally-picked) `paths` entry came from, and the response headers captured at that download — recorded so a later reimport can compare against them (see `checkRemotePaymentFile`). */
interface UrlProvenance {
  url: string;
  /** The real display name from Content-Disposition/the URL — overrides the local uuid-named temp file's own basename, which is all `hashPaymentFile` below would otherwise have to go on. */
  fileName: string;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

/**
 * A snapshot of everything worth restoring on this page, attached to its
 * own history entry (via `navigate(".", {replace:true, state})`) right
 * before leaving for "Cadastrar colaborador" — so clicking "Voltar" there
 * (a plain `navigate(-1)`, see `BackButton`) pops back to this exact
 * preview instead of a blank page. Derived state (`selectedTemplate`,
 * `fileHashes`) isn't included — restoring `templateId`/`paths` makes
 * their own effects recompute it the same way a fresh load would.
 */
interface PaymentImportNavState {
  templateId: string;
  periodStart: string;
  periodEnd: string;
  paths: string[];
  importMode: ImportMode;
  urlSourceByPath: Map<string, UrlProvenance>;
  fileResults: PaymentFileResult[];
  selectedRows: Set<number>;
  rowFilter: RowFilter;
  nameSearch: string;
  previewPage: number;
  previewPageSize: number;
  keepManualEdits: boolean;
}

type DisplayRow =
  | { kind: "shift"; index: number; row: PaymentPreviewRow }
  | { kind: "error"; fileName: string; message: string };

/** Identifies "the same shift" for dedup purposes (within-batch and against payment_shifts) — every column that matters, status excluded — see `findDuplicatePaymentShifts`. */
function shiftDedupKey(
  employeeId: number,
  r: Pick<PaymentPreviewRow, "workDate" | "local" | "role" | "scheduleStartMinutes" | "scheduleEndMinutes">,
): string {
  return JSON.stringify([employeeId, r.workDate, r.local, r.role, r.scheduleStartMinutes, r.scheduleEndMinutes]);
}

const PREVIEW_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const PATHS_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportPaymentsPage() {
  const navigate = useNavigate();
  // Only used as the initial values below — once here, each piece of state
  // is this page's own, independently adjustable from that point on.
  const location = useLocation();
  const restored = location.state as PaymentImportNavState | null;

  const [templates, setTemplates] = useState<PaymentTemplateListRow[]>([]);
  const [templateId, setTemplateId] = useState(restored?.templateId ?? "");
  const [selectedTemplate, setSelectedTemplate] = useState<PaymentTemplateRow | null>(null);

  // Optional — filters rows by the template's mapped "data" column. Left
  // empty, processing goes through the whole file (with confirmation, see
  // handleProcessClick).
  const [periodStart, setPeriodStart] = useState(restored?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(restored?.periodEnd ?? "");
  const [confirmFullImport, setConfirmFullImport] = useState(false);
  const [rowFilter, setRowFilter] = useState<RowFilter>(restored?.rowFilter ?? "all");
  const [nameSearch, setNameSearch] = useState(restored?.nameSearch ?? "");

  const [paths, setPaths] = useState<string[]>(restored?.paths ?? []);
  const [pathsPage, setPathsPage] = useState(0);
  const [pathsPageSize, setPathsPageSize] = useState(PATHS_PAGE_SIZE_OPTIONS[0]);
  const [fileHashes, setFileHashes] = useState<Map<string, { hash: string; fileName: string }>>(
    new Map(),
  );

  const [importMode, setImportMode] = useState<ImportMode>(restored?.importMode ?? "local");
  const [urlInput, setUrlInput] = useState("");
  const [urlDownloading, setUrlDownloading] = useState(false);
  const [urlSourceByPath, setUrlSourceByPath] = useState<Map<string, UrlProvenance>>(
    restored?.urlSourceByPath ?? new Map(),
  );
  const [pendingAutoProcess, setPendingAutoProcess] = useState(false);
  // Off by default — tracking is opt-in per save, not an automatic side
  // effect of importing by URL (see trackUrlForAutoReimport's doc comment).
  const [trackAutoUpdates, setTrackAutoUpdates] = useState(false);
  // True for the duration of a reimport triggered from a "Verificação
  // automática" flag (handleReimportFromUrl) — this is already a tracked,
  // already-validated URL, so the format warning, the URL input/"Baixar
  // arquivo" button and the tracking checkbox (this page is shared with a
  // regular manual URL import, where all of those still apply) don't make
  // sense here; the URL itself still shows, just read-only. Cleared back to
  // false by `reset()` (a fresh save or a new reimport starts clean) and,
  // as a manual escape hatch, if the user removes the auto-downloaded file
  // themselves (see `removePath`) — otherwise the URL input would stay
  // stuck disabled with nothing left to reimport.
  const [isAutoReimport, setIsAutoReimport] = useState(false);
  const { dismissRemoteUpdate, trackUrl, trackedFiles, reimportConfigs, addReimportConfig, getReimportFlag } =
    useRemoteFileUpdates();

  const [fileResults, setFileResults] = useState<PaymentFileResult[]>(restored?.fileResults ?? []);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(restored?.selectedRows ?? new Set());
  const [previewPage, setPreviewPage] = useState(restored?.previewPage ?? 0);
  const [previewPageSize, setPreviewPageSize] = useState(restored?.previewPageSize ?? PREVIEW_PAGE_SIZE_OPTIONS[0]);
  const [processedKeepManualEdits, setProcessedKeepManualEdits] = useState<boolean | null>(null);

  // The inverse of "excluído" (a file row whose match was soft-deleted in
  // the system): shifts that are still very much alive in the system, on
  // record as having come from this exact URL/período, but that this read
  // of the file didn't land on at all — not just one row among many, but
  // NO row. Only ever populated for a URL-based import (see `handleProcess`)
  // — a locally-picked file has no stable identity to compare a past import
  // against.
  const [missingSourceShifts, setMissingSourceShifts] = useState<(SourceUrlHeadShift & { sourceUrl: string })[]>([]);
  const [markingMissingShiftId, setMarkingMissingShiftId] = useState<number | null>(null);

  async function handleMarkMissingShiftDeleted(shiftId: number) {
    setMarkingMissingShiftId(shiftId);
    try {
      await deletePaymentShift(shiftId);
      setMissingSourceShifts((prev) => prev.filter((m) => m.shiftId !== shiftId));
    } finally {
      setMarkingMissingShiftId(null);
    }
  }

  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [recentFilesTotal, setRecentFilesTotal] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Whether a "duplicate" row whose current match was edited manually
  // (editar valor/fazer pagamento/voltar para pendente) can still be
  // reprocessed on THIS save — see the checkbox/badge logic below. Not a
  // persisted preference: defaults to on for a fresh import, replayed from
  // the reimport config's own stored value on an automatic reimport (see
  // `handleReimportFromUrl`), and carried into a new config's own
  // `keepManualEdits` if "Rastrear atualizações automaticamente" is checked
  // (see `handleSave`'s `trackUrl` call).
  const [keepManualEdits, setKeepManualEdits] = useState(true);

  useEffect(() => {
    listPaymentTemplates().then(setTemplates);
  }, []);

  // History panel — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    refreshRecentFiles();
  }, [historySearch, historyPage, historyPageSize]);

  function refreshRecentFiles() {
    listImportFiles({ importType: "payment", search: historySearch, page: historyPage, pageSize: historyPageSize }).then(
      ({ rows, total }) => {
        setRecentFiles(rows);
        setRecentFilesTotal(total);
      },
    );
  }

  // Hash newly picked files (no page-count/duplicate check like timesheets
  // — a payment file has no equivalent to "one PDF, one employee", and the
  // row-level duplicate check further down is the meaningful one here).
  useEffect(() => {
    if (paths.length === 0) {
      setFileHashes(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(paths.map((p) => hashPaymentFile(p)));
      if (cancelled) return;
      // A URL download's local copy lives under imports/ named by uuid —
      // hashPaymentFile can only report that uuid-based basename as
      // `fileName`, so the real name (from Content-Disposition/the URL)
      // recorded at download time takes priority here, same as a locally
      // picked file's own real basename would.
      setFileHashes(
        new Map(
          entries.map((e) => [
            e.path,
            { hash: e.hash, fileName: urlSourceByPath.get(e.path)?.fileName ?? e.fileName },
          ]),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [paths, urlSourceByPath]);

  useEffect(() => {
    if (!templateId) {
      setSelectedTemplate(null);
      return;
    }
    let cancelled = false;
    getPaymentTemplate(Number(templateId)).then((t) => {
      if (!cancelled) setSelectedTemplate(t);
    });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  function addPaths(newPaths: string[]) {
    setPaths((prev) => Array.from(new Set([...prev, ...newPaths])));
    setPathsPage(0);
    cancelPreview();
    setSuccessMessage(null);
  }

  function removePath(path: string) {
    setPaths((prev) => {
      const next = prev.filter((p) => p !== path);
      // The user tore down the auto-downloaded file themselves — unlock
      // manual URL entry again instead of leaving it stuck disabled with
      // nothing left to reimport.
      if (next.length === 0) setIsAutoReimport(false);
      return next;
    });
    setPathsPage(0);
  }

  const pathsPageCount = Math.max(1, Math.ceil(paths.length / pathsPageSize));
  const pagedPaths = useMemo(
    () => paths.slice(pathsPage * pathsPageSize, pathsPage * pathsPageSize + pathsPageSize),
    [paths, pathsPage, pathsPageSize],
  );

  function cancelPreview() {
    setFileResults([]);
    setSelectedRows(new Set());
    setPreviewPage(0);
    setRowFilter("all");
    setNameSearch("");
    setMissingSourceShifts([]);
  }

  function reset() {
    setPaths([]);
    setUrlSourceByPath(new Map());
    setUrlInput("");
    setTrackAutoUpdates(false);
    setIsAutoReimport(false);
      setProcessedKeepManualEdits(null);
    setKeepManualEdits(true);
    cancelPreview();
    setError(null);
  }

  async function handlePickFiles() {
    if (!selectedTemplate) return;
    setError(null);
    const selected = await pickPaymentFiles(selectedTemplate.acceptedFileKinds);
    if (selected.length === 0) return;

    // The OS dialog is already filtered to the template's accepted formats,
    // but that's a soft filter on some platforms (an "all files" toggle is
    // usually still reachable) — checked again here so a mismatched file
    // never silently gets treated as if it matched.
    const suffixes = selectedTemplate.acceptedFileKinds.map((k) => `.${k}`);
    const valid = selected.filter((p) => suffixes.some((s) => p.toLowerCase().endsWith(s)));
    const invalid = selected.filter((p) => !suffixes.some((s) => p.toLowerCase().endsWith(s)));
    if (invalid.length > 0) {
      setError(
        `O template "${selectedTemplate.name}" espera arquivos ${formatFileKindList(selectedTemplate.acceptedFileKinds)}. Ignorado(s) por formato incompatível: ${invalid.map(fileNameFromPath).join(", ")}`,
      );
    }
    if (valid.length > 0) addPaths(valid);
  }

  async function handlePickFolder() {
    if (!selectedTemplate) return;
    setError(null);
    const dir = await pickFolder();
    if (!dir) return;
    const selected = await listDirFiles(dir, selectedTemplate.acceptedFileKinds);
    if (selected.length === 0) {
      setError(
        `Nenhum arquivo ${formatFileKindList(selectedTemplate.acceptedFileKinds)} encontrado na pasta selecionada.`,
      );
      return;
    }
    addPaths(selected);
  }

  /**
   * Shared by "Processar arquivo(s)" (via `proceedToProcess`, when nothing's
   * been downloaded yet) and the remote-update banner's "Reimportar" — there's
   * no standalone "Baixar arquivo" step anymore. A URL download can only
   * ever produce .xlsx/.xls
   * (see `download_payment_file_from_url`'s magic-byte check) — if the
   * selected template expects csv/ods, that's caught here the same way
   * `handlePickFiles` catches a locally-picked file of the wrong format.
   *
   * `templateOverride` exists only for `handleReimportFromUrl`: it just
   * called `setTemplateId`, and `selectedTemplate` (derived from
   * `templateId` by its own effect + an async `getPaymentTemplate` call)
   * hasn't caught up yet by the time this runs — so that caller fetches the
   * template itself and passes it straight through instead of racing state.
   */
  async function handleDownloadFromUrl(
    urlOverride?: string,
    autoProcessAfter = false,
    templateOverride?: PaymentTemplateRow,
  ) {
    const targetUrl = (urlOverride ?? urlInput).trim();
    const template = templateOverride ?? selectedTemplate;
    if (!targetUrl || !template) return;
    setError(null);
    setUrlDownloading(true);
    try {
      const result = await downloadPaymentFileFromUrl(targetUrl);
      if (!template.acceptedFileKinds.includes(result.fileKind)) {
        setError(
          `O template "${template.name}" espera arquivos ${formatFileKindList(template.acceptedFileKinds)}, mas a URL retornou um arquivo ${PAYMENT_FILE_KIND_LABELS[result.fileKind]}.`,
        );
        return;
      }
      setUrlSourceByPath((prev) => {
        const next = new Map(prev);
        next.set(result.path, {
          url: targetUrl,
          fileName: result.fileName,
          etag: result.etag,
          lastModified: result.lastModified,
          contentLength: result.contentLength,
        });
        return next;
      });
      addPaths([result.path]);
      // Manual download: clear the field so the next URL can be typed.
      // Automatic reimport: keep it showing (read-only, see isAutoReimport)
      // — the user asked to still see which file this is, not have the
      // field go blank right after.
      setUrlInput(autoProcessAfter ? targetUrl : "");
      if (autoProcessAfter) setPendingAutoProcess(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setUrlDownloading(false);
    }
  }

  // setPaths/setTemplateId/setPeriodStart/setPeriodEnd from
  // handleReimportFromUrl are async — calling handleProcess() synchronously
  // right after would still see stale state. This waits for paths and
  // template to actually land (fileHashes catches up to paths once its own
  // effect finishes) before firing the process step exactly once. Calls
  // handleProcess() directly, not handleProcessClick() — an automatic
  // reimport replays Período filters that were already confirmed once (at
  // the save they were captured from), so re-asking "processar o arquivo
  // inteiro?" here would just be re-litigating a choice already made.
  useEffect(() => {
    if (pendingAutoProcess && selectedTemplate && paths.length > 0 && fileHashes.size === paths.length) {
      setPendingAutoProcess(false);
      handleProcess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoProcess, selectedTemplate, paths, fileHashes]);

  /**
   * "Never both at once" is normally enforced by disabling the inactive
   * mode's toggle while `paths.length > 0` (see the mode-toggle buttons
   * below) — this bypasses that toggle, so it clears whatever was
   * previously selected/downloaded first, the same way switching modes
   * would require the user to do manually.
   */
  async function handleReimportFromUrl(flag: RemoteUpdateFlag) {
    dismissRemoteUpdate(flag.configId);
    reset();
    setImportMode("url");
    setIsAutoReimport(true);
    // Replays this specific reimport config's Período — already resolved
    // (a relative one as of right now, not a stale cached date) by the
    // context when it built this flag.
    setPeriodStart(flag.resolvedPeriodStart ?? "");
    setPeriodEnd(flag.resolvedPeriodEnd ?? "");
    // Same replay for the config's own choice — not whatever `reset()` just
    // defaulted to.
    setKeepManualEdits(flag.keepManualEdits);

    let fullTemplate = null;
    try {
      fullTemplate = await getPaymentTemplate(flag.templateId);
    } catch {
      // The config's template was deleted since it was created — nothing
      // was actually downloaded automatically, so this falls back to the
      // regular manual flow: leave the URL filled in, but let the user
      // pick a template and take it from there themselves (warning box,
      // editable input and "Baixar arquivo" all need to be back).
      setIsAutoReimport(false);
      setUrlInput(flag.sourceUrl);
      return;
    }
    setTemplateId(String(fullTemplate.id));
    await handleDownloadFromUrl(flag.sourceUrl, true, fullTemplate);
  }

  // "Ir para Importar Pagamentos"/"Reprocessar agora", clicked from a
  // specific reimport config on the Verificação automática page, passes
  // that config's id through navigation state — the whole point is landing
  // here with the reimport already running, not just on the right tab
  // waiting for another click. Built via `getReimportFlag` (not looked up
  // in `remoteUpdates`) so this works the same whether or not a remote
  // change was actually detected — "Reprocessar agora" deliberately
  // reprocesses regardless. `location.state` is cleared right away
  // (`replace`) so this fires exactly once per navigation, not again on a
  // later re-render or on browser back/forward landing back on this same
  // history entry.
  //
  // `handledAutoReimportState` guards against React StrictMode's dev-only
  // double-invoke of this same effect body — the `replace` navigate above
  // is itself async (its cleared state doesn't land until a LATER render),
  // so without this guard both invocations still see the same non-null
  // `configId` and each downloads/adds the file, producing a duplicate
  // entry in `paths`. A ref (not state) survives across the double-invoke
  // and persists across renders, so it's checked BEFORE doing anything.
  const handledAutoReimportState = useRef<unknown>(undefined);
  useEffect(() => {
    if (location.state === handledAutoReimportState.current) return;
    const configId = (location.state as { autoReimportConfigId?: number } | null)?.autoReimportConfigId;
    if (configId === undefined) return;
    handledAutoReimportState.current = location.state;
    navigate(location.pathname, { replace: true, state: null });
    const flag = getReimportFlag(configId);
    if (flag) handleReimportFromUrl(flag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const shiftRows = useMemo(() => fileResults.flatMap((r) => r.rows), [fileResults]);
  const shiftRowFileHash = useMemo(
    () => fileResults.flatMap((r) => r.rows.map(() => r.fileHash)),
    [fileResults],
  );

  // The toolbar's chips both count and filter by these — clicking one sets
  // `rowFilter`, this just decides what actually renders. `idx` still
  // increments for every row regardless of match, since it's the absolute
  // position `selectedRows`/`shiftRows` key off of, not a display index.
  const previewRows = useMemo(() => {
    const query = nameSearch.trim().toLowerCase();
    const out: DisplayRow[] = [];
    let idx = 0;
    for (const result of fileResults) {
      if (result.error) {
        if (!query && (rowFilter === "all" || rowFilter === "error")) {
          out.push({ kind: "error", fileName: result.fileName, message: result.error });
        }
        continue;
      }
      for (const row of result.rows) {
        const matchesFilter =
          rowFilter === "all" ||
          (rowFilter === "selected" ? selectedRows.has(idx) : rowFilter === row.category);
        const matchesName = !query || (row.employee?.name ?? row.nameRaw).toLowerCase().includes(query);
        if (matchesFilter && matchesName) out.push({ kind: "shift", index: idx, row });
        idx++;
      }
    }
    return out;
  }, [fileResults, rowFilter, selectedRows, nameSearch]);

  const categoryCounts = useMemo(() => {
    const counts: Record<RowCategory, number> = {
      valid: 0,
      duplicate: 0,
      deleted: 0,
      "duplicate-in-file": 0,
      "not-found": 0,
      "unresolved-route": 0,
      skipped: 0,
    };
    for (const r of shiftRows) counts[r.category]++;
    return counts;
  }, [shiftRows]);

  const errorCount = fileResults.filter((r) => r.error).length;
  const duplicateCount = categoryCounts.duplicate;
  const deletedCount = categoryCounts.deleted;
  const duplicateInFileCount = categoryCounts["duplicate-in-file"];
  const skippedCount = categoryCounts.skipped;

  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const previewPageItems = useMemo(
    () => previewRows.slice(previewPage * previewPageSize, previewPage * previewPageSize + previewPageSize),
    [previewRows, previewPage, previewPageSize],
  );

  const effectiveKeepManualEdits = processedKeepManualEdits ?? keepManualEdits;
  const isSelectable = (r: PaymentPreviewRow) =>
    Boolean(r.employee) &&
    r.category !== "duplicate-in-file" &&
    !(r.category === "duplicate" && r.matchedEditedManually && effectiveKeepManualEdits);
  const selectableCount = shiftRows.filter(isSelectable).length;
  const allSelected = selectableCount > 0 && shiftRows.every((r, i) => selectedRows.has(i) || !isSelectable(r));

  function toggleRowFilter(category: RowFilter) {
    setRowFilter((prev) => (prev === category ? "all" : category));
    setPreviewPage(0);
  }

  function toggleRow(index: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(shiftRows.flatMap((r, i) => (isSelectable(r) ? [i] : []))));
    }
  }

  const historyPageCount = Math.max(1, Math.ceil(recentFilesTotal / historyPageSize));

  async function handleProcess() {
    if (!selectedTemplate) return;
    setError(null);
    setBusy(true);
    try {
      const results: PaymentFileResult[] = [];
      for (const path of paths) {
        const info = fileHashes.get(path);
        const fileHash = info?.hash ?? path;
        const fileName = info?.fileName ?? path;
        try {
          const applied: AppliedPaymentRow[] = await applyPaymentTemplate(
            path,
            selectedTemplate.groups.map((g) => ({
              sheetNames: g.sheetNames,
              fieldMappings: g.fieldMappings.map(
                (fm) => [fm.columnLetter, fm.targetField] as [string, string],
              ),
            })),
            selectedTemplate.delimiter,
          );

          const rows: PaymentPreviewRow[] = [];
          for (const applied_row of applied) {
            const workDateRaw = applied_row.fields.data ?? "";
            const workDate = workDateRaw
              ? parseDateWithFormat(workDateRaw, selectedTemplate.dateFormat)
              : null;
            const scheduleRaw = applied_row.fields.horario ?? "";
            const parsedSchedule = parseScheduleToMinutes(scheduleRaw);
            const fieldsWithSheet = withSheetNameField(applied_row.fields, applied_row.sheetName);
            const base = {
              fileHash,
              fileName,
              sheetName: applied_row.sheetName,
              rowNumber: applied_row.rowNumber,
              nameRaw: applied_row.fields.nome ?? "",
              local: applied_row.fields.local ?? "",
              role: applied_row.fields.funcao ?? "",
              scheduleRaw,
              scheduleStartMinutes: parsedSchedule?.startMinutes ?? null,
              scheduleEndMinutes: parsedSchedule?.endMinutes ?? null,
              workDateRaw,
              paymentStatus: resolvePaymentStatus(selectedTemplate.statusRules, fieldsWithSheet) ?? "pendente",
              extraFields: applied_row.extraFields,
              // Filled in below, once `findDuplicatePaymentShifts` has actually run against the batch.
              matchedShiftId: null,
              matchedEditedManually: false,
              matchedIdentityChanged: false,
            };

            // No fixed header row anymore — a physical row is only "real
            // data" if its mapped "data" column actually parses as a
            // date. Anything that doesn't (a title, header, or footer
            // row) still shows up here, flagged "skipped", instead of
            // vanishing silently — the toolbar's filter chips are how you
            // double-check nothing real got dropped.
            if (!workDate) {
              rows.push({
                ...base,
                employee: null,
                workDate: null,
                isDuplicate: false,
                unresolvedRoute: false,
                resolvedClientId: null,
                resolvedClientName: null,
                resolvedCompanyId: null,
                resolvedCompanyName: null,
                category: "skipped",
              });
              continue;
            }

            // Optional período filter, same "data" column/formato já
            // usados acima — rows outside it are excluded entirely, not
            // just flagged: the whole point of setting a period is to only
            // bring back what's inside it.
            if ((periodStart && workDate < periodStart) || (periodEnd && workDate > periodEnd)) {
              continue;
            }

            // Which company/client this row belongs to is resolved here,
            // per row, by walking the template's if/else-if/else rule
            // chain — there's no upfront cliente/empresa choice anymore.
            const route = resolvePaymentRoute(selectedTemplate.rules, fieldsWithSheet);
            const cpf = applied_row.fields.cpf || null;
            const matricula = applied_row.fields.matricula || null;
            const nome = applied_row.fields.nome || null;
            const employee = route
              ? await findEmployeeByAttempts(route.clientId, route.companyId, selectedTemplate.identifierPriority, {
                  cpf,
                  matricula,
                  nome,
                })
              : null;
            rows.push({
              ...base,
              employee,
              workDate,
              isDuplicate: false,
              unresolvedRoute: !route,
              resolvedClientId: route?.clientId ?? null,
              resolvedClientName: route?.clientName ?? null,
              resolvedCompanyId: route?.companyId ?? null,
              resolvedCompanyName: route?.companyName ?? null,
              category: !route ? "unresolved-route" : !employee ? "not-found" : "valid",
            });
          }
          results.push({ fileHash, fileName, path, rows, error: null });
        } catch (e) {
          results.push({ fileHash, fileName, path, rows: [], error: String(e) });
        }
      }

      const allRows = results.flatMap((r) => r.rows);
      const candidates = allRows.filter((r) => r.employee);

      // Within this same batch, two candidate rows that agree on every
      // column are the same shift repeated in the source file — only the
      // first stays importable, so "vou importar apenas um" holds even
      // before anything is compared against payment_shifts.
      const seenInBatch = new Set<string>();
      for (const r of candidates) {
        const key = shiftDedupKey(r.employee!.id, r);
        if (seenInBatch.has(key)) {
          r.category = "duplicate-in-file";
        } else {
          seenInBatch.add(key);
        }
      }

      const dbCheckCandidates = candidates.filter((r) => r.category !== "duplicate-in-file");
      const dupMatches = await findDuplicatePaymentShifts(
        dbCheckCandidates.map((r) => ({
          employeeId: r.employee!.id,
          workDate: r.workDate!,
          local: r.local,
          role: r.role,
          scheduleStartMinutes: r.scheduleStartMinutes,
          scheduleEndMinutes: r.scheduleEndMinutes,
        })),
      );
      dupMatches.forEach((match, i) => applyDuplicateMatch(dbCheckCandidates[i], match));

      const defaultSelected = new Set<number>();
      allRows.forEach((r, i) => {
        if (r.category === "valid") defaultSelected.add(i);
      });

      // Missing-from-file detection — the inverse of "excluído", only
      // meaningful for a URL-based import (a locally-picked file has no
      // stable identity to compare a past import against). Runs once every
      // row's own duplicate/deleted match is known (`allRows` above already
      // has `matchedShiftId` filled in by `applyDuplicateMatch`).
      const urlsInBatch = Array.from(
        new Set(results.map((r) => urlSourceByPath.get(r.path)?.url).filter((u): u is string => Boolean(u))),
      );
      const missingRows: (SourceUrlHeadShift & { sourceUrl: string })[] = [];
      if (urlsInBatch.length > 0) {
        const accountedForIds = new Set<number>();
        for (const r of allRows) {
          if (r.matchedShiftId !== null) accountedForIds.add(r.matchedShiftId);
        }
        // A "novo" row (no duplicate match at all) might still be an EDIT of
        // an existing shift's own identity (data/local/função/horário)
        // rather than a genuinely new one — same position-based fallback the
        // automatic deep check uses (`findPaymentShiftByPosition`), so that
        // case isn't double-reported as both "novo" and "sumiu da fonte".
        for (const result of results) {
          const url = urlSourceByPath.get(result.path)?.url;
          if (!url) continue;
          for (const r of result.rows) {
            if (r.category !== "valid" || !r.workDate) continue;
            const positional = await findPaymentShiftByPosition(url, r.sheetName, r.rowNumber);
            if (positional) accountedForIds.add(positional.shiftId);
          }
        }
        const expectedSheetNames = new Set(selectedTemplate.groups.flatMap((g) => g.sheetNames));
        for (const url of urlsInBatch) {
          const heads = await listHeadShiftsForSourceUrl(url, periodStart || null, periodEnd || null);
          for (const h of heads) {
            if (accountedForIds.has(h.shiftId)) continue;
            if (expectedSheetNames.size > 0 && !expectedSheetNames.has(h.sheetName ?? "")) continue;
            missingRows.push({ ...h, sourceUrl: url });
          }
        }
      }

      setFileResults(results);
      setSelectedRows(defaultSelected);
        setProcessedKeepManualEdits(keepManualEdits);
      setPreviewPage(0);
      setRowFilter("all");
      setNameSearch("");
      setMissingSourceShifts(missingRows);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Vincular colaborador" on a "colaborador não encontrado" row: registers
   * the row's raw name as a possível nome for `employee`, then resolves
   * every still-unresolved row in this same batch that shares that exact
   * raw name and client — not just the one clicked, since a repeated name
   * usually means several rows in the same file. Re-runs the same
   * within-batch and payment_shifts duplicate checks `handleProcess` does,
   * scoped to just the newly-resolved rows, so they don't skip that check.
   */
  async function handleLinkEmployee(clickedIndex: number, employee: EmployeeRow) {
    const clicked = shiftRows[clickedIndex];
    if (!clicked || clicked.resolvedClientId === null) return;
    setError(null);
    try {
      await addEmployeeAlias(employee.id, clicked.nameRaw);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      return;
    }

    const targetNameRaw = clicked.nameRaw.trim().toLowerCase();
    const allRows = fileResults.flatMap((r) => r.rows);

    // Every already-resolved candidate in the whole batch, so newly-linked
    // rows are checked against rows that were "valid"/"duplicate" before
    // this link too, not just against each other.
    const seenInBatch = new Set<string>();
    for (const r of allRows) {
      if (r.employee) seenInBatch.add(shiftDedupKey(r.employee.id, r));
    }

    const newlyResolved = allRows.filter(
      (r) =>
        r.category === "not-found" &&
        r.resolvedClientId === clicked.resolvedClientId &&
        r.resolvedCompanyId === clicked.resolvedCompanyId &&
        r.nameRaw.trim().toLowerCase() === targetNameRaw,
    );

    const dbCheckTargets: PaymentPreviewRow[] = [];
    for (const r of newlyResolved) {
      r.employee = employee;
      const key = shiftDedupKey(employee.id, r);
      if (seenInBatch.has(key)) {
        r.category = "duplicate-in-file";
      } else {
        seenInBatch.add(key);
        r.category = "valid";
        dbCheckTargets.push(r);
      }
    }

    if (dbCheckTargets.length > 0) {
      const dupMatches = await findDuplicatePaymentShifts(
        dbCheckTargets.map((r) => ({
          employeeId: employee.id,
          workDate: r.workDate!,
          local: r.local,
          role: r.role,
          scheduleStartMinutes: r.scheduleStartMinutes,
          scheduleEndMinutes: r.scheduleEndMinutes,
        })),
      );
      dupMatches.forEach((match, i) => applyDuplicateMatch(dbCheckTargets[i], match));
    }

    setSelectedRows((prev) => {
      const next = new Set(prev);
      allRows.forEach((r, i) => {
        if (newlyResolved.includes(r) && r.category === "valid") next.add(i);
      });
      return next;
    });
    setFileResults([...fileResults]);
  }

  /**
   * Runs once, only on a mount restored from "Cadastrar colaborador" (see
   * `PaymentImportNavState`) — a colaborador registered there gets a fresh
   * `employees` row with exactly the raw name this preview already has on
   * the row (`prefillName`), but the preview itself was captured BEFORE
   * that row existed, so it still shows "não encontrado" unless it's
   * explicitly re-checked against the database on the way back. Matches
   * purely by name (like "Vincular colaborador"'s alias match), not the
   * template's own `identifierPriority` — there's no raw cpf/matrícula left
   * on a preview row to replay through it, only `nameRaw`.
   */
  async function reresolveNotFoundRows(currentFileResults: PaymentFileResult[]) {
    const allRows = currentFileResults.flatMap((r) => r.rows);
    const notFound = allRows.filter(
      (r) => r.category === "not-found" && r.resolvedClientId !== null && r.resolvedCompanyId !== null,
    );
    if (notFound.length === 0) return;

    const seenInBatch = new Set<string>();
    for (const r of allRows) {
      if (r.employee) seenInBatch.add(shiftDedupKey(r.employee.id, r));
    }

    const nameAttempt: IdentifierAttempt[] = [{ fields: ["nome"], caseInsensitive: true }];
    const dbCheckTargets: PaymentPreviewRow[] = [];
    for (const r of notFound) {
      const employee = await findEmployeeByAttempts(r.resolvedClientId!, r.resolvedCompanyId!, nameAttempt, {
        cpf: null,
        matricula: null,
        nome: r.nameRaw,
      });
      if (!employee) continue;
      r.employee = employee;
      const key = shiftDedupKey(employee.id, r);
      if (seenInBatch.has(key)) {
        r.category = "duplicate-in-file";
      } else {
        seenInBatch.add(key);
        r.category = "valid";
        dbCheckTargets.push(r);
      }
    }
    if (dbCheckTargets.length === 0) return;

    const dupMatches = await findDuplicatePaymentShifts(
      dbCheckTargets.map((r) => ({
        employeeId: r.employee!.id,
        workDate: r.workDate!,
        local: r.local,
        role: r.role,
        scheduleStartMinutes: r.scheduleStartMinutes,
        scheduleEndMinutes: r.scheduleEndMinutes,
      })),
    );
    dupMatches.forEach((match, i) => applyDuplicateMatch(dbCheckTargets[i], match));

    setSelectedRows((prev) => {
      const next = new Set(prev);
      allRows.forEach((r, i) => {
        if (dbCheckTargets.includes(r) && r.category === "valid") next.add(i);
      });
      return next;
    });
    setFileResults([...currentFileResults]);
  }

  useEffect(() => {
    if (restored?.fileResults?.length) reresolveNotFoundRows(restored.fileResults);
    // Only on this exact mount, from a "Cadastrar colaborador" restore —
    // `fileResults`/`restored` deliberately excluded, see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * "Cadastrar colaborador" on a "colaborador não encontrado" row: this
   * preview took real processing to build (file reads, DB lookups), so
   * instead of losing it, it's attached to this page's own history entry
   * first — `navigate(-1)` from the cadastro form (see `BackButton`) then
   * pops back to this exact state instead of a blank page.
   */
  function handleRegisterEmployee(row: PaymentPreviewRow) {
    const snapshot: PaymentImportNavState = {
      templateId,
      periodStart,
      periodEnd,
      paths,
      importMode,
      urlSourceByPath,
      fileResults,
      selectedRows,
      rowFilter,
      nameSearch,
      previewPage,
      previewPageSize,
      keepManualEdits: processedKeepManualEdits ?? keepManualEdits,
    };
    navigate(".", { replace: true, state: snapshot });
    // The row's routing rule already resolved exactly which cliente/empresa
    // this colaborador belongs to — hand that off too instead of leaving
    // it to be picked blind.
    const employeeFormState: EmployeeFormNavState = {
      prefillName: row.nameRaw,
      prefillClientId: row.resolvedClientId ?? undefined,
      prefillCompanyId: row.resolvedCompanyId ?? undefined,
    };
    navigate("/employees/new", { state: employeeFormState });
  }

  /** Shared by "Processar arquivo(s)" and the "processar o arquivo inteiro?" confirm — in URL mode, nothing's been downloaded yet the first time this runs (there's no separate "Baixar arquivo" step anymore), so it downloads first, then falls into the same `pendingAutoProcess` effect "Reimportar" already uses to process right after. Already-downloaded paths (local files, or a URL reprocessed after an error) skip straight to processing. */
  async function proceedToProcess() {
    if (importMode === "url" && paths.length === 0) {
      await handleDownloadFromUrl(undefined, true);
      return;
    }
    handleProcess();
  }

  /** No período set means "the whole file" — that's easy to do by accident, so it's confirmed instead of just silently processing everything. */
  function handleProcessClick() {
    if (!periodStart && !periodEnd) {
      setConfirmFullImport(true);
      return;
    }
    proceedToProcess();
  }

  async function handleSave() {
    if (!selectedTemplate) return;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const sourceFileIdByHash = new Map<string, number>();
      for (const result of fileResults) {
        const provenance = urlSourceByPath.get(result.path);
        const sourceFileId = await logSourceFile({
          fileHash: result.fileHash,
          fileName: result.fileName,
          pageCount: 1,
          provider: selectedTemplate.name,
          importType: "payment",
          status: result.error ? "error" : "success",
          errorMessage: result.error,
          originalPdfPath: "",
          sourceUrl: provenance?.url ?? null,
          sourceEtag: provenance?.etag ?? null,
          sourceLastModified: provenance?.lastModified ?? null,
          sourceContentLength: provenance?.contentLength ?? null,
        });
        sourceFileIdByHash.set(result.fileHash, sourceFileId);
      }

      const shiftInputs: PaymentShiftInput[] = [];
      const savedFileHashes = new Set<string>();
      for (let i = 0; i < shiftRows.length; i++) {
        if (!selectedRows.has(i)) continue;
        const row = shiftRows[i];
        if (!row.employee || row.workDate === null) continue;
        const fileHash = shiftRowFileHash[i];
        shiftInputs.push({
          employeeId: row.employee.id,
          templateId: selectedTemplate.id,
          sourceFileId: sourceFileIdByHash.get(fileHash) ?? null,
          local: row.local,
          workDate: row.workDate,
          role: row.role,
          scheduleStartMinutes: row.scheduleStartMinutes,
          scheduleEndMinutes: row.scheduleEndMinutes,
          status: row.paymentStatus,
          extraData: buildExtraData(row),
          sourceRowNumber: row.rowNumber,
          sourceSheetName: row.sheetName,
          // "duplicate"/"deleted" rows are reprocessing an existing shift, not
          // creating an independent new one — links this new row back to the
          // current one it supersedes (see `findDuplicatePaymentShifts`), same
          // append-only pattern as "Fazer pagamento"/"Editar valor". For
          // "deleted" this is also what "restores" it: the new row isn't
          // itself deleted, so it becomes the head again (see
          // `deletePaymentShift`/`HEAD_SHIFT_CONDITION`). A protected
          // "duplicate" match (edited_manually + keepManualEdits snapshot)
          // never gets here selected in the first place — the checkbox is
          // disabled for those (see `canSelect` above); "deleted" is never
          // protected that way, only ever unselected by default.
          previousShiftId: row.category === "duplicate" || row.category === "deleted" ? row.matchedShiftId : null,
        });
        savedFileHashes.add(fileHash);
      }
      await savePaymentShifts(shiftInputs);
      for (const fileHash of savedFileHashes) {
        await markSourceFileSaved(fileHash);
      }

      // A URL not yet tracked becomes tracked — with its first reimport
      // config, from what this save just used — only if "Rastrear
      // atualizações automaticamente" is checked; tracking is never
      // created as a side effect on its own. A URL that's ALREADY tracked
      // is left alone UNLESS this save's own template+período combination
      // doesn't match any of its existing reimport configs — in that case
      // this save adds itself as a new config alongside the others (still
      // never editing/overwriting one that's already there, and never
      // adding a duplicate of one that already matches).
      if (trackAutoUpdates) {
        const savedUrls = new Set(
          fileResults.map((r) => urlSourceByPath.get(r.path)?.url).filter((u): u is string => Boolean(u)),
        );
        const resolvedPeriodStart = periodStart || null;
        const resolvedPeriodEnd = periodEnd || null;
        for (const url of savedUrls) {
          const alreadyTracked = trackedFiles.some((t) => t.sourceUrl === url);
          if (!alreadyTracked) {
            await trackUrl(url, selectedTemplate.id, resolvedPeriodStart, resolvedPeriodEnd, effectiveKeepManualEdits);
            continue;
          }
          const matchesExistingConfig = reimportConfigs.some(
            (c) =>
              c.sourceUrl === url &&
              c.templateId === selectedTemplate.id &&
              c.dateMode === "fixed" &&
              c.periodStart === resolvedPeriodStart &&
              c.periodEnd === resolvedPeriodEnd,
          );
          if (!matchesExistingConfig) {
            await addReimportConfig({
              sourceUrl: url,
              label: "",
              templateId: selectedTemplate.id,
              dateMode: "fixed",
              periodStart: resolvedPeriodStart,
              periodEnd: resolvedPeriodEnd,
              startOffsetDays: null,
              endOffsetDays: null,
              checkIntervalMinutes: DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
              keepManualEdits: effectiveKeepManualEdits,
              autoApplyEnabled: false,
              autoApplyOverwriteManualEdits: true,
              autoApplyOverwritePaid: false,
            });
          }
        }
      }

      refreshRecentFiles();
      reset();
      setSuccessMessage(
        shiftInputs.length === 1
          ? "1 turno importado com sucesso."
          : `${shiftInputs.length} turnos importados com sucesso.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/import" className="back-link">
        <ArrowLeft size={14} />
        Importar
      </Link>
      <div className="page-header">
        <h2>Importar pagamentos</h2>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <button type="button" className="outline" onClick={() => setHistoryOpen(true)}>
            <History size={15} style={{ marginRight: "0.4rem" }} />
            Histórico
          </button>
          <button type="button" className="secondary" onClick={() => navigate("/import/payments/templates")}>
            <Settings2 size={15} style={{ marginRight: "0.4rem" }} />
            Gerenciar templates
          </button>
        </div>
      </div>
      <p className="page-subtitle">
        Aplique um template já cadastrado a um arquivo de pagamentos (CSV, Excel ou ODS) e
        associe cada linha ao colaborador correspondente.
      </p>

      {error && <div className="error-box">{error}</div>}
      {successMessage && <div className="success-box">{successMessage}</div>}

      <div className="import-layout" style={{ display: "block" }}>
        <div className="import-main">
          <div className="card">
            <div className="field-row" style={{ marginBottom: "1.2rem" }}>
              <div className="field" style={{ flex: "1 1 280px", maxWidth: "24rem" }}>
                <label htmlFor="payment-template">Template</label>
                <select
                  id="payment-template"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  disabled={templates.length === 0}
                >
                  <option value="">Selecione um template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {templates.length === 0 ? (
                  <p className="field-hint">
                    Nenhum template disponível.{" "}
                    <Link to="/import/payments/templates">Cadastre um template</Link>.
                  </p>
                ) : (
                  <p className="field-hint">
                    Como as colunas do arquivo serão lidas, e as regras que decidem a Empresa/Cliente
                    de cada linha.
                  </p>
                )}
              </div>

              <div className="field" style={{ flex: "1 1 240px", maxWidth: "24rem" }}>
                <label>Período (opcional)</label>
                <DateRangePicker
                  startValue={periodStart}
                  endValue={periodEnd}
                  onChange={(start, end) => {
                    setPeriodStart(start);
                    setPeriodEnd(end);
                  }}
                />
                <p className="field-hint">
                  Filtra pela coluna de data do template. Deixe em branco para processar o relatório
                  inteiro.
                </p>
              </div>
            </div>

            <div className="field" style={{ maxWidth: "28rem", marginBottom: "1.2rem" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={keepManualEdits}
                  onChange={(e) => setKeepManualEdits(e.target.checked)}
                  style={{ marginTop: "0.2rem" }}
                />
                <span>
                  Manter registros atualizados manualmente
                  <span className="muted" style={{ display: "block", fontSize: "0.78rem" }}>
                    Uma linha duplicada de um turno já pago, revertido ou com valor corrigido à mão
                    não é reprocessada — o registro manual continua sendo o vigente.
                  </span>
                </span>
              </label>
            </div>

            <div className="field">
              <label>Arquivos de pagamento</label>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.8rem" }}>
                <button
                  type="button"
                  className={`badge neutral chip-filter${importMode === "local" ? " active" : ""}`}
                  onClick={() => setImportMode("local")}
                  disabled={importMode !== "local" && paths.length > 0}
                  title={
                    importMode !== "local" && paths.length > 0
                      ? "Remova os arquivos selecionados para trocar o modo de importação."
                      : undefined
                  }
                >
                  <FolderOpen size={13} style={{ marginRight: "0.3rem" }} />
                  Arquivo local
                </button>
                <button
                  type="button"
                  className={`badge neutral chip-filter${importMode === "url" ? " active" : ""}`}
                  onClick={() => setImportMode("url")}
                  disabled={importMode !== "url" && paths.length > 0}
                  title={
                    importMode !== "url" && paths.length > 0
                      ? "Remova os arquivos selecionados para trocar o modo de importação."
                      : undefined
                  }
                >
                  <Link2 size={13} style={{ marginRight: "0.3rem" }} />
                  URL
                </button>
              </div>

              {importMode === "local" ? (
                <div className="dropzone">
                  <div className="dropzone-icon">
                    <FileText size={20} />
                  </div>
                  <h4>Selecione os arquivos</h4>
                  <p className="muted" style={{ margin: 0 }}>
                    {selectedTemplate
                      ? `Formatos aceitos: ${formatFileKindList(selectedTemplate.acceptedFileKinds)} — suporta múltiplos arquivos.`
                      : "Selecione um template para saber os formatos aceitos."}
                  </p>
                  <PickFilesButton
                    onPickFiles={handlePickFiles}
                    onPickFolder={handlePickFolder}
                    disabled={!selectedTemplate}
                    title={selectedTemplate ? undefined : "Selecione um template primeiro"}
                  />
                </div>
              ) : (
                <>
                  {!isAutoReimport && (
                    <div className="warning-box">
                      <AlertTriangle size={14} style={{ verticalAlign: "-2px", marginRight: "0.4rem" }} />
                      Apenas arquivos do Microsoft Office (.xlsx, .xls) ou OpenDocument (.ods) são
                      suportados por URL. O link precisa ser de download direto e anônimo — não pode
                      exigir login.
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.8rem" }}>
                    <input
                      type="url"
                      placeholder="https://exemplo.com/arquivo.xlsx"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      disabled={urlDownloading || isAutoReimport}
                      title={isAutoReimport ? "Arquivo desta reimportação automática — não editável aqui." : undefined}
                      style={{ flex: 1 }}
                    />
                    {isAutoReimport && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={reset}
                        title="Sai da reimportação automática e libera a tela para importar outro arquivo"
                      >
                        Processar outro arquivo
                      </button>
                    )}
                  </div>
                  {!isAutoReimport && (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "0.5rem",
                        marginTop: "0.8rem",
                        fontSize: "0.85rem",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={trackAutoUpdates}
                        onChange={(e) => setTrackAutoUpdates(e.target.checked)}
                        style={{ marginTop: "0.2rem" }}
                      />
                      <span>
                        Salvar em Verificação automática
                        <span className="muted" style={{ display: "block", fontSize: "0.78rem" }}>
                          Guarda esse link na tela "Verificação automática", pra não perder de vista —
                          de lá dá pra acompanhar mudanças, reimportar manualmente ou deixar
                          atualizando sozinho. Só se aplica ao salvar; sem isso, esse link não fica
                          guardado em lugar nenhum.
                        </span>
                      </span>
                    </label>
                  )}
                </>
              )}

              {paths.length > 0 && (
                <div className="file-list">
                  {pagedPaths.map((p) => {
                    const info = fileHashes.get(p);
                    const provenance = urlSourceByPath.get(p);
                    return (
                      <div className="file-row" key={p}>
                        <div className="file-row-icon">
                          <FileText size={18} />
                        </div>
                        <div className="file-row-info">
                          <div className="file-name">
                            {info?.fileName ? safeDecodeFileName(info.fileName) : p}
                            {/* Redundant once the URL is already shown, read-only, right above
                                (the auto-reimport case) — only worth a hover hint here when
                                this row is the only place the source URL shows at all. */}
                            {provenance && !isAutoReimport && (
                              <Link2
                                size={12}
                                style={{ marginLeft: "0.4rem", opacity: 0.6, verticalAlign: "-1px" }}
                                aria-label={provenance.url}
                              >
                                <title>{provenance.url}</title>
                              </Link2>
                            )}
                          </div>
                        </div>
                        <div className="file-row-actions">
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.3rem" }}
                            onClick={() => removePath(p)}
                            aria-label="Remover"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {paths.length > PATHS_PAGE_SIZE_OPTIONS[0] && (
                <Pagination
                  page={pathsPage}
                  pageCount={pathsPageCount}
                  onPageChange={setPathsPage}
                  rangeLabel={`Mostrando ${pathsPage * pathsPageSize + 1} a ${Math.min(
                    paths.length,
                    pathsPage * pathsPageSize + pathsPageSize,
                  )} de ${paths.length}`}
                  pageSize={pathsPageSize}
                  pageSizeOptions={PATHS_PAGE_SIZE_OPTIONS}
                  onPageSizeChange={(size) => {
                    setPathsPageSize(size);
                    setPathsPage(0);
                  }}
                />
              )}
            </div>

            <div className="card-footer">
              <button
                type="button"
                disabled={
                  (importMode === "url" ? !urlInput.trim() : paths.length === 0) ||
                  !templateId ||
                  busy ||
                  urlDownloading
                }
                onClick={handleProcessClick}
              >
                {urlDownloading ? "Baixando..." : busy ? "Processando..." : `Processar ${paths.length || ""} arquivo(s)`}
              </button>
            </div>
          </div>

          {fileResults.length > 0 && (
            <>
              <div className="card card-flush">
                <div className="page-header" style={{ marginBottom: 0, alignItems: "flex-end" }}>
                  <div>
                    <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Eye size={18} />
                      Pré-visualização da Importação
                    </h3>
                    {duplicateCount > 0 || deletedCount > 0 ? (
                      <p className="muted" style={{ maxWidth: "42rem" }}>
                        Algumas linhas batem, em todas as colunas, com um turno já salvo
                        {deletedCount > 0 && " (ou já removido)"} — marque a linha se quiser
                        reprocessar (importar de novo) mesmo assim.
                      </p>
                    ) : (
                      <p className="muted">Revise os dados antes de confirmar.</p>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "0.6rem", flexShrink: 0 }}>
                    <button type="button" className="outline" onClick={cancelPreview} disabled={busy}>
                      Cancelar
                    </button>
                    <button type="button" onClick={handleSave} disabled={busy || selectedRows.size === 0}>
                      {busy ? "Salvando..." : `Salvar (${selectedRows.size})`}
                    </button>
                  </div>
                </div>
              </div>

              {missingSourceShifts.length > 0 && (
                <div className="warning-box">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.85rem" }}>
                    <AlertTriangle size={14} />
                    {missingSourceShifts.length} turno(s) que estavam neste arquivo não aparecem mais nesta leitura
                  </div>
                  <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}>
                    Esses turnos já foram importados dessa mesma fonte antes, mas nenhuma linha da leitura atual bate
                    com eles — pode ser que a linha tenha sido removida no arquivo. Revise e marque como excluído se
                    for o caso.
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginTop: "0.5rem" }}>
                    {missingSourceShifts.map((m) => (
                      <div
                        key={m.shiftId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "0.6rem",
                          fontSize: "0.8rem",
                          padding: "0.35rem 0",
                          borderTop: "1px solid rgba(251, 191, 36, 0.25)",
                        }}
                      >
                        <div>
                          <strong>{m.employeeName}</strong> — {formatDate(m.workDate)} · {m.local || "—"} /{" "}
                          {m.role || "—"}
                          {m.scheduleStartMinutes !== null && m.scheduleEndMinutes !== null && (
                            <>
                              {" · "}
                              {formatMinutesAsTime(m.scheduleStartMinutes)} –{" "}
                              {formatMinutesAsTime(m.scheduleEndMinutes)}
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          className="ghost"
                          style={{ fontSize: "0.76rem", padding: "0.25rem 0.5rem", flexShrink: 0 }}
                          disabled={markingMissingShiftId === m.shiftId}
                          onClick={() => handleMarkMissingShiftDeleted(m.shiftId)}
                        >
                          <Trash2 size={12} style={{ verticalAlign: "-1px", marginRight: "0.3rem" }} />
                          {markingMissingShiftId === m.shiftId ? "Marcando…" : "Marcar como excluído"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="card table-card">
                <div className="table-toolbar">
                  <div className="counts">
                    <button
                      type="button"
                      className={`badge ok chip-filter${rowFilter === "selected" ? " active" : ""}`}
                      onClick={() => toggleRowFilter("selected")}
                      title="Linhas marcadas — vão ser importadas ao salvar. Clique para filtrar."
                    >
                      {selectedRows.size} a importar
                    </button>
                    <button
                      type="button"
                      className={`badge info chip-filter${rowFilter === "valid" ? " active" : ""}`}
                      onClick={() => toggleRowFilter("valid")}
                      title="Colaborador encontrado, sem turno igual já importado. Clique para filtrar."
                    >
                      {categoryCounts.valid} novo(s)
                    </button>
                    {duplicateCount > 0 && (
                      <button
                        type="button"
                        className={`badge overwrite chip-filter${rowFilter === "duplicate" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("duplicate")}
                        title="Todas as colunas batem com um turno já salvo. Clique para filtrar."
                      >
                        {duplicateCount} já importado(s)
                      </button>
                    )}
                    {deletedCount > 0 && (
                      <button
                        type="button"
                        className={`count-chip chip-filter${rowFilter === "deleted" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("deleted")}
                        title="Esse turno foi removido no sistema. Clique para filtrar."
                      >
                        {deletedCount} excluído(s)
                      </button>
                    )}
                    {duplicateInFileCount > 0 && (
                      <button
                        type="button"
                        className={`count-chip chip-filter${rowFilter === "duplicate-in-file" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("duplicate-in-file")}
                        title="Idêntica a outra linha já importável deste mesmo arquivo. Clique para filtrar."
                      >
                        {duplicateInFileCount} duplicado(s) no arquivo
                      </button>
                    )}
                    {categoryCounts["not-found"] > 0 && (
                      <button
                        type="button"
                        className={`badge warn chip-filter${rowFilter === "not-found" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("not-found")}
                        title="Clique para filtrar"
                      >
                        {categoryCounts["not-found"]} colaborador não encontrado
                      </button>
                    )}
                    {categoryCounts["unresolved-route"] > 0 && (
                      <button
                        type="button"
                        className={`badge warn chip-filter${rowFilter === "unresolved-route" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("unresolved-route")}
                        title="Clique para filtrar"
                      >
                        {categoryCounts["unresolved-route"]} empresa/cliente não definido
                      </button>
                    )}
                    {skippedCount > 0 && (
                      <button
                        type="button"
                        className={`count-chip chip-filter${rowFilter === "skipped" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("skipped")}
                        title="Linhas sem uma data válida na coluna mapeada — presumidas título, cabeçalho ou rodapé. Clique para filtrar."
                      >
                        {skippedCount} linha(s) ignorada(s)
                      </button>
                    )}
                    {errorCount > 0 && (
                      <button
                        type="button"
                        className={`badge file-error chip-filter${rowFilter === "error" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("error")}
                        title="Clique para filtrar"
                      >
                        {errorCount} erro(s)
                      </button>
                    )}
                  </div>
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <Search
                      size={14}
                      style={{
                        position: "absolute",
                        left: "0.65rem",
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: "var(--text-muted)",
                      }}
                    />
                    <input
                      type="text"
                      value={nameSearch}
                      onChange={(e) => {
                        setNameSearch(e.target.value);
                        setPreviewPage(0);
                      }}
                      placeholder="Buscar por nome..."
                      style={{ paddingLeft: "2rem", width: "13rem" }}
                    />
                  </div>
                </div>

                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="checkbox-cell">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            disabled={selectableCount === 0}
                            aria-label="Selecionar todos"
                          />
                        </th>
                        <th>Linha</th>
                        <th>Colaborador</th>
                        <th>Empresa</th>
                        <th>Cliente</th>
                        <th>Local</th>
                        <th>Data</th>
                        <th>Função</th>
                        <th>Horário</th>
                        <th>Status pgto.</th>
                        <th>Status</th>
                        <th>Vincular</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.length === 0 && rowFilter !== "all" && (
                        <tr>
                          <td colSpan={12} className="muted" style={{ textAlign: "center", padding: "1.4rem" }}>
                            Nenhuma linha nesta categoria.
                          </td>
                        </tr>
                      )}
                      {previewPageItems.map((item, i) => {
                        if (item.kind === "error") {
                          return (
                            <tr key={`error-${i}`} className="row-error">
                              <td className="checkbox-cell">
                                <input type="checkbox" disabled aria-label="Não disponível" />
                              </td>
                              <td colSpan={10}>
                                <div className="file-name">{safeDecodeFileName(item.fileName)}</div>
                                <div className="muted">{item.message}</div>
                              </td>
                              <td>
                                <span className="badge file-error">
                                  <AlertCircle size={13} />
                                  Erro no arquivo
                                </span>
                              </td>
                            </tr>
                          );
                        }

                        const { row, index } = item;
                        // A duplicate whose current match was edited by hand (Fazer
                        // pagamento/Voltar para pendente/Editar valor) and the
                        // "Manter registros atualizados manualmente" setting is on
                        // — reprocessing it would be a no-op at save time, so it's
                        // not offered as selectable in the first place, instead of a
                        // checkbox that silently does nothing once checked.
                        const protectedByManualEdit =
                          row.category === "duplicate" && row.matchedEditedManually && effectiveKeepManualEdits;
                        const canSelect =
                          Boolean(row.employee) && row.category !== "duplicate-in-file" && !protectedByManualEdit;
                        return (
                          <tr key={index}>
                            <td className="checkbox-cell">
                              <input
                                type="checkbox"
                                checked={selectedRows.has(index)}
                                onChange={() => toggleRow(index)}
                                disabled={!canSelect}
                                title={
                                  protectedByManualEdit
                                    ? 'Este turno foi atualizado manualmente e está protegido contra reprocessamento — desative "Manter registros atualizados manualmente" acima para permitir.'
                                    : undefined
                                }
                                aria-label={`Selecionar linha ${row.rowNumber}`}
                              />
                            </td>
                            <td>
                              {row.rowNumber}
                              {row.sheetName && <div className="muted" style={{ fontSize: "0.78rem" }}>{row.sheetName}</div>}
                            </td>
                            <td>
                              {row.employee ? (
                                <div className="person-cell">
                                  <Avatar name={row.employee.name} />
                                  {row.employee.name}
                                </div>
                              ) : (
                                <span className="muted" title={row.nameRaw ? "Nome lido da planilha, mas não encontrado no cadastro" : undefined}>
                                  {row.nameRaw || "—"}
                                </span>
                              )}
                            </td>
                            <td>{row.resolvedCompanyName ?? <span className="muted">—</span>}</td>
                            <td>{row.resolvedClientName ?? <span className="muted">—</span>}</td>
                            <td>{row.local}</td>
                            <td>
                              {row.workDate ? (
                                formatDate(row.workDate)
                              ) : (
                                <span className="muted" title="Data não reconhecida">
                                  {row.workDateRaw || "—"}
                                </span>
                              )}
                            </td>
                            <td>{row.role}</td>
                            <td>
                              {row.scheduleStartMinutes !== null && row.scheduleEndMinutes !== null ? (
                                `${formatMinutesAsTime(row.scheduleStartMinutes)} – ${formatMinutesAsTime(row.scheduleEndMinutes)}`
                              ) : (
                                <span className="muted" title="Horário não reconhecido">
                                  {row.scheduleRaw || "—"}
                                </span>
                              )}
                            </td>
                            <td>
                              <span className={PAYMENT_STATUS_BADGE_CLASS[row.paymentStatus]}>
                                {PAYMENT_SHIFT_STATUS_LABELS[row.paymentStatus]}
                              </span>
                            </td>
                            <td>
                              {row.category === "valid" && (
                                <span className="badge ok">
                                  <PlusCircle size={13} />
                                  Novo
                                </span>
                              )}
                              {row.category === "duplicate" &&
                                (protectedByManualEdit ? (
                                  <span
                                    className="badge info"
                                    title={
                                      row.matchedIdentityChanged
                                        ? "Esse turno foi atualizado manualmente (Data/Local/Função/Horário não batem mais com esta planilha) — reprocessar não vai sobrescrevê-lo."
                                        : "Todas as colunas batem com um turno já salvo, mas esse turno foi atualizado manualmente — reprocessar não vai sobrescrevê-lo."
                                    }
                                  >
                                    <AlertTriangle size={13} />
                                    {row.matchedIdentityChanged ? "Dados alterados manualmente — mantido" : "Editado manualmente — mantido"}
                                  </span>
                                ) : selectedRows.has(index) ? (
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Será reprocessado
                                  </span>
                                ) : (
                                  <span
                                    className="badge overwrite"
                                    title={
                                      row.matchedIdentityChanged
                                        ? "Esse turno foi atualizado manualmente (Data/Local/Função/Horário não batem mais com esta planilha). Marque a linha para reprocessar (importar de novo) mesmo assim."
                                        : "Todas as colunas batem com um turno já salvo. Marque a linha para reprocessar (importar de novo)."
                                    }
                                  >
                                    <AlertTriangle size={13} />
                                    Já importado
                                  </span>
                                ))}
                              {row.category === "deleted" &&
                                (selectedRows.has(index) ? (
                                  <span className="badge warn">
                                    <Trash2 size={13} />
                                    Será restaurado
                                  </span>
                                ) : (
                                  <span
                                    className="badge neutral"
                                    title="Esse turno foi removido no sistema (Remover, na tela de Pagamentos). Marque a linha para importar de novo (restaurar) mesmo assim."
                                  >
                                    <Trash2 size={13} />
                                    Excluído anteriormente
                                  </span>
                                ))}
                              {row.category === "duplicate-in-file" && (
                                <span
                                  className="badge neutral"
                                  title="Idêntico a outra linha deste mesmo arquivo — só a primeira ocorrência é importável."
                                >
                                  Duplicado no arquivo
                                </span>
                              )}
                              {row.category === "unresolved-route" && (
                                <div style={{ marginBottom: "0.3rem" }}>
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Empresa/cliente não definido
                                  </span>
                                  <div style={{ marginTop: "0.25rem" }}>
                                    <Link to="/import/payments/templates" style={{ fontSize: "0.78rem" }}>
                                      Editar regras do template
                                    </Link>
                                  </div>
                                </div>
                              )}
                              {row.category === "not-found" && (
                                <div style={{ marginBottom: "0.3rem" }}>
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Colaborador não encontrado
                                  </span>
                                  <div style={{ marginTop: "0.25rem" }}>
                                    <button
                                      type="button"
                                      className="link-button"
                                      style={{ fontSize: "0.78rem" }}
                                      onClick={() => handleRegisterEmployee(row)}
                                    >
                                      Cadastrar colaborador
                                    </button>
                                  </div>
                                </div>
                              )}
                              {row.category === "skipped" && (
                                <span className="badge neutral" title="A coluna mapeada como Data não pôde ser interpretada nesta linha">
                                  Data não reconhecida
                                </span>
                              )}
                            </td>
                            <td>
                              {row.category === "not-found" &&
                                row.resolvedClientId !== null &&
                                row.resolvedCompanyId !== null && (
                                  <EmployeePicker
                                    clientId={row.resolvedClientId}
                                    companyId={row.resolvedCompanyId}
                                    onSelect={(employee) => handleLinkEmployee(index, employee)}
                                    placeholder="Vincular"
                                  />
                                )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {previewRows.length > PREVIEW_PAGE_SIZE_OPTIONS[0] && (
                  <Pagination
                    page={previewPage}
                    pageCount={previewPageCount}
                    onPageChange={setPreviewPage}
                    rangeLabel={`Mostrando ${previewPage * previewPageSize + 1} a ${Math.min(
                      previewRows.length,
                      previewPage * previewPageSize + previewPageSize,
                    )} de ${previewRows.length}`}
                    pageSize={previewPageSize}
                    pageSizeOptions={PREVIEW_PAGE_SIZE_OPTIONS}
                    onPageSizeChange={(size) => {
                      setPreviewPageSize(size);
                      setPreviewPage(0);
                    }}
                  />
                )}
              </div>
            </>
          )}
        </div>

      </div>

      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="Histórico de importações">
            {!(recentFilesTotal === 0 && !historySearch.trim()) && (
              <div className="field" style={{ marginBottom: "0.8rem" }}>
                <div style={{ position: "relative" }}>
                  <Search
                    size={14}
                    style={{
                      position: "absolute",
                      left: "0.65rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--text-muted)",
                    }}
                  />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => {
                      setHistorySearch(e.target.value);
                      setHistoryPage(0);
                    }}
                    placeholder="Buscar por nome do arquivo..."
                    style={{ width: "100%", paddingLeft: "2rem" }}
                  />
                </div>
              </div>
            )}

            {recentFilesTotal === 0 && !historySearch.trim() && (
              <p className="muted">Nenhum arquivo importado ainda.</p>
            )}
            {recentFilesTotal === 0 && historySearch.trim() && (
              <p className="muted">Nenhum arquivo encontrado.</p>
            )}

            {recentFilesTotal > 0 && (
              <div className="file-list">
                {recentFiles.map((f) => {
                  const badge = STATUS_BADGE[f.status];
                  const BadgeIcon = badge.icon;
                  return (
                    <div className="file-row" key={f.id}>
                      <div className="file-row-icon">
                        <FileText size={18} />
                      </div>
                      <div className="file-row-info">
                        <div className="file-name" title={f.fileName}>
                          {safeDecodeFileName(f.fileName)}
                        </div>
                        {f.sourceUrl && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => openUrl(f.sourceUrl!)}
                            title={
                              f.checkDisabled
                                ? `Verificação automática desativada — ${f.sourceUrl}`
                                : `Verificação automática de atualização ativa — ${f.sourceUrl}`
                            }
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.3rem",
                              marginTop: "0.15rem",
                              maxWidth: "100%",
                              fontSize: "0.78rem",
                              opacity: f.checkDisabled ? 0.55 : 1,
                            }}
                          >
                            <Link2 size={12} style={{ flexShrink: 0 }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {f.sourceUrl}
                            </span>
                          </button>
                        )}
                        <div className="file-meta">
                          {f.provider || "—"} · {formatDateTime(f.importedAt)}
                        </div>
                        {f.status !== "success" && f.errorMessage && (
                          <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                            {f.errorMessage}
                          </div>
                        )}
                      </div>
                      <div className="file-row-actions">
                        <span className={badge.className}>
                          <BadgeIcon size={13} />
                          {badge.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {recentFilesTotal > HISTORY_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={historyPage}
                pageCount={historyPageCount}
                onPageChange={setHistoryPage}
                rangeLabel={`Mostrando ${historyPage * historyPageSize + 1} a ${Math.min(
                  recentFilesTotal,
                  historyPage * historyPageSize + historyPageSize,
                )} de ${recentFilesTotal}`}
                pageSize={historyPageSize}
                pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setHistoryPageSize(size);
                  setHistoryPage(0);
                }}
                maxPageButtons={3}
              />
            )}
      </Drawer>

      {confirmFullImport && (
        <ConfirmModal
          title="Processar sem filtro de período"
          message="Nenhum período foi selecionado — isso vai processar o relatório inteiro, sem limitar por data. Deseja continuar?"
          confirmLabel="Processar arquivo inteiro"
          danger={false}
          onConfirm={() => {
            setConfirmFullImport(false);
            proceedToProcess();
          }}
          onCancel={() => setConfirmFullImport(false)}
        />
      )}
    </div>
  );
}
