/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web server base URL in production (e.g. https://pontoscan.duckdns.org). Empty in dev — Vite proxies `/api`. */
  readonly VITE_API_URL?: string;
  /** Firebase web app config (Firebase console → Configurações do projeto → Seus apps). All four, or none in dev. */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}
