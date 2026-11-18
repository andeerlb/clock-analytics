-- source_files has only ever logged timesheet PDFs. Payments (CSV/Excel/
-- ODS) are a second, separate import flow with their own history — this
-- column is what keeps the two from bleeding into each other's list.
ALTER TABLE source_files ADD COLUMN import_type TEXT NOT NULL DEFAULT 'timesheet';
