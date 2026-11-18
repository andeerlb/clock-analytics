-- Whether THIS reimport config's automatic reimport skips a "duplicate"
-- match that was edited by hand (Fazer pagamento/Editar valor/Voltar para
-- pendente) instead of superseding it — captured from whatever the
-- "Manter registros atualizados manualmente" checkbox was set to on
-- Importar Pagamentos when this config was first created, editable per
-- config afterward on Verificação automática. Unrelated to
-- payment_settings.keep_manual_edits (a leftover, unused column from an
-- earlier design) or to "Apagar tudo"'s own same-named option.
ALTER TABLE source_url_reimport_configs ADD COLUMN keep_manual_edits INTEGER NOT NULL DEFAULT 1;
