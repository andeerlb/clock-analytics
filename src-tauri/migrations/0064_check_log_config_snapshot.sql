-- Snapshot of what a config's check attempt actually used — the config
-- itself (template, período) can be edited or deleted afterward, so without
-- this the "Histórico completo" drawer can't show what was true AT THE TIME
-- of a past check, only what's true now.
ALTER TABLE source_url_check_log_configs ADD COLUMN template_id INTEGER;
ALTER TABLE source_url_check_log_configs ADD COLUMN template_name TEXT;
ALTER TABLE source_url_check_log_configs ADD COLUMN period_start TEXT;
ALTER TABLE source_url_check_log_configs ADD COLUMN period_end TEXT;
