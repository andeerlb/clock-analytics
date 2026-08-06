import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkRemotePaymentFile, getRemoteFileCheckIntervalMinutes, setRemoteFileCheckIntervalMinutes } from "../lib/api";
import {
  createReimportConfig as createReimportConfigDb,
  deleteReimportConfig as deleteReimportConfigDb,
  listReimportConfigs,
  listTrackedPaymentUrls,
  logUrlCheckResult,
  setUrlCheckDisabled as setUrlCheckDisabledDb,
  setUrlCheckIntervalMinutes as setUrlCheckIntervalMinutesDb,
  trackUrlForAutoReimport,
  updateReimportConfig as updateReimportConfigDb,
  type ReimportConfig,
  type ReimportConfigInput,
  type TrackedPaymentUrl,
  type UrlCheckResult,
} from "../lib/db";
import { resolveReimportConfigLabel, resolveReimportPeriod } from "../lib/format";

export type { ReimportConfig, ReimportConfigInput, ReimportDateMode, TrackedPaymentUrl, UrlCheckResult } from "../lib/db";

/**
 * One reimport config, for one tracked URL, currently known to be out of
 * date — each config a tracked URL has flags independently (a URL with
 * two configs and a detected change produces two of these, not one).
 */
export interface RemoteUpdateFlag {
  configId: number;
  sourceUrl: string;
  fileName: string;
  configLabel: string;
  templateId: number;
  lastImportedAt: string;
  /** Already resolved — for a relative-Período config this is always "as of right now", never a stale cached date. */
  resolvedPeriodStart: string | null;
  resolvedPeriodEnd: string | null;
}

/**
 * Payroll files can change mid-day, and the app can stay open for hours (or
 * days) without the user ever revisiting Importar Pagamentos — a one-shot
 * check on that page's mount (like the app's own update-checker in
 * `Sidebar.tsx`) could go unnoticed indefinitely. Checked here instead, at
 * the app root (always mounted for the whole session, so the Sidebar and
 * the "Verificação automática" page can both reflect it regardless of
 * which screen is open).
 *
 * Each tracked URL can have its own check interval (`checkIntervalMinutes`
 * on `TrackedPaymentUrl`, editable on the Verificação automática page),
 * falling back to the global default (`intervalMinutes` here, editable on
 * the same page, persisted server-side, minimum 1) when unset. Supporting
 * that means the ticker itself runs on a fixed, fine-grained schedule
 * (`TICK_INTERVAL_MS`) and, on every tick, computes — from real
 * timestamps, not a tick count — which URLs are actually due
 * (`now - lastCheckedAt >= effectiveInterval`); only those get checked.
 * This is naturally robust to a throttled/suspended timer (e.g. the app
 * minimized for a while): whenever a tick does fire, it just picks up
 * everything that's overdue, however that happened. A `visibilitychange`
 * listener triggers an extra tick on refocus for the same reason — not to
 * force-check everything, just to reassess due-ness sooner than the next
 * fixed tick would.
 *
 * The check itself is still one per URL (there's only one remote file to
 * ask about) — what's one-to-many is what happens once a change is found:
 * a URL's `reimportConfigs` (each its own template + Período, fixed or
 * relative to today) each independently turn into their own entry in
 * `remoteUpdates`.
 */
const TICK_INTERVAL_MS = 60_000;
const DEFAULT_CHECK_INTERVAL_MINUTES = 5;

function effectiveIntervalMs(t: TrackedPaymentUrl, globalMinutes: number): number {
  return (t.checkIntervalMinutes ?? globalMinutes) * 60_000;
}

interface RemoteFileUpdatesContextValue {
  remoteUpdates: RemoteUpdateFlag[];
  dismissRemoteUpdate: (configId: number) => void;
  setUrlCheckDisabled: (url: string, disabled: boolean) => Promise<void>;
  setUrlIntervalMinutes: (url: string, minutes: number | null) => Promise<void>;
  /** Opts a URL into automatic tracking for the first time — creates its first reimport config from what this save used. */
  trackUrl: (url: string, templateId: number, periodStart: string | null, periodEnd: string | null) => Promise<void>;
  addReimportConfig: (input: ReimportConfigInput) => Promise<void>;
  updateReimportConfig: (id: number, input: Omit<ReimportConfigInput, "sourceUrl" | "templateId">) => Promise<void>;
  deleteReimportConfig: (id: number) => Promise<void>;
  refreshNow: () => void;
  /** Global default (minutes) used by any tracked URL without its own override. */
  intervalMinutes: number;
  setIntervalMinutes: (minutes: number) => Promise<void>;
  /** True while a check cycle is in flight — for a "Verificando..." indicator. */
  checking: boolean;
  /** Every URL explicitly opted into tracking, with its full tracking state — feeds the Verificação automática page. */
  trackedFiles: TrackedPaymentUrl[];
  /** Every reimport config for every tracked URL — feeds the Verificação automática page (filter by `sourceUrl` per file). */
  reimportConfigs: ReimportConfig[];
  /** Soonest due time across active (non-disabled) tracked files, ISO string — for the Sidebar's live countdown. `null` when nothing is tracked. */
  nextCheckAt: string | null;
}

const RemoteFileUpdatesContext = createContext<RemoteFileUpdatesContextValue | null>(null);

export function RemoteFileUpdatesProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [intervalMinutes, setIntervalMinutesState] = useState(DEFAULT_CHECK_INTERVAL_MINUTES);
  const [checking, setChecking] = useState(false);
  const [trackedFiles, setTrackedFiles] = useState<TrackedPaymentUrl[]>([]);
  const [reimportConfigs, setReimportConfigs] = useState<ReimportConfig[]>([]);
  const [nextCheckAt, setNextCheckAt] = useState<string | null>(null);
  const checkingRef = useRef(false);
  // `tick` closes over `intervalMinutes` (for URLs without their own
  // override) — kept in a ref too so a tick already in flight when the
  // global default changes doesn't need to restart to see the new value.
  const intervalMinutesRef = useRef(intervalMinutes);
  intervalMinutesRef.current = intervalMinutes;

  useEffect(() => {
    getRemoteFileCheckIntervalMinutes()
      .then(setIntervalMinutesState)
      .catch(() => {}); // stick with the default rather than block polling on this
  }, []);

  const refreshTrackedState = useCallback(async () => {
    const [refreshedFiles, refreshedConfigs] = await Promise.all([listTrackedPaymentUrls(), listReimportConfigs()]);
    setTrackedFiles(refreshedFiles);
    setReimportConfigs(refreshedConfigs);
    return refreshedFiles;
  }, []);

  const tick = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const tracked = await listTrackedPaymentUrls();
      const globalMinutes = intervalMinutesRef.current;
      const now = Date.now();
      const due = tracked.filter((t) => {
        if (t.checkDisabled) return false;
        if (!t.lastCheckedAt) return true;
        return now - new Date(t.lastCheckedAt).getTime() >= effectiveIntervalMs(t, globalMinutes);
      });

      if (due.length > 0) {
        const results = await Promise.allSettled(
          due.map((t) => checkRemotePaymentFile(t.sourceUrl, t.sourceEtag, t.sourceLastModified, t.sourceContentLength)),
        );
        await Promise.all(
          results.map((res, i) => {
            const t = due[i];
            if (res.status === "fulfilled") {
              const result: UrlCheckResult =
                res.value.changed === true ? "changed" : res.value.changed === false ? "unchanged" : "unknown";
              return logUrlCheckResult(t.sourceUrl, t.fileName, result, null);
            }
            const message = String(res.reason instanceof Error ? res.reason.message : res.reason);
            return logUrlCheckResult(t.sourceUrl, t.fileName, "error", message);
          }),
        );
      }

      // Re-read rather than patch in memory — URLs not due this tick keep
      // exactly what the log already says about them, and the ones just
      // checked come back with their brand new log entry, uniformly.
      const refreshed = await refreshTrackedState();

      const nextTimes = refreshed
        .filter((t) => !t.checkDisabled)
        .map((t) => (t.lastCheckedAt ? new Date(t.lastCheckedAt).getTime() : now) + effectiveIntervalMs(t, globalMinutes));
      setNextCheckAt(nextTimes.length > 0 ? new Date(Math.min(...nextTimes)).toISOString() : null);
    } catch {
      // silent — ambient, same treatment as the app's own update-checker;
      // individual per-URL failures are already captured via logUrlCheckResult.
    } finally {
      setChecking(false);
      checkingRef.current = false;
    }
  }, [refreshTrackedState]);

  useEffect(() => {
    tick();
    const interval = setInterval(tick, TICK_INTERVAL_MS);
    function onVisibilityChange() {
      if (document.visibilityState === "visible") tick();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [tick]);

  function dismissRemoteUpdate(configId: number) {
    setDismissed((prev) => new Set(prev).add(configId));
  }

  async function setUrlCheckDisabled(url: string, disabled: boolean) {
    await setUrlCheckDisabledDb(url, disabled);
    setTrackedFiles((prev) => prev.map((t) => (t.sourceUrl === url ? { ...t, checkDisabled: disabled } : t)));
  }

  async function setUrlIntervalMinutes(url: string, minutes: number | null) {
    await setUrlCheckIntervalMinutesDb(url, minutes);
    setTrackedFiles((prev) => prev.map((t) => (t.sourceUrl === url ? { ...t, checkIntervalMinutes: minutes } : t)));
  }

  async function trackUrl(url: string, templateId: number, periodStart: string | null, periodEnd: string | null) {
    await trackUrlForAutoReimport(url, templateId, periodStart, periodEnd);
    // A fresh entry, not a patch to an existing one — re-fetch rather than
    // try to hand-construct the rest of TrackedPaymentUrl's/ReimportConfig's
    // shape client-side. The next tick (≤1min) fills in nextCheckAt.
    await refreshTrackedState();
  }

  async function addReimportConfig(input: ReimportConfigInput) {
    await createReimportConfigDb(input);
    await refreshTrackedState();
  }

  async function updateReimportConfig(id: number, input: Omit<ReimportConfigInput, "sourceUrl" | "templateId">) {
    await updateReimportConfigDb(id, input);
    setReimportConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, ...input } : c)));
  }

  async function deleteReimportConfig(id: number) {
    await deleteReimportConfigDb(id);
    setReimportConfigs((prev) => prev.filter((c) => c.id !== id));
  }

  async function setIntervalMinutes(minutes: number) {
    const saved = await setRemoteFileCheckIntervalMinutes(minutes);
    setIntervalMinutesState(saved);
  }

  const changedUrls = new Set(
    trackedFiles.filter((t) => !t.checkDisabled && t.lastResult === "changed").map((t) => t.sourceUrl),
  );
  const remoteUpdates: RemoteUpdateFlag[] = reimportConfigs
    .filter((c) => changedUrls.has(c.sourceUrl) && !dismissed.has(c.id))
    .map((c) => {
      const t = trackedFiles.find((f) => f.sourceUrl === c.sourceUrl);
      const { start, end } = resolveReimportPeriod(c);
      return {
        configId: c.id,
        sourceUrl: c.sourceUrl,
        fileName: t?.fileName ?? c.sourceUrl,
        configLabel: resolveReimportConfigLabel(c),
        templateId: c.templateId,
        lastImportedAt: t?.importedAt ?? "",
        resolvedPeriodStart: start,
        resolvedPeriodEnd: end,
      };
    });

  return (
    <RemoteFileUpdatesContext.Provider
      value={{
        remoteUpdates,
        dismissRemoteUpdate,
        setUrlCheckDisabled,
        setUrlIntervalMinutes,
        trackUrl,
        addReimportConfig,
        updateReimportConfig,
        deleteReimportConfig,
        refreshNow: tick,
        intervalMinutes,
        setIntervalMinutes,
        checking,
        trackedFiles,
        reimportConfigs,
        nextCheckAt,
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
