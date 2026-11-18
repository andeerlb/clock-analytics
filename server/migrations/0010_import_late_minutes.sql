-- Splits the single "Faltas/Atrasos" bucket into two: a day counts as
-- falta (no valid punch pair — 0 or 1 punches, a lone punch is invalid on
-- its own) or atraso (has at least one valid pair but still came up short
-- on hours). `absence_minutes` keeps its name but narrows to just the
-- falta days; `late_minutes` is the new atraso bucket. Together they sum
-- to whatever `absence_minutes` held before this migration.
ALTER TABLE imports ADD COLUMN late_minutes INTEGER NOT NULL DEFAULT 0;

UPDATE imports SET
  absence_minutes = COALESCE(
    (SELECT SUM(d.absence_minutes) FROM day_records d
     WHERE d.import_id = imports.id
       AND (SELECT COUNT(*) FROM punches p WHERE p.day_record_id = d.id) < 2), 0
  ),
  late_minutes = COALESCE(
    (SELECT SUM(d.absence_minutes) FROM day_records d
     WHERE d.import_id = imports.id
       AND (SELECT COUNT(*) FROM punches p WHERE p.day_record_id = d.id) >= 2), 0
  );
