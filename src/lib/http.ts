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

/** Set by `AuthProvider`: hands out the signed-in user's Firebase ID token (refreshed by Firebase as needed). */
export function setAuthTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/** 401 = the session is no longer valid; 403 = this e-mail lost access. */
type AuthFailureHandler = (status: 401 | 403) => void;
let authFailureHandler: AuthFailureHandler = () => {};

/** Set by `AuthProvider`, so any screen's API call can trigger "sessão expirou" / "sem acesso". */
export function setAuthFailureHandler(handler: AuthFailureHandler): void {
  authFailureHandler = handler;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Sends a request with the login token; throws `ApiError` with the server's message on failure. */
async function send(method: string, path: string, body?: BodyInit, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = await tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers["Content-Type"] = contentType;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, { method, headers, body });
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
    if (response.status === 401 || response.status === 403) authFailureHandler(response.status);
    throw new ApiError(message, response.status);
  }
  return response;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await send(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? undefined : "application/json",
  );
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

/**
 * Calls a server function that replaced a `db.ts` / Tauri-command function:
 * `POST /api/rpc/<name>` with the original function's arguments as one
 * object, keyed by their parameter names. See server/PORTING.md.
 */
export function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return request<T>("POST", `/rpc/${name}`, args);
}

export interface UploadedFile {
  /** Server path — what the old path-based functions now receive. */
  path: string;
  fileName: string;
  size: number;
}

/** Uploads files to the server (all into one folder) and returns their server paths, in order. */
export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  if (files.length === 0) return [];
  const form = new FormData();
  for (const file of files) form.append("file", file, file.name);
  const response = await send("POST", "/files/upload", form);
  return (await response.json()) as UploadedFile[];
}

/** Bytes of a file stored on the server (e.g. an imported PDF for the viewer). */
export async function fetchServerFile(path: string): Promise<ArrayBuffer> {
  const response = await send("GET", `/files/content?path=${encodeURIComponent(path)}`);
  return response.arrayBuffer();
}

/** A file stored on the server, as a `Blob` (large files stay on disk instead of in memory). */
export async function fetchServerBlob(path: string): Promise<Blob> {
  const response = await send("GET", `/files/content?path=${encodeURIComponent(path)}`);
  return response.blob();
}

/** Git commit the server was built from ("dev" for local builds) — the "Versão" row in Configurações. */
export async function fetchServerVersion(): Promise<string> {
  const response = await send("GET", "/version");
  return (await response.text()).trim();
}
