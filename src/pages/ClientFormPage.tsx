import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import { createClient, getClient, listCompanies, updateClient, type CompanyRow } from "../lib/db";
import { maskCnpj } from "../lib/format";

export default function ClientFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [linkedCompanies, setLinkedCompanies] = useState<{ id: number; name: string }[]>([]);
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isEditing) {
      getClient(Number(id))
        .then((c) => {
          setName(c.name);
          setCnpj(maskCnpj(c.cnpj));
          setLinkedCompanies(c.companies);
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
        .finally(() => setLoading(false));
    } else {
      listCompanies().then(setCompanies);
    }
  }, [id, isEditing]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isEditing) {
        await updateClient(Number(id), name, cnpj);
      } else {
        await createClient(Number(companyId), name, cnpj);
      }
      navigate("/clients");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/clients" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar cliente" : "Novo cliente"}</h2>
      </div>
      <p className="page-subtitle">
        {isEditing
          ? "As empresas vinculadas a este cliente não são editadas aqui — cadastre o cliente novamente com o mesmo CNPJ na tela de Clientes para vinculá-lo a outra empresa."
          : "O CNPJ do cliente é único: cadastrar o mesmo CNPJ para outra empresa apenas vincula o cliente já existente a ela, em vez de duplicá-lo."}
      </p>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <div className="card" style={{ maxWidth: "32rem" }}>
          <form onSubmit={handleSubmit}>
            {isEditing ? (
              <div className="field" style={{ marginBottom: "1rem" }}>
                <label>Empresas vinculadas</label>
                <p className="muted" style={{ margin: 0 }}>
                  {linkedCompanies.map((c) => c.name).join(", ")}
                </p>
              </div>
            ) : (
              <div className="field" style={{ marginBottom: "1rem" }}>
                <label htmlFor="client-company">Empresa</label>
                {companies.length === 0 ? (
                  <p className="field-hint">
                    Nenhuma empresa cadastrada. <Link to="/companies">Cadastre uma empresa</Link>{" "}
                    antes.
                  </p>
                ) : (
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
                )}
              </div>
            )}

            <div className="field" style={{ marginBottom: "1rem" }}>
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
            <div className="field" style={{ marginBottom: "1.2rem" }}>
              <label htmlFor="client-cnpj">CNPJ</label>
              <input
                id="client-cnpj"
                type="text"
                value={cnpj}
                onChange={(e) => setCnpj(maskCnpj(e.target.value))}
                placeholder="00.000.000/0000-00"
                inputMode="numeric"
                required
                style={{ width: "100%" }}
              />
            </div>

            <button type="submit" disabled={busy}>
              {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
