-- Marks the "current" row of a shift as the result of a deliberate user
-- action on the Pagamentos detail page (editar valor, fazer pagamento,
-- voltar para pendente) rather than an import/reprocessamento. Used to
-- decide whether a reimport that matches the same identity (colaborador +
-- dia + local + função + horário) may create a new current row on top of
-- it, or should be skipped instead (see payment_settings.keep_manual_edits).
ALTER TABLE payment_shifts ADD COLUMN edited_manually INTEGER NOT NULL DEFAULT 0;

-- Single global toggle (fixed id=1 row) — just this one boolean for now, no
-- need for a generic key/value settings table.
CREATE TABLE payment_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    keep_manual_edits INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payment_settings (id, keep_manual_edits) VALUES (1, 1);
