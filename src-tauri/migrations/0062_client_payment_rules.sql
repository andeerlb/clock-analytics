-- Clients gain the same optional overrides companies have: a night-shift
-- window/rule and an if/else-if/else pay-value chain. All three night
-- columns are nullable (unlike companies', which are NOT NULL WITH
-- DEFAULT) — NULL on all three together means "no override, inherit the
-- company's", since a client (unlike a company) always has a fallback to
-- fall back to. Precedence is resolved in application code (see
-- `getEffectivePaymentRules` in db.ts), not here.
ALTER TABLE clients ADD COLUMN night_start_time TEXT;
ALTER TABLE clients ADD COLUMN night_end_time TEXT;
ALTER TABLE clients ADD COLUMN night_shift_rule TEXT;

-- Mirrors payment_value_rules exactly (company_id -> client_id), already in
-- its final post-0048 shape — no need to replay that table's own migration
-- history for a brand-new table. An empty value-rule chain for a client
-- means "no override", not "worth zero" — same convention as every other
-- optional rule chain in this project.
CREATE TABLE client_payment_value_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    kind TEXT NOT NULL DEFAULT 'condition',
    conditions_json TEXT,
    operator TEXT,
    threshold_minutes INTEGER,
    amount REAL NOT NULL
);
CREATE INDEX idx_client_payment_value_rules_client ON client_payment_value_rules(client_id);
