-- Row/aba position within the source file, promoted from `extra_data`
-- (where it lived as opaque "linha de origem"/"aba de origem" text) to
-- real, indexed columns. Needed by the deep-check diff's position-based
-- fallback match (see remoteCheckDiff.ts): when a file edits an existing
-- row's identity fields (local/função/horário/data), the usual identity
-- match no longer finds it, so the fallback looks up "what shift used to
-- sit at this exact row/aba of this exact source URL" instead, which
-- extra_data's JSON blob can't support efficiently.
--
-- Filename/URL aren't duplicated here — already reachable, and indexed
-- (see 0036_source_file_url.sql), via source_file_id -> source_files.
ALTER TABLE payment_shifts ADD COLUMN source_row_number INTEGER;
ALTER TABLE payment_shifts ADD COLUMN source_sheet_name TEXT;

CREATE INDEX idx_payment_shifts_source_position
  ON payment_shifts(source_sheet_name, source_row_number)
  WHERE source_row_number IS NOT NULL;
