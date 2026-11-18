-- Deep-check tracking: the header-only check (source_url_check_log) still
-- runs every due tick, but the actual download+parse+diff pass only runs
-- when the remote signature differs from the one it last diffed against —
-- distinct from source_files' own etag/last_modified/content_length (which
-- only update on an actual saved reimport), so a "changed" file the user
-- hasn't reimported yet doesn't get re-downloaded and re-diffed every tick
-- indefinitely.
ALTER TABLE source_url_settings ADD COLUMN last_deep_check_etag TEXT;
ALTER TABLE source_url_settings ADD COLUMN last_deep_check_last_modified TEXT;
ALTER TABLE source_url_settings ADD COLUMN last_deep_check_content_length INTEGER;
ALTER TABLE source_url_settings ADD COLUMN last_deep_check_at TEXT;

-- One row per changed field, possible-new-shift, or per-config failure
-- found by a deep check — child of source_url_check_log, not a JSON blob on
-- it, so the log table's own pagination/pruning (see
-- MAX_CHECK_LOG_ENTRIES_PER_URL) stays untouched and this can be
-- queried/filtered on its own later. No FK enforcement relied on (see
-- deleteImport's comment) — callers clean this up by hand (see
-- logUrlCheckResult's prune step and untrackPaymentUrl).
--
-- Identity here mirrors payment_shifts' own natural key (employee + data +
-- local + função + horário) — NOT arbitrary columns: those five together
-- are what `findDuplicatePaymentShifts` matches an existing record by, so a
-- change to any one of them means "different record", not a diffable field
-- of the same one. In today's schema the only things that CAN differ for a
-- matched identity are `status` (field_name = 'status') and an unmapped
-- column (field_name = 'extra:<columnLetter>').
CREATE TABLE source_url_check_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_log_id INTEGER NOT NULL REFERENCES source_url_check_log(id),
    config_id INTEGER REFERENCES source_url_reimport_configs(id),
    -- Snapshot, not just config_id — a config can be edited/deleted after
    -- this diff was recorded; the log entry should still read sensibly.
    config_label TEXT NOT NULL DEFAULT '',
    change_kind TEXT NOT NULL, -- 'field' | 'new-shift' | 'error'
    matched_shift_id INTEGER REFERENCES payment_shifts(id),
    employee_id INTEGER,
    employee_name TEXT,
    work_date TEXT,
    local TEXT,
    role TEXT,
    schedule_start_minutes INTEGER,
    schedule_end_minutes INTEGER,
    sheet_name TEXT,
    row_number INTEGER,
    column_letter TEXT,
    field_name TEXT,      -- 'status' | 'extra:<columnLetter>' | NULL (new-shift/error)
    old_value TEXT,
    new_value TEXT,
    message TEXT,          -- só pra change_kind='error'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_source_url_check_diffs_log ON source_url_check_diffs(check_log_id);
