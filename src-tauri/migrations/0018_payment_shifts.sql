-- One row per imported work shift (place/day/role/hours) — not a payment
-- amount. A shift is additive by nature (an employee can and will have
-- many, across many separate imports), so unlike imports/day_records this
-- is never overwritten by a later import of the same period, only ever
-- appended to. Amount and the pago/erro status transitions belong to a
-- later "processar pagamento" step, not to import — every row starts
-- pendente.
CREATE TABLE payment_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    template_id INTEGER REFERENCES payment_templates(id),
    source_file_id INTEGER REFERENCES source_files(id),
    local TEXT NOT NULL DEFAULT '',
    work_date TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '',
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pendente',
    error_message TEXT,
    amount REAL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payment_shifts_employee_date ON payment_shifts(employee_id, work_date);
CREATE INDEX idx_payment_shifts_source_file ON payment_shifts(source_file_id);
