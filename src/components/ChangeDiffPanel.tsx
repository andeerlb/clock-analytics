import { AlertTriangle, Trash2 } from "lucide-react";
import { diffFieldLabel, formatDateAbbrevYY } from "../lib/format";
import type { CheckDiffRow } from "../lib/db";
import PillButton from "./PillButton";

/** Same identity a deep check matched a record by (employee+data+local+função+horário) — used only to group diff rows into one card per changed record, not to look anything up. `'unresolved'` rows have no `employeeId` at all (that's the whole point — the file's colaborador/rota didn't match anything) — grouped by their own row/aba instead, so two different unmatched rows never collapse into one card just because they share null identity fields. */
function diffIdentityKey(r: CheckDiffRow): string {
  if (r.employeeId === null) return `unresolved:${r.sheetName ?? ""}:${r.rowNumber ?? ""}`;
  return `${r.employeeId}|${r.workDate}|${r.local}|${r.role}|${r.scheduleStartMinutes}|${r.scheduleEndMinutes}`;
}

/**
 * One diff-record card per changed turno — shared by the "Verificação
 * automática" page's per-row Drawer, the Pagamentos page's per-turno review
 * Drawer, and the global "bolinha" indicator's summary Drawer. A
 * GitHub-diff-style before/after per field. `change_kind: 'new-shift'`
 * records (no existing match at all) get their own "Possível novo turno"
 * card instead of a field diff; `'unresolved'` records (a route or
 * colaborador that didn't match anything — e.g. a typo in the name column)
 * get their own warning card with why; `'error'` entries (a whole config or
 * the whole URL's deep pass failing) render as compact error lines, separate
 * from the field changes.
 *
 * `applied` (see `CheckDiffRow.applied`) splits each 'field'/'removed' card
 * into two shapes: still-pending (shows the action — "Aceitar e atualizar"/
 * "Marcar como excluído", via `onAccept`/`onMarkDeleted`) or already written
 * by auto-apply (shows a plain "aplicado automaticamente" badge instead —
 * nothing left to do). Every action callback is optional: omitted entirely
 * makes this panel purely read-only, which is what the global indicator's
 * summary Drawer wants (the action itself lives on the Pagamentos page).
 */
export default function ChangeDiffPanel({
  rows,
  markingShiftId = null,
  markedShiftIds,
  onMarkDeleted,
  onAccept,
  acceptingShiftId = null,
  acceptedShiftIds,
  onDismiss,
  dismissingIds,
  onReprocess,
}: {
  rows: CheckDiffRow[];
  /** The one shift currently being soft-deleted via "Marcar como excluído" (disables just that card's button) — `null` when nothing's in flight. */
  markingShiftId?: number | null;
  /** Shifts already marked this session — swaps that card's button for a confirmation instead of re-fetching to notice the same thing. */
  markedShiftIds?: Set<number>;
  onMarkDeleted?: (shiftId: number) => void;
  /** Pending 'field' cards get an "Aceitar e atualizar" button that calls this — omitted (e.g. the global indicator's read-only summary) means no action is offered at all. */
  onAccept?: (shiftId: number) => void;
  acceptingShiftId?: number | null;
  acceptedShiftIds?: Set<number>;
  /** "Visto" — acknowledges a card/line without resolving it (see `dismissCheckDiffs`): takes every `CheckDiffRow.id` the card is made of, since a card can bundle several field diffs for the same turno. Content-based (see `dismissed_diff_fingerprints`): a later check whose new row has identical content to a dismissed one arrives already dismissed, so it stays quiet everywhere — the pending banner AND this same single-check detail — until something actually changes. Omitted entirely only where there's truly no dismiss story (none currently). */
  onDismiss?: (rowIds: number[]) => void;
  dismissingIds?: Set<number>;
  /** Every card/line (regardless of `changeKind`) gets a "Reprocessar agora" button whenever it carries a `configId`, calling this with that `configId` and the período THAT CHECK used (`CheckDiffRow.periodStart`/`periodEnd`, not whatever the live config resolves to today) — reprocessing with the exact same período is what lets the user find out whether whatever's shown here is still true. Omitted means no button offered anywhere. */
  onReprocess?: (configId: number, periodStart: string | null, periodEnd: string | null) => void;
}) {
  /** "Reprocessar agora" also marks the card "Visto" — reprocessing is itself an acknowledgment, and without this the card would keep nagging even while a reprocess is in flight. */
  function handleReprocess(row: CheckDiffRow, groupRows: CheckDiffRow[]) {
    if (!onReprocess || row.configId === null) return;
    onReprocess(row.configId, row.periodStart, row.periodEnd);
    onDismiss?.(groupRows.map((r) => r.id));
  }

  /** Renders "Visto" for a card/line, keyed off the full rows (not just ids) so an already-dismissed group shows a static confirmation instead of a clickable button — dismissing never removes the card, just acknowledges it. */
  function renderDismissButton(groupRows: CheckDiffRow[]) {
    if (!onDismiss) return null;
    if (groupRows.every((r) => r.dismissedAt !== null)) {
      return (
        <span className="badge neutral" style={{ display: "inline-flex", fontSize: "0.7rem", borderRadius: 7 }}>
          Visto
        </span>
      );
    }
    const rowIds = groupRows.map((r) => r.id);
    const busy = dismissingIds !== undefined && rowIds.some((id) => dismissingIds.has(id));
    return (
      <PillButton disabled={busy} onClick={() => onDismiss(rowIds)}>
        {busy ? "..." : "Visto"}
      </PillButton>
    );
  }

  const errors = rows.filter((r) => r.changeKind === "error");
  const changes = rows.filter((r) => r.changeKind !== "error");
  const byIdentity = new Map<string, CheckDiffRow[]>();
  for (const r of changes) {
    const idKey = diffIdentityKey(r);
    const list = byIdentity.get(idKey) ?? [];
    list.push(r);
    byIdentity.set(idKey, list);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      {errors.map((e, i) => (
        <div
          key={`err-${i}`}
          className="error-box"
          style={{
            fontSize: "0.78rem",
            padding: "0.45rem 0.7rem",
            marginBottom: "0.4rem",
          }}
        >
          <span style={{ overflowWrap: "anywhere" }}>{e.message}</span>
          <div style={{ marginTop: "0.35rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
            {onReprocess && e.configId !== null && (
              <PillButton onClick={() => handleReprocess(e, [e])}>Reprocessar agora</PillButton>
            )}
            {renderDismissButton([e])}
          </div>
        </div>
      ))}
      {Array.from(byIdentity.entries()).map(([idKey, entries]) => {
        const first = entries[0];
        const isNew = first.changeKind === "new-shift";
        const isUnresolved = first.changeKind === "unresolved";
        const isRemoved = first.changeKind === "removed";
        return (
          <div
            key={idKey}
            style={{
              border: `1px solid ${isNew ? "var(--accent)" : isUnresolved ? "var(--warning)" : isRemoved ? "var(--danger)" : "var(--border-soft)"}`,
              borderRadius: 8,
              padding: "0.5rem 0.7rem",
              marginBottom: "0.4rem",
            }}
          >
            <div style={{ fontSize: "0.82rem", fontWeight: 500 }}>
              {first.employeeName ?? "(nome vazio)"}
              {first.workDate ? ` — ${formatDateAbbrevYY(first.workDate)}` : ""}
              {" · "}
              {first.local || "—"} / {first.role || "—"}
            </div>
            {(first.sheetName || first.rowNumber !== null) && (
              <div className="muted" style={{ fontSize: "0.72rem" }}>
                {first.sheetName ? `aba ${first.sheetName}, ` : ""}
                {first.rowNumber !== null ? `linha ${first.rowNumber}` : ""}
              </div>
            )}
            {isNew ? (
              <div style={{ marginTop: "0.35rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                <span className="badge ok" style={{ display: "inline-flex" }}>
                  {first.applied ? "Criado automaticamente" : "Possível novo turno"}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {onReprocess && first.configId !== null && (
                    <PillButton onClick={() => handleReprocess(first, entries)}>Reprocessar agora</PillButton>
                  )}
                  {renderDismissButton(entries)}
                </div>
              </div>
            ) : isUnresolved ? (
              <div style={{ marginTop: "0.35rem" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.78rem",
                    color: "var(--warning)",
                  }}
                >
                  <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{first.message}</span>
                </div>
                <div
                  style={{
                    marginTop: "0.35rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.5rem",
                  }}
                >
                  {onReprocess && first.configId !== null && (
                    <PillButton onClick={() => handleReprocess(first, entries)}>Reprocessar agora</PillButton>
                  )}
                  {renderDismissButton(entries)}
                </div>
              </div>
            ) : isRemoved ? (
              <div style={{ marginTop: "0.35rem" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.78rem",
                    color: "var(--danger)",
                  }}
                >
                  <Trash2 size={13} style={{ flexShrink: 0 }} />
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{first.message}</span>
                </div>
                <div
                  style={{
                    marginTop: "0.35rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.5rem",
                  }}
                >
                  {first.applied ? (
                    <span className="badge neutral" style={{ display: "inline-flex" }}>
                      Excluído automaticamente
                    </span>
                  ) : (
                    onMarkDeleted &&
                    first.matchedShiftId !== null &&
                    (markedShiftIds?.has(first.matchedShiftId) ? (
                      <span className="badge neutral" style={{ display: "inline-flex" }}>
                        Marcado como excluído
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        style={{ fontSize: "0.76rem", padding: "0.25rem 0.5rem" }}
                        disabled={markingShiftId === first.matchedShiftId}
                        onClick={() => onMarkDeleted(first.matchedShiftId!)}
                      >
                        {markingShiftId === first.matchedShiftId ? "Marcando…" : "Marcar como excluído"}
                      </button>
                    ))
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    {onReprocess && first.configId !== null && (
                      <PillButton onClick={() => handleReprocess(first, entries)}>Reprocessar agora</PillButton>
                    )}
                    {renderDismissButton(entries)}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                {entries.map((e, i) => (
                  <div key={i} style={{ fontSize: "0.78rem" }}>
                    <span className="muted">{diffFieldLabel(e.fieldName, e.columnLetter)}: </span>
                    <span
                      style={{
                        background: "var(--danger-soft)",
                        color: "var(--danger)",
                        textDecoration: "line-through",
                        padding: "0.05rem 0.35rem",
                        borderRadius: 4,
                      }}
                    >
                      {e.oldValue || "(vazio)"}
                    </span>
                    {" → "}
                    <span
                      style={{
                        background: "var(--success-soft)",
                        color: "var(--success)",
                        padding: "0.05rem 0.35rem",
                        borderRadius: 4,
                      }}
                    >
                      {e.newValue || "(vazio)"}
                    </span>
                  </div>
                ))}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                  {first.applied ? (
                    <span className="badge neutral" style={{ display: "inline-flex" }}>
                      Aplicado automaticamente
                    </span>
                  ) : (
                    onAccept &&
                    first.matchedShiftId !== null &&
                    (acceptedShiftIds?.has(first.matchedShiftId) ? (
                      <span className="badge ok" style={{ display: "inline-flex" }}>
                        Atualizado
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        style={{ fontSize: "0.76rem", padding: "0.25rem 0.5rem", alignSelf: "flex-start" }}
                        disabled={acceptingShiftId === first.matchedShiftId}
                        onClick={() => onAccept(first.matchedShiftId!)}
                      >
                        {acceptingShiftId === first.matchedShiftId ? "Aplicando…" : "Aceitar e atualizar"}
                      </button>
                    ))
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    {onReprocess && first.configId !== null && (
                      <PillButton onClick={() => handleReprocess(first, entries)}>Reprocessar agora</PillButton>
                    )}
                    {renderDismissButton(entries)}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
