import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import "./App.css";
import PendingChangesTab from "./components/PendingChangesTab";
import Modal from "./components/Modal";
import Sidebar from "./components/Sidebar";
import { FiltersProvider } from "./contexts/FiltersContext";
import { RemoteFileUpdatesProvider } from "./contexts/RemoteFileUpdatesContext";
import { checkPopplerStatus, clearDatabaseImportResult, takeDatabaseImportResult, type DatabaseImportResult } from "./lib/api";
import { useWindowGlassInit } from "./lib/useWindowGlass";
import ClientFormPage from "./pages/ClientFormPage";
import ClientsPage from "./pages/ClientsPage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyFormPage from "./pages/CompanyFormPage";
import EmployeeTemplatesPage from "./pages/EmployeeTemplatesPage";
import ImportChooserPage from "./pages/ImportChooserPage";
import ImportEmployeesPage from "./pages/ImportEmployeesPage";
import ImportPaymentsPage from "./pages/ImportPaymentsPage";
import ImportTimesheetPage from "./pages/ImportTimesheetPage";
import LibraryPage from "./pages/LibraryPage";
import EmployeeDetailPage from "./pages/EmployeeDetailPage";
import EmployeeFormPage from "./pages/EmployeeFormPage";
import EmployeesPage from "./pages/EmployeesPage";
import PaymentExportTemplateEditorPage from "./pages/PaymentExportTemplateEditorPage";
import PaymentExportTemplatesPage from "./pages/PaymentExportTemplatesPage";
import PaymentReconciliationWindowPage from "./pages/PaymentReconciliationWindowPage";
import PaymentsPage from "./pages/PaymentsPage";
import PaymentTemplatesPage from "./pages/PaymentTemplatesPage";
import RemoteUpdatesPage from "./pages/RemoteUpdatesPage";
import RoleFormPage from "./pages/RoleFormPage";
import RolesPage from "./pages/RolesPage";
import SettingsPage from "./pages/SettingsPage";
import AnalyticsPage from "./pages/AnalyticsPage";

/**
 * "Conferência" on `PaymentsPage` (`open_reconciliation_window`) opens a
 * second OS window running this exact same app bundle — the only thing that
 * tells the two apart is the window's own label, set in Rust. That window
 * gets none of the normal app shell (`Sidebar`/routes/
 * `RemoteFileUpdatesProvider`): it's a focused single-purpose surface, not a
 * second copy of the whole app. `FiltersProvider` is the one thing it still
 * needs, since `PaymentReconciliationWindowPage` reads/writes
 * `usePaymentsFilters()`.
 */
const IS_RECONCILIATION_WINDOW = getCurrentWindow().label === "reconciliation";

function AppShell({ popplerMissing, importResult, clearImportResult }: { popplerMissing: boolean; importResult: DatabaseImportResult | null; clearImportResult: () => void }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
        {importResult && (
          <Modal onClose={() => {}} closeOnEscape={false} closeOnBackdrop={false} width="36rem">
            <h3 style={{ marginTop: 0 }}>{importResult.success ? "Restauração concluída" : "Restauração não realizada"}</h3>
            <div className={importResult.success ? "success-box" : "error-box"}>{importResult.message}</div>
            <div style={{ display: "grid", gap: "0.4rem", margin: "1rem 0" }}>
              {importResult.events.map((event) => (
                <div key={`${event.label}-${event.occurredAt}`} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.5rem 0.65rem", background: "var(--sidebar-bg)", borderRadius: 6 }}>
                  <span>{importResult.success ? "✓" : "•"} {event.label}</span><code>{event.occurredAt}</code>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="button" onClick={clearImportResult}>Concluir</button></div>
          </Modal>
        )}
        {popplerMissing && (
          <div className="error-box" style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <AlertTriangle size={18} style={{ flexShrink: 0 }} />
            <span>
              Não foi possível encontrar as ferramentas do Poppler (pdftotext, pdfinfo etc.),
              necessárias para importar e exportar PDFs. Vá em{" "}
              <Link to="/settings" style={{ color: "inherit", textDecoration: "underline" }}>
                Configurações
              </Link>{" "}
              para ajustar a pasta onde elas estão instaladas.
            </span>
          </div>
        )}
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/companies" element={<CompaniesPage />} />
          <Route path="/companies/new" element={<CompanyFormPage />} />
          <Route path="/companies/:id" element={<CompanyFormPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/new" element={<ClientFormPage />} />
          <Route path="/clients/:id" element={<ClientFormPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
          <Route path="/employees/new" element={<EmployeeFormPage />} />
          <Route path="/employees/:id" element={<EmployeeFormPage />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/roles/new" element={<RoleFormPage />} />
          <Route path="/roles/:id" element={<RoleFormPage />} />
          <Route path="/import" element={<ImportChooserPage />} />
          <Route path="/import/timesheet" element={<ImportTimesheetPage />} />
          <Route path="/import/payments" element={<ImportPaymentsPage />} />
          <Route path="/import/payments/templates" element={<PaymentTemplatesPage />} />
          <Route path="/remote-updates/imports" element={<RemoteUpdatesPage />} />
          <Route path="/import/employees" element={<ImportEmployeesPage />} />
          <Route path="/import/employees/templates" element={<EmployeeTemplatesPage />} />
          <Route path="/employee/:importId" element={<EmployeeDetailPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/payments/export-templates" element={<PaymentExportTemplatesPage />} />
          <Route path="/payments/export-templates/new" element={<PaymentExportTemplateEditorPage />} />
          <Route path="/payments/export-templates/:id" element={<PaymentExportTemplateEditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <PendingChangesTab />
    </div>
  );
}

function App() {
  const [popplerMissing, setPopplerMissing] = useState(false);
  const [importResult, setImportResult] = useState<DatabaseImportResult | null>(null);

  // Reads back whether the native window blur applied at startup (see
  // `lib.rs`'s `setup`) actually took, and stamps `<html>` accordingly —
  // once per window, permanently, not per Modal/Drawer open.
  useWindowGlassInit();

  useEffect(() => {
    checkPopplerStatus()
      .then((status) => setPopplerMissing(!status.allFound))
      .catch(() => setPopplerMissing(false));
  }, []);

  useEffect(() => {
    if (IS_RECONCILIATION_WINDOW) return;
    takeDatabaseImportResult().then((result) => {
      if (!result) return;
      try {
        const before = JSON.parse(localStorage.getItem("database-import-events") ?? "[]");
        result.events = [...before, ...result.events];
      } catch { /* malformed transient state is safe to ignore */ }
      setImportResult(result);
    }).catch(() => {});
  }, []);

  if (IS_RECONCILIATION_WINDOW) {
    return (
      <FiltersProvider>
        <PaymentReconciliationWindowPage />
      </FiltersProvider>
    );
  }

  return (
    <HashRouter>
      <FiltersProvider>
        <RemoteFileUpdatesProvider>
          <AppShell popplerMissing={popplerMissing} importResult={importResult} clearImportResult={() => {
            clearDatabaseImportResult().then(() => {
              localStorage.removeItem("database-import-events");
              setImportResult(null);
            }).catch(() => {});
          }} />
        </RemoteFileUpdatesProvider>
      </FiltersProvider>
    </HashRouter>
  );
}

export default App;
