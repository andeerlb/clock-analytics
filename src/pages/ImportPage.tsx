import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FolderOpen, Lightbulb, ShieldCheck, UploadCloud } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listProviders, parseImport, pickPdfFiles } from "../lib/api";
import { saveParsedTimesheet } from "../lib/db";
import type { ParsedTimesheet, ProviderInfo } from "../lib/types";

export default function ImportPage() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<ParsedTimesheet[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProviders().then((list) => {
      setProviders(list);
      if (list.length > 0) setProvider(list[0].id);
    });
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setDragActive(true);
      } else if (event.payload.type === "drop") {
        setDragActive(false);
        const pdfPaths = event.payload.paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
        if (pdfPaths.length > 0) {
          setPaths((prev) => Array.from(new Set([...prev, ...pdfPaths])));
          setPreview([]);
        }
      } else {
        setDragActive(false);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function reset() {
    setPaths([]);
    setPreview([]);
    setError(null);
  }

  async function handlePick() {
    setError(null);
    const selected = await pickPdfFiles();
    if (selected.length > 0) {
      setPaths((prev) => Array.from(new Set([...prev, ...selected])));
      setPreview([]);
    }
  }

  async function handleParse() {
    setError(null);
    setBusy(true);
    try {
      const sheets = await parseImport(provider, paths);
      setPreview(sheets);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      let lastImportId: number | null = null;
      for (const sheet of preview) {
        lastImportId = await saveParsedTimesheet(sheet);
      }
      reset();
      navigate(lastImportId ? `/employee/${lastImportId}` : "/");
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
            {paths.length > 0 && (
              <ul className="dropzone-file-list">
                {paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card-footer">
          <button type="button" className="ghost" onClick={reset} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            disabled={paths.length === 0 || !provider || busy}
            onClick={handleParse}
          >
            {busy ? "Processando..." : `Processar ${paths.length || ""} PDF(s)`}
          </button>
        </div>
      </div>

      {preview.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Pré-visualização</h3>
          <table>
            <thead>
              <tr>
                <th>Colaborador</th>
                <th>CPF</th>
                <th>Empresa</th>
                <th>Período</th>
                <th>Dias lidos</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((sheet, i) => (
                <tr key={i}>
                  <td>{sheet.employee.name}</td>
                  <td>{sheet.employee.cpf}</td>
                  <td>{sheet.company.name}</td>
                  <td>
                    {sheet.period.start} a {sheet.period.end}
                  </td>
                  <td>{sheet.days.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-footer">
            <button type="button" onClick={handleSave} disabled={busy}>
              {busy ? "Salvando..." : "Salvar no banco"}
            </button>
          </div>
        </div>
      )}

      <div className="tip-grid">
        <div className="tip-card">
          <div className="tip-card-icon" style={{ background: "rgba(245, 158, 11, 0.15)" }}>
            <Lightbulb size={16} color="#fbbf24" />
          </div>
          <div>
            <h5>Dica de Importação</h5>
            <p>
              Garanta que os PDFs gerados pelo provedor não estejam protegidos por senha para que
              a extração funcione corretamente.
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
              Uma cópia do PDF original é mantida localmente neste computador, para que você possa
              reabri-lo a qualquer momento pelo botão "Ver relatório original".
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
