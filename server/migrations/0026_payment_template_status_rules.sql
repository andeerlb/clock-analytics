-- An if/else-if/else chain deciding a shift's initial payment status from
-- an already-mapped field's value at import time — same shape as
-- payment_template_rules (routing), evaluated the same way, but "um pra
-- um": the consequence is a single status instead of company_id/client_id,
-- so there's no join to companies/clients here. Optional, unlike routing
-- rules: a template with none of these (the default) leaves every
-- imported shift 'pendente', same as before this table existed.
CREATE TABLE payment_template_status_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES payment_templates(id),
    kind TEXT NOT NULL DEFAULT 'condition', -- 'condition' | 'else'
    field TEXT,                              -- PaymentTargetField; NULL when kind = 'else'
    values_json TEXT,                        -- JSON array of strings; NULL when kind = 'else'
    case_insensitive INTEGER NOT NULL DEFAULT 1, -- 0/1; whether values_json matching folds case
    status TEXT NOT NULL -- PaymentShiftStatus: 'pendente' | 'erro' | 'pago'
);

CREATE INDEX idx_payment_template_status_rules_template ON payment_template_status_rules(template_id);
