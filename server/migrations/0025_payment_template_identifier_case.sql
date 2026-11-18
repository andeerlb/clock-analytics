-- Each tentativa gains its own case-sensitivity flag for matching field
-- values (matrícula/nome), the same idea payment_template_rules' values
-- already have. The stored shape changes from an array of field-name
-- arrays to an array of {fields, caseInsensitive} objects, so existing
-- rows (all test data so far, from this feature's own development) are
-- reset to the new shape's default rather than migrated in place.
ALTER TABLE payment_templates DROP COLUMN identifier_priority;
ALTER TABLE payment_templates ADD COLUMN identifier_priority TEXT NOT NULL DEFAULT
    '[{"fields":["cpf"],"caseInsensitive":true},{"fields":["matricula"],"caseInsensitive":true},{"fields":["nome"],"caseInsensitive":true}]';
