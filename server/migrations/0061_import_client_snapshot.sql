-- Same reasoning as 0060_payment_shift_client_snapshot.sql, for `imports`
-- (Cartão Ponto) instead of payment_shifts: stop deriving client/company
-- live through employees.client_id/company_id, snapshot it on the row
-- itself at import time instead. `saveParsedTimesheet` already receives
-- clientId/companyId as explicit, user-chosen, already-validated
-- parameters — it just wasn't writing them onto the row before.
ALTER TABLE imports ADD COLUMN client_id INTEGER REFERENCES clients(id);
ALTER TABLE imports ADD COLUMN company_id INTEGER REFERENCES companies(id);

UPDATE imports SET
  client_id = (SELECT client_id FROM employees WHERE employees.id = imports.employee_id),
  company_id = (SELECT company_id FROM employees WHERE employees.id = imports.employee_id);
