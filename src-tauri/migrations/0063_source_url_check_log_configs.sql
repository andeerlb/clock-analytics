-- Independent per-config check history/scheduling. Previously EVERY active
-- reimport config for a URL was re-diffed whenever ANY of its configs
-- became due (the underlying HTTP check is shared per URL), which silently
-- ignored a slower config's own interval whenever a faster sibling config
-- shared the same URL, and made the "Histórico recente" strip show the same
-- shared entries under every config rather than each one's own genuinely
-- independent schedule. This table records exactly which configs were
-- actually evaluated on a given check attempt, so due-ness (via each
-- config's own last-evaluated timestamp) and the resulting history are
-- decided per config, not per URL. No FK enforcement relied on — callers
-- clean this up by hand (see logUrlCheckResult's prune step and
-- untrackPaymentUrl/deleteReimportConfig), same as source_url_check_diffs.
CREATE TABLE source_url_check_log_configs (
    check_log_id INTEGER NOT NULL REFERENCES source_url_check_log(id),
    config_id INTEGER NOT NULL REFERENCES source_url_reimport_configs(id),
    PRIMARY KEY (check_log_id, config_id)
);
CREATE INDEX idx_source_url_check_log_configs_config ON source_url_check_log_configs(config_id, check_log_id DESC);
