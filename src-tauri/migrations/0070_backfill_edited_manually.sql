-- Before this release, markPaymentShiftPaid/revertPaymentShiftToPending
-- unconditionally set edited_manually = 1 on every row they inserted, even
-- though neither transition touches a single field — only editPaymentShift
-- (a genuine hand-edit of Data/Local/Função/Horário/Valor) should ever
-- really mean that. The app code now INHERITS the flag from the previous
-- row on those two transitions instead of forcing it, so it only reads
-- true when a real edit happened somewhere in this shift's history — this
-- backfills every row written under the old (always-force-1) behavior to
-- match, instead of leaving every already-paid/-reverted shift showing
-- "editado manualmente" until it happens to go through another transition.
--
-- Under the OLD code, edited_manually = 1 on a row with a previous_shift_id
-- means it came from exactly one of three transitions:
--   - editPaymentShift: carries the OLD status forward unchanged
--   - markPaymentShiftPaid: always changes status to 'pago'
--   - revertPaymentShiftToPending: always changes status to 'pendente'
-- So "this row's status equals its previous row's status" uniquely
-- identifies an editPaymentShift hop among edited_manually = 1 rows — a
-- pago/revert hop always changes status, an edit never does. Walking each
-- row's own ancestor chain (previous_shift_id) for such a hop tells us
-- whether it should keep the flag (some real edit happened somewhere
-- upstream) or lose it (only ever pago/revert/auto-sync transitions).
WITH RECURSIVE ancestry(start_id, id, previous_shift_id, status, edited_manually) AS (
    SELECT id, id, previous_shift_id, status, edited_manually
    FROM payment_shifts
    WHERE edited_manually = 1
    UNION ALL
    SELECT ancestry.start_id, ps.id, ps.previous_shift_id, ps.status, ps.edited_manually
    FROM payment_shifts ps
    JOIN ancestry ON ps.id = ancestry.previous_shift_id
),
genuinely_edited(start_id) AS (
    SELECT DISTINCT a.start_id
    FROM ancestry a
    JOIN payment_shifts p ON p.id = a.previous_shift_id
    WHERE a.edited_manually = 1 AND a.status = p.status
)
UPDATE payment_shifts
SET edited_manually = 0
WHERE edited_manually = 1
  AND id NOT IN (SELECT start_id FROM genuinely_edited);
