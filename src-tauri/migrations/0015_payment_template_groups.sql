-- Different sheets in the same workbook can have genuinely different
-- layouts (extra/missing columns, different order), so a template no
-- longer has one flat header_row + column mapping for every included
-- sheet — it has one or more "groups", each with its own header_row and
-- mapping, covering whichever subset of sheets actually share that
-- layout. Sheets with an identical structure share a group (mapped once);
-- sheets that differ get their own. CSV has no sheets, so it always ends
-- up with exactly one implicit group with no sheet rows under it.
--
-- No saved templates exist yet to migrate forward, so the previous flat
-- shape (payment_templates.header_row, payment_template_sheets/fields
-- keyed straight off template_id) is simply replaced rather than altered
-- in place.
DROP TABLE payment_template_fields;
DROP TABLE payment_template_sheets;
ALTER TABLE payment_templates DROP COLUMN header_row;

CREATE TABLE payment_template_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES payment_templates(id),
    header_row INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_payment_template_groups_template ON payment_template_groups(template_id);

CREATE TABLE payment_template_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES payment_template_groups(id),
    sheet_name TEXT NOT NULL,
    UNIQUE (group_id, sheet_name)
);

CREATE INDEX idx_payment_template_sheets_group ON payment_template_sheets(group_id);

CREATE TABLE payment_template_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES payment_template_groups(id),
    column_letter TEXT NOT NULL,
    target_field TEXT NOT NULL,
    header_label TEXT,
    UNIQUE (group_id, column_letter)
);

CREATE INDEX idx_payment_template_fields_group ON payment_template_fields(group_id);
