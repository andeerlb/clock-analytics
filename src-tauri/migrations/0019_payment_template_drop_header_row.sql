-- header_row assumed every real data row sits at a fixed physical
-- position, which broke down for files mixing title rows, blank rows, or
-- footers unpredictably. Row validity is decided at import time instead:
-- whichever column a group maps to "data" is tried as a date for every
-- row, and only rows where that parses are treated as real data — no
-- fixed row number needed at template-configuration time.
ALTER TABLE payment_template_groups DROP COLUMN header_row;
