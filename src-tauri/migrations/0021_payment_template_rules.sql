-- An if/else-if/else chain, evaluated in insertion order (create/update
-- always delete-and-reinsert the whole chain in the right order, same
-- pattern payment_template_groups already uses, so plain `ORDER BY id` is
-- enough — no separate position column needed). A 'condition' rule routes
-- rows whose already-mapped `field`'s value is one of `values_json` to
-- company_id/client_id; an 'else' rule (field/values_json both NULL) always
-- matches, is optional, and at most one per template. Always required —
-- even a template that only ever serves one client needs a single 'else'
-- rule, since the fixed template-level client field is gone.
CREATE TABLE payment_template_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES payment_templates(id),
    kind TEXT NOT NULL DEFAULT 'condition', -- 'condition' | 'else'
    field TEXT,                              -- PaymentTargetField; NULL when kind = 'else'
    values_json TEXT,                        -- JSON array of strings; NULL when kind = 'else'
    case_insensitive INTEGER NOT NULL DEFAULT 1, -- 0/1; whether values_json matching folds case
    company_id INTEGER NOT NULL REFERENCES companies(id),
    client_id INTEGER NOT NULL REFERENCES clients(id)
);

CREATE INDEX idx_payment_template_rules_template ON payment_template_rules(template_id);
