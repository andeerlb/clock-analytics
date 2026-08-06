-- A tracked URL can now have MULTIPLE independent reimport recipes — each
-- one its own template + Período, each one flagging its own reimport
-- opportunity when the remote file changes (not one shared config per
-- URL anymore). Período can be a fixed date range, same as before, or
-- relative to "today" (start/end as an offset in days), resolved fresh
-- every time it's actually needed (see resolveReimportPeriod in
-- src/lib/format.ts) — e.g. start_offset_days=7, end_offset_days=0 means
-- "the last 7 days through today," recomputed daily, never a stale date
-- range.
CREATE TABLE source_url_reimport_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    template_id INTEGER NOT NULL,
    date_mode TEXT NOT NULL DEFAULT 'fixed', -- 'fixed' | 'relative'
    period_start TEXT,
    period_end TEXT,
    start_offset_days INTEGER,
    end_offset_days INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_source_url_reimport_configs_url ON source_url_reimport_configs(source_url);

-- Carries forward the single template/período that already existed per
-- tracked URL (source_url_settings.reimport_*) as that URL's first config,
-- so existing tracked files don't lose their reimport setup. Those three
-- source_url_settings columns are left in place (unused going forward) —
-- not dropped, consistent with never editing/undoing an applied migration.
-- A tracked URL with no template ever captured there (tracked before that
-- concept existed) gets no config here; one is added by hand on the
-- Verificação automática page.
INSERT INTO source_url_reimport_configs (source_url, template_id, date_mode, period_start, period_end)
SELECT source_url, reimport_template_id, 'fixed', reimport_period_start, reimport_period_end
FROM source_url_settings
WHERE tracking_enabled = 1 AND reimport_template_id IS NOT NULL;
