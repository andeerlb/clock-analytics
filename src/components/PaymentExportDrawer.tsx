import { FileSpreadsheet, FileText, Settings2 } from "lucide-react";
import { useState } from "react";
import { formatDateTime } from "../lib/format";
import type { PaymentExportTemplateListRow, PaymentPdfTemplateListRow } from "../lib/types";
import Drawer from "./Drawer";

type ExportFormat = "excel" | "pdf";

/**
 * The Pagamentos screen's single "Exportar" flow — replaces what used to be
 * two template `<select>`s plus four buttons (Exportar Excel / Exportar PDF /
 * Templates Excel / Templates PDF) crowded into the toolbar. The format
 * (Excel/PDF) is a tab, the chosen format's templates a pick-list, and the
 * actual export still runs through the caller's handlers so result banners
 * and error states stay where they already were.
 */
export default function PaymentExportDrawer({
  open,
  onClose,
  excelTemplates,
  pdfTemplates,
  selectedExcelTemplateId,
  selectedPdfTemplateId,
  onSelectExcelTemplate,
  onSelectPdfTemplate,
  exportingExcel,
  exportingPdf,
  excelError,
  pdfError,
  onExport,
  onManageTemplates,
}: {
  open: boolean;
  onClose: () => void;
  excelTemplates: PaymentExportTemplateListRow[];
  pdfTemplates: PaymentPdfTemplateListRow[];
  /** Selection lives in the parent so it survives the drawer being closed/reopened. */
  selectedExcelTemplateId: string;
  selectedPdfTemplateId: string;
  onSelectExcelTemplate: (id: string) => void;
  onSelectPdfTemplate: (id: string) => void;
  exportingExcel: boolean;
  exportingPdf: boolean;
  excelError: string | null;
  pdfError: string | null;
  /** Runs the real export for the picked format+template — the drawer closes itself on success via the caller. */
  onExport: (format: ExportFormat, templateId: number) => void;
  onManageTemplates: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("excel");

  const templates: Array<{ id: number; name: string; updatedAt: string }> = format === "excel" ? excelTemplates : pdfTemplates;
  const selectedId = format === "excel" ? selectedExcelTemplateId : selectedPdfTemplateId;
  const select = format === "excel" ? onSelectExcelTemplate : onSelectPdfTemplate;
  const busy = format === "excel" ? exportingExcel : exportingPdf;
  const error = format === "excel" ? excelError : pdfError;

  return (
    <Drawer open={open} onClose={onClose} title="Exportar" width="min(480px, 95vw)">
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Escolha o formato e o template. Os filtros aplicados na lista são considerados.
      </p>

      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.9rem" }}>
        <button
          type="button"
          className={format === "excel" ? "" : "secondary"}
          onClick={() => setFormat("excel")}
          style={{ flex: 1 }}
        >
          <FileSpreadsheet size={15} /> Excel
        </button>
        <button
          type="button"
          className={format === "pdf" ? "" : "secondary"}
          onClick={() => setFormat("pdf")}
          style={{ flex: 1 }}
        >
          <FileText size={15} /> PDF
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: "0.9rem" }}>{error}</div>}

      {templates.length === 0 ? (
        <div className="card" style={{ padding: "1.1rem" }}>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
            Nenhum template de {format === "excel" ? "Excel" : "PDF"} ainda. Crie um na tela de
            templates para exportar {format === "excel" ? "planilhas" : "PDFs"} personalizados.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {templates.map((t) => {
            const active = String(t.id) === selectedId;
            return (
              <button
                key={t.id}
                type="button"
                className={active ? "" : "secondary"}
                onClick={() => select(String(t.id))}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.8rem", textAlign: "left" }}
              >
                <span style={{ overflowWrap: "anywhere" }}>{t.name}</span>
                <small style={{ whiteSpace: "nowrap", opacity: 0.75 }}>{formatDateTime(t.updatedAt)}</small>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.6rem", justifyContent: "space-between", marginTop: "1.1rem" }}>
        <button type="button" className="secondary" onClick={onManageTemplates}>
          <Settings2 size={15} /> Gerenciar templates
        </button>
        <button
          type="button"
          disabled={busy || !selectedId}
          onClick={() => onExport(format, Number(selectedId))}
        >
          {busy ? "Exportando..." : `Exportar ${format === "excel" ? "Excel" : "PDF"}`}
        </button>
      </div>
    </Drawer>
  );
}
