import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkRemotePaymentFile, downloadPaymentFileFromUrl } from "../lib/api";
import {
  createReimportConfig as createReimportConfigDb,
  deleteReimportConfig as deleteReimportConfigDb,
  listReimportConfigs,
  listTrackedPaymentUrls,
  logUrlCheckResult,
  markDeepCheckSignature,
  saveCheckDiffs,
  setConfigCheckDisabled as setConfigCheckDisabledDb,
  trackUrlForAutoReimport,
  untrackPaymentUrl as untrackPaymentUrlDb,
  updateReimportConfig as updateReimportConfigDb,
  type CheckDiffInput,
  type ReimportConfig,
  type ReimportConfigInput,
  type TrackedPaymentUrl,
  type UrlCheckResult,
} from "../lib/db";
import { parseSqliteDateTime, resolveReimportConfigLabel, resolveReimportPeriod } from "../lib/format";
import { computeReimportDiff } from "../lib/remoteCheckDiff";

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
  /** This config's own choice, replayed as-is on an automatic reimport — see `ReimportConfig.keepManualEdits`. */
  keepManualEdits: boolean;
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

/** A `change_kind: 'error'` diff entry not tied to any specific field — used both for a whole-config failure (bad/deleted template, parse error) and a whole-URL one (the download itself failed after every config was already known to want a deep pass). */
function errorDiffEntry(configId: number | null, configLabel: string, message: string): CheckDiffInput {
  return {
    configId,
    configLabel,
    changeKind: "error",
    matchedShiftId: null,
    employeeId: null,
    employeeName: null,
    workDate: null,
    local: null,
    role: null,
    scheduleStartMinutes: null,
    scheduleEndMinutes: null,
    sheetName: null,
    rowNumber: null,
    columnLetter: null,
    fieldName: null,
    oldValue: null,
    newValue: null,
    message,
  };
}

/** Builds one config's `RemoteUpdateFlag` regardless of whether a remote change was actually detected — shared by `remoteUpdates` (filtered to changed + not dismissed) and `getReimportFlag` (used for an unconditional "Reprocessar agora"). */
function buildReimportFlag(config: ReimportConfig, trackedFiles: TrackedPaymentUrl[]): RemoteUpdateFlag {
  const t = trackedFiles.find((f) => f.sourceUrl === config.sourceUrl);
  const { start, end } = resolveReimportPeriod(config);
  return {
    configId: config.id,
    sourceUrl: config.sourceUrl,
    fileName: t?.fileName ?? config.sourceUrl,
    configLabel: resolveReimportConfigLabel(config),
    templateId: config.templateId,
    lastImportedAt: t?.importedAt ?? "",
    resolvedPeriodStart: start,
    resolvedPeriodEnd: end,
    keepManualEdits: config.keepManualEdits,
  };
}

interface RemoteFileUpdatesContextValue {
  remoteUpdates: RemoteUpdateFlag[];
  dismissRemoteUpdate: (configId: number) => void;
  /** Opts a URL into automatic tracking for the first time — creates its first reimport config from what this save used. */
  trackUrl: (
    url: string,
    templateId: number,
    periodStart: string | null,
    periodEnd: string | null,
    keepManualEdits: boolean,
  ) => Promise<void>;
  addReimportConfig: (input: ReimportConfigInput) => Promise<void>;
  updateReimportConfig: (id: number, input: Omit<ReimportConfigInput, "sourceUrl" | "templateId">) => Promise<void>;
  setConfigCheckDisabled: (id: number, disabled: boolean) => Promise<void>;
  deleteReimportConfig: (id: number) => Promise<void>;
  /** Fully stops tracking a URL — its settings, every reimport config, and its whole check-log history. Already-imported payment_shifts are untouched. */
  untrackUrl: (sourceUrl: string) => Promise<void>;
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
  /** Builds a config's reimport flag on demand, regardless of whether a change was ever detected — the "Reprocessar agora" button's whole point. `null` if the config was deleted. */
  getReimportFlag: (configId: number) => RemoteUpdateFlag | null;
  /**
   * Set when a tick's own bookkeeping (reading `trackedFiles`/`reimportConfigs`
   * before deciding what's due) throws — distinct from a per-URL check
   * failure, which is always captured via `logUrlCheckResult` regardless.
   * Surfaced so this kind of failure isn't silently dropped just because it
   * has no specific URL to attach a history entry to.
   */
  tickError: string | null;
}

const RemoteFileUpdatesContext = createContext<RemoteFileUpdatesContextValue | null>(null);

export function RemoteFileUpdatesProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [tickError, setTickError] = useState<string | null>(null);
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
   *
   * For each URL: (1) the cheap header check, always. This ONLY decides
   * whether to look closer — on its own it's noisy (a host can hand out a
   * new ETag without any content that matters actually changing), so it
   * never gets logged as the check's `result` by itself. (2) When the
   * header says "changed" and the remote signature differs from the one
   * the last deep check already ran against (`TrackedPaymentUrl.lastDeepCheck*`
   * — NOT `sourceEtag`/etc., which only update on an actual saved
   * reimport), download the file once and run every active `ReimportConfig`
   * for that URL through `computeReimportDiff` (never writing to
   * payment_shifts — see `remoteCheckDiff.ts`). What THAT finds is what gets
   * logged: 'changed' only if a real field/new-shift diff turned up,
   * 'unchanged' if it ran clean and found nothing, 'error' if it couldn't
   * finish. (3) A later check against that SAME signature reuses this
   * verdict (`lastDeepCheckResult`) instead of re-downloading just to log
   * the same thing again — this is what stops an unreimported "changed"
   * file from being re-parsed every tick indefinitely, and what stops a
   * confirmed-empty diff from being reported as "Mudou" forever. Each URL
   * leaves `checkingUrls` as soon as ITS OWN work (header + any deep pass)
   * finishes, not when the whole batch does — a slow deep pass on one URL
   * shouldn't keep an unrelated fast URL showing "Verificando...".
   */
  const runChecks = useCallback(
    async (targets: TrackedPaymentUrl[]) => {
      const fresh = targets.filter((t) => !checkingUrlsRef.current.has(t.sourceUrl));
      if (fresh.length === 0) return;
      fresh.forEach((t) => checkingUrlsRef.current.add(t.sourceUrl));
      setCheckingUrlsState(new Set(checkingUrlsRef.current));

      // Read fresh regardless of what's in React state — this runs from
      // `tick` (schedule), `forceCheckUrl`/`forceCheckAll` (manual), any of
      // which may be working off a stale `reimportConfigs` snapshot.
      const activeConfigsByUrl = new Map<string, ReimportConfig[]>();
      try {
        for (const c of await listReimportConfigs()) {
          if (c.checkDisabled) continue;
          const list = activeConfigsByUrl.get(c.sourceUrl) ?? [];
          list.push(c);
          activeConfigsByUrl.set(c.sourceUrl, list);
        }
      } catch {
        // A failure here just means no URL gets a deep pass this round —
        // the header checks below still run and still get logged.
      }

      async function runOne(t: TrackedPaymentUrl) {
        try {
          let headerResult: UrlCheckResult;
          let current: { etag: string | null; lastModified: string | null; contentLength: number | null };
          try {
            const check = await checkRemotePaymentFile(
              t.sourceUrl,
              t.sourceEtag,
              t.sourceLastModified,
              t.sourceContentLength,
            );
            headerResult = check.changed === true ? "changed" : check.changed === false ? "unchanged" : "unknown";
            current = check.current;
          } catch (e) {
            const message = String(e instanceof Error ? e.message : e);
            await logUrlCheckResult(t.sourceUrl, t.fileName, "error", message);
            return;
          }

          if (headerResult !== "changed") {
            // Nothing to look closer at — the header itself is the whole
            // story here.
            await logUrlCheckResult(t.sourceUrl, t.fileName, headerResult, null);
            return;
          }

          const configs = activeConfigsByUrl.get(t.sourceUrl) ?? [];
          if (configs.length === 0) {
            // No reimport config to diff against — nothing to verify
            // deeper, so the header's own word is all there is to log.
            await logUrlCheckResult(t.sourceUrl, t.fileName, "changed", null);
            return;
          }

          const signatureChanged =
            current.etag !== t.lastDeepCheckEtag ||
            current.lastModified !== t.lastDeepCheckLastModified ||
            current.contentLength !== t.lastDeepCheckContentLength;

          if (!signatureChanged) {
            // Already deep-checked this exact remote version — reuse that
            // verdict instead of re-downloading/re-parsing for nothing.
            await logUrlCheckResult(t.sourceUrl, t.fileName, t.lastDeepCheckResult ?? "changed", null);
            return;
          }

          const entries: CheckDiffInput[] = [];
          let wholeUrlErrorMessage: string | null = null;
          let downloadSucceeded = false;
          try {
            const downloaded = await downloadPaymentFileFromUrl(t.sourceUrl);
            downloadSucceeded = true;
            for (const config of configs) {
              try {
                entries.push(...(await computeReimportDiff(config, downloaded.path)));
              } catch (e) {
                entries.push(
                  errorDiffEntry(
                    config.id,
                    resolveReimportConfigLabel(config),
                    String(e instanceof Error ? e.message : e),
                  ),
                );
              }
            }
          } catch (e) {
            wholeUrlErrorMessage = String(e instanceof Error ? e.message : e);
          }

          const hasRealChange = entries.some((e) => e.changeKind !== "error");
          const hasConfigErrors = entries.some((e) => e.changeKind === "error");
          const effectiveResult: UrlCheckResult = wholeUrlErrorMessage
            ? "error"
            : hasRealChange
              ? "changed"
              : hasConfigErrors
                ? "error"
                : "unchanged";

          const checkLogId = await logUrlCheckResult(t.sourceUrl, t.fileName, effectiveResult, wholeUrlErrorMessage);
          await saveCheckDiffs(checkLogId, entries);
          // A failed DOWNLOAD isn't cached as "checked" — a transient
          // network blip should be retried next tick, not stuck showing
          // 'error' forever until the header changes again. A per-config
          // failure (bad template) is real and persistent, so that case
          // still gets cached the same as a clean result.
          if (downloadSucceeded) {
            await markDeepCheckSignature(t.sourceUrl, current.etag, current.lastModified, current.contentLength, effectiveResult);
          }
        } finally {
          checkingUrlsRef.current.delete(t.sourceUrl);
          setCheckingUrlsState(new Set(checkingUrlsRef.current));
        }
      }

      try {
        await Promise.allSettled(fresh.map(runOne));
      } finally {
        // Re-read rather than patch in memory — the checked URLs come back
        // with their brand new log entry (and deep-check signature),
        // uniformly with everything else.
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
      setTickError(null);
    } catch (e) {
      // Unlike a per-URL check failure (always captured via
      // logUrlCheckResult, tied to that URL's own row/history), a failure
      // here has no specific URL to attach a history entry to — this is the
      // only place that kind of failure is visible at all, so it's kept
      // (not discarded) for the Sidebar/Verificação automática page to
      // surface.
      setTickError(String(e instanceof Error ? e.message : e));
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

  async function trackUrl(
    url: string,
    templateId: number,
    periodStart: string | null,
    periodEnd: string | null,
    keepManualEdits: boolean,
  ) {
    await trackUrlForAutoReimport(url, templateId, periodStart, periodEnd, keepManualEdits);
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

  async function untrackUrl(sourceUrl: string) {
    await untrackPaymentUrlDb(sourceUrl);
    await refreshTrackedState();
  }

  const changedUrls = new Set(trackedFiles.filter((t) => t.lastResult === "changed").map((t) => t.sourceUrl));
  const remoteUpdates: RemoteUpdateFlag[] = reimportConfigs
    .filter((c) => !c.checkDisabled && changedUrls.has(c.sourceUrl) && !dismissed.has(c.id))
    .map((c) => buildReimportFlag(c, trackedFiles));

  /** Builds a config's reimport flag on demand, regardless of whether a change was ever detected — the "Reprocessar agora" button's whole point, unlike `remoteUpdates` which only ever holds configs with a pending detected change. `null` if the config no longer exists (deleted between the button rendering and being clicked). */
  function getReimportFlag(configId: number): RemoteUpdateFlag | null {
    const config = reimportConfigs.find((c) => c.id === configId);
    return config ? buildReimportFlag(config, trackedFiles) : null;
  }

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
        untrackUrl,
        refreshNow: tick,
        checking: checkingUrls.size > 0,
        checkingUrls,
        forceCheckUrl,
        forceCheckAll,
        trackedFiles,
        reimportConfigs,
        getReimportFlag,
        tickError,
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
