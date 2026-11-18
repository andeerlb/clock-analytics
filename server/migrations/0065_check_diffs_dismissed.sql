-- "Visto" — the user acknowledges a specific diff/error without resolving
-- it, scoped to this exact row (not the config/URL as a whole): a LATER
-- check that finds the same logical problem again writes a brand-new row,
-- undismissed, and alerts again on its own.
ALTER TABLE source_url_check_diffs ADD COLUMN dismissed_at TEXT;
