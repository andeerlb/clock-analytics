-- Whether a URL-sourced payment file was explicitly opted into automatic
-- tracking (via the "Rastrear atualizações automaticamente" checkbox on
-- Importar Pagamentos) — defaults to off. Before this column, ANY
-- URL-sourced save was implicitly tracked; that's no longer the case, so
-- `listTrackedPaymentUrls` now requires tracking_enabled = 1. Separate from
-- `check_disabled`, which pauses/resumes an already-tracked file without
-- forgetting its settings — this is the initial opt-in gate.
ALTER TABLE source_url_settings ADD COLUMN tracking_enabled INTEGER NOT NULL DEFAULT 0;
