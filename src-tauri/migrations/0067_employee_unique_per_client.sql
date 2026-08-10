-- employees.UNIQUE(company_id, cpf) predates client_id (added later, in
-- 0007_clients.sql) and was never widened to match — it still treats "same
-- CPF, same empresa" as a duplicate regardless of which cliente, even
-- though a company can serve several clients whose workforces are meant to
-- be independent, and every app-level duplicate check (moveEmployeeToClient,
-- updateEmployee, createEmployeeManual) is already scoped to
-- client_id + company_id + cpf specifically for that reason. The mismatch
-- surfaces as a SQLite UNIQUE constraint failure whenever an employee is
-- created in, or moved into ("mover colaborador para outro cliente"), a
-- company that already has a DIFFERENT employee sharing that CPF under a
-- different client — a case the app itself already treats as safe.
--
-- SQLite has no ALTER TABLE for constraints, so this rebuilds `employees`.
-- Two things that look like they'd work here do NOT, verified directly:
--   - `PRAGMA foreign_keys=OFF` is a documented no-op mid-transaction, and
--     tauri-plugin-sql/sqlx always runs each migration inside one — so
--     `DROP TABLE employees` still performs its implicit "DELETE FROM
--     employees" with FK enforcement active, failing against every row
--     imports/payment_shifts/employee_aliases still reference.
--   - `PRAGMA legacy_alter_table=ON` does NOT stop `ALTER TABLE employees
--     RENAME TO employees_old` from auto-rewriting those same three
--     tables' `REFERENCES employees(id)` to `REFERENCES employees_old(id)`
--     — so a later `DROP TABLE employees_old` still fails the same way.
-- The only sequence that actually works (empirically verified against a
-- full copy of production data, byte-for-byte, before writing this):
-- rebuild EVERY table in the dependency chain (employees; its direct
-- children imports/payment_shifts/employee_aliases; and imports' own
-- children day_records/punches) under "_new" names that reference each
-- other's "_new" name, copy all data, drop every OLD table child-first
-- (so no live reference ever points at the table being dropped), then
-- rename every "_new" table into place PARENT-first — each rename's
-- automatic FK-rewrite is what correctly re-targets the next, still-"_new"
-- child, cascading the fix downward instead of fighting it.
PRAGMA foreign_keys = ON;

CREATE TABLE employees_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    cpf TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id),
    matricula TEXT,
    UNIQUE (company_id, client_id, cpf)
);

CREATE TABLE imports_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES employees_new(id),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    original_pdf_path TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    import_file_id INTEGER REFERENCES import_files(id),
    source_file_id INTEGER REFERENCES source_files(id),
    max_punches INTEGER NOT NULL DEFAULT 4,
    total_worked_minutes INTEGER NOT NULL DEFAULT 0,
    overtime_minutes INTEGER NOT NULL DEFAULT 0,
    absence_minutes INTEGER NOT NULL DEFAULT 0,
    regular_minutes INTEGER NOT NULL DEFAULT 0,
    interval_minutes INTEGER NOT NULL DEFAULT 0,
    late_minutes INTEGER NOT NULL DEFAULT 0,
    pending_count INTEGER NOT NULL DEFAULT 0,
    client_id INTEGER REFERENCES clients(id),
    company_id INTEGER REFERENCES companies(id)
);

CREATE TABLE day_records_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports_new(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    weekday TEXT NOT NULL,
    total_worked_minutes INTEGER NOT NULL,
    normal_hours_minutes INTEGER NOT NULL,
    absence_minutes INTEGER NOT NULL,
    observation TEXT
);

CREATE TABLE punches_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_record_id INTEGER NOT NULL REFERENCES day_records_new(id) ON DELETE CASCADE,
    punch_time TEXT NOT NULL,
    sequence_index INTEGER NOT NULL
);

CREATE TABLE payment_shifts_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees_new(id),
    template_id INTEGER REFERENCES payment_templates(id),
    source_file_id INTEGER REFERENCES source_files(id),
    local TEXT NOT NULL DEFAULT '',
    work_date TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pendente',
    error_message TEXT,
    amount REAL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    schedule_start_minutes INTEGER,
    schedule_end_minutes INTEGER,
    previous_shift_id INTEGER REFERENCES payment_shifts_new(id),
    extra_data TEXT,
    edited_manually INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    source_row_number INTEGER,
    source_sheet_name TEXT,
    client_id INTEGER REFERENCES clients(id),
    company_id INTEGER REFERENCES companies(id)
);

CREATE TABLE employee_aliases_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees_new(id),
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO employees_new (id, company_id, name, cpf, client_id, matricula)
SELECT id, company_id, name, cpf, client_id, matricula FROM employees;

INSERT INTO imports_new (id, provider, employee_id, period_start, period_end, original_pdf_path,
    imported_at, import_file_id, source_file_id, max_punches, total_worked_minutes, overtime_minutes,
    absence_minutes, regular_minutes, interval_minutes, late_minutes, pending_count, client_id, company_id)
SELECT id, provider, employee_id, period_start, period_end, original_pdf_path,
    imported_at, import_file_id, source_file_id, max_punches, total_worked_minutes, overtime_minutes,
    absence_minutes, regular_minutes, interval_minutes, late_minutes, pending_count, client_id, company_id
FROM imports;

INSERT INTO day_records_new (id, import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation)
SELECT id, import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation FROM day_records;

INSERT INTO punches_new (id, day_record_id, punch_time, sequence_index)
SELECT id, day_record_id, punch_time, sequence_index FROM punches;

INSERT INTO payment_shifts_new (id, employee_id, template_id, source_file_id, local, work_date, role, note,
    status, error_message, amount, imported_at, schedule_start_minutes, schedule_end_minutes, previous_shift_id,
    extra_data, edited_manually, deleted_at, source_row_number, source_sheet_name, client_id, company_id)
SELECT id, employee_id, template_id, source_file_id, local, work_date, role, note,
    status, error_message, amount, imported_at, schedule_start_minutes, schedule_end_minutes, previous_shift_id,
    extra_data, edited_manually, deleted_at, source_row_number, source_sheet_name, client_id, company_id
FROM payment_shifts;

INSERT INTO employee_aliases_new (id, employee_id, alias, created_at)
SELECT id, employee_id, alias, created_at FROM employee_aliases;

DROP TABLE punches;
DROP TABLE day_records;
DROP TABLE imports;
DROP TABLE payment_shifts;
DROP TABLE employee_aliases;
DROP TABLE employees;

ALTER TABLE employees_new RENAME TO employees;
ALTER TABLE imports_new RENAME TO imports;
ALTER TABLE day_records_new RENAME TO day_records;
ALTER TABLE punches_new RENAME TO punches;
ALTER TABLE payment_shifts_new RENAME TO payment_shifts;
ALTER TABLE employee_aliases_new RENAME TO employee_aliases;

CREATE INDEX idx_employees_client ON employees(client_id);
CREATE INDEX idx_imports_employee ON imports(employee_id);
CREATE INDEX idx_imports_import_file ON imports(import_file_id);
CREATE INDEX idx_day_records_import ON day_records(import_id);
CREATE INDEX idx_punches_day_record ON punches(day_record_id);
CREATE INDEX idx_payment_shifts_employee_date ON payment_shifts(employee_id, work_date);
CREATE INDEX idx_payment_shifts_source_file ON payment_shifts(source_file_id);
CREATE INDEX idx_payment_shifts_previous ON payment_shifts(previous_shift_id);
CREATE INDEX idx_payment_shifts_source_position
  ON payment_shifts(source_sheet_name, source_row_number)
  WHERE source_row_number IS NOT NULL;
CREATE INDEX idx_employee_aliases_employee ON employee_aliases(employee_id);
