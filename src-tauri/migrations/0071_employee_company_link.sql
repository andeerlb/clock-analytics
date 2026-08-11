-- "Colaborador" stops being scoped to a single empresa. Today employees.
-- UNIQUE(company_id, client_id, cpf) means the same real person (same CPF)
-- working through two different empresas for the same cliente (e.g. "FC"
-- and "RF" both serving cliente "Bistek") gets TWO separate `employees`
-- rows — which then duplicates them across every employee-scoped table
-- (imports, payment_shifts, employee_aliases) and every list in the app.
-- Verified against a copy of real data before writing this: 272 of 751
-- employees (36%) were exactly this kind of duplicate, always split across
-- exactly two empresas, never three+.
--
-- The new model: one `employees` row per (client_id, cpf) — a person, not a
-- person-at-an-empresa — linked to however many empresas via the new
-- `employee_companies` (which also gets a per-empresa `matricula`, since a
-- matrícula is issued by the empresa's own payroll, not shared across two).
-- `payment_shifts`/`imports` don't need any FK change here — since
-- 0060/0061 they already snapshot their own client_id/company_id instead of
-- deriving it live through the employee, so "which empresa paid this turno"
-- was never actually tied to which of the (soon to be merged) employee rows
-- it pointed at.
--
-- Same rebuild-the-whole-chain technique as
-- 0067_employee_unique_per_client.sql, for the same reason: SQLite has no
-- ALTER TABLE for constraints, and this migration always runs inside a
-- transaction (tauri-plugin-sql), so PRAGMA foreign_keys=OFF is a no-op and
-- DROP TABLE employees still performs its implicit FK-checked delete
-- against every row imports/payment_shifts/employee_aliases still
-- reference. `employees` (with an added table) → `imports` →
-- `day_records`/`punches`, and `employees` → `payment_shifts` /
-- `employee_aliases`, every child gets an `_new` sibling referencing the
-- others' `_new` names, data copies across, every old table drops
-- child-first, then every `_new` table renames into place parent-first.
PRAGMA foreign_keys = ON;

-- Which surviving "canonical" employee id each existing employee row
-- (duplicate or not) folds into. Canonical = most existing history
-- (payment_shifts + imports combined) within its (client_id, cpf) group —
-- picking the row real work is already attached to, so the fewest rows
-- need repointing and whichever id already shows up in the most places
-- keeps being the one that's valid. Ties (including groups with no
-- history at all — most of the 272 pairs found had zero shifts on EITHER
-- side) break on the lowest id, so the choice is deterministic.
CREATE TEMP TABLE employee_canonical AS
SELECT
  e.id AS old_id,
  FIRST_VALUE(e.id) OVER (
    PARTITION BY e.client_id, e.cpf
    ORDER BY
      (SELECT COUNT(*) FROM payment_shifts ps WHERE ps.employee_id = e.id) +
      (SELECT COUNT(*) FROM imports i WHERE i.employee_id = e.id) DESC,
      e.id ASC
  ) AS canonical_id
FROM employees e;

CREATE TABLE employees_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    name TEXT NOT NULL,
    cpf TEXT NOT NULL,
    UNIQUE (client_id, cpf)
);

CREATE TABLE employee_companies_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees_new(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    matricula TEXT,
    UNIQUE (employee_id, company_id)
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
    company_id INTEGER REFERENCES companies(id),
    role_id INTEGER REFERENCES roles(id)
);

CREATE TABLE employee_aliases_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees_new(id),
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Also a child of payment_shifts (matched_shift_id), missed on first pass
-- of this migration and caught by testing against a real copy of the data
-- (see the conversation this migration was written in) — `DROP TABLE
-- payment_shifts` below fails its implicit FK-checked delete otherwise,
-- for any row here whose matched_shift_id isn't NULL. Every other column
-- is a plain snapshot (no FK) or points at tables untouched by this
-- migration (source_url_check_log, source_url_reimport_configs), so only
-- matched_shift_id's target changes.
CREATE TABLE source_url_check_diffs_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_log_id INTEGER NOT NULL REFERENCES source_url_check_log(id),
    config_id INTEGER REFERENCES source_url_reimport_configs(id),
    config_label TEXT NOT NULL DEFAULT '',
    change_kind TEXT NOT NULL,
    matched_shift_id INTEGER REFERENCES payment_shifts_new(id),
    employee_id INTEGER,
    employee_name TEXT,
    work_date TEXT,
    local TEXT,
    role TEXT,
    schedule_start_minutes INTEGER,
    schedule_end_minutes INTEGER,
    sheet_name TEXT,
    row_number INTEGER,
    column_letter TEXT,
    field_name TEXT,
    old_value TEXT,
    new_value TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per canonical id, keeping its own current name/cpf/client_id —
-- the merged-away duplicates' names survive separately, as aliases, below.
INSERT INTO employees_new (id, client_id, name, cpf)
SELECT e.id, e.client_id, e.name, e.cpf
FROM employees e
WHERE e.id IN (SELECT DISTINCT canonical_id FROM employee_canonical);

-- One row per (canonical, empresa) — every original row's own company_id
-- and matricula become a link, not a second person. Within one
-- (client_id, cpf) group the old UNIQUE(company_id, client_id, cpf) made
-- at most one row per company_id possible, so this can't collide.
INSERT INTO employee_companies_new (employee_id, company_id, matricula)
SELECT ec.canonical_id, e.company_id, e.matricula
FROM employees e
JOIN employee_canonical ec ON ec.old_id = e.id;

INSERT INTO imports_new (id, provider, employee_id, period_start, period_end, original_pdf_path,
    imported_at, import_file_id, source_file_id, max_punches, total_worked_minutes, overtime_minutes,
    absence_minutes, regular_minutes, interval_minutes, late_minutes, pending_count, client_id, company_id)
SELECT i.id, i.provider, ec.canonical_id, i.period_start, i.period_end, i.original_pdf_path,
    i.imported_at, i.import_file_id, i.source_file_id, i.max_punches, i.total_worked_minutes, i.overtime_minutes,
    i.absence_minutes, i.regular_minutes, i.interval_minutes, i.late_minutes, i.pending_count, i.client_id, i.company_id
FROM imports i
JOIN employee_canonical ec ON ec.old_id = i.employee_id;

INSERT INTO day_records_new (id, import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation)
SELECT id, import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation FROM day_records;

INSERT INTO punches_new (id, day_record_id, punch_time, sequence_index)
SELECT id, day_record_id, punch_time, sequence_index FROM punches;

INSERT INTO payment_shifts_new (id, employee_id, template_id, source_file_id, local, work_date, note,
    status, error_message, amount, imported_at, schedule_start_minutes, schedule_end_minutes, previous_shift_id,
    extra_data, edited_manually, deleted_at, source_row_number, source_sheet_name, client_id, company_id, role_id)
SELECT ps.id, ec.canonical_id, ps.template_id, ps.source_file_id, ps.local, ps.work_date, ps.note,
    ps.status, ps.error_message, ps.amount, ps.imported_at, ps.schedule_start_minutes, ps.schedule_end_minutes, ps.previous_shift_id,
    ps.extra_data, ps.edited_manually, ps.deleted_at, ps.source_row_number, ps.source_sheet_name, ps.client_id, ps.company_id, ps.role_id
FROM payment_shifts ps
JOIN employee_canonical ec ON ec.old_id = ps.employee_id;

-- Unchanged data — payment_shifts.id itself never changes (copied straight
-- across above), so matched_shift_id doesn't need remapping, only the
-- table it points at.
INSERT INTO source_url_check_diffs_new (id, check_log_id, config_id, config_label, change_kind, matched_shift_id,
    employee_id, employee_name, work_date, local, role, schedule_start_minutes, schedule_end_minutes,
    sheet_name, row_number, column_letter, field_name, old_value, new_value, message, created_at)
SELECT id, check_log_id, config_id, config_label, change_kind, matched_shift_id,
    employee_id, employee_name, work_date, local, role, schedule_start_minutes, schedule_end_minutes,
    sheet_name, row_number, column_letter, field_name, old_value, new_value, message, created_at
FROM source_url_check_diffs;

-- Existing aliases, remapped to their canonical employee — de-duplicated
-- (alias text, not id) since two merging duplicates could each already
-- have recorded the same alias text independently.
INSERT INTO employee_aliases_new (employee_id, alias, created_at)
SELECT ec.canonical_id, a.alias, MIN(a.created_at)
FROM employee_aliases a
JOIN employee_canonical ec ON ec.old_id = a.employee_id
GROUP BY ec.canonical_id, a.alias;

-- A merged-away duplicate's own name, preserved as an alias when it isn't
-- just a spelling/case match for the canonical's name that's already
-- covered — e.g. "ROBERTO Gonçalves da Silva" merging into a canonical
-- named "ROBERTO GONCALVES DA SILVA" still stays findable by either
-- spelling in a future payment-file import.
INSERT INTO employee_aliases_new (employee_id, alias)
SELECT DISTINCT ec.canonical_id, e.name
FROM employees e
JOIN employee_canonical ec ON ec.old_id = e.id
WHERE ec.old_id <> ec.canonical_id
  AND e.name <> (SELECT canon.name FROM employees canon WHERE canon.id = ec.canonical_id)
  AND NOT EXISTS (
    SELECT 1 FROM employee_aliases_new ex WHERE ex.employee_id = ec.canonical_id AND ex.alias = e.name
  );

DROP TABLE punches;
DROP TABLE day_records;
DROP TABLE imports;
DROP TABLE source_url_check_diffs;
DROP TABLE payment_shifts;
DROP TABLE employee_aliases;
DROP TABLE employees;

ALTER TABLE employees_new RENAME TO employees;
ALTER TABLE employee_companies_new RENAME TO employee_companies;
ALTER TABLE imports_new RENAME TO imports;
ALTER TABLE day_records_new RENAME TO day_records;
ALTER TABLE punches_new RENAME TO punches;
ALTER TABLE payment_shifts_new RENAME TO payment_shifts;
ALTER TABLE source_url_check_diffs_new RENAME TO source_url_check_diffs;
ALTER TABLE employee_aliases_new RENAME TO employee_aliases;

CREATE INDEX idx_employees_client ON employees(client_id);
CREATE INDEX idx_employee_companies_employee ON employee_companies(employee_id);
CREATE INDEX idx_employee_companies_company ON employee_companies(company_id);
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
CREATE INDEX idx_payment_shifts_role ON payment_shifts(role_id);
CREATE INDEX idx_employee_aliases_employee ON employee_aliases(employee_id);
CREATE INDEX idx_source_url_check_diffs_log ON source_url_check_diffs(check_log_id);
