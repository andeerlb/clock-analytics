-- Which columns of the Pagamentos "desagrupado" table (and a grouped row's
-- expanded turno table) are shown — a JSON array of column ids, or NULL
-- meaning "all of them" (the default before this setting existed). Lives on
-- the existing payment_settings singleton row rather than a new table,
-- since it's one more piece of Pagamentos-wide configuration.
ALTER TABLE payment_settings ADD COLUMN visible_columns_json TEXT;
