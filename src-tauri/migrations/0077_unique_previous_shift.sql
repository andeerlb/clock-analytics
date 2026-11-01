-- A payment_shifts row is superseded by at most one newer row: the chain is
-- a line, not a tree. The app now inserts every successor with
-- `INSERT ... WHERE NOT EXISTS` (see `successorShiftId` in src/lib/db.ts);
-- this makes the database itself refuse a second successor too.
--
-- A database that already has a fork (two rows pointing back at the same
-- `previous_shift_id`, from two writers acting at once before that guard
-- existed) would make the UNIQUE index below fail, so those are repaired
-- first, without deleting anything: the earliest successor keeps the link,
-- and each later sibling is detached (previous_shift_id = NULL). That later
-- sibling was already showing as a current shift of its own (a fork leaves
-- two heads), so nothing changes on screen — it only stops listing the
-- shared older rows in its "Ver histórico".
UPDATE payment_shifts
SET previous_shift_id = NULL
WHERE previous_shift_id IS NOT NULL
  AND id <> (
    SELECT MIN(sibling.id) FROM payment_shifts sibling
    WHERE sibling.previous_shift_id = payment_shifts.previous_shift_id
  );

-- Same name and column as the plain index it replaces, so queries keep
-- using it; NULLs never collide in a SQLite UNIQUE index. Any future
-- migration that rebuilds payment_shifts must recreate it as UNIQUE.
DROP INDEX IF EXISTS idx_payment_shifts_previous;
CREATE UNIQUE INDEX idx_payment_shifts_previous ON payment_shifts(previous_shift_id);
