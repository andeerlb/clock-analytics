-- Keep sheet inclusion state for imported templates so disabled sheets still reappear when editing.
ALTER TABLE payment_template_sheets ADD COLUMN included INTEGER NOT NULL DEFAULT 1;
ALTER TABLE employee_template_sheets ADD COLUMN included INTEGER NOT NULL DEFAULT 1;
