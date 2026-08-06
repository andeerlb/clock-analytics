import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import {
  addEmployeeAlias,
  createEmployeeManual,
  getEmployee,
  listClients,
  listEmployeeAliases,
  removeEmployeeAlias,
  updateEmployee,
  type ClientRow,
  type EmployeeAliasRow,
} from "../lib/db";
import { maskCpf } from "../lib/format";

/**
 * What a "Cadastrar colaborador" shortcut (e.g. from the payment import
 * preview) hands off — a name to start the form pre-filled with, and,
 * whenever the shortcut already resolved exactly which cliente/empresa the
 * colaborador belongs to (e.g. via a template's routing rule), that too.
 */
export interface EmployeeFormNavState {
  prefillName?: string;
  prefillClientId?: number;
  prefillCompanyId?: number;
}

export default function EmployeeFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  // Only used as the initial values below — irrelevant once editing takes
  // over the form, and never applies to `isEditing` at all (an existing
  // colaborador's fields always come from `getEmployee`).
  const prefill = !isEditing ? (location.state as EmployeeFormNavState | null) : null;

  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState(prefill?.prefillClientId !== undefined ? String(prefill.prefillClientId) : "");
  const [companyId, setCompanyId] = useState(
    prefill?.prefillCompanyId !== undefined ? String(prefill.prefillCompanyId) : "",
  );
  const [clientName, setClientName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState(prefill?.prefillName ?? "");
  const [cpf, setCpf] = useState("");
  const [matricula, setMatricula] = useState("");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [aliases, setAliases] = useState<EmployeeAliasRow[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);

  useEffect(() => {
    if (isEditing) {
      getEmployee(Number(id))
        .then((e) => {
          setName(e.name);
          setCpf(maskCpf(e.cpf));
          setMatricula(e.matricula ?? "");
          setClientName(e.clientName);
          setCompanyName(e.companyName);
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
        .finally(() => setLoading(false));
      listEmployeeAliases(Number(id)).then(setAliases);
    } else {
      listClients().then(setClients);
    }
  }, [id, isEditing]);

  async function handleAddAlias(e: React.FormEvent) {
    e.preventDefault();
    setAliasError(null);
    setAliasBusy(true);
    try {
      await addEmployeeAlias(Number(id), newAlias);
      setNewAlias("");
      setAliases(await listEmployeeAliases(Number(id)));
    } catch (err) {
      setAliasError(String(err instanceof Error ? err.message : err));
    } finally {
      setAliasBusy(false);
    }
  }

  async function handleRemoveAlias(aliasId: number) {
    await removeEmployeeAlias(aliasId);
    setAliases((prev) => prev.filter((a) => a.id !== aliasId));
  }

  // `clients` has one row per (client, company) link — same pattern as the
  // timesheet import form's Cliente/Empresa selects.
  const clientCompanies = useMemo(
    () => clients.filter((c) => String(c.id) === clientId),
    [clients, clientId],
  );

  useEffect(() => {
    // `clients` hasn't loaded yet — `clientCompanies` is spuriously empty
    // regardless of `clientId`, so there's nothing real to derive from it
    // yet. Without this guard, this effect fired on first mount (before
    // `listClients()` resolves), saw an empty `clientCompanies`, and wiped
    // out a pre-filled `companyId` (from "Cadastrar colaborador") before it
    // ever got a chance to be checked against the real list.
    if (clients.length === 0) return;
    // Already a valid choice for this clientCompanies set — leave it alone.
    // Covers both a still-fresh manual pick and a pre-filled `companyId`.
    if (clientCompanies.some((c) => String(c.companyId) === companyId)) return;
    if (clientCompanies.length === 1) {
      setCompanyId(String(clientCompanies[0].companyId));
    } else {
      setCompanyId("");
    }
  }, [clients, clientCompanies]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const trimmedMatricula = matricula.trim() || null;
      if (isEditing) {
        await updateEmployee(Number(id), name, cpf, trimmedMatricula);
      } else {
        await createEmployeeManual(Number(clientId), Number(companyId), name, cpf, trimmedMatricula);
      }
      navigate("/employees");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/employees" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar colaborador" : "Novo colaborador"}</h2>
      </div>
      <p className="page-subtitle">
        {isEditing
          ? "Cliente e empresa não podem ser alterados aqui — mudar de cliente é, na prática, um colaborador diferente."
          : "O CPF é único por cliente — o mesmo CPF pode existir para clientes diferentes."}
      </p>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <div className="card" style={{ maxWidth: "32rem" }}>
          <form onSubmit={handleSubmit}>
            {isEditing ? (
              <div className="field-row" style={{ marginBottom: "1rem" }}>
                <div className="field" style={{ flex: "1 1 200px" }}>
                  <label>Cliente</label>
                  <p className="muted" style={{ margin: 0 }}>{clientName}</p>
                </div>
                <div className="field" style={{ flex: "1 1 200px" }}>
                  <label>Empresa</label>
                  <p className="muted" style={{ margin: 0 }}>{companyName}</p>
                </div>
              </div>
            ) : (
              <div className="field-row" style={{ marginBottom: "1rem" }}>
                <div className="field" style={{ flex: "1 1 200px" }}>
                  <label htmlFor="employee-client">Cliente</label>
                  {clients.length === 0 ? (
                    <p className="field-hint">
                      Nenhum cliente cadastrado. <Link to="/clients">Cadastre um cliente</Link>{" "}
                      antes.
                    </p>
                  ) : (
                    <select
                      id="employee-client"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      required
                    >
                      <option value="">Selecione</option>
                      {Array.from(new Map(clients.map((c) => [c.id, c])).values()).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="field" style={{ flex: "1 1 180px" }}>
                  <label htmlFor="employee-company">Empresa</label>
                  <select
                    id="employee-company"
                    value={companyId}
                    onChange={(e) => setCompanyId(e.target.value)}
                    disabled={clientCompanies.length <= 1}
                    required
                  >
                    {clientCompanies.length !== 1 && <option value="">Selecione uma empresa</option>}
                    {clientCompanies.map((c) => (
                      <option key={c.companyId} value={c.companyId}>
                        {c.companyName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="field" style={{ marginBottom: "1rem" }}>
              <label htmlFor="employee-name">Nome</label>
              <input
                id="employee-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome completo"
                required
                style={{ width: "100%" }}
              />
            </div>
            <div className="field-row" style={{ marginBottom: "1.2rem" }}>
              <div className="field" style={{ flex: "1 1 200px" }}>
                <label htmlFor="employee-cpf">CPF</label>
                <input
                  id="employee-cpf"
                  type="text"
                  value={cpf}
                  onChange={(e) => setCpf(maskCpf(e.target.value))}
                  placeholder="000.000.000-00"
                  inputMode="numeric"
                  required
                  style={{ width: "100%" }}
                />
              </div>
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label htmlFor="employee-matricula">Matrícula (opcional)</label>
                <input
                  id="employee-matricula"
                  type="text"
                  value={matricula}
                  onChange={(e) => setMatricula(e.target.value)}
                  placeholder="Ex.: 00123"
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            <button type="submit" disabled={busy}>
              {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
            </button>
          </form>
        </div>
      )}

      {!loading && isEditing && (
        <div className="card" style={{ maxWidth: "32rem", marginTop: "1.2rem" }}>
          <h3 style={{ marginTop: 0 }}>Possíveis nomes</h3>
          <p className="page-subtitle" style={{ marginTop: 0 }}>
            Outras grafias do nome desse colaborador que podem aparecer em arquivos de pagamento
            (ex.: "Anderson Lucas" para "Anderson Lucas Babinski") — consideradas junto com o nome
            cadastrado ao buscar o colaborador durante a importação. Um nome só pode estar
            vinculado a um colaborador por vez, dentro do mesmo cliente.
          </p>

          {aliasError && <div className="error-box">{aliasError}</div>}

          {aliases.length > 0 && (
            <div className="file-list" style={{ marginBottom: "0.8rem" }}>
              {aliases.map((a) => (
                <div className="file-row" key={a.id}>
                  <div className="file-row-info">
                    <div className="file-name">{a.alias}</div>
                  </div>
                  <div className="file-row-actions">
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "0.3rem" }}
                      onClick={() => handleRemoveAlias(a.id)}
                      aria-label="Remover"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleAddAlias} style={{ display: "flex", gap: "0.5rem" }}>
            <input
              type="text"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder="Ex.: Anderson Lucas"
              style={{ flex: 1 }}
            />
            <button type="submit" className="secondary" disabled={aliasBusy || !newAlias.trim()}>
              <Plus size={14} style={{ marginRight: "0.3rem" }} />
              Adicionar
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
