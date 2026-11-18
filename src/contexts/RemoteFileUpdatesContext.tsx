import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  createReimportConfig as createReimportConfigDb,
  deleteReimportConfig as deleteReimportConfigDb,
  listReimportConfigs,
  listTrackedPaymentUrls,
  setConfigCheckDisabled as setConfigCheckDisabledDb,
  trackUrlForAutoReimport,
  untrackPaymentUrl as untrackPaymentUrlDb,
  updateReimportConfig as updateReimportConfigDb,
  type ReimportConfig,
  type ReimportConfigInput,
  type TrackedPaymentUrl,
} from "../lib/db";
import { rpc } from "../lib/http";
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
  /** This config's own choice, replayed as-is on an automatic reimport — see `ReimportConfig.keepManualEdits`. */
  keepManualEdits: boolean;
}

/**
 * The automatic check runs on the server (server/src/remote_checks): one
 * background task for the whole team, every minute, whether or not anyone
 * has the app open. Each reimport config still has its own interval and
 * on/off switch; the server decides what is due exactly as the desktop app
 * did.
 *
 * This provider only follows it: it reads the tracked URLs, their configs
 * and which configs are being checked right now, and asks the server for a
 * check on demand ("Conferir agora"). It polls quickly while a check is in
 * flight, so "Conferindo agora…" clears as soon as the server is done, and
 * slowly otherwise; coming back to the tab refreshes right away.
 */
const IDLE_POLL_MS = 30_000;
const BUSY_POLL_MS = 3_000;

interface RemoteCheckStatus {
  checkingConfigIds: number[];
  tickError: string | null;
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
  /** Re-reads the tracked files, configs and check status from the server. */
  refreshNow: () => void;
  /** True while at least one reimport config's check is in flight — for a "Verificando..." indicator. */
  checking: boolean;
  /** Reimport configs with a check actually in flight right now (not just "due") — the precise "em progresso" state, per CONFIG (not per URL — see the module comment on why each config's schedule is independent even when it shares a URL with siblings), for the Verificação automática page's per-config rows. */
  checkingConfigIds: Set<number>;
  /** Forces an immediate check of one reimport config, bypassing its own schedule — the per-config "Forçar verificação" button. Never touches a sibling config sharing the same `sourceUrl`. A no-op if that config is already being checked or no longer exists. */
  forceCheckConfig: (configId: number) => Promise<void>;
  /** Forces an immediate check of every tracked URL and every one of its non-disabled configs, bypassing schedules — the global "Forçar verificação de todas" button. */
  forceCheckAll: () => Promise<void>;
  /** Every URL explicitly opted into tracking, with its shared check state — feeds the Verificação automática page. */
  trackedFiles: TrackedPaymentUrl[];
  /** Every reimport config for every tracked URL — feeds the Verificação automática page (filter by `sourceUrl` per file) and the Sidebar's status indicator. */
  reimportConfigs: ReimportConfig[];
  /** Builds a config's reimport flag on demand, regardless of whether a change was ever detected — the "Reprocessar agora" button's whole point. `null` if the config was deleted. */
  getReimportFlag: (configId: number) => RemoteUpdateFlag | null;
  /**
   * Set when the server's last scheduled tick failed before reaching any URL
   * (a per-URL failure always lands in that URL's own history instead), or
   * when the server itself can't be reached. Surfaced so this kind of
   * failure isn't silently dropped just because it has no specific URL to
   * attach a history entry to.
   */
  tickError: string | null;
}

const RemoteFileUpdatesContext = createContext<RemoteFileUpdatesContextValue | null>(null);

export function RemoteFileUpdatesProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [tickError, setTickError] = useState<string | null>(null);
  const [trackedFiles, setTrackedFiles] = useState<TrackedPaymentUrl[]>([]);
  const [reimportConfigs, setReimportConfigs] = useState<ReimportConfig[]>([]);
  // Configs the server reports as being checked (by the schedule, or by
  // anyone's "Conferir agora"), plus the ones THIS tab asked for and is still
  // waiting on — so the button reacts at once, before the next status poll.
  const [serverChecking, setServerChecking] = useState<Set<number>>(new Set());
  const [forcing, setForcing] = useState<Set<number>>(new Set());
  const busyRef = useRef(false);

  const refreshTrackedState = useCallback(async () => {
    try {
      const [files, configs, status] = await Promise.all([
        listTrackedPaymentUrls(),
        listReimportConfigs(),
        rpc<RemoteCheckStatus>("getRemoteCheckStatus"),
      ]);
      setTrackedFiles(files);
      setReimportConfigs(configs);
      setServerChecking(new Set(status.checkingConfigIds));
      setTickError(status.tickError);
      busyRef.current = status.checkingConfigIds.length > 0;
    } catch (e) {
      setTickError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await refreshTrackedState();
      if (!cancelled) timer = setTimeout(poll, busyRef.current ? BUSY_POLL_MS : IDLE_POLL_MS);
    }
    poll();
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refreshTrackedState();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshTrackedState]);

  /** Runs a server-side check and waits for it, showing `ids` as in progress meanwhile. */
  const runForced = useCallback(
    async (ids: number[], request: () => Promise<void>) => {
      setForcing((prev) => new Set([...prev, ...ids]));
      try {
        await request();
      } finally {
        setForcing((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        await refreshTrackedState();
      }
    },
    [refreshTrackedState],
  );

  /** Forces an immediate check of one config on the server; never touches a sibling config sharing the URL. */
  const forceCheckConfig = useCallback(
    (configId: number) => runForced([configId], () => rpc<void>("forceCheckConfig", { configId })),
    [runForced],
  );

  const forceCheckAll = useCallback(
    () =>
      runForced(
        reimportConfigs.filter((c) => !c.checkDisabled).map((c) => c.id),
        () => rpc<void>("forceCheckAll"),
      ),
    [runForced, reimportConfigs],
  );

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

  const checkingConfigIds = new Set([...serverChecking, ...forcing]);

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
        refreshNow: refreshTrackedState,
        checking: checkingConfigIds.size > 0,
        checkingConfigIds,
        forceCheckConfig,
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
