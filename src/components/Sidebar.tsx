import type { Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import UpdateModal from "./UpdateModal";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { checkForUpdate } from "../lib/updateCheck";

function MenuIcon({ path, size = 17, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  brand: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  toggle: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18",
  import: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15l3-3 3 3",
  companies: "M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1",
  clients: "M4 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  employees: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  roles: "M12 2H2v10l9.3 9.3a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4zM7 7h.01",
  timesheet: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  payments: "M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1M17 14h.01",
  analytics: "M3 3v18h18M8 17v-5M13 17V7M18 17v-8",
  remote: "M21 12a9 9 0 0 0-15-6.7L3 8M3 3v5h5M3 12a9 9 0 0 0 15 6.7L21 16M21 21v-5h-5",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4",
};

const NAV_GROUPS = [
  {
    title: "Operação",
    items: [
      { to: "/import", label: "Importar", icon: ICONS.import, end: false },
      { to: "/", label: "Cartão Ponto", icon: ICONS.timesheet, end: true },
      { to: "/payments", label: "Pagamentos", icon: ICONS.payments, end: false },
      { to: "/analytics", label: "Análises", icon: ICONS.analytics, end: false },
    ],
  },
  {
    title: "Cadastros",
    items: [
      { to: "/companies", label: "Empresas", icon: ICONS.companies, end: false },
      { to: "/clients", label: "Clientes", icon: ICONS.clients, end: false },
      { to: "/employees", label: "Colaboradores", icon: ICONS.employees, end: false },
      { to: "/roles", label: "Funções", icon: ICONS.roles, end: false },
    ],
  },
];

const COLLAPSED_KEY = "sidebar-collapsed";

function readSavedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

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
  const [collapsed, setCollapsed] = useState(readSavedCollapsed);
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

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* only a remembered preference */
    }
  }

  return (
    <nav className={collapsed ? "app-nav collapsed" : "app-nav"}>
      <div className="app-brand">
        <MenuIcon path={ICONS.brand} size={18} className="app-nav-label" />
        <span className="app-brand-name app-nav-label">PontoScan</span>
        <button
          type="button"
          className="app-nav-toggle"
          aria-label={collapsed ? "Abrir menu" : "Fechar menu"}
          aria-expanded={!collapsed}
          title={collapsed ? "Abrir menu" : "Fechar menu"}
          onClick={toggleCollapsed}
        >
          <MenuIcon path={ICONS.toggle} />
        </button>
      </div>

      <div className="app-nav-links">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="app-nav-group">
            <span className="app-nav-group-title app-nav-label">{group.title}</span>
            <span className="app-nav-group-rule" aria-hidden="true" />
            {group.items.map(({ to, label, icon, end }) => (
              <NavLink key={to} to={to} end={end} className={navLinkClass} title={collapsed ? label : undefined} aria-label={label}>
                <MenuIcon path={icon} />
                <span className="app-nav-label">{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </div>

      <div className="app-nav-footer">
        <NavLink to="/remote-updates/imports" className={navLinkClass} title={collapsed ? `Verificação automática: ${statusLabel}` : statusLabel} aria-label="Verificação automática">
          <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
            <MenuIcon path={ICONS.remote} className={checking ? "spin" : undefined} />
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
          <span className="app-nav-label">Verificação automática</span>
        </NavLink>

        <NavLink to="/settings" className={navLinkClass} title={collapsed ? "Configurações" : undefined} aria-label="Configurações">
          <MenuIcon path={ICONS.settings} />
          <span className="app-nav-label">Configurações</span>
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
