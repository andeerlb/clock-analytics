import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  createClient,
  listClientsWithStats,
  listCompanies,
  type ClientWithStats,
  type CompanyRow,
} from "../lib/db";
import { formatCnpj } from "../lib/format";

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientWithStats[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState("");
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return listClientsWithStats().then(setClients);
  }

  useEffect(() => {
    Promise.all([refresh(), listCompanies().then(setCompanies)]).finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createClient(Number(companyId), name, cnpj);
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
        <h2>Clientes</h2>
      </div>
      <p className="page-subtitle">
        O CNPJ do cliente é único: cadastrar o mesmo CNPJ para outra empresa apenas vincula o
        cliente já existente a ela, em vez de duplicá-lo. Ao importar, selecione o cliente e, se
        ele estiver vinculado a mais de uma empresa, escolha qual delas.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        {companies.length === 0 ? (
          <p className="muted">
            Nenhuma empresa cadastrada ainda. <Link to="/companies">Cadastre uma empresa</Link>{" "}
            antes de cadastrar clientes.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="field-row" style={{ marginBottom: 0 }}>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="client-company">Empresa</label>
              <select
                id="client-company"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                required
              >
                <option value="">Selecione</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: "2 1 240px" }}>
              <label htmlFor="client-name">Nome</label>
              <input
                id="client-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Razão social do cliente"
                required
                style={{ width: "100%" }}
              />
            </div>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="client-cnpj">CNPJ</label>
              <input
                id="client-cnpj"
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
        )}
      </div>

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && clients.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum cliente cadastrado ainda.
          </p>
        )}
        {clients.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>CNPJ</th>
                  <th>Empresa</th>
                  <th style={{ textAlign: "right" }}>Colaboradores</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="person-cell">
                        <span className="avatar" style={{ background: "var(--surface-variant)" }}>
                          <Users size={15} />
                        </span>
                        {c.name}
                      </div>
                    </td>
                    <td className="mono">{formatCnpj(c.cnpj)}</td>
                    <td>{c.companyName}</td>
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
