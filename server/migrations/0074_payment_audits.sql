-- Audit trail for "Conferência de Pagamentos": records the user's manual
-- bank-statement verification of a `pago` payment_shifts row, kept separate
-- from `payment_shifts` itself since only the "erro" outcome is a real
-- state transition (handled by the existing `revertPaymentShiftToPending`,
-- which appends its own new row to that table) — a "confirmado" outcome
-- has no state to transition, it's purely an audit fact about the CURRENT
-- head row. `payment_shift_id` targets that head row's own id directly
-- (not a "shift identity" grouping column) because a `pago` row is frozen
-- once written — `editPaymentShift` refuses to touch a `pago` row — so the
-- FK stays meaningful even after a later revert grows the chain with a new
-- `pendente` head; a future re-payment creates a brand new payment_shifts
-- row (new id), correctly counted as a fresh, unaudited item rather than
-- inheriting this one's audit.
--
-- UNIQUE(payment_shift_id) guards against a double-submit (e.g. a stray
-- double key-press from the keyboard-nav shortcuts) inserting two audit
-- rows for the same shift before the list has a chance to refetch and hide
-- it — the app-side insert swallows the resulting constraint violation as
-- a no-op instead of surfacing it.
--
-- Pure new-table addition — doesn't touch payment_shifts' own shape, so
-- (unlike 0067/0071/0072) this doesn't need the rebuild-the-whole-chain
-- technique; a plain CREATE TABLE inside the always-on transaction is
-- enough.
PRAGMA foreign_keys = ON;

CREATE TABLE payment_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_shift_id INTEGER NOT NULL UNIQUE REFERENCES payment_shifts(id),
    result TEXT NOT NULL CHECK (result IN ('confirmado', 'erro')),
    note TEXT,
    audited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payment_audits_shift ON payment_audits(payment_shift_id);
