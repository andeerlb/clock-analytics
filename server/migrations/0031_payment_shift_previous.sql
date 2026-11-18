-- "Fazer pagamento" always creates a new row instead of mutating the
-- pendente/erro one — previous_shift_id links the new row back to the one
-- it replaces, so that older row can stay untouched as history instead of
-- being overwritten. A shift's "current" row, for any list/summary/filter,
-- is whichever one nothing else points to (see the "head shift" WHERE
-- fragment in db.ts) — the row this points to is always frozen once
-- something links to it.
ALTER TABLE payment_shifts ADD COLUMN previous_shift_id INTEGER REFERENCES payment_shifts(id);

CREATE INDEX idx_payment_shifts_previous ON payment_shifts(previous_shift_id);
