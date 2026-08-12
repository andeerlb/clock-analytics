-- Same idea as 0071_employee_company_link.sql, one dimension further: a
-- colaborador stops being scoped to a single cliente too. Today employees.
-- UNIQUE(client_id, cpf) means the same real person working for two
-- different clientes gets TWO separate `employees` rows — and since a
-- empresa can already serve more than one cliente (client_companies is
-- many-to-many), a colaborador's empresa link has to say *which* cliente
-- it's for, not just "linked to this empresa" — otherwise linking someone
-- to an empresa that serves 3 clientes would be ambiguous about which of
-- the 3 they actually work at.
--
-- New model: `employees` is one row per person, period — UNIQUE(cpf), no
-- client_id at all. `employee_companies` (employee_id, company_id,
-- matricula) is replaced by `employee_client_companies` (employee_id,
-- client_id, company_id, matricula) — the atomic fact is "this person
-- works at this cliente via this empresa, with this matrícula", matching
-- exactly what resolving a payment row already needs (a routing rule
-- resolves a client_id+company_id pair together, never just one alone).
--
-- Verified against a live copy of the data before writing this: 0 people
-- currently share a CPF across different clientes (unlike 0071's 272
-- cross-empresa duplicates), so the canonical-merge logic below is a
-- safety net for a case that doesn't exist in today's data, not something
-- this run actually needs to resolve — kept anyway so this doesn't quietly
-- corrupt data if that ever stops being true before this runs.
--
-- Same rebuild-the-whole-chain technique as 0067/0071, for the same
-- reason: SQLite has no ALTER TABLE for constraints, this always runs
-- inside a transaction (tauri-plugin-sql), so DROP TABLE employees still
-- performs its implicit FK-checked delete against every row still
-- referencing it. Every table in the chain — verified exhaustively this
-- time by scanning sqlite_master for every CREATE TABLE mentioning any of
-- these as a FK target, not just grepping migration files by hand (how
-- 0071 missed source_url_check_diffs.applied/dismissed_at the first
-- time) — gets rebuilt under `_new` names, data copies across, every old
-- table drops child-first, every `_new` table renames into place
-- parent-first.
PRAGMA foreign_keys = ON;

-- 0071_employee_company_link.sql creates a TEMP TABLE of this exact same
-- name and never drops it. tauri-plugin-sql/sqlx's migrator runs every
-- pending migration sequentially over ONE shared connection per app
-- launch, and a TEMP TABLE lives on that connection (not scoped to any one
-- migration's own transaction) — so on any database that has to apply 0071
-- and this migration back-to-back in the same launch (a fresh install, or
-- one that was several versions behind), 0071's `employee_canonical`
-- survives its own commit and collides with this one's `CREATE TEMP TABLE`
-- below with "table employee_canonical already exists", before this
-- migration ever gets to its own actual work. Only 0071 and 0072 ever
-- landing in the SAME session (rather than two separate app launches, each
-- getting a fresh connection) is why this wasn't caught testing them
-- individually against a real data copy beforehand. Harmless either way:
-- if 0071's leftover is there, this clears it first; if this is a fresh
-- connection (0071 ran in an earlier launch) there's nothing to drop.
DROP TABLE IF EXISTS employee_canonical;

-- Which surviving "canonical" employee id each existing employee row folds
-- into, same tie-break as 0071: most existing history (payment_shifts +
-- imports combined), lowest id breaks ties.
CREATE TEMP TABLE employee_canonical AS
SELECT
  e.id AS old_id,
  FIRST_VALUE(e.id) OVER (
    PARTITION BY e.cpf
    ORDER BY
      (SELECT COUNT(*) FROM payment_shifts ps WHERE ps.employee_id = e.id) +
      (SELECT COUNT(*) FROM imports i WHERE i.employee_id = e.id) DESC,
      e.id ASC
  ) AS canonical_id
FROM employees e;

CREATE TABLE employees_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cpf TEXT NOT NULL,
    UNIQUE (cpf)
);

CREATE TABLE employee_client_companies_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees_new(id),
    client_id INTEGER NOT NULL REFERENCES clients(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    matricula TEXT,
    UNIQUE (employee_id, client_id, company_id)
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    applied INTEGER NOT NULL DEFAULT 0,
    dismissed_at TEXT
);

-- One row per canonical id, keeping its own current name/cpf — merged-away
-- duplicates' names survive separately as aliases, below.
INSERT INTO employees_new (id, name, cpf)
SELECT e.id, e.name, e.cpf
FROM employees e
WHERE e.id IN (SELECT DISTINCT canonical_id FROM employee_canonical);

-- One row per (canonical, cliente-daquele-vínculo, empresa) — every
-- original employee_companies row already meant "this company_id, for
-- whichever cliente that employee row belonged to", so it maps straight
-- across using that OLD employee row's own client_id.
INSERT INTO employee_client_companies_new (employee_id, client_id, company_id, matricula)
SELECT canon.canonical_id, e.client_id, oc.company_id, oc.matricula
FROM employee_companies oc
JOIN employees e ON e.id = oc.employee_id
JOIN employee_canonical canon ON canon.old_id = oc.employee_id;

INSERT INTO imports_new (id, provider, employee_id, period_start, period_end, original_pdf_path,
    imported_at, import_file_id, source_file_id, max_punches, total_worked_minutes, overtime_minutes,
    absence_minutes, regular_minutes, interval_minutes, late_minutes, pending_count, client_id, company_id)
SELECT i.id, i.provider, canon.canonical_id, i.period_start, i.period_end, i.original_pdf_path,
    i.imported_at, i.import_file_id, i.source_file_id, i.max_punches, i.total_worked_minutes, i.overtime_minutes,
    i.absence_minutes, i.regular_minutes, i.interval_minutes, i.late_minutes, i.pending_count, i.client_id, i.company_id
FROM imports i
JOIN employee_canonical canon ON canon.old_id = i.employee_id;

INSERT INTO day_records_new (id, import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation)
SELECT id, import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation FROM day_records;

INSERT INTO punches_new (id, day_record_id, punch_time, sequence_index)
SELECT id, day_record_id, punch_time, sequence_index FROM punches;

INSERT INTO payment_shifts_new (id, employee_id, template_id, source_file_id, local, work_date, note,
    status, error_message, amount, imported_at, schedule_start_minutes, schedule_end_minutes, previous_shift_id,
    extra_data, edited_manually, deleted_at, source_row_number, source_sheet_name, client_id, company_id, role_id)
SELECT ps.id, canon.canonical_id, ps.template_id, ps.source_file_id, ps.local, ps.work_date, ps.note,
    ps.status, ps.error_message, ps.amount, ps.imported_at, ps.schedule_start_minutes, ps.schedule_end_minutes, ps.previous_shift_id,
    ps.extra_data, ps.edited_manually, ps.deleted_at, ps.source_row_number, ps.source_sheet_name, ps.client_id, ps.company_id, ps.role_id
FROM payment_shifts ps
JOIN employee_canonical canon ON canon.old_id = ps.employee_id;

-- Unchanged data — payment_shifts.id itself never changes, so
-- matched_shift_id doesn't need remapping, only the table it points at.
INSERT INTO source_url_check_diffs_new (id, check_log_id, config_id, config_label, change_kind, matched_shift_id,
    employee_id, employee_name, work_date, local, role, schedule_start_minutes, schedule_end_minutes,
    sheet_name, row_number, column_letter, field_name, old_value, new_value, message, created_at,
    applied, dismissed_at)
SELECT id, check_log_id, config_id, config_label, change_kind, matched_shift_id,
    employee_id, employee_name, work_date, local, role, schedule_start_minutes, schedule_end_minutes,
    sheet_name, row_number, column_letter, field_name, old_value, new_value, message, created_at,
    applied, dismissed_at
FROM source_url_check_diffs;

-- Existing aliases, remapped to their canonical employee — de-duplicated
-- (alias text, not id) since two merging duplicates could each already
-- have recorded the same alias text independently.
INSERT INTO employee_aliases_new (employee_id, alias, created_at)
SELECT canon.canonical_id, a.alias, MIN(a.created_at)
FROM employee_aliases a
JOIN employee_canonical canon ON canon.old_id = a.employee_id
GROUP BY canon.canonical_id, a.alias;

-- A merged-away duplicate's own name, preserved as an alias when it isn't
-- just a spelling/case match for the canonical's name that's already
-- covered.
INSERT INTO employee_aliases_new (employee_id, alias)
SELECT DISTINCT canon.canonical_id, e.name
FROM employees e
JOIN employee_canonical canon ON canon.old_id = e.id
WHERE canon.old_id <> canon.canonical_id
  AND e.name <> (SELECT c2.name FROM employees c2 WHERE c2.id = canon.canonical_id)
  AND NOT EXISTS (
    SELECT 1 FROM employee_aliases_new ex WHERE ex.employee_id = canon.canonical_id AND ex.alias = e.name
  );

-- Cleared once it's done its job — same reasoning as the `DROP TABLE IF
-- EXISTS` above this migration's own `CREATE TEMP TABLE`: left behind, it
-- would trip up any future migration that happens to reuse this name in
-- the same session, the exact way 0071's own leftover tripped up this one.
DROP TABLE employee_canonical;

DROP TABLE punches;
DROP TABLE day_records;
DROP TABLE imports;
DROP TABLE source_url_check_diffs;
DROP TABLE payment_shifts;
DROP TABLE employee_aliases;
DROP TABLE employee_companies;
DROP TABLE employees;

ALTER TABLE employees_new RENAME TO employees;
ALTER TABLE employee_client_companies_new RENAME TO employee_client_companies;
ALTER TABLE imports_new RENAME TO imports;
ALTER TABLE day_records_new RENAME TO day_records;
ALTER TABLE punches_new RENAME TO punches;
ALTER TABLE payment_shifts_new RENAME TO payment_shifts;
ALTER TABLE source_url_check_diffs_new RENAME TO source_url_check_diffs;
ALTER TABLE employee_aliases_new RENAME TO employee_aliases;

CREATE INDEX idx_employee_client_companies_employee ON employee_client_companies(employee_id);
CREATE INDEX idx_employee_client_companies_client ON employee_client_companies(client_id);
CREATE INDEX idx_employee_client_companies_company ON employee_client_companies(company_id);
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
