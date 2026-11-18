-- A payment template is a reusable mapping from a sample payroll file's
-- columns to known target fields, so a later (separate, not-yet-built)
-- import-execution step knows how to turn a spreadsheet into payment rows
-- without asking the user to re-map it every time. This migration only
-- registers the template and its column mappings — it does not touch
-- anything about actually importing payment data.
--
-- payment_template_fields is a normalized child table (one row per mapped
-- column), matching how every other variable-cardinality relationship in
-- this schema is modeled (punches under day_records, client_companies
-- under clients) rather than a JSON blob column, which nothing else here
-- uses.
CREATE TABLE payment_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id),
    file_kind TEXT NOT NULL,
    sheet_name TEXT,
    header_row INTEGER NOT NULL DEFAULT 1,
    delimiter TEXT,
    decimal_separator TEXT NOT NULL DEFAULT ',',
    date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    sample_file_path TEXT NOT NULL DEFAULT '',
    sample_file_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payment_templates_client ON payment_templates(client_id);

CREATE TABLE payment_template_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES payment_templates(id),
    column_letter TEXT NOT NULL,
    target_field TEXT NOT NULL,
    header_label TEXT,
    UNIQUE (template_id, column_letter)
);

CREATE INDEX idx_payment_template_fields_template ON payment_template_fields(template_id);
