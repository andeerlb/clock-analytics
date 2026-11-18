/**
 * Drop-in replacement for `@tauri-apps/api/event`'s `emit` / `listen`.
 *
 * The desktop app used Tauri's global event bus so a change in one window
 * (e.g. the detached "Conferência de Pagamentos") refreshed the others. In
 * the browser the same happens across tabs of the app through a
 * BroadcastChannel, and within the same tab through a local dispatch.
 * Same signatures as Tauri's, so callers only change the import.
 */
type Handler<T> = (event: { event: string; payload: T }) => void;

const CHANNEL = "tapago-events";
const local = new EventTarget();
const channel: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);

channel?.addEventListener("message", (message: MessageEvent<{ event: string; payload: unknown }>) => {
  local.dispatchEvent(new CustomEvent(message.data.event, { detail: message.data.payload }));
});

export async function emit<T = unknown>(event: string, payload?: T): Promise<void> {
  local.dispatchEvent(new CustomEvent(event, { detail: payload }));
  channel?.postMessage({ event, payload });
}

export type UnlistenFn = () => void;

export async function listen<T = unknown>(event: string, handler: Handler<T>): Promise<UnlistenFn> {
  const wrapped = (e: Event) => handler({ event, payload: (e as CustomEvent<T>).detail });
  local.addEventListener(event, wrapped);
  return () => local.removeEventListener(event, wrapped);
}

/**
 * Tauri's `emitTo(window, …)`: there are no separate windows in the browser,
 * so this reaches every tab of the app, same as `emit`.
 */
export async function emitTo<T = unknown>(_target: string, event: string, payload?: T): Promise<void> {
  return emit(event, payload);
}
