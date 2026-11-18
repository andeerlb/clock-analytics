/**
 * Client for the PontoScan web server (`server/`). Every call carries the
 * Firebase ID token of whoever is signed in; the server rejects anything
 * else. Errors come back as `{ error: "..." }` with a message meant for the
 * user, and are rethrown as a plain `Error` with that message — the same
 * shape `db.ts` used to throw, so the screens' error handling is unchanged.
 */

/** Empty = same origin (dev, through Vite's `/api` proxy). In production, the server's URL. */
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;

/** Set by the login layer once Firebase Auth is wired in. */
export function setAuthTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = await tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Não foi possível falar com o servidor. Verifique sua conexão.", 0);
  }

  if (!response.ok) {
    let message = `Erro ${response.status} no servidor.`;
    try {
      const data = await response.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {
      // Not JSON (proxy error page, etc.) — keep the generic message.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
