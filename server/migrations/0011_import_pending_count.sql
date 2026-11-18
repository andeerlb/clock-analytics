-- "Marcação pendente" (an odd, incomplete punch count on some day) needs a
-- period-level signal to power the Colaboradores "Status no período"
-- filter, same as the other categories there. Unlike those, it's a count
-- of days rather than minutes — a day with a dangling punch doesn't have a
-- meaningful duration to sum, just a "this needs a look" flag.
ALTER TABLE imports ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0;

UPDATE imports SET
  pending_count = COALESCE(
    (SELECT COUNT(*) FROM day_records d
     WHERE d.import_id = imports.id
       AND (SELECT COUNT(*) FROM punches p WHERE p.day_record_id = d.id) % 2 = 1), 0
  );
