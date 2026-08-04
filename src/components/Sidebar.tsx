import { Briefcase, Building2, Clock, FileUp, Settings, Users } from "lucide-react";
import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/companies", label: "Empresas", icon: Building2, end: false },
  { to: "/clients", label: "Clientes", icon: Briefcase, end: false },
  { to: "/import", label: "Importar", icon: FileUp, end: false },
  { to: "/", label: "Colaboradores", icon: Users, end: true },
];

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `app-nav-link${isActive ? " active" : ""}`;
}

export default function Sidebar() {
  return (
    <nav className="app-nav">
      <div className="app-brand">
        <div className="app-brand-icon">
          <Clock size={18} />
        </div>
        <span>PontoScan</span>
      </div>

      <div className="app-nav-links">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navLinkClass}>
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>

      <NavLink to="/settings" className={navLinkClass}>
        <Settings size={18} />
        <span>Configurações</span>
      </NavLink>
    </nav>
  );
}
