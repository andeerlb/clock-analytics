-- Which template to apply on this URL's automatic reimport — captured
-- alongside reimport_period_start/end (0039) the last time a save
-- succeeded for this URL, editable by hand on the Verificação automática
-- page. NULL falls back to matching the template by name (source_files.provider)
-- at reimport time, same behavior as before this column existed.
ALTER TABLE source_url_settings ADD COLUMN reimport_template_id INTEGER;
