-- "Possíveis nomes" — a colaborador can be known by more than one spelling
-- across payment files (e.g. a shortened "Anderson Lucas" for the real
-- "Anderson Lucas Babinski"). Each alias belongs to exactly one colaborador;
-- uniqueness (per client, matching how CPF is scoped) is enforced at the
-- application layer, the same way employees.cpf already is, rather than a
-- DB constraint that would need a join to reach client_id.
CREATE TABLE employee_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_employee_aliases_employee ON employee_aliases(employee_id);
