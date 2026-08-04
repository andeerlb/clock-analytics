-- Payment templates already use CPF -> Matrícula -> Nome as identifier
-- precedence, but employees never gained a matricula column — without it,
-- matrícula can never actually match anything. Nullable and unchecked for
-- duplicates (unlike CPF): not every client's payroll system uses one.
ALTER TABLE employees ADD COLUMN matricula TEXT;
