import type { ReactNode } from "react";
import { useAuth, type SignInNotice } from "../contexts/AuthContext";
import { AUTH_MODE } from "../lib/firebase";

/** Google's "G" mark, as Google's sign-in branding guidelines ask for on the button. */
function GoogleMark() {
  return (
    <svg className="signin-google-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const ICON_PROPS = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function ClockMark() {
  return (
    <svg {...ICON_PROPS} width={18} height={18}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function GoogleButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className="signin-google-btn" onClick={onClick} disabled={busy} aria-busy={busy}>
      {busy ? <span className="signin-spinner" aria-hidden="true" /> : <GoogleMark />}
      <span>{busy ? "Aguardando o Google…" : label}</span>
    </button>
  );
}

function Notice({ notice }: { notice: SignInNotice }) {
  if (notice.kind === "denied") {
    return (
      <div className="signin-notice danger" role="alert">
        <strong>Este e-mail não tem acesso ao PontoScan</strong>
        <span className="signin-email-chip">{notice.email}</span>
        <p>Peça ao administrador para incluir este e-mail, ou entre com a conta da empresa.</p>
      </div>
    );
  }
  if (notice.kind === "popup-blocked") {
    return (
      <div className="signin-notice warning" role="alert">
        <strong>A janela do Google não abriu</strong>
        <p>O navegador bloqueou o pop-up. Libere pop-ups para este site no ícone da barra de endereço e tente de novo.</p>
      </div>
    );
  }
  return (
    <div className="signin-notice warning" role="alert">
      <strong>Não foi possível entrar</strong>
      <p>{notice.message}</p>
    </div>
  );
}

function SignInScreen({ notice, busy, onSignIn }: { notice: SignInNotice | null; busy: boolean; onSignIn: () => void }) {
  const denied = notice?.kind === "denied";
  const label = denied ? "Entrar com outra conta Google" : notice?.kind === "popup-blocked" ? "Tentar de novo" : "Entrar com Google";
  return (
    <main className="signin">
      <section className="signin-card" aria-labelledby="signin-title">
        <div className="signin-brand">
          <span className="signin-brand-mark"><ClockMark /></span>
          <span className="signin-brand-name">PontoScan</span>
        </div>
        <div className="signin-heading">
          <h1 id="signin-title">{denied ? "Acesso negado" : "Entrar"}</h1>
          <p>
            {denied
              ? "Você entrou no Google, mas essa conta não está na lista de acesso."
              : "Use sua conta Google para acessar os espelhos de ponto e pagamentos."}
          </p>
        </div>
        {notice && <Notice notice={notice} />}
        {busy && <p className="signin-hint">Conclua o login na janela do Google que abriu.</p>}
        {AUTH_MODE !== "missing" && <GoogleButton label={label} busy={busy} onClick={onSignIn} />}
        <div className="signin-footnote">
          <svg {...ICON_PROPS}>
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span>Acesso restrito à equipe. Só entram os e-mails cadastrados pelo administrador.</span>
        </div>
      </section>
    </main>
  );
}

/** Renders the app only for a signed-in, allowed user; everything else is the sign-in screen. */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { state, signIn } = useAuth();

  if (state.status === "starting") {
    return (
      <main className="signin" aria-busy="true">
        <span className="signin-spinner large" role="status" aria-label="Carregando" />
      </main>
    );
  }

  if (state.status === "signed-out") {
    return <SignInScreen notice={state.notice} busy={state.signingIn} onSignIn={signIn} />;
  }

  return (
    <>
      {children}
      {state.expired && (
        <div className="signin-modal-backdrop">
          <div className="signin-modal" role="dialog" aria-modal="true" aria-labelledby="expired-title">
            <h2 id="expired-title">Sua sessão expirou</h2>
            <p>Entre de novo para continuar. Você volta para esta mesma tela, e o que já foi salvo continua salvo.</p>
            <GoogleButton label="Entrar com Google" busy={state.signingIn} onClick={signIn} />
          </div>
        </div>
      )}
    </>
  );
}
