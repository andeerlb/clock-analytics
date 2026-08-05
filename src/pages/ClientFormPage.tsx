import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import {
  addClientCompany,
  createClient,
  getClient,
  listCompanies,
  removeClientCompany,
  updateClient,
  type CompanyRow,
} from "../lib/db";
import { maskCnpj } from "../lib/format";

export default function ClientFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  // Editing: companies already linked in the DB (add/remove act on it right
  // away). Creating: companies picked so far, held only in memory until
  // submit — there's no clientId yet to link them to.
  const [linkedCompanies, setLinkedCompanies] = useState<{ id: number; name: string }[]>([]);
  const [pendingCompanies, setPendingCompanies] = useState<{ id: number; name: string }[]>([]);
  const [addCompanyId, setAddCompanyId] = useState("");
  const [companyBusy, setCompanyBusy] = useState(false);
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentCompanies = isEditing ? linkedCompanies : pendingCompanies;

  useEffect(() => {
    listCompanies().then(setCompanies);
    if (isEditing) {
      refreshClient();
    }
  }, [id, isEditing]);

  function refreshClient() {
    return getClient(Number(id))
      .then((c) => {
        setName(c.name);
        setCnpj(maskCnpj(c.cnpj));
        setLinkedCompanies(c.companies);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }

  const addableCompanies = companies.filter((c) => !currentCompanies.some((lc) => lc.id === c.id));

  async function handleAddCompany() {
    if (!addCompanyId) return;
    setCompanyError(null);

    if (!isEditing) {
      const company = companies.find((c) => c.id === Number(addCompanyId));
      if (company) setPendingCompanies((prev) => [...prev, { id: company.id, name: company.name }]);
      setAddCompanyId("");
      return;
    }

    setCompanyBusy(true);
    try {
      await addClientCompany(Number(id), Number(addCompanyId));
      setAddCompanyId("");
      await refreshClient();
    } catch (err) {
      setCompanyError(String(err instanceof Error ? err.message : err));
    } finally {
      setCompanyBusy(false);
    }
  }

  async function handleRemoveCompany(companyId: number) {
    setCompanyError(null);

    if (!isEditing) {
      setPendingCompanies((prev) => prev.filter((c) => c.id !== companyId));
      return;
    }

    setCompanyBusy(true);
    try {
      await removeClientCompany(Number(id), companyId);
      await refreshClient();
    } catch (err) {
      setCompanyError(String(err instanceof Error ? err.message : err));
    } finally {
      setCompanyBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isEditing) {
        await updateClient(Number(id), name, cnpj);
      } else {
        await createClient(pendingCompanies.map((c) => c.id), name, cnpj);
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
          ? "Um cliente precisa continuar vinculado a pelo menos uma empresa — não é possível remover a última, nem uma empresa com colaboradores cadastrados para este cliente."
          : "O CNPJ do cliente é único: cadastrar o mesmo CNPJ para outra empresa apenas vincula o cliente já existente a ela, em vez de duplicá-lo."}
      </p>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <div className="card" style={{ maxWidth: "32rem" }}>
          <form onSubmit={handleSubmit}>
            <div className="field" style={{ marginBottom: "1rem" }}>
              <label>Empresas vinculadas</label>

              {companyError && <div className="error-box">{companyError}</div>}

              {currentCompanies.length > 0 && (
                <div className="file-list" style={{ marginBottom: "0.6rem" }}>
                  {currentCompanies.map((c) => (
                    <div className="file-row" key={c.id}>
                      <div className="file-row-info">
                        <div className="file-name">{c.name}</div>
                      </div>
                      <div className="file-row-actions">
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => handleRemoveCompany(c.id)}
                          disabled={companyBusy}
                          aria-label="Remover"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {companies.length === 0 ? (
                <p className="field-hint">
                  Nenhuma empresa cadastrada. <Link to="/companies">Cadastre uma empresa</Link> antes.
                </p>
              ) : (
                addableCompanies.length > 0 && (
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <select
                      value={addCompanyId}
                      onChange={(e) => setAddCompanyId(e.target.value)}
                      style={{ flex: 1 }}
                    >
                      <option value="">Vincular a outra empresa...</option>
                      {addableCompanies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="secondary"
                      disabled={companyBusy || !addCompanyId}
                      onClick={handleAddCompany}
                    >
                      <Plus size={14} style={{ marginRight: "0.3rem" }} />
                      Adicionar
                    </button>
                  </div>
                )
              )}
            </div>

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

            <button type="submit" disabled={busy || (!isEditing && pendingCompanies.length === 0)}>
              {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
