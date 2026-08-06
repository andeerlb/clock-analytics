-- Check interval/enabled move from the URL (source_url_settings) to each
-- individual reimport config — a tracked URL can have several configs
-- now, and each one is meant to run on its own schedule and be turned
-- on/off independently, not share one setting for the whole URL. The
-- actual HTTP check is still made once per URL per tick (there's only one
-- remote file to ask about) — whichever of a URL's configs are due decide
-- *whether* that shared check happens; a positive "changed" result then
-- applies to every non-disabled config for that URL, not just whichever
-- one triggered the check.
ALTER TABLE source_url_reimport_configs ADD COLUMN check_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_url_reimport_configs ADD COLUMN check_interval_minutes INTEGER;

-- Carries forward each URL's existing check_disabled/check_interval_minutes
-- (source_url_settings) onto every config it already has, so nothing that
-- was running keeps running with the exact same cadence. Those two
-- source_url_settings columns are left in place (unused going forward) —
-- not dropped, same reasoning as 0042.
UPDATE source_url_reimport_configs
SET check_disabled = (
      SELECT COALESCE(s.check_disabled, 0) FROM source_url_settings s
      WHERE s.source_url = source_url_reimport_configs.source_url
    ),
    check_interval_minutes = (
      SELECT s.check_interval_minutes FROM source_url_settings s
      WHERE s.source_url = source_url_reimport_configs.source_url
    );
