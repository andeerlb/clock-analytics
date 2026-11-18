-- "Visto" content-based suppression — dismissing a diff/error means "I've
-- seen THIS exact problem for this file, don't alert me about it again
-- unless it actually changes", not merely "hide this one literal row
-- forever". A later check whose new diff row has identical content (same
-- config, same kind, same identity/value/message) is auto-dismissed the
-- moment it's written (see saveCheckDiffs/copyCheckDiffs in db.ts);
-- anything with different content is a genuinely new problem and alerts
-- normally.
CREATE TABLE dismissed_diff_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_dismissed_diff_fingerprints_lookup ON dismissed_diff_fingerprints(source_url, fingerprint);
