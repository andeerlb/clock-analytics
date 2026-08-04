import { openUrl } from "@tauri-apps/plugin-opener";
import { Briefcase, Building2, Clock, FileUp, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import GithubIcon from "./GithubIcon";
import { checkForUpdate, REPO_URL } from "../lib/updateCheck";

const NAV_ITEMS = [
  { to: "/companies", label: "Empresas", icon: Building2, end: false },
  { to: "/clients", label: "Clientes", icon: Briefcase, end: false },
  { to: "/employees", label: "Colaboradores", icon: Users, end: false },
  { to: "/import", label: "Importar", icon: FileUp, end: false },
  { to: "/", label: "Cartão Ponto", icon: Clock, end: true },
];

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `app-nav-link${isActive ? " active" : ""}`;
}

export default function Sidebar() {
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);

  useEffect(() => {
    checkForUpdate().then((status) => {
      if (status.updateAvailable) setUpdateUrl(status.latestUrl ?? REPO_URL);
    });
  }, []);

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

      <button
        type="button"
        className="app-nav-link ghost"
        style={{ width: "100%", textAlign: "left" }}
        onClick={() => openUrl(updateUrl ?? REPO_URL)}
        title={updateUrl ? "Nova versão disponível no GitHub" : "Ver no GitHub"}
      >
        <GithubIcon size={18} />
        <span>GitHub</span>
        {updateUrl && (
          <span
            style={{
              marginLeft: "auto",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--success)",
              flexShrink: 0,
            }}
            aria-label="Nova versão disponível"
          />
        )}
      </button>

      <NavLink to="/settings" className={navLinkClass}>
        <Settings size={18} />
        <span>Configurações</span>
      </NavLink>
    </nav>
  );
}
