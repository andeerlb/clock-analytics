-- Some colaboradores exist as multiple `employees` rows sharing the exact
-- same name (case/whitespace-insensitive) but DIFFERENT CPFs — so
-- 0072_employee_client_link.sql's CPF-based merge never caught them
-- (verified against a real copy of the data: 11 such groups, e.g. "Yuri
-- Manoel" existed as 3 rows, each with its own distinct CPF). Confirmed by
-- the user these are genuinely the same person, matched by name alone
-- since the CPFs themselves differ (a data-entry mistake on one or more of
-- them, not a real distinct identity) — a real CPF mismatch normally means
-- two different people, so this is a one-time, explicitly-requested
-- cleanup for this specific already-reviewed situation, not a general rule
-- this app applies automatically going forward (a common name shared by
-- two actually-different colaboradores must never be silently merged this
-- way — see `findEmployeeByAttempts`, which still keys off cpf/matrícula
-- ahead of nome for exactly that reason).
--
-- Doesn't change any table's shape — only reassigns/removes specific rows
-- — so unlike 0067/0071/0072 this doesn't need the rebuild-the-whole-chain
-- technique; plain UPDATE/DELETE inside the always-on transaction
-- (tauri-plugin-sql) is enough, since no table's CREATE TABLE statement
-- changes and every FK target (payment_shifts.id, imports.id, ...) stays
-- exactly where it was — only which `employees` row they point at moves.
PRAGMA foreign_keys = ON;

-- Which surviving "canonical" employee id each employee row folds into,
-- per case/whitespace-insensitive name group — same tie-break 0071/0072
-- used: most existing history (payment_shifts + imports combined) wins,
-- lowest id breaks ties. A name with no duplicates maps to itself (a
-- no-op for that row in every step below).
CREATE TEMP TABLE name_dup_canonical AS
SELECT
  e.id AS old_id,
  FIRST_VALUE(e.id) OVER (
    PARTITION BY lower(trim(e.name))
    ORDER BY
      (SELECT COUNT(*) FROM payment_shifts ps WHERE ps.employee_id = e.id) +
      (SELECT COUNT(*) FROM imports i WHERE i.employee_id = e.id) DESC,
      e.id ASC
  ) AS canonical_id
FROM employees e;

-- Cliente/empresa links from every merged-away row, collapsed onto the
-- canonical. GROUP BY handles two cases at once: a merged-away row's pair
-- the canonical already has (skipped via NOT EXISTS), and two merged-away
-- rows in the same name group that both happen to link the identical pair
-- (e.g. two of the three "Yuri Manoel" rows both linked Bistek/FC) — either
-- would otherwise violate UNIQUE(employee_id, client_id, company_id) on
-- the second insert. MAX(matricula) keeps whichever isn't NULL when only
-- one side of a collapsed pair had one recorded.
INSERT INTO employee_client_companies (employee_id, client_id, company_id, matricula)
SELECT canon.canonical_id, ecc.client_id, ecc.company_id, MAX(ecc.matricula)
FROM employee_client_companies ecc
JOIN name_dup_canonical canon ON canon.old_id = ecc.employee_id
WHERE canon.old_id <> canon.canonical_id
  AND NOT EXISTS (
    SELECT 1 FROM employee_client_companies existing
    WHERE existing.employee_id = canon.canonical_id
      AND existing.client_id = ecc.client_id
      AND existing.company_id = ecc.company_id
  )
GROUP BY canon.canonical_id, ecc.client_id, ecc.company_id;

UPDATE imports SET employee_id = (
  SELECT canonical_id FROM name_dup_canonical WHERE old_id = imports.employee_id
)
WHERE employee_id IN (SELECT old_id FROM name_dup_canonical WHERE old_id <> canonical_id);

UPDATE payment_shifts SET employee_id = (
  SELECT canonical_id FROM name_dup_canonical WHERE old_id = payment_shifts.employee_id
)
WHERE employee_id IN (SELECT old_id FROM name_dup_canonical WHERE old_id <> canonical_id);

-- Existing "possíveis nomes" from merged-away rows, de-duplicated (alias
-- text, not id) against whatever the canonical already has — including
-- another merged-away row in the same name group recording the identical
-- alias text (GROUP BY collapses that the same way as the link insert
-- above).
INSERT INTO employee_aliases (employee_id, alias)
SELECT canon.canonical_id, a.alias
FROM employee_aliases a
JOIN name_dup_canonical canon ON canon.old_id = a.employee_id
WHERE canon.old_id <> canon.canonical_id
  AND NOT EXISTS (
    SELECT 1 FROM employee_aliases existing
    WHERE existing.employee_id = canon.canonical_id AND lower(existing.alias) = lower(a.alias)
  )
GROUP BY canon.canonical_id, lower(a.alias);

-- Each merged-away row's own name, preserved as a "possível nome" when its
-- exact spelling differs from the canonical's (this is a case/whitespace-
-- insensitive merge, so two rows in the same group can have genuinely
-- different literal spellings, e.g. "yuri manoel" merging into a canonical
-- named "Yuri Manoel") — so a future import using either spelling still
-- resolves to the same colaborador.
INSERT INTO employee_aliases (employee_id, alias)
SELECT canon.canonical_id, e.name
FROM employees e
JOIN name_dup_canonical canon ON canon.old_id = e.id
WHERE canon.old_id <> canon.canonical_id
  AND e.name <> (SELECT c2.name FROM employees c2 WHERE c2.id = canon.canonical_id)
  AND NOT EXISTS (
    SELECT 1 FROM employee_aliases existing
    WHERE existing.employee_id = canon.canonical_id AND lower(existing.alias) = lower(e.name)
  )
GROUP BY canon.canonical_id, e.name;

DELETE FROM employee_aliases WHERE employee_id IN (
  SELECT old_id FROM name_dup_canonical WHERE old_id <> canonical_id
);
DELETE FROM employee_client_companies WHERE employee_id IN (
  SELECT old_id FROM name_dup_canonical WHERE old_id <> canonical_id
);
DELETE FROM employees WHERE id IN (
  SELECT old_id FROM name_dup_canonical WHERE old_id <> canonical_id
);
