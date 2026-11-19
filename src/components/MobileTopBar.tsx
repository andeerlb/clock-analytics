import SidebarAccount from "./SidebarAccount";
import { usePendingChangesCount } from "../lib/pendingChanges";

/**
 * The phone layout's top bar (hidden on wider screens, see App.css): ☰
 * opens the menu over the page — a yellow dot on it when there are
 * "atualizações pendentes" — and, on the right, the signed-in person's
 * avatar, which opens the account menu (Configurações, Usuários
 * e perfis, Atividade, Sair).
 */
export default function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const pending = usePendingChangesCount();
  return (
    <header className="mobile-topbar">
      <button type="button" className="mobile-topbar-menu" onClick={onMenu} aria-label={pending > 0 ? `Abrir menu — ${pending} atualizações pendentes` : "Abrir menu"}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        {pending > 0 && <span className="mobile-topbar-dot" aria-hidden="true" />}
      </button>
      <span className="mobile-topbar-spacer" />
      <SidebarAccount collapsed={false} placement="topbar" />
    </header>
  );
}
