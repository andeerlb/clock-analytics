-- Per-URL override of the automatic remote-change check interval — NULL
-- means "inherit the global default" (see AppSettings.remote_file_check_interval_minutes).
ALTER TABLE source_url_settings ADD COLUMN check_interval_minutes INTEGER;

-- One row per check attempt, across all URL-sourced payment files — the
-- detailed history the "Verificação automática" page shows (when it ran,
-- what it found). `file_name` is denormalized (not joined from
-- source_files) so this history stays readable even if the original
-- source_files rows are ever wiped (e.g. "Apagar tudo" in Configurações
-- deliberately doesn't touch this table or source_url_settings — they're
-- feature preferences/audit trail, not business data).
CREATE TABLE source_url_check_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    result TEXT NOT NULL, -- 'changed' | 'unchanged' | 'unknown' | 'error'
    message TEXT
);
CREATE INDEX idx_source_url_check_log_url ON source_url_check_log(source_url, checked_at DESC);
