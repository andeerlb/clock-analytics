-- payment_shifts stops deriving "which client/company does this turno
-- belong to" LIVE via a join through employees.client_id/company_id, and
-- instead snapshots its own client_id/company_id at the moment the row is
-- created (or resynced from the source file). This is what makes "mover
-- colaborador para outro cliente" (moving an employee's home client/company
-- registration) a forward-only change instead of one that silently rewrites
-- every historical turno's displayed client/company the instant it's saved.
--
-- Backfill uses the CURRENT employee's client/company — the best (only)
-- data available for rows imported before this migration, since there was
-- never a per-row snapshot to recover. This does not change what any
-- existing row displays today; it only stops future employee moves from
-- retroactively changing it.
ALTER TABLE payment_shifts ADD COLUMN client_id INTEGER REFERENCES clients(id);
ALTER TABLE payment_shifts ADD COLUMN company_id INTEGER REFERENCES companies(id);

UPDATE payment_shifts SET
  client_id = (SELECT client_id FROM employees WHERE employees.id = payment_shifts.employee_id),
  company_id = (SELECT company_id FROM employees WHERE employees.id = payment_shifts.employee_id);
