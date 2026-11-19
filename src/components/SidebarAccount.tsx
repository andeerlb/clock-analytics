import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAccess, useAuth } from "../contexts/AuthContext";
import { colorForName, initials } from "../lib/avatar";
import { AUTH_MODE } from "../lib/firebase";

const ICON_PROPS = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/**
 * Who is signed in, at the foot of the sidebar. Clicking the card opens the
 * account menu (Configurações, Usuários e perfis, Atividade, Sair) the
 * same way the app's pickers open: the box grows out of the card itself,
 * upward, with the card at its bottom (see `.emp-picker-popover`).
 * Collapsed sidebar: just the avatar.
 *
 * `placement="topbar"` is the phone layout's version: only the avatar, at
 * the right of `MobileTopBar`, and the menu drops down from it.
 */
export default function SidebarAccount({ collapsed, placement = "sidebar" }: { collapsed: boolean; placement?: "sidebar" | "topbar" }) {
  const { state, signOut } = useAuth();
  const { access, canView, canManageUsers } = useAccess();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Leaving the page through one of the items closes the menu.
  useEffect(() => setOpen(false), [pathname]);

  if (state.status !== "ready") return null;
  const { name, email } = state.user;
  const canSwitch = AUTH_MODE === "firebase";
  const onAccountPage = pathname.startsWith("/settings") || pathname.startsWith("/users") || pathname.startsWith("/activity");

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  const card = (inMenu: boolean) =>
    placement === "topbar" ? (
      <button
        type="button"
        className="mobile-topbar-account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Conta: ${email}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" style={{ background: colorForName(email) }}>
          {initials(name)}
        </span>
      </button>
    ) : (
    <button
      type="button"
      className={`sidebar-account-trigger${onAccountPage && !inMenu ? " current" : ""}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Conta: ${email}`}
      title={collapsed ? email : undefined}
      onClick={() => setOpen((v) => !v)}
    >
      <span className="avatar sidebar-account-avatar" style={{ background: colorForName(email) }}>
        {initials(name)}
      </span>
      <span className="sidebar-account-text app-nav-label">
        <b>{name}</b>
        <small>{access.profileName}</small>
      </span>
      <svg {...ICON_PROPS} className={`app-nav-label sidebar-account-chevron${inMenu ? " open" : ""}`}>
        <path d="M7 15l5-5 5 5" />
      </svg>
    </button>
    );

  return (
    <div className={placement === "topbar" ? "sidebar-account sidebar-account-topbar" : "sidebar-account"} ref={rootRef}>
      {card(false)}
      {open && (
        <div className={placement === "topbar" ? "sidebar-account-menu sidebar-account-menu-top" : "sidebar-account-menu"} role="menu">
          <div className="sidebar-account-menu-head">
            <b>{name}</b>
            <small>{email}</small>
            <em>{access.profileName}</em>
          </div>
          {canView("configuracoes") && (
            <button type="button" role="menuitem" className={pathname.startsWith("/settings") ? "active" : undefined} onClick={() => go("/settings")}>
              <svg {...ICON_PROPS}>
                <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />
              </svg>
              Configurações
            </button>
          )}
          {canManageUsers && (
            <button type="button" role="menuitem" className={pathname.startsWith("/users") ? "active" : undefined} onClick={() => go("/users")}>
              <svg {...ICON_PROPS}>
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" />
              </svg>
              Usuários e perfis
            </button>
          )}
          {canManageUsers && (
            <button type="button" role="menuitem" className={pathname.startsWith("/activity") ? "active" : undefined} onClick={() => go("/activity")}>
              <svg {...ICON_PROPS}>
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />
              </svg>
              Atividade
            </button>
          )}
          {canSwitch ? (
            <>
              <div className="sidebar-account-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setOpen(false);
                  signOut();
                }}
              >
                <svg {...ICON_PROPS}>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
                Sair
              </button>
            </>
          ) : (
            <p className="sidebar-account-dev">Modo de desenvolvimento: login desativado.</p>
          )}
          {placement === "sidebar" && card(true)}
        </div>
      )}
    </div>
  );
}
