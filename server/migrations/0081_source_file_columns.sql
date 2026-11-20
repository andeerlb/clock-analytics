-- What each column the template left unmapped is, per imported file and
-- aba: the header text found above the data (so "Coluna E" can read as
-- "Entrada real") and, for an Excel date/time cell, which kind it is (the
-- value in payment_shifts.extra_data stays the raw serial, e.g. 0.25, so
-- the automatic verification keeps comparing it with the file as-is; the
-- screen shows it as 06:00). Kept per file+aba instead of on every
-- payment_shifts row: every version of a turno already carries its
-- source_file_id/source_sheet_name forward, so nothing has to copy this.
-- sheet_name is '' for a csv (no abas), so the UNIQUE holds.
CREATE TABLE source_file_columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL REFERENCES source_files(id),
    sheet_name TEXT NOT NULL DEFAULT '',
    column_letter TEXT NOT NULL,
    header TEXT,
    kind TEXT,
    UNIQUE (source_file_id, sheet_name, column_letter)
);
