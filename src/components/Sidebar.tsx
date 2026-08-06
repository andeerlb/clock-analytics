import { openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { Briefcase, Building2, Clock, FileUp, Settings, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import GithubIcon from "./GithubIcon";
import UpdateModal from "./UpdateModal";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { checkForUpdate, REPO_URL } from "../lib/updateCheck";

const NAV_ITEMS = [
  { to: "/import", label: "Importar", icon: FileUp, end: false },
  { to: "/companies", label: "Empresas", icon: Building2, end: false },
  { to: "/clients", label: "Clientes", icon: Briefcase, end: false },
  { to: "/employees", label: "Colaboradores", icon: Users, end: false },
  { to: "/", label: "Cartão Ponto", icon: Clock, end: true },
  { to: "/payments", label: "Pagamentos", icon: Wallet, end: false },
];

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `app-nav-link${isActive ? " active" : ""}`;
}

export default function Sidebar() {
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const { remoteUpdates } = useRemoteFileUpdates();

  useEffect(() => {
    checkForUpdate()
      .then((update) => {
        if (update) setAvailableUpdate(update);
      })
      .catch(() => {});
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
            {to === "/import" && remoteUpdates.length > 0 && (
              <span
                style={{
                  marginLeft: "auto",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--warning)",
                  flexShrink: 0,
                }}
                aria-label="Arquivo remoto atualizado — reimportação disponível"
                title="Arquivo remoto atualizado — reimportação disponível"
              />
            )}
          </NavLink>
        ))}
      </div>

      <div className="app-nav-footer">
        <button
          type="button"
          className="app-nav-link ghost"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => (availableUpdate ? setShowUpdateModal(true) : openUrl(REPO_URL))}
          title={availableUpdate ? "Nova versão disponível" : "Ver no GitHub"}
        >
          <GithubIcon size={18} />
          <span>GitHub</span>
          {availableUpdate && (
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
      </div>

      {showUpdateModal && availableUpdate && (
        <UpdateModal
          update={availableUpdate}
          onClose={() => {
            setShowUpdateModal(false);
            setAvailableUpdate(null);
          }}
        />
      )}
    </nav>
  );
}
