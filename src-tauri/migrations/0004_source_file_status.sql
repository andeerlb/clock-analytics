-- source_files now logs every processing attempt (not just saved ones), so
-- the import history can show real outcomes: success / warning (partial,
-- e.g. some pages of a batch failed) / error.
ALTER TABLE source_files ADD COLUMN provider TEXT NOT NULL DEFAULT '';
ALTER TABLE source_files ADD COLUMN status TEXT NOT NULL DEFAULT 'success';
ALTER TABLE source_files ADD COLUMN error_message TEXT;
ALTER TABLE source_files ADD COLUMN original_pdf_path TEXT NOT NULL DEFAULT '';
-- Set only once the user actually saves at least one sheet from this file —
-- the "já importado, não reprocessar" pre-check keys off this, not off
-- `status`, since a file can parse fine but never get saved.
ALTER TABLE source_files ADD COLUMN saved_at TEXT;
