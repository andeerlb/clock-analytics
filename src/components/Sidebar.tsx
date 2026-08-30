import type { Update } from "@tauri-apps/plugin-updater";
import { BarChart3, Briefcase, Building2, Clock, FileUp, RefreshCw, Settings, Tag, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import UpdateModal from "./UpdateModal";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { checkForUpdate } from "../lib/updateCheck";

const NAV_ITEMS = [
  { to: "/import", label: "Importar", icon: FileUp, end: false },
  { to: "/companies", label: "Empresas", icon: Building2, end: false },
  { to: "/clients", label: "Clientes", icon: Briefcase, end: false },
  { to: "/employees", label: "Colaboradores", icon: Users, end: false },
  { to: "/roles", label: "Funções", icon: Tag, end: false },
  { to: "/", label: "Cartão Ponto", icon: Clock, end: true },
  { to: "/payments", label: "Pagamentos", icon: Wallet, end: false },
  { to: "/analytics", label: "Análises", icon: BarChart3, end: false },
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
  const { remoteUpdates, trackedFiles, reimportConfigs, checking, tickError } = useRemoteFileUpdates();

  // Passive check on launch — found means "surface it immediately" (no
  // separate click needed to see the modal), not just a badge waiting to be
  // noticed.
  useEffect(() => {
    checkForUpdate()
      .then((update) => {
        if (update) {
          setAvailableUpdate(update);
          setShowUpdateModal(true);
        }
      })
      .catch(() => {});
  }, []);

  // No single countdown makes sense anymore — a URL can have several
  // reimport configs, each on its own schedule (see the Verificação
  // automática page for those). This is just a status summary: whether
  // anything's actively watching, and whether it found something. Kept to
  // a single color-coded dot (title attribute for the label on hover,
  // no separate popover) — the actual "something was found" detail is
  // `PendingChangesTab`'s job now, not this nav link's.
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
        <NavLink to="/remote-updates/imports" className={navLinkClass} title={statusLabel}>
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
