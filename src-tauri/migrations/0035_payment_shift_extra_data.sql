-- Every column the template left unmapped ("Ignorar") used to be discarded
-- entirely at import time — now kept per shift as history/audit, in case
-- something worth knowing was in a column nobody thought to map. JSON
-- object, columnLetter -> raw text value; NULL when there was nothing left
-- unmapped (or every unmapped cell on that row was blank).
ALTER TABLE payment_shifts ADD COLUMN extra_data TEXT;
