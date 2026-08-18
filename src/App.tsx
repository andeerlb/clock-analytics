import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import "./App.css";
import PaymentReconciliationModal from "./components/PaymentReconciliationModal";
import PendingChangesTab from "./components/PendingChangesTab";
import Sidebar from "./components/Sidebar";
import { FiltersProvider } from "./contexts/FiltersContext";
import { ReconciliationModalProvider, useReconciliationModal } from "./contexts/ReconciliationModalContext";
import { RemoteFileUpdatesProvider } from "./contexts/RemoteFileUpdatesContext";
import { checkPopplerStatus } from "./lib/api";
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

/**
 * "Destacar" on "Conferência de Pagamentos" (`open_reconciliation_window`)
 * opens a second OS window running this exact same app bundle — the only
 * thing that tells the two apart is the window's own label, set in Rust.
 * That window gets none of the normal app shell (`Sidebar`/routes/
 * `RemoteFileUpdatesProvider`): it's a focused single-purpose surface, not
 * a second copy of the whole app. `FiltersProvider` is the one thing it
 * still needs, since `PaymentReconciliationWindowPage` reads/writes
 * `usePaymentsFilters()` same as the embedded modal does.
 */
const IS_RECONCILIATION_WINDOW = getCurrentWindow().label === "reconciliation";

/**
 * The normal app shell's content — split out from `App` so it can sit
 * inside `ReconciliationModalProvider` (which itself needs `FiltersProvider`
 * above it) and call `useReconciliationModal()` to render
 * `PaymentReconciliationModal` at this level, alongside `PendingChangesTab`,
 * rather than nested under whichever route happens to be active. That's
 * what lets "Anexar" on the detached window reopen the modal here even if
 * the main window isn't currently sitting on `/payments` — see
 * `ReconciliationModalContext.tsx`.
 */
function AppShell({ popplerMissing }: { popplerMissing: boolean }) {
  const { open, closeReconciliation } = useReconciliationModal();
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
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
          <Route path="/payments/export-templates" element={<PaymentExportTemplatesPage />} />
          <Route path="/payments/export-templates/new" element={<PaymentExportTemplateEditorPage />} />
          <Route path="/payments/export-templates/:id" element={<PaymentExportTemplateEditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <PendingChangesTab />
      {open && <PaymentReconciliationModal onClose={closeReconciliation} />}
    </div>
  );
}

function App() {
  const [popplerMissing, setPopplerMissing] = useState(false);

  useEffect(() => {
    checkPopplerStatus()
      .then((status) => setPopplerMissing(!status.allFound))
      .catch(() => setPopplerMissing(false));
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
          <ReconciliationModalProvider>
            <AppShell popplerMissing={popplerMissing} />
          </ReconciliationModalProvider>
        </RemoteFileUpdatesProvider>
      </FiltersProvider>
    </HashRouter>
  );
}

export default App;
