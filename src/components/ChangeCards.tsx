import type { ReactNode } from "react";
import type { ReimportConfig } from "../contexts/RemoteFileUpdatesContext";
import { colorForName, initials } from "../lib/avatar";
import { dismissCheckDiffs, type CheckDiffRow } from "../lib/db";
import { diffFieldLabel, formatDateAbbrevYY, formatMinutesAsTime, formatPersonName } from "../lib/format";
import { acceptShiftChange } from "../lib/remoteCheckDiff";

/** "hoje às 14:28", "ontem às 18:40", "16/11 às 10:00" — when a spreadsheet version was saved (as written in the file). */
export function savedWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `hoje às ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `ontem às ${time}`;
  return `${date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${time}`;
}

/** The "Quem alterou" key of a change: the name, "no name in the file", or not known at all. */
export const UNNAMED_AUTHOR = "Sem nome no arquivo";
export function authorKey(r: CheckDiffRow): string | null {
  if (!r.savedAt && !r.savedBy) return null;
  return r.savedBy?.trim() || UNNAMED_AUTHOR;
}

/** Field diffs of one turno go together; everything else is one card per row. Then grouped by person. */
export function cardsOf(rows: CheckDiffRow[]) {
  const cards = new Map<string, CheckDiffRow[]>();
  for (const r of rows) {
    const key = r.changeKind === "field" && r.matchedShiftId !== null ? `s${r.matchedShiftId}` : `d${r.id}`;
    cards.set(key, [...(cards.get(key) ?? []), r]);
  }
  const byPerson = new Map<string, { name: string; cards: { key: string; rows: CheckDiffRow[] }[] }>();
  for (const [key, cardRows] of cards) {
    const raw = cardRows[0].employeeName?.trim() || "";
    const name = cardRows[0].changeKind === "error" ? "Erro na conferência" : raw ? (cardRows[0].employeeId ? formatPersonName(raw) : `“${raw}”`) : "(nome vazio)";
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
  error: ["rv-tag-gone", "Erro"],
};

export type CardState = "pending" | "applied" | "seen";

/**
 * The review cards of Verificação automática, grouped by person — also used
 * by the pending-updates Drawer, so both places look and act the same.
 */
export default function ChangeCards({
  rows,
  configFor,
  stateOf,
  busyKeys,
  run,
  onDeleteShift,
  onReprocess,
  keyPrefix = "",
}: {
  rows: CheckDiffRow[];
  /** The rule that found the change; actions that need it are disabled when it was removed. */
  configFor: (row: CheckDiffRow) => ReimportConfig | undefined;
  stateOf: (cardRows: CheckDiffRow[]) => CardState;
  busyKeys: Set<string>;
  /** Runs an action with `key` marked busy, then refreshes. */
  run: (key: string, action: () => Promise<void>) => void;
  onDeleteShift: (target: { shiftId: number; who: string }) => void;
  onReprocess: (configId: number, periodStart: string | null, periodEnd: string | null) => void;
  /** Keeps busy keys apart when several lists share one `busyKeys`. */
  keyPrefix?: string;
}) {
  function renderCard(cardKey: string, cardRows: CheckDiffRow[]) {
    const key = keyPrefix + cardKey;
    const state = stateOf(cardRows);
    const applied = state === "applied";
    const first = cardRows[0];
    const c = configFor(first);
    const [tagClass, tagLabel] = KIND_TAG[first.changeKind] ?? ["rv-tag-who", first.changeKind];
    const where = [first.local, first.role].filter(Boolean).join(" · ");
    const sheetPlace = first.rowNumber !== null ? `${first.sheetName ? `aba ${first.sheetName}, ` : ""}linha ${first.rowNumber}` : null;
    const busy = busyKeys.has(key) || busyKeys.has("all");
    const ids = cardRows.map((r) => r.id);
    const schedule =
      first.scheduleStartMinutes !== null && first.scheduleEndMinutes !== null
        ? `${formatMinutesAsTime(first.scheduleStartMinutes)} – ${formatMinutesAsTime(first.scheduleEndMinutes)}`
        : null;

    let body: ReactNode;
    if (first.changeKind === "field") {
      body = (
        <dl className="rv-diffs">
          {cardRows.map((r) => (
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
    if (state === "pending") {
      const ignore = (label: string) => (
        <button type="button" className="settings-button settings-button-ghost" disabled={busy} onClick={() => run(key, () => dismissCheckDiffs(ids))}>
          {label}
        </button>
      );
      if (first.changeKind === "field" && first.matchedShiftId !== null) {
        actions = (
          <>
            <button type="button" className="settings-button" disabled={busy || !c} onClick={() => c && run(key, () => acceptShiftChange(c, first.matchedShiftId!))}>
              {busy ? "Aplicando..." : "Aplicar"}
            </button>
            {ignore("Ignorar")}
          </>
        );
      } else if (first.changeKind === "removed" && first.matchedShiftId !== null) {
        actions = (
          <>
            <button type="button" className="settings-button settings-button-danger" disabled={busy} onClick={() => onDeleteShift({ shiftId: first.matchedShiftId!, who: first.employeeName ?? "" })}>
              Excluir turno…
            </button>
            {ignore("Manter")}
          </>
        );
      } else if (first.changeKind === "error") {
        actions = ignore("Ok, já vi");
      } else {
        actions = (
          <>
            <button type="button" className="settings-button" disabled={busy || !c} onClick={() => c && onReprocess(c.id, first.periodStart, first.periodEnd)}>
              Reimportar o período
            </button>
            {ignore("Ignorar")}
          </>
        );
      }
    }

    return (
      <div key={cardKey} className="rv-change">
        <div className="rv-change-top">
          <span className="rv-change-date">{first.workDate ? formatDateAbbrevYY(first.workDate) : "Sem data"}</span>
          {where && <span className="rv-small">{where}</span>}
          <span className={`rv-tag ${applied ? "rv-tag-auto" : tagClass}`}>{applied ? "Aplicado" : tagLabel}</span>
          {state === "seen" && <span className="rv-tag rv-tag-who">Visto</span>}
        </div>
        {body}
        <div className="rv-change-meta">
          {authorKey(first) && (
            <span className="rv-by">
              <span className="rv-avatar rv-avatar-xs" style={{ background: first.savedBy ? colorForName(first.savedBy) : "#3a3a42" }} aria-hidden="true">
                {first.savedBy ? initials(first.savedBy) : "?"}
              </span>
              {first.savedBy ? (
                <>
                  Alterado por <b>{first.savedBy}</b>
                </>
              ) : (
                UNNAMED_AUTHOR
              )}
              {first.savedAt && ` · ${savedWhen(first.savedAt)}`}
            </span>
          )}
          {sheetPlace && <span className="rv-small">{sheetPlace}</span>}
        </div>
        {actions && <div className="rv-actions">{actions}</div>}
      </div>
    );
  }

  return (
    <>
      {cardsOf(rows).map((person) => (
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
          {person.cards.map((card) => renderCard(card.key, card.rows))}
        </div>
      ))}
    </>
  );
}
