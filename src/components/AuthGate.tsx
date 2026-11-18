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

/** A spreadsheet: the brand mark while the product's final name is decided. */
function SheetMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 3v18" />
    </svg>
  );
}

/** Made-up rows for the background spreadsheet: never real people or clients. */
const SAMPLE_NAMES = ["Fulana Exemplo", "Beltrano Teste", "Cicrana Modelo", "Dora Fictícia", "Edu Inventado", "Fê Amostra", "Gil Exemplo", "Íris Teste", "Juca Modelo", "Lia Demonstração"];
const SAMPLE_PLACES = ["Unidade Centro", "Unidade Norte", "Unidade Sul", "Unidade Leste"];
const SAMPLE_HOURS = ["08:00 às 16:00", "16:00 às 22:00", "07:00 às 13:00", "13:00 às 19:00"];
const SAMPLE_VALUES = ["R$ 120,00", "R$ 95,00", "R$ 90,00", "R$ 110,00"];

/** The spreadsheet drifting behind the sign-in panel (two copies of 40 rows, so the loop is seamless). */
function BackgroundSheet() {
  const rows = Array.from({ length: 80 }, (_, i) => i);
  return (
    <div className="signin-grid" aria-hidden="true">
      <table>
        <thead>
          <tr>
            <th />
            {["A", "B", "C", "D", "E", "F", "G"].map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i}>
              <th>{(i % 40) + 2}</th>
              <td className={i % 7 === 3 ? "hl" : undefined}>{SAMPLE_NAMES[i % SAMPLE_NAMES.length]}</td>
              <td>{String(10 + (i % 18)).padStart(2, "0")}/11</td>
              <td>{SAMPLE_PLACES[i % 4]}</td>
              <td>{SAMPLE_HOURS[i % 4]}</td>
              <td>{SAMPLE_VALUES[i % 4]}</td>
              <td>{i % 5 ? "pendente" : "pago"}</td>
              <td>caixa</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        <strong>Este e-mail não tem acesso</strong>
        <span className="signin-email-chip">{notice.email}</span>
        <p>Peça a um admin para cadastrar este e-mail em Usuários e perfis.</p>
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
      <BackgroundSheet />
      <div className="signin-fade" />
      <section className="signin-panel" aria-labelledby="signin-title">
        <span className="signin-brand">
          <span className="signin-brand-mark">
            <SheetMark />
          </span>
          Tá Pago
        </span>
        <h1 id="signin-title">
          {denied ? (
            "Essa conta não está cadastrada."
          ) : (
            <>
              Da planilha ao <span>pagamento</span>.
            </>
          )}
        </h1>
        <p className="signin-lead">
          {denied
            ? "Você entrou no Google, mas este e-mail não tem acesso ao sistema."
            : "Importe as escalas, confira o que mudou e pague cada turno sem copiar e colar."}
        </p>
        {!denied && (
          <div className="signin-formats" aria-label="Formatos aceitos">
            {[".xlsx", ".xls", ".ods", ".csv", "link"].map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        )}
        {notice && <Notice notice={notice} />}
        {AUTH_MODE !== "missing" && <GoogleButton label={label} busy={busy} onClick={onSignIn} />}
        {busy && <p className="signin-hint">Conclua o login na janela do Google que abriu.</p>}
      </section>
    </main>
  );
}

/** Renders the app only for a signed-in, allowed user; everything else is the sign-in screen. */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { state, signIn } = useAuth();

  if (state.status === "starting") {
    return (
      <main className="signin signin-loading" aria-busy="true">
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
