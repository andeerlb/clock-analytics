-- Narrows which shifts a payment_value_rules step can even apply to, before
-- its duration check runs — a JSON array of column conditions (Data/Local/
-- Função by field+values, same "one of these" idea as payment_template_rules'
-- values_json; Horário by a ScheduleTimeRule start/end comparison instead,
-- since it's a range, not a discrete value), all AND'd together. NULL/empty
-- means "no column restriction", so every existing rule keeps matching
-- exactly as before.
ALTER TABLE payment_value_rules ADD COLUMN conditions_json TEXT;
