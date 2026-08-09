-- 0056 added payment_shifts.source_row_number/source_sheet_name as real
-- columns, but every row imported before that migration only ever had this
-- info baked into extra_data as opaque "linha de origem"/"aba de origem"
-- text (see the old ImportPaymentsPage.buildExtraData). Without this
-- backfill, findPaymentShiftByPosition's deep-check fallback silently finds
-- nothing for any pre-existing shift, no matter how exact a match would
-- otherwise be — it only ever reads the new columns, never extra_data.
-- Idempotent (WHERE ... IS NULL), and a no-op for a row with no such keys.
UPDATE payment_shifts
SET source_row_number = CAST(json_extract(extra_data, '$."linha de origem"') AS INTEGER)
WHERE source_row_number IS NULL
  AND extra_data IS NOT NULL
  AND json_extract(extra_data, '$."linha de origem"') IS NOT NULL;

UPDATE payment_shifts
SET source_sheet_name = json_extract(extra_data, '$."aba de origem"')
WHERE source_sheet_name IS NULL
  AND extra_data IS NOT NULL
  AND json_extract(extra_data, '$."aba de origem"') IS NOT NULL;
