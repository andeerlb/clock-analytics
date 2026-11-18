-- A user-designed layout for exporting payment shifts to a real, styled
-- .xlsx (columns, colors, grouping, subtotal rows — see PaymentExportTemplateConfig
-- in src/lib/types.ts). Unlike payment_templates (whose rules/groups are
-- normalized child tables because they're queried/joined at the SQL level,
-- e.g. by company_id/client_id), nothing about an export template's
-- internals is ever queried that way — it's opaque config, read and written
-- whole. One JSON blob column, same idea as payment_settings.visible_columns_json.
CREATE TABLE payment_export_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
