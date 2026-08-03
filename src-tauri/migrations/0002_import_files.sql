CREATE TABLE import_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL UNIQUE,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE imports ADD COLUMN import_file_id INTEGER REFERENCES import_files(id);

CREATE INDEX idx_imports_import_file ON imports(import_file_id);
