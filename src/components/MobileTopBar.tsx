import { useAuth } from "../contexts/AuthContext";
import { colorForName, initials } from "../lib/avatar";
import { usePendingChangesCount } from "../lib/pendingChanges";

/**
 * The phone layout's top bar (hidden on wider screens, see App.css): ☰
 * opens the menu over the page — a yellow dot on it when there are
 * "atualizações pendentes" — then the app's name and who is signed in
 * (which opens the menu too, where the account is).
 */
export default function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const { state } = useAuth();
  const pending = usePendingChangesCount();
  const user = state.status === "ready" ? state.user : null;
  return (
    <header className="mobile-topbar">
      <button type="button" className="mobile-topbar-menu" onClick={onMenu} aria-label={pending > 0 ? `Abrir menu — ${pending} atualizações pendentes` : "Abrir menu"}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        {pending > 0 && <span className="mobile-topbar-dot" aria-hidden="true" />}
      </button>
      <span className="mobile-topbar-brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 9h18M9 3v18" />
        </svg>
        Tá Pago
      </span>
      {user && (
        <button type="button" className="mobile-topbar-account" onClick={onMenu} aria-label={`Conta: ${user.email}`}>
          <span className="avatar" style={{ background: colorForName(user.email) }}>
            {initials(user.name)}
          </span>
        </button>
      )}
    </header>
  );
}
