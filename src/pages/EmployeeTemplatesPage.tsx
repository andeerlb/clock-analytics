import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { UpdatedByCell, useLastActivity } from "../components/ActivityInfo";
import { useEffect, useState } from "react";
import { READ_ONLY_TITLE, useReadOnly } from "../components/AreaRoute";
import ConfirmModal from "../components/ConfirmModal";
import PageHeader from "../components/PageHeader";
import EmployeeTemplateWizard from "../components/EmployeeTemplateWizard";
import { deleteEmployeeTemplate, getEmployeeTemplate, listEmployeeTemplates } from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { EmployeeTemplateListRow, EmployeeTemplateRow } from "../lib/types";

const FILE_KIND_LABELS: Record<string, string> = {
  csv: "CSV",
  xlsx: "Excel",
  xls: "Excel",
  ods: "ODS",
};

export default function EmployeeTemplatesPage() {
  const readOnly = useReadOnly();
  const [templates, setTemplates] = useState<EmployeeTemplateListRow[]>([]);
  const lastActivity = useLastActivity("employeeTemplate", templates.map((t) => t.id));
  const [wizardTarget, setWizardTarget] = useState<EmployeeTemplateRow | "new" | null>(null);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<EmployeeTemplateListRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshTemplates();
  }, []);

  function refreshTemplates() {
    listEmployeeTemplates().then(setTemplates);
  }

  async function handleEditTemplate(id: number) {
    setError(null);
    try {
      const template = await getEmployeeTemplate(id);
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
      await deleteEmployeeTemplate(confirmDeleteTarget.id);
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
      <PageHeader
        title="Templates de colaboradores"
        backFallback="/import/employees"
        backLabel="Voltar para Importar colaboradores"
        subtitle="Mapeamento de colunas usado ao importar arquivos de colaboradores — cada template descreve como ler um formato de planilha."
        actions={
          !readOnly && (
            <button type="button" onClick={() => setWizardTarget("new")}>
              <Plus size={15} />
              Novo template
            </button>
          )
        }
      />

      {error && <div className="error-box">{error}</div>}

      <div className="card table-card">
        {templates.length === 0 ? (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum template cadastrado ainda. Crie um para mapear as colunas de um arquivo de
            colaboradores antes de importar.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="mobile-cards">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Formatos aceitos</th>
                  <th>Atualizado</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{Array.from(new Set(t.acceptedFileKinds.map((k) => FILE_KIND_LABELS[k] ?? k))).join(", ")}</td>
                    <td>
                      <UpdatedByCell info={lastActivity.get(String(t.id))} fallback={formatDateTime(t.updatedAt)} />
                    </td>
                    <td>
                      <span style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => handleEditTemplate(t.id)}
                          aria-label={readOnly ? "Ver" : "Editar"}
                          title={readOnly ? "Ver" : "Editar"}
                        >
                          {readOnly ? <Eye size={14} /> : <Pencil size={14} />}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: "0.3rem" }}
                          onClick={() => setConfirmDeleteTarget(t)}
                          disabled={readOnly}
                          aria-label="Excluir"
                          title={readOnly ? READ_ONLY_TITLE : "Excluir"}
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

      <EmployeeTemplateWizard
        target={wizardTarget}
        readOnly={readOnly}
        onClose={() => setWizardTarget(null)}
        onSaved={() => {
          setWizardTarget(null);
          refreshTemplates();
        }}
      />

      {confirmDeleteTarget && (
        <ConfirmModal
          title="Excluir template"
          message={`Tem certeza que deseja excluir "${confirmDeleteTarget.name}"? Colaboradores já importados com este template continuam cadastrados normalmente.`}
          confirmLabel={busy ? "Excluindo..." : "Excluir"}
          confirmDisabled={busy}
          onConfirm={handleDeleteTemplate}
          onCancel={() => setConfirmDeleteTarget(null)}
        />
      )}
    </div>
  );
}
