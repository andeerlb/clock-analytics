-- A real-world workbook (e.g. one tab per store) mixes sheets that share
-- the same payroll layout with a handful of unrelated ones (training
-- logs, absence sheets, etc.) — so a template needs to target a SET of
-- sheets, all read with the same header_row/column mapping, instead of
-- the single fixed sheet_name from the previous migration.
ALTER TABLE payment_templates DROP COLUMN sheet_name;

-- Empty for csv (no concept of sheets). For xlsx/xls/ods, one row per
-- sheet the template should read — everything else in the workbook is
-- skipped.
CREATE TABLE payment_template_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES payment_templates(id),
    sheet_name TEXT NOT NULL,
    UNIQUE (template_id, sheet_name)
);

CREATE INDEX idx_payment_template_sheets_template ON payment_template_sheets(template_id);
