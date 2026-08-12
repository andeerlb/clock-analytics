import { Calculator, Info, Moon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import FormPanel from "../components/FormPanel";
import NightShiftRuleFields from "../components/NightShiftRuleFields";
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

  useEffect(() => {
    if (!isEditing) return;
    getCompany(Number(id))
      .then((c) => {
        setName(c.name);
        setCnpj(maskCnpj(c.cnpj));
        setNightStartTime(c.nightStartTime);
        setNightEndTime(c.nightEndTime);
        setNightShiftRule(c.nightShiftRule);
        setValueRules(fromPaymentValueRules(c.valueRules));
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
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/companies" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar empresa" : "Nova empresa"}</h2>
      </div>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Carregando...</p>
      ) : (
        <form onSubmit={handleSubmit} className="details-main" style={{ maxWidth: "52rem" }}>
          <FormPanel icon={Info} title="Informações Gerais">
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
          </FormPanel>

          <FormPanel
            icon={Moon}
            title="Horário noturno"
            description="O horário entre o início e o fim do noturno define quais turnos de um colaborador contam como noturnos ao calcular pagamentos — o padrão (22:00–05:00) segue a CLT."
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
            title="Regras de valor por hora trabalhada"
            description="Decide o Valor de um turno a partir de condições de coluna (Data/Local/Função/Horário) e da duração (horas trabalhadas, somada do Horário) — avaliadas em ordem, a primeira que bater vence. Opcional: sem nenhuma regra, o Valor não é calculado."
          >
            <PaymentValueRulesEditor valueRules={valueRules} onChange={setValueRules} />
          </FormPanel>

          <button type="submit" disabled={busy || !isValueRulesValid(valueRules)} style={{ alignSelf: "flex-start" }}>
            {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
          </button>
        </form>
      )}
    </div>
  );
}
