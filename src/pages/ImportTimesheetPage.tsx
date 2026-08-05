import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileText,
  FolderOpen,
  Lightbulb,
  PlusCircle,
  RotateCcw,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../components/Avatar";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import { hashFiles, listProviders, parseImport, pickPdfFiles } from "../lib/api";
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
import { formatDateTime, formatPeriod, normalizeCnpj } from "../lib/format";
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

type PreviewRow =
  | { kind: "sheet"; sheetIndex: number; sheet: ParsedTimesheet }
  | { kind: "error"; fileName: string; message: string };

const PREVIEW_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportTimesheetPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [fileStatuses, setFileStatuses] = useState<Map<string, FileStatus>>(new Map());
  const [forceReprocess, setForceReprocess] = useState<Set<string>>(new Set());
  const [fileResults, setFileResults] = useState<FileParseResult[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [selectedSheets, setSelectedSheets] = useState<Set<number>>(new Set());
  const [previewPage, setPreviewPage] = useState(0);
  const [previewPageSize, setPreviewPageSize] = useState(PREVIEW_PAGE_SIZE_OPTIONS[0]);
  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [recentFilesTotal, setRecentFilesTotal] = useState(0);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [viewerFile, setViewerFile] = useState<ImportFileRow | null>(null);

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
    cancelPreview();
    setSuccessMessage(null);
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
  }

  function cancelPreview() {
    setFileResults([]);
    setConflicts([]);
    setSelectedSheets(new Set());
    setPreviewPage(0);
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

  async function handlePick() {
    setError(null);
    const selected = await pickPdfFiles();
    if (selected.length > 0) addPaths(selected);
  }

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

  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const previewPageItems = useMemo(
    () =>
      previewRows.slice(
        previewPage * previewPageSize,
        previewPage * previewPageSize + previewPageSize,
      ),
    [previewRows, previewPage, previewPageSize],
  );

  const allSelected = sheets.length > 0 && sheets.every((_, i) => selectedSheets.has(i));

  const historyPageCount = Math.max(1, Math.ceil(recentFilesTotal / historyPageSize));

  async function handleParse() {
    if (!selectedClient) return;
    setError(null);
    setBusy(true);
    try {
      const results = await parseImport(provider, eligiblePaths);
      const allSheets = results.flatMap((r) => r.sheets);
      const foundConflicts = await findConflicts(allSheets, selectedClient.id);
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
      <Link to="/import" className="back-link">
        <ArrowLeft size={14} />
        Importar
      </Link>
      <div className="page-header">
        <h2>Importar espelhos de ponto</h2>
      </div>
      <p className="page-subtitle">
        Faça o upload dos arquivos PDF fornecidos pelo seu provedor de ponto para extrair os
        dados.
      </p>

      {error && <div className="error-box">{error}</div>}
      {successMessage && <div className="success-box">{successMessage}</div>}

      <div className="import-layout">
      <div className="import-main">
      <div className="card">
        <div className="field-row" style={{ marginBottom: "1.2rem" }}>
          <div className="field" style={{ flex: "1 1 220px" }}>
            <label htmlFor="client">Cliente</label>
            <select
              id="client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={clients.length === 0}
            >
              <option value="">Selecione um cliente</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {clients.length === 0 ? (
              <p className="field-hint">
                Nenhum cliente cadastrado. <Link to="/clients">Cadastre um cliente</Link> antes de
                importar.
              </p>
            ) : (
              <p className="field-hint">Os colaboradores importados ficam vinculados a ele.</p>
            )}
          </div>
          <div className="field" style={{ flex: "1 1 180px" }}>
            <label htmlFor="company">Empresa</label>
            <select
              id="company"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              disabled={clientCompanies.length <= 1}
            >
              {clientCompanies.length !== 1 && <option value="">Selecione uma empresa</option>}
              {clientCompanies.map((c) => (
                <option key={c.companyId} value={c.companyId}>
                  {c.companyName}
                </option>
              ))}
            </select>
            <p className="field-hint">
              {clientCompanies.length > 1
                ? "Esse cliente está vinculado a mais de uma empresa — escolha uma."
                : "Definida automaticamente pelo cliente selecionado."}
            </p>
          </div>
          <div className="field" style={{ flex: "1 1 220px" }}>
            <label htmlFor="provider">Provedor</label>
            <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.length === 0 && <option value="">Selecione um provedor</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="field-hint">O formato de extração varia conforme o sistema de origem.</p>
          </div>
        </div>

        <div className="field">
          <label>Arquivos PDF</label>
          <div className={`dropzone${dragActive ? " drag-active" : ""}`}>
            <div className="dropzone-icon">
              <UploadCloud size={20} />
            </div>
            <h4>Selecione ou arraste os PDFs</h4>
            <p className="muted" style={{ margin: 0 }}>
              Suporta múltiplos arquivos.
            </p>
            <button type="button" className="secondary" onClick={handlePick}>
              <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
              Procurar arquivos
            </button>
          </div>

          {paths.length > 0 && (
            <div className="file-list">
              {paths.map((p) => {
                const status = fileStatuses.get(p);
                return (
                  <div className="file-row" key={p}>
                    <div className="file-row-icon">
                      <FileText size={18} />
                    </div>
                    <div className="file-row-info">
                      <div className="file-name">{status?.fileName ?? p}</div>
                      {status?.duplicate && status.duplicate.employees.length > 0 && (
                        <div className="file-meta">
                          {status.duplicate.employees[0].companyName} ·{" "}
                          {status.duplicate.employees.map((e, i) => (
                            <span key={e.importId}>
                              {i > 0 && ", "}
                              <Link to={`/employee/${e.importId}`}>{e.employeeName}</Link>
                            </span>
                          ))}
                          {" · importado em "}
                          {formatDateTime(status.duplicate.importedAt)}
                        </div>
                      )}
                      {status?.duplicate && status.duplicate.employees.length === 0 && (
                        <div className="file-meta">
                          {status.duplicate.pageCount} páginas · importado em{" "}
                          {formatDateTime(status.duplicate.importedAt)}
                        </div>
                      )}
                    </div>
                    <div className="file-row-actions">
                      {status?.duplicate && !forceReprocess.has(p) && (
                        <>
                          <span className="badge duplicate">Já importado</span>
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
                      )}
                      {status?.duplicate && forceReprocess.has(p) && (
                        <>
                          <span className="badge warn">Será reprocessado</span>
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                            onClick={() => toggleForceReprocess(p)}
                          >
                            Cancelar
                          </button>
                        </>
                      )}
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
          {duplicateCount > 0 && (
            <p className="muted" style={{ textAlign: "center", marginTop: "0.75rem" }}>
              {duplicateCount} arquivo(s) já importado(s) não serão reprocessados.
            </p>
          )}
        </div>

        <div className="card-footer">
          <button
            type="button"
            disabled={eligiblePaths.length === 0 || !provider || !clientId || !companyId || busy}
            onClick={handleParse}
          >
            {busy ? "Processando..." : `Processar ${eligiblePaths.length || ""} PDF(s)`}
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
              {(conflicts.length > 0 || mismatchedSheetIndexes.size > 0) ? (
                <p className="muted" style={{ maxWidth: "42rem" }}>
                  {conflicts.length > 0 &&
                    "Alguns colaboradores já possuem dados importados para este período. "}
                  {mismatchedSheetIndexes.size > 0 &&
                    "Alguns arquivos têm um CNPJ diferente do cliente selecionado. "}
                  Revise a lista e marque o que você quer salvar — o resto fica de fora.
                </p>
              ) : (
                <p className="muted">Revise os dados antes de confirmar.</p>
              )}
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexShrink: 0 }}>
              <button type="button" className="outline" onClick={cancelPreview} disabled={busy}>
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || selectedSheets.size === 0}
              >
                {busy ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>

        <div className="card table-card">
          <div className="table-toolbar">
            <div className="counts">
              <span>{sheets.length} registro(s) encontrado(s)</span>
              {conflicts.length > 0 && (
                <span className="count-chip">{conflicts.length} conflito(s)</span>
              )}
              {errorCount > 0 && (
                <span className="badge file-error">
                  <AlertCircle size={13} />
                  {errorCount} erro(s)
                </span>
              )}
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
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
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
                        <span className="badge file-error">
                          <AlertCircle size={13} />
                          Erro no arquivo
                        </span>
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
                      {!conflict && !mismatched && (
                        <span className="badge ok">
                          <PlusCircle size={13} />
                          Novo
                        </span>
                      )}
                      {mismatched && (
                        <div style={{ marginBottom: conflict ? "0.4rem" : 0 }}>
                          <span className="badge warn">
                            <AlertTriangle size={13} />
                            CNPJ diferente do cliente selecionado
                          </span>
                        </div>
                      )}
                      {conflict && (
                        <>
                          <span className="badge overwrite">
                            <AlertTriangle size={13} />
                            Sobrescrever
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
                      <button
                        type="button"
                        className="ghost"
                        style={{ padding: "0.3rem" }}
                        onClick={() => setViewerFile(f)}
                        disabled={!f.originalPdfPath}
                        aria-label="Visualizar"
                        title={f.originalPdfPath ? "Visualizar" : "Arquivo original removido (Configurações)"}
                      >
                        <Eye size={14} />
                      </button>
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
      </div>

      <PdfViewerModal
        path={viewerFile?.originalPdfPath ?? null}
        title={viewerFile?.fileName}
        onClose={() => setViewerFile(null)}
      />
    </div>
  );
}
