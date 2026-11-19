import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { AiAssistantProvider } from "./components/AiAssistant";
import AreaRoute, { AccessDenied } from "./components/AreaRoute";
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
import UsersPage from "./pages/UsersPage";
import ActivityPage from "./pages/ActivityPage";
import { useAccess } from "./contexts/AuthContext";
import AnalyticsPage from "./pages/AnalyticsPage";

/** "Usuários e perfis": only for profiles that manage users. */
function UsersRoute() {
  const { canManageUsers } = useAccess();
  return canManageUsers ? <UsersPage /> : <AccessDenied title="Você não tem acesso a Usuários e perfis" />;
}

/** "Atividade": who changed what — for the same profiles as "Usuários e perfis". */
function ActivityRoute() {
  const { canManageUsers } = useAccess();
  return canManageUsers ? <ActivityPage /> : <AccessDenied title="Você não tem acesso à Atividade" />;
}

function AppShell() {
  const { canView } = useAccess();
  // The "atualizações pendentes" card reads the automatic check's results.
  const followsRemoteChecks = canView("verificacao") || canView("pagamentos") || canView("analises");
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
        <Routes>
          <Route path="/" element={<AreaRoute area="espelhos"><LibraryPage /></AreaRoute>} />
          <Route path="/companies" element={<AreaRoute area="cadastros"><CompaniesPage /></AreaRoute>} />
          <Route path="/companies/new" element={<AreaRoute area="cadastros" needEdit><CompanyFormPage /></AreaRoute>} />
          <Route path="/companies/:id" element={<AreaRoute area="cadastros"><CompanyFormPage /></AreaRoute>} />
          <Route path="/clients" element={<AreaRoute area="cadastros"><ClientsPage /></AreaRoute>} />
          <Route path="/clients/new" element={<AreaRoute area="cadastros" needEdit><ClientFormPage /></AreaRoute>} />
          <Route path="/clients/:id" element={<AreaRoute area="cadastros"><ClientFormPage /></AreaRoute>} />
          <Route path="/employees" element={<AreaRoute area="cadastros"><EmployeesPage /></AreaRoute>} />
          <Route path="/employees/new" element={<AreaRoute area="cadastros" needEdit><EmployeeFormPage /></AreaRoute>} />
          <Route path="/employees/:id" element={<AreaRoute area="cadastros"><EmployeeFormPage /></AreaRoute>} />
          <Route path="/roles" element={<AreaRoute area="cadastros"><RolesPage /></AreaRoute>} />
          <Route path="/roles/new" element={<AreaRoute area="cadastros" needEdit><RoleFormPage /></AreaRoute>} />
          <Route path="/roles/:id" element={<AreaRoute area="cadastros"><RoleFormPage /></AreaRoute>} />
          <Route path="/import" element={<ImportChooserPage />} />
          <Route path="/users" element={<UsersRoute />} />
          <Route path="/activity" element={<ActivityRoute />} />
          <Route path="/import/timesheet" element={<AreaRoute area="espelhos" needEdit><ImportTimesheetPage /></AreaRoute>} />
          <Route path="/import/payments" element={<AreaRoute area="pagamentos" needEdit><ImportPaymentsPage /></AreaRoute>} />
          <Route path="/import/payments/templates" element={<AreaRoute area="pagamentos"><PaymentTemplatesPage /></AreaRoute>} />
          <Route path="/remote-updates/imports" element={<AreaRoute area="verificacao"><RemoteUpdatesPage /></AreaRoute>} />
          <Route path="/import/employees" element={<AreaRoute area="cadastros" needEdit><ImportEmployeesPage /></AreaRoute>} />
          <Route path="/import/employees/templates" element={<AreaRoute area="cadastros"><EmployeeTemplatesPage /></AreaRoute>} />
          <Route path="/employee/:importId" element={<AreaRoute area="espelhos"><EmployeeDetailPage /></AreaRoute>} />
          <Route path="/payments" element={<AreaRoute area="pagamentos"><PaymentsPage /></AreaRoute>} />
          <Route path="/analytics" element={<AreaRoute area="analises"><AnalyticsPage /></AreaRoute>} />
          <Route path="/payments/export-templates" element={<AreaRoute area="pagamentos"><PaymentExportTemplatesPage /></AreaRoute>} />
          <Route path="/payments/export-templates/new" element={<AreaRoute area="pagamentos" needEdit><PaymentExportTemplateEditorPage /></AreaRoute>} />
          <Route path="/payments/export-templates/:id" element={<AreaRoute area="pagamentos"><PaymentExportTemplateEditorPage /></AreaRoute>} />
          {/* Both template kinds are managed on the single `/payments/export-templates`
              screen now — this old URL just redirects there. The PDF editor keeps
              its own `pdf-templates/new|:id` paths below. */}
          <Route path="/payments/pdf-templates" element={<Navigate to="/payments/export-templates" replace />} />
          <Route path="/payments/pdf-templates/new" element={<AreaRoute area="pagamentos" needEdit><PaymentPdfTemplateEditorPage /></AreaRoute>} />
          <Route path="/payments/pdf-templates/:id" element={<AreaRoute area="pagamentos"><PaymentPdfTemplateEditorPage /></AreaRoute>} />
          <Route path="/settings" element={<AreaRoute area="configuracoes"><SettingsPage /></AreaRoute>} />
        </Routes>
      </main>
      {followsRemoteChecks && <PendingChangesTab />}
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
              <Route path="/payments/reconciliation" element={<AreaRoute area="pagamentos"><PaymentReconciliationWindowPage /></AreaRoute>} />
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
