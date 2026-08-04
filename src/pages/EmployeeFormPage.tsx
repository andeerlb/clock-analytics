import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import {
  createEmployeeManual,
  getEmployee,
  listClients,
  updateEmployee,
  type ClientRow,
} from "../lib/db";
import { maskCpf } from "../lib/format";

export default function EmployeeFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();

  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [clientName, setClientName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [cpf, setCpf] = useState("");
  const [matricula, setMatricula] = useState("");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } else {
      listClients().then(setClients);
    }
  }, [id, isEditing]);

  // `clients` has one row per (client, company) link — same pattern as the
  // timesheet import form's Cliente/Empresa selects.
  const clientCompanies = useMemo(
    () => clients.filter((c) => String(c.id) === clientId),
    [clients, clientId],
  );

  useEffect(() => {
    if (clientCompanies.length === 1) {
      setCompanyId(String(clientCompanies[0].companyId));
    } else {
      setCompanyId("");
    }
  }, [clientCompanies]);

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
    </div>
  );
}
