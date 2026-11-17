import { Building2, Calculator, Moon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import FormPanel from "../components/FormPanel";
import NightShiftRuleFields from "../components/NightShiftRuleFields";
import PageHeader from "../components/PageHeader";
import PaymentValueRulesEditor, {
  fromPaymentValueRules,
  isValueRulesValid,
  toPaymentValueRules,
  type WizardValueRule,
} from "../components/PaymentValueRulesEditor";
import { createCompany, getCompany, updateCompany } from "../lib/db";
import { maskCnpj } from "../lib/format";
import type { NightShiftRule } from "../lib/types";

export default function CompanyFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [nightStartTime, setNightStartTime] = useState("22:00");
  const [nightEndTime, setNightEndTime] = useState("05:00");
  const [nightShiftRule, setNightShiftRule] = useState<NightShiftRule>("overlap");
  const [valueRules, setValueRules] = useState<WizardValueRule[]>([]);
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the form held when it was loaded (or empty, for a new company) —
  // anything different shows "Alterações não salvas" next to Salvar.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(isEditing ? null : "");
  const snapshot = useMemo(
    () => JSON.stringify([name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRules]),
    [name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRules],
  );
  const dirty = savedSnapshot !== null && snapshot !== savedSnapshot && (isEditing || name.trim() !== "" || cnpj.trim() !== "");

  useEffect(() => {
    if (!isEditing) return;
    getCompany(Number(id))
      .then((c) => {
        setName(c.name);
        setCnpj(maskCnpj(c.cnpj));
        setNightStartTime(c.nightStartTime);
        setNightEndTime(c.nightEndTime);
        setNightShiftRule(c.nightShiftRule);
        const rules = fromPaymentValueRules(c.valueRules);
        setValueRules(rules);
        setSavedSnapshot(JSON.stringify([c.name, maskCnpj(c.cnpj), c.nightStartTime, c.nightEndTime, c.nightShiftRule, rules]));
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [id, isEditing]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const valueRuleInputs = toPaymentValueRules(valueRules);

      if (isEditing) {
        await updateCompany(Number(id), name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRuleInputs);
      } else {
        await createCompany(name, cnpj, nightStartTime, nightEndTime, nightShiftRule, valueRuleInputs);
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
      <PageHeader
        title={isEditing ? "Editar empresa" : "Nova empresa"}
        subtitle="Dados da empresa, horário noturno e valor do turno."
        backFallback="/companies"
        backLabel="Voltar para Empresas"
        actions={
          !loading && (
            <>
              {dirty && (
                <span className="form-dirty">
                  <i />
                  Alterações não salvas
                </span>
              )}
              <button type="submit" form="company-form" disabled={busy || !isValueRulesValid(valueRules) || (isEditing && !dirty)}>
                {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
              </button>
            </>
          )
        }
      />

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <form id="company-form" onSubmit={handleSubmit} className="details-main" style={{ maxWidth: "52rem" }}>
          <FormPanel icon={Building2} title="Dados da empresa">
            <div className="form-row-2">
            <div className="field">
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
            <div className="field">
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
            </div>
          </FormPanel>

          <FormPanel
            icon={Moon}
            title="Horário noturno"
            description="Separa os turnos em diurnos e noturnos nos filtros de Pagamentos e em Análises. O padrão da CLT é das 22:00 às 05:00."
          >
            <NightShiftRuleFields
              nightStartTime={nightStartTime}
              nightEndTime={nightEndTime}
              nightShiftRule={nightShiftRule}
              onChange={(patch) => {
                if (patch.nightStartTime !== undefined) setNightStartTime(patch.nightStartTime);
                if (patch.nightEndTime !== undefined) setNightEndTime(patch.nightEndTime);
                if (patch.nightShiftRule !== undefined) setNightShiftRule(patch.nightShiftRule);
              }}
              idPrefix="company"
            />
          </FormPanel>

          <FormPanel
            icon={Calculator}
            title="Valor do turno"
            description="Quanto vale cada turno, de acordo com a função, o local, a data ou o horário e quanto tempo a pessoa trabalhou. Sem nenhuma regra, o valor não é calculado."
          >
            <PaymentValueRulesEditor valueRules={valueRules} onChange={setValueRules} companyIds={isEditing ? [Number(id)] : undefined} />
          </FormPanel>

        </form>
      )}
    </div>
  );
}
