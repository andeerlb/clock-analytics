-- Who changed what: every change made through the app (and what the
-- automatic verification finds) is recorded here, with the before → after
-- of each field. Kept forever.
CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    -- NULL for the automatic verification (no person behind it).
    actor_email TEXT,
    actor_name TEXT,
    -- Pagamentos, Templates, Colaboradores, Empresas, Clientes, Funções,
    -- Espelhos, Verificação, Configurações, Usuários.
    area TEXT NOT NULL,
    -- The operation (e.g. editPaymentShift) and how it reads ("editou o turno").
    action TEXT NOT NULL,
    verb TEXT NOT NULL,
    -- What it touched: kind, id and a readable name at the time.
    entity_type TEXT,
    entity_id TEXT,
    entity_label TEXT,
    -- A short extra ("214 turnos"), the per-field changes
    -- ([{field, before, after}]) and, for bulk actions, the records touched
    -- ([{id, label}]).
    summary TEXT,
    changes_json TEXT,
    items_json TEXT
);
CREATE INDEX idx_activity_log_at ON activity_log(at DESC, id DESC);
CREATE INDEX idx_activity_log_actor ON activity_log(actor_email, id DESC);
CREATE INDEX idx_activity_log_area ON activity_log(area, id DESC);
CREATE INDEX idx_activity_log_entity ON activity_log(entity_type, entity_id, id DESC);

-- The name each signed-in person goes by (from their Google account),
-- refreshed whenever they change something.
CREATE TABLE known_users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who wrote each version of a turno (import, edit, payment...). NULL for
-- versions written before this was recorded.
ALTER TABLE payment_shifts ADD COLUMN created_by TEXT;
