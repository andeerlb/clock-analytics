-- An optional if/else-if/else chain, per company, deciding a shift's Valor
-- from its own duration (horas trabalhadas) — same evaluation-by-insertion-
-- order convention as payment_template_rules/payment_template_status_rules
-- (ORDER BY id). Unlike those, a 'condition' row here is a numeric
-- comparison (operator + hours threshold) against the shift's duration,
-- not a text match against a mapped field — so there's no values_json,
-- just a single operator/hours pair. Company-scoped (not template-scoped)
-- since how much a shift pays is a company policy, independent of which
-- import template produced the row.
CREATE TABLE payment_value_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    kind TEXT NOT NULL DEFAULT 'condition', -- 'condition' | 'else'
    operator TEXT,  -- '=' | '!=' | '>' | '>=' | '<' | '<=' ; NULL when kind = 'else'
    hours REAL,     -- threshold, in hours; NULL when kind = 'else'
    amount REAL NOT NULL -- valor a pagar (R$) when this step matches
);

CREATE INDEX idx_payment_value_rules_company ON payment_value_rules(company_id);
