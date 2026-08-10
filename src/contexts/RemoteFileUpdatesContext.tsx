import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkRemotePaymentFile, deletePaths, downloadPaymentFileFromUrl, hashPaymentFile, setTrayStatus } from "../lib/api";
import {
  copyCheckDiffs,
  createReimportConfig as createReimportConfigDb,
  deleteReimportConfig as deleteReimportConfigDb,
  listCheckLogConfigIds,
  listReimportConfigs,
  listTrackedPaymentUrls,
  logSourceFile,
  logUrlCheckResult,
  markDeepCheckSignature,
  markSourceFileSaved,
  saveCheckDiffs,
  setConfigCheckDisabled as setConfigCheckDisabledDb,
  trackUrlForAutoReimport,
  untrackPaymentUrl as untrackPaymentUrlDb,
  updateReimportConfig as updateReimportConfigDb,
  type CheckDiffInput,
  type EvaluatedConfigSnapshot,
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
 * Each reimport config has its own mandatory check interval, its own on/off
 * switch (`ReimportConfig.checkIntervalMinutes`/`checkDisabled`, editable on
 * the Verificação automática page), and — crucially — its own independent
 * schedule: due-ness is computed from `ReimportConfig.lastCheckedAt` (when
 * THIS config was last actually evaluated, via
 * `source_url_check_log_configs`), never from a shared per-URL timestamp. A
 * URL with several configs on different intervals only gets its HTTP check
 * made when at least one of them is due, and that check only ever evaluates
 * the config(s) that are actually due right then — a slow config never gets
 * silently re-evaluated just because a fast sibling sharing the same URL
 * came due (see `runChecks`). This is naturally robust to a
 * throttled/suspended timer (e.g. the app minimized for a while): due-ness
 * is computed from real timestamps every tick, not a tick count, so a late
 * tick just picks up everything overdue however that happened. A
 * `visibilitychange` listener triggers an extra tick on refocus for the same
 * reason.
 */
const TICK_INTERVAL_MS = 60_000;

// Asked once per app session (not once per tick) — `isPermissionGranted`/
// `requestPermission` are themselves cheap, but there's no reason to pester
// the OS every minute once the user has answered (or not) the very first
// time. A denial just means `notifyFileChanged` below silently no-ops
// forever after (`isPermissionGranted` keeps returning false) — never
// re-prompted, same as any other OS permission.
let notificationPermissionRequested = false;

async function ensureNotificationPermission() {
  if (notificationPermissionRequested) return;
  notificationPermissionRequested = true;
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // Best-effort — worst case, notifications just never fire.
  }
}

/**
 * Fires an OS notification for a freshly CONFIRMED real change (called only
 * from the fresh-deep-pass branch of `runOne`, never the cached-signature
 * replay — that would otherwise re-notify every tick for as long as a
 * change sits unaddressed). Skipped while the window is focused — if the
 * user is already looking at the app, the in-app "Mudou" badge (Sidebar/
 * Verificação automática) is enough; the OS notification is for when
 * they're not (minimized, in the tray, or on another app — see "Minimizar
 * na bandeja ao fechar" in Configurações, which is what keeps this tick
 * loop running at all once the window is hidden).
 */
async function notifyFileChanged(fileName: string) {
  try {
    if (!(await isPermissionGranted())) return;
    if (await getCurrentWindow().isFocused()) return;
    await sendNotification({
      title: "PontoScan",
      body: `${fileName} mudou desde a última verificação.`,
    });
  } catch {
    // Best-effort — a failed OS notification shouldn't affect the check itself.
  }
}

/**
 * Same three host patterns `normalize_office_share_url` (`commands.rs`)
 * special-cases for OneDrive/SharePoint's cookie-based anonymous-share-link
 * redemption. A plain HEAD (`check_remote_payment_file`) doesn't reliably
 * walk that same redemption chain a real download's GET does — in practice
 * its ETag/Last-Modified/Content-Length routinely stay identical across an
 * actual content change on these hosts, which silently starves BOTH the
 * cheap "did the header change" verdict AND the deep-check signature cache
 * below (`t.lastDeepCheck*`) — a real edit on OneDrive can sit reported as
 * "Sem mudança" forever, only ever caught by "Reprocessar agora" (which
 * always does a real GET). For these hosts specifically, neither shortcut
 * is trusted: every due check just always runs the real download+diff.
 */
function isUnreliableHeaderHost(sourceUrl: string): boolean {
  let host: string;
  try {
    host = new URL(sourceUrl).hostname;
  } catch {
    return false;
  }
  return host === "1drv.ms" || host === "onedrive.live.com" || host.endsWith(".sharepoint.com");
}

function isConfigDue(config: ReimportConfig, now: number): boolean {
  if (config.checkDisabled) return false;
  if (!config.lastCheckedAt) return true;
  const effectiveMs = config.checkIntervalMinutes * 60_000;
  return now - parseSqliteDateTime(config.lastCheckedAt).getTime() >= effectiveMs;
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
    applied: false,
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

/** What `logUrlCheckResult` snapshots for a config it evaluated — template/período resolved NOW, at evaluation time, so a later edit or delete of the config never rewrites what a past check actually used. */
function toEvaluatedConfigSnapshot(config: ReimportConfig): EvaluatedConfigSnapshot {
  const { start, end } = resolveReimportPeriod(config);
  return {
    id: config.id,
    templateId: config.templateId,
    templateName: config.templateName,
    periodStart: start,
    periodEnd: end,
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
  // Reimport configs with a check actually in flight — a Set (not one
  // global boolean) so a forced check of a single config and the regular
  // scheduled tick can report precise per-CONFIG "em progresso" state
  // instead of a page-wide flag, or a per-URL one that would wrongly light
  // up a sibling config sharing the same URL but not actually being
  // evaluated right now (see the module comment on independent per-config
  // scheduling). Kept in a ref too, so overlapping calls (a force-click
  // landing mid-tick) can see what's already in flight without waiting on a
  // state update.
  const [checkingConfigIds, setCheckingConfigIdsState] = useState<Set<number>>(new Set());
  const checkingConfigIdsRef = useRef<Set<number>>(new Set());

  const refreshTrackedState = useCallback(async () => {
    const [refreshedFiles, refreshedConfigs] = await Promise.all([listTrackedPaymentUrls(), listReimportConfigs()]);
    setTrackedFiles(refreshedFiles);
    setReimportConfigs(refreshedConfigs);
    return { files: refreshedFiles, configs: refreshedConfigs };
  }, []);

  /**
   * Runs exactly the work handed in — each item a tracked URL plus the
   * SPECIFIC reimport configs to evaluate on it this round (never "every
   * config that URL has": due-ness is decided per config by the caller —
   * `tick` for the schedule, `forceCheckConfig`/`forceCheckAll` for a manual
   * override — precisely so a config with a long interval never gets
   * silently re-evaluated just because a faster sibling sharing the same
   * URL came due). A config already mid-check (via `checkingConfigIdsRef`,
   * read synchronously so two overlapping calls — e.g. a force-click
   * landing mid-tick — never double-check the same config) is dropped from
   * whichever item lists it; an item left with zero configs after that is
   * skipped UNLESS it had none to begin with (a tracked URL with no reimport
   * config yet, only reachable via `forceCheckAll` — still worth a header
   * check on its own).
   *
   * For each URL: (1) the cheap header check, always. This ONLY decides
   * whether to look closer — on its own it's noisy (a host can hand out a
   * new ETag without any content that matters actually changing), so it
   * never gets logged as the check's `result` by itself. (2) When the
   * header says "changed" and the remote signature differs from the one the
   * last deep check already ran against (`TrackedPaymentUrl.lastDeepCheck*`
   * — NOT `sourceEtag`/etc., which only update on an actual saved
   * reimport), download the file once and run every config THIS run was
   * given for that URL through `computeReimportDiff` — read-only UNLESS
   * that config has `autoApplyEnabled` ("Atualizar registros
   * automaticamente"), in which case it writes the change straight to
   * `payment_shifts` too (see `remoteCheckDiff.ts`'s `AutoApplyOptions`).
   * What THAT finds is what gets logged as this check's `result`: 'changed'
   * only if a real field/new-shift diff turned up, 'unchanged' if it ran
   * clean and found nothing, 'error' if it couldn't finish. Every config
   * this run evaluated (whichever branch handled it) is recorded via
   * `logUrlCheckResult`'s `evaluatedConfigIds` — that's what makes each
   * config's own due-ness and "Histórico recente" independent of its
   * siblings. (3) A later check against that SAME signature skips the
   * download/parse (avoids doing real work for nothing) but ONLY when every
   * config this run needs was already covered by that cached deep check
   * (`listCheckLogConfigIds`) — otherwise a config new to this signature
   * (e.g. it just became due for the first time since the file last
   * changed) would wrongly inherit a verdict that never actually considered
   * it. When it applies, it still gets a full, real check-log row: it
   * reuses the verdict AND copies that run's diff rows onto its own
   * check_log_id (`copyCheckDiffs`) — so "Detalhes" never goes blank just
   * because the expensive part was skipped, and a still-unaddressed "Mudou"
   * keeps showing its own diff on every single check until the file is
   * actually reimported (or the change dismissed — see
   * `dismissRemoteUpdate`). Each config leaves `checkingConfigIds` as soon
   * as ITS OWN URL's work (header + any deep pass) finishes, not when the
   * whole batch does — a slow deep pass on one URL shouldn't keep an
   * unrelated fast config showing "Verificando...".
   *
   * Exception to both (2) and (3) above: `isUnreliableHeaderHost` (OneDrive/
   * SharePoint) — for those, a "changed" verdict is never trusted to mean
   * "changed" AND an "unchanged"/matching-signature verdict is never trusted
   * to mean "unchanged" either, so every due check for one of these URLs
   * always runs the real download+diff, same as "Reprocessar agora".
   */
  const runChecks = useCallback(
    async (work: { t: TrackedPaymentUrl; configs: ReimportConfig[] }[]) => {
      const fresh = work
        .map(({ t, configs }) => ({
          t,
          configs: configs.filter((c) => !checkingConfigIdsRef.current.has(c.id)),
          hadConfigs: configs.length > 0,
        }))
        .filter((w) => w.configs.length > 0 || !w.hadConfigs);
      if (fresh.length === 0) return;
      fresh.forEach(({ configs }) => configs.forEach((c) => checkingConfigIdsRef.current.add(c.id)));
      setCheckingConfigIdsState(new Set(checkingConfigIdsRef.current));

      async function runOne(t: TrackedPaymentUrl, configs: ReimportConfig[]) {
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
            const checkLogId = await logUrlCheckResult(
              t.sourceUrl,
              t.fileName,
              "error",
              message,
              configs.map(toEvaluatedConfigSnapshot),
            );
            // A real diff row (not just `source_url_check_log.message`) so
            // this whole-URL failure surfaces in the global pending-updates
            // banner too, not only on the Verificação automática page.
            await saveCheckDiffs(checkLogId, [errorDiffEntry(null, t.fileName, message)]);
            return;
          }

          // OneDrive/SharePoint's HEAD response can't be trusted to reflect
          // a real content change (see `isUnreliableHeaderHost`) — for those
          // hosts, "unchanged" from the header isn't taken at its word.
          const unreliableHeader = isUnreliableHeaderHost(t.sourceUrl);

          if (headerResult !== "changed" && !unreliableHeader) {
            // Nothing to look closer at — the header itself is the whole
            // story here.
            await logUrlCheckResult(t.sourceUrl, t.fileName, headerResult, null, configs.map(toEvaluatedConfigSnapshot));
            return;
          }

          if (configs.length === 0) {
            // No reimport config to diff against — nothing to verify
            // deeper, so the header's own word is all there is to log
            // (whatever it actually was — forcing "changed" here would be
            // asserting something no check actually confirmed).
            await logUrlCheckResult(t.sourceUrl, t.fileName, headerResult, null, []);
            return;
          }

          // Same distrust extends to the deep-check signature cache below —
          // it's built from this same unreliable HEAD data, so a host that
          // can't be trusted to report "changed" can't be trusted to report
          // "matches what I last deep-checked" either. Every due check for
          // these hosts runs the real download+diff, same as "Reprocessar
          // agora" already does.
          const signatureChanged =
            unreliableHeader ||
            current.etag !== t.lastDeepCheckEtag ||
            current.lastModified !== t.lastDeepCheckLastModified ||
            current.contentLength !== t.lastDeepCheckContentLength;

          // Reuse the cached verdict only when there's a real one to reuse
          // (a signature recorded before this cache existed, or one whose
          // log row was since pruned, leaves these `null`) AND every config
          // this run needs was actually part of that cached deep check —
          // otherwise fall through to a real pass so a matching-but-
          // unverified signature never gets stuck reporting a guess forever,
          // and a config new to this signature never inherits a verdict that
          // never considered it.
          if (!signatureChanged && t.lastDeepCheckResult !== null && t.lastDeepCheckLogId !== null) {
            const cachedConfigIds = new Set(await listCheckLogConfigIds(t.lastDeepCheckLogId));
            if (configs.every((c) => cachedConfigIds.has(c.id))) {
              const checkLogId = await logUrlCheckResult(
                t.sourceUrl,
                t.fileName,
                t.lastDeepCheckResult,
                null,
                configs.map(toEvaluatedConfigSnapshot),
              );
              await copyCheckDiffs(t.lastDeepCheckLogId, checkLogId);
              return;
            }
          }

          const entries: CheckDiffInput[] = [];
          let wholeUrlErrorMessage: string | null = null;
          let downloadSucceeded = false;
          // Set as soon as the download lands — deleted in the `finally`
          // below regardless of how the deep pass turns out, since this is
          // always just a scratch file: `computeReimportDiff` never keeps
          // its own copy, and even a config with `autoApplyEnabled` only
          // ever needs `source_files`' METADATA (see `logSourceFile` below)
          // to persist, not the file's bytes — nothing could ever reference
          // this exact path again once this check is done with it. Left
          // unset otherwise — nothing to clean up.
          let downloadedPath: string | null = null;
          try {
            const downloaded = await downloadPaymentFileFromUrl(t.sourceUrl);
            downloadSucceeded = true;
            downloadedPath = downloaded.path;

            // "Atualizar registros automaticamente" needs real provenance
            // for anything it writes (source_row_number/sheet position
            // matching depends on it, same as any manual reimport's
            // `logSourceFile` call) — persisted once per check, shared by
            // every auto-apply config for this URL, not per-config.
            const autoApplyConfigs = configs.filter((c) => c.autoApplyEnabled);
            let autoApplySourceFileId: number | null = null;
            let autoApplyFileHash: string | null = null;
            if (autoApplyConfigs.length > 0) {
              try {
                const { hash } = await hashPaymentFile(downloaded.path);
                autoApplyFileHash = hash;
                autoApplySourceFileId = await logSourceFile({
                  fileHash: hash,
                  fileName: downloaded.fileName,
                  pageCount: 1,
                  provider: autoApplyConfigs.map((c) => resolveReimportConfigLabel(c)).join(", "),
                  importType: "payment",
                  status: "success",
                  errorMessage: null,
                  originalPdfPath: "",
                  sourceUrl: t.sourceUrl,
                  sourceEtag: current.etag,
                  sourceLastModified: current.lastModified,
                  sourceContentLength: current.contentLength,
                });
              } catch (e) {
                // Couldn't persist the file — auto-apply configs fall back
                // to a plain (read-only) diff pass below rather than
                // failing the whole check over it.
                entries.push(errorDiffEntry(null, "Atualizar registros automaticamente", String(e instanceof Error ? e.message : e)));
              }
            }

            for (const config of configs) {
              try {
                const autoApply =
                  config.autoApplyEnabled && autoApplySourceFileId !== null
                    ? {
                        enabled: true,
                        overwriteManualEdits: config.autoApplyOverwriteManualEdits,
                        overwritePaid: config.autoApplyOverwritePaid,
                        sourceFileId: autoApplySourceFileId,
                      }
                    : undefined;
                entries.push(...(await computeReimportDiff(config, downloaded.path, autoApply)));
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

            if (autoApplyFileHash) await markSourceFileSaved(autoApplyFileHash);
          } catch (e) {
            wholeUrlErrorMessage = String(e instanceof Error ? e.message : e);
            // Same reasoning as the header-check failure above — without a
            // diff row this never reaches the global pending-updates banner.
            entries.push(errorDiffEntry(null, t.fileName, wholeUrlErrorMessage));
          } finally {
            if (downloadedPath) {
              try {
                await deletePaths([downloadedPath]);
              } catch {
                // Best-effort — a leftover temp file from a background check
                // isn't worth failing (or even logging) the check over.
              }
            }
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

          const checkLogId = await logUrlCheckResult(
            t.sourceUrl,
            t.fileName,
            effectiveResult,
            wholeUrlErrorMessage,
            configs.map(toEvaluatedConfigSnapshot),
          );
          await saveCheckDiffs(checkLogId, entries);
          // A failed DOWNLOAD isn't cached as "checked" — a transient
          // network blip should be retried next tick, not stuck reusing an
          // 'error' verdict forever until the header changes again. A
          // per-config failure (bad template) is real and persistent, so
          // that case still gets cached the same as a clean result.
          if (downloadSucceeded) {
            await markDeepCheckSignature(
              t.sourceUrl,
              current.etag,
              current.lastModified,
              current.contentLength,
              effectiveResult,
              checkLogId,
            );
            if (effectiveResult === "changed") await notifyFileChanged(t.fileName);
          }
        } finally {
          configs.forEach((c) => checkingConfigIdsRef.current.delete(c.id));
          setCheckingConfigIdsState(new Set(checkingConfigIdsRef.current));
        }
      }

      try {
        await Promise.allSettled(fresh.map(({ t, configs }) => runOne(t, configs)));
      } finally {
        // Re-read rather than patch in memory — the checked URLs/configs come
        // back with their brand new log entry (and deep-check signature),
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
      // Keep the rest of the app current even on a tick that finds nothing
      // due — cheap, since `tracked`/`configs` were just fetched anyway.
      setTrackedFiles(tracked);
      setReimportConfigs(configs);

      const trackedByUrl = new Map(tracked.map((t) => [t.sourceUrl, t]));
      const dueConfigsByUrl = new Map<string, ReimportConfig[]>();
      for (const c of configs) {
        if (!isConfigDue(c, now)) continue;
        const list = dueConfigsByUrl.get(c.sourceUrl) ?? [];
        list.push(c);
        dueConfigsByUrl.set(c.sourceUrl, list);
      }
      const work: { t: TrackedPaymentUrl; configs: ReimportConfig[] }[] = [];
      for (const [sourceUrl, dueConfigs] of dueConfigsByUrl) {
        const t = trackedByUrl.get(sourceUrl);
        if (t) work.push({ t, configs: dueConfigs });
      }
      if (work.length > 0) await runChecks(work);
      setTickError(null);
    } catch (e) {
      // Unlike a per-config check failure (always captured via
      // logUrlCheckResult, tied to that URL's own row/history), a failure
      // here has no specific URL to attach a history entry to — this is the
      // only place that kind of failure is visible at all, so it's kept
      // (not discarded) for the Sidebar/Verificação automática page to
      // surface.
      setTickError(String(e instanceof Error ? e.message : e));
    }
  }, [runChecks]);

  /** Fetches fresh rather than trusting React state — this can run right after a config/tracking change the page's own state hasn't necessarily settled from yet. */
  const forceCheckConfig = useCallback(
    async (configId: number) => {
      const configs = await listReimportConfigs();
      const config = configs.find((c) => c.id === configId);
      if (!config) return;
      const tracked = await listTrackedPaymentUrls();
      const t = tracked.find((f) => f.sourceUrl === config.sourceUrl);
      if (!t) return;
      await runChecks([{ t, configs: [config] }]);
    },
    [runChecks],
  );

  const forceCheckAll = useCallback(async () => {
    const [tracked, configs] = await Promise.all([listTrackedPaymentUrls(), listReimportConfigs()]);
    const activeConfigsByUrl = new Map<string, ReimportConfig[]>();
    for (const c of configs) {
      if (c.checkDisabled) continue;
      const list = activeConfigsByUrl.get(c.sourceUrl) ?? [];
      list.push(c);
      activeConfigsByUrl.set(c.sourceUrl, list);
    }
    const work = tracked.map((t) => ({ t, configs: activeConfigsByUrl.get(t.sourceUrl) ?? [] }));
    await runChecks(work);
  }, [runChecks]);

  useEffect(() => {
    ensureNotificationPermission();
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

  // Mirrors the same "Mudou"/erro state the Sidebar/Verificação automática
  // page already show, onto the tray icon — the one place that's still
  // visible once the window is hidden/minimized (see "Minimizar na bandeja
  // ao fechar" in Configurações). `changedUrls.size` (not
  // `remoteUpdates.length`) so dismissing one of several configs on the
  // same still-changed URL doesn't flip the tray back to normal — the URL
  // itself is still unaddressed.
  const trayAttention = changedUrls.size > 0 || tickError !== null || trackedFiles.some((t) => t.lastResult === "error");
  useEffect(() => {
    const parts: string[] = [];
    if (changedUrls.size > 0) {
      parts.push(`${changedUrls.size} arquivo${changedUrls.size > 1 ? "s" : ""} com mudança`);
    }
    if (tickError !== null || trackedFiles.some((t) => t.lastResult === "error")) {
      parts.push("erro na verificação");
    }
    const tooltip = parts.length > 0 ? `PontoScan — ${parts.join(", ")}` : "PontoScan";
    setTrayStatus(trayAttention, tooltip).catch(() => {
      // Best-effort — a platform without tray support (or the icon never
      // having been set up, e.g. no default app icon) shouldn't affect
      // anything else the app does.
    });
    // `trackedFiles` is a fresh array every tick (`refreshTrackedState`), so
    // this re-sets the tray on every tick regardless of whether anything
    // about it actually changed — harmless (the native call is cheap and
    // idempotent), and simpler than trying to diff it by hand just to skip
    // a no-op call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayAttention, changedUrls.size, tickError, trackedFiles]);

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
