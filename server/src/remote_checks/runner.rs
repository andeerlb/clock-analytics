//! The schedule and `runChecks` of `RemoteFileUpdatesContext.tsx`, plus the
//! check-log writes it used from `db.ts` (`logUrlCheckResult`,
//! `saveCheckDiffs`, `markDeepCheckSignature`, `copyCheckDiffs`,
//! `listCheckLogConfigIds`), SQL verbatim.
//!
//! Each reimport config has its own interval and is "due" from when *it* was
//! last evaluated; a URL gets one HTTP check when at least one of its configs
//! is due, and that check only evaluates the due ones. See the TS original's
//! comments for the full reasoning; the decisions here are the same.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::task::JoinSet;

use super::diff::{self, DiffEntry};
use super::{list_configs, list_tracked, rules, ReimportConfig, Runtime, TrackedPaymentUrl};
use crate::error::{ApiError, ApiResult};
use crate::routes::{call, commands};
use crate::sql::{self, Row};
use crate::{params, AppState};

/// `TICK_INTERVAL_MS`.
const TICK_INTERVAL: Duration = Duration::from_secs(60);

/// `MAX_CHECK_LOG_ENTRIES_PER_URL`.
const MAX_CHECK_LOG_ENTRIES_PER_URL: i64 = 200;

/// Starts the background check: one tick now, then every minute. Like the
/// TS `setInterval`, a slow tick doesn't hold back the next one; a config
/// already being checked is skipped by whichever tick comes second.
pub fn spawn_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let state = state.clone();
            tokio::spawn(async move { tick(&state).await });
        }
    });
}

/// `isConfigDue`.
fn is_config_due(config: &ReimportConfig, now: chrono::DateTime<Utc>) -> bool {
    if config.check_disabled {
        return false;
    }
    let Some(last) = &config.last_checked_at else { return true };
    // An unreadable timestamp is NaN in the TS: never due.
    let Some(last) = rules::parse_sqlite_datetime(last) else { return false };
    (now - last).num_milliseconds() as f64 >= config.check_interval_minutes * 60_000.0
}

/// `isUnreliableHeaderHost`: OneDrive/SharePoint HEAD answers don't follow
/// real content changes, so every due check there downloads the file.
fn is_unreliable_header_host(source_url: &str) -> bool {
    let Ok(url) = url::Url::parse(source_url) else { return false };
    let host = url.host_str().unwrap_or("");
    host == "1drv.ms" || host == "onedrive.live.com" || host.ends_with(".sharepoint.com")
}

/// One tracked URL and the configs to evaluate on it this round.
pub struct Work {
    pub tracked: TrackedPaymentUrl,
    pub configs: Vec<ReimportConfig>,
}

/// `tick`: checks every config whose own interval is up.
pub async fn tick(state: &AppState) {
    let due = async {
        let tracked = list_tracked(state).await?;
        let configs = list_configs(state).await?;
        let now = Utc::now();
        let mut due_by_url: Vec<(String, Vec<ReimportConfig>)> = Vec::new();
        for c in configs.into_iter().filter(|c| is_config_due(c, now)) {
            match due_by_url.iter_mut().find(|(url, _)| *url == c.source_url) {
                Some((_, list)) => list.push(c),
                None => due_by_url.push((c.source_url.clone(), vec![c])),
            }
        }
        let work: Vec<Work> = due_by_url
            .into_iter()
            .filter_map(|(url, configs)| tracked.iter().find(|t| t.source_url == url).map(|t| Work { tracked: t.clone(), configs }))
            .collect();
        ApiResult::Ok(work)
    }
    .await;
    match due {
        Ok(work) => {
            if !work.is_empty() {
                run_checks(state, work).await;
            }
            state.remote_checks.set_tick_error(None);
        }
        Err(error) => state.remote_checks.set_tick_error(Some(diff::error_text(&error))),
    }
}

/// `forceCheckConfig`: one config now, ignoring its schedule.
pub async fn force_check_config(state: &AppState, config_id: i64) -> ApiResult<()> {
    let Some(config) = list_configs(state).await?.into_iter().find(|c| c.id == config_id) else { return Ok(()) };
    let Some(tracked) = list_tracked(state).await?.into_iter().find(|t| t.source_url == config.source_url) else { return Ok(()) };
    run_checks(state, vec![Work { tracked, configs: vec![config] }]).await;
    Ok(())
}

/// `forceCheckAll`: every tracked URL with all its enabled configs.
pub async fn force_check_all(state: &AppState) -> ApiResult<()> {
    let tracked = list_tracked(state).await?;
    let configs = list_configs(state).await?;
    let work = tracked
        .into_iter()
        .map(|t| {
            let configs = configs.iter().filter(|c| !c.check_disabled && c.source_url == t.source_url).cloned().collect();
            Work { tracked: t, configs }
        })
        .collect();
    run_checks(state, work).await;
    Ok(())
}

/// Takes configs out of "being checked" when their URL's work ends, however it ends.
struct CheckingGuard {
    runtime: Arc<Runtime>,
    ids: Vec<i64>,
}

impl Drop for CheckingGuard {
    fn drop(&mut self) {
        let mut checking = self.runtime.checking.lock().unwrap();
        for id in &self.ids {
            checking.remove(id);
        }
    }
}

/// `runChecks`: each URL in parallel. A config already mid-check is dropped;
/// a URL left with no config is skipped unless it had none to begin with.
pub async fn run_checks(state: &AppState, work: Vec<Work>) {
    let fresh: Vec<(Work, CheckingGuard)> = {
        let mut checking = state.remote_checks.checking.lock().unwrap();
        work.into_iter()
            .filter_map(|w| {
                let had_configs = !w.configs.is_empty();
                let configs: Vec<ReimportConfig> = w.configs.into_iter().filter(|c| !checking.contains(&c.id)).collect();
                if configs.is_empty() && had_configs {
                    return None;
                }
                let ids: Vec<i64> = configs.iter().map(|c| c.id).collect();
                checking.extend(ids.iter().copied());
                Some((Work { tracked: w.tracked, configs }, CheckingGuard { runtime: state.remote_checks.clone(), ids }))
            })
            .collect()
    };

    let mut tasks = JoinSet::new();
    for (w, guard) in fresh {
        let state = state.clone();
        tasks.spawn(async move {
            let _guard = guard;
            if let Err(error) = run_one(&state, &w.tracked, &w.configs).await {
                tracing::error!(%error, url = %w.tracked.source_url, "verificação automática falhou");
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

/// `EvaluatedConfigSnapshot`: template/período as used right now.
struct Snapshot {
    id: i64,
    template_id: i64,
    template_name: Option<String>,
    period_start: Option<String>,
    period_end: Option<String>,
}

fn snapshots(state: &AppState, configs: &[ReimportConfig]) -> Vec<Snapshot> {
    let today = state.remote_checks.today();
    configs
        .iter()
        .map(|c| {
            let (period_start, period_end) = rules::resolve_reimport_period(&c.period, today);
            Snapshot { id: c.id, template_id: c.template_id, template_name: c.template_name.clone(), period_start, period_end }
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Signature {
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct HeaderCheck {
    changed: Option<bool>,
    current: Signature,
}

async fn check_headers(t: &TrackedPaymentUrl) -> ApiResult<HeaderCheck> {
    let args = serde_json::from_value(json!({
        "url": t.source_url,
        "knownEtag": t.source_etag,
        "knownLastModified": t.source_last_modified,
        "knownContentLength": t.source_content_length,
    }))
    .map_err(|e| ApiError::Internal(e.to_string()))?;
    let Json(check) = commands::check_remote_payment_file(Json(args)).await?;
    serde_json::to_value(check).and_then(serde_json::from_value).map_err(|e| ApiError::Internal(e.to_string()))
}

/// `FileAuthor`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAuthor {
    saved_by: Option<String>,
    saved_at: Option<String>,
}

/// `runOne`: header check, then (when needed) one download shared by every
/// config of this URL, diffed per config.
async fn run_one(state: &AppState, t: &TrackedPaymentUrl, configs: &[ReimportConfig]) -> ApiResult<()> {
    let url = &t.source_url;
    let check = match check_headers(t).await {
        Ok(check) => check,
        Err(error) => {
            let message = diff::error_text(&error);
            let id = log_url_check_result(state, url, &t.file_name, "error", Some(&message), &snapshots(state, configs), None).await?;
            // A diff row too, so the failure reaches the pending-updates banner.
            save_check_diffs(state, id, url, &[DiffEntry::error(None, &t.file_name, message)], None).await?;
            return Ok(());
        }
    };
    let header_result = match check.changed {
        Some(true) => "changed",
        Some(false) => "unchanged",
        None => "unknown",
    };
    let current = check.current;
    let unreliable_header = is_unreliable_header_host(url);

    if header_result != "changed" && !unreliable_header {
        log_url_check_result(state, url, &t.file_name, header_result, None, &snapshots(state, configs), None).await?;
        return Ok(());
    }
    if configs.is_empty() {
        log_url_check_result(state, url, &t.file_name, header_result, None, &[], None).await?;
        return Ok(());
    }

    let signature_changed = unreliable_header
        || current.etag != t.last_deep_check_etag
        || current.last_modified != t.last_deep_check_last_modified
        || current.content_length != t.last_deep_check_content_length;

    if let (false, Some(cached_result), Some(cached_log_id)) = (signature_changed, &t.last_deep_check_result, t.last_deep_check_log_id) {
        let cached_ids: HashSet<i64> = list_check_log_config_ids(state, cached_log_id).await?.into_iter().collect();
        if configs.iter().all(|c| cached_ids.contains(&c.id)) {
            let id = log_url_check_result(state, url, &t.file_name, cached_result, None, &snapshots(state, configs), None).await?;
            copy_check_diffs(state, cached_log_id, id, url).await?;
            return Ok(());
        }
    }

    let mut entries: Vec<DiffEntry> = Vec::new();
    let mut whole_url_error: Option<String> = None;
    let mut download_succeeded = false;
    let mut author: Option<FileAuthor> = None;
    match diff::download(state, url).await {
        Err(error) => {
            let message = diff::error_text(&error);
            entries.push(DiffEntry::error(None, &t.file_name, message.clone()));
            whole_url_error = Some(message);
        }
        Ok(downloaded) => {
            download_succeeded = true;
            author = call(state, commands::read_spreadsheet_author, json!({ "path": downloaded.path }))
                .await
                .ok()
                .and_then(|v| serde_json::from_value(v).ok());

            // Read-only: the web version never writes on its own. A change
            // is only written when someone clicks "Aceitar" (see
            // `diff::accept_shift_change`), whatever the config's old
            // desktop auto-apply setting was.
            for config in configs {
                match diff::compute_reimport_diff(state, config, &downloaded.path, None).await {
                    Ok(found) => entries.extend(found),
                    Err(error) => entries.push(DiffEntry::error(Some(config.id), &config.label(), diff::error_text(&error))),
                }
            }
            diff::discard(&downloaded);
        }
    }

    let has_real_change = entries.iter().any(|e| e.change_kind != "error");
    let has_config_errors = entries.iter().any(|e| e.change_kind == "error");
    let effective_result = if whole_url_error.is_some() {
        "error"
    } else if has_real_change {
        "changed"
    } else if has_config_errors {
        "error"
    } else {
        "unchanged"
    };

    let id = log_url_check_result(state, url, &t.file_name, effective_result, whole_url_error.as_deref(), &snapshots(state, configs), author.as_ref()).await?;
    save_check_diffs(state, id, url, &entries, author.as_ref()).await?;
    // A failed download is retried next tick instead of cached as checked.
    if download_succeeded {
        mark_deep_check_signature(state, url, &current, effective_result, id).await?;
    }
    Ok(())
}

// --- check log writes (db.ts) --------------------------------------------------

/// `logUrlCheckResult`: one check attempt plus the configs it evaluated, then
/// prunes the URL's log to the last 200 entries. Returns the new log id.
///
/// The pruning breaks ties on `id` (the desktop ordered by `checked_at`
/// alone): two checks in the same second (a "Conferir agora" landing on a
/// scheduled one) could otherwise prune the row just inserted, and saving
/// its diffs then failed on the foreign key.
async fn log_url_check_result(
    state: &AppState,
    source_url: &str,
    file_name: &str,
    result: &str,
    message: Option<&str>,
    evaluated: &[Snapshot],
    author: Option<&FileAuthor>,
) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let inserted = sql::execute(
        &mut *tx,
        "INSERT INTO source_url_check_log (source_url, file_name, result, message, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5, $6)",
        &params![source_url, file_name, result, message, author.and_then(|a| a.saved_by.clone()), author.and_then(|a| a.saved_at.clone())],
    )
    .await?;
    let check_log_id = inserted.last_insert_id;
    for config in evaluated {
        sql::execute(
            &mut *tx,
            "INSERT INTO source_url_check_log_configs (check_log_id, config_id, template_id, template_name, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)",
            &params![check_log_id, config.id, config.template_id, config.template_name, config.period_start, config.period_end],
        )
        .await?;
    }
    sql::execute(
        &mut *tx,
        "DELETE FROM source_url_check_diffs
     WHERE check_log_id IN (
       SELECT id FROM source_url_check_log
       WHERE source_url = $1
         AND id NOT IN (SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC, id DESC LIMIT $2)
     )",
        &params![source_url, MAX_CHECK_LOG_ENTRIES_PER_URL],
    )
    .await?;
    sql::execute(
        &mut *tx,
        "DELETE FROM source_url_check_log_configs
     WHERE check_log_id IN (
       SELECT id FROM source_url_check_log
       WHERE source_url = $1
         AND id NOT IN (SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC, id DESC LIMIT $2)
     )",
        &params![source_url, MAX_CHECK_LOG_ENTRIES_PER_URL],
    )
    .await?;
    sql::execute(
        &mut *tx,
        "DELETE FROM source_url_check_log
     WHERE source_url = $1
       AND id NOT IN (
         SELECT id FROM source_url_check_log WHERE source_url = $1 ORDER BY checked_at DESC, id DESC LIMIT $2
       )",
        &params![source_url, MAX_CHECK_LOG_ENTRIES_PER_URL],
    )
    .await?;
    tx.commit().await?;
    Ok(check_log_id)
}

/// `listCheckLogConfigIds`.
async fn list_check_log_config_ids(state: &AppState, check_log_id: i64) -> ApiResult<Vec<i64>> {
    let rows = sql::select(&state.db, "SELECT config_id AS configId FROM source_url_check_log_configs WHERE check_log_id = $1", &params![check_log_id]).await?;
    Ok(rows.iter().filter_map(|r: &Row| r.get("configId").and_then(Value::as_i64)).collect())
}

/// `String(v)` for a fingerprint part (`null`/`undefined` → "").
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (None, Some(f)) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
            (None, Some(f)) => f.to_string(),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

/// U+001F: never inside real field text.
const FINGERPRINT_SEP: &str = "\x1f";

/// `diffContentFingerprint`. Same field order as `fingerprint_sql_expr`.
fn diff_content_fingerprint(e: &DiffEntry) -> String {
    let opt_s = |v: &Option<String>| v.clone().map(Value::String).unwrap_or(Value::Null);
    let opt_i = |v: Option<i64>| v.map(|n| json!(n)).unwrap_or(Value::Null);
    [
        Value::String(e.change_kind.clone()),
        opt_i(e.config_id),
        opt_i(e.employee_id),
        opt_s(&e.employee_name),
        opt_s(&e.work_date),
        opt_s(&e.local),
        opt_s(&e.role),
        opt_i(e.schedule_start_minutes),
        opt_i(e.schedule_end_minutes),
        opt_s(&e.sheet_name),
        opt_i(e.row_number),
        opt_s(&e.field_name),
        e.old_value.clone().unwrap_or(Value::Null),
        e.new_value.clone().unwrap_or(Value::Null),
        opt_s(&e.message),
    ]
    .iter()
    .map(js_string)
    .collect::<Vec<_>>()
    .join(FINGERPRINT_SEP)
}

/// `fingerprintSqlExpr`.
fn fingerprint_sql_expr(prefix: &str) -> String {
    [
        "change_kind",
        "config_id",
        "employee_id",
        "employee_name",
        "work_date",
        "local",
        "role",
        "schedule_start_minutes",
        "schedule_end_minutes",
        "sheet_name",
        "row_number",
        "field_name",
        "old_value",
        "new_value",
        "message",
    ]
    .iter()
    .map(|c| format!("COALESCE({prefix}{c}, '')"))
    .collect::<Vec<_>>()
    .join(" || char(31) || ")
}

/// `saveCheckDiffs`: a row whose content was already dismissed ("Visto") for
/// this URL arrives dismissed; a change seen before keeps the author of the
/// version it first appeared in.
async fn save_check_diffs(state: &AppState, check_log_id: i64, source_url: &str, entries: &[DiffEntry], author: Option<&FileAuthor>) -> ApiResult<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut tx = state.db.begin().await?;
    for e in entries {
        let fingerprint = diff_content_fingerprint(e);
        let dismissed_match = sql::select(
            &mut *tx,
            "SELECT id FROM dismissed_diff_fingerprints WHERE source_url = $1 AND fingerprint = $2 LIMIT 1",
            &params![source_url, fingerprint],
        )
        .await?;
        let earlier = sql::select_one(
            &mut *tx,
            &format!(
                "SELECT d.saved_by AS savedBy, d.saved_at AS savedAt
       FROM source_url_check_diffs d
       JOIN source_url_check_log l ON l.id = d.check_log_id
       WHERE l.source_url = $1 AND d.check_log_id < $2 AND {} = $3
       ORDER BY d.id DESC LIMIT 1",
                fingerprint_sql_expr("d.")
            ),
            &params![source_url, check_log_id, fingerprint],
        )
        .await?;
        let (saved_by, saved_at) = match &earlier {
            Some(row) => (row.get("savedBy").cloned().unwrap_or(Value::Null), row.get("savedAt").cloned().unwrap_or(Value::Null)),
            None => (json!(author.and_then(|a| a.saved_by.clone())), json!(author.and_then(|a| a.saved_at.clone()))),
        };
        let inserted = sql::execute(
            &mut *tx,
            "INSERT INTO source_url_check_diffs
         (check_log_id, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
          work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
          column_letter, field_name, old_value, new_value, message, applied, saved_by, saved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)",
            &params![
                check_log_id,
                e.config_id,
                e.config_label,
                e.change_kind,
                e.matched_shift_id,
                e.employee_id,
                e.employee_name,
                e.work_date,
                e.local,
                e.role,
                e.schedule_start_minutes,
                e.schedule_end_minutes,
                e.sheet_name,
                e.row_number,
                e.column_letter,
                e.field_name,
                e.old_value,
                e.new_value,
                e.message,
                i64::from(e.applied),
                saved_by,
                saved_at,
            ],
        )
        .await?;
        if !dismissed_match.is_empty() {
            sql::execute(&mut *tx, "UPDATE source_url_check_diffs SET dismissed_at = datetime('now') WHERE id = $1", &params![inserted.last_insert_id]).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// `markDeepCheckSignature`.
async fn mark_deep_check_signature(state: &AppState, source_url: &str, signature: &Signature, result: &str, check_log_id: i64) -> ApiResult<()> {
    sql::execute(
        &state.db,
        "UPDATE source_url_settings
     SET last_deep_check_etag = $2, last_deep_check_last_modified = $3, last_deep_check_content_length = $4,
         last_deep_check_result = $5, last_deep_check_log_id = $6, last_deep_check_at = datetime('now')
     WHERE source_url = $1",
        &params![source_url, signature.etag, signature.last_modified, signature.content_length, result, check_log_id],
    )
    .await?;
    Ok(())
}

/// `copyCheckDiffs`: a check that reuses a cached verdict gets the same diff rows.
async fn copy_check_diffs(state: &AppState, from_check_log_id: i64, to_check_log_id: i64, source_url: &str) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    sql::execute(
        &mut *tx,
        &format!(
            "INSERT INTO source_url_check_diffs
       (check_log_id, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
        work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
        column_letter, field_name, old_value, new_value, message, applied, dismissed_at, saved_by, saved_at)
     SELECT $2, config_id, config_label, change_kind, matched_shift_id, employee_id, employee_name,
            work_date, local, role, schedule_start_minutes, schedule_end_minutes, sheet_name, row_number,
            column_letter, field_name, old_value, new_value, message, applied,
            CASE WHEN EXISTS (
              SELECT 1 FROM dismissed_diff_fingerprints f
              WHERE f.source_url = $3 AND f.fingerprint = {}
            ) THEN datetime('now') ELSE NULL END,
            saved_by, saved_at
     FROM source_url_check_diffs
     WHERE check_log_id = $1",
            fingerprint_sql_expr("")
        ),
        &params![from_check_log_id, to_check_log_id, source_url],
    )
    .await?;
    sql::execute(
        &mut *tx,
        "UPDATE source_url_check_log
     SET saved_by = (SELECT saved_by FROM source_url_check_log WHERE id = $1),
         saved_at = (SELECT saved_at FROM source_url_check_log WHERE id = $1)
     WHERE id = $2",
        &params![from_check_log_id, to_check_log_id],
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(disabled: bool, interval: f64, last: Option<&str>) -> ReimportConfig {
        serde_json::from_value(json!({
            "id": 1, "sourceUrl": "https://x", "templateId": 1, "templateName": null, "label": "", "dateMode": "fixed",
            "periodStart": null, "periodEnd": null, "startOffsetDays": null, "endOffsetDays": null,
            "checkDisabled": disabled, "checkIntervalMinutes": interval, "lastCheckedAt": last,
        }))
        .unwrap()
    }

    #[test]
    fn due_ness_follows_each_configs_own_interval() {
        let now = rules::parse_sqlite_datetime("2026-05-01 12:00:00").unwrap();
        assert!(is_config_due(&config(false, 5.0, None), now));
        assert!(!is_config_due(&config(true, 5.0, None), now));
        assert!(is_config_due(&config(false, 5.0, Some("2026-05-01 11:55:00")), now));
        assert!(!is_config_due(&config(false, 5.0, Some("2026-05-01 11:55:01")), now));
        assert!(!is_config_due(&config(false, 5.0, Some("lixo")), now));
    }

    #[test]
    fn office_hosts_are_never_trusted_by_headers() {
        assert!(is_unreliable_header_host("https://1drv.ms/x/s!abc"));
        assert!(is_unreliable_header_host("https://empresa.sharepoint.com/:x:/g/abc"));
        assert!(is_unreliable_header_host("https://ONEDRIVE.live.com/download?x"));
        assert!(!is_unreliable_header_host("https://example.com/a.xlsx"));
        assert!(!is_unreliable_header_host("não é url"));
    }

    fn sample_entry() -> DiffEntry {
        DiffEntry {
            employee_id: Some(7),
            employee_name: Some("Ana Souza".into()),
            work_date: Some("2026-10-05".into()),
            local: Some("Loja 1".into()),
            role: Some("Caixa".into()),
            schedule_start_minutes: Some(480),
            schedule_end_minutes: Some(1020),
            sheet_name: Some("LOJA 11".into()),
            row_number: Some(12),
            column_letter: Some("G".into()),
            field_name: Some("extra:G".into()),
            old_value: Some(json!("antes")),
            new_value: Some(json!("depois")),
            message: None,
            change_kind: "field".into(),
            ..DiffEntry::error(Some(3), "Escala", String::new())
        }
    }

    fn snapshot(id: i64) -> Snapshot {
        Snapshot { id, template_id: 1, template_name: Some("T".into()), period_start: None, period_end: None }
    }

    /// A real reimport config (the log tables reference it).
    async fn config_row(state: &AppState, url: &str) -> i64 {
        sql::execute(&state.db, "INSERT INTO source_url_reimport_configs (source_url, template_id) VALUES ($1, 1)", &params![url]).await.unwrap().last_insert_id
    }

    async fn diff_rows(state: &AppState, check_log_id: i64) -> Vec<Row> {
        sql::select(&state.db, "SELECT dismissed_at AS dismissedAt, saved_by AS savedBy FROM source_url_check_diffs WHERE check_log_id = $1", &params![check_log_id]).await.unwrap()
    }

    #[tokio::test]
    async fn visto_carries_over_to_identical_changes_only() {
        let state = AppState::for_tests().await;
        let url = "https://example.com/a.xlsx";
        let config_id = config_row(&state, url).await;
        let mut entry = sample_entry();
        entry.config_id = Some(config_id);
        let author = FileAuthor { saved_by: Some("Bia".into()), saved_at: Some("2026-10-05T10:00:00Z".into()) };

        let first = log_url_check_result(&state, url, "a.xlsx", "changed", None, &[snapshot(config_id)], Some(&author)).await.unwrap();
        save_check_diffs(&state, first, url, std::slice::from_ref(&entry), Some(&author)).await.unwrap();

        // The Rust fingerprint is the SQL expression over the stored row:
        // "Visto" (dismissCheckDiffs) stores the SQL one, saving compares the Rust one.
        let stored = sql::select_one(&state.db, &format!("SELECT {} AS f FROM source_url_check_diffs WHERE check_log_id = $1", fingerprint_sql_expr("")), &params![first])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored["f"], json!(diff_content_fingerprint(&entry)));
        sql::execute(&state.db, "INSERT INTO dismissed_diff_fingerprints (source_url, fingerprint) VALUES ($1, $2)", &params![url, diff_content_fingerprint(&entry)]).await.unwrap();

        // Same content later: arrives already seen, keeps the first author.
        let second = log_url_check_result(&state, url, "a.xlsx", "changed", None, &[snapshot(config_id)], None).await.unwrap();
        let mut changed = entry.clone();
        changed.new_value = Some(json!("outro"));
        save_check_diffs(&state, second, url, &[entry.clone(), changed], None).await.unwrap();
        let rows = diff_rows(&state, second).await;
        assert!(!rows[0]["dismissedAt"].is_null());
        assert_eq!(rows[0]["savedBy"], json!("Bia"));
        assert!(rows[1]["dismissedAt"].is_null(), "a different value is a new problem");

        // A reused verdict copies the rows, with the same "Visto" rule.
        let third = log_url_check_result(&state, url, "a.xlsx", "changed", None, &[snapshot(config_id)], None).await.unwrap();
        copy_check_diffs(&state, second, third, url).await.unwrap();
        let rows = diff_rows(&state, third).await;
        assert_eq!(rows.len(), 2);
        assert!(!rows[0]["dismissedAt"].is_null());
        assert!(rows[1]["dismissedAt"].is_null());
        assert_eq!(list_check_log_config_ids(&state, third).await.unwrap(), vec![config_id]);
    }

    /// All 205 checks land in the same second: the newest must always survive.
    #[tokio::test]
    async fn the_log_keeps_the_last_200_checks_per_url() {
        let state = AppState::for_tests().await;
        let config_id = config_row(&state, "https://a").await;
        for _ in 0..205 {
            let id = log_url_check_result(&state, "https://a", "a.xlsx", "unchanged", None, &[snapshot(config_id)], None).await.unwrap();
            save_check_diffs(&state, id, "https://a", &[DiffEntry::error(None, "a.xlsx", "x".into())], None).await.unwrap();
        }
        log_url_check_result(&state, "https://b", "b.xlsx", "unchanged", None, &[], None).await.unwrap();
        let count = |table: &'static str| {
            let state = state.clone();
            async move { sql::select_one(&state.db, &format!("SELECT COUNT(*) AS n FROM {table}"), &[]).await.unwrap().unwrap()["n"].as_i64().unwrap() }
        };
        assert_eq!(count("source_url_check_log").await, 201);
        assert_eq!(count("source_url_check_log_configs").await, 200);
        assert_eq!(count("source_url_check_diffs").await, 200);
    }

    #[test]
    fn fingerprint_matches_the_sql_expression() {
        let mut entry = DiffEntry::error(Some(3), "Escala", "falhou".into());
        entry.row_number = Some(12);
        entry.old_value = Some(json!("a"));
        let expected = ["error", "3", "", "", "", "", "", "", "", "", "12", "", "a", "", "falhou"].join("\x1f");
        assert_eq!(diff_content_fingerprint(&entry), expected);
        assert_eq!(fingerprint_sql_expr("d.").matches("COALESCE(d.").count(), 15);
    }
}
