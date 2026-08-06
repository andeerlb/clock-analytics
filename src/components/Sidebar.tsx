import { openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { Briefcase, Building2, Clock, FileUp, RefreshCw, Settings, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import GithubIcon from "./GithubIcon";
import UpdateModal from "./UpdateModal";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { formatCountdown } from "../lib/format";
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
  const { remoteUpdates, trackedFiles, nextCheckAt, checking } = useRemoteFileUpdates();
  // Ticks once a second purely to redraw the countdown below — `nextCheckAt`
  // itself only changes once per check cycle (every `TICK_INTERVAL_MS`).
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    checkForUpdate()
      .then((update) => {
        if (update) setAvailableUpdate(update);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const countdownLabel = nextCheckAt ? formatCountdown(new Date(nextCheckAt).getTime() - now) : null;
  const hasCheckError = trackedFiles.some((t) => !t.checkDisabled && t.lastResult === "error");
  const remoteDotColor = hasCheckError ? "var(--danger)" : remoteUpdates.length > 0 ? "var(--warning)" : null;

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

      <div className="app-nav-footer">
        <NavLink to="/import/payments/remote-updates" className={navLinkClass}>
          <RefreshCw size={18} className={checking ? "spin" : undefined} />
          <span>Verificação automática</span>
          {countdownLabel && (
            <span className="muted" style={{ marginLeft: "auto", fontSize: "0.72rem", flexShrink: 0 }}>
              {countdownLabel}
            </span>
          )}
          {remoteDotColor && (
            <span
              style={{
                marginLeft: countdownLabel ? "0.4rem" : "auto",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: remoteDotColor,
                flexShrink: 0,
              }}
              aria-label={hasCheckError ? "Falha na verificação automática" : "Arquivo remoto atualizado — reimportação disponível"}
              title={hasCheckError ? "Falha na verificação automática" : "Arquivo remoto atualizado — reimportação disponível"}
            />
          )}
        </NavLink>

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
