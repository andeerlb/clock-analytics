import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { AiAssistantProvider } from "./components/AiAssistant";
import AuthGate from "./components/AuthGate";
import PendingChangesTab from "./components/PendingChangesTab";
import Sidebar from "./components/Sidebar";
import { AuthProvider } from "./contexts/AuthContext";
import { FiltersProvider } from "./contexts/FiltersContext";
import { RemoteFileUpdatesProvider } from "./contexts/RemoteFileUpdatesContext";
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
import PaymentPdfTemplateEditorPage from "./pages/PaymentPdfTemplateEditorPage";
import PaymentReconciliationWindowPage from "./pages/PaymentReconciliationWindowPage";
import PaymentsPage from "./pages/PaymentsPage";
import PaymentTemplatesPage from "./pages/PaymentTemplatesPage";
import RemoteUpdatesPage from "./pages/RemoteUpdatesPage";
import RoleFormPage from "./pages/RoleFormPage";
import RolesPage from "./pages/RolesPage";
import SettingsPage from "./pages/SettingsPage";
import AnalyticsPage from "./pages/AnalyticsPage";

function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
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
          {/* Both template kinds are managed on the single `/payments/export-templates`
              screen now — this old URL just redirects there. The PDF editor keeps
              its own `pdf-templates/new|:id` paths below. */}
          <Route path="/payments/pdf-templates" element={<Navigate to="/payments/export-templates" replace />} />
          <Route path="/payments/pdf-templates/new" element={<PaymentPdfTemplateEditorPage />} />
          <Route path="/payments/pdf-templates/:id" element={<PaymentPdfTemplateEditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <PendingChangesTab />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <HashRouter>
          <FiltersProvider>
            <Routes>
              {/* "Conferência" opens in its own browser tab (see
                  `openReconciliationWindow`), with none of the app shell. */}
              <Route path="/payments/reconciliation" element={<PaymentReconciliationWindowPage />} />
              <Route
                path="*"
                element={
                  <RemoteFileUpdatesProvider>
                    <AiAssistantProvider>
                      <AppShell />
                    </AiAssistantProvider>
                  </RemoteFileUpdatesProvider>
                }
              />
            </Routes>
          </FiltersProvider>
        </HashRouter>
      </AuthGate>
    </AuthProvider>
  );
}

export default App;
