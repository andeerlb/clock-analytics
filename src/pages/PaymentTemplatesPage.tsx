import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import PaymentTemplateWizard from "../components/PaymentTemplateWizard";
import { deletePaymentTemplate, getPaymentTemplate, listPaymentTemplates } from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { PaymentTemplateListRow, PaymentTemplateRow } from "../lib/types";

const FILE_KIND_LABELS: Record<string, string> = {
  csv: "CSV",
  xlsx: "Excel",
  xls: "Excel",
  ods: "ODS",
};

export default function PaymentTemplatesPage() {
  const [templates, setTemplates] = useState<PaymentTemplateListRow[]>([]);
  const [wizardTarget, setWizardTarget] = useState<PaymentTemplateRow | "new" | null>(null);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<PaymentTemplateListRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshTemplates();
  }, []);

  function refreshTemplates() {
    listPaymentTemplates().then(setTemplates);
  }

  async function handleEditTemplate(id: number) {
    setError(null);
    try {
      const template = await getPaymentTemplate(id);
      setWizardTarget(template);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDeleteTemplate() {
    if (!confirmDeleteTarget) return;
    setError(null);
    setBusy(true);
    try {
      await deletePaymentTemplate(confirmDeleteTarget.id);
      setConfirmDeleteTarget(null);
      refreshTemplates();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <BackButton fallback="/import/payments" />
      <div className="page-header">
        <h2>Templates de pagamento</h2>
        <button type="button" onClick={() => setWizardTarget("new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo template
        </button>
      </div>
      <p className="page-subtitle">
        Mapeamento de colunas usado ao importar arquivos de pagamento — cada template descreve
        como ler um formato de planilha.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card table-card">
        {templates.length === 0 ? (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum template cadastrado ainda. Crie um para mapear as colunas de um arquivo de
            pagamentos antes de importar.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Formato</th>
                  <th>Atualizado em</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{FILE_KIND_LABELS[t.fileKind] ?? t.fileKind}</td>
                    <td>{formatDateTime(t.updatedAt)}</td>
                    <td>
                      <span style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => handleEditTemplate(t.id)}
                          aria-label="Editar"
                          title="Editar"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => setConfirmDeleteTarget(t)}
                          aria-label="Excluir"
                          title="Excluir"
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PaymentTemplateWizard
        target={wizardTarget}
        onClose={() => setWizardTarget(null)}
        onSaved={() => {
          setWizardTarget(null);
          refreshTemplates();
        }}
      />

      {confirmDeleteTarget && (
        <ConfirmModal
          title="Excluir template"
          message={`Tem certeza que deseja excluir "${confirmDeleteTarget.name}"? Turnos já importados com este template continuam guardados, só deixam de referenciá-lo.`}
          confirmLabel={busy ? "Excluindo..." : "Excluir"}
          confirmDisabled={busy}
          onConfirm={handleDeleteTemplate}
          onCancel={() => setConfirmDeleteTarget(null)}
        />
      )}
    </div>
  );
}
