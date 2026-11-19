import { Building2, Calculator, Info, Moon, Plus, X } from "lucide-react";
import { RecordActivityFooter } from "../components/ActivityInfo";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { READ_ONLY_TITLE, useReadOnly } from "../components/AreaRoute";
import FormPanel from "../components/FormPanel";
import NightShiftRuleFields from "../components/NightShiftRuleFields";
import PageHeader from "../components/PageHeader";
import PaymentValueRulesEditor, {
  fromPaymentValueRules,
  isValueRulesValid,
  toPaymentValueRules,
  type WizardValueRule,
} from "../components/PaymentValueRulesEditor";
import {
  getCompany,
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
  const readOnly = useReadOnly();

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
  // "Usar os da empresa" vs "Definir próprios". Saved the same way as
  // before — an empty list means "inherit the company's chain entirely" —
  // the switch only makes that choice visible. The draft rules are kept
  // while switching back and forth, and only dropped on save.
  const [valueRules, setValueRules] = useState<WizardValueRule[]>([]);
  const [ownValueRules, setOwnValueRules] = useState(false);
  const [companyValueRules, setCompanyValueRules] = useState<
    { id: number; name: string; rules: WizardValueRule[]; nightStartTime: string; nightEndTime: string; nightShiftRule: NightShiftRule }[]
  >([]);
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentCompanies = isEditing ? linkedCompanies : pendingCompanies;

  // What the form held when it was loaded — anything different shows "Alterações não salvas" next to Salvar.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(isEditing ? null : "");
  const snapshot = JSON.stringify([name, cnpj, overrideNightShift, nightStartTime, nightEndTime, nightShiftRule, ownValueRules, valueRules]);
  const dirty = savedSnapshot !== null && snapshot !== savedSnapshot && (isEditing || name.trim() !== "" || cnpj.trim() !== "");
  const canSave = !busy && (isEditing || pendingCompanies.length > 0) && (!ownValueRules || isValueRulesValid(valueRules)) && (!isEditing || dirty);
  const companyIdsKey = currentCompanies.map((c) => c.id).join(",");

  // The rules each linked empresa would hand down, shown read-only under "Usar os da empresa".
  useEffect(() => {
    let cancelled = false;
    Promise.all(currentCompanies.map((c) => getCompany(c.id).then((d) => ({
          id: c.id,
          name: c.name,
          rules: fromPaymentValueRules(d.valueRules),
          nightStartTime: d.nightStartTime,
          nightEndTime: d.nightEndTime,
          nightShiftRule: d.nightShiftRule,
        }))))
      .then((list) => {
        if (!cancelled) setCompanyValueRules(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyIdsKey]);

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
        const rules = fromPaymentValueRules(c.valueRules);
        setValueRules(rules);
        setOwnValueRules(c.valueRules.length > 0);
        const override = c.nightStartTime !== null;
        setSavedSnapshot(
          JSON.stringify([
            c.name,
            maskCnpj(c.cnpj),
            override,
            override ? c.nightStartTime : "22:00",
            override ? c.nightEndTime : "05:00",
            override ? c.nightShiftRule : "overlap",
            c.valueRules.length > 0,
            rules,
          ]),
        );
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
      const valueRuleInputs = ownValueRules ? toPaymentValueRules(valueRules) : [];
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
      <PageHeader
        title={isEditing ? (readOnly ? "Cliente" : "Editar cliente") : "Novo cliente"}
        backFallback="/clients"
        backLabel="Voltar para Clientes"
        actions={
          !loading && !readOnly && (
            <>
              {dirty && (
                <span className="form-dirty">
                  <i />
                  Alterações não salvas
                </span>
              )}
              <button type="submit" form="client-form" disabled={!canSave}>
                {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
              </button>
            </>
          )
        }
        subtitle={
          isEditing
            ? "Um cliente precisa continuar vinculado a pelo menos uma empresa — não é possível remover a última, nem uma empresa com colaboradores cadastrados para este cliente."
            : "O CNPJ do cliente é único: cadastrar o mesmo CNPJ para outra empresa apenas vincula o cliente já existente a ela, em vez de duplicá-lo."
        }
      />

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        // View-only profile: everything stays readable, nothing editable.
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <form id="client-form" onSubmit={handleSubmit} className="details-main" style={{ maxWidth: "52rem" }}>
          <FormPanel icon={Building2} title="Empresas vinculadas">
            <div className="field">
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
                          disabled={readOnly || companyBusy}
                          title={readOnly ? READ_ONLY_TITLE : undefined}
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
                !readOnly && addableCompanies.length > 0 && (
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
          </FormPanel>

          <FormPanel icon={Info} title="Dados do cliente">
            <div className="form-row-2">
            <div className="field">
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
            <div className="field">
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
            </div>
          </FormPanel>

          <FormPanel
            icon={Moon}
            title="Horário noturno"
            description="Por padrão este cliente usa o horário noturno da empresa. Defina um próprio só se ele for diferente."
          >
            <div className="vr-inherit">
              <span className="vr-inherit-text">
                {overrideNightShift
                  ? "Horário próprio deste cliente; o da empresa não vale para ele."
                  : currentCompanies.length
                    ? `Usando o horário de ${currentCompanies.map((c) => c.name).join(", ")}.`
                    : "Vincule uma empresa para ver o horário que este cliente vai usar."}
              </span>
              <div className="analytics-seg" role="group" aria-label="Horário noturno deste cliente">
                <button type="button" aria-pressed={!overrideNightShift} onClick={() => setOverrideNightShift(false)}>
                  Usar o da empresa
                </button>
                <button type="button" aria-pressed={overrideNightShift} onClick={() => setOverrideNightShift(true)}>
                  Definir próprio
                </button>
              </div>
            </div>
            {overrideNightShift ? (
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
                readOnly={readOnly}
              />
            ) : (
              companyValueRules.map((c) => (
                <div key={c.id}>
                  {companyValueRules.length > 1 && <div className="vr-company-label">{c.name}</div>}
                  <NightShiftRuleFields
                    nightStartTime={c.nightStartTime}
                    nightEndTime={c.nightEndTime}
                    nightShiftRule={c.nightShiftRule}
                    idPrefix={`company-${c.id}`}
                    readOnly
                  />
                </div>
              ))
            )}
          </FormPanel>

          <FormPanel
            icon={Calculator}
            title="Valor do turno"
            description="Por padrão este cliente usa os valores da empresa. Defina valores próprios só se ele pagar diferente."
          >
            <div className="vr-inherit">
              <span className="vr-inherit-text">
                {ownValueRules
                  ? "Regras próprias deste cliente; as da empresa não valem para ele."
                  : currentCompanies.length
                    ? `Usando as regras de ${currentCompanies.map((c) => c.name).join(", ")}.`
                    : "Vincule uma empresa para ver as regras que este cliente vai usar."}
              </span>
              <div className="analytics-seg" role="group" aria-label="Valores deste cliente">
                <button type="button" aria-pressed={!ownValueRules} onClick={() => setOwnValueRules(false)}>
                  Usar os da empresa
                </button>
                <button type="button" aria-pressed={ownValueRules} onClick={() => setOwnValueRules(true)}>
                  Definir próprios
                </button>
              </div>
            </div>
            {ownValueRules ? (
              <PaymentValueRulesEditor valueRules={valueRules} onChange={setValueRules} companyIds={currentCompanies.map((c) => c.id)} readOnly={readOnly} />
            ) : (
              companyValueRules.map((c) => (
                <div key={c.id}>
                  {companyValueRules.length > 1 && <div className="vr-company-label">{c.name}</div>}
                  {c.rules.length ? (
                    <PaymentValueRulesEditor valueRules={c.rules} readOnly />
                  ) : (
                    <p className="vr-hint">{c.name} não tem regras de valor: o valor dos turnos não é calculado.</p>
                  )}
                </div>
              ))
            )}
          </FormPanel>

        </form>
        {isEditing && <RecordActivityFooter entityType="client" id={id} />}
        </fieldset>
      )}
    </div>
  );
}
