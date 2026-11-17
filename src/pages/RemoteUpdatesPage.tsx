import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import ChangeDiffPanel from "../components/ChangeDiffPanel";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import Drawer from "../components/Drawer";
import { useRemoteFileUpdates, type ReimportConfig, type TrackedPaymentUrl } from "../contexts/RemoteFileUpdatesContext";
import { colorForName, initials } from "../lib/avatar";
import {
  DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  deletePaymentShift,
  dismissCheckDiffs,
  listAllLatestShiftDiffs,
  listCheckDiffs,
  listPaymentTemplates,
  listUrlCheckLogForConfig,
  type CheckDiffRow,
  type ReimportConfigInput,
  type UrlCheckLogEntry,
} from "../lib/db";
import { diffFieldLabel, formatDateAbbrevYY, formatDateTimeAbbrevYY, formatMinutesAsTime, formatPersonName, parseSqliteDateTime, resolveReimportPeriod } from "../lib/format";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import type { PaymentTemplateListRow } from "../lib/types";

const INTERVAL_CHOICES = [1, 5, 15, 30, 60];
const HISTORY_SIZE = 10;

type Tone = "ok" | "warn" | "bad" | "info" | "off" | "busy";

/** Editable part of a rule (everything but the spreadsheet and the template). */
type RuleSettings = Omit<ReimportConfigInput, "sourceUrl" | "templateId">;

function settingsOf(c: ReimportConfig): RuleSettings {
  return {
    label: c.label,
    dateMode: c.dateMode,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    startOffsetDays: c.startOffsetDays,
    endOffsetDays: c.endOffsetDays,
    checkIntervalMinutes: c.checkIntervalMinutes,
    keepManualEdits: c.keepManualEdits,
    autoApplyEnabled: c.autoApplyEnabled,
    autoApplyOverwriteManualEdits: c.autoApplyOverwriteManualEdits,
    autoApplyOverwritePaid: c.autoApplyOverwritePaid,
  };
}

const NEW_RULE_DEFAULTS: RuleSettings = {
  label: "",
  dateMode: "relative",
  periodStart: null,
  periodEnd: null,
  startOffsetDays: 30,
  endOffsetDays: 0,
  checkIntervalMinutes: DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  keepManualEdits: true,
  autoApplyEnabled: false,
  autoApplyOverwriteManualEdits: true,
  autoApplyOverwritePaid: false,
};

/** Shortcuts for "Quais turnos olhar". */
const PERIOD_CHOICES: { key: string; label: string; settings: Pick<RuleSettings, "dateMode" | "periodStart" | "periodEnd" | "startOffsetDays" | "endOffsetDays"> }[] = [
  { key: "7", label: "Últimos 7 dias", settings: { dateMode: "relative", periodStart: null, periodEnd: null, startOffsetDays: 7, endOffsetDays: 0 } },
  { key: "30", label: "Últimos 30 dias", settings: { dateMode: "relative", periodStart: null, periodEnd: null, startOffsetDays: 30, endOffsetDays: 0 } },
  { key: "60", label: "Últimos 60 dias", settings: { dateMode: "relative", periodStart: null, periodEnd: null, startOffsetDays: 60, endOffsetDays: 0 } },
  { key: "all", label: "Planilha inteira", settings: { dateMode: "fixed", periodStart: null, periodEnd: null, startOffsetDays: null, endOffsetDays: null } },
];

function periodChoiceOf(s: RuleSettings): string {
  const hit = PERIOD_CHOICES.find(
    (p) =>
      p.settings.dateMode === s.dateMode &&
      (s.dateMode === "relative"
        ? p.settings.startOffsetDays === s.startOffsetDays && p.settings.endOffsetDays === s.endOffsetDays
        : p.settings.periodStart === s.periodStart && p.settings.periodEnd === s.periodEnd),
  );
  if (hit) return hit.key;
  return s.dateMode === "fixed" ? "fixed" : "custom";
}

/** "últimos 30 dias", "01/nov/26 a 30/nov/26", "planilha inteira" — the rule's period in a few words. */
function periodText(s: RuleSettings): string {
  const choice = PERIOD_CHOICES.find((p) => p.key === periodChoiceOf(s));
  if (choice) return choice.label.toLowerCase();
  const r = resolveReimportPeriod(s);
  if (s.dateMode === "relative") return `de ${s.startOffsetDays ?? "?"} a ${s.endOffsetDays ?? "?"} dias atrás`;
  return `${r.start ? formatDateAbbrevYY(r.start) : "início"} a ${r.end ? formatDateAbbrevYY(r.end) : "fim"}`;
}

function todayRange(s: RuleSettings): string {
  const r = resolveReimportPeriod(s);
  if (!r.start && !r.end) return "a planilha inteira";
  return `de ${r.start ? formatDateAbbrevYY(r.start) : "início"} a ${r.end ? formatDateAbbrevYY(r.end) : "fim"}`;
}

function everyText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "a cada 1 hora" : `a cada ${minutes / 60} horas`;
  return `a cada ${minutes} min`;
}

function ruleName(c: ReimportConfig): string {
  return c.label.trim() || c.templateName || "Modelo removido";
}

/** "agora mesmo", "há 4 min", "há 2 h", "há 3 dias". */
function ago(sqlite: string | null, now: number): string {
  if (!sqlite) return "";
  const minutes = Math.max(0, Math.round((now - parseSqliteDateTime(sqlite).getTime()) / 60_000));
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

function fileExt(name: string): string {
  const ext = name.split(".").pop()?.toUpperCase() ?? "";
  return ext.length >= 2 && ext.length <= 4 ? ext : "URL";
}

type Sheet =
  | { kind: "rule"; configId: number }
  | { kind: "file"; sourceUrl: string }
  | { kind: "new-rule"; sourceUrl: string }
  | { kind: "review"; configId: number; mode: "pending" | "applied" }
  | { kind: "check"; configId: number; entry: UrlCheckLogEntry };

/**
 * "Verificação automática": the spreadsheets imported by link that the app
 * checks on its own. One row per spreadsheet with a plain-language status
 * and, only when needed, one button (Revisar, Ver, Ver o que fazer). A
 * spreadsheet with several rules shows once, with its rules nested under
 * it. Everything else (how often, which turnos, auto-apply, history) is in
 * a sheet opened by clicking the row, saved as it changes.
 */
export default function RemoteUpdatesPage() {
  const navigate = useNavigate();
  const {
    trackedFiles,
    reimportConfigs,
    addReimportConfig,
    updateReimportConfig,
    setConfigCheckDisabled,
    deleteReimportConfig,
    untrackUrl,
    checkingConfigIds,
    forceCheckConfig,
    forceCheckAll,
    tickError,
  } = useRemoteFileUpdates();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const [diffRows, setDiffRows] = useState<CheckDiffRow[]>([]);
  async function refreshDiffs() {
    setDiffRows(await listAllLatestShiftDiffs());
  }
  useEffect(() => {
    refreshDiffs().catch(() => {});
  }, [trackedFiles, reimportConfigs]);

  const [templates, setTemplates] = useState<PaymentTemplateListRow[]>([]);
  useEffect(() => {
    listPaymentTemplates().then(setTemplates).catch(() => {});
  }, []);

  const [forcingAll, setForcingAll] = useState(false);
  async function handleForceCheckAll() {
    setForcingAll(true);
    try {
      await forceCheckAll();
    } finally {
      setForcingAll(false);
    }
  }

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  function openSheet(next: Sheet) {
    setActionError(null);
    setSheet(next);
  }

  const configsByUrl = useMemo(() => {
    const map = new Map<string, ReimportConfig[]>();
    for (const c of reimportConfigs) map.set(c.sourceUrl, [...(map.get(c.sourceUrl) ?? []), c]);
    return map;
  }, [reimportConfigs]);

  function fileOf(sourceUrl: string): TrackedPaymentUrl | undefined {
    return trackedFiles.find((f) => f.sourceUrl === sourceUrl);
  }

  // ---- what each rule needs from you ----
  function rowsFor(c: ReimportConfig) {
    const own = diffRows.filter((r) => r.configId === c.id);
    return {
      pending: own.filter((r) => !r.applied && r.dismissedAt === null && r.changeKind !== "error"),
      applied: own.filter((r) => r.applied && r.dismissedAt === null),
      error:
        own.find((r) => r.changeKind === "error" && r.dismissedAt === null) ??
        diffRows.find((r) => r.configId === null && r.sourceUrl === c.sourceUrl && r.changeKind === "error" && r.dismissedAt === null),
    };
  }

  /** How many things a pending list holds: field diffs on the same turno count once. */
  function countItems(rows: CheckDiffRow[]): number {
    return new Set(rows.map((r) => (r.changeKind === "field" && r.matchedShiftId !== null ? `s${r.matchedShiftId}` : `d${r.id}`))).size;
  }

  function ruleStatus(c: ReimportConfig): { tone: Tone; text: string; action?: ReactNode } {
    if (checkingConfigIds.has(c.id)) return { tone: "busy", text: "Conferindo agora…" };
    if (c.checkDisabled) return { tone: "off", text: "Pausada" };
    const { pending, applied, error } = rowsFor(c);
    const file = fileOf(c.sourceUrl);
    if (error || file?.lastResult === "error") {
      return {
        tone: "bad",
        text: error?.message || file?.lastErrorMessage || "Não deu pra conferir a planilha",
        action: (
          <button type="button" className="settings-button" onClick={(e) => (e.stopPropagation(), openSheet({ kind: "rule", configId: c.id }))}>
            Ver o que fazer
          </button>
        ),
      };
    }
    if (pending.length) {
      const n = countItems(pending);
      return {
        tone: "warn",
        text: `${n} ${n === 1 ? "mudança encontrada" : "mudanças encontradas"} ${ago(c.lastCheckedAt, now)}`,
        action: (
          <button type="button" className="settings-button settings-button-primary" onClick={(e) => (e.stopPropagation(), openSheet({ kind: "review", configId: c.id, mode: "pending" }))}>
            Revisar
          </button>
        ),
      };
    }
    if (applied.length) {
      const n = countItems(applied);
      return {
        tone: "info",
        text: `${n} ${n === 1 ? "mudança aplicada" : "mudanças aplicadas"} sozinho ${ago(c.lastCheckedAt, now)}`,
        action: (
          <button type="button" className="settings-button" onClick={(e) => (e.stopPropagation(), openSheet({ kind: "review", configId: c.id, mode: "applied" }))}>
            Ver
          </button>
        ),
      };
    }
    if (!c.lastCheckedAt) return { tone: "ok", text: "Ainda não conferida" };
    return { tone: "ok", text: `Sem mudanças · conferida ${ago(c.lastCheckedAt, now)}` };
  }

  // ---- rule edits: saved as they change ----
  const [savingConfigId, setSavingConfigId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  async function saveRule(c: ReimportConfig, patch: Partial<RuleSettings>) {
    setSavingConfigId(c.id);
    setSaveError(null);
    try {
      await updateReimportConfig(c.id, { ...settingsOf(c), ...patch });
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSavingConfigId(null);
    }
  }
  async function toggleRule(c: ReimportConfig) {
    setSavingConfigId(c.id);
    setSaveError(null);
    try {
      await setConfigCheckDisabled(c.id, !c.checkDisabled);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSavingConfigId(null);
    }
  }

  // ---- new rule ----
  const [newRule, setNewRule] = useState<RuleSettings & { templateId: string }>({ ...NEW_RULE_DEFAULTS, templateId: "" });
  const [creating, setCreating] = useState(false);
  function openNewRule(sourceUrl: string) {
    setNewRule({ ...NEW_RULE_DEFAULTS, templateId: "" });
    openSheet({ kind: "new-rule", sourceUrl });
  }
  async function handleCreateRule(sourceUrl: string) {
    if (!newRule.templateId) {
      setActionError("Escolha o modelo da planilha.");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const { templateId, ...settings } = newRule;
      await addReimportConfig({ ...settings, sourceUrl, templateId: Number(templateId) });
      const list = configsByUrl.get(sourceUrl) ?? [];
      setSheet(list.length > 0 ? { kind: "file", sourceUrl } : null);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setCreating(false);
    }
  }

  // ---- confirmations ----
  const [untrackTarget, setUntrackTarget] = useState<TrackedPaymentUrl | null>(null);
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<ReimportConfig | null>(null);
  const [deleteShiftTarget, setDeleteShiftTarget] = useState<{ shiftId: number; who: string } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  async function runConfirm(action: () => Promise<void>, after: () => void) {
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await action();
      after();
    } catch (e) {
      setConfirmError(String(e));
    } finally {
      setConfirmBusy(false);
    }
  }

  // ---- review actions (same calls the old screen and the pending tab use) ----
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  async function withBusy(key: string, action: () => Promise<void>) {
    setBusyKeys((prev) => new Set(prev).add(key));
    setActionError(null);
    try {
      await action();
      await refreshDiffs();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }
  function reprocess(configId: number, periodStart: string | null, periodEnd: string | null) {
    navigate("/import/payments", { state: { autoReimportConfigId: configId, autoReimportPeriodStart: periodStart, autoReimportPeriodEnd: periodEnd } });
  }
  async function applyAll(c: ReimportConfig, rows: CheckDiffRow[]) {
    const shiftIds = Array.from(new Set(rows.filter((r) => r.changeKind === "field" && r.matchedShiftId !== null).map((r) => r.matchedShiftId!)));
    await withBusy("all", async () => {
      for (const id of shiftIds) await acceptShiftChange(c, id);
    });
  }

  // ---- history (in the rule sheet) and one check's detail ----
  const [history, setHistory] = useState<UrlCheckLogEntry[] | null>(null);
  const sheetConfigId = sheet && (sheet.kind === "rule" || sheet.kind === "check") ? sheet.configId : null;
  const sheetConfigChecked = reimportConfigs.find((c) => c.id === sheetConfigId)?.lastCheckedAt ?? null;
  useEffect(() => {
    if (sheet?.kind !== "rule") return;
    setHistory(null);
    listUrlCheckLogForConfig(sheet.configId, HISTORY_SIZE, 0)
      .then(setHistory)
      .catch(() => setHistory([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet?.kind, sheetConfigId, sheetConfigChecked]);

  const [checkDiffs, setCheckDiffs] = useState<CheckDiffRow[] | null>(null);
  useEffect(() => {
    if (sheet?.kind !== "check") return;
    setCheckDiffs(null);
    listCheckDiffs(sheet.entry.id)
      .then((rows) => setCheckDiffs(rows.filter((r) => r.configId === sheet.configId)))
      .catch(() => setCheckDiffs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  // ---- rendering helpers ----
  function statusLine(tone: Tone, text: string) {
    return (
      <span className={`rv-status rv-status-${tone}`}>
        <i aria-hidden="true" />
        <span className="rv-status-text">{text}</span>
      </span>
    );
  }

  function fileIcon(name: string) {
    const ext = fileExt(name);
    return <span className={ext === "XLSX" || ext === "XLS" ? "rv-file-ico" : "rv-file-ico rv-file-ico-other"}>{ext.slice(0, 3)}</span>;
  }

  function groupSummary(configs: ReimportConfig[]): { tone: Tone; text: string } {
    let pending = 0;
    let errors = 0;
    let paused = 0;
    for (const c of configs) {
      const s = ruleStatus(c);
      if (s.tone === "warn") pending += countItems(rowsFor(c).pending);
      if (s.tone === "bad") errors++;
      if (s.tone === "off") paused++;
    }
    const parts: string[] = [];
    if (pending) parts.push(`${pending} ${pending === 1 ? "mudança" : "mudanças"} para revisar`);
    if (errors) parts.push(`${errors} com erro`);
    if (paused) parts.push(`${paused} ${paused === 1 ? "pausada" : "pausadas"}`);
    return { tone: pending ? "warn" : errors ? "bad" : "ok", text: parts.length ? parts.join(" · ") : "Tudo em dia" };
  }

  function chevron() {
    return <ChevronRight size={16} className="rv-chevron" aria-hidden="true" />;
  }

  function renderSingle(file: TrackedPaymentUrl, c: ReimportConfig | undefined) {
    const status = c ? ruleStatus(c) : null;
    const open = () => (c ? openSheet({ kind: "rule", configId: c.id }) : openNewRule(file.sourceUrl));
    return (
      <div
        key={file.sourceUrl}
        className="rv-item"
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), open())}
      >
        {fileIcon(file.fileName)}
        <div className="rv-text">
          <div className="rv-name">{file.fileName}</div>
          {status ? statusLine(status.tone, status.text) : statusLine("off", "Sem regra: não está sendo conferida")}
        </div>
        {status?.action ?? (c ? <span className="rv-every">{c.checkDisabled ? "" : everyText(c.checkIntervalMinutes)}</span> : (
          <button type="button" className="settings-button" onClick={(e) => (e.stopPropagation(), openNewRule(file.sourceUrl))}>
            Criar regra
          </button>
        ))}
        {chevron()}
      </div>
    );
  }

  function renderGroup(file: TrackedPaymentUrl, configs: ReimportConfig[]) {
    const summary = groupSummary(configs);
    const openFile = () => openSheet({ kind: "file", sourceUrl: file.sourceUrl });
    return (
      <div key={file.sourceUrl} className="rv-group">
        <div
          className="rv-group-head"
          role="button"
          tabIndex={0}
          onClick={openFile}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openFile())}
        >
          {fileIcon(file.fileName)}
          <div className="rv-text">
            <div className="rv-name">
              {file.fileName}
              <span className="rv-count-badge">{configs.length} regras</span>
            </div>
            {statusLine(summary.tone, summary.text)}
          </div>
          {chevron()}
        </div>
        <div className="rv-rules">
          {configs.map((c) => {
            const status = ruleStatus(c);
            const open = () => openSheet({ kind: "rule", configId: c.id });
            return (
              <div
                key={c.id}
                className="rv-rule"
                role="button"
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), open())}
              >
                <div className="rv-text">
                  <div className="rv-rule-name">
                    {ruleName(c)} <span className="rv-rule-period">· {periodText(settingsOf(c))}</span>
                  </div>
                  {statusLine(status.tone, status.text)}
                </div>
                {status.action ?? <span className="rv-every">{c.checkDisabled ? "" : everyText(c.checkIntervalMinutes)}</span>}
                {chevron()}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /** The rule settings shared by "edit" and "new rule". */
  function renderRuleFields(s: RuleSettings, onChange: (patch: Partial<RuleSettings>) => void) {
    const periodChoice = periodChoiceOf(s);
    const customInterval = !INTERVAL_CHOICES.includes(s.checkIntervalMinutes);
    return (
      <>
        <div className="rv-field">
          <span className="rv-label">Conferir a cada</span>
          <div className="rv-chips">
            {INTERVAL_CHOICES.map((m) => (
              <button key={m} type="button" className="rv-chip" aria-pressed={s.checkIntervalMinutes === m} onClick={() => onChange({ checkIntervalMinutes: m })}>
                {m === 60 ? "1 hora" : `${m} min`}
              </button>
            ))}
            {customInterval && (
              <span className="rv-chip" aria-pressed="true">
                {s.checkIntervalMinutes} min
              </span>
            )}
          </div>
        </div>

        <div className="rv-field">
          <span className="rv-label">Quais turnos olhar</span>
          <div className="rv-chips">
            {PERIOD_CHOICES.map((p) => (
              <button key={p.key} type="button" className="rv-chip" aria-pressed={periodChoice === p.key} onClick={() => onChange(p.settings)}>
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className="rv-chip"
              aria-pressed={periodChoice === "fixed"}
              onClick={() => onChange({ dateMode: "fixed", startOffsetDays: null, endOffsetDays: null, periodStart: s.periodStart, periodEnd: s.periodEnd })}
            >
              Período fixo…
            </button>
            {periodChoice === "custom" && (
              <span className="rv-chip" aria-pressed="true">
                {periodText(s)}
              </span>
            )}
          </div>
          {periodChoice === "fixed" && (
            <DateRangePicker startValue={s.periodStart ?? ""} endValue={s.periodEnd ?? ""} onChange={(start, end) => onChange({ periodStart: start || null, periodEnd: end || null })} fullWidth />
          )}
          <span className="rv-small">Hoje isso é {todayRange(s)}.</span>
        </div>

        <label className="rv-toggle">
          <span className="rv-text">
            <span className="rv-toggle-title">Aplicar mudanças sozinho</span>
            <span className="rv-toggle-desc">Alterações e turnos novos entram sem precisar revisar. Turnos já pagos não são alterados, a não ser que você permita em “Mais detalhes”.</span>
          </span>
          <input type="checkbox" role="switch" className="settings-switch" checked={s.autoApplyEnabled} onChange={(e) => onChange({ autoApplyEnabled: e.target.checked })} />
        </label>
      </>
    );
  }

  function renderRuleSheet(c: ReimportConfig) {
    const s = settingsOf(c);
    const file = fileOf(c.sourceUrl);
    const siblings = configsByUrl.get(c.sourceUrl) ?? [];
    const { error } = rowsFor(c);
    const errorMessage = error?.message || (file?.lastResult === "error" ? file.lastErrorMessage : null);
    return (
      <div className="rv-sheet">
        <div className="rv-sheet-sub">
          {siblings.length > 1 ? (
            <>
              Regra: {ruleName(c)} · {periodText(s)} ·{" "}
              <button type="button" className="rv-link" onClick={() => openSheet({ kind: "file", sourceUrl: c.sourceUrl })}>
                ver as outras regras
              </button>
            </>
          ) : (
            <button type="button" className="rv-link" onClick={() => openUrl(c.sourceUrl)}>
              Abrir link <ExternalLink size={11} />
            </button>
          )}
        </div>

        {errorMessage && (
          <div className="rv-banner rv-banner-bad">
            <strong>Não deu pra conferir a planilha</strong>
            <span>{errorMessage}</span>
            <ol>
              <li>Abra o link e confira se a planilha ainda existe.</li>
              <li>Se for do OneDrive ou SharePoint, compartilhe com “Qualquer pessoa com o link pode ver”.</li>
              <li>Volte aqui e clique em Tentar de novo.</li>
            </ol>
            <div className="rv-actions">
              <button type="button" className="settings-button" onClick={() => openUrl(c.sourceUrl)}>
                Abrir link <ExternalLink size={12} />
              </button>
              <button type="button" className="settings-button settings-button-primary" onClick={() => forceCheckConfig(c.id)} disabled={checkingConfigIds.has(c.id)}>
                {checkingConfigIds.has(c.id) ? "Conferindo..." : "Tentar de novo"}
              </button>
              {error && (
                <button type="button" className="settings-button settings-button-ghost" onClick={() => withBusy(`e${error.id}`, () => dismissCheckDiffs([error.id]))}>
                  Ok, já vi
                </button>
              )}
            </div>
          </div>
        )}

        <label className="rv-toggle">
          <span className="rv-text">
            <span className="rv-toggle-title">Conferir esta planilha</span>
            <span className="rv-toggle-desc">Desligue para pausar sem perder os ajustes.</span>
          </span>
          <input type="checkbox" role="switch" className="settings-switch" checked={!c.checkDisabled} onChange={() => toggleRule(c)} />
        </label>

        {renderRuleFields(s, (patch) => saveRule(c, patch))}

        <details className="rv-details">
          <summary>Mais detalhes</summary>
          <div className="rv-details-body">
            <label className="rv-toggle rv-toggle-sub">
              <span className="rv-text">
                <span className="rv-toggle-title">Também alterar turnos editados à mão</span>
                <span className="rv-toggle-desc">Quando aplica sozinho. Pagos, voltados para pendente ou com valor corrigido.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="settings-switch"
                checked={c.autoApplyOverwriteManualEdits}
                disabled={!c.autoApplyEnabled}
                onChange={(e) => saveRule(c, { autoApplyOverwriteManualEdits: e.target.checked })}
              />
            </label>
            <label className="rv-toggle rv-toggle-sub">
              <span className="rv-text">
                <span className="rv-toggle-title">Também alterar turnos já pagos</span>
                <span className="rv-toggle-desc">Quando aplica sozinho.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="settings-switch"
                checked={c.autoApplyOverwritePaid}
                disabled={!c.autoApplyEnabled}
                onChange={(e) => saveRule(c, { autoApplyOverwritePaid: e.target.checked })}
              />
            </label>
            <label className="rv-toggle rv-toggle-sub">
              <span className="rv-text">
                <span className="rv-toggle-title">Ao reimportar, manter turnos editados à mão</span>
                <span className="rv-toggle-desc">Vale quando você usa “Reimportar agora”, abaixo.</span>
              </span>
              <input type="checkbox" role="switch" className="settings-switch" checked={c.keepManualEdits} onChange={(e) => saveRule(c, { keepManualEdits: e.target.checked })} />
            </label>

            <div className="rv-field">
              <span className="rv-label">Modelo da planilha</span>
              <span>{c.templateName ?? "Modelo removido"}</span>
              <span className="rv-small">Para usar outro modelo, crie uma nova regra.</span>
            </div>

            <div className="rv-field">
              <span className="rv-label">Últimas verificações</span>
              {history === null && <span className="rv-small">Carregando...</span>}
              {history?.length === 0 && <span className="rv-small">Ainda não foi conferida.</span>}
              <div className="rv-history">
                {history?.map((entry) => {
                  const tone: Tone = entry.result === "error" || entry.hasOwnError ? "bad" : entry.diffCount > 0 ? "warn" : entry.result === "unknown" ? "off" : "ok";
                  const text =
                    tone === "bad" ? "erro" : entry.diffCount > 0 ? `${entry.diffCount} ${entry.diffCount === 1 ? "mudança" : "mudanças"}` : entry.result === "unknown" ? "não deu pra saber" : "sem mudanças";
                  return (
                    <button key={entry.id} type="button" onClick={() => openSheet({ kind: "check", configId: c.id, entry })}>
                      <i className={`rv-dot rv-dot-${tone}`} aria-hidden="true" />
                      {formatDateTimeAbbrevYY(entry.checkedAt)} · {text}
                      <span className="rv-history-go">Ver ›</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rv-actions">
              <button type="button" className="settings-button" onClick={() => forceCheckConfig(c.id)} disabled={checkingConfigIds.has(c.id)}>
                <RefreshCw size={13} />
                {checkingConfigIds.has(c.id) ? "Conferindo..." : "Conferir agora"}
              </button>
              <button type="button" className="settings-button" onClick={() => reprocess(c.id, resolveReimportPeriod(s).start, resolveReimportPeriod(s).end)}>
                Reimportar agora
              </button>
              <button type="button" className="settings-button settings-button-ghost" onClick={() => openNewRule(c.sourceUrl)}>
                + Outra regra para esta planilha
              </button>
            </div>
          </div>
        </details>
      </div>
    );
  }

  function renderFileSheet(sourceUrl: string) {
    const configs = configsByUrl.get(sourceUrl) ?? [];
    return (
      <div className="rv-sheet">
        <div className="rv-sheet-sub">
          <button type="button" className="rv-link" onClick={() => openUrl(sourceUrl)}>
            Abrir link <ExternalLink size={11} />
          </button>
        </div>
        <p className="rv-muted">
          A mesma planilha é conferida por {configs.length} regras. Cada uma usa o seu modelo e o seu período, e avisa separado.
        </p>
        <div className="rv-rules-list">
          {configs.map((c) => {
            const status = ruleStatus(c);
            return (
              <button key={c.id} type="button" onClick={() => openSheet({ kind: "rule", configId: c.id })}>
                <span className="rv-text">
                  <span className="rv-rule-name">
                    {ruleName(c)} <span className="rv-rule-period">· {periodText(settingsOf(c))}</span>
                  </span>
                  {statusLine(status.tone, status.text)}
                </span>
                {chevron()}
              </button>
            );
          })}
        </div>
        <button type="button" className="settings-button" style={{ alignSelf: "flex-start" }} onClick={() => openNewRule(sourceUrl)}>
          + Nova regra para esta planilha
        </button>
      </div>
    );
  }

  function renderNewRuleSheet() {
    return (
      <div className="rv-sheet">
        <div className="rv-field">
          <label className="rv-label" htmlFor="rv-new-template">
            Modelo da planilha
          </label>
          <select id="rv-new-template" value={newRule.templateId} onChange={(e) => setNewRule((r) => ({ ...r, templateId: e.target.value }))}>
            <option value="">Escolha um modelo</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {renderRuleFields(newRule, (patch) => setNewRule((r) => ({ ...r, ...patch })))}
      </div>
    );
  }

  /** Field diffs of one turno go together; everything else is one card per row. */
  function cardsOf(rows: CheckDiffRow[]) {
    const cards = new Map<string, CheckDiffRow[]>();
    for (const r of rows) {
      const key = r.changeKind === "field" && r.matchedShiftId !== null ? `s${r.matchedShiftId}` : `d${r.id}`;
      cards.set(key, [...(cards.get(key) ?? []), r]);
    }
    const byPerson = new Map<string, { name: string; cards: { key: string; rows: CheckDiffRow[] }[] }>();
    for (const [key, cardRows] of cards) {
      const raw = cardRows[0].employeeName?.trim() || "";
      const name = raw ? (cardRows[0].employeeId ? formatPersonName(raw) : `“${raw}”`) : "(nome vazio)";
      const entry = byPerson.get(name) ?? { name, cards: [] };
      entry.cards.push({ key, rows: cardRows });
      byPerson.set(name, entry);
    }
    return Array.from(byPerson.values());
  }

  const KIND_TAG: Record<string, [string, string]> = {
    field: ["rv-tag-alt", "Alterado"],
    "new-shift": ["rv-tag-new", "Novo"],
    removed: ["rv-tag-gone", "Saiu"],
    unresolved: ["rv-tag-who", "Sem cadastro"],
  };

  function renderCard(c: ReimportConfig, key: string, rows: CheckDiffRow[], applied: boolean) {
    const first = rows[0];
    const [tagClass, tagLabel] = KIND_TAG[first.changeKind] ?? ["rv-tag-who", first.changeKind];
    const where = [first.local, first.role].filter(Boolean).join(" · ");
    const sheetPlace = first.rowNumber !== null ? `${first.sheetName ? `aba ${first.sheetName}, ` : ""}linha ${first.rowNumber}` : null;
    const busy = busyKeys.has(key) || busyKeys.has("all");
    const ids = rows.map((r) => r.id);
    const schedule =
      first.scheduleStartMinutes !== null && first.scheduleEndMinutes !== null
        ? `${formatMinutesAsTime(first.scheduleStartMinutes)} – ${formatMinutesAsTime(first.scheduleEndMinutes)}`
        : null;

    let body: ReactNode;
    if (first.changeKind === "field") {
      body = (
        <dl className="rv-diffs">
          {rows.map((r) => (
            <div key={r.id}>
              <dt>{diffFieldLabel(r.fieldName, r.columnLetter)}</dt>
              <dd>
                <s>{r.oldValue || "(vazio)"}</s> → <b>{r.newValue || "(vazio)"}</b>
              </dd>
            </div>
          ))}
        </dl>
      );
    } else if (first.changeKind === "new-shift") {
      body = <p className="rv-plain">{schedule ? `Turno novo na planilha: ${schedule}.` : "Turno novo na planilha."}</p>;
    } else {
      body = <p className="rv-plain">{first.message}</p>;
    }

    let actions: ReactNode = null;
    if (!applied) {
      const ignore = (label: string) => (
        <button type="button" className="settings-button settings-button-ghost" disabled={busy} onClick={() => withBusy(key, () => dismissCheckDiffs(ids))}>
          {label}
        </button>
      );
      if (first.changeKind === "field" && first.matchedShiftId !== null) {
        actions = (
          <>
            <button type="button" className="settings-button" disabled={busy} onClick={() => withBusy(key, () => acceptShiftChange(c, first.matchedShiftId!))}>
              {busy ? "Aplicando..." : "Aplicar"}
            </button>
            {ignore("Ignorar")}
          </>
        );
      } else if (first.changeKind === "removed" && first.matchedShiftId !== null) {
        actions = (
          <>
            <button type="button" className="settings-button settings-button-danger" disabled={busy} onClick={() => setDeleteShiftTarget({ shiftId: first.matchedShiftId!, who: first.employeeName ?? "" })}>
              Excluir turno…
            </button>
            {ignore("Manter")}
          </>
        );
      } else {
        actions = (
          <>
            <button type="button" className="settings-button" disabled={busy} onClick={() => reprocess(c.id, first.periodStart, first.periodEnd)}>
              Reimportar o período
            </button>
            {ignore("Ignorar")}
          </>
        );
      }
    }

    return (
      <div key={key} className="rv-change">
        <div className="rv-change-top">
          <span className="rv-change-date">{first.workDate ? formatDateAbbrevYY(first.workDate) : "Sem data"}</span>
          {where && <span className="rv-small">{where}</span>}
          <span className={`rv-tag ${applied ? "rv-tag-auto" : tagClass}`}>{applied ? "Aplicado" : tagLabel}</span>
        </div>
        {body}
        {sheetPlace && <span className="rv-small">{sheetPlace}</span>}
        {actions && <div className="rv-actions">{actions}</div>}
      </div>
    );
  }

  const [reviewFilter, setReviewFilter] = useState<string>("all");
  useEffect(() => setReviewFilter("all"), [sheet?.kind, sheetConfigId]);

  function renderReview(c: ReimportConfig, mode: "pending" | "applied") {
    const { pending, applied } = rowsFor(c);
    const rows = mode === "pending" ? pending : applied;
    if (rows.length === 0) {
      return (
        <div className="rv-all-done">
          <span>✓</span>
          <strong>Tudo revisado</strong>
          <span className="rv-small">A planilha continua sendo conferida {everyText(c.checkIntervalMinutes)}.</span>
        </div>
      );
    }
    const kinds = ["field", "new-shift", "removed", "unresolved"].filter((k) => rows.some((r) => r.changeKind === k));
    const shown = reviewFilter === "all" ? rows : rows.filter((r) => r.changeKind === reviewFilter);
    const counts = (k: string) => countItems(rows.filter((r) => r.changeKind === k));
    return (
      <div className="rv-sheet rv-sheet-tight">
        {mode === "applied" && (
          <div className="rv-banner rv-banner-info">
            <strong>Aplicado sozinho</strong>
            <span>Esta regra está com “Aplicar mudanças sozinho” ligado. Nada aqui precisa de você; é só pra conferir.</span>
          </div>
        )}
        {mode === "pending" && kinds.length > 1 && (
          <div className="rv-chips">
            <button type="button" className="rv-chip" aria-pressed={reviewFilter === "all"} onClick={() => setReviewFilter("all")}>
              Todas <span className="rv-chip-n">{countItems(rows)}</span>
            </button>
            {kinds.map((k) => (
              <button key={k} type="button" className="rv-chip" aria-pressed={reviewFilter === k} onClick={() => setReviewFilter(k)}>
                {{ field: "Alteradas", "new-shift": "Novas", removed: "Saíram", unresolved: "Sem cadastro" }[k]} <span className="rv-chip-n">{counts(k)}</span>
              </button>
            ))}
          </div>
        )}
        {actionError && <div className="error-box">{actionError}</div>}
        {cardsOf(shown).map((person) => (
          <div key={person.name} className="rv-person">
            <div className="rv-person-head">
              <span className="rv-avatar" style={{ background: colorForName(person.name) }}>
                {initials(person.name.replace(/[“”]/g, ""))}
              </span>
              <span className="rv-text">
                <span className="rv-person-name">{person.name}</span>
                <span className="rv-small">
                  {person.cards.length} {person.cards.length === 1 ? "turno" : "turnos"}
                </span>
              </span>
            </div>
            {person.cards.map((card) => renderCard(c, card.key, card.rows, mode === "applied"))}
          </div>
        ))}
      </div>
    );
  }

  // ---- sheet chrome ----
  const sheetConfig = sheetConfigId !== null ? reimportConfigs.find((c) => c.id === sheetConfigId) : undefined;
  const reviewConfig = sheet?.kind === "review" ? reimportConfigs.find((c) => c.id === sheet.configId) : undefined;
  let sheetTitle = "";
  let sheetBody: ReactNode = null;
  let sheetFooter: ReactNode = null;

  if (sheet?.kind === "rule" && sheetConfig) {
    const file = fileOf(sheetConfig.sourceUrl);
    const siblings = configsByUrl.get(sheetConfig.sourceUrl) ?? [];
    sheetTitle = file?.fileName ?? "Planilha";
    sheetBody = renderRuleSheet(sheetConfig);
    sheetFooter = (
      <>
        {siblings.length > 1 ? (
          <button type="button" className="settings-button settings-button-danger" onClick={() => setDeleteRuleTarget(sheetConfig)}>
            Excluir esta regra…
          </button>
        ) : (
          file && (
            <button type="button" className="settings-button settings-button-danger" onClick={() => setUntrackTarget(file)}>
              Parar de acompanhar…
            </button>
          )
        )}
        <span className="rv-footer-note">{saveError ? <span className="settings-text-danger">{saveError}</span> : savingConfigId === sheetConfig.id ? "Salvando..." : "Salvo automaticamente"}</span>
      </>
    );
  } else if (sheet?.kind === "file") {
    const file = fileOf(sheet.sourceUrl);
    sheetTitle = file?.fileName ?? "Planilha";
    sheetBody = renderFileSheet(sheet.sourceUrl);
    sheetFooter = file && (
      <button type="button" className="settings-button settings-button-danger" onClick={() => setUntrackTarget(file)}>
        Parar de acompanhar…
      </button>
    );
  } else if (sheet?.kind === "new-rule") {
    const file = fileOf(sheet.sourceUrl);
    sheetTitle = "Nova regra";
    sheetBody = (
      <>
        <div className="rv-sheet-sub rv-sheet-sub-top">{file?.fileName}</div>
        {renderNewRuleSheet()}
        {actionError && <div className="error-box">{actionError}</div>}
      </>
    );
    sheetFooter = (
      <>
        <button type="button" className="settings-button settings-button-ghost" onClick={() => setSheet(null)}>
          Cancelar
        </button>
        <button type="button" className="settings-button settings-button-primary" onClick={() => handleCreateRule(sheet.sourceUrl)} disabled={creating}>
          {creating ? "Criando..." : "Criar regra"}
        </button>
      </>
    );
  } else if (sheet?.kind === "review" && reviewConfig) {
    const { pending, applied } = rowsFor(reviewConfig);
    const rows = sheet.mode === "pending" ? pending : applied;
    const n = countItems(rows);
    const file = fileOf(reviewConfig.sourceUrl);
    const siblings = configsByUrl.get(reviewConfig.sourceUrl) ?? [];
    sheetTitle =
      sheet.mode === "applied"
        ? `${n} ${n === 1 ? "mudança aplicada" : "mudanças aplicadas"} sozinho`
        : n
          ? `${n} ${n === 1 ? "mudança para revisar" : "mudanças para revisar"}`
          : "Tudo revisado";
    sheetBody = (
      <>
        <div className="rv-sheet-sub rv-sheet-sub-top">
          {file?.fileName}
          {siblings.length > 1 && ` · ${ruleName(reviewConfig)}`} · encontradas {ago(reviewConfig.lastCheckedAt, now)}
        </div>
        {renderReview(reviewConfig, sheet.mode)}
      </>
    );
    const fieldShifts = new Set(pending.filter((r) => r.changeKind === "field" && r.matchedShiftId !== null).map((r) => r.matchedShiftId)).size;
    sheetFooter =
      sheet.mode === "applied" ? (
        <>
          <span className="rv-footer-note">Ao confirmar, essas mudanças saem da lista.</span>
          <button type="button" className="settings-button settings-button-primary" disabled={busyKeys.has("seen") || rows.length === 0} onClick={() => withBusy("seen", () => dismissCheckDiffs(rows.map((r) => r.id)))}>
            Ok, entendi
          </button>
        </>
      ) : (
        <>
          <span className="rv-footer-note">{n ? `${n} restantes` : "Nada pendente"}</span>
          <button type="button" className="settings-button settings-button-primary" disabled={fieldShifts === 0 || busyKeys.has("all")} onClick={() => applyAll(reviewConfig, pending)}>
            {busyKeys.has("all") ? "Aplicando..." : `Aplicar as alterações (${fieldShifts})`}
          </button>
        </>
      );
  } else if (sheet?.kind === "check" && sheetConfig) {
    sheetTitle = `Verificação de ${formatDateTimeAbbrevYY(sheet.entry.checkedAt)}`;
    sheetBody = (
      <div className="rv-sheet">
        <div className="rv-sheet-sub">
          <button type="button" className="rv-link" onClick={() => openSheet({ kind: "rule", configId: sheetConfig.id })}>
            ← Voltar para a regra
          </button>
        </div>
        {sheet.entry.message && <div className="error-box">{sheet.entry.message}</div>}
        {actionError && <div className="error-box">{actionError}</div>}
        {checkDiffs === null && <p className="rv-muted">Carregando...</p>}
        {checkDiffs?.length === 0 && !sheet.entry.message && <p className="rv-muted">Nenhuma mudança nesta verificação.</p>}
        {checkDiffs && checkDiffs.length > 0 && (
          <ChangeDiffPanel
            rows={checkDiffs}
            markingShiftId={null}
            markedShiftIds={new Set()}
            onMarkDeleted={(shiftId) => {
              const who = checkDiffs.find((r) => r.matchedShiftId === shiftId)?.employeeName ?? "";
              setDeleteShiftTarget({ shiftId, who });
            }}
            onAccept={(shiftId) => withBusy(`s${shiftId}`, () => acceptShiftChange(sheetConfig, shiftId))}
            acceptingShiftId={null}
            acceptedShiftIds={new Set()}
            onDismiss={(ids) =>
              withBusy(`d${ids.join(",")}`, async () => {
                await dismissCheckDiffs(ids);
                setCheckDiffs((prev) => prev?.map((r) => (ids.includes(r.id) ? { ...r, dismissedAt: new Date().toISOString() } : r)) ?? null);
              })
            }
            dismissingIds={new Set()}
            onReprocess={reprocess}
          />
        )}
      </div>
    );
  }

  const files = trackedFiles;

  return (
    <div className="rv-page">
      <div className="rv-head">
        <div>
          <h2>Verificação automática</h2>
          <p className="page-subtitle">Planilhas importadas por link que o PontoScan confere sozinho.</p>
        </div>
        {files.length > 0 && (
          <button type="button" className="settings-button" onClick={handleForceCheckAll} disabled={forcingAll}>
            <RefreshCw size={14} className={forcingAll ? "ai-spin" : undefined} />
            {forcingAll ? "Conferindo..." : "Verificar agora"}
          </button>
        )}
      </div>

      {tickError && <div className="error-box">Não deu pra conferir as planilhas: {tickError}</div>}

      {files.length === 0 ? (
        <div className="rv-empty">
          <span className="rv-empty-icon" aria-hidden="true">
            <RefreshCw size={20} />
          </span>
          <strong>Nenhuma planilha acompanhada ainda</strong>
          <span className="rv-empty-lead">Quando uma planilha de pagamento vem de um link (OneDrive, SharePoint ou link direto), o PontoScan pode conferir sozinho se ela mudou.</span>
          <ol className="rv-empty-steps">
            <li>
              <b>1</b>Em Importar Pagamentos, importe a planilha pelo link.
            </li>
            <li>
              <b>2</b>Marque “Rastrear atualizações automaticamente”.
            </li>
            <li>
              <b>3</b>Ela aparece aqui, e você é avisado quando algo mudar.
            </li>
          </ol>
          <button type="button" className="settings-button settings-button-primary" onClick={() => navigate("/import/payments")}>
            Ir para Importar Pagamentos
          </button>
        </div>
      ) : (
        <>
          <div className="rv-list">
            {files.map((f) => {
              const configs = configsByUrl.get(f.sourceUrl) ?? [];
              return configs.length > 1 ? renderGroup(f, configs) : renderSingle(f, configs[0]);
            })}
          </div>
          <p className="rv-hint">
            Para acompanhar outra planilha, importe-a por link em{" "}
            <button type="button" className="rv-link" onClick={() => navigate("/import/payments")}>
              Importar Pagamentos
            </button>{" "}
            e marque “Rastrear atualizações automaticamente”.
          </p>
        </>
      )}

      <Drawer open={sheet !== null && sheetBody !== null} onClose={() => setSheet(null)} title={sheetTitle} width="min(480px, 94vw)" footer={sheetFooter ? <div className="rv-footer">{sheetFooter}</div> : undefined}>
        {sheetBody}
      </Drawer>

      {untrackTarget && (
        <ConfirmModal
          title="Parar de acompanhar esta planilha?"
          message={`O PontoScan deixa de conferir “${untrackTarget.fileName}” e apaga as regras e o histórico de verificações dela. Os turnos já importados não mudam.`}
          confirmLabel={confirmBusy ? "Removendo..." : "Parar de acompanhar"}
          confirmDisabled={confirmBusy}
          error={confirmError}
          onConfirm={() =>
            runConfirm(
              () => untrackUrl(untrackTarget.sourceUrl),
              () => {
                setUntrackTarget(null);
                setSheet(null);
              },
            )
          }
          onCancel={() => {
            setUntrackTarget(null);
            setConfirmError(null);
          }}
        />
      )}

      {deleteRuleTarget && (
        <ConfirmModal
          title="Excluir esta regra?"
          message={`A regra “${ruleName(deleteRuleTarget)} · ${periodText(settingsOf(deleteRuleTarget))}” para de conferir a planilha. As outras regras e os turnos já importados não mudam.`}
          confirmLabel={confirmBusy ? "Excluindo..." : "Excluir regra"}
          confirmDisabled={confirmBusy}
          error={confirmError}
          onConfirm={() =>
            runConfirm(
              () => deleteReimportConfig(deleteRuleTarget.id),
              () => {
                setSheet({ kind: "file", sourceUrl: deleteRuleTarget.sourceUrl });
                setDeleteRuleTarget(null);
              },
            )
          }
          onCancel={() => {
            setDeleteRuleTarget(null);
            setConfirmError(null);
          }}
        />
      )}

      {deleteShiftTarget && (
        <ConfirmModal
          title="Excluir este turno?"
          message={`O turno${deleteShiftTarget.who ? ` de ${formatPersonName(deleteShiftTarget.who)}` : ""} saiu da planilha e vai ser excluído do PontoScan também.`}
          confirmLabel={confirmBusy ? "Excluindo..." : "Excluir turno"}
          confirmDisabled={confirmBusy}
          error={confirmError}
          onConfirm={() =>
            runConfirm(
              async () => {
                await deletePaymentShift(deleteShiftTarget.shiftId);
                await refreshDiffs();
              },
              () => setDeleteShiftTarget(null),
            )
          }
          onCancel={() => {
            setDeleteShiftTarget(null);
            setConfirmError(null);
          }}
        />
      )}
    </div>
  );
}
