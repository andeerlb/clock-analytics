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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProviders().then((list) => {
      setProviders(list);
      if (list.length > 0) setProvider(list[0].id);
    });
  }, []);

  async function handlePick() {
    setError(null);
    const selected = await pickPdfFiles();
    if (selected.length > 0) {
      setPaths(selected);
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
      setPaths([]);
      setPreview([]);
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

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="field-row">
          <div className="field">
            <label htmlFor="provider">Provedor</label>
            <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="secondary" onClick={handlePick}>
            Selecionar PDFs
          </button>
          <button type="button" disabled={paths.length === 0 || busy} onClick={handleParse}>
            {busy ? "Processando..." : `Processar ${paths.length || ""} PDF(s)`}
          </button>
        </div>
        {paths.length > 0 && (
          <ul className="muted">
            {paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>

      {preview.length > 0 && (
        <div className="card">
          <h3>Pré-visualização</h3>
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
          <div className="field-row" style={{ marginTop: "1rem" }}>
            <button type="button" onClick={handleSave} disabled={busy}>
              {busy ? "Salvando..." : "Salvar no banco"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
