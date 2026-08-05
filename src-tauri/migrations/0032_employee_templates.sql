-- A colaborador-import template is a simplified sibling of payment_templates:
-- same column-mapping-groups shape (mirroring payment_templates as of
-- migration 0025), but with no client_id (company/client are chosen at
-- import *execution* time, not baked into the template — see
-- ImportEmployeesPage.tsx) and no date_format/decimal_separator (there's no
-- date field in this vocabulary at all — just cpf/matricula/nome).
CREATE TABLE employee_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_kind TEXT NOT NULL,
    delimiter TEXT,
    identifier_priority TEXT NOT NULL DEFAULT '[{"fields":["cpf"],"caseInsensitive":true},{"fields":["matricula"],"caseInsensitive":true},{"fields":["nome"],"caseInsensitive":true}]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE employee_template_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES employee_templates(id)
);
CREATE INDEX idx_employee_template_groups_template ON employee_template_groups(template_id);

CREATE TABLE employee_template_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES employee_template_groups(id),
    sheet_name TEXT NOT NULL,
    UNIQUE (group_id, sheet_name)
);
CREATE INDEX idx_employee_template_sheets_group ON employee_template_sheets(group_id);

CREATE TABLE employee_template_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES employee_template_groups(id),
    column_letter TEXT NOT NULL,
    target_field TEXT NOT NULL,
    header_label TEXT,
    UNIQUE (group_id, column_letter)
);
CREATE INDEX idx_employee_template_fields_group ON employee_template_fields(group_id);
