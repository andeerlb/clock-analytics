import { BarChart3, Clock, FileUp, Plus, Users } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/import", label: "Importar", icon: FileUp, end: false },
  { to: "/", label: "Colaboradores", icon: Users, end: true },
  { to: "/reports", label: "Relatórios", icon: BarChart3, end: false },
];

export default function Sidebar() {
  const location = useLocation();

  return (
    <nav className="app-nav">
      <div className="app-brand">
        <div className="app-brand-icon">
          <Clock size={18} />
        </div>
        <span>Clock Analytics</span>
      </div>

      <div className="app-nav-links">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `app-nav-link${isActive ? " active" : ""}`}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>

      {location.pathname !== "/import" && (
        <NavLink to="/import" className="app-nav-cta">
          <Plus size={16} />
          Nova Importação
        </NavLink>
      )}
    </nav>
  );
}
