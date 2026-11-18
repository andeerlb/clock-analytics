-- Corrects the client/company relationship: a client's CNPJ is one physical
-- entity, globally unique — just like a company's — but the *same* client
-- can be linked to more than one company. Genuinely many-to-many, not
-- "a client belongs to one company" as 0007 modeled it.
DROP TABLE clients;

CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cnpj TEXT NOT NULL UNIQUE
);

CREATE TABLE client_companies (
    client_id INTEGER NOT NULL REFERENCES clients(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    PRIMARY KEY (client_id, company_id)
);

CREATE INDEX idx_client_companies_company ON client_companies(company_id);
CREATE INDEX idx_client_companies_client ON client_companies(client_id);
