-- Payment files can now be imported from a plain/anonymous direct-download
-- URL instead of a local pick. `source_url` records where a given
-- source_files row came from (NULL for local picks/timesheet PDFs); the
-- other three mirror the HTTP response headers captured at THAT import,
-- so a later visit to Importar Pagamentos can HEAD the same URL and tell
-- whether it has since changed (see check_remote_payment_file). Because
-- source_files is already keyed (ON CONFLICT) by file_hash, not by
-- source_url, a URL whose remote content changes produces a NEW row here
-- on reimport rather than overwriting the old one — "the current known
-- state of a URL" is simply whichever of that URL's rows has the newest
-- imported_at, not a separately tracked single row.
ALTER TABLE source_files ADD COLUMN source_url TEXT;
ALTER TABLE source_files ADD COLUMN source_etag TEXT;
ALTER TABLE source_files ADD COLUMN source_last_modified TEXT;
ALTER TABLE source_files ADD COLUMN source_content_length INTEGER;

-- Only URL-sourced rows are ever looked up by source_url (the "check
-- every known URL for updates" pass on ImportPaymentsPage's mount) — a
-- partial index keeps it out of the way of every other (source_url IS
-- NULL) row.
CREATE INDEX idx_source_files_source_url ON source_files(source_url) WHERE source_url IS NOT NULL;
