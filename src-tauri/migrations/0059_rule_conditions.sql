-- Lets a routing/status rule test SEVERAL fields at once, ANDed together
-- (e.g. "SE Aba == X E CPF == Y"), instead of just one. `conditions_json` is
-- an array of {field, values, caseInsensitive} objects — the previous
-- single-condition columns (field/values_json/case_insensitive) are left in
-- place untouched, read only as a fallback for a template saved before this
-- migration (rules are always fully deleted+reinserted on every template
-- save, so no bulk data migration is needed — an old template just keeps
-- reading through the fallback until it's next saved, at which point it
-- gets a real conditions_json like everything else).
ALTER TABLE payment_template_rules ADD COLUMN conditions_json TEXT;
ALTER TABLE payment_template_status_rules ADD COLUMN conditions_json TEXT;
