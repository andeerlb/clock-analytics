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
-- different client — a case the app itself already treats as safe. SQLite
-- has no ALTER TABLE for constraints, so this rebuilds the table with the
-- corrected one; every other column/FK/id is preserved as-is.
PRAGMA foreign_keys=OFF;

CREATE TABLE employees_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    cpf TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id),
    matricula TEXT,
    UNIQUE (company_id, client_id, cpf)
);

INSERT INTO employees_new (id, company_id, name, cpf, client_id, matricula)
SELECT id, company_id, name, cpf, client_id, matricula FROM employees;

DROP TABLE employees;
ALTER TABLE employees_new RENAME TO employees;

CREATE INDEX idx_employees_client ON employees(client_id);

PRAGMA foreign_keys=ON;
