-- A user-designed layout for exporting payment shifts to a styled PDF —
-- the PDF counterpart of payment_export_templates (see PaymentPdfTemplateConfig
-- in src/lib/types.ts). Deliberately a separate table (not a "format" column on
-- payment_export_templates) so the two template kinds stay independently
-- listable/deletable and each config blob remains self-describing. Same opaque
-- JSON-blob-column pattern, same rationale as 0051: nothing about a template's
-- internals is ever queried at the SQL level.
CREATE TABLE payment_pdf_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);