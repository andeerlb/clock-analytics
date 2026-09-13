import { Copy, FileSpreadsheet, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import {
  clonePaymentExportTemplate,
  clonePaymentPdfTemplate,
  deletePaymentExportTemplate,
  deletePaymentPdfTemplate,
  listPaymentExportTemplates,
  listPaymentPdfTemplates,
} from "../lib/db";
import { formatDateTime } from "../lib/format";
import type { PaymentExportTemplateListRow, PaymentPdfTemplateListRow } from "../lib/types";

/** Which section a pending delete/clone action targets — the two kinds live in separate tables with separate ids. */
type TemplateKind = "excel" | "pdf";

/**
 * One management screen for BOTH export template kinds (Excel and PDF) —
 * each kind keeps its own editor (the grids' role vocabularies differ), so
 * this is a sectioned list: one table per kind, each with its own
 * new/edit/clone/delete actions, instead of two separate pages.
 */
export default function PaymentExportTemplatesPage() {
  const navigate = useNavigate();
  const [excelTemplates, setExcelTemplates] = useState<PaymentExportTemplateListRow[]>([]);
  const [pdfTemplates, setPdfTemplates] = useState<PaymentPdfTemplateListRow[]>([]);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{ kind: TemplateKind; id: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshTemplates();
  }, []);

  function refreshTemplates() {
    return Promise.all([listPaymentExportTemplates().then(setExcelTemplates), listPaymentPdfTemplates().then(setPdfTemplates)]);
  }

  async function handleDeleteTemplate() {
    if (!confirmDeleteTarget) return;
    setError(null);
    setBusy(true);
    try {
      if (confirmDeleteTarget.kind === "excel") await deletePaymentExportTemplate(confirmDeleteTarget.id);
      else await deletePaymentPdfTemplate(confirmDeleteTarget.id);
      setConfirmDeleteTarget(null);
      refreshTemplates();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCloneTemplate(kind: TemplateKind, id: number) {
    setError(null);
    setCloningId(`${kind}-${id}`);
    try {
      if (kind === "excel") await clonePaymentExportTemplate(id);
      else await clonePaymentPdfTemplate(id);
      await refreshTemplates();
    } catch (e) {
      setError(String(e));
    } finally {
      setCloningId(null);
    }
  }

  function actionButtons(kind: TemplateKind, id: number, name: string, editPath: string) {
    const cloneKey = `${kind}-${id}`;
    return (
      <span style={{ display: "flex", gap: "0.3rem" }}>
        <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={() => navigate(editPath)} aria-label="Editar" title="Editar">
          <Pencil size={14} />
        </button>
        <button
          type="button"
          className="ghost"
          style={{ padding: "0.3rem" }}
          onClick={() => handleCloneTemplate(kind, id)}
          disabled={cloningId !== null}
          aria-label={cloningId === cloneKey ? "Clonando" : "Clonar"}
          title={cloningId === cloneKey ? "Clonando..." : "Clonar"}
        >
          <Copy size={14} />
        </button>
        <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={() => setConfirmDeleteTarget({ kind, id, name })} aria-label="Excluir" title="Excluir">
          <Trash2 size={14} />
        </button>
      </span>
    );
  }

  function templateTable(rows: ReactNode, emptyMessage: string) {
    if (rows === null) return <p className="muted" style={{ padding: "1.4rem" }}>{emptyMessage}</p>;
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Atualizado em</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    );
  }

  const excelRows = excelTemplates.length === 0 ? null : excelTemplates.map((t) => (
    <tr key={t.id}>
      <td>{t.name}</td>
      <td>{formatDateTime(t.updatedAt)}</td>
      <td>{actionButtons("excel", t.id, t.name, `/payments/export-templates/${t.id}`)}</td>
    </tr>
  ));

  const pdfRows = pdfTemplates.length === 0 ? null : pdfTemplates.map((t) => (
    <tr key={t.id}>
      <td>{t.name}</td>
      <td>{formatDateTime(t.updatedAt)}</td>
      <td>{actionButtons("pdf", t.id, t.name, `/payments/pdf-templates/${t.id}`)}</td>
    </tr>
  ));

  return (
    <div>
      <BackButton fallback="/payments" />
      <div className="page-header">
        <h2>Templates de exportação</h2>
      </div>
      <p className="page-subtitle">
        Layouts para exportar turnos de pagamento — em Excel ou em PDF, com colunas, cores,
        agrupamento e linha de soma, montados como numa planilha real.
      </p>

      {error && <div className="error-box">{error}</div>}

      <h3 style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", margin: "1.4rem 0 0.6rem" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><FileSpreadsheet size={17} /> Excel</span>
        <button type="button" className="secondary" onClick={() => navigate("/payments/export-templates/new")} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <Plus size={15} />
          Novo template Excel
        </button>
      </h3>
      <div className="card table-card">
        {templateTable(excelRows, "Nenhum template de Excel cadastrado ainda. Crie um para definir como os turnos de pagamento saem em planilha.")}
      </div>

      <div role="separator" aria-label="Separação entre templates de Excel e PDF" style={{ display: "flex", alignItems: "center", gap: "0.7rem", margin: "7rem 0 2.5rem" }}>
        <span style={{ height: "2px", flex: 1, background: "var(--border-soft)" }} />
        <span style={{ width: "2.8rem", height: "4px", borderRadius: "999px", background: "var(--accent)" }} />
        <span style={{ height: "2px", flex: 1, background: "var(--border-soft)" }} />
      </div>

      <h3 style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", margin: "0 0 1rem" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><FileText size={17} /> PDF</span>
        <button type="button" className="secondary" onClick={() => navigate("/payments/pdf-templates/new")} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <Plus size={15} />
          Novo template PDF
        </button>
      </h3>
      <div className="card table-card">
        {templateTable(pdfRows, "Nenhum template de PDF cadastrado ainda. Crie um para definir como os turnos de pagamento saem em PDF.")}
      </div>

      {confirmDeleteTarget && (
        <ConfirmModal
          title={`Excluir template de ${confirmDeleteTarget.kind === "excel" ? "Excel" : "PDF"}`}
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
