CREATE TABLE companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cnpj TEXT NOT NULL UNIQUE
);

CREATE TABLE employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    cpf TEXT NOT NULL,
    UNIQUE (company_id, cpf)
);

CREATE TABLE imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    original_pdf_path TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE day_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    weekday TEXT NOT NULL,
    total_worked_minutes INTEGER NOT NULL,
    normal_hours_minutes INTEGER NOT NULL,
    absence_minutes INTEGER NOT NULL,
    observation TEXT
);

CREATE TABLE punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_record_id INTEGER NOT NULL REFERENCES day_records(id) ON DELETE CASCADE,
    punch_time TEXT NOT NULL,
    sequence_index INTEGER NOT NULL
);

CREATE INDEX idx_day_records_import ON day_records(import_id);
CREATE INDEX idx_punches_day_record ON punches(day_record_id);
CREATE INDEX idx_imports_employee ON imports(employee_id);
