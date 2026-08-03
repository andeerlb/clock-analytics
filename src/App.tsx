import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import "./App.css";
import ImportPage from "./pages/ImportPage";
import LibraryPage from "./pages/LibraryPage";
import EmployeeDetailPage from "./pages/EmployeeDetailPage";
import ReportsPage from "./pages/ReportsPage";

function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <nav className="app-nav">
          <h1>Clock Analytics</h1>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Colaboradores
          </NavLink>
          <NavLink to="/import" className={({ isActive }) => (isActive ? "active" : "")}>
            Importar
          </NavLink>
          <NavLink to="/reports" className={({ isActive }) => (isActive ? "active" : "")}>
            Relatórios
          </NavLink>
        </nav>
        <main className="app-content">
          <Routes>
            <Route path="/" element={<LibraryPage />} />
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
