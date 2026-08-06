-- The Período filters in effect the last time a save actually happened for
-- a given source_url — replayed automatically when an automatic reimport
-- (triggered from a detected remote change) runs, so the user doesn't have
-- to reconfigure them by hand every time. NULL means "todo o relatório"
-- (same "blank = whole file" convention already used by the import
-- screen's own Período fields). Editable per file on the Verificação
-- automática page, independent of when it was last captured from a save.
ALTER TABLE source_url_settings ADD COLUMN reimport_period_start TEXT;
ALTER TABLE source_url_settings ADD COLUMN reimport_period_end TEXT;
