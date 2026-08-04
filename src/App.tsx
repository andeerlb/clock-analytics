import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import "./App.css";
import Sidebar from "./components/Sidebar";
import { FiltersProvider } from "./contexts/FiltersContext";
import { checkPopplerStatus } from "./lib/api";
import ClientFormPage from "./pages/ClientFormPage";
import ClientsPage from "./pages/ClientsPage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyFormPage from "./pages/CompanyFormPage";
import ImportChooserPage from "./pages/ImportChooserPage";
import ImportPaymentsPage from "./pages/ImportPaymentsPage";
import ImportTimesheetPage from "./pages/ImportTimesheetPage";
import LibraryPage from "./pages/LibraryPage";
import EmployeeDetailPage from "./pages/EmployeeDetailPage";
import EmployeeFormPage from "./pages/EmployeeFormPage";
import EmployeesPage from "./pages/EmployeesPage";
import SettingsPage from "./pages/SettingsPage";

function App() {
  const [popplerMissing, setPopplerMissing] = useState(false);

  useEffect(() => {
    checkPopplerStatus()
      .then((status) => setPopplerMissing(!status.allFound))
      .catch(() => setPopplerMissing(false));
  }, []);

  return (
    <HashRouter>
      <FiltersProvider>
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
              <Route path="/import" element={<ImportChooserPage />} />
              <Route path="/import/timesheet" element={<ImportTimesheetPage />} />
              <Route path="/import/payments" element={<ImportPaymentsPage />} />
              <Route path="/employee/:importId" element={<EmployeeDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>
        </div>
      </FiltersProvider>
    </HashRouter>
  );
}

export default App;
