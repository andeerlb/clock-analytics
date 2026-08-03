import { Building2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createCompany, listCompaniesWithStats, type CompanyWithStats } from "../lib/db";
import { formatCnpj } from "../lib/format";

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<CompanyWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return listCompaniesWithStats().then(setCompanies);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createCompany(name, cnpj);
      setName("");
      setCnpj("");
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Empresas</h2>
      </div>
      <p className="page-subtitle">
        Cadastre as empresas que podem ser selecionadas ao importar espelhos de ponto.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <form onSubmit={handleSubmit} className="field-row" style={{ marginBottom: 0 }}>
          <div className="field" style={{ flex: "2 1 240px" }}>
            <label htmlFor="company-name">Nome</label>
            <input
              id="company-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Razão social"
              required
              style={{ width: "100%" }}
            />
          </div>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <label htmlFor="company-cnpj">CNPJ</label>
            <input
              id="company-cnpj"
              type="text"
              value={cnpj}
              onChange={(e) => setCnpj(e.target.value)}
              placeholder="00.000.000/0000-00"
              required
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" disabled={busy}>
            {busy ? "Cadastrando..." : "Cadastrar"}
          </button>
        </form>
      </div>

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && companies.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhuma empresa cadastrada ainda.
          </p>
        )}
        {companies.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>CNPJ</th>
                  <th style={{ textAlign: "right" }}>Colaboradores</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="person-cell">
                        <span className="avatar" style={{ background: "var(--surface-variant)" }}>
                          <Building2 size={15} />
                        </span>
                        {c.name}
                      </div>
                    </td>
                    <td className="mono">{formatCnpj(c.cnpj)}</td>
                    <td style={{ textAlign: "right" }}>{c.employeeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
