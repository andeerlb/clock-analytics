-- Tracks the originally picked file (whole, unsplit) so the "já importado"
-- pre-check works even for multi-page batch files, which get split into one
-- `import_files` row per page/employee and therefore don't retain the
-- whole-file hash anywhere else.
CREATE TABLE source_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL UNIQUE,
    page_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
