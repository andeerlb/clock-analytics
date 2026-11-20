import { Building2, Plus } from "lucide-react";
import { UpdatedByCell, useLastActivity } from "../components/ActivityInfo";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useReadOnly } from "../components/AreaRoute";
import CountCell from "../components/CountCell";
import PageHeader from "../components/PageHeader";
import { listCompanies, type CompanyRow } from "../lib/db";
import { formatCnpj } from "../lib/format";

export default function CompaniesPage() {
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const lastActivity = useLastActivity("company", companies.map((c) => c.id));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCompanies()
      .then(setCompanies)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader
        title="Empresas"
        subtitle="Cadastre as empresas que podem ser selecionadas ao importar espelhos de ponto."
        actions={
          !readOnly && (
            <button type="button" onClick={() => navigate("/companies/new")}>
              <Plus size={15} />
              Nova empresa
            </button>
          )
        }
      />

      {error && <div className="error-box">Não foi possível carregar as empresas: {error}</div>}

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && !error && companies.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhuma empresa cadastrada ainda.
          </p>
        )}
        {companies.length > 0 && (
          <div className="table-scroll">
            <table className="mobile-cards">
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>CNPJ</th>
                  <th>Horário noturno</th>
                  <th className="count-col">Clientes</th>
                  <th className="count-col">Colaboradores</th>
                  <th>Atualizado</th>
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
                        <Link to={`/companies/${c.id}`}>{c.name}</Link>
                      </div>
                    </td>
                    <td className="mono">{formatCnpj(c.cnpj)}</td>
                    <td className="mono">
                      {c.nightStartTime}–{c.nightEndTime}
                    </td>
                    <CountCell value={c.clientCount ?? 0} singular="cliente" plural="clientes" />
                    <CountCell value={c.employeeCount ?? 0} singular="colaborador" plural="colaboradores" />
                    <td>
                      <UpdatedByCell info={lastActivity.get(String(c.id))} />
                    </td>
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
