import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileText, FolderOpen, Lightbulb, ShieldCheck, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { hashFiles, listProviders, parseImport, pickPdfFiles } from "../lib/api";
import {
  findConflicts,
  listImportFiles,
  findDuplicateFiles,
  saveParsedTimesheet,
} from "../lib/db";
import type {
  ConflictInfo,
  DuplicateFileInfo,
  ImportFileRow,
  ParsedTimesheet,
  ProviderInfo,
} from "../lib/types";

interface FileStatus {
  hash: string;
  fileName: string;
  duplicate: DuplicateFileInfo | null;
}

export default function ImportPage() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [fileStatuses, setFileStatuses] = useState<Map<string, FileStatus>>(new Map());
  const [preview, setPreview] = useState<ParsedTimesheet[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [overwriteSelected, setOverwriteSelected] = useState<Set<number>>(new Set());
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
    setPreview([]);
    setConflicts([]);
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
  }

  function reset() {
    setPaths([]);
    setPreview([]);
    setConflicts([]);
    setOverwriteSelected(new Set());
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

  async function handleParse() {
    setError(null);
    setBusy(true);
    try {
      const sheets = await parseImport(provider, eligiblePaths);
      const foundConflicts = await findConflicts(sheets);
      setPreview(sheets);
      setConflicts(foundConflicts);
      setOverwriteSelected(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleOverwrite(sheetIndex: number) {
    setOverwriteSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sheetIndex)) next.delete(sheetIndex);
      else next.add(sheetIndex);
      return next;
    });
  }

  const conflictBySheetIndex = useMemo(
    () => new Map(conflicts.map((c) => [c.sheetIndex, c])),
    [conflicts],
  );

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      let lastImportId: number | null = null;
      let savedCount = 0;
      for (let i = 0; i < preview.length; i++) {
        const conflict = conflictBySheetIndex.get(i);
        if (conflict && !overwriteSelected.has(i)) continue; // conflicting + not confirmed: skip
        lastImportId = await saveParsedTimesheet(preview[i], conflict?.existingImportId);
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
                          {status.duplicate.employeeName} · {status.duplicate.companyName} ·
                          importado em {status.duplicate.importedAt}{" "}
                          <Link to={`/employee/${status.duplicate.importId}`}>ver</Link>
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

      {preview.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Pré-visualização</h3>
          {conflicts.length > 0 && (
            <p className="muted" style={{ marginTop: "-0.4rem" }}>
              Alguns colaboradores já têm dados importados para esse período. Marque quem você
              quer <strong>sobrescrever</strong> — os demais não terão os dados salvos.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Colaborador</th>
                <th>CPF</th>
                <th>Empresa</th>
                <th>Período</th>
                <th>Dias lidos</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((sheet, i) => {
                const conflict = conflictBySheetIndex.get(i);
                return (
                  <tr key={i}>
                    <td>{sheet.employee.name}</td>
                    <td>{sheet.employee.cpf}</td>
                    <td>{sheet.company.name}</td>
                    <td>
                      {sheet.period.start} a {sheet.period.end}
                    </td>
                    <td>{sheet.days.length}</td>
                    <td>
                      {!conflict && <span className="badge ok">Novo</span>}
                      {conflict && (
                        <label
                          style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
                          className="muted"
                        >
                          <input
                            type="checkbox"
                            checked={overwriteSelected.has(i)}
                            onChange={() => toggleOverwrite(i)}
                          />
                          Sobrescrever ({conflict.existingPeriodStart} a{" "}
                          {conflict.existingPeriodEnd}, {conflict.existingImportedAt})
                        </label>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="card-footer">
            <button type="button" onClick={handleSave} disabled={busy}>
              {busy ? "Salvando..." : "Salvar no banco"}
            </button>
          </div>
        </div>
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
                    <td>{f.importedAt}</td>
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
