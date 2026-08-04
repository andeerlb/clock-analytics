import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import BackButton from "../components/BackButton";
import PaymentTemplateWizard from "../components/PaymentTemplateWizard";
import { deletePaths } from "../lib/api";
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
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

  async function handleDeleteTemplate(id: number) {
    setError(null);
    try {
      const samplePath = await deletePaymentTemplate(id);
      if (samplePath) await deletePaths([samplePath]).catch(() => {});
      setConfirmDeleteId(null);
      refreshTemplates();
    } catch (e) {
      setError(String(e));
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
                  <th>Cliente</th>
                  <th>Formato</th>
                  <th>Atualizado em</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.clientName ?? "Global"}</td>
                    <td>{FILE_KIND_LABELS[t.fileKind] ?? t.fileKind}</td>
                    <td>{formatDateTime(t.updatedAt)}</td>
                    <td>
                      {confirmDeleteId === t.id ? (
                        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <span style={{ color: "var(--danger)", fontSize: "0.82rem" }}>
                            Confirmar exclusão?
                          </span>
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem", color: "var(--danger)" }}
                            onClick={() => handleDeleteTemplate(t.id)}
                          >
                            Excluir
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancelar
                          </button>
                        </span>
                      ) : (
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
                            onClick={() => setConfirmDeleteId(t.id)}
                            aria-label="Excluir"
                            title="Excluir"
                          >
                            <Trash2 size={14} />
                          </button>
                        </span>
                      )}
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
    </div>
  );
}
