-- A client belongs to exactly one company; a company can have many clients.
-- CNPJ only needs to be unique *within* a company, not globally.
CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    cnpj TEXT NOT NULL,
    UNIQUE (company_id, cnpj)
);

CREATE INDEX idx_clients_company ON clients(company_id);

-- Employees now link to the specific client their timesheet data belongs
-- to; `company_id` stays too (derived from the client at import time) so
-- existing company-scoped filters/joins keep working unchanged.
ALTER TABLE employees ADD COLUMN client_id INTEGER REFERENCES clients(id);

CREATE INDEX idx_employees_client ON employees(client_id);
