-- Which check_log_id's diff rows are the ones currently cached (see
-- last_deep_check_etag/etc., migrations 0053/0054) — lets a later check
-- that reuses the cached verdict copy those same diff rows onto ITS OWN
-- check_log_id (see copyCheckDiffs in db.ts) instead of leaving "Detalhes"
-- blank just because the expensive download+parse was skipped. Every check
-- attempt's history is meant to show what it found, even when what it
-- found is "the same thing as last time."
ALTER TABLE source_url_settings ADD COLUMN last_deep_check_log_id INTEGER;
