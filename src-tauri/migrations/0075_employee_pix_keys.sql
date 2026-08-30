CREATE TABLE employee_pix_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    key_value TEXT NOT NULL,
    key_type TEXT NOT NULL CHECK (key_type IN ('cpf', 'cnpj', 'phone', 'email', 'random', 'other')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (employee_id, key_value)
);

CREATE INDEX idx_employee_pix_keys_employee ON employee_pix_keys(employee_id);
