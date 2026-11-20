import { ChevronDown, ChevronRight, ExternalLink, FileSpreadsheet, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { READ_ONLY_TITLE, useReadOnly } from "../components/AreaRoute";
import ChangeCards, { authorKey, NO_PAYMENT_EDIT_TITLE, savedWhen, UNNAMED_AUTHOR } from "../components/ChangeCards";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import Drawer from "../components/Drawer";
import PageHeader from "../components/PageHeader";
import { useAccess } from "../contexts/AuthContext";
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
import { formatDateAbbrevYY, formatDateTimeAbbrevYY, formatPersonName, parseSqliteDateTime, resolveReimportConfigLabel, resolveReimportPeriod } from "../lib/format";
import { acceptShiftChange } from "../lib/remoteCheckDiff";
import type { PaymentTemplateListRow } from "../lib/types";

/** Opens the spreadsheet's link in a new browser tab. */
function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

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
  dateMode: "month",
  periodStart: null,
  periodEnd: null,
  startOffsetDays: null,
  endOffsetDays: null,
  checkIntervalMinutes: DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES,
  keepManualEdits: true,
  autoApplyEnabled: false,
  autoApplyOverwriteManualEdits: true,
  autoApplyOverwritePaid: false,
};

/** Shortcuts for "Quais turnos olhar" (plus "Período fixo…", which opens the date picker). */
const PERIOD_CHOICES: { key: string; label: string; settings: Pick<RuleSettings, "dateMode" | "periodStart" | "periodEnd" | "startOffsetDays" | "endOffsetDays"> }[] = [
  { key: "today", label: "Hoje", settings: { dateMode: "relative", periodStart: null, periodEnd: null, startOffsetDays: 0, endOffsetDays: 0 } },
  { key: "month", label: "Mês atual", settings: { dateMode: "month", periodStart: null, periodEnd: null, startOffsetDays: null, endOffsetDays: null } },
  { key: "30", label: "Últimos 30 dias", settings: { dateMode: "relative", periodStart: null, periodEnd: null, startOffsetDays: 30, endOffsetDays: 0 } },
];

/** Which "Quais turnos olhar" option a rule is on; "days" for any other relative range (edited under "Dias atrás…"). */
function periodChoiceOf(s: RuleSettings): string {
  if (s.dateMode === "month") return "month";
  if (s.dateMode === "fixed") return "fixed";
  const hit = PERIOD_CHOICES.find((p) => p.settings.dateMode === "relative" && p.settings.startOffsetDays === s.startOffsetDays && p.settings.endOffsetDays === s.endOffsetDays);
  return hit ? hit.key : "days";
}

/** "Hoje", "Ontem", "Hoje e ontem", "Últimos 7 dias", "De 7 a 2 dias atrás" — a relative range in a few words. */
function relativeText(s: RuleSettings): string {
  const t = resolveReimportConfigLabel({ label: "", dateMode: "relative", startOffsetDays: s.startOffsetDays, endOffsetDays: s.endOffsetDays });
  return /^\d/.test(t) ? `De ${t}` : t;
}

/** "hoje", "mês atual", "últimos 30 dias", "01/nov/26 a 30/nov/26", "planilha inteira" — the rule's period in a few words. */
function periodText(s: RuleSettings): string {
  if (s.dateMode === "month") return "mês atual";
  if (s.dateMode === "relative") return relativeText(s).toLowerCase();
  if (!s.periodStart && !s.periodEnd) return "planilha inteira";
  return `${s.periodStart ? formatDateAbbrevYY(s.periodStart) : "início"} a ${s.periodEnd ? formatDateAbbrevYY(s.periodEnd) : "fim"}`;
}

/** "De [N] até [M] dias atrás" for "Dias atrás…": saves on every valid change (start ≥ end), keeps an invalid draft local.
 *  Only it changes the offsets while open, so the draft isn't re-synced from props (a slow save would overwrite what's being typed);
 *  it is keyed by rule so another rule starts fresh. */
function RelativeDaysFields({ start, end, onChange, disabled = false }: { start: number; end: number; onChange: (start: number, end: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState({ start: String(start), end: String(end) });
  const parse = (v: string) => (/^\d{1,3}$/.test(v) ? Number(v) : null);
  const a = parse(draft.start);
  const b = parse(draft.end);
  const invalid = a === null || b === null || b > a;
  function edit(next: { start: string; end: string }) {
    setDraft(next);
    const na = parse(next.start);
    const nb = parse(next.end);
    if (na !== null && nb !== null && nb <= na && (na !== start || nb !== end)) onChange(na, nb);
  }
  return (
    <div className="rv-days">
      <div className="rv-days-row">
        De
        <input className="rv-days-input" type="number" inputMode="numeric" min={0} max={999} aria-label="Início, em dias atrás" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} value={draft.start} onChange={(e) => edit({ ...draft, start: e.target.value })} />
        até
        <input className="rv-days-input" type="number" inputMode="numeric" min={0} max={999} aria-label="Fim, em dias atrás" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} value={draft.end} onChange={(e) => edit({ ...draft, end: e.target.value })} />
        dias atrás
      </div>
      {invalid && <span className="rv-days-error">O início precisa ser igual ou maior que o fim (ex.: de 7 até 0).</span>}
      <div className="rv-days-presets">
        <span className="rv-small">Atalhos:</span>
        {[
          ["Ontem", 1, 1],
          ["Hoje e ontem", 1, 0],
          ["7 dias", 7, 0],
          ["60 dias", 60, 0],
        ].map(([label, ps, pe]) => (
          <button key={label} type="button" className="rv-days-preset" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onClick={() => edit({ start: String(ps), end: String(pe) })}>
            {label}
          </button>
        ))}
      </div>
      <span className="rv-small">0 = hoje. “De 7 até 0” pega a última semana inteira até hoje.</span>
    </div>
  );
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

/** " · por Maria e Carlos" — who saved the versions these changes came from; "" when nobody is known. */
function byWhom(rows: CheckDiffRow[]): string {
  const names = Array.from(new Set(rows.map((r) => r.savedBy?.trim()).filter((n): n is string => Boolean(n))));
  if (names.length === 0) return "";
  if (names.length === 1) return ` · por ${names[0]}`;
  const first = names.map((n) => n.split(/\s+/)[0]);
  return ` · por ${first.slice(0, -1).join(", ")} e ${first[first.length - 1]}`;
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
  // View-only in Verificação automática: rules, toggles and checks are off.
  const readOnly = useReadOnly();
  const roTitle = readOnly ? READ_ONLY_TITLE : undefined;
  // Accepting a change, deleting a turno or reimporting writes to Pagamentos.
  const { canEdit, canView } = useAccess();
  const canPay = canEdit("pagamentos");
  const payTitle = canPay ? undefined : NO_PAYMENT_EDIT_TITLE;
  // "Visto"/"Ignorar" is allowed with "Editar" in either area.
  const canDismiss = !readOnly || canPay;
  const dismissTitle = canDismiss ? undefined : READ_ONLY_TITLE;
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
  // "Dias atrás…" stays open while its fields are edited, even if they land on a shortcut (0 a 0 = Hoje).
  const [daysEditing, setDaysEditing] = useState(false);
  function openSheet(next: Sheet) {
    setActionError(null);
    setDaysEditing(false);
    setSheet(next);
  }

  // Deep link (e.g. a rule clicked on Templates de pagamento): opens that
  // rule's sheet once the configs are loaded, then clears the state so a
  // reload or back doesn't reopen it.
  const location = useLocation();
  useEffect(() => {
    const configId = (location.state as { openConfigId?: number } | null)?.openConfigId;
    if (configId === undefined || !reimportConfigs.some((c) => c.id === configId)) return;
    navigate(location.pathname, { replace: true, state: null });
    openSheet({ kind: "rule", configId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, reimportConfigs]);

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
        text: `${n} ${n === 1 ? "mudança encontrada" : "mudanças encontradas"} ${ago(c.lastCheckedAt, now)}${byWhom(pending)}`,
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
        text: `${n} ${n === 1 ? "mudança aplicada" : "mudanças aplicadas"} sozinho ${ago(c.lastCheckedAt, now)}${byWhom(applied)}`,
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
      setCheckReload((n) => n + 1);
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
  const [checkReload, setCheckReload] = useState(0);
  useEffect(() => {
    if (sheet?.kind !== "check") return;
    setCheckDiffs(null);
    listCheckDiffs(sheet.entry.id)
      .then((rows) => setCheckDiffs(rows.filter((r) => r.configId === sheet.configId)))
      .catch(() => setCheckDiffs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, checkReload]);

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
    const open = () => (c ? openSheet({ kind: "rule", configId: c.id }) : !readOnly && openNewRule(file.sourceUrl));
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
        {status?.action ?? (c ? <span className="rv-every">{c.checkDisabled ? "" : everyText(c.checkIntervalMinutes)}</span> : !readOnly && (
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
  function renderRuleFields(s: RuleSettings, onChange: (patch: Partial<RuleSettings>) => void, ruleKey: string, disabled = false) {
    const title = disabled ? READ_ONLY_TITLE : undefined;
    const periodChoice = periodChoiceOf(s);
    const daysOpen = periodChoice === "days" || (daysEditing && s.dateMode === "relative");
    const customInterval = !INTERVAL_CHOICES.includes(s.checkIntervalMinutes);
    return (
      <>
        <div className="rv-field">
          <span className="rv-label">Conferir a cada</span>
          <div className="rv-chips">
            {INTERVAL_CHOICES.map((m) => (
              <button key={m} type="button" className="rv-chip" aria-pressed={s.checkIntervalMinutes === m} disabled={disabled} title={title} onClick={() => onChange({ checkIntervalMinutes: m })}>
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
              <button key={p.key} type="button" className="rv-chip" aria-pressed={periodChoice === p.key} disabled={disabled} title={title} onClick={() => (setDaysEditing(false), onChange(p.settings))}>
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className="rv-chip"
              aria-pressed={daysOpen}
              disabled={disabled}
              title={title}
              onClick={() => {
                setDaysEditing(true);
                if (s.dateMode !== "relative") onChange({ dateMode: "relative", periodStart: null, periodEnd: null, startOffsetDays: 7, endOffsetDays: 0 });
              }}
            >
              {periodChoice === "days" ? relativeText(s) : "Dias atrás…"}
            </button>
            <button
              type="button"
              className="rv-chip"
              aria-pressed={periodChoice === "fixed"}
              disabled={disabled}
              title={title}
              onClick={() => (setDaysEditing(false), onChange({ dateMode: "fixed", startOffsetDays: null, endOffsetDays: null, periodStart: s.periodStart, periodEnd: s.periodEnd }))}
            >
              Período fixo…
            </button>
          </div>
          {daysOpen && <RelativeDaysFields key={ruleKey} start={s.startOffsetDays ?? 0} end={s.endOffsetDays ?? 0} onChange={(start, end) => onChange({ startOffsetDays: start, endOffsetDays: end })} disabled={disabled} />}
          {periodChoice === "fixed" && (
            // DateRangePicker has no `disabled`; a disabled fieldset turns off its controls.
            <fieldset disabled={disabled} title={title} style={{ display: "contents" }}>
              <DateRangePicker startValue={s.periodStart ?? ""} endValue={s.periodEnd ?? ""} onChange={(start, end) => onChange({ periodStart: start || null, periodEnd: end || null })} fullWidth />
            </fieldset>
          )}
          <span className="rv-small">Hoje isso é {todayRange(s)}.</span>
        </div>

      </>
    );
  }

  function renderRuleSheet(c: ReimportConfig) {
    const s = settingsOf(c);
    const file = fileOf(c.sourceUrl);
    const { error } = rowsFor(c);
    const errorMessage = error?.message || (file?.lastResult === "error" ? file.lastErrorMessage : null);
    return (
      <div className="rv-sheet">
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
              <button type="button" className="settings-button settings-button-primary" onClick={() => forceCheckConfig(c.id)} disabled={readOnly || checkingConfigIds.has(c.id)} title={roTitle}>
                {checkingConfigIds.has(c.id) ? "Conferindo..." : "Tentar de novo"}
              </button>
              {error && (
                <button type="button" className="settings-button settings-button-ghost" disabled={!canDismiss} title={dismissTitle} onClick={() => withBusy(`e${error.id}`, () => dismissCheckDiffs([error.id]))}>
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
          <input type="checkbox" role="switch" className="settings-switch" checked={!c.checkDisabled} disabled={readOnly} title={roTitle} onChange={() => toggleRule(c)} />
        </label>

        {renderRuleFields(s, (patch) => saveRule(c, patch), `rule-${c.id}`, readOnly)}

        <div className={moreOpen ? "rv-more rv-more-open" : "rv-more"}>
          <button type="button" className="rv-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            <span className="rv-more-icon" aria-hidden="true">
              <SlidersHorizontal size={15} />
            </span>
            <span className="rv-text">
              <span className="rv-more-title">Mais detalhes</span>
              <span className="rv-more-desc">Turnos editados à mão, modelo, histórico e ações</span>
            </span>
            <ChevronDown size={16} className="rv-more-chevron" aria-hidden="true" />
          </button>

          {moreOpen && (
            <div className="rv-more-body">
              <section className="rv-more-section">
                <span className="rv-section-label">Turnos editados à mão</span>
                <div className="rv-opts">
                  <label className="rv-opts-row">
                    <span className="rv-text">
                      <span className="rv-opts-title">Manter ao reimportar</span>
                      <span className="rv-opts-desc">Vale para “Reimportar agora”, abaixo.</span>
                    </span>
                    <input type="checkbox" role="switch" className="settings-switch" checked={c.keepManualEdits} disabled={readOnly} title={roTitle} onChange={(e) => saveRule(c, { keepManualEdits: e.target.checked })} />
                  </label>
                </div>
              </section>

              <section className="rv-more-section">
                <span className="rv-section-label">Modelo da planilha</span>
                <div className="rv-opts">
                  {c.templateName !== null && canView("pagamentos") ? (
                    // Opens the template's editor on Templates de pagamento.
                    <button
                      type="button"
                      className="rv-opts-row rv-history-row"
                      onClick={() => navigate("/import/payments/templates", { state: { openTemplateId: c.templateId } })}
                      title="Abrir o template"
                    >
                      <span className="rv-more-icon" aria-hidden="true">
                        <FileSpreadsheet size={15} />
                      </span>
                      <span className="rv-text">
                        <span className="rv-opts-title">{c.templateName}</span>
                        <span className="rv-opts-desc">Para usar outro modelo, crie uma nova regra.</span>
                      </span>
                      <ChevronRight size={16} className="muted" aria-hidden="true" />
                    </button>
                  ) : (
                    <div className="rv-opts-row">
                      <span className="rv-more-icon" aria-hidden="true">
                        <FileSpreadsheet size={15} />
                      </span>
                      <span className="rv-text">
                        <span className="rv-opts-title">{c.templateName ?? "Modelo removido"}</span>
                        <span className="rv-opts-desc">Para usar outro modelo, crie uma nova regra.</span>
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section className="rv-more-section">
                <span className="rv-section-label">
                  Últimas verificações
                  {history && history.length > 0 && <span className="rv-section-count">{history.length} mais recentes</span>}
                </span>
                {history === null && <span className="rv-small">Carregando...</span>}
                {history?.length === 0 && <span className="rv-small">Ainda não foi conferida.</span>}
                {history && history.length > 0 && (
                  <div className="rv-opts">
                    {history.map((entry) => {
                      const tone: Tone = entry.result === "error" || entry.hasOwnError ? "bad" : entry.diffCount > 0 ? "warn" : entry.result === "unknown" ? "off" : "ok";
                      const text =
                        tone === "bad"
                          ? "Erro"
                          : entry.diffCount > 0
                            ? `${entry.diffCount} ${entry.diffCount === 1 ? "mudança" : "mudanças"}`
                            : entry.result === "unknown"
                              ? "Não deu pra saber"
                              : "Sem mudanças";
                      const author = entry.diffCount > 0 && entry.savedAt ? entry.savedBy?.trim() || "Sem nome no arquivo" : null;
                      return (
                        <button key={entry.id} type="button" className="rv-opts-row rv-history-row" onClick={() => openSheet({ kind: "check", configId: c.id, entry })}>
                          <i className={`rv-dot rv-dot-${tone}`} aria-hidden="true" />
                          <span className="rv-text">
                            <span className="rv-history-line">
                              <span className="rv-history-when">{formatDateTimeAbbrevYY(entry.checkedAt)}</span>
                              <span className={`rv-history-result rv-history-result-${tone}`}>{text}</span>
                            </span>
                            {author && (
                              <span className="rv-history-author">
                                <span className="rv-avatar rv-avatar-xs" style={{ background: entry.savedBy ? colorForName(author) : "#3a3a42" }} aria-hidden="true">
                                  {entry.savedBy ? initials(author) : "?"}
                                </span>
                                <span className="rv-history-author-text">
                                  salva por {author} {savedWhen(entry.savedAt)}
                                </span>
                              </span>
                            )}
                          </span>
                          <ChevronRight size={15} className="rv-chevron" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <div className="rv-more-actions">
                <button type="button" className="settings-button" onClick={() => forceCheckConfig(c.id)} disabled={readOnly || checkingConfigIds.has(c.id)} title={roTitle}>
                  <RefreshCw size={13} />
                  {checkingConfigIds.has(c.id) ? "Conferindo..." : "Conferir agora"}
                </button>
                <button type="button" className="settings-button" disabled={!canPay} title={payTitle} onClick={() => reprocess(c.id, resolveReimportPeriod(s).start, resolveReimportPeriod(s).end)}>
                  Reimportar agora
                </button>
                {!readOnly && (
                  <button type="button" className="settings-button settings-button-ghost" onClick={() => openNewRule(c.sourceUrl)}>
                    <Plus size={13} />
                    Outra regra para esta planilha
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderFileSheet(sourceUrl: string) {
    const configs = configsByUrl.get(sourceUrl) ?? [];
    return (
      <div className="rv-sheet">
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
        {!readOnly && (
          <button type="button" className="settings-button" style={{ alignSelf: "flex-start" }} onClick={() => openNewRule(sourceUrl)}>
            + Nova regra para esta planilha
          </button>
        )}
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
        {renderRuleFields(newRule, (patch) => setNewRule((r) => ({ ...r, ...patch })), "new")}
      </div>
    );
  }

  const [reviewFilter, setReviewFilter] = useState<string>("all");
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [authorInfoOpen, setAuthorInfoOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    setReviewFilter("all");
    setAuthorFilter(null);
    setAuthorInfoOpen(false);
    setMoreOpen(false);
  }, [sheet?.kind, sheetConfigId]);

  /** "Quem alterou a planilha": each person who saved a version with these changes; a click filters to theirs. */
  function renderAuthors(rows: CheckDiffRow[]) {
    const authors = new Map<string, { name: string; count: Set<string>; lastAt: string | null }>();
    for (const r of rows) {
      const key = authorKey(r);
      if (!key) continue;
      const entry = authors.get(key) ?? { name: key, count: new Set<string>(), lastAt: null };
      entry.count.add(r.changeKind === "field" && r.matchedShiftId !== null ? `s${r.matchedShiftId}` : `d${r.id}`);
      if (r.savedAt && (!entry.lastAt || r.savedAt > entry.lastAt)) entry.lastAt = r.savedAt;
      authors.set(key, entry);
    }
    if (authors.size === 0) return null;
    return (
      <div className="rv-authors">
        <div className="rv-authors-head">
          <span className="rv-section-label">Quem alterou a planilha</span>
          <button type="button" className="rv-link" aria-expanded={authorInfoOpen} onClick={() => setAuthorInfoOpen((v) => !v)}>
            Como sabemos?
          </button>
        </div>
        {authorInfoOpen && (
          <p className="rv-authors-info">
            O Excel guarda quem salvou a planilha por último. A cada conferência, o Tá Pago anota esse nome junto com as mudanças daquela versão. Se duas pessoas
            salvarem entre uma conferência e outra, aparece só a última. “{UNNAMED_AUTHOR}” é quando a planilha foi salva por um programa que não grava o nome.
          </p>
        )}
        <div className="rv-author-list">
          {Array.from(authors.values()).map((a) => {
            const unnamed = a.name === UNNAMED_AUTHOR;
            const n = a.count.size;
            return (
              <button key={a.name} type="button" className="rv-author" aria-pressed={authorFilter === a.name} onClick={() => setAuthorFilter((cur) => (cur === a.name ? null : a.name))}>
                <span className="rv-avatar rv-avatar-sm" style={{ background: unnamed ? "#3a3a42" : colorForName(a.name) }} aria-hidden="true">
                  {unnamed ? "?" : initials(a.name)}
                </span>
                <span className="rv-author-text">
                  <b>{a.name}</b>
                  <span>
                    {n} {n === 1 ? "mudança" : "mudanças"}
                    {a.lastAt && ` · salvou ${savedWhen(a.lastAt)}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

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
    const shown = rows
      .filter((r) => reviewFilter === "all" || r.changeKind === reviewFilter)
      .filter((r) => authorFilter === null || authorKey(r) === authorFilter);
    const counts = (k: string) => countItems(rows.filter((r) => r.changeKind === k));
    return (
      <div className="rv-sheet rv-sheet-tight">
        {mode === "applied" && (
          <div className="rv-banner rv-banner-info">
            <strong>Aplicado sozinho</strong>
            <span>Gravadas pela versão desktop, que aplicava mudanças sozinha. Nada aqui precisa de você; é só pra conferir.</span>
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
        {renderAuthors(rows)}
        {actionError && <div className="error-box">{actionError}</div>}
        <ChangeCards
          canDismiss={canDismiss}
          canChange={canPay}
          rows={shown}
          configFor={() => c}
          stateOf={() => (mode === "applied" ? "applied" : "pending")}
          busyKeys={busyKeys}
          run={withBusy}
          onDeleteShift={setDeleteShiftTarget}
          onReprocess={reprocess}
        />
      </div>
    );
  }

  // ---- sheet chrome ----
  const sheetConfig = sheetConfigId !== null ? reimportConfigs.find((c) => c.id === sheetConfigId) : undefined;
  const reviewConfig = sheet?.kind === "review" ? reimportConfigs.find((c) => c.id === sheet.configId) : undefined;
  let sheetTitle = "";
  /** The line under the title: which rule, a way back, or the link. */
  let sheetSub: ReactNode = null;
  /** The spreadsheet these sheets are about, shown as its icon in the header. */
  let sheetFileName: string | null = null;
  let sheetBody: ReactNode = null;
  let sheetFooter: ReactNode = null;

  const linkTo = (url: string) => (
    <button type="button" className="rv-link" onClick={() => openUrl(url)}>
      Abrir link <ExternalLink size={11} />
    </button>
  );
  /** "Regra: Modelo Atlas · mês atual · ver as outras regras" when the spreadsheet has several rules. */
  const ruleSub = (c: ReimportConfig, extra?: string) => {
    const siblings = configsByUrl.get(c.sourceUrl) ?? [];
    if (siblings.length < 2) return extra ? <>{extra}</> : linkTo(c.sourceUrl);
    return (
      <>
        Regra: {ruleName(c)} · {periodText(settingsOf(c))}
        {extra ? ` · ${extra}` : ""} ·{" "}
        <button type="button" className="rv-link" onClick={() => openSheet({ kind: "file", sourceUrl: c.sourceUrl })}>
          ver as outras regras
        </button>
      </>
    );
  };

  if (sheet?.kind === "rule" && sheetConfig) {
    const file = fileOf(sheetConfig.sourceUrl);
    const siblings = configsByUrl.get(sheetConfig.sourceUrl) ?? [];
    sheetTitle = file?.fileName ?? "Planilha";
    sheetFileName = sheetTitle;
    sheetSub = ruleSub(sheetConfig);
    sheetBody = renderRuleSheet(sheetConfig);
    sheetFooter = (
      <>
        {siblings.length > 1 ? (
          <button type="button" className="settings-button settings-button-danger" disabled={readOnly} title={roTitle} onClick={() => setDeleteRuleTarget(sheetConfig)}>
            Excluir esta regra…
          </button>
        ) : (
          file && (
            <button type="button" className="settings-button settings-button-danger" disabled={readOnly} title={roTitle} onClick={() => setUntrackTarget(file)}>
              Parar de acompanhar…
            </button>
          )
        )}
        <span className="rv-footer-note">
          {readOnly ? READ_ONLY_TITLE : saveError ? <span className="settings-text-danger">{saveError}</span> : savingConfigId === sheetConfig.id ? "Salvando..." : "Salvo automaticamente"}
        </span>
      </>
    );
  } else if (sheet?.kind === "file") {
    const file = fileOf(sheet.sourceUrl);
    sheetTitle = file?.fileName ?? "Planilha";
    sheetFileName = sheetTitle;
    sheetSub = linkTo(sheet.sourceUrl);
    sheetBody = renderFileSheet(sheet.sourceUrl);
    sheetFooter = file && (
      <button type="button" className="settings-button settings-button-danger" disabled={readOnly} title={roTitle} onClick={() => setUntrackTarget(file)}>
        Parar de acompanhar…
      </button>
    );
  } else if (sheet?.kind === "new-rule") {
    const file = fileOf(sheet.sourceUrl);
    sheetTitle = "Nova regra";
    sheetFileName = file?.fileName ?? null;
    sheetSub = file?.fileName;
    sheetBody = (
      <>
        {renderNewRuleSheet()}
        {actionError && <div className="error-box">{actionError}</div>}
      </>
    );
    sheetFooter = (
      <>
        <button type="button" className="settings-button settings-button-ghost" onClick={() => setSheet(null)}>
          Cancelar
        </button>
        <button type="button" className="settings-button settings-button-primary" onClick={() => handleCreateRule(sheet.sourceUrl)} disabled={readOnly || creating} title={roTitle}>
          {creating ? "Criando..." : "Criar regra"}
        </button>
      </>
    );
  } else if (sheet?.kind === "review" && reviewConfig) {
    const { pending, applied } = rowsFor(reviewConfig);
    const rows = sheet.mode === "pending" ? pending : applied;
    const n = countItems(rows);
    const file = fileOf(reviewConfig.sourceUrl);
    sheetTitle =
      sheet.mode === "applied"
        ? `${n} ${n === 1 ? "mudança aplicada" : "mudanças aplicadas"} sozinho`
        : n
          ? `${n} ${n === 1 ? "mudança para revisar" : "mudanças para revisar"}`
          : "Tudo revisado";
    const siblings = configsByUrl.get(reviewConfig.sourceUrl) ?? [];
    sheetSub = `${file?.fileName ?? ""}${siblings.length > 1 ? ` · ${ruleName(reviewConfig)}` : ""} · encontradas ${ago(reviewConfig.lastCheckedAt, now)}`;
    sheetBody = renderReview(reviewConfig, sheet.mode);
    const fieldShifts = new Set(pending.filter((r) => r.changeKind === "field" && r.matchedShiftId !== null).map((r) => r.matchedShiftId)).size;
    sheetFooter =
      sheet.mode === "applied" ? (
        <>
          <span className="rv-footer-note">Ao confirmar, essas mudanças saem da lista.</span>
          <button type="button" className="settings-button settings-button-primary" disabled={!canDismiss || busyKeys.has("seen") || rows.length === 0} title={dismissTitle} onClick={() => withBusy("seen", () => dismissCheckDiffs(rows.map((r) => r.id)))}>
            Ok, entendi
          </button>
        </>
      ) : (
        <>
          <span className="rv-footer-note">{n ? `${n} restantes` : "Nada pendente"}</span>
          <button type="button" className="settings-button settings-button-primary" disabled={!canPay || fieldShifts === 0 || busyKeys.has("all")} title={payTitle} onClick={() => applyAll(reviewConfig, pending)}>
            {busyKeys.has("all") ? "Aplicando..." : `Aplicar as alterações (${fieldShifts})`}
          </button>
        </>
      );
  } else if (sheet?.kind === "check" && sheetConfig) {
    // A past check, with the same cards as "Revisar": still pending ones keep
    // their actions, the rest say what happened to them.
    const file = fileOf(sheetConfig.sourceUrl);
    sheetTitle = `Verificação de ${formatDateTimeAbbrevYY(sheet.entry.checkedAt)}`;
    sheetFileName = file?.fileName ?? null;
    sheetSub = (
      <button type="button" className="rv-link" onClick={() => openSheet({ kind: "rule", configId: sheetConfig.id })}>
        ← Voltar para a regra
      </button>
    );
    const changes = (checkDiffs ?? []).filter((r) => r.changeKind !== "error");
    const errors = (checkDiffs ?? []).filter((r) => r.changeKind === "error");
    const cardState = (cardRows: CheckDiffRow[]): "pending" | "applied" | "seen" =>
      cardRows.every((r) => r.applied) ? "applied" : cardRows.every((r) => r.dismissedAt !== null) ? "seen" : "pending";
    sheetBody = (
      <div className="rv-sheet rv-sheet-tight">
        {(sheet.entry.message || errors.length > 0) && (
          <div className="rv-banner rv-banner-bad">
            <strong>Não deu pra conferir nesta verificação</strong>
            <span>{sheet.entry.message || errors.map((e) => e.message).filter(Boolean).join(" ")}</span>
          </div>
        )}
        {sheet.entry.savedAt && changes.length > 0 && (
          <p className="rv-muted rv-check-author">
            Planilha salva por <b>{sheet.entry.savedBy?.trim() || "alguém sem nome no arquivo"}</b> {savedWhen(sheet.entry.savedAt)}.
          </p>
        )}
        {actionError && <div className="error-box">{actionError}</div>}
        {checkDiffs === null && <p className="rv-muted">Carregando...</p>}
        {checkDiffs !== null && changes.length === 0 && !sheet.entry.message && errors.length === 0 && <p className="rv-muted">Nenhuma mudança nesta verificação.</p>}
        <ChangeCards
          canDismiss={canDismiss}
          canChange={canPay}
          rows={changes}
          configFor={() => sheetConfig}
          stateOf={cardState}
          busyKeys={busyKeys}
          run={withBusy}
          onDeleteShift={setDeleteShiftTarget}
          onReprocess={reprocess}
        />
      </div>
    );
  }

  const sheetHeader = sheet ? (
    <div className="rv-drawer-head">
      {sheetFileName && fileIcon(sheetFileName)}
      <div className="rv-text">
        <span className="rv-drawer-title">{sheetTitle}</span>
        {sheetSub && <span className="rv-drawer-sub">{sheetSub}</span>}
      </div>
    </div>
  ) : null;

  const files = trackedFiles;

  return (
    <div className="rv-page">
      <PageHeader
        title="Verificação automática"
        subtitle="Planilhas importadas por link que o Tá Pago confere sozinho."
        actions={
          files.length > 0 && (
            <button type="button" className="settings-button" onClick={handleForceCheckAll} disabled={readOnly || forcingAll} title={roTitle}>
              <RefreshCw size={14} className={forcingAll ? "ai-spin" : undefined} />
              {forcingAll ? "Conferindo..." : "Verificar agora"}
            </button>
          )
        }
      />

      {tickError && <div className="error-box">Não deu pra conferir as planilhas: {tickError}</div>}

      {files.length === 0 ? (
        <div className="rv-empty">
          <span className="rv-empty-icon" aria-hidden="true">
            <RefreshCw size={20} />
          </span>
          <strong>Nenhuma planilha acompanhada ainda</strong>
          <span className="rv-empty-lead">Quando uma planilha de pagamento vem de um link (OneDrive, SharePoint ou link direto), o Tá Pago pode conferir sozinho se ela mudou.</span>
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
          {canPay && (
            <button type="button" className="settings-button settings-button-primary" onClick={() => navigate("/import/payments")}>
              Ir para Importar Pagamentos
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="rv-list">
            {files.map((f) => {
              const configs = configsByUrl.get(f.sourceUrl) ?? [];
              return configs.length > 1 ? renderGroup(f, configs) : renderSingle(f, configs[0]);
            })}
          </div>
          {canPay && (
            <p className="rv-hint">
              Para acompanhar outra planilha, importe-a por link em{" "}
              <button type="button" className="rv-link" onClick={() => navigate("/import/payments")}>
                Importar Pagamentos
              </button>{" "}
              e marque “Rastrear atualizações automaticamente”.
            </p>
          )}
        </>
      )}

      <Drawer
        open={sheet !== null && sheetBody !== null}
        onClose={() => setSheet(null)}
        title={sheetTitle}
        header={sheetHeader}
        width="min(480px, calc(100vw - 24px))"
        footer={sheetFooter ? <div className="rv-footer">{sheetFooter}</div> : undefined}
      >
        {sheetBody}
      </Drawer>

      {untrackTarget && (
        <ConfirmModal
          title="Parar de acompanhar esta planilha?"
          message={`O Tá Pago deixa de conferir “${untrackTarget.fileName}” e apaga as regras e o histórico de verificações dela. Os turnos já importados não mudam.`}
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
          message={`O turno${deleteShiftTarget.who ? ` de ${formatPersonName(deleteShiftTarget.who)}` : ""} saiu da planilha e vai ser excluído do Tá Pago também.`}
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
