-- Lets a colaborador-import template mark which physical row is the last
-- header/title row for a given sheet group — rows up to and including it
-- are skipped at import time (see ImportEmployeesPage.tsx), instead of
-- relying only on the CPF/Nome required-fields check to incidentally filter
-- them out. NULL (the default) means no header row is marked, matching the
-- prior behavior of processing every row.
ALTER TABLE employee_template_groups ADD COLUMN header_row INTEGER;
