-- "Atualizar registros automaticamente" per reimport config: when enabled,
-- the background check (RemoteFileUpdatesContext.runOne -> computeReimportDiff)
-- writes the change straight to payment_shifts instead of just recording a
-- pending diff for manual review (see PaymentsPage's row-blocking flow).
-- The two overwrite flags gate which already-protected shifts auto-apply is
-- still allowed to touch — auto_apply_overwrite_manual_edits defaults ON
-- (auto-apply is trusted to fix a hand-edited-but-unpaid shift by default),
-- auto_apply_overwrite_paid defaults OFF (a paid shift's fields are never
-- touched unless explicitly opted in).
ALTER TABLE source_url_reimport_configs ADD COLUMN auto_apply_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_url_reimport_configs ADD COLUMN auto_apply_overwrite_manual_edits INTEGER NOT NULL DEFAULT 1;
ALTER TABLE source_url_reimport_configs ADD COLUMN auto_apply_overwrite_paid INTEGER NOT NULL DEFAULT 0;

-- Whether this particular diff row was written to payment_shifts already
-- (auto-apply, or a manual "Aceitar") or is still just a pending finding
-- waiting for review — see computeReimportDiff's AutoApplyOptions.
ALTER TABLE source_url_check_diffs ADD COLUMN applied INTEGER NOT NULL DEFAULT 0;
