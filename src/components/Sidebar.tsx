import { openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { Briefcase, Building2, Clock, FileUp, RefreshCw, Settings, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
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

/** Priority order, most urgent first — only one state is ever shown at a time. */
type RemoteStatus = "checking" | "error" | "update" | "active" | "idle";

const REMOTE_STATUS_META: Record<RemoteStatus, { label: string; color: string; pulse?: boolean }> = {
  // A check is actually in flight right now — distinct from "active", which
  // just means configs exist and are waiting their turn (see the user's own
  // distinction: "em progresso" = executando agora, "configuradas" = nenhuma
  // rodando no momento).
  checking: { label: "Verificando agora", color: "var(--accent)", pulse: true },
  error: { label: "Falha na verificação", color: "var(--danger)" },
  update: { label: "Atualização encontrada", color: "var(--warning)" },
  active: { label: "Configuradas", color: "var(--success)" },
  idle: { label: "Nenhuma configurada", color: "var(--outline)" },
};

export default function Sidebar() {
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [remoteHovered, setRemoteHovered] = useState(false);
  const { remoteUpdates, trackedFiles, reimportConfigs, checking, tickError } = useRemoteFileUpdates();
  const navigate = useNavigate();

  useEffect(() => {
    checkForUpdate()
      .then((update) => {
        if (update) setAvailableUpdate(update);
      })
      .catch(() => {});
  }, []);

  // No single countdown makes sense anymore — a URL can have several
  // reimport configs, each on its own schedule (see the Verificação
  // automática page for those). This is just a status summary: whether
  // anything's actively watching, and whether it found something. Kept to
  // a single dot (color-coded) plus a hover popover with the detail,
  // instead of inline text that has nowhere to go in a 220px sidebar.
  const activeConfigUrls = new Set(reimportConfigs.filter((c) => !c.checkDisabled).map((c) => c.sourceUrl));
  const hasActiveConfig = activeConfigUrls.size > 0;
  const hasCheckError = tickError !== null || trackedFiles.some((t) => activeConfigUrls.has(t.sourceUrl) && t.lastResult === "error");
  const remoteStatus: RemoteStatus = checking
    ? "checking"
    : hasCheckError
      ? "error"
      : remoteUpdates.length > 0
        ? "update"
        : hasActiveConfig
          ? "active"
          : "idle";
  const { label: statusLabel, color: remoteDotColor, pulse: remoteDotPulsing } = REMOTE_STATUS_META[remoteStatus];

  function goToRemoteUpdates() {
    navigate("/remote-updates/imports");
  }

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
        <div
          style={{ position: "relative" }}
          onMouseEnter={() => setRemoteHovered(true)}
          onMouseLeave={() => setRemoteHovered(false)}
        >
          <NavLink to="/remote-updates/imports" className={navLinkClass}>
            <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
              <RefreshCw size={18} className={checking ? "spin" : undefined} />
              <span
                className={remoteDotPulsing ? "pulse-dot" : undefined}
                style={{
                  position: "absolute",
                  top: -2,
                  right: -3,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: remoteDotColor,
                  border: "1.5px solid var(--sidebar-bg)",
                }}
                aria-label={statusLabel}
              />
            </span>
            <span>Verificação automática</span>
          </NavLink>

          {remoteHovered && (
            <div
              role="button"
              tabIndex={0}
              onClick={goToRemoteUpdates}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  goToRemoteUpdates();
                }
              }}
              style={{
                position: "absolute",
                left: "100%",
                bottom: 0,
                marginLeft: "0.5rem",
                background: "var(--card-bg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "0.7rem 0.9rem",
                minWidth: "220px",
                boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
                zIndex: 30,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.85rem" }}>
                <span
                  className={remoteDotPulsing ? "pulse-dot" : undefined}
                  style={{ width: 8, height: 8, borderRadius: "50%", background: remoteDotColor, flexShrink: 0 }}
                />
                {statusLabel}
                {checking && <RefreshCw size={12} className="spin" style={{ marginLeft: "auto", opacity: 0.7 }} />}
              </div>
              {remoteUpdates.length > 0 && (
                <p className="muted" style={{ fontSize: "0.78rem", margin: "0.4rem 0 0" }}>
                  {remoteUpdates.length === 1
                    ? "1 configuração com atualização pendente."
                    : `${remoteUpdates.length} configurações com atualização pendente.`}
                </p>
              )}
              {hasCheckError && (
                <p style={{ fontSize: "0.78rem", margin: "0.4rem 0 0", color: "var(--danger)" }}>
                  {tickError ?? "Falha em alguma verificação recente."}
                </p>
              )}
              <p className="muted" style={{ fontSize: "0.75rem", margin: "0.5rem 0 0" }}>
                Clique para ver os detalhes.
              </p>
            </div>
          )}
        </div>

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
