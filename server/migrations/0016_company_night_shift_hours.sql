-- Whether a payment-template shift counts as "noturno" (night) or
-- "diurno" (day) pay depends on when night starts/ends for that specific
-- company — Brazilian CLT sets 22:00-05:00 as the usual urban default,
-- but this varies by sector/agreement, so it's a per-company setting
-- rather than a hardcoded constant. Not consumed by anything yet — this
-- just registers the setting for when a payment template's Horário field
-- gets classified later.
ALTER TABLE companies ADD COLUMN night_start_time TEXT NOT NULL DEFAULT '22:00';
ALTER TABLE companies ADD COLUMN night_end_time TEXT NOT NULL DEFAULT '05:00';
