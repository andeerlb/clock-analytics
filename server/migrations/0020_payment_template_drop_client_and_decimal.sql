-- A template no longer targets a single fixed client — which client/company
-- a row belongs to is now resolved per row by `payment_template_rules`
-- (see 0021), always required, even for a file that only ever has one
-- client. decimal_separator never got used: there's no monetary value
-- parsed at import time, only raw shift data.
--
-- The index from 0013 has to go first — SQLite refuses to drop a column
-- that's still referenced by an index.
DROP INDEX idx_payment_templates_client;
ALTER TABLE payment_templates DROP COLUMN client_id;
ALTER TABLE payment_templates DROP COLUMN decimal_separator;
