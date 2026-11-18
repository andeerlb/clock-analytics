/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web server base URL in production (e.g. https://pontoscan.duckdns.org). Empty in dev — Vite proxies `/api`. */
  readonly VITE_API_URL?: string;
}
