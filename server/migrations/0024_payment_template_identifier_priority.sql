-- Which combination of identifier fields (cpf/matricula/nome) has to match
-- the same employee, and in what order of preference, is now configurable
-- per template instead of the hardcoded cpf -> matricula -> nome
-- precedence. JSON array of arrays: each inner array is one "tentativa" —
-- every field in it must match together (AND); tentativas are tried in
-- order, first one that finds an employee wins (OR across tentativas).
-- Default reproduces today's fixed behavior: three single-field
-- tentativas, same order as before.
ALTER TABLE payment_templates
    ADD COLUMN identifier_priority TEXT NOT NULL DEFAULT '[["cpf"],["matricula"],["nome"]]';
