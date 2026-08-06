import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkRemotePaymentFile } from "../lib/api";
import {
  createReimportConfig as createReimportConfigDb,
  deleteReimportConfig as deleteReimportConfigDb,
  listReimportConfigs,
  listTrackedPaymentUrls,
  logUrlCheckResult,
  setConfigCheckDisabled as setConfigCheckDisabledDb,
  trackUrlForAutoReimport,
  updateReimportConfig as updateReimportConfigDb,
  type ReimportConfig,
  type ReimportConfigInput,
  type TrackedPaymentUrl,
  type UrlCheckResult,
} from "../lib/db";
import { parseSqliteDateTime, resolveReimportConfigLabel, resolveReimportPeriod } from "../lib/format";

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
 * Each reimport config has its own mandatory check interval and its own
 * on/off switch (`ReimportConfig.checkIntervalMinutes`/`checkDisabled`,
 * editable on the Verificação automática page) — there's no global default
 * to fall back to. The actual HTTP check, though, is still made once per
 * URL — there's only one remote file to ask about, however many configs
 * are watching it — so every tick: (1) figure out which URLs have at least
 * one non-disabled, due config; (2) check each of those URLs exactly once;
 * (3) a "changed" result then applies to every non-disabled config for
 * that URL, not just the one(s) that happened to trigger the check. This
 * is naturally robust to a throttled/suspended timer (e.g. the app
 * minimized for a while): due-ness is computed from real timestamps every
 * tick, not a tick count, so a late tick just picks up everything overdue
 * however that happened. A `visibilitychange` listener triggers an extra
 * tick on refocus for the same reason.
 */
const TICK_INTERVAL_MS = 60_000;

function isConfigDue(config: ReimportConfig, urlLastCheckedAt: string | null | undefined, now: number): boolean {
  if (config.checkDisabled) return false;
  if (!urlLastCheckedAt) return true;
  const effectiveMs = config.checkIntervalMinutes * 60_000;
  return now - parseSqliteDateTime(urlLastCheckedAt).getTime() >= effectiveMs;
}

interface RemoteFileUpdatesContextValue {
  remoteUpdates: RemoteUpdateFlag[];
  dismissRemoteUpdate: (configId: number) => void;
  /** Opts a URL into automatic tracking for the first time — creates its first reimport config from what this save used. */
  trackUrl: (url: string, templateId: number, periodStart: string | null, periodEnd: string | null) => Promise<void>;
  addReimportConfig: (input: ReimportConfigInput) => Promise<void>;
  updateReimportConfig: (id: number, input: Omit<ReimportConfigInput, "sourceUrl" | "templateId">) => Promise<void>;
  setConfigCheckDisabled: (id: number, disabled: boolean) => Promise<void>;
  deleteReimportConfig: (id: number) => Promise<void>;
  refreshNow: () => void;
  /** True while at least one URL check is in flight — for a "Verificando..." indicator. */
  checking: boolean;
  /** URLs with an HTTP check actually in flight right now (not just "due") — the precise "em progresso" state, per URL, for the Verificação automática page's per-config rows. */
  checkingUrls: Set<string>;
  /** Forces an immediate check of one URL, bypassing every config's schedule — the per-config "Forçar verificação" button. A no-op if that URL is already being checked. */
  forceCheckUrl: (sourceUrl: string) => Promise<void>;
  /** Forces an immediate check of every tracked URL, bypassing schedules — the global "Forçar verificação de todas" button. */
  forceCheckAll: () => Promise<void>;
  /** Every URL explicitly opted into tracking, with its shared check state — feeds the Verificação automática page. */
  trackedFiles: TrackedPaymentUrl[];
  /** Every reimport config for every tracked URL — feeds the Verificação automática page (filter by `sourceUrl` per file) and the Sidebar's status indicator. */
  reimportConfigs: ReimportConfig[];
}

const RemoteFileUpdatesContext = createContext<RemoteFileUpdatesContextValue | null>(null);

export function RemoteFileUpdatesProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [trackedFiles, setTrackedFiles] = useState<TrackedPaymentUrl[]>([]);
  const [reimportConfigs, setReimportConfigs] = useState<ReimportConfig[]>([]);
  // URLs with an HTTP check actually in flight — a Set (not one global
  // boolean) so a forced check of a single URL and the regular scheduled
  // tick can report precise per-URL "em progresso" state instead of a
  // page-wide flag that's ambiguous about which file it refers to. Kept in
  // a ref too, so overlapping calls (a force-click landing mid-tick) can
  // see what's already in flight without waiting on a state update.
  const [checkingUrls, setCheckingUrlsState] = useState<Set<string>>(new Set());
  const checkingUrlsRef = useRef<Set<string>>(new Set());

  const refreshTrackedState = useCallback(async () => {
    const [refreshedFiles, refreshedConfigs] = await Promise.all([listTrackedPaymentUrls(), listReimportConfigs()]);
    setTrackedFiles(refreshedFiles);
    setReimportConfigs(refreshedConfigs);
    return { files: refreshedFiles, configs: refreshedConfigs };
  }, []);

  /**
   * Checks exactly the URLs in `targets`, unconditionally — due-ness is
   * decided by the caller (`tick` for the schedule, `forceCheckUrl`/
   * `forceCheckAll` for a manual override). Skips any URL already being
   * checked (via `checkingUrlsRef`, read synchronously so two overlapping
   * calls — e.g. a force-click landing mid-tick — never double-check the
   * same URL), so it's safe to call from more than one place at once.
   */
  const runChecks = useCallback(
    async (targets: TrackedPaymentUrl[]) => {
      const fresh = targets.filter((t) => !checkingUrlsRef.current.has(t.sourceUrl));
      if (fresh.length === 0) return;
      fresh.forEach((t) => checkingUrlsRef.current.add(t.sourceUrl));
      setCheckingUrlsState(new Set(checkingUrlsRef.current));
      try {
        const results = await Promise.allSettled(
          fresh.map((t) => checkRemotePaymentFile(t.sourceUrl, t.sourceEtag, t.sourceLastModified, t.sourceContentLength)),
        );
        await Promise.all(
          results.map((res, i) => {
            const t = fresh[i];
            if (res.status === "fulfilled") {
              const result: UrlCheckResult =
                res.value.changed === true ? "changed" : res.value.changed === false ? "unchanged" : "unknown";
              return logUrlCheckResult(t.sourceUrl, t.fileName, result, null);
            }
            const message = String(res.reason instanceof Error ? res.reason.message : res.reason);
            return logUrlCheckResult(t.sourceUrl, t.fileName, "error", message);
          }),
        );
      } finally {
        fresh.forEach((t) => checkingUrlsRef.current.delete(t.sourceUrl));
        setCheckingUrlsState(new Set(checkingUrlsRef.current));
        // Re-read rather than patch in memory — the checked URLs come back
        // with their brand new log entry, uniformly with everything else.
        await refreshTrackedState();
      }
    },
    [refreshTrackedState],
  );

  const tick = useCallback(async () => {
    try {
      const [tracked, configs] = await Promise.all([listTrackedPaymentUrls(), listReimportConfigs()]);
      const now = Date.now();
      const lastCheckedByUrl = new Map(tracked.map((t) => [t.sourceUrl, t.lastCheckedAt]));
      // Keep the rest of the app current even on a tick that finds nothing
      // due — cheap, since `tracked`/`configs` were just fetched anyway.
      setTrackedFiles(tracked);
      setReimportConfigs(configs);

      const dueUrls = new Set(
        configs.filter((c) => isConfigDue(c, lastCheckedByUrl.get(c.sourceUrl), now)).map((c) => c.sourceUrl),
      );
      const dueTracked = tracked.filter((t) => dueUrls.has(t.sourceUrl));
      if (dueTracked.length > 0) await runChecks(dueTracked);
    } catch {
      // silent — ambient, same treatment as the app's own update-checker;
      // individual per-URL failures are already captured via logUrlCheckResult.
    }
  }, [runChecks]);

  const forceCheckUrl = useCallback(
    async (sourceUrl: string) => {
      const target = trackedFiles.find((t) => t.sourceUrl === sourceUrl);
      if (!target) return;
      await runChecks([target]);
    },
    [trackedFiles, runChecks],
  );

  const forceCheckAll = useCallback(async () => {
    await runChecks(trackedFiles);
  }, [trackedFiles, runChecks]);

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

  async function trackUrl(url: string, templateId: number, periodStart: string | null, periodEnd: string | null) {
    await trackUrlForAutoReimport(url, templateId, periodStart, periodEnd);
    // A fresh entry, not a patch to an existing one — re-fetch rather than
    // try to hand-construct the rest of TrackedPaymentUrl's/ReimportConfig's
    // shape client-side.
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

  async function setConfigCheckDisabled(id: number, disabled: boolean) {
    await setConfigCheckDisabledDb(id, disabled);
    setReimportConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, checkDisabled: disabled } : c)));
  }

  async function deleteReimportConfig(id: number) {
    await deleteReimportConfigDb(id);
    setReimportConfigs((prev) => prev.filter((c) => c.id !== id));
  }

  const changedUrls = new Set(trackedFiles.filter((t) => t.lastResult === "changed").map((t) => t.sourceUrl));
  const remoteUpdates: RemoteUpdateFlag[] = reimportConfigs
    .filter((c) => !c.checkDisabled && changedUrls.has(c.sourceUrl) && !dismissed.has(c.id))
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
        trackUrl,
        addReimportConfig,
        updateReimportConfig,
        setConfigCheckDisabled,
        deleteReimportConfig,
        refreshNow: tick,
        checking: checkingUrls.size > 0,
        checkingUrls,
        forceCheckUrl,
        forceCheckAll,
        trackedFiles,
        reimportConfigs,
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
