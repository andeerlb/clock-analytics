import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import { createCompany, getCompany, updateCompany } from "../lib/db";
import { maskCnpj } from "../lib/format";

export default function CompanyFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [nightStartTime, setNightStartTime] = useState("22:00");
  const [nightEndTime, setNightEndTime] = useState("05:00");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    getCompany(Number(id))
      .then((c) => {
        setName(c.name);
        setCnpj(maskCnpj(c.cnpj));
        setNightStartTime(c.nightStartTime);
        setNightEndTime(c.nightEndTime);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, isEditing]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isEditing) {
        await updateCompany(Number(id), name, cnpj, nightStartTime, nightEndTime);
      } else {
        await createCompany(name, cnpj, nightStartTime, nightEndTime);
      }
      navigate("/companies");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/companies" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar empresa" : "Nova empresa"}</h2>
      </div>
      <p className="page-subtitle">
        O horário entre o início e o fim do noturno define quais turnos de um colaborador contam
        como noturnos ao calcular pagamentos — o padrão (22:00–05:00) segue a CLT.
      </p>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <div className="card" style={{ maxWidth: "32rem" }}>
          <form onSubmit={handleSubmit}>
            <div className="field" style={{ marginBottom: "1rem" }}>
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
            <div className="field" style={{ marginBottom: "1rem" }}>
              <label htmlFor="company-cnpj">CNPJ</label>
              <input
                id="company-cnpj"
                type="text"
                value={cnpj}
                onChange={(e) => setCnpj(maskCnpj(e.target.value))}
                placeholder="00.000.000/0000-00"
                inputMode="numeric"
                required
                style={{ width: "100%" }}
              />
            </div>
            <div className="field-row" style={{ marginBottom: "1.2rem" }}>
              <div className="field" style={{ flex: "0 1 160px" }}>
                <label htmlFor="company-night-start">Início do noturno</label>
                <input
                  id="company-night-start"
                  type="time"
                  value={nightStartTime}
                  onChange={(e) => setNightStartTime(e.target.value)}
                  required
                />
              </div>
              <div className="field" style={{ flex: "0 1 160px" }}>
                <label htmlFor="company-night-end">Fim do noturno</label>
                <input
                  id="company-night-end"
                  type="time"
                  value={nightEndTime}
                  onChange={(e) => setNightEndTime(e.target.value)}
                  required
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
