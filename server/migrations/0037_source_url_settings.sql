-- "Desativar verificação automática" for a specific payment-file source
-- URL. Keyed by the URL itself, not by any particular source_files row —
-- a reimport creates a NEW source_files row (see 0036's comment, keyed by
-- content hash), so a per-row flag would be lost the moment the file
-- changes and gets reimported. This table is the durable, URL-scoped
-- preference that survives that.
CREATE TABLE source_url_settings (
    source_url TEXT PRIMARY KEY,
    check_disabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
