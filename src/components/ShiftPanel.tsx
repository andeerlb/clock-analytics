import ExtraColumnsList from "./ExtraColumnsList";
import { extraColumnEntries } from "../lib/extraColumns";
import {
  AlertTriangle,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronLeft,
  Clock,
  Copy,
  CreditCard,
  History,
  Link2,
  MapPin,
  Moon,
  Info,
  Pencil,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  addEmployeePixKey,
  getPaymentShiftHistory,
  listEmployeePixKeys,
  type EffectivePaymentRules,
  type EmployeePixKeyRow,
  type ShiftFieldDiffRow,
} from "../lib/db";
import {
  centsMaskToAmount,
  classifyShiftPeriod,
  describePaymentValueRule,
  diffFieldLabel,
  formatCurrencyBRL,
  formatDate,
  formatDateSlash,
  formatDateTime,
  formatDateTimeAbbrevYY,
  formatMinutesAsTime,
  matchingPaymentValueRuleIndex,
  parseTimeToMinutes,
  scheduleDurationMinutes,
  shiftValue,
} from "../lib/format";
import { detectPixKeyType, PIX_KEY_TYPE_LABELS, PIX_KEY_TYPES, type PixKeyType } from "../lib/pix";
import { useAccess } from "../contexts/AuthContext";
import type { PaymentShiftRow, PaymentShiftStatus, ShiftPeriod } from "../lib/types";
import { READ_ONLY_TITLE, useReadOnly } from "./AreaRoute";
import Avatar from "./Avatar";
import CurrencyInput from "./CurrencyInput";
import DatePicker from "./DatePicker";
import SidePanel from "./SidePanel";
import TimeField from "./TimeField";

export type ShiftPanelTab = "pay" | "data" | "history";

/** The fields "Dados" saves — same shape `editPaymentShift` takes. */
export interface ShiftEditFields {
  workDate: string;
  local: string;
  role: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  amount: number | null;
}

/** A payment confirmed from this panel — remembered so the paid state can say which PIX key was used (that isn't stored with the shift). */
export interface LastPayment {
  shiftId: number;
  pixKey: EmployeePixKeyRow | null;
}

const STATUS_BADGE: Record<PaymentShiftStatus, { className: string; label: string }> = {
  pendente: { className: "badge overwrite", label: "Pendente" },
  erro: { className: "badge file-error", label: "Erro" },
  pago: { className: "badge ok", label: "Pago" },
};

function scheduleText(s: { scheduleStartMinutes: number | null; scheduleEndMinutes: number | null }): string | null {
  if (s.scheduleStartMinutes === null || s.scheduleEndMinutes === null) return null;
  return `${formatMinutesAsTime(s.scheduleStartMinutes)} – ${formatMinutesAsTime(s.scheduleEndMinutes)}`;
}

function weekday(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
}

/** Diurno/noturno by the company's night window — `null` without an horário or rules. */
function shiftPeriodOf(shift: PaymentShiftRow, rules: EffectivePaymentRules | null): ShiftPeriod | null {
  if (!rules || shift.scheduleStartMinutes === null || shift.scheduleEndMinutes === null) return null;
  const nightStart = parseTimeToMinutes(rules.nightStartTime);
  const nightEnd = parseTimeToMinutes(rules.nightEndTime);
  if (nightStart === null || nightEnd === null) return null;
  return classifyShiftPeriod(rules.nightShiftRule, nightStart, nightEnd, shift.scheduleStartMinutes, shift.scheduleEndMinutes);
}

/** "6h", "7h30" — a duration, so it doesn't read as a clock time like "06:00" does. */
function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m ? String(m).padStart(2, "0") : ""}`;
}

function StripItem({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="sa-strip-item" title={label}>
      <Icon size={13} aria-hidden="true" />
      <span className="sr-only">{label}: </span>
      <span>{children}</span>
    </div>
  );
}

/** Which turno the panel is about — the same strip on every tab. */
function ShiftStrip({ shift, period }: { shift: PaymentShiftRow; period: ShiftPeriod | null }) {
  const badge = STATUS_BADGE[shift.status];
  const duration = scheduleDurationMinutes(shift);
  const schedule = scheduleText(shift);
  return (
    <div className="sa-strip">
      <div className="sa-strip-head">
        <Avatar name={shift.employeeName} />
        <span className="sa-strip-name">{shift.employeeName}</span>
        <span className={badge.className}>{badge.label}</span>
      </div>
      <div className="sa-strip-grid">
        <StripItem icon={CalendarDays} label="Data">
          {weekday(shift.workDate)}, {formatDateSlash(shift.workDate)}
        </StripItem>
        <StripItem icon={period === "noturno" ? Moon : period === "diurno" ? Sun : Clock} label="Horário">
          {schedule ? (
            <>
              {schedule}
              <span className="muted">
                {duration !== null ? ` · ${durationText(duration)}` : ""}
                {period ? ` · ${period === "noturno" ? "Noturno" : "Diurno"}` : ""}
              </span>
            </>
          ) : (
            <span className="muted">Sem horário</span>
          )}
        </StripItem>
        <StripItem icon={MapPin} label="Local">
          {shift.local || <span className="muted">Sem local</span>}
        </StripItem>
        <StripItem icon={BriefcaseBusiness} label="Função">
          {shift.role || <span className="muted">Sem função</span>}
        </StripItem>
      </div>
    </div>
  );
}

/** "Cadastrar" / "+ Nova chave" on the Pagamento tab: one field, the type is guessed (and can be corrected),
 *  Enter saves to the employee and hands back the fresh list with the new key's index; an existing key is just selected. */
function PixKeyForm({
  employeeId,
  firstName,
  keys,
  onDone,
  onCancel,
}: {
  employeeId: number;
  firstName: string;
  keys: EmployeePixKeyRow[];
  onDone: (keys: EmployeePixKeyRow[], index: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [typeOverride, setTypeOverride] = useState<PixKeyType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const type = typeOverride ?? (trimmed ? detectPixKeyType(trimmed) : null);
  const dupIndex = trimmed ? keys.findIndex((k) => k.keyValue.trim().toLowerCase() === trimmed.toLowerCase()) : -1;

  async function save() {
    if (!trimmed || busy) return;
    if (dupIndex >= 0) return onDone(keys, dupIndex);
    setBusy(true);
    setError(null);
    try {
      await addEmployeePixKey(employeeId, trimmed, type ?? undefined);
      const fresh = await listEmployeePixKeys(employeeId);
      onDone(fresh, Math.max(0, fresh.findIndex((k) => k.keyValue === trimmed)));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }

  return (
    <div className="sa-pix-form">
      <label className="sa-slip-label" htmlFor="shift-pix-new">
        Nova chave PIX de {firstName}
      </label>
      <input
        id="shift-pix-new"
        className="sa-pix-input"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="Cole a chave: CPF, telefone, e-mail ou aleatória"
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            // Only closes the form, not the whole panel.
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="sa-pix-types">
        <span className="sa-pix-types-hint">{!typeOverride && type ? "Reconhecida como:" : "Tipo:"}</span>
        {PIX_KEY_TYPES.map((t) => (
          <button key={t} type="button" className="sa-pix-type" aria-pressed={type === t} disabled={busy} onClick={() => setTypeOverride(t)}>
            {PIX_KEY_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      {error ? (
        <span className="sa-pix-warn sa-pix-warn-bad">{error}</span>
      ) : dupIndex >= 0 ? (
        <span className="sa-pix-warn">Essa chave já está no cadastro ({PIX_KEY_TYPE_LABELS[keys[dupIndex].keyType]}).</span>
      ) : (
        type === "other" && !typeOverride && <span className="sa-pix-warn">Não reconheci o formato. Confira a chave ou escolha o tipo.</span>
      )}
      <div className="sa-pix-form-actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="button" onClick={save} disabled={!trimmed || busy}>
          {busy ? "Salvando…" : dupIndex >= 0 ? "Usar esta chave" : "Salvar chave"}
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? "sa-copy sa-copy-done" : "sa-copy"}
      aria-label={label}
      disabled={!text}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

function Notice({ tone, icon: Icon, children }: { tone: "warn" | "danger" | "info"; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className={`sa-notice sa-notice-${tone}`}>
      <Icon size={15} />
      <div>{children}</div>
    </div>
  );
}

function ChangeList({ changes }: { changes: ShiftFieldDiffRow[] }) {
  return (
    <div className="sa-diff">
      {changes.map((c, i) =>
        c.changeKind === "removed" ? (
          <div key={i}>{c.message ?? "Não encontrado na fonte."}</div>
        ) : (
          <div key={i}>
            {diffFieldLabel(c.fieldName, c.columnLetter)}: <s>{c.oldValue ?? "—"}</s> → <strong>{c.newValue ?? "—"}</strong>
          </div>
        ),
      )}
    </div>
  );
}

/** Where the suggested Valor comes from, in words. */
function valueOrigin(shift: PaymentShiftRow, rules: EffectivePaymentRules | null): string {
  if (shift.amount !== null) return "Valor registrado no turno";
  const duration = scheduleDurationMinutes(shift);
  if (!rules || duration === null) return "Sem horário ou regra de valor: digite o valor.";
  const index = matchingPaymentValueRuleIndex(rules.valueRules, duration, shift);
  if (index === null) return "Nenhuma regra de valor se aplica a este turno: digite o valor.";
  return `Pela regra: ${describePaymentValueRule(rules.valueRules[index])}`;
}

interface HistoryEvent {
  row: PaymentShiftRow;
  title: string;
  tag: string | null;
  changes: { label: string; from: string | null; to: string }[];
}

/** Each step of the chain, oldest first, with only what changed from the step before it. */
function historyEvents(rowsNewestFirst: PaymentShiftRow[], rules: EffectivePaymentRules | null): HistoryEvent[] {
  const rows = [...rowsNewestFirst].reverse();
  const fields = (r: PaymentShiftRow) => {
    const value = shiftValue(r, rules?.valueRules ?? null);
    return [
      { label: "Status", text: STATUS_BADGE[r.status].label },
      { label: "Data", text: formatDate(r.workDate) },
      { label: "Local", text: r.local },
      { label: "Função", text: r.role },
      { label: "Horário", text: scheduleText(r) ?? "—" },
      { label: "Valor", text: value !== null ? formatCurrencyBRL(value) : "—" },
    ];
  };
  return rows.map((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    if (!prev) {
      const first = fields(row).filter((f) => ["Status", "Horário", "Valor"].includes(f.label));
      return {
        row,
        title: row.sourceFileName || row.sourceRowNumber !== null ? "Importado" : "Criado",
        tag: row.sourceFileName,
        changes: first.map((f) => ({ label: f.label, from: null, to: f.text })),
      };
    }
    const before = fields(prev);
    const changes = fields(row)
      .map((f, k) => ({ label: f.label, from: before[k].text, to: f.text }))
      .filter((c) => c.from !== c.to);
    let title: string;
    if (row.status !== prev.status) {
      title = row.status === "pago" ? "Pago" : row.status === "erro" ? "Marcado com erro" : "Voltou para pendente";
    } else if (row.editedManually && !prev.editedManually) {
      title = "Editado manualmente";
    } else if (!row.editedManually) {
      title = "Atualizado pela fonte";
    } else {
      title = "Alterado";
    }
    return { row, title, tag: null, changes };
  });
}

function useShiftHistory(shiftId: number | null) {
  const [rows, setRows] = useState<PaymentShiftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    setError(null);
    if (shiftId === null) return;
    let cancelled = false;
    getPaymentShiftHistory(shiftId)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      cancelled = true;
    };
  }, [shiftId]);
  return { rows, error };
}

/** "Dados": the turno's editable fields — what used to be edited inline in the table. */
/** Where the turno came from and what the import kept aside — read-only. */
function OriginSection({ shift, importedAt }: { shift: PaymentShiftRow; importedAt: string | null }) {
  // Lexicographic order alone misorders past column Z ("AA" < "B") — sort
  // by letter count first so single-letter columns come before double.
  const extras = extraColumnEntries(shift.extraData, shift.extraColumns);
  const rows: { label: string; value: ReactNode }[] = [];
  if (importedAt) rows.push({ label: "Importado em", value: formatDateTime(importedAt) });
  if (shift.sourceFileName) {
    rows.push({
      label: "Arquivo",
      value: shift.sourceUrl ? (
        <button type="button" className="sa-link sa-link-icon" onClick={() => window.open(shift.sourceUrl!, "_blank", "noopener")} title={shift.sourceUrl}>
          <Link2 size={12} />
          {shift.sourceFileName}
        </button>
      ) : (
        shift.sourceFileName
      ),
    });
  }
  if (shift.sourceSheetName) rows.push({ label: "Aba", value: shift.sourceSheetName });
  if (shift.sourceRowNumber !== null) rows.push({ label: "Linha", value: String(shift.sourceRowNumber) });
  if (shift.editedManually) {
    rows.push({
      label: "Editado manualmente",
      value: (
        <span
          title={
            shift.status === "pago"
              ? "O histórico deste turno inclui um campo corrigido à mão."
              : "Uma reimportação não sobrescreve este turno enquanto 'Manter registros atualizados manualmente' estiver ativado (Configurações → Zona de risco → Pagamentos)."
          }
        >
          Sim
        </span>
      ),
    });
  }
  if (rows.length === 0 && extras.length === 0) return null;
  return (
    <div>
      <div className="sa-section-label">Origem</div>
      <div className="sa-details">
        {rows.map((r) => (
          <div key={r.label} className="sa-detail-row">
            <span className="muted">{r.label}</span>
            <span>{r.value}</span>
          </div>
        ))}
      </div>
      {extras.length > 0 && (
        <>
          <div className="sa-section-label" style={{ marginTop: 14 }}>
            Outras colunas da planilha
          </div>
          <div className="sa-details xcol-details">
            <ExtraColumnsList entries={extras} />
          </div>
          <p className="xcol-help">O template não usa estas colunas. Elas ficam guardadas só para consulta e não entram no valor nem no status.</p>
        </>
      )}
    </div>
  );
}

function DataTab({
  shift,
  importedAt,
  canEdit,
  blocked,
  readOnly,
  busy,
  onSave,
  setFooter,
}: {
  shift: PaymentShiftRow;
  /** When the turno first entered the app — the oldest row of its history. */
  importedAt: string | null;
  canEdit: boolean;
  blocked: boolean;
  /** The profile can only view Pagamentos: details shown, nothing to edit. */
  readOnly: boolean;
  busy: boolean;
  onSave: (fields: ShiftEditFields) => void;
  setFooter: (footer: ReactNode) => void;
}) {
  const initial = {
    workDate: shift.workDate,
    local: shift.local,
    role: shift.role,
    start: shift.scheduleStartMinutes !== null ? formatMinutesAsTime(shift.scheduleStartMinutes) : "",
    end: shift.scheduleEndMinutes !== null ? formatMinutesAsTime(shift.scheduleEndMinutes) : "",
    amountDigits: shift.amount !== null ? String(Math.round(shift.amount * 100)) : "",
  };
  const [draft, setDraft] = useState(initial);
  const [pickingDate, setPickingDate] = useState(false);
  const dateRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setDraft(initial);
    setPickingDate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift.id]);

  const scheduleValid = (draft.start === "" && draft.end === "") || (parseTimeToMinutes(draft.start) !== null && parseTimeToMinutes(draft.end) !== null);
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => initial[k] !== draft[k]);

  function save() {
    onSave({
      workDate: draft.workDate,
      local: draft.local.trim(),
      role: draft.role.trim(),
      scheduleStartMinutes: draft.start ? parseTimeToMinutes(draft.start) : null,
      scheduleEndMinutes: draft.end ? parseTimeToMinutes(draft.end) : null,
      amount: draft.amountDigits === "" ? null : centsMaskToAmount(draft.amountDigits),
    });
  }

  const footer = canEdit ? (
    <>
      {dirty && (
        <button type="button" className="outline" onClick={() => setDraft(initial)} disabled={busy}>
          Descartar
        </button>
      )}
      <span className="sa-spacer" />
      <button type="button" onClick={save} disabled={!dirty || !scheduleValid || busy}>
        {busy ? "Salvando..." : "Salvar alterações"}
      </button>
    </>
  ) : null;
  // The footer lives in the panel, outside this tab; it changes with the draft.
  useEffect(() => {
    setFooter(footer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, dirty, scheduleValid, busy, draft]);
  useEffect(() => () => setFooter(null), [setFooter]);

  return (
    <>
      {!canEdit && !readOnly && (
        <Notice tone="info" icon={Info}>
          {blocked
            ? "Revise a alteração encontrada na fonte (aba Pagamento) antes de editar este turno."
            : "Um turno pago não pode ser editado. Volte para pendente na aba Pagamento para editar."}
        </Notice>
      )}
      {!canEdit && (
        <div className="sa-details">
          {[
            { label: "Data", value: formatDate(shift.workDate) },
            { label: "Local", value: shift.local || "—" },
            { label: "Função", value: shift.role || "—" },
            { label: "Horário", value: scheduleText(shift) ?? "—" },
            ...(shift.amount !== null ? [{ label: shift.status === "pago" ? "Valor pago" : "Valor fixo", value: formatCurrencyBRL(shift.amount) }] : []),
          ].map((r) => (
            <div key={r.label} className="sa-detail-row">
              <span className="muted">{r.label}</span>
              <span>{r.value}</span>
            </div>
          ))}
        </div>
      )}
      {canEdit && (
      <div className="sa-form">
        <div className="field">
          <label htmlFor="shift-data-date">Data</label>
          <button
            id="shift-data-date"
            ref={dateRef}
            type="button"
            className="sa-date-trigger"
            disabled={!canEdit}
            onClick={() => setPickingDate((v) => !v)}
          >
            <CalendarDays size={14} />
            {formatDate(draft.workDate)}
          </button>
          {pickingDate && (
            <DatePicker
              value={draft.workDate}
              anchorRef={dateRef}
              onSelect={(iso) => {
                setDraft((d) => ({ ...d, workDate: iso }));
                setPickingDate(false);
              }}
              onClose={() => setPickingDate(false)}
            />
          )}
        </div>
        <div className="sa-form-two">
          <div className="field">
            <label htmlFor="shift-data-local">Local</label>
            <input id="shift-data-local" type="text" value={draft.local} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, local: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="shift-data-role">Função</label>
            <input id="shift-data-role" type="text" value={draft.role} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))} />
          </div>
        </div>
        <div className="sa-form-two">
          <div className="field">
            <label htmlFor="shift-data-start">Início</label>
            {canEdit ? (
              <TimeField id="shift-data-start" value={draft.start} onChange={(v) => setDraft((d) => ({ ...d, start: v }))} />
            ) : (
              <input id="shift-data-start" type="text" value={draft.start || "—"} disabled />
            )}
          </div>
          <div className="field">
            <label htmlFor="shift-data-end">Fim</label>
            {canEdit ? (
              <TimeField id="shift-data-end" value={draft.end} onChange={(v) => setDraft((d) => ({ ...d, end: v }))} />
            ) : (
              <input id="shift-data-end" type="text" value={draft.end || "—"} disabled />
            )}
          </div>
        </div>
        {!scheduleValid && <div className="sa-small" style={{ color: "var(--danger)" }}>Preencha início e fim no formato HH:MM, ou deixe os dois vazios.</div>}
        {canEdit && (
          <div className="field">
            <label htmlFor="shift-data-amount">Valor fixo</label>
            <CurrencyInput id="shift-data-amount" digits={draft.amountDigits} onChange={(v) => setDraft((d) => ({ ...d, amountDigits: v }))} placeholder="Automático, pela regra" />
          </div>
        )}
      </div>
      )}
      {canEdit && <p className="muted sa-small">Salvar cria um novo registro marcado como editado manualmente. O registro atual fica no histórico.</p>}
      <OriginSection shift={shift} importedAt={importedAt} />
    </>
  );
}

/**
 * Everything about one turno on Pagamentos, in a panel docked beside the
 * table (same as the assistant): pagar or see the payment, edit its data,
 * its history, remove it. Opened by clicking a row.
 */
export default function ShiftPanel({
  shift: shiftProp,
  tab,
  onTabChange,
  rules,
  changes,
  otherPending,
  valueFor,
  busy,
  error,
  lastPayment,
  onOpenShift,
  onReview,
  onConfirmPay,
  onConfirmRevert,
  onSave,
  onConfirmDelete,
  onClose,
}: {
  shift: PaymentShiftRow | null;
  tab: ShiftPanelTab;
  onTabChange: (tab: ShiftPanelTab) => void;
  rules: EffectivePaymentRules | null;
  /** What the automatic verification last found different for this turno (pending and already applied). */
  changes: ShiftFieldDiffRow[];
  /** Other payable turnos of the same colaborador in the current list. */
  otherPending: PaymentShiftRow[];
  valueFor: (shift: PaymentShiftRow) => number | null;
  busy: boolean;
  error: string | null;
  lastPayment: LastPayment | null;
  onOpenShift: (shift: PaymentShiftRow) => void;
  /** Opens the review of what the automatic verification found. */
  onReview: () => void;
  onConfirmPay: (amount: number, pixKey: EmployeePixKeyRow | null) => void;
  onConfirmRevert: () => void;
  onSave: (fields: ShiftEditFields) => void;
  onConfirmDelete: () => void;
  onClose: () => void;
}) {
  // Kept after the shift clears so the content doesn't vanish mid slide-out.
  const [shown, setShown] = useState(shiftProp);
  useEffect(() => {
    if (shiftProp) setShown(shiftProp);
  }, [shiftProp]);
  const shift = shown;
  const readOnly = useReadOnly();
  const { canEdit: canEditArea } = useAccess();
  // A new PIX key is saved in the colaborador's Cadastro, and only matters when paying.
  const canAddPix = !readOnly && canEditArea("cadastros");

  const suggested = shift ? shiftValue(shift, rules?.valueRules ?? null) : null;
  const suggestedDigits = suggested !== null ? String(Math.round(suggested * 100)) : "";

  const [digits, setDigits] = useState(suggestedDigits);
  const [pixKeys, setPixKeys] = useState<EmployeePixKeyRow[] | null>(null);
  const [pixError, setPixError] = useState<string | null>(null);
  const [pixIndex, setPixIndex] = useState(0);
  const [pixAdding, setPixAdding] = useState(false);
  const [pixJustSaved, setPixJustSaved] = useState(false);
  useEffect(() => {
    if (!pixJustSaved) return;
    const t = window.setTimeout(() => setPixJustSaved(false), 3500);
    return () => window.clearTimeout(t);
  }, [pixJustSaved]);
  function pixSaved(keys: EmployeePixKeyRow[], index: number) {
    const added = pixKeys !== null && keys.length > pixKeys.length;
    setPixKeys(keys);
    setPixIndex(index);
    setPixAdding(false);
    setPixJustSaved(added);
  }
  const [deleting, setDeleting] = useState(false);
  const [deleteAck, setDeleteAck] = useState(false);
  const [confirmingRevert, setConfirmingRevert] = useState(false);
  const [dataFooter, setDataFooter] = useState<ReactNode>(null);

  const shiftId = shift?.id ?? null;
  useEffect(() => {
    setDeleting(false);
    setDeleteAck(false);
    setConfirmingRevert(false);
  }, [shiftId]);
  useEffect(() => {
    setDigits(suggestedDigits);
  }, [shiftId, suggestedDigits]);

  const employeeId = shift?.employeeId ?? null;
  useEffect(() => {
    setPixKeys(null);
    setPixError(null);
    setPixIndex(0);
    setPixAdding(false);
    setPixJustSaved(false);
    if (employeeId === null) return;
    let cancelled = false;
    listEmployeePixKeys(employeeId)
      .then((k) => !cancelled && setPixKeys(k))
      .catch((e) => !cancelled && setPixError(String(e instanceof Error ? e.message : e)));
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const history = useShiftHistory(shift && (tab === "history" || deleting) ? shift.id : null);
  // For the tab's count and "Importado em" (its oldest row) — refreshed per turno.
  const chain = useShiftHistory(shiftId).rows;
  const historyCount = chain?.length ?? null;

  if (!shift) return null;
  const pendingChanges = changes.filter((c) => !c.applied);
  const appliedChanges = changes.filter((c) => c.applied);
  const blocked = pendingChanges.length > 0;
  const paid = shift.status === "pago";
  const canEdit = !blocked && !paid && !readOnly;
  const firstName = shift.employeeName.split(" ")[0];
  const amountValid = digits !== "";

  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (deleting) {
    const paidAmount = shift.amount ?? valueFor(shift);
    const earlier = history.rows ? history.rows.length - 1 : null;
    body = (
      <>
        <button type="button" className="sa-back" onClick={() => setDeleting(false)}>
          <ChevronLeft size={14} />
          Voltar
        </button>
        <div className="sa-delete-title">
          <span className="side-panel-icon side-panel-icon-danger">
            <Trash2 size={15} />
          </span>
          Remover turno
        </div>
        {paid && (
          <Notice tone="danger" icon={AlertTriangle}>
            <strong>Este turno já foi pago</strong>
            {paidAmount !== null ? ` (${formatCurrencyBRL(paidAmount)} em ${formatDateTime(shift.importedAt)})` : ""}. O registro do pagamento também será removido.
          </Notice>
        )}
        <ul className="sa-list">
          <li>
            Remove o turno
            {earlier !== null && earlier > 0 ? ` e ${earlier} ${earlier === 1 ? "registro anterior" : "registros anteriores"} do histórico` : ""}
            {paid ? ", incluindo o pagamento" : ""}.
          </li>
          <li>Ele some de todas as listas, relatórios e exportações.</li>
          <li>Se for reimportado, a pré-visualização avisa que ele foi removido e você decide se traz de volta.</li>
        </ul>
        {paid && (
          <label className="sa-ack">
            <input type="checkbox" checked={deleteAck} onChange={(e) => setDeleteAck(e.target.checked)} />
            <span>Entendo que o pagamento{paidAmount !== null ? ` de ${formatCurrencyBRL(paidAmount)}` : ""} também será removido.</span>
          </label>
        )}
      </>
    );
    footer = (
      <>
        <span className="sa-spacer" />
        <button type="button" className="outline" onClick={() => setDeleting(false)} disabled={busy}>
          Cancelar
        </button>
        <button type="button" className="danger" onClick={onConfirmDelete} disabled={busy || (paid && !deleteAck)}>
          {busy ? "Removendo..." : "Remover turno"}
        </button>
      </>
    );
  } else if (tab === "pay" && blocked) {
    body = (
      <>
        <div className="sa-review">
          <AlertTriangle size={15} />
          <span>
            <strong>Mudança na fonte para revisar.</strong> Pagar e editar ficam bloqueados até você revisar.
          </span>
          <button type="button" className="sa-copy" onClick={onReview}>
            Revisar
          </button>
        </div>
        <div className="muted sa-small">
          <ChangeList changes={pendingChanges} />
        </div>
      </>
    );
  } else if (tab === "pay" && paid) {
    const justPaid = lastPayment?.shiftId === shift.id;
    const paidAmount = shift.amount ?? valueFor(shift);
    body = (
      <>
        <div className="sa-done">
          <span className="sa-done-check">
            <Check size={20} />
          </span>
          <div>
            <div className="sa-done-title">{justPaid ? "Pagamento confirmado" : "Pago"}</div>
            <div className="muted sa-small">{formatDateTime(shift.importedAt)}</div>
          </div>
        </div>
        <div className="sa-slip">
          <div className="sa-slip-row">
            <div className="sa-slip-main">
              <div className="sa-slip-label">Valor pago</div>
              <div className="sa-paid-amount">{paidAmount !== null ? formatCurrencyBRL(paidAmount) : "—"}</div>
            </div>
          </div>
          {justPaid && lastPayment.pixKey && (
            <div className="sa-slip-row">
              <div className="sa-slip-main">
                <div className="sa-slip-label">Chave PIX · {PIX_KEY_TYPE_LABELS[lastPayment.pixKey.keyType]}</div>
                <div className="sa-pix-key sa-pix-key-sm">{lastPayment.pixKey.keyValue}</div>
              </div>
            </div>
          )}
        </div>
        {appliedChanges.length > 0 && (
          <div className="sa-siblings">
            <span>A verificação automática atualizou este turno.</span>
            <button type="button" className="sa-copy" onClick={onReview}>
              Ver o que mudou
            </button>
          </div>
        )}
        {confirmingRevert && (
          <div className="sa-inline-confirm">
            Voltar este turno para <strong>Pendente</strong>? O pagamento continua no histórico e o turno pode ser pago de novo.
          </div>
        )}
      </>
    );
    footer = confirmingRevert ? (
      <>
        <span className="sa-spacer" />
        <button type="button" className="outline" onClick={() => setConfirmingRevert(false)} disabled={busy}>
          Cancelar
        </button>
        <button type="button" onClick={onConfirmRevert} disabled={busy}>
          {busy ? "Revertendo..." : "Voltar para pendente"}
        </button>
      </>
    ) : (
      <button type="button" className="outline" onClick={() => setConfirmingRevert(true)} disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined}>
        Voltar para pendente
      </button>
    );
  } else if (tab === "pay") {
    const pix = pixKeys && pixKeys.length > 0 ? pixKeys[Math.min(pixIndex, pixKeys.length - 1)] : null;
    const edited = digits !== suggestedDigits && suggested !== null;
    // No rule gave a Valor: the field must be typed — make that obvious.
    const needsValue = suggested === null && !amountValid;
    const otherTotal = otherPending.reduce((sum, s) => sum + (valueFor(s) ?? 0), 0);
    body = (
      <>
        {shift.status === "erro" && shift.errorMessage && (
          <Notice tone="danger" icon={AlertTriangle}>
            <strong>Erro:</strong> {shift.errorMessage}
          </Notice>
        )}
        {appliedChanges.length > 0 && (
          <Notice tone="warn" icon={AlertTriangle}>
            <strong>A fonte mudou desde a importação</strong> (verificado em {formatDateTimeAbbrevYY(appliedChanges[0].checkedAt)})
            <ChangeList changes={appliedChanges} />
          </Notice>
        )}
        <div className="sa-slip">
          <div className={needsValue ? "sa-slip-row sa-slip-row-needs" : "sa-slip-row"}>
            <div className="sa-slip-main">
              <label className="sa-slip-label" htmlFor="shift-pay-amount">
                Valor
              </label>
              <CurrencyInput
                id="shift-pay-amount"
                size="lg"
                digits={digits}
                onChange={setDigits}
                placeholder="0,00"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && amountValid && !busy && !readOnly) {
                    e.preventDefault();
                    onConfirmPay(centsMaskToAmount(digits), pix);
                  }
                }}
              />
              <div className="sa-origin">
                {edited ? (
                  <>
                    Editado. Sugerido: {formatCurrencyBRL(suggested!)} ·{" "}
                    <button type="button" className="sa-link" onClick={() => setDigits(suggestedDigits)}>
                      Restaurar
                    </button>
                  </>
                ) : needsValue ? (
                  <span className="sa-origin-needs">{valueOrigin(shift, rules)}</span>
                ) : (
                  valueOrigin(shift, rules)
                )}
              </div>
            </div>
            <CopyButton text={amountValid ? centsMaskToAmount(digits).toFixed(2).replace(".", ",") : ""} label="Copiar valor" />
          </div>
          {pixKeys !== null && pixKeys.length === 0 && pixAdding ? (
            <div className="sa-slip-row">
              <PixKeyForm employeeId={shift.employeeId} firstName={firstName} keys={pixKeys} onDone={pixSaved} onCancel={() => setPixAdding(false)} />
            </div>
          ) : (
            <div className="sa-slip-row">
              <div className="sa-slip-main">
                <div className="sa-slip-label">Chave PIX{pix ? ` · ${PIX_KEY_TYPE_LABELS[pix.keyType]}` : ""}</div>
                {pixKeys === null && !pixError && <div className="muted sa-small">Carregando chaves…</div>}
                {pixError && <div className="sa-small" style={{ color: "var(--danger)" }}>{pixError}</div>}
                {pixKeys !== null && pixKeys.length === 0 && <div className="muted sa-small">Nenhuma chave cadastrada para {firstName}.</div>}
                {pix && <div className="sa-pix-key">{pix.keyValue}</div>}
                {pixJustSaved && <div className="sa-pix-saved">✓ Salva no cadastro de {firstName}</div>}
              </div>
              {pix ? (
                <CopyButton text={pix.keyValue} label="Copiar chave PIX" />
              ) : (
                pixKeys !== null && canAddPix && (
                  <button type="button" className="sa-copy" onClick={() => setPixAdding(true)}>
                    Cadastrar
                  </button>
                )
              )}
            </div>
          )}
          {pixKeys && pixKeys.length > 0 && (pixKeys.length > 1 || canAddPix) && (
            <div className="sa-pix-options">
              {pixKeys.length > 1 &&
                pixKeys.map((k, i) => (
                  <button
                    key={k.id}
                    type="button"
                    className={k === pix && !pixAdding ? "sa-pix-option sa-pix-option-on" : "sa-pix-option"}
                    aria-pressed={k === pix && !pixAdding}
                    onClick={() => {
                      setPixIndex(i);
                      setPixAdding(false);
                    }}
                  >
                    {PIX_KEY_TYPE_LABELS[k.keyType]}
                  </button>
                ))}
              {canAddPix && (
              <button
                type="button"
                className={pixAdding ? "sa-pix-option sa-pix-option-add sa-pix-option-on" : "sa-pix-option sa-pix-option-add"}
                aria-pressed={pixAdding}
                onClick={() => setPixAdding((v) => !v)}
              >
                + Nova chave
              </button>
              )}
            </div>
          )}
          {pixKeys && pixKeys.length > 0 && pixAdding && (
            <div className="sa-slip-row">
              <PixKeyForm employeeId={shift.employeeId} firstName={firstName} keys={pixKeys} onDone={pixSaved} onCancel={() => setPixAdding(false)} />
            </div>
          )}
        </div>
        {otherPending.length > 0 && (
          <div className="sa-siblings">
            <span>
              {firstName} tem mais {otherPending.length} {otherPending.length === 1 ? "turno pendente" : "turnos pendentes"} nesta lista
              {otherTotal > 0 ? ` (${formatCurrencyBRL(otherTotal)})` : ""}
            </span>
            <button type="button" className="sa-copy" onClick={() => onOpenShift(otherPending[0])}>
              Ver
            </button>
          </div>
        )}
        {!readOnly && <p className="muted sa-small">Confirmar cria um novo registro "Pago". O registro atual fica no histórico.</p>}
      </>
    );
    footer = (
      <>
        <span className="sa-spacer" />
        <button
          type="button"
          onClick={() => onConfirmPay(centsMaskToAmount(digits), pix)}
          disabled={readOnly || !amountValid || busy}
          title={readOnly ? READ_ONLY_TITLE : undefined}
        >
          {busy ? "Confirmando..." : "Confirmar pagamento"}
        </button>
      </>
    );
  } else if (tab === "data") {
    body = <DataTab shift={shift} importedAt={chain && chain.length > 0 ? chain[chain.length - 1].importedAt : null} canEdit={canEdit} blocked={blocked} readOnly={readOnly} busy={busy} onSave={onSave} setFooter={setDataFooter} />;
    footer = dataFooter;
  } else {
    const events = history.rows ? historyEvents(history.rows, rules).reverse() : null;
    body = (
      <>
        {history.error && <div className="error-box">{history.error}</div>}
        {!events && !history.error && <p className="muted">Carregando...</p>}
        {events && (
          <div className="sa-timeline">
            {events.map((ev, i) => (
              <div key={ev.row.id} className={i === 0 ? "sa-tl-item sa-tl-now" : "sa-tl-item"}>
                <span className="sa-tl-dot" />
                <div className="sa-tl-content">
                  <div className="sa-tl-head">
                    <span className="sa-tl-title">{ev.title}</span>
                    {i === 0 && <span className="sa-tag">Atual</span>}
                    {ev.tag && (
                      <span className="sa-tag" title={ev.tag}>
                        {ev.tag}
                      </span>
                    )}
                  </div>
                  <div className="sa-tl-when">
                    {formatDateTime(ev.row.importedAt)}
                    {ev.row.createdByName && <> · por {ev.row.createdByName}</>}
                  </div>
                  {ev.row.status === "erro" && ev.row.errorMessage && (
                    <div className="sa-small" style={{ color: "var(--danger)" }}>
                      {ev.row.errorMessage}
                    </div>
                  )}
                  {ev.changes.length > 0 && (
                    <div className="sa-tl-changes">
                      {ev.changes.map((c) => (
                        <div key={c.label}>
                          <span className="muted">{c.label}</span>{" "}
                          {c.from !== null && (
                            <>
                              <s>{c.from}</s> →
                            </>
                          )}{" "}
                          <strong>{c.to}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {events && events.length > 1 && <p className="muted sa-small">Cada etapa mostra só o que mudou em relação à anterior.</p>}
      </>
    );
  }

  const tabs: { id: ShiftPanelTab; label: string; icon: LucideIcon; count?: number | null }[] = [
    { id: "pay", label: "Pagamento", icon: CreditCard },
    { id: "data", label: "Dados", icon: Pencil },
    { id: "history", label: "Histórico", icon: History, count: historyCount },
  ];

  return (
    <SidePanel
      open={shiftProp !== null}
      onClose={onClose}
      title="Turno"
      icon={CalendarDays}
      width={400}
      actions={
        <>
          <button
            type="button"
            className="side-panel-icon-button sa-trash-button"
            aria-label="Remover turno"
            title={readOnly ? READ_ONLY_TITLE : blocked ? "Revise a alteração da fonte antes de remover" : "Remover turno"}
            disabled={readOnly || blocked || deleting}
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={16} />
          </button>
        </>
      }
      subheader={
        <>
          <ShiftStrip shift={shift} period={shiftPeriodOf(shift, rules)} />
          {!deleting && (
            <div className="sa-tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTabChange(t.id)}>
                  <t.icon size={14} />
                  {t.label}
                  {t.count != null && <span className="sa-tab-count">{t.count}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      }
      footer={footer}
    >
      {body}
      {error && (
        <div className="error-box" style={{ margin: 0 }}>
          {error}
        </div>
      )}
    </SidePanel>
  );
}
