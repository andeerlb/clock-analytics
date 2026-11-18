//! Verificação automática: the server keeps an eye on every tracked payment
//! spreadsheet URL and records what changed.
//!
//! On the desktop this ran inside the app window (`RemoteFileUpdatesContext`
//! and `remoteCheckDiff.ts`), so it only ran while someone had the app open and,
//! on the web, every open tab would have run it again. Here it is one
//! background task (`runner`) for everyone; the frontend only reads the
//! results and asks for a check now and then ("Conferir agora").
//!
//! - `rules`: the pure `format.ts` helpers the check uses;
//! - `diff`: `computeReimportDiff` / `acceptShiftChange`;
//! - `runner`: the schedule, `runChecks` and the check log writes;
//! - this file: the RPC endpoints and the `db.ts` reads/writes of the
//!   Verificação automática page, SQL verbatim.

use std::collections::HashSet;
use std::sync::Mutex;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::NaiveDate;
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::routes::payments::bool_field;
use crate::sql::{self, BatchStatement, Row};
use crate::{params, AppState};

pub mod diff;
pub mod rules;
pub mod runner;


pub use runner::spawn_scheduler;

/// Live state of the automatic check, shared by the scheduler and the
/// endpoints (the TS kept these in React state / refs).
pub struct Runtime {
    /// Configs with a check in flight right now (`checkingConfigIdsRef`).
    checking: Mutex<HashSet<i64>>,
    /// A tick that failed before reaching any URL (`tickError`).
    tick_error: Mutex<Option<String>>,
    /// The team's time zone: "today" for relative períodos.
    timezone: Tz,
}

impl Runtime {
    pub fn new(timezone: Tz) -> Self {
        Runtime { checking: Mutex::new(HashSet::new()), tick_error: Mutex::new(None), timezone }
    }

    /// The local date in the team's time zone (`todayUtc()` in the TS read the
    /// computer's local date).
    pub fn today(&self) -> NaiveDate {
        chrono::Utc::now().with_timezone(&self.timezone).date_naive()
    }

    fn checking_ids(&self) -> Vec<i64> {
        let mut ids: Vec<i64> = self.checking.lock().unwrap().iter().copied().collect();
        ids.sort_unstable();
        ids
    }

    fn set_tick_error(&self, error: Option<String>) {
        *self.tick_error.lock().unwrap() = error;
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listTrackedPaymentUrls", post(list_tracked_payment_urls))
        .route("/rpc/listReimportConfigs", post(list_reimport_configs))
        .route("/rpc/createReimportConfig", post(create_reimport_config))
        .route("/rpc/updateReimportConfig", post(update_reimport_config))
        .route("/rpc/setConfigCheckDisabled", post(set_config_check_disabled))
        .route("/rpc/deleteReimportConfig", post(delete_reimport_config))
        .route("/rpc/untrackPaymentUrl", post(untrack_payment_url))
        .route("/rpc/listUrlCheckLogForConfig", post(list_url_check_log_for_config))
        .route("/rpc/listCheckDiffs", post(list_check_diffs))
        .route("/rpc/listCheckDiffCountsByLogIds", post(list_check_diff_counts_by_log_ids))
        .route("/rpc/getRemoteCheckStatus", post(get_remote_check_status))
        .route("/rpc/forceCheckConfig", post(force_check_config))
        .route("/rpc/forceCheckAll", post(force_check_all))
        .route("/rpc/acceptShiftChange", post(accept_shift_change))
}

// --- tracked URLs and reimport configs ---------------------------------------

/// `TrackedPaymentUrl`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPaymentUrl {
    pub source_url: String,
    pub file_name: String,
    pub source_etag: Option<String>,
    pub source_last_modified: Option<String>,
    pub source_content_length: Option<i64>,
    pub last_deep_check_etag: Option<String>,
    pub last_deep_check_last_modified: Option<String>,
    pub last_deep_check_content_length: Option<i64>,
    pub last_deep_check_result: Option<String>,
    pub last_deep_check_log_id: Option<i64>,
}

/// `ReimportConfig`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportConfig {
    pub id: i64,
    pub source_url: String,
    pub template_id: i64,
    pub template_name: Option<String>,
    #[serde(flatten)]
    pub period: rules::PeriodSpec,
    pub check_disabled: bool,
    pub check_interval_minutes: f64,
    pub last_checked_at: Option<String>,
}

impl ReimportConfig {
    pub fn label(&self) -> String {
        rules::resolve_reimport_config_label(&self.period)
    }
}

fn typed<T: serde::de::DeserializeOwned>(rows: Vec<Value>) -> ApiResult<Vec<T>> {
    rows.into_iter()
        .map(|row| serde_json::from_value(row).map_err(|e| ApiError::Internal(format!("linha inesperada: {e}"))))
        .collect()
}

pub(crate) async fn list_tracked_impl(state: &AppState) -> ApiResult<Vec<Value>> {
    let rows = sql::select(
        &state.db,
        "SELECT
       sf.source_url AS sourceUrl,
       sf.file_name AS fileName,
       sf.provider,
       sf.imported_at AS importedAt,
       sf.source_etag AS sourceEtag,
       sf.source_last_modified AS sourceLastModified,
       sf.source_content_length AS sourceContentLength,
       log.checked_at AS lastCheckedAt,
       log.result AS lastResult,
       log.message AS lastErrorMessage,
       sus.last_deep_check_etag AS lastDeepCheckEtag,
       sus.last_deep_check_last_modified AS lastDeepCheckLastModified,
       sus.last_deep_check_content_length AS lastDeepCheckContentLength,
       sus.last_deep_check_at AS lastDeepCheckAt,
       sus.last_deep_check_result AS lastDeepCheckResult,
       sus.last_deep_check_log_id AS lastDeepCheckLogId
     FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY source_url ORDER BY imported_at DESC) AS rn
       FROM source_files
       WHERE import_type = 'payment' AND source_url IS NOT NULL
     ) sf
     LEFT JOIN source_url_settings sus ON sus.source_url = sf.source_url
     LEFT JOIN (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY source_url ORDER BY checked_at DESC, id DESC) AS rn
       FROM source_url_check_log
     ) log ON log.source_url = sf.source_url AND log.rn = 1
     WHERE sf.rn = 1 AND COALESCE(sus.tracking_enabled, 0) = 1
     ORDER BY sf.imported_at DESC",
        &[],
    )
    .await?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

pub(crate) async fn list_tracked(state: &AppState) -> ApiResult<Vec<TrackedPaymentUrl>> {
    typed(list_tracked_impl(state).await?)
}

async fn list_tracked_payment_urls(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(list_tracked_impl(&state).await?))
}

pub(crate) async fn list_configs_impl(state: &AppState) -> ApiResult<Vec<Value>> {
    let rows = sql::select(
        &state.db,
        "SELECT
       c.id, c.source_url AS sourceUrl, c.label,
       c.template_id AS templateId, pt.name AS templateName,
       c.date_mode AS dateMode,
       c.period_start AS periodStart, c.period_end AS periodEnd,
       c.start_offset_days AS startOffsetDays, c.end_offset_days AS endOffsetDays,
       c.check_disabled AS checkDisabled, c.check_interval_minutes AS checkIntervalMinutes,
       c.keep_manual_edits AS keepManualEdits,
       c.auto_apply_enabled AS autoApplyEnabled,
       c.auto_apply_overwrite_manual_edits AS autoApplyOverwriteManualEdits,
       c.auto_apply_overwrite_paid AS autoApplyOverwritePaid,
       (SELECT MAX(l.checked_at)
        FROM source_url_check_log_configs jc
        JOIN source_url_check_log l ON l.id = jc.check_log_id
        WHERE jc.config_id = c.id) AS lastCheckedAt
     FROM source_url_reimport_configs c
     LEFT JOIN payment_templates pt ON pt.id = c.template_id
     ORDER BY c.created_at",
        &[],
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            for key in ["checkDisabled", "keepManualEdits", "autoApplyEnabled", "autoApplyOverwriteManualEdits", "autoApplyOverwritePaid"] {
                bool_field(&mut row, key);
            }
            Value::Object(row)
        })
        .collect())
}

pub(crate) async fn list_configs(state: &AppState) -> ApiResult<Vec<ReimportConfig>> {
    typed(list_configs_impl(state).await?)
}

async fn list_reimport_configs(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(list_configs_impl(&state).await?))
}

/// `ReimportConfigInput` (without `sourceUrl`/`templateId` on update).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigInput {
    #[serde(default)]
    source_url: Option<String>,
    label: String,
    #[serde(default)]
    template_id: Option<i64>,
    date_mode: String,
    period_start: Option<String>,
    period_end: Option<String>,
    start_offset_days: Option<f64>,
    end_offset_days: Option<f64>,
    check_interval_minutes: f64,
    keep_manual_edits: bool,
    auto_apply_overwrite_manual_edits: bool,
    auto_apply_overwrite_paid: bool,
}

const DATE_MODES: [&str; 3] = ["fixed", "relative", "month"];

/// The page's own form checks, repeated here: the browser isn't trusted.
fn validate(input: &ConfigInput) -> ApiResult<()> {
    if !DATE_MODES.contains(&input.date_mode.as_str()) {
        return Err(ApiError::BadRequest("Modo de período inválido.".into()));
    }
    if input.check_interval_minutes.is_nan() || input.check_interval_minutes < 1.0 {
        return Err(ApiError::BadRequest("O intervalo de verificação deve ser de pelo menos 1 minuto.".into()));
    }
    Ok(())
}

fn flag(value: bool) -> i64 {
    i64::from(value)
}

#[derive(Deserialize)]
struct CreateArgs {
    input: ConfigInput,
}

async fn create_reimport_config(State(state): State<AppState>, Json(CreateArgs { input }): Json<CreateArgs>) -> ApiResult<Json<i64>> {
    validate(&input)?;
    let (Some(source_url), Some(template_id)) = (&input.source_url, input.template_id) else {
        return Err(ApiError::BadRequest("Informe a URL e o template.".into()));
    };
    let result = sql::execute(
        &state.db,
        "INSERT INTO source_url_reimport_configs
       (source_url, label, template_id, date_mode, period_start, period_end, start_offset_days, end_offset_days,
        check_interval_minutes, keep_manual_edits, auto_apply_enabled, auto_apply_overwrite_manual_edits,
        auto_apply_overwrite_paid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        &params![
            source_url,
            input.label,
            template_id,
            input.date_mode,
            input.period_start,
            input.period_end,
            input.start_offset_days,
            input.end_offset_days,
            input.check_interval_minutes,
            flag(input.keep_manual_edits),
            // "Aplicar mudanças sozinho" doesn't exist on the web: always off.
            flag(false),
            flag(input.auto_apply_overwrite_manual_edits),
            flag(input.auto_apply_overwrite_paid),
        ],
    )
    .await?;
    Ok(Json(result.last_insert_id))
}

#[derive(Deserialize)]
struct UpdateArgs {
    id: i64,
    input: ConfigInput,
}

async fn update_reimport_config(State(state): State<AppState>, Json(UpdateArgs { id, input }): Json<UpdateArgs>) -> ApiResult<StatusCode> {
    validate(&input)?;
    sql::execute(
        &state.db,
        "UPDATE source_url_reimport_configs SET
       label = $2, date_mode = $3, period_start = $4, period_end = $5,
       start_offset_days = $6, end_offset_days = $7, check_interval_minutes = $8,
       keep_manual_edits = $9, auto_apply_enabled = $10, auto_apply_overwrite_manual_edits = $11,
       auto_apply_overwrite_paid = $12, updated_at = datetime('now')
     WHERE id = $1",
        &params![
            id,
            input.label,
            input.date_mode,
            input.period_start,
            input.period_end,
            input.start_offset_days,
            input.end_offset_days,
            input.check_interval_minutes,
            flag(input.keep_manual_edits),
            // "Aplicar mudanças sozinho" doesn't exist on the web: always off.
            flag(false),
            flag(input.auto_apply_overwrite_manual_edits),
            flag(input.auto_apply_overwrite_paid),
        ],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DisabledArgs {
    id: i64,
    disabled: bool,
}

async fn set_config_check_disabled(State(state): State<AppState>, Json(args): Json<DisabledArgs>) -> ApiResult<StatusCode> {
    sql::execute(
        &state.db,
        "UPDATE source_url_reimport_configs SET check_disabled = $2, updated_at = datetime('now') WHERE id = $1",
        &params![args.id, flag(args.disabled)],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

async fn delete_reimport_config(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    sql::run_batch(
        &state.db,
        vec![
            BatchStatement::new("DELETE FROM source_url_check_log_configs WHERE config_id = $1", params![args.id]),
            BatchStatement::new("DELETE FROM source_url_reimport_configs WHERE id = $1", params![args.id]),
        ],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceUrlArgs {
    source_url: String,
}

async fn untrack_payment_url(State(state): State<AppState>, Json(args): Json<SourceUrlArgs>) -> ApiResult<StatusCode> {
    let url = params![args.source_url];
    sql::run_batch(
        &state.db,
        vec![
            BatchStatement::new(
                "DELETE FROM source_url_check_diffs
     WHERE check_log_id IN (SELECT id FROM source_url_check_log WHERE source_url = $1)",
                url.clone(),
            ),
            BatchStatement::new(
                "DELETE FROM source_url_check_log_configs
     WHERE check_log_id IN (SELECT id FROM source_url_check_log WHERE source_url = $1)",
                url.clone(),
            ),
            BatchStatement::new("DELETE FROM source_url_check_log WHERE source_url = $1", url.clone()),
            BatchStatement::new("DELETE FROM source_url_reimport_configs WHERE source_url = $1", url.clone()),
            BatchStatement::new("DELETE FROM source_url_settings WHERE source_url = $1", url),
        ],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- check log reads -----------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogForConfigArgs {
    config_id: i64,
    limit: i64,
    #[serde(default)]
    offset: i64,
}

async fn list_url_check_log_for_config(State(state): State<AppState>, Json(args): Json<LogForConfigArgs>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(
        &state.db,
        "SELECT l.id, l.source_url AS sourceUrl, l.file_name AS fileName, l.checked_at AS checkedAt, l.result, l.message,
            l.saved_by AS savedBy, l.saved_at AS savedAt,
            jc.template_id AS templateId, jc.template_name AS templateName,
            jc.period_start AS periodStart, jc.period_end AS periodEnd,
            (SELECT COUNT(*) FROM source_url_check_diffs d WHERE d.check_log_id = l.id AND d.config_id = $1) AS diffCount,
            (SELECT MAX(CASE WHEN d.change_kind = 'error' THEN 1 ELSE 0 END)
             FROM source_url_check_diffs d WHERE d.check_log_id = l.id AND d.config_id = $1) AS hasOwnError,
            (SELECT d.id FROM source_url_check_diffs d
             WHERE d.check_log_id = l.id AND d.change_kind = 'error' AND (d.config_id = $1 OR d.config_id IS NULL)
             ORDER BY (d.config_id IS NULL) ASC LIMIT 1) AS errorDiffId,
            (SELECT d.dismissed_at FROM source_url_check_diffs d
             WHERE d.check_log_id = l.id AND d.change_kind = 'error' AND (d.config_id = $1 OR d.config_id IS NULL)
             ORDER BY (d.config_id IS NULL) ASC LIMIT 1) AS errorDismissedAt
     FROM source_url_check_log l
     JOIN source_url_check_log_configs jc ON jc.check_log_id = l.id AND jc.config_id = $1
     ORDER BY l.checked_at DESC, l.id DESC
     LIMIT $2 OFFSET $3",
        &params![args.config_id, args.limit, args.offset],
    )
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|mut row| {
                bool_field(&mut row, "hasOwnError");
                Value::Object(row)
            })
            .collect(),
    ))
}

/// `listCheckDiffs`' columns — also what `listAllLatestShiftDiffs` returns.
pub(crate) fn parse_check_diff_row(mut row: Row) -> Value {
    bool_field(&mut row, "applied");
    Value::Object(row)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckLogArgs {
    check_log_id: i64,
}

async fn list_check_diffs(State(state): State<AppState>, Json(args): Json<CheckLogArgs>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(
        &state.db,
        "SELECT d.id, d.check_log_id AS checkLogId, l.source_url AS sourceUrl, d.config_id AS configId, d.config_label AS configLabel,
            d.change_kind AS changeKind, d.matched_shift_id AS matchedShiftId, d.employee_id AS employeeId,
            d.employee_name AS employeeName, d.work_date AS workDate, d.local, d.role,
            d.schedule_start_minutes AS scheduleStartMinutes, d.schedule_end_minutes AS scheduleEndMinutes,
            d.sheet_name AS sheetName, d.row_number AS rowNumber, d.column_letter AS columnLetter,
            d.field_name AS fieldName, d.old_value AS oldValue, d.new_value AS newValue, d.message, d.applied,
            d.dismissed_at AS dismissedAt, jc.period_start AS periodStart, jc.period_end AS periodEnd,
            d.saved_by AS savedBy, d.saved_at AS savedAt
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
     LEFT JOIN source_url_check_log_configs jc ON jc.check_log_id = d.check_log_id AND jc.config_id = d.config_id
     WHERE d.check_log_id = $1
     ORDER BY d.id",
        &params![args.check_log_id],
    )
    .await?;
    Ok(Json(rows.into_iter().map(parse_check_diff_row).collect()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckLogIdsArgs {
    check_log_ids: Vec<i64>,
}

async fn list_check_diff_counts_by_log_ids(State(state): State<AppState>, Json(args): Json<CheckLogIdsArgs>) -> ApiResult<Json<Vec<Value>>> {
    if args.check_log_ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let placeholders = (1..=args.check_log_ids.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
    let params: Vec<Value> = args.check_log_ids.iter().map(|id| json!(id)).collect();
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT check_log_id AS checkLogId, config_id AS configId, config_label AS configLabel, COUNT(*) AS diffCount,
            MAX(CASE WHEN change_kind = 'error' THEN 1 ELSE 0 END) AS hasError
     FROM source_url_check_diffs
     WHERE check_log_id IN ({placeholders})
     GROUP BY check_log_id, config_id, config_label"
        ),
        &params,
    )
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|mut row| {
                bool_field(&mut row, "hasError");
                Value::Object(row)
            })
            .collect(),
    ))
}

// --- running checks from the page ---------------------------------------------

/// What the page shows while checks run: which configs are being checked
/// right now, and a tick that failed before reaching any URL.
async fn get_remote_check_status(State(state): State<AppState>) -> Json<Value> {
    let runtime = &state.remote_checks;
    let tick_error = runtime.tick_error.lock().unwrap().clone();
    Json(json!({ "checkingConfigIds": runtime.checking_ids(), "tickError": tick_error }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigIdArgs {
    config_id: i64,
}

/// "Conferir agora" for one config. Answers once that check finished.
async fn force_check_config(State(state): State<AppState>, Json(args): Json<ConfigIdArgs>) -> ApiResult<StatusCode> {
    runner::force_check_config(&state, args.config_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// "Conferir todas agora".
async fn force_check_all(State(state): State<AppState>) -> ApiResult<StatusCode> {
    runner::force_check_all(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptArgs {
    config_id: i64,
    shift_id: i64,
}

/// "Aceitar e atualizar" on one turno: see `diff::accept_shift_change`.
async fn accept_shift_change(State(state): State<AppState>, Json(args): Json<AcceptArgs>) -> ApiResult<StatusCode> {
    let config = list_configs(&state)
        .await?
        .into_iter()
        .find(|c| c.id == args.config_id)
        .ok_or_else(|| ApiError::NotFound("Essa configuração de verificação não existe mais.".into()))?;
    diff::accept_shift_change(&state, &config, args.shift_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
