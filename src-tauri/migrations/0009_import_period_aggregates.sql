-- Period-level aggregates for each import, computed once at import time
-- (see `saveParsedTimesheet`) instead of recomputed live from day_records
-- every time a screen needs them. An import's own period never changes
-- after it's saved, so there's nothing "live" left to recompute for it —
-- unlike a day-level filter over an arbitrary, still-movable range.
--
-- `interval_minutes` is left at its default for imports that already
-- existed before this migration — computing it retroactively needs the
-- `punches` table's per-day ordering, which isn't worth a correlated
-- backfill query for what's still test data. Every import saved from now
-- on gets a real value.
ALTER TABLE imports ADD COLUMN total_worked_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN overtime_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN absence_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN regular_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 0;

UPDATE imports SET
  total_worked_minutes = COALESCE(
    (SELECT SUM(total_worked_minutes) FROM day_records WHERE day_records.import_id = imports.id), 0
  ),
  absence_minutes = COALESCE(
    (SELECT SUM(absence_minutes) FROM day_records WHERE day_records.import_id = imports.id), 0
  ),
  regular_minutes = COALESCE(
    (SELECT SUM(normal_hours_minutes) FROM day_records WHERE day_records.import_id = imports.id), 0
  ),
  overtime_minutes = COALESCE(
    (SELECT SUM(MAX(total_worked_minutes - 480, 0)) FROM day_records WHERE day_records.import_id = imports.id), 0
  );
