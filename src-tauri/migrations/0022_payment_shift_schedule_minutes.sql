-- Horário was stored as raw free text ("9:00 - 15:00", "7:30 às 13:30"),
-- unusable for the future diurno/noturno calculation phase. Normalized
-- into start/end minutes-since-midnight instead, parsed at import time.
-- No special handling for a shift crossing midnight here — end < start is
-- valid and left for a future duration calculation to add 1440 for.
ALTER TABLE payment_shifts DROP COLUMN schedule;
ALTER TABLE payment_shifts ADD COLUMN schedule_start_minutes INTEGER;
ALTER TABLE payment_shifts ADD COLUMN schedule_end_minutes INTEGER;
