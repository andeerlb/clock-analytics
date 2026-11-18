import { useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { colorForName, initials } from "../lib/avatar";
import { AUTH_MODE } from "../lib/firebase";

const ICON_PROPS = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** Who is signed in, at the foot of the sidebar, with "Trocar de conta" / "Sair". Collapsed sidebar: just the avatar. */
export default function SidebarAccount({ collapsed }: { collapsed: boolean }) {
  const { state, signIn, signOut } = useAuth();
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

  if (state.status !== "ready") return null;
  const { name, email } = state.user;
  const canSwitch = AUTH_MODE === "firebase";

  return (
    <div className="sidebar-account" ref={rootRef}>
      <button
        type="button"
        className="sidebar-account-trigger"
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
          <small>{email}</small>
        </span>
        <svg {...ICON_PROPS} className="app-nav-label sidebar-account-more">
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {open && (
        <div className="sidebar-account-menu" role="menu">
          <div className="sidebar-account-menu-head">
            <b>{name}</b>
            <small>{email}</small>
          </div>
          {canSwitch ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  signIn();
                }}
              >
                <svg {...ICON_PROPS}>
                  <path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7" />
                </svg>
                Trocar de conta
              </button>
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
        </div>
      )}
    </div>
  );
}
