-- Every write path to employees.cpf normalizes to digits-only today except
-- the timesheet-PDF-import one (upsertEmployee, fixed alongside this
-- migration) — its parser's CPF regex allows dots/dashes through
-- ([0-9.\-]+), so a punctuated CPF could have been stored for an employee
-- created that way. Since findEmployeeByAttempts's CPF match compares
-- against a digits-only normalized value with no normalization on the
-- stored side, a punctuated row would silently never match again — this
-- backfill is idempotent (a no-op on already-clean values) and closes that
-- gap for any row that predates the fix.
UPDATE employees SET cpf = REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '')
WHERE cpf LIKE '%.%' OR cpf LIKE '%-%' OR cpf LIKE '% %';
