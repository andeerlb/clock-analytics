import { Building2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listCompaniesWithStats, type CompanyWithStats } from "../lib/db";
import { formatCnpj } from "../lib/format";

export default function CompaniesPage() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<CompanyWithStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listCompaniesWithStats()
      .then(setCompanies)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h2>Empresas</h2>
        <button type="button" onClick={() => navigate("/companies/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Nova empresa
        </button>
      </div>
      <p className="page-subtitle">
        Cadastre as empresas que podem ser selecionadas ao importar espelhos de ponto.
      </p>

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
                  <th>Horário noturno</th>
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
                        <Link to={`/companies/${c.id}`}>{c.name}</Link>
                      </div>
                    </td>
                    <td className="mono">{formatCnpj(c.cnpj)}</td>
                    <td className="mono">
                      {c.nightStartTime}–{c.nightEndTime}
                    </td>
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
