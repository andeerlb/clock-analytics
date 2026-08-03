import { HashRouter, Route, Routes } from "react-router-dom";
import "./App.css";
import Sidebar from "./components/Sidebar";
import CompaniesPage from "./pages/CompaniesPage";
import ImportPage from "./pages/ImportPage";
import LibraryPage from "./pages/LibraryPage";
import EmployeeDetailPage from "./pages/EmployeeDetailPage";
import ReportsPage from "./pages/ReportsPage";

function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <Sidebar />
        <main className="app-content">
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/companies" element={<CompaniesPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/employee/:importId" element={<EmployeeDetailPage />} />
            <Route path="/reports" element={<ReportsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}

export default App;
