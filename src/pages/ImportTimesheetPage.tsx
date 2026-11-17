import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  History,
  Lightbulb,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../components/Avatar";
import Drawer from "../components/Drawer";
import OptionPicker from "../components/OptionPicker";
import PageHeader from "../components/PageHeader";
import Pagination from "../components/Pagination";
import PickFilesButton from "../components/PickFilesButton";
import { hashFiles, listDirFiles, listProviders, parseImport, pickFolder, pickPdfFiles } from "../lib/api";
import {
  findConflicts,
  listClients,
  listImportFiles,
  findDuplicateFiles,
  logSourceFile,
  markSourceFileSaved,
  saveParsedTimesheet,
  type ClientRow,
} from "../lib/db";
import { formatCnpj, formatDateTime, formatPeriod, normalizeCnpj } from "../lib/format";
import { importStatusOf } from "../lib/types";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  FileParseResult,
  ImportFileRow,
  ImportStatus,
  ParsedTimesheet,
  ProviderInfo,
} from "../lib/types";

const STATUS_BADGE: Record<ImportStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { className: "badge ok", label: "Sucesso", icon: CheckCircle2 },
  warning: { className: "badge overwrite", label: "Com alertas", icon: AlertTriangle },
  error: { className: "badge file-error", label: "Falha", icon: AlertCircle },
};

interface FileStatus {
  hash: string;
  fileName: string;
  duplicate: DuplicateFileInfo | null;
}

type SheetFilter = "all" | "selected" | "new" | "conflict" | "mismatch" | "error";

/** For the "⌘F" vs "Ctrl F" hint on the preview's search. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Processar", "Processar 1 arquivo", "Processar 3 arquivos". */
function processLabel(count: number): string {
  if (count === 0) return "Processar";
  return `Processar ${count} arquivo${count === 1 ? "" : "s"}`;
}

/** "/home/me/Ponto/joao.pdf" -> "joao.pdf". */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** "/home/me/Ponto/joao.pdf" -> "/home/me/Ponto" — the short origin under a picked file's name. */
function parentDirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

type PreviewRow =
  | { kind: "sheet"; sheetIndex: number; sheet: ParsedTimesheet }
  | { kind: "error"; fileName: string; message: string };

const PREVIEW_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const PATHS_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportTimesheetPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [pathsPage, setPathsPage] = useState(0);
  const [pathsPageSize, setPathsPageSize] = useState(PATHS_PAGE_SIZE_OPTIONS[0]);
  const [fileStatuses, setFileStatuses] = useState<Map<string, FileStatus>>(new Map());
  const [forceReprocess, setForceReprocess] = useState<Set<string>>(new Set());
  const [fileResults, setFileResults] = useState<FileParseResult[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [selectedSheets, setSelectedSheets] = useState<Set<number>>(new Set());
  const [previewPage, setPreviewPage] = useState(0);
  const [sheetFilter, setSheetFilter] = useState<SheetFilter>("all");
  const [nameSearch, setNameSearch] = useState("");
  const previewSearchRef = useRef<HTMLInputElement>(null);
  const [previewPageSize, setPreviewPageSize] = useState(PREVIEW_PAGE_SIZE_OPTIONS[0]);
  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [recentFilesTotal, setRecentFilesTotal] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    listProviders().then((list) => {
      setProviders(list);
      if (list.length > 0) setProvider(list[0].id);
    });
    listClients().then(setClients);
  }, []);

  // History panel — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    refreshRecentFiles();
  }, [historySearch, historyPage, historyPageSize]);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setDragActive(true);
      } else if (event.payload.type === "drop") {
        setDragActive(false);
        const pdfPaths = event.payload.paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
        if (pdfPaths.length > 0) addPaths(pdfPaths);
      } else {
        setDragActive(false);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Every time the file list changes, hash the new files and check which
  // ones were already imported before — this runs before any parsing.
  useEffect(() => {
    if (paths.length === 0) {
      setFileStatuses(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const hashes = await hashFiles(paths);
      const duplicates = await findDuplicateFiles(hashes.map((h) => h.hash));
      if (cancelled) return;
      setFileStatuses(
        new Map(
          hashes.map((h) => [
            h.path,
            { hash: h.hash, fileName: h.fileName, duplicate: duplicates.get(h.hash) ?? null },
          ]),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [paths]);

  function refreshRecentFiles() {
    listImportFiles({ importType: "timesheet", search: historySearch, page: historyPage, pageSize: historyPageSize }).then(
      ({ rows, total }) => {
        setRecentFiles(rows);
        setRecentFilesTotal(total);
      },
    );
  }

  function addPaths(newPaths: string[]) {
    setPaths((prev) => Array.from(new Set([...prev, ...newPaths])));
    setPathsPage(0);
    cancelPreview();
    setSuccessMessage(null);
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
    setPathsPage(0);
  }

  function cancelPreview() {
    setFileResults([]);
    setConflicts([]);
    setSelectedSheets(new Set());
    setPreviewPage(0);
    setSheetFilter("all");
    setNameSearch("");
  }

  function reset() {
    setPaths([]);
    setForceReprocess(new Set());
    cancelPreview();
    setError(null);
  }

  // Opt a single already-imported file back into processing — its own
  // sheet(s) then go through the normal conflict flow (findConflicts),
  // which already knows how to overwrite an existing import by id.
  function toggleForceReprocess(path: string) {
    setForceReprocess((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handlePickFiles() {
    setError(null);
    const selected = await pickPdfFiles();
    if (selected.length > 0) addPaths(selected);
  }

  async function handlePickFolder() {
    setError(null);
    const dir = await pickFolder();
    if (!dir) return;
    const selected = await listDirFiles(dir, ["pdf"]);
    if (selected.length === 0) {
      setError("Nenhum arquivo PDF encontrado na pasta selecionada.");
      return;
    }
    addPaths(selected);
  }

  const pathsPageCount = Math.max(1, Math.ceil(paths.length / pathsPageSize));
  const pagedPaths = useMemo(
    () => paths.slice(pathsPage * pathsPageSize, pathsPage * pathsPageSize + pathsPageSize),
    [paths, pathsPage, pathsPageSize],
  );

  const eligiblePaths = useMemo(
    () => paths.filter((p) => !fileStatuses.get(p)?.duplicate || forceReprocess.has(p)),
    [paths, fileStatuses, forceReprocess],
  );
  const duplicateCount = paths.filter(
    (p) => fileStatuses.get(p)?.duplicate && !forceReprocess.has(p),
  ).length;

  // `clients` has one row per (client, company) link, so grab the first
  // match just for the client's own identity (name/cnpj) — those are the
  // same across every row for a given client.
  const selectedClient = useMemo(
    () => clients.find((c) => String(c.id) === clientId) ?? null,
    [clients, clientId],
  );

  // Deduplicated by client id, just for the "Cliente" select's options —
  // `clients` itself stays one-row-per-(client,company) since that's what
  // `clientCompanies`/the auto-select effect below need.
  const clientOptions = useMemo(() => {
    const seen = new Map<number, ClientRow>();
    for (const c of clients) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients]);

  // Every company the selected client is linked to — this is what the
  // "Empresa" select offers, since a client can be tied to more than one.
  const clientCompanies = useMemo(
    () => clients.filter((c) => String(c.id) === clientId),
    [clients, clientId],
  );

  // Auto-select the company when the client only has one; otherwise force
  // an explicit choice (and clear any stale choice from a previous client).
  useEffect(() => {
    if (clientCompanies.length === 1) {
      setCompanyId(String(clientCompanies[0].companyId));
    } else {
      setCompanyId("");
    }
  }, [clientCompanies]);

  // Flat list of every successfully parsed sheet, in file order — this is
  // what conflict-checking and saving iterate over. Index into this array
  // is the stable identity used for selection/conflict lookups.
  const sheets = useMemo(() => fileResults.flatMap((r) => r.sheets), [fileResults]);

  // Which FileParseResult each flat sheet index came from — needed at save
  // time to record the *original* (possibly multi-page) file once, even
  // though it may have produced several sheets/imports.
  const sheetOwner = useMemo(
    () => fileResults.flatMap((r) => r.sheets.map(() => r)),
    [fileResults],
  );

  const conflictBySheetIndex = useMemo(
    () => new Map(conflicts.map((c) => [c.sheetIndex, c])),
    [conflicts],
  );

  // The employee's own file says a different CNPJ than the client selected
  // for this batch — surfaced so picking the wrong client doesn't silently
  // attribute someone's timesheet to it.
  const mismatchedSheetIndexes = useMemo(() => {
    if (!selectedClient) return new Set<number>();
    const selectedCnpj = normalizeCnpj(selectedClient.cnpj);
    const mismatched = new Set<number>();
    sheets.forEach((sheet, i) => {
      if (normalizeCnpj(sheet.company.cnpj) !== selectedCnpj) mismatched.add(i);
    });
    return mismatched;
  }, [sheets, selectedClient]);

  // One row per sheet, plus one row per file that failed to parse — a bad
  // PDF in the batch doesn't hide the results already extracted from the
  // others.
  const previewRows = useMemo(() => {
    const rows: PreviewRow[] = [];
    let idx = 0;
    for (const result of fileResults) {
      if (result.error) {
        rows.push({ kind: "error", fileName: result.fileName, message: result.error });
      } else {
        for (const sheet of result.sheets) {
          rows.push({ kind: "sheet", sheetIndex: idx, sheet });
          idx++;
        }
      }
    }
    return rows;
  }, [fileResults]);

  const errorCount = fileResults.filter((r) => r.error).length;

  // Preview filter chips + name/CPF search — same look and behavior as the
  // payment import's preview.
  const visibleRows = useMemo(() => {
    const query = nameSearch.trim().toLowerCase();
    const digits = query.replace(/\D/g, "");
    return previewRows.filter((row) => {
      if (row.kind === "error") return !query && (sheetFilter === "all" || sheetFilter === "error");
      const conflict = conflictBySheetIndex.has(row.sheetIndex);
      const mismatched = mismatchedSheetIndexes.has(row.sheetIndex);
      const matchesFilter =
        sheetFilter === "all" ||
        (sheetFilter === "selected" && selectedSheets.has(row.sheetIndex)) ||
        (sheetFilter === "new" && !conflict && !mismatched) ||
        (sheetFilter === "conflict" && conflict) ||
        (sheetFilter === "mismatch" && mismatched);
      const matchesSearch =
        !query ||
        row.sheet.employee.name.toLowerCase().includes(query) ||
        (digits.length >= 3 && row.sheet.employee.cpf.replace(/\D/g, "").includes(digits));
      return matchesFilter && matchesSearch;
    });
  }, [previewRows, sheetFilter, nameSearch, selectedSheets, conflictBySheetIndex, mismatchedSheetIndexes]);

  const newSheetCount = sheets.filter((_, i) => !conflictBySheetIndex.has(i) && !mismatchedSheetIndexes.has(i)).length;
  const sheetChips: { filter: SheetFilter; label: string; count: number; color?: string; title?: string }[] = [
    { filter: "all", label: "Todos", count: sheets.length + errorCount },
    { filter: "selected", label: "A importar", count: selectedSheets.size, color: "var(--text)", title: "Marcados — vão ser salvos." },
    { filter: "new", label: "Novos", count: newSheetCount, color: "var(--success)" },
    ...(conflicts.length > 0
      ? [{ filter: "conflict" as SheetFilter, label: "Já têm dados no período", count: conflicts.length, color: "#93c5fd" }]
      : []),
    ...(mismatchedSheetIndexes.size > 0
      ? [{ filter: "mismatch" as SheetFilter, label: "CNPJ diferente", count: mismatchedSheetIndexes.size, color: "var(--warning)" }]
      : []),
    ...(errorCount > 0 ? [{ filter: "error" as SheetFilter, label: "Erros", count: errorCount, color: "var(--danger)" }] : []),
  ];

  function toggleSheetFilter(filter: SheetFilter) {
    setSheetFilter((prev) => (prev === filter ? "all" : filter));
    setPreviewPage(0);
  }

  // Ctrl/⌘+F jumps to the preview's search while a preview is open.
  const hasPreview = fileResults.length > 0;
  useEffect(() => {
    if (!hasPreview) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        previewSearchRef.current?.focus();
        previewSearchRef.current?.scrollIntoView({ block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasPreview]);

  const previewPageCount = Math.max(1, Math.ceil(visibleRows.length / previewPageSize));
  const previewPageItems = useMemo(
    () =>
      visibleRows.slice(
        previewPage * previewPageSize,
        previewPage * previewPageSize + previewPageSize,
      ),
    [visibleRows, previewPage, previewPageSize],
  );

  const allSelected = sheets.length > 0 && sheets.every((_, i) => selectedSheets.has(i));

  const historyPageCount = Math.max(1, Math.ceil(recentFilesTotal / historyPageSize));

  async function handleParse() {
    if (!selectedClient || !companyId) return;
    setError(null);
    setBusy(true);
    try {
      const results = await parseImport(provider, eligiblePaths);
      const allSheets = results.flatMap((r) => r.sheets);
      const foundConflicts = await findConflicts(allSheets, selectedClient.id, Number(companyId));
      const selectedCnpj = normalizeCnpj(selectedClient.cnpj);
      // Rows with a conflict, or whose own CNPJ doesn't match the client
      // selected for this batch, start unselected — both are opt-in.
      const defaultSelected = new Set<number>();
      allSheets.forEach((sheet, i) => {
        const hasConflict = foundConflicts.some((c) => c.sheetIndex === i);
        const mismatched = normalizeCnpj(sheet.company.cnpj) !== selectedCnpj;
        if (!hasConflict && !mismatched) defaultSelected.add(i);
      });
      setFileResults(results);
      setConflicts(foundConflicts);
      setSelectedSheets(defaultSelected);
      setPreviewPage(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSheet(sheetIndex: number) {
    setSelectedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(sheetIndex)) next.delete(sheetIndex);
      else next.add(sheetIndex);
      return next;
    });
  }

  function toggleAll() {
    setSelectedSheets(allSelected ? new Set() : new Set(sheets.map((_, i) => i)));
  }

  async function handleSave() {
    if (!selectedClient || !companyId) return;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      // The import history only gets an entry once the user actually
      // commits this batch — parsing alone (without clicking Salvar)
      // shouldn't leave a trace. Every file from the batch is logged here
      // (including ones that failed or whose sheets weren't selected), not
      // just the ones that ended up saved. This has to happen *before* the
      // save loop below: each import links back to its source_files row,
      // which only exists once it's been logged.
      const sourceFileIdByHash = new Map<string, number>();
      for (const result of fileResults) {
        const sourceFileId = await logSourceFile({
          fileHash: result.fileHash,
          fileName: result.fileName,
          pageCount: result.pageCount,
          provider,
          importType: "timesheet",
          status: importStatusOf(result),
          errorMessage: result.error,
          originalPdfPath: result.originalPdfPath,
        });
        sourceFileIdByHash.set(result.fileHash, sourceFileId);
      }

      let savedCount = 0;
      const savedFileHashes = new Set<string>();
      for (let i = 0; i < sheets.length; i++) {
        if (!selectedSheets.has(i)) continue;
        const conflict = conflictBySheetIndex.get(i);
        const fileHash = sheetOwner[i].fileHash;
        await saveParsedTimesheet(
          sheets[i],
          selectedClient.id,
          Number(companyId),
          conflict?.existingImportId,
          sourceFileIdByHash.get(fileHash),
        );
        savedCount++;
        savedFileHashes.add(fileHash);
      }
      // Once per *original* file (not per sheet) — this is what lets the
      // pre-check recognize a saved batch file, even though it produced
      // several separate imports.
      for (const fileHash of savedFileHashes) {
        await markSourceFileSaved(fileHash);
      }
      refreshRecentFiles();
      reset();
      setSuccessMessage(
        savedCount === 1
          ? "1 colaborador importado com sucesso."
          : `${savedCount} colaboradores importados com sucesso.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Importar espelhos de ponto"
        backTo="/import"
        backLabel="Voltar para Importar"
        subtitle="Faça o upload dos arquivos fornecidos pelo seu provedor de ponto para extrair os dados."
        tags={["PDF"]}
        actions={
          <button type="button" className="ghost" onClick={() => setHistoryOpen(true)}>
            <History size={15} />
            Histórico
          </button>
        }
      />

      {error && <div className="error-box">{error}</div>}
      {successMessage && <div className="success-box">{successMessage}</div>}

      <div className="import-layout" style={{ display: "block" }}>
      <div className="import-main">
      <div className="card import-payments-card">
        <section className="import-payments-section">
          <div className="import-payments-fields import-payments-fields-3">
            <div className="field">
              <label>Cliente</label>
              <OptionPicker
                single
                align="left"
                options={clientOptions.map((c) => ({ id: String(c.id), label: c.name, meta: c.cnpj ? formatCnpj(c.cnpj) : undefined }))}
                selected={clientId ? new Set([clientId]) : new Set()}
                onToggle={(id) => setClientId(id)}
                title="Clientes"
                allPlaceholder={clients.length === 0 ? "Nenhum cliente cadastrado" : "Selecione um cliente"}
                searchPlaceholder="Buscar cliente ou CNPJ"
              />
              {clients.length === 0 ? (
                <p className="field-hint">
                  <Link to="/clients">Cadastre um cliente</Link> antes de importar.
                </p>
              ) : (
                <p className="field-hint">Os colaboradores importados ficam vinculados a ele.</p>
              )}
            </div>
            <div className="field">
              <label>Empresa</label>
              <OptionPicker
                single
                align="left"
                options={clientCompanies.map((c) => ({ id: String(c.companyId), label: c.companyName }))}
                selected={companyId ? new Set([companyId]) : new Set()}
                onToggle={(id) => setCompanyId(id)}
                title="Empresas"
                allPlaceholder={clientId ? "Selecione uma empresa" : "Escolha o cliente primeiro"}
                searchPlaceholder="Buscar empresa"
              />
              <p className="field-hint">
                {clientCompanies.length > 1
                  ? "Esse cliente está vinculado a mais de uma empresa — escolha uma."
                  : "Definida automaticamente pelo cliente."}
              </p>
            </div>
            <div className="field">
              <label>Provedor</label>
              <OptionPicker
                single
                options={providers.map((pr) => ({ id: pr.id, label: pr.label }))}
                selected={provider ? new Set([provider]) : new Set()}
                onToggle={(id) => setProvider(id)}
                title="Provedores"
                allPlaceholder="Selecione um provedor"
                searchPlaceholder="Buscar provedor"
              />
              <p className="field-hint">O formato de extração varia conforme o sistema de origem.</p>
            </div>
          </div>
        </section>

        <section className="import-payments-section">
          <div className="field">
            <div className="import-source-head">
              <label>Arquivos</label>
              {paths.length > 0 && (
                <span className="muted" style={{ fontSize: "0.78rem" }}>
                  {paths.length} {paths.length === 1 ? "arquivo" : "arquivos"}
                </span>
              )}
            </div>
            <div className={`dropzone import-dropzone${dragActive ? " drag-active" : ""}`}>
              <div className="dropzone-icon">
                <UploadCloud size={18} />
              </div>
              <PickFilesButton onPickFiles={handlePickFiles} onPickFolder={handlePickFolder} />
              <p className="muted" style={{ margin: 0, fontSize: "0.78rem" }}>
                ou arraste aqui · PDF · suporta múltiplos arquivos
              </p>
            </div>

            {paths.length > 0 && (
              <div className="file-list import-file-list">
                {pagedPaths.map((p) => {
                  const status = fileStatuses.get(p);
                  const name = status?.fileName ?? fileNameOf(p);
                  return (
                    <div className="file-row" key={p}>
                      <div className="file-row-icon import-file-icon">
                        <FileText size={18} />
                      </div>
                      <div className="file-row-info">
                        <div className="file-name">{name}</div>
                        <div className="file-meta import-file-meta">
                          {status?.duplicate ? (
                            <span className="import-file-origin">
                              {status.duplicate.employees.length > 0 ? (
                                <>
                                  {status.duplicate.employees[0].companyName} ·{" "}
                                  {status.duplicate.employees.map((e, i) => (
                                    <span key={e.importId}>
                                      {i > 0 && ", "}
                                      <Link to={`/employee/${e.importId}`}>{e.employeeName}</Link>
                                    </span>
                                  ))}
                                </>
                              ) : (
                                `${status.duplicate.pageCount} páginas`
                              )}
                              {" · importado em "}
                              {formatDateTime(status.duplicate.importedAt)}
                            </span>
                          ) : (
                            <span className="import-file-origin" title={p}>
                              {parentDirOf(p)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="file-row-actions">
                        {status?.duplicate &&
                          (forceReprocess.has(p) ? (
                            <>
                              <span className="row-state row-state-warn">Será reprocessado</span>
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                                onClick={() => toggleForceReprocess(p)}
                              >
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="row-state row-state-info">Já importado</span>
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                                onClick={() => toggleForceReprocess(p)}
                              >
                                <RotateCcw size={13} style={{ marginRight: "0.35rem" }} />
                                Reprocessar
                              </button>
                            </>
                          ))}
                        <span className="import-file-ext">pdf</span>
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
            {duplicateCount > 0 && (
              <p className="field-hint">
                {duplicateCount === 1
                  ? "1 arquivo já importado não vai ser reprocessado."
                  : `${duplicateCount} arquivos já importados não vão ser reprocessados.`}
              </p>
            )}
          </div>
        </section>

        <div className="import-payments-footer">
          <button
            type="button"
            disabled={eligiblePaths.length === 0 || !provider || !clientId || !companyId || busy}
            onClick={handleParse}
          >
            <Play size={14} style={{ marginRight: "0.45rem" }} />
            {busy && fileResults.length === 0 ? "Processando..." : processLabel(eligiblePaths.length)}
          </button>
        </div>
      </div>

      {fileResults.length > 0 && (
        <>
        <div className="card table-card">
          <div className="preview-header">
            <div className="preview-heading">
              <span className="preview-file-icon" aria-hidden="true">
                <FileText size={19} />
              </span>
              <div style={{ minWidth: 0 }}>
                <h3 className="preview-title">Pré-visualização da importação</h3>
                <div className="preview-meta">
                  {[
                    fileResults.length === 1 ? fileResults[0].fileName : `${fileResults.length} arquivos`,
                    selectedClient?.name,
                    providers.find((pr) => pr.id === provider)?.label,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexShrink: 0 }}>
              <button type="button" className="outline" onClick={cancelPreview} disabled={busy}>
                Cancelar
              </button>
              <button type="button" onClick={handleSave} disabled={busy || selectedSheets.size === 0}>
                {busy
                  ? "Salvando..."
                  : selectedSheets.size === 0
                    ? "Salvar"
                    : `Salvar ${selectedSheets.size} ${selectedSheets.size === 1 ? "espelho" : "espelhos"}`}
              </button>
            </div>
          </div>

          <div className="preview-status-row">
            <p className="preview-status">
              <span
                className="preview-status-dot"
                style={{ background: selectedSheets.size > 0 ? "var(--success)" : "var(--warning)" }}
              />
              <span>
                {selectedSheets.size === 0
                  ? "Nenhum espelho para importar ainda."
                  : `${selectedSheets.size} ${selectedSheets.size === 1 ? "espelho será importado" : "espelhos serão importados"}.`}
                {conflicts.length > 0 && (
                  <>
                    {" "}
                    <button type="button" className="preview-status-link" onClick={() => toggleSheetFilter("conflict")}>
                      {conflicts.length} {conflicts.length === 1 ? "já tem dados" : "já têm dados"} no período
                    </button>
                    {" — marque para sobrescrever."}
                  </>
                )}
                {mismatchedSheetIndexes.size > 0 && (
                  <>
                    {" "}
                    <button type="button" className="preview-status-link" onClick={() => toggleSheetFilter("mismatch")}>
                      {mismatchedSheetIndexes.size} com CNPJ diferente do cliente
                    </button>
                    .
                  </>
                )}
              </span>
            </p>
          </div>

          <div className="table-toolbar preview-toolbar">
            <label className={`preview-search${nameSearch ? " preview-search-has-value" : ""}`}>
              <Search size={14} aria-hidden="true" />
              <input
                ref={previewSearchRef}
                type="text"
                value={nameSearch}
                onChange={(e) => {
                  setNameSearch(e.target.value);
                  setPreviewPage(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setNameSearch("");
                    setPreviewPage(0);
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Buscar por nome ou CPF"
                aria-label="Buscar por nome ou CPF"
              />
              {nameSearch ? (
                <button
                  type="button"
                  className="preview-search-clear"
                  aria-label="Limpar busca"
                  onClick={() => {
                    setNameSearch("");
                    setPreviewPage(0);
                    previewSearchRef.current?.focus();
                  }}
                >
                  <X size={13} />
                </button>
              ) : (
                <kbd>{IS_MAC ? "⌘F" : "Ctrl F"}</kbd>
              )}
            </label>
            <span className="preview-toolbar-sep" aria-hidden="true" />
            <div className="preview-chips">
              {sheetChips.map((chip) => (
                <button
                  key={chip.filter}
                  type="button"
                  className="preview-chip"
                  aria-pressed={sheetFilter === chip.filter}
                  onClick={() => (chip.filter === "all" ? (setSheetFilter("all"), setPreviewPage(0)) : toggleSheetFilter(chip.filter))}
                  title={chip.title}
                >
                  {chip.color && <span className="preview-chip-dot" style={{ background: chip.color }} />}
                  {chip.label}
                  <b>{chip.count}</b>
                </button>
              ))}
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
                    disabled={sheets.length === 0}
                    aria-label="Selecionar todos"
                  />
                </th>
                <th>Colaborador</th>
                <th>CPF</th>
                <th>Empresa</th>
                <th>Período</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {previewPageItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: "center", padding: "1.4rem" }}>
                    {nameSearch.trim() ? "Nenhum espelho com esse nome ou CPF." : "Nenhum espelho neste filtro."}
                  </td>
                </tr>
              )}
              {previewPageItems.map((row, i) => {
                if (row.kind === "error") {
                  return (
                    <tr key={`error-${i}`} className="row-error">
                      <td className="checkbox-cell">
                        <input type="checkbox" disabled aria-label="Não disponível" />
                      </td>
                      <td colSpan={4}>
                        <div className="file-name">{row.fileName}</div>
                        <div className="muted">{row.message}</div>
                      </td>
                      <td>
                        <span className="row-state row-state-error">Erro no arquivo</span>
                      </td>
                    </tr>
                  );
                }

                const conflict = conflictBySheetIndex.get(row.sheetIndex);
                const mismatched = mismatchedSheetIndexes.has(row.sheetIndex);
                return (
                  <tr key={row.sheetIndex}>
                    <td className="checkbox-cell">
                      <input
                        type="checkbox"
                        checked={selectedSheets.has(row.sheetIndex)}
                        onChange={() => toggleSheet(row.sheetIndex)}
                        aria-label={`Selecionar ${row.sheet.employee.name}`}
                      />
                    </td>
                    <td>
                      <div className="person-cell">
                        <Avatar name={row.sheet.employee.name} />
                        {row.sheet.employee.name}
                      </div>
                    </td>
                    <td className="mono">{row.sheet.employee.cpf}</td>
                    <td>{row.sheet.company.name}</td>
                    <td>{formatPeriod(row.sheet.period.start, row.sheet.period.end)}</td>
                    <td>
                      {!conflict && !mismatched && <span className="row-state row-state-ok">Novo</span>}
                      {mismatched && (
                        <div style={{ marginBottom: conflict ? "0.4rem" : 0 }}>
                          <span className="row-state row-state-warn">CNPJ diferente do cliente</span>
                        </div>
                      )}
                      {conflict && (
                        <>
                          <span className="row-state row-state-info">
                            {selectedSheets.has(row.sheetIndex) ? "Vai sobrescrever" : "Já tem dados no período"}
                          </span>
                          <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.25rem" }}>
                            {formatPeriod(conflict.existingPeriodStart, conflict.existingPeriodEnd)}{" "}
                            · {formatDateTime(conflict.existingImportedAt)}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {visibleRows.length > PREVIEW_PAGE_SIZE_OPTIONS[0] && (
            <Pagination
              page={previewPage}
              pageCount={previewPageCount}
              onPageChange={setPreviewPage}
              rangeLabel={`Mostrando ${previewPage * previewPageSize + 1} a ${Math.min(
                visibleRows.length,
                previewPage * previewPageSize + previewPageSize,
              )} de ${visibleRows.length}`}
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

      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="Histórico de importações" icon={History} subtitle={`${recentFilesTotal} ${recentFilesTotal === 1 ? "arquivo importado" : "arquivos importados"}`}>
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
      </Drawer>

      <div className="tip-row">
          <div className="tip-card">
            <div className="tip-card-icon" style={{ background: "rgba(245, 158, 11, 0.15)" }}>
              <Lightbulb size={16} color="#fbbf24" />
            </div>
            <div>
              <h5>Dica de Importação</h5>
              <p>
                Garanta que os PDFs gerados pelo provedor não estejam protegidos por senha para
                que a extração funcione corretamente.
              </p>
            </div>
          </div>
          <div className="tip-card">
            <div className="tip-card-icon" style={{ background: "rgba(34, 197, 94, 0.15)" }}>
              <ShieldCheck size={16} color="#4ade80" />
            </div>
            <div>
              <h5>Sobre o arquivo original</h5>
              <p>
                Uma cópia do PDF original é mantida localmente neste computador, para que você
                possa reabri-lo a qualquer momento pelo botão "Ver relatório original".
              </p>
            </div>
          </div>
        </div>
    </div>
  );
}
