-- Which file kinds a template accepts at import time, beyond the single
-- `file_kind` it was originally built from — a JSON array of
-- "csv"|"xlsx"|"xls"|"ods". NULL means "just its own file_kind" (every
-- template before this existed), since xlsx/xls/ods already parse through
-- the same calamine-backed reader (see spreadsheet.rs) and only differ in
-- which magic bytes identify them — a template mapped against one of the
-- three works just as well fed a file in either of the other two. csv has
-- its own delimiter/no-sheets shape, so a csv template's accepted list is
-- always just ["csv"], never combined with the other three.
ALTER TABLE payment_templates ADD COLUMN accepted_file_kinds_json TEXT;
ALTER TABLE employee_templates ADD COLUMN accepted_file_kinds_json TEXT;
