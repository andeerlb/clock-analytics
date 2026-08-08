import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import { deletePaymentExportTemplate, listPaymentExportTemplates } from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { PaymentExportTemplateListRow } from "../lib/types";

export default function PaymentExportTemplatesPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<PaymentExportTemplateListRow[]>([]);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<PaymentExportTemplateListRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshTemplates();
  }, []);

  function refreshTemplates() {
    listPaymentExportTemplates().then(setTemplates);
  }

  async function handleDeleteTemplate() {
    if (!confirmDeleteTarget) return;
    setError(null);
    setBusy(true);
    try {
      await deletePaymentExportTemplate(confirmDeleteTarget.id);
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
      <BackButton fallback="/payments" />
      <div className="page-header">
        <h2>Templates de exportação</h2>
        <button type="button" onClick={() => navigate("/payments/export-templates/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo template
        </button>
      </div>
      <p className="page-subtitle">
        Layouts para exportar turnos de pagamento em Excel — colunas, cores, agrupamento e linha
        de soma, montados como numa planilha real.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card table-card">
        {templates.length === 0 ? (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum template de exportação cadastrado ainda. Crie um para definir como os turnos
            de pagamento saem em Excel.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Atualizado em</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{formatDateTime(t.updatedAt)}</td>
                    <td>
                      <span style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => navigate(`/payments/export-templates/${t.id}`)}
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

      {confirmDeleteTarget && (
        <ConfirmModal
          title="Excluir template de exportação"
          message={`Tem certeza que deseja excluir "${confirmDeleteTarget.name}"?`}
          confirmLabel={busy ? "Excluindo..." : "Excluir"}
          confirmDisabled={busy}
          onConfirm={handleDeleteTemplate}
          onCancel={() => setConfirmDeleteTarget(null)}
        />
      )}
    </div>
  );
}
