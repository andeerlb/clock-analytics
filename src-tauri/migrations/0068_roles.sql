-- "Função" moves from free-text on payment_shifts.role to a real cadastro,
-- mirroring employees/employee_aliases: `roles` is the master list, scoped
-- per company only (a função belongs to an empresa, not to a specific
-- cliente — different from employees, which are client_id+company_id
-- scoped), and `role_aliases` holds the "nomes possíveis" that make
-- alternate spellings from an imported file (e.g. "MERCEARIA" vs
-- "Mercearia") resolve to the same função during matching.
--
-- payment_shifts.role_id is purely additive: a plain `ALTER TABLE ADD
-- COLUMN ... REFERENCES` is safe here (unlike the employees rebuild in
-- 0067) because nothing else has an FK into payment_shifts except itself
-- (previous_shift_id) — there's no child table whose REFERENCES would need
-- rewriting. The existing `role` text column is untouched and keeps being
-- the display/export source exactly as before; role_id is only used for
-- matching and filtering.
CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_roles_company ON roles(company_id);

CREATE TABLE role_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_role_aliases_role ON role_aliases(role_id);

ALTER TABLE payment_shifts ADD COLUMN role_id INTEGER REFERENCES roles(id);

CREATE INDEX idx_payment_shifts_role ON payment_shifts(role_id);

-- Backfill: one função per (company_id, case-insensitive trimmed text)
-- already present in payment_shifts.role, picking the most common exact
-- spelling as the canonical name (ties broken alphabetically, just to be
-- deterministic).
INSERT INTO roles (company_id, name)
SELECT company_id, name FROM (
  SELECT ps.company_id AS company_id, TRIM(ps.role) AS name,
         ROW_NUMBER() OVER (
           PARTITION BY ps.company_id, LOWER(TRIM(ps.role))
           ORDER BY COUNT(*) DESC, TRIM(ps.role)
         ) AS rn
  FROM payment_shifts ps
  WHERE TRIM(ps.role) <> '' AND ps.company_id IS NOT NULL
  GROUP BY ps.company_id, TRIM(ps.role)
) t
WHERE rn = 1;

UPDATE payment_shifts
SET role_id = (
  SELECT r.id FROM roles r
  WHERE r.company_id = payment_shifts.company_id
    AND LOWER(r.name) = LOWER(TRIM(payment_shifts.role))
)
WHERE TRIM(role) <> '' AND company_id IS NOT NULL;
