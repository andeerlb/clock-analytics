import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";

/**
 * Firebase web config, from Vite env (`.env.local` in dev, CI secrets in
 * the production build). These values are public by design — they identify
 * the project to Google; what protects the data is the server checking the
 * token and the e-mail allowlist.
 */
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const configured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);

/**
 * `"firebase"`: real Google login.
 * `"dev"`: `yarn dev` without Firebase config — no login screen; the local
 *   server (started with TAPAGO_DEV_USER_EMAIL) answers as the dev user.
 * `"missing"`: a production build without config — shown as an error,
 *   never silently skipped.
 */
export const AUTH_MODE: "firebase" | "dev" | "missing" = configured ? "firebase" : import.meta.env.DEV ? "dev" : "missing";

export const auth: Auth | null = configured ? getAuth(initializeApp(config)) : null;

export function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Always show the account chooser, so "Entrar com outra conta" really
  // lets the person pick a different Google account.
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}
