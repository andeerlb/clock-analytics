-- Which rule decides a payment shift's Horário counts as "noturno" against
-- the company's night_start_time/night_end_time window — was never
-- consumed by anything (see 0016's comment); this is the first of the
-- possible rules actually getting used. 'overlap' (any time overlap
-- between the shift and the night window) is the default — the most
-- intuitive single-label classification without needing a proportional
-- calculation.
ALTER TABLE companies ADD COLUMN night_shift_rule TEXT NOT NULL DEFAULT 'overlap';
