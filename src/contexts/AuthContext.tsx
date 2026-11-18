import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut, type User } from "firebase/auth";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { auth, AUTH_MODE, googleProvider } from "../lib/firebase";
import { api, ApiError, setAuthFailureHandler, setAuthTokenProvider } from "../lib/http";

export interface SignedInUser {
  email: string;
  name: string;
}

/** Why the person is looking at the sign-in screen, if it's not a plain first visit. */
export type SignInNotice =
  | { kind: "denied"; email: string }
  | { kind: "popup-blocked" }
  | { kind: "error"; message: string };

export type AuthState =
  /** Restoring a previous session / confirming access with the server. */
  | { status: "starting" }
  | { status: "signed-out"; notice: SignInNotice | null; signingIn: boolean }
  /** `expired`: the server stopped accepting the session — the app stays mounted under a re-login prompt. */
  | { status: "ready"; user: SignedInUser; expired: boolean; signingIn: boolean };

interface AuthContextValue {
  state: AuthState;
  /** Opens Google's account chooser. Must be called straight from a click (browsers block pop-ups otherwise). */
  signIn: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth fora do AuthProvider");
  return value;
}

/** Firebase error codes that just mean "the person closed the window" — not worth a message. */
const CANCELLED = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/user-cancelled"]);

function noticeForSignInError(error: unknown): SignInNotice | null {
  const code = (error as { code?: string })?.code ?? "";
  if (CANCELLED.has(code)) return null;
  if (code === "auth/popup-blocked") return { kind: "popup-blocked" };
  if (code === "auth/network-request-failed") {
    return { kind: "error", message: "Sem conexão com o Google. Verifique sua internet e tente de novo." };
  }
  if (code === "auth/operation-not-allowed" || code === "auth/configuration-not-found") {
    return { kind: "error", message: "O login com Google não está ativado no Firebase. Ative em Authentication → Método de login → Google." };
  }
  if (code.startsWith("auth/api-key-not-valid") || code === "auth/invalid-api-key") {
    return { kind: "error", message: "A configuração do Firebase deste build está errada (chave de API inválida)." };
  }
  if (code === "auth/unauthorized-domain") {
    return {
      kind: "error",
      message: "Este endereço não está autorizado no Firebase. Adicione-o em Authentication → Configurações → Domínios autorizados.",
    };
  }
  return { kind: "error", message: `Não foi possível entrar (${code || "erro desconhecido"}). Tente de novo.` };
}

/** "ana.souza@x.com" → "Ana Souza", for accounts without a Google display name (and dev mode). */
function nameFromEmail(email: string): string {
  return email
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function toSignedInUser(email: string, user: User | null): SignedInUser {
  return { email, name: user?.displayName?.trim() || nameFromEmail(email) || email };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    AUTH_MODE === "missing"
      ? {
          status: "signed-out",
          signingIn: false,
          notice: { kind: "error", message: "O login não foi configurado neste build (faltam as variáveis VITE_FIREBASE_*)." },
        }
      : { status: "starting" },
  );
  // Survives the sign-out that follows a denied login, so the screen can still show which e-mail was refused.
  const pendingNotice = useRef<SignInNotice | null>(null);

  /** Asks the server whether this login may use the system (token valid + e-mail on the allowlist). */
  const verify = useCallback(async (user: User | null) => {
    try {
      const me = await api.get<{ email: string }>("/me");
      pendingNotice.current = null;
      setState({ status: "ready", user: toSignedInUser(me.email, user), expired: false, signingIn: false });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && user?.email) {
        pendingNotice.current = { kind: "denied", email: user.email };
        if (auth) await firebaseSignOut(auth);
        return; // onAuthStateChanged(null) shows the sign-in screen with this notice
      }
      const message = error instanceof Error ? error.message : "Não foi possível falar com o servidor.";
      pendingNotice.current = null;
      if (auth && user) await firebaseSignOut(auth).catch(() => {});
      setState({ status: "signed-out", signingIn: false, notice: { kind: "error", message } });
    }
  }, []);

  useEffect(() => {
    if (AUTH_MODE === "dev") {
      // No Firebase: the local server's dev bypass answers /me.
      void verify(null);
      return;
    }
    if (!auth) return;
    const firebaseAuth = auth;
    setAuthTokenProvider(async () => (firebaseAuth.currentUser ? firebaseAuth.currentUser.getIdToken() : null));
    return onAuthStateChanged(firebaseAuth, (user) => {
      if (user) {
        void verify(user);
      } else {
        const notice = pendingNotice.current;
        pendingNotice.current = null;
        setState({ status: "signed-out", signingIn: false, notice });
      }
    });
  }, [verify]);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    setAuthFailureHandler((status) => {
      const current = stateRef.current;
      if (current.status !== "ready") return;
      if (status === 401) {
        if (!current.expired) setState({ ...current, expired: true });
        return;
      }
      // 403 mid-session: this e-mail was taken off the allowlist.
      pendingNotice.current = { kind: "denied", email: current.user.email };
      if (auth) void firebaseSignOut(auth);
    });
    return () => setAuthFailureHandler(() => {});
  }, []);

  const signIn = useCallback(() => {
    if (!auth) return;
    const current = stateRef.current;
    if (current.status !== "starting") setState({ ...current, signingIn: true });
    signInWithPopup(auth, googleProvider())
      // Also verified here, not only in onAuthStateChanged: renewing an
      // expired session with the same account doesn't change the user, so
      // that listener stays silent.
      .then((credential) => verify(credential.user))
      .catch((error) => {
        const notice = noticeForSignInError(error);
        const latest = stateRef.current;
        if (latest.status === "ready") setState({ ...latest, signingIn: false });
        else setState({ status: "signed-out", signingIn: false, notice });
      });
  }, [verify]);

  const signOut = useCallback(() => {
    pendingNotice.current = null;
    if (auth) void firebaseSignOut(auth);
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
