-- Who saved the spreadsheet version a check looked at, read from the file's
-- own properties (xlsx: docProps/core.xml lastModifiedBy/modified; ods:
-- meta.xml dc:creator/dc:date). Only the last person to save before that
-- check is known: the file doesn't keep per-cell authorship.
--
-- On a check (`source_url_check_log`): who saved that downloaded version.
-- On a diff (`source_url_check_diffs`): who saved the version where that
-- change FIRST showed up — inherited, row after row, while the same change
-- keeps appearing on later checks.
--
-- `saved_at` NULL means "not known" (checks from before this column existed,
-- or a format with no such property, like .xls/.csv); `saved_by` NULL with a
-- `saved_at` set means the file was saved by a program that wrote no name.
ALTER TABLE source_url_check_log ADD COLUMN saved_by TEXT;
ALTER TABLE source_url_check_log ADD COLUMN saved_at TEXT;
ALTER TABLE source_url_check_diffs ADD COLUMN saved_by TEXT;
ALTER TABLE source_url_check_diffs ADD COLUMN saved_at TEXT;
