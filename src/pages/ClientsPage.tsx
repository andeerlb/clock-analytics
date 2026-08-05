import { Plus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listClients, type ClientRow } from "../lib/db";
import { formatCnpj } from "../lib/format";

interface ClientListRow {
  id: number;
  name: string;
  cnpj: string;
  companyNames: string[];
}

/** One row per client — `listClients` returns one row per (client, company) link, merged here since a client showing up once per empresa it's linked to is noise, not information. */
function groupByClient(rows: ClientRow[]): ClientListRow[] {
  const byId = new Map<number, ClientListRow>();
  for (const r of rows) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.companyNames.push(r.companyName);
    } else {
      byId.set(r.id, { id: r.id, name: r.name, cnpj: r.cnpj, companyNames: [r.companyName] });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export default function ClientsPage() {
  const navigate = useNavigate();
  const [rawClients, setRawClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listClients()
      .then(setRawClients)
      .finally(() => setLoading(false));
  }, []);

  const clients = useMemo(() => groupByClient(rawClients), [rawClients]);

  return (
    <div>
      <div className="page-header">
        <h2>Clientes</h2>
        <button type="button" onClick={() => navigate("/clients/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo cliente
        </button>
      </div>
      <p className="page-subtitle">
        O CNPJ do cliente é único: cadastrar o mesmo CNPJ para outra empresa apenas vincula o
        cliente já existente a ela, em vez de duplicá-lo. Ao importar, selecione o cliente e, se
        ele estiver vinculado a mais de uma empresa, escolha qual delas.
      </p>

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
                        <Link to={`/clients/${c.id}`}>{c.name}</Link>
                      </div>
                    </td>
                    <td className="mono">{formatCnpj(c.cnpj)}</td>
                    <td>{c.companyNames.join(", ")}</td>
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
