-- How many punches-per-day this import's grid needs (2 pairs by default,
-- more if any day actually had more clock-ins) — computed once at import
-- time so the UI never has to scan day_records to figure out how many
-- Entrada/Saída columns to draw.
ALTER TABLE imports ADD COLUMN max_punches INTEGER NOT NULL DEFAULT 4;
