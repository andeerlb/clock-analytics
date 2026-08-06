import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileText,
  FolderOpen,
  Link2,
  ListChecks,
  PlusCircle,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import EmployeePicker from "../components/EmployeePicker";
import Pagination from "../components/Pagination";
import { useRemoteFileUpdates, type RemoteUpdateFlag } from "../contexts/RemoteFileUpdatesContext";
import type { EmployeeFormNavState } from "./EmployeeFormPage";
import {
  applyPaymentTemplate,
  downloadPaymentFileFromUrl,
  hashPaymentFile,
  pickPaymentFiles,
  type AppliedPaymentRow,
} from "../lib/api";
import {
  addEmployeeAlias,
  findDuplicatePaymentShifts,
  findEmployeeByAttempts,
  getPaymentTemplate,
  listImportFiles,
  listPaymentTemplates,
  logSourceFile,
  markSourceFileSaved,
  savePaymentShifts,
  type EmployeeRow,
  type PaymentShiftInput,
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
} from "../lib/format";
import {
  PAYMENT_SHIFT_STATUS_LABELS,
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

/**
 * Every row lands in exactly one bucket — this is both what the toolbar
 * counts and what the toolbar's chips filter by (see `rowFilter`).
 * "valid"/"duplicate"/"duplicate-in-file" are the only ones with a
 * resolved `employee`. "duplicate" means an exact match already exists in
 * `payment_shifts` (see `findDuplicatePaymentShifts`) — offered as
 * "reprocessar", not excluded outright. "duplicate-in-file" means this row
 * is byte-for-byte identical to an earlier candidate row in this same
 * import batch — a source-file artifact, not importable at all, since
 * keeping both would just double-import the same shift within one run.
 */
type RowCategory = "valid" | "duplicate" | "duplicate-in-file" | "not-found" | "unresolved-route" | "skipped";
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
  /** The route's resolved company, alongside `resolvedClientId` — same routing rule, so "Cadastrar colaborador" can hand off exactly which client/empresa this row already resolved to, instead of leaving them to pick blind. */
  resolvedCompanyId: number | null;
  /** Resolved from the template's status rules, falling back to `"pendente"` when none match (or none are configured) — see `resolvePaymentStatus`. */
  paymentStatus: PaymentShiftStatus;
  /** Every non-blank column the template left unmapped on this row — kept for history/audit instead of discarded. */
  extraFields: Record<string, string>;
  category: RowCategory;
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

export default function ImportPaymentsPage() {
  const navigate = useNavigate();
  // Only used as the initial values below — once here, each piece of state
  // is this page's own, independently adjustable from that point on (same
  // "read once, then own it" pattern as `PaymentDetailPage`'s navState).
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
  const { remoteUpdates, dismissRemoteUpdate, setUrlCheckDisabled } = useRemoteFileUpdates();

  const [fileResults, setFileResults] = useState<PaymentFileResult[]>(restored?.fileResults ?? []);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(restored?.selectedRows ?? new Set());
  const [previewPage, setPreviewPage] = useState(restored?.previewPage ?? 0);
  const [previewPageSize, setPreviewPageSize] = useState(restored?.previewPageSize ?? PREVIEW_PAGE_SIZE_OPTIONS[0]);

  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [recentFilesTotal, setRecentFilesTotal] = useState(0);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
    cancelPreview();
    setSuccessMessage(null);
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
  }

  function cancelPreview() {
    setFileResults([]);
    setSelectedRows(new Set());
    setPreviewPage(0);
    setRowFilter("all");
    setNameSearch("");
  }

  function reset() {
    setPaths([]);
    setUrlSourceByPath(new Map());
    cancelPreview();
    setError(null);
  }

  async function handlePick() {
    if (!selectedTemplate) return;
    setError(null);
    const selected = await pickPaymentFiles([selectedTemplate.fileKind]);
    if (selected.length === 0) return;

    // The OS dialog is already filtered to the template's format, but
    // that's a soft filter on some platforms (an "all files" toggle is
    // usually still reachable) — checked again here so a mismatched file
    // never silently gets treated as if it matched.
    const suffix = `.${selectedTemplate.fileKind}`;
    const valid = selected.filter((p) => p.toLowerCase().endsWith(suffix));
    const invalid = selected.filter((p) => !p.toLowerCase().endsWith(suffix));
    if (invalid.length > 0) {
      setError(
        `O template "${selectedTemplate.name}" espera arquivos ${PAYMENT_FILE_KIND_LABELS[selectedTemplate.fileKind]}. Ignorado(s) por formato incompatível: ${invalid.map(fileNameFromPath).join(", ")}`,
      );
    }
    if (valid.length > 0) addPaths(valid);
  }

  /**
   * Shared by the manual "Baixar arquivo" button and the remote-update
   * banner's "Reimportar". A URL download can only ever produce .xlsx/.xls
   * (see `download_payment_file_from_url`'s magic-byte check) — if the
   * selected template expects csv/ods, that's caught here the same way
   * `handlePick` catches a locally-picked file of the wrong format.
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
      if (result.fileKind !== template.fileKind) {
        setError(
          `O template "${template.name}" espera arquivos ${PAYMENT_FILE_KIND_LABELS[template.fileKind]}, mas a URL retornou um arquivo ${PAYMENT_FILE_KIND_LABELS[result.fileKind]}.`,
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
      setUrlInput("");
      if (autoProcessAfter) setPendingAutoProcess(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setUrlDownloading(false);
    }
  }

  // setPaths/setTemplateId from handleReimportFromUrl are async — calling
  // handleProcessClick() synchronously right after would still see the
  // stale `paths`/`selectedTemplate`. This waits for both to actually land
  // (fileHashes catches up to paths once its own effect finishes) before
  // firing the process step exactly once.
  useEffect(() => {
    if (pendingAutoProcess && selectedTemplate && paths.length > 0 && fileHashes.size === paths.length) {
      setPendingAutoProcess(false);
      handleProcessClick();
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
    dismissRemoteUpdate(flag.sourceUrl);
    reset();
    setImportMode("url");
    const match = templates.find((t) => t.name === flag.provider);
    if (!match) {
      // Template renamed/deleted since the original import — leave the URL
      // filled in and let the user pick a template themselves, same as a
      // fresh URL import (the "Baixar arquivo" button already requires one).
      setUrlInput(flag.sourceUrl);
      return;
    }
    setTemplateId(String(match.id));
    const fullTemplate = await getPaymentTemplate(match.id);
    await handleDownloadFromUrl(flag.sourceUrl, true, fullTemplate);
  }

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
  const duplicateInFileCount = categoryCounts["duplicate-in-file"];
  const skippedCount = categoryCounts.skipped;

  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const previewPageItems = useMemo(
    () => previewRows.slice(previewPage * previewPageSize, previewPage * previewPageSize + previewPageSize),
    [previewRows, previewPage, previewPageSize],
  );

  const isSelectable = (r: PaymentPreviewRow) => Boolean(r.employee) && r.category !== "duplicate-in-file";
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
              paymentStatus:
                resolvePaymentStatus(selectedTemplate.statusRules, applied_row.fields) ?? "pendente",
              extraFields: applied_row.extraFields,
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
                resolvedCompanyId: null,
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
            const route = resolvePaymentRoute(selectedTemplate.rules, applied_row.fields);
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
              resolvedCompanyId: route?.companyId ?? null,
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
      const dupIndices = await findDuplicatePaymentShifts(
        dbCheckCandidates.map((r) => ({
          employeeId: r.employee!.id,
          workDate: r.workDate!,
          local: r.local,
          role: r.role,
          scheduleStartMinutes: r.scheduleStartMinutes,
          scheduleEndMinutes: r.scheduleEndMinutes,
        })),
      );
      dupIndices.forEach((i) => {
        dbCheckCandidates[i].isDuplicate = true;
        dbCheckCandidates[i].category = "duplicate";
      });

      const defaultSelected = new Set<number>();
      allRows.forEach((r, i) => {
        if (r.category === "valid") defaultSelected.add(i);
      });

      setFileResults(results);
      setSelectedRows(defaultSelected);
      setPreviewPage(0);
      setRowFilter("all");
      setNameSearch("");
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
      const dupIndices = await findDuplicatePaymentShifts(
        dbCheckTargets.map((r) => ({
          employeeId: employee.id,
          workDate: r.workDate!,
          local: r.local,
          role: r.role,
          scheduleStartMinutes: r.scheduleStartMinutes,
          scheduleEndMinutes: r.scheduleEndMinutes,
        })),
      );
      dupIndices.forEach((i) => {
        dbCheckTargets[i].isDuplicate = true;
        dbCheckTargets[i].category = "duplicate";
      });
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

  /** No período set means "the whole file" — that's easy to do by accident, so it's confirmed instead of just silently processing everything. */
  function handleProcessClick() {
    if (!periodStart && !periodEnd) {
      setConfirmFullImport(true);
      return;
    }
    handleProcess();
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
          extraData: Object.keys(row.extraFields).length > 0 ? row.extraFields : null,
        });
        savedFileHashes.add(fileHash);
      }
      await savePaymentShifts(shiftInputs);
      for (const fileHash of savedFileHashes) {
        await markSourceFileSaved(fileHash);
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
        <button type="button" className="secondary" onClick={() => navigate("/import/payments/templates")}>
          <Settings2 size={15} style={{ marginRight: "0.4rem" }} />
          Gerenciar templates
        </button>
      </div>
      <p className="page-subtitle">
        Aplique um template já cadastrado a um arquivo de pagamentos (CSV, Excel ou ODS) e
        associe cada linha ao colaborador correspondente.
      </p>

      {error && <div className="error-box">{error}</div>}
      {successMessage && <div className="success-box">{successMessage}</div>}
      {remoteUpdates
        .map((u) => (
          <div
            className="warning-box"
            key={u.sourceUrl}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}
          >
            <span>
              <AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: "0.4rem" }} />
              O arquivo remoto de <strong>{u.fileName}</strong> (importado em {formatDateTime(u.lastImportedAt)})
              parece ter sido atualizado.
            </span>
            <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
              <button
                type="button"
                className="ghost"
                onClick={() => setUrlCheckDisabled(u.sourceUrl, true)}
                title="Não verificar mais este arquivo automaticamente (pode reativar em Configurações)"
              >
                Desativar verificação automática
              </button>
              <button type="button" className="outline" onClick={() => dismissRemoteUpdate(u.sourceUrl)}>
                Ignorar
              </button>
              <button type="button" onClick={() => handleReimportFromUrl(u)}>
                Reimportar
              </button>
            </div>
          </div>
        ))}

      <div className="import-layout">
        <div className="import-main">
          <div className="card">
            <div className="field" style={{ maxWidth: "24rem", marginBottom: "1.2rem" }}>
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

            <div className="field" style={{ maxWidth: "24rem", marginBottom: "1.2rem" }}>
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
                      ? `Formato do template: ${PAYMENT_FILE_KIND_LABELS[selectedTemplate.fileKind]} — suporta múltiplos arquivos.`
                      : "Selecione um template para saber o formato aceito."}
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={handlePick}
                    disabled={!selectedTemplate}
                    title={selectedTemplate ? undefined : "Selecione um template primeiro"}
                  >
                    <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                    Procurar arquivos
                  </button>
                </div>
              ) : (
                <>
                  <div className="warning-box">
                    <AlertTriangle size={14} style={{ verticalAlign: "-2px", marginRight: "0.4rem" }} />
                    Apenas arquivos do Microsoft Office (.xlsx, .xls) ou OpenDocument (.ods) são
                    suportados por URL. O link precisa ser de download direto e anônimo — não pode
                    exigir login.
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.8rem" }}>
                    <input
                      type="url"
                      placeholder="https://exemplo.com/arquivo.xlsx"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      disabled={urlDownloading}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleDownloadFromUrl()}
                      disabled={!selectedTemplate || !urlInput.trim() || urlDownloading}
                      title={selectedTemplate ? undefined : "Selecione um template primeiro"}
                    >
                      {urlDownloading ? "Baixando..." : "Baixar arquivo"}
                    </button>
                  </div>
                </>
              )}

              {paths.length > 0 && (
                <div className="file-list">
                  {paths.map((p) => {
                    const info = fileHashes.get(p);
                    const provenance = urlSourceByPath.get(p);
                    return (
                      <div className="file-row" key={p}>
                        <div className="file-row-icon">
                          <FileText size={18} />
                        </div>
                        <div className="file-row-info">
                          <div className="file-name">
                            {info?.fileName ?? p}
                            {provenance && (
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
            </div>

            <div className="card-footer">
              <button
                type="button"
                disabled={paths.length === 0 || !templateId || busy}
                onClick={handleProcessClick}
              >
                {busy ? "Processando..." : `Processar ${paths.length || ""} arquivo(s)`}
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
                    {duplicateCount > 0 ? (
                      <p className="muted" style={{ maxWidth: "42rem" }}>
                        Algumas linhas batem, em todas as colunas, com um turno já salvo — marque
                        a linha se quiser reprocessar (importar de novo) mesmo assim.
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

              <div className="card table-card">
                <div className="table-toolbar">
                  <div className="counts">
                    <span>{shiftRows.length} registro(s) encontrado(s)</span>
                    <button
                      type="button"
                      className={`badge ok chip-filter${rowFilter === "selected" ? " active" : ""}`}
                      onClick={() => toggleRowFilter("selected")}
                      title="Linhas marcadas — vão ser importadas ao salvar. Clique para filtrar."
                    >
                      <ListChecks size={13} />
                      {selectedRows.size} a importar
                    </button>
                    <button
                      type="button"
                      className={`badge info chip-filter${rowFilter === "valid" ? " active" : ""}`}
                      onClick={() => toggleRowFilter("valid")}
                      title="Colaborador encontrado, sem turno igual já importado. Clique para filtrar."
                    >
                      <CheckCircle2 size={13} />
                      {categoryCounts.valid} novo(s)
                    </button>
                    {duplicateCount > 0 && (
                      <button
                        type="button"
                        className={`badge overwrite chip-filter${rowFilter === "duplicate" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("duplicate")}
                        title="Todas as colunas batem com um turno já salvo. Clique para filtrar."
                      >
                        <AlertTriangle size={13} />
                        {duplicateCount} já importado(s)
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
                        <AlertTriangle size={13} />
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
                        <AlertTriangle size={13} />
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
                        <AlertCircle size={13} />
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
                          <td colSpan={10} className="muted" style={{ textAlign: "center", padding: "1.4rem" }}>
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
                              <td colSpan={8}>
                                <div className="file-name">{item.fileName}</div>
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
                        const canSelect = Boolean(row.employee) && row.category !== "duplicate-in-file";
                        return (
                          <tr key={index}>
                            <td className="checkbox-cell">
                              <input
                                type="checkbox"
                                checked={selectedRows.has(index)}
                                onChange={() => toggleRow(index)}
                                disabled={!canSelect}
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
                                (selectedRows.has(index) ? (
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Será reprocessado
                                  </span>
                                ) : (
                                  <span className="badge overwrite" title="Todas as colunas batem com um turno já salvo. Marque a linha para reprocessar (importar de novo).">
                                    <AlertTriangle size={13} />
                                    Já importado
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

        <div className="import-side">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Histórico de importações</h3>

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
                          {f.fileName}
                          {f.sourceUrl && (
                            <Link2
                              size={12}
                              style={{ marginLeft: "0.4rem", opacity: f.checkDisabled ? 0.35 : 0.6, verticalAlign: "-1px" }}
                              aria-label={
                                f.checkDisabled
                                  ? `Verificação automática desativada — ${f.sourceUrl}`
                                  : `Verificação automática de atualização ativa — ${f.sourceUrl}`
                              }
                            >
                              <title>
                                {f.checkDisabled
                                  ? `Verificação automática desativada — ${f.sourceUrl}`
                                  : `Verificação automática de atualização ativa — ${f.sourceUrl}`}
                              </title>
                            </Link2>
                          )}
                        </div>
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
          </div>
        </div>
      </div>

      {confirmFullImport && (
        <ConfirmModal
          title="Processar sem filtro de período"
          message="Nenhum período foi selecionado — isso vai processar o relatório inteiro, sem limitar por data. Deseja continuar?"
          confirmLabel="Processar arquivo inteiro"
          danger={false}
          onConfirm={() => {
            setConfirmFullImport(false);
            handleProcess();
          }}
          onCancel={() => setConfirmFullImport(false)}
        />
      )}
    </div>
  );
}
