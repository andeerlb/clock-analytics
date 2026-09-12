import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import {
  clonePaymentPdfTemplate,
  deletePaymentPdfTemplate,
  listPaymentPdfTemplates,
} from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { PaymentPdfTemplateListRow } from "../lib/types";

export default function PaymentPdfTemplatesPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<PaymentPdfTemplateListRow[]>([]);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<PaymentPdfTemplateListRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [cloningId, setCloningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshTemplates();
  }, []);

  function refreshTemplates() {
    return listPaymentPdfTemplates().then(setTemplates);
  }

  async function handleDeleteTemplate() {
    if (!confirmDeleteTarget) return;
    setError(null);
    setBusy(true);
    try {
      await deletePaymentPdfTemplate(confirmDeleteTarget.id);
      setConfirmDeleteTarget(null);
      refreshTemplates();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCloneTemplate(id: number) {
    setError(null);
    setCloningId(id);
    try {
      await clonePaymentPdfTemplate(id);
      await refreshTemplates();
    } catch (e) {
      setError(String(e));
    } finally {
      setCloningId(null);
    }
  }

  return (
    <div>
      <BackButton fallback="/payments" />
      <div className="page-header">
        <h2>Templates de PDF</h2>
        <button type="button" onClick={() => navigate("/payments/pdf-templates/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo template
        </button>
      </div>
      <p className="page-subtitle">
        Layouts para exportar turnos de pagamento em PDF — colunas, cores, agrupamento e linha de
        soma, montados como numa planilha real e desenhados no PDF exatamente como aqui.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card table-card">
        {templates.length === 0 ? (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum template de PDF cadastrado ainda. Crie um para definir como os turnos de
            pagamento saem em PDF (o botão "Gerar PDF" da tela de Pagamentos continua usando o
            relatório padrão).
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
                          onClick={() => navigate(`/payments/pdf-templates/${t.id}`)}
                          aria-label="Editar"
                          title="Editar"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => handleCloneTemplate(t.id)}
                          disabled={cloningId !== null}
                          aria-label={cloningId === t.id ? "Clonando" : "Clonar"}
                          title={cloningId === t.id ? "Clonando..." : "Clonar"}
                        >
                          <Copy size={14} />
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
          title="Excluir template de PDF"
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
