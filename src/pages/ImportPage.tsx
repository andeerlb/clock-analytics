import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertCircle,
  AlertTriangle,
  Eye,
  FileText,
  FolderOpen,
  Lightbulb,
  PlusCircle,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Pagination from "../components/Pagination";
import { hashFiles, listProviders, parseImport, pickPdfFiles } from "../lib/api";
import { colorForName, initials } from "../lib/avatar";
import {
  findConflicts,
  listImportFiles,
  findDuplicateFiles,
  saveParsedTimesheet,
} from "../lib/db";
import { formatDateTime, formatPeriod } from "../lib/format";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  FileParseResult,
  ImportFileRow,
  ParsedTimesheet,
  ProviderInfo,
} from "../lib/types";

interface FileStatus {
  hash: string;
  fileName: string;
  duplicate: DuplicateFileInfo | null;
}

type PreviewRow =
  | { kind: "sheet"; sheetIndex: number; sheet: ParsedTimesheet }
  | { kind: "error"; fileName: string; message: string };

const PREVIEW_PAGE_SIZE = 10;

export default function ImportPage() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [fileStatuses, setFileStatuses] = useState<Map<string, FileStatus>>(new Map());
  const [fileResults, setFileResults] = useState<FileParseResult[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [selectedSheets, setSelectedSheets] = useState<Set<number>>(new Set());
  const [previewPage, setPreviewPage] = useState(0);
  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProviders().then((list) => {
      setProviders(list);
      if (list.length > 0) setProvider(list[0].id);
    });
    refreshRecentFiles();
  }, []);

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
    listImportFiles().then(setRecentFiles);
  }

  function addPaths(newPaths: string[]) {
    setPaths((prev) => Array.from(new Set([...prev, ...newPaths])));
    cancelPreview();
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
    cancelPreview();
    setError(null);
  }

  async function handlePick() {
    setError(null);
    const selected = await pickPdfFiles();
    if (selected.length > 0) addPaths(selected);
  }

  const eligiblePaths = useMemo(
    () => paths.filter((p) => !fileStatuses.get(p)?.duplicate),
    [paths, fileStatuses],
  );
  const duplicateCount = paths.length - eligiblePaths.length;

  // Flat list of every successfully parsed sheet, in file order — this is
  // what conflict-checking and saving iterate over. Index into this array
  // is the stable identity used for selection/conflict lookups.
  const sheets = useMemo(() => fileResults.flatMap((r) => r.sheets), [fileResults]);

  const conflictBySheetIndex = useMemo(
    () => new Map(conflicts.map((c) => [c.sheetIndex, c])),
    [conflicts],
  );

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

  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / PREVIEW_PAGE_SIZE));
  const previewPageItems = useMemo(
    () =>
      previewRows.slice(
        previewPage * PREVIEW_PAGE_SIZE,
        previewPage * PREVIEW_PAGE_SIZE + PREVIEW_PAGE_SIZE,
      ),
    [previewRows, previewPage],
  );

  const allSelected = sheets.length > 0 && sheets.every((_, i) => selectedSheets.has(i));

  async function handleParse() {
    setError(null);
    setBusy(true);
    try {
      const results = await parseImport(provider, eligiblePaths);
      const allSheets = results.flatMap((r) => r.sheets);
      const foundConflicts = await findConflicts(allSheets);
      // Rows with a conflict start unselected — overwriting is opt-in.
      const defaultSelected = new Set<number>();
      allSheets.forEach((_, i) => {
        if (!foundConflicts.some((c) => c.sheetIndex === i)) defaultSelected.add(i);
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
    setBusy(true);
    setError(null);
    try {
      let lastImportId: number | null = null;
      let savedCount = 0;
      for (let i = 0; i < sheets.length; i++) {
        if (!selectedSheets.has(i)) continue;
        const conflict = conflictBySheetIndex.get(i);
        lastImportId = await saveParsedTimesheet(sheets[i], conflict?.existingImportId);
        savedCount++;
      }
      refreshRecentFiles();
      reset();
      navigate(savedCount === 1 && lastImportId ? `/employee/${lastImportId}` : "/");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Importar espelhos de ponto</h2>
      </div>
      <p className="page-subtitle">
        Faça o upload dos arquivos PDF fornecidos pelo seu provedor de ponto para extrair os
        dados.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="import-layout">
      <div className="import-main">
      <div className="card">
        <div className="field" style={{ marginBottom: "1.2rem" }}>
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
                      {status?.duplicate && (
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
                    </div>
                    <div className="file-row-actions">
                      {status?.duplicate && <span className="badge duplicate">Já importado</span>}
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
            disabled={eligiblePaths.length === 0 || !provider || busy}
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
              {conflicts.length > 0 ? (
                <p className="muted" style={{ maxWidth: "42rem" }}>
                  Alguns colaboradores já possuem dados importados para este período. Revise a
                  lista e marque quem você quer <strong>sobrescrever</strong> — os demais não
                  terão os dados salvos.
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
                {busy ? "Salvando..." : "Salvar no banco"}
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
                <th style={{ textAlign: "right" }}>Dias lidos</th>
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
                      <td colSpan={5}>
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
                        <span
                          className="avatar"
                          style={{ background: colorForName(row.sheet.employee.name) }}
                        >
                          {initials(row.sheet.employee.name)}
                        </span>
                        {row.sheet.employee.name}
                      </div>
                    </td>
                    <td className="mono">{row.sheet.employee.cpf}</td>
                    <td>{row.sheet.company.name}</td>
                    <td>{formatPeriod(row.sheet.period.start, row.sheet.period.end)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {row.sheet.days.length}
                    </td>
                    <td>
                      {!conflict && (
                        <span className="badge ok">
                          <PlusCircle size={13} />
                          Novo
                        </span>
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

          {previewRows.length > PREVIEW_PAGE_SIZE && (
            <Pagination
              page={previewPage}
              pageCount={previewPageCount}
              onPageChange={setPreviewPage}
              rangeLabel={`Mostrando ${previewPage * PREVIEW_PAGE_SIZE + 1} a ${Math.min(
                previewRows.length,
                previewPage * PREVIEW_PAGE_SIZE + PREVIEW_PAGE_SIZE,
              )} de ${previewRows.length}`}
            />
          )}
        </div>
        </>
      )}
      </div>

      <div className="import-side">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Histórico de importações</h3>
          {recentFiles.length === 0 && <p className="muted">Nenhum arquivo importado ainda.</p>}
          {recentFiles.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Arquivo</th>
                  <th>Importado em</th>
                </tr>
              </thead>
              <tbody>
                {recentFiles.map((f) => (
                  <tr key={f.id}>
                    <td>{f.fileName}</td>
                    <td>{formatDateTime(f.importedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
    </div>
  );
}
