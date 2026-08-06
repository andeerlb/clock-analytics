import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkRemotePaymentFile, getRemoteFileCheckIntervalMinutes, setRemoteFileCheckIntervalMinutes } from "../lib/api";
import { listUrlSourcedPaymentFiles, setUrlCheckDisabled } from "../lib/db";

/** A URL-sourced payment import this check found has changed remotely since it was last saved. */
export interface RemoteUpdateFlag {
  sourceUrl: string;
  fileName: string;
  /** The template's name at last import (`source_files.provider`) — used to try to auto-select it again; templates are only ever referenced by name here, not id. */
  provider: string;
  lastImportedAt: string;
}

/** One URL's check failing on the last cycle — surfaced instead of silently ignored, unlike the app's own update-checker. */
export interface RemoteCheckFailure {
  sourceUrl: string;
  fileName: string;
  message: string;
}

/**
 * Payroll files can change mid-day, and the app can stay open for hours (or
 * days) without the user ever revisiting Importar Pagamentos — a one-shot
 * check on that page's mount (like the app's own update-checker in
 * `Sidebar.tsx`) could go unnoticed indefinitely. Checked here instead, at
 * the app root (always mounted for the whole session, so the Sidebar can
 * show a hint regardless of which screen is open), on an interval short
 * enough to feel prompt but still trivially low-volume for a single HEAD
 * request per known URL — plus an immediate recheck when the window
 * regains focus, covering "left it open for days, just switched back"
 * without waiting for the next tick.
 *
 * The interval itself is user-editable in Configurações (default 5 min,
 * persisted server-side, minimum 1) — unlike the app's own update check,
 * which stays a fixed 30 minutes. `intervalMinutes` here starts at that
 * same default before the real persisted value loads, so polling begins
 * immediately instead of waiting on a round-trip.
 */
const DEFAULT_CHECK_INTERVAL_MINUTES = 5;

interface RemoteFileUpdatesContextValue {
  remoteUpdates: RemoteUpdateFlag[];
  dismissRemoteUpdate: (url: string) => void;
  /** Turns the automatic check off for one URL — persisted (see `setUrlCheckDisabled`), unlike `dismissRemoteUpdate` which only hides the current banner. */
  disableUrlCheck: (url: string) => Promise<void>;
  refreshNow: () => void;
  intervalMinutes: number;
  setIntervalMinutes: (minutes: number) => Promise<void>;
  /** True while a check cycle is in flight — for a "Verificando..." indicator in Configurações. */
  checking: boolean;
  /** When the last check cycle finished (success or failure), ISO string. */
  lastCheckedAt: string | null;
  /** Per-URL failures from the last cycle — unlike a flagged update, these mean the check itself couldn't run (offline, server error, etc.), not that the file didn't change. */
  lastErrors: RemoteCheckFailure[];
}

const RemoteFileUpdatesContext = createContext<RemoteFileUpdatesContextValue | null>(null);

export function RemoteFileUpdatesProvider({ children }: { children: ReactNode }) {
  const [remoteUpdates, setRemoteUpdates] = useState<RemoteUpdateFlag[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [intervalMinutes, setIntervalMinutesState] = useState(DEFAULT_CHECK_INTERVAL_MINUTES);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [lastErrors, setLastErrors] = useState<RemoteCheckFailure[]>([]);
  // A dismissed URL that's genuinely still different keeps getting
  // re-flagged by `check()` on every tick — filtered back out here so
  // "Ignorar" stays dismissed until the user actually reimports (which
  // logs a new source_files row with a fresh etag/hash, so future checks
  // naturally stop matching `changed === true` against it).
  const checkingRef = useRef(false);

  useEffect(() => {
    getRemoteFileCheckIntervalMinutes()
      .then(setIntervalMinutesState)
      .catch(() => {}); // stick with the default rather than block polling on this
  }, []);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const known = await listUrlSourcedPaymentFiles();
      if (known.length === 0) {
        setRemoteUpdates([]);
        setLastErrors([]);
        return;
      }
      const checks = await Promise.allSettled(
        known.map((k) =>
          checkRemotePaymentFile(k.sourceUrl, k.sourceEtag, k.sourceLastModified, k.sourceContentLength),
        ),
      );
      const flagged: RemoteUpdateFlag[] = [];
      const failures: RemoteCheckFailure[] = [];
      checks.forEach((res, i) => {
        if (res.status === "fulfilled") {
          if (res.value.changed === true) {
            flagged.push({
              sourceUrl: known[i].sourceUrl,
              fileName: known[i].fileName,
              provider: known[i].provider,
              lastImportedAt: known[i].importedAt,
            });
          }
          // changed === false/null — nothing to report, same ambient
          // treatment as the app's own update-checker.
        } else {
          failures.push({
            sourceUrl: known[i].sourceUrl,
            fileName: known[i].fileName,
            message: String(res.reason instanceof Error ? res.reason.message : res.reason),
          });
        }
      });
      setRemoteUpdates(flagged);
      setLastErrors(failures);
    } catch (e) {
      setLastErrors([{ sourceUrl: "", fileName: "", message: String(e instanceof Error ? e.message : e) }]);
    } finally {
      setLastCheckedAt(new Date().toISOString());
      setChecking(false);
      checkingRef.current = false;
    }
  }, []);

  // Re-created whenever `intervalMinutes` changes — including right after
  // `setIntervalMinutes` below saves a new value from Configurações, so a
  // change takes effect immediately instead of needing an app restart.
  useEffect(() => {
    check();
    const interval = setInterval(check, intervalMinutes * 60 * 1000);
    function onVisibilityChange() {
      if (document.visibilityState === "visible") check();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [check, intervalMinutes]);

  function dismissRemoteUpdate(url: string) {
    setDismissed((prev) => new Set(prev).add(url));
  }

  async function disableUrlCheck(url: string) {
    await setUrlCheckDisabled(url, true);
    setRemoteUpdates((prev) => prev.filter((u) => u.sourceUrl !== url));
  }

  async function setIntervalMinutes(minutes: number) {
    const saved = await setRemoteFileCheckIntervalMinutes(minutes);
    setIntervalMinutesState(saved);
  }

  const visible = remoteUpdates.filter((u) => !dismissed.has(u.sourceUrl));

  return (
    <RemoteFileUpdatesContext.Provider
      value={{
        remoteUpdates: visible,
        dismissRemoteUpdate,
        disableUrlCheck,
        refreshNow: check,
        intervalMinutes,
        setIntervalMinutes,
        checking,
        lastCheckedAt,
        lastErrors,
      }}
    >
      {children}
    </RemoteFileUpdatesContext.Provider>
  );
}

export function useRemoteFileUpdates(): RemoteFileUpdatesContextValue {
  const ctx = useContext(RemoteFileUpdatesContext);
  if (!ctx) throw new Error("useRemoteFileUpdates must be used within RemoteFileUpdatesProvider");
  return ctx;
}
