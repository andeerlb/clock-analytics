-- Migration 0029 was already applied (with an `hours REAL` threshold)
-- before this session settled on whole-minutes instead — "7 horas e 20
-- minutos" as an exact 440, comparable with `=`/`!=` without
-- floating-point rounding, per the actual requirement. A fresh migration
-- rather than editing 0029 again, since 0029 has now genuinely applied
-- somewhere. payment_value_rules only ever held this feature's own
-- from-this-session test data, so the column is dropped and recreated
-- rather than converted in place.
ALTER TABLE payment_value_rules DROP COLUMN hours;
ALTER TABLE payment_value_rules ADD COLUMN threshold_minutes INTEGER;
