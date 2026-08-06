-- The global default check interval is being removed — every reimport
-- config's own interval is now mandatory (minimum 1 minute, default 5,
-- enforced app-side going forward). Existing configs left NULL here
-- previously fell back to the global default at check-time; backfilling
-- them to 5 now keeps that same effective cadence now that the fallback
-- is gone.
UPDATE source_url_reimport_configs SET check_interval_minutes = 5 WHERE check_interval_minutes IS NULL;
