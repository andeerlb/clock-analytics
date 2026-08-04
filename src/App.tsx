import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import "./App.css";
import Sidebar from "./components/Sidebar";
import { FiltersProvider } from "./contexts/FiltersContext";
import { checkPopplerStatus } from "./lib/api";
import ClientsPage from "./pages/ClientsPage";
import CompaniesPage from "./pages/CompaniesPage";
import ImportPage from "./pages/ImportPage";
import LibraryPage from "./pages/LibraryPage";
import EmployeeDetailPage from "./pages/EmployeeDetailPage";
import ReportsPage from "./pages/ReportsPage";
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
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/employee/:importId" element={<EmployeeDetailPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>
        </div>
      </FiltersProvider>
    </HashRouter>
  );
}

export default App;
