import { Calculator, Moon, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import NightShiftRuleFields from "../components/NightShiftRuleFields";
import PaymentValueRulesEditor, {
  fromPaymentValueRules,
  isValueRulesValid,
  toPaymentValueRules,
  type WizardValueRule,
} from "../components/PaymentValueRulesEditor";
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
import type { NightShiftRule } from "../lib/types";

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
  // Unlike a company, a client's night-shift window/rule is optional — off
  // by default means "inherit the linked company's own window/rule" (see
  // `getEffectivePaymentRules` in db.ts). The 3 fields below only matter
  // while this is on.
  const [overrideNightShift, setOverrideNightShift] = useState(false);
  const [nightStartTime, setNightStartTime] = useState("22:00");
  const [nightEndTime, setNightEndTime] = useState("05:00");
  const [nightShiftRule, setNightShiftRule] = useState<NightShiftRule>("overlap");
  // No separate toggle for value rules — an empty list already means "no
  // override, inherit the company's chain entirely" (same convention as
  // every other optional rule chain in this project).
  const [valueRules, setValueRules] = useState<WizardValueRule[]>([]);
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
        setOverrideNightShift(c.nightStartTime !== null);
        if (c.nightStartTime !== null && c.nightEndTime !== null && c.nightShiftRule !== null) {
          setNightStartTime(c.nightStartTime);
          setNightEndTime(c.nightEndTime);
          setNightShiftRule(c.nightShiftRule);
        }
        setValueRules(fromPaymentValueRules(c.valueRules));
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
      const valueRuleInputs = toPaymentValueRules(valueRules);
      const nightArgs: [string | null, string | null, NightShiftRule | null] = overrideNightShift
        ? [nightStartTime, nightEndTime, nightShiftRule]
        : [null, null, null];

      if (isEditing) {
        await updateClient(Number(id), name, cnpj, ...nightArgs, valueRuleInputs);
      } else {
        await createClient(pendingCompanies.map((c) => c.id), name, cnpj, ...nightArgs, valueRuleInputs);
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

            <section className="glass-panel" style={{ marginBottom: "1.2rem" }}>
              <h3 className="glass-panel-heading">
                <Moon size={18} />
                Horário noturno
              </h3>
              <p className="glass-panel-desc">
                Por padrão, este cliente usa o horário noturno configurado na empresa. Sobrescreva
                aqui só se este cliente específico tiver um horário diferente.
              </p>
              <label className="field-code-checkbox" style={{ marginBottom: overrideNightShift ? "1rem" : 0 }}>
                <input
                  type="checkbox"
                  checked={overrideNightShift}
                  onChange={(e) => setOverrideNightShift(e.target.checked)}
                />
                Sobrescrever horário noturno da empresa
              </label>
              {overrideNightShift && (
                <NightShiftRuleFields
                  nightStartTime={nightStartTime}
                  nightEndTime={nightEndTime}
                  nightShiftRule={nightShiftRule}
                  onChange={(patch) => {
                    if (patch.nightStartTime !== undefined) setNightStartTime(patch.nightStartTime);
                    if (patch.nightEndTime !== undefined) setNightEndTime(patch.nightEndTime);
                    if (patch.nightShiftRule !== undefined) setNightShiftRule(patch.nightShiftRule);
                  }}
                  idPrefix="client"
                />
              )}
            </section>

            <section className="glass-panel" style={{ marginBottom: "1.2rem" }}>
              <h3 className="glass-panel-heading">
                <Calculator size={18} />
                Regras de valor por hora trabalhada
              </h3>
              <p className="glass-panel-desc">
                Por padrão, este cliente usa as regras de valor configuradas na empresa. Cadastre
                regras aqui só se este cliente específico tiver valores diferentes — sem nenhuma
                regra, o Valor continua vindo da empresa.
              </p>
              <PaymentValueRulesEditor valueRules={valueRules} onChange={setValueRules} />
            </section>

            <button
              type="submit"
              disabled={busy || (!isEditing && pendingCompanies.length === 0) || !isValueRulesValid(valueRules)}
            >
              {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
