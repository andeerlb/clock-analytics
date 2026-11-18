//! Análises — port of the `src/lib/db.ts` functions behind the Análises
//! dashboard, "Conferência de Pagamentos"'s paged list, and the global
//! "Atualizações pendentes" panel (shift-change diffs):
//! `listDistinctPaymentShiftLocals`, `listPaymentShiftsForReport`,
//! `listPaymentShiftsForReportPage`, `countPaymentShiftsPendingAudit`,
//! `listAllLatestShiftDiffs`, `dismissCheckDiffs`.
//!
//! The SQL text and the dynamic WHERE construction (`build_payment_shift_row_conditions`,
//! the twin of `buildPaymentShiftRowConditions`) are copied from db.ts as-is —
//! same conditions, same `$N` numbering, same ordering and paging.
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::sql::{self, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listDistinctPaymentShiftLocals", post(list_distinct_payment_shift_locals))
        .route("/rpc/listPaymentShiftsForReport", post(list_payment_shifts_for_report))
        .route("/rpc/listPaymentShiftsForReportPage", post(list_payment_shifts_for_report_page))
        .route("/rpc/countPaymentShiftsPendingAudit", post(count_payment_shifts_pending_audit))
        .route("/rpc/listAllLatestShiftDiffs", post(list_all_latest_shift_diffs))
        .route("/rpc/dismissCheckDiffs", post(dismiss_check_diffs))
}

// --- shared payment-shift SQL fragments (twins of the db.ts helpers) --------

/// `STRUCTURAL_HEAD_CONDITION` in db.ts.
pub(crate) const STRUCTURAL_HEAD_CONDITION: &str =
    "ps.id NOT IN (SELECT previous_shift_id FROM payment_shifts WHERE previous_shift_id IS NOT NULL)";

/// `HEAD_SHIFT_CONDITION` in db.ts: structurally the head AND not soft-deleted.
pub(crate) fn head_shift_condition() -> String {
    format!("{STRUCTURAL_HEAD_CONDITION} AND ps.deleted_at IS NULL")
}

/// `SHIFT_DURATION_SQL` in db.ts.
const SHIFT_DURATION_SQL: &str = "(CASE WHEN ps.schedule_end_minutes > ps.schedule_start_minutes THEN ps.schedule_end_minutes - ps.schedule_start_minutes ELSE 1440 - ps.schedule_start_minutes + ps.schedule_end_minutes END)";

/// `intervalPiecesSql`: `[p1s, p1e, p2s, p2e]`.
fn interval_pieces_sql(start: &str, end: &str) -> [String; 4] {
    let wraps = format!("({end} < {start})");
    [
        start.to_owned(),
        format!("(CASE WHEN {wraps} THEN 1440 ELSE {end} END)"),
        "0".to_owned(),
        format!("(CASE WHEN {wraps} THEN {end} ELSE 0 END)"),
    ]
}

/// `piecePairs`.
fn piece_pairs(a: &[String; 4], b: &[String; 4]) -> [[String; 4]; 4] {
    let (a1s, a1e, a2s, a2e) = (&a[0], &a[1], &a[2], &a[3]);
    let (b1s, b1e, b2s, b2e) = (&b[0], &b[1], &b[2], &b[3]);
    [
        [a1s.clone(), a1e.clone(), b1s.clone(), b1e.clone()],
        [a1s.clone(), a1e.clone(), b2s.clone(), b2e.clone()],
        [a2s.clone(), a2e.clone(), b1s.clone(), b1e.clone()],
        [a2s.clone(), a2e.clone(), b2s.clone(), b2e.clone()],
    ]
}

/// `rangesOverlapSql`.
fn ranges_overlap_sql(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> String {
    let pairs = piece_pairs(&interval_pieces_sql(a_start, a_end), &interval_pieces_sql(b_start, b_end));
    let parts: Vec<String> = pairs.iter().map(|[as_, ae, bs, be]| format!("({as_} < {be} AND {bs} < {ae})")).collect();
    format!("({})", parts.join(" OR "))
}

/// `overlapMinutesSql`.
fn overlap_minutes_sql(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> String {
    let pairs = piece_pairs(&interval_pieces_sql(a_start, a_end), &interval_pieces_sql(b_start, b_end));
    let parts: Vec<String> = pairs.iter().map(|[as_, ae, bs, be]| format!("MAX(0, MIN({ae}, {be}) - MAX({as_}, {bs}))")).collect();
    format!("({})", parts.join(" + "))
}

/// `timeInRangeSql`.
fn time_in_range_sql(point: &str, start: &str, end: &str) -> String {
    format!(
        "(CASE WHEN {end} < {start}\n    THEN ({point} >= {start} OR {point} < {end})\n    ELSE ({point} >= {start} AND {point} < {end}) END)"
    )
}

/// `shiftPeriodSql`: `(hasSchedule, isNoturno)` — needs `ps`, `c` and `cl` joined.
pub(crate) fn shift_period_sql() -> (String, String) {
    let effective_start = "COALESCE(cl.night_start_time, c.night_start_time)";
    let effective_end = "COALESCE(cl.night_end_time, c.night_end_time)";
    let effective_rule = "COALESCE(cl.night_shift_rule, c.night_shift_rule)";
    let night_start = format!("((CAST(substr({effective_start},1,2) AS INTEGER) * 60) + CAST(substr({effective_start},4,2) AS INTEGER))");
    let night_end = format!("((CAST(substr({effective_end},1,2) AS INTEGER) * 60) + CAST(substr({effective_end},4,2) AS INTEGER))");
    let shift_start = "ps.schedule_start_minutes";
    let shift_end = "ps.schedule_end_minutes";

    let start_in_range = time_in_range_sql(shift_start, &night_start, &night_end);
    let end_in_range = time_in_range_sql(shift_end, &night_start, &night_end);
    let overlaps = ranges_overlap_sql(shift_start, shift_end, &night_start, &night_end);
    let overlap_minutes = overlap_minutes_sql(shift_start, shift_end, &night_start, &night_end);
    let duration = format!(
        "(CASE WHEN {shift_end} > {shift_start} THEN {shift_end} - {shift_start} ELSE 1440 - {shift_start} + {shift_end} END)"
    );
    let majority_overlap = format!("({duration} > 0 AND {overlap_minutes} * 2 >= {duration})");

    let is_noturno = format!(
        "(CASE {effective_rule}\n    WHEN 'start-in-range' THEN {start_in_range}\n    WHEN 'end-in-range' THEN {end_in_range}\n    WHEN 'start-or-end-in-range' THEN ({start_in_range} OR {end_in_range})\n    WHEN 'majority-overlap' THEN {majority_overlap}\n    ELSE {overlaps}\n  END)"
    );

    (format!("({shift_start} IS NOT NULL AND {shift_end} IS NOT NULL)"), is_noturno)
}

/// `shiftPeriodSelectSql`: 'diurno' / 'noturno' / NULL (no schedule).
pub(crate) fn shift_period_select_sql() -> String {
    let (has_schedule, is_noturno) = shift_period_sql();
    format!("(CASE WHEN NOT {has_schedule} THEN NULL WHEN {is_noturno} THEN 'noturno' ELSE 'diurno' END)")
}

/// `parseTimeToMinutes` (format.ts): strict `H:MM`/`HH:MM`, ASCII digits only.
fn parse_time_to_minutes(value: &str) -> Option<i64> {
    let (h, m) = value.split_once(':')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !(1..=2).contains(&h.len()) || m.len() != 2 || !digits(h) || !digits(m) {
        return None;
    }
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// The Pagamentos "Horário" filter (`ScheduleTimeFilter`).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ScheduleTimeFilter {
    pub rule: String,
    pub time: String,
}

/// `scheduleTimeConditionSql`.
fn schedule_time_condition_sql(filter: &ScheduleTimeFilter, params: &mut Vec<Value>) -> Option<String> {
    let reference_minutes = parse_time_to_minutes(&filter.time)?;
    let field = if filter.rule.starts_with("start") { "ps.schedule_start_minutes" } else { "ps.schedule_end_minutes" };
    let op = if filter.rule.ends_with("before") { "<" } else { ">" };
    params.push(json!(reference_minutes));
    Some(format!("({field} IS NOT NULL AND {field} {op} ${})", params.len()))
}

/// `shiftIdsCondition`: one JSON-array param, so a long list can't hit SQLite's bound-parameter limit.
fn shift_ids_condition(shift_ids: Option<&Vec<Value>>, params: &mut Vec<Value>) -> Option<String> {
    let shift_ids = shift_ids?;
    params.push(Value::String(Value::Array(shift_ids.clone()).to_string()));
    Some(format!("ps.id IN (SELECT value FROM json_each(${}))", params.len()))
}

/// JavaScript's `String(n)` for a number: integral values print without a
/// fractional part ("3", not "3.0").
fn js_number_string(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}

/// `Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize">` — the
/// Pagamentos filters. Unknown fields (e.g. `page`) are ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PaymentShiftsQuery {
    pub employee_ids: Option<Vec<Value>>,
    pub company_ids: Option<Vec<Value>>,
    pub client_ids: Option<Vec<Value>>,
    pub role_ids: Option<Vec<Value>>,
    pub locals: Option<Vec<Value>>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub statuses: Vec<String>,
    pub shift_periods: Vec<String>,
    pub schedule_time_filter: Option<ScheduleTimeFilter>,
    pub attention: Option<String>,
    pub analytics: Option<String>,
    pub analytics_weekday: Option<f64>,
    pub analytics_time_bucket: Option<f64>,
    pub analytics_shift_ids: Option<Vec<Value>>,
    pub shift_ids: Option<Vec<Value>>,
}

impl PaymentShiftsQuery {
    /// "Empty `statuses` or `shiftPeriods` matches nothing" short-circuit every caller does first.
    fn matches_nothing(&self) -> bool {
        self.statuses.is_empty() || self.shift_periods.is_empty()
    }
}

fn push_in(conditions: &mut Vec<String>, column: &str, values: Option<&Vec<Value>>, params: &mut Vec<Value>) {
    if let Some(clause) = sql::in_clause(column, values.map(Vec::as_slice).unwrap_or(&[]), params) {
        conditions.push(clause);
    }
}

/// `buildPaymentShiftRowConditions`: row-level WHERE conditions shared by
/// every flat (non-aggregated) shift query.
pub(crate) fn build_payment_shift_row_conditions(query: &PaymentShiftsQuery, params: &mut Vec<Value>) -> Vec<String> {
    let mut conditions: Vec<String> = vec![head_shift_condition()];
    push_in(&mut conditions, "e.id", query.employee_ids.as_ref(), params);
    push_in(&mut conditions, "c.id", query.company_ids.as_ref(), params);
    push_in(&mut conditions, "cl.id", query.client_ids.as_ref(), params);
    push_in(&mut conditions, "ps.role_id", query.role_ids.as_ref(), params);
    push_in(&mut conditions, "ps.local", query.locals.as_ref(), params);
    if let Some(start) = query.period_start.as_deref().filter(|s| !s.is_empty()) {
        params.push(json!(start));
        conditions.push(format!("ps.work_date >= ${}", params.len()));
    }
    if let Some(end) = query.period_end.as_deref().filter(|s| !s.is_empty()) {
        params.push(json!(end));
        conditions.push(format!("ps.work_date <= ${}", params.len()));
    }
    if query.statuses.len() < 3 {
        let placeholders: Vec<String> = query
            .statuses
            .iter()
            .map(|s| {
                params.push(json!(s));
                format!("${}", params.len())
            })
            .collect();
        conditions.push(format!("ps.status IN ({})", placeholders.join(", ")));
    }
    let (has_schedule, is_noturno) = shift_period_sql();
    if query.shift_periods.len() < 2 {
        conditions.push(if query.shift_periods.first().map(String::as_str) == Some("noturno") {
            format!("({has_schedule} AND {is_noturno})")
        } else {
            format!("({has_schedule} AND NOT {is_noturno})")
        });
    }
    if let Some(filter) = &query.schedule_time_filter {
        if let Some(cond) = schedule_time_condition_sql(filter, params) {
            conditions.push(cond);
        }
    }
    let attention = query.attention.as_deref();
    let analytics = query.analytics.as_deref();
    if attention == Some("missing-amount") {
        conditions.push("ps.amount IS NULL".into());
    }
    if let Some(cond) = shift_ids_condition(query.shift_ids.as_ref(), params) {
        conditions.push(cond);
    }
    if attention == Some("pending-audit") {
        conditions.push("ps.status = 'pago'".into());
        conditions.push("NOT EXISTS (SELECT 1 FROM payment_audits pa_attention WHERE pa_attention.payment_shift_id = ps.id)".into());
    }
    if analytics == Some("journey-over-12h") {
        conditions.push("ps.schedule_start_minutes IS NOT NULL AND ps.schedule_end_minutes IS NOT NULL".into());
        conditions.push(format!("{SHIFT_DURATION_SQL} > 720"));
    }
    if analytics == Some("journey-under-4h") {
        conditions.push("ps.schedule_start_minutes IS NOT NULL AND ps.schedule_end_minutes IS NOT NULL".into());
        conditions.push(format!("{SHIFT_DURATION_SQL} BETWEEN 1 AND 239"));
    }
    if analytics == Some("rest-under-11h") {
        // The explicit ids are computed from the already-filtered dashboard rows.
        match sql::in_clause("ps.id", query.analytics_shift_ids.as_deref().unwrap_or(&[]), params) {
            Some(ids) => conditions.push(ids),
            None => conditions.push("0 = 1".into()),
        }
    }
    if analytics == Some("heatmap") {
        match (query.analytics_weekday, query.analytics_time_bucket) {
            (Some(weekday), Some(bucket)) => {
                params.push(json!(js_number_string(weekday)));
                conditions.push(format!("strftime('%w', ps.work_date) = ${}", params.len()));
                // Análises' heatmap uses 2-hour start buckets (0 = 00:00–01:59 … 11 = 22:00–23:59).
                params.push(json!(bucket * 120.0));
                params.push(json!(bucket * 120.0 + 119.0));
                conditions.push(format!("ps.schedule_start_minutes BETWEEN ${} AND ${}", params.len() - 1, params.len()));
            }
            _ => conditions.push("0 = 1".into()),
        }
    }
    conditions
}

// --- SQL builders (pure, so tests can check them) ---------------------------

const REPORT_FROM: &str = "FROM payment_shifts ps
    JOIN employees e ON e.id = ps.employee_id
    JOIN clients cl ON cl.id = ps.client_id
    JOIN companies c ON c.id = ps.company_id
    LEFT JOIN roles r ON r.id = ps.role_id";

fn report_select_columns() -> String {
    format!(
        "ps.id, e.id AS employeeId, e.name AS employeeName, c.id AS companyId, c.name AS companyName,
            cl.id AS clientId, cl.name AS clientName,
            ps.work_date AS workDate, ps.local, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.amount, ps.imported_at AS importedAt, ps.extra_data AS extraData,
            {} AS shiftPeriod",
        shift_period_select_sql()
    )
}

/// `listPaymentShiftsForReport`'s statement.
fn report_sql(query: &PaymentShiftsQuery) -> (String, Vec<Value>) {
    let mut params = Vec::new();
    let conditions = build_payment_shift_row_conditions(query, &mut params);
    let sql = format!(
        "SELECT {}
     {REPORT_FROM}
     WHERE {}
     ORDER BY ps.work_date, ps.local, e.name",
        report_select_columns(),
        conditions.join(" AND ")
    );
    (sql, params)
}

/// `listPaymentShiftsForReportPage`'s two statements: `(count, page)`.
fn report_page_sql(query: &PaymentShiftsQuery, page: &Value, page_size: &Value) -> ((String, Vec<Value>), (String, Vec<Value>)) {
    let mut params = Vec::new();
    let conditions = build_payment_shift_row_conditions(query, &mut params);
    let where_clause = format!("WHERE {}", conditions.join(" AND "));
    let count_sql = format!("SELECT COUNT(*) AS count {REPORT_FROM} {where_clause}");
    let page_sql = format!(
        "SELECT {}
     {REPORT_FROM}
     {where_clause}
     ORDER BY ps.work_date, ps.local, e.name
     LIMIT ${} OFFSET ${}",
        report_select_columns(),
        params.len() + 1,
        params.len() + 2
    );
    let offset = json!(page.as_f64().unwrap_or_default() * page_size.as_f64().unwrap_or_default());
    let mut page_params = params.clone();
    page_params.push(page_size.clone());
    page_params.push(offset);
    ((count_sql, params), (page_sql, page_params))
}

/// `countPaymentShiftsPendingAudit`'s statement.
fn pending_audit_sql(query: &PaymentShiftsQuery) -> (String, Vec<Value>) {
    let mut params = Vec::new();
    let mut conditions = build_payment_shift_row_conditions(query, &mut params);
    conditions.push("ps.status = 'pago'".into());
    let sql = format!(
        "SELECT COUNT(*) AS count
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN clients cl ON cl.id = ps.client_id
     JOIN companies c ON c.id = ps.company_id
     LEFT JOIN payment_audits pa ON pa.payment_shift_id = ps.id
     WHERE {} AND pa.id IS NULL",
        conditions.join(" AND ")
    );
    (sql, params)
}

/// `extra_data` is stored as a JSON string (or NULL) — parsed like `JSON.parse` did.
fn parse_report_rows(rows: Vec<Row>) -> ApiResult<Vec<Value>> {
    rows.into_iter()
        .map(|mut row| {
            let parsed = match row.get("extraData") {
                Some(Value::String(s)) if !s.is_empty() => {
                    serde_json::from_str(s).map_err(|e| ApiError::Internal(format!("extra_data inválido no turno {:?}: {e}", row.get("id"))))?
                }
                _ => Value::Null,
            };
            row.insert("extraData".into(), parsed);
            Ok(Value::Object(row))
        })
        .collect()
}

fn count_of(rows: &[Row]) -> Value {
    rows.first().and_then(|r| r.get("count")).cloned().unwrap_or(json!(0))
}

// --- handlers ----------------------------------------------------------------

async fn list_distinct_payment_shift_locals(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT DISTINCT ps.local AS local
     FROM payment_shifts ps
     WHERE {} AND ps.local <> ''
     ORDER BY ps.local",
            head_shift_condition()
        ),
        &[],
    )
    .await?;
    Ok(Json(rows.into_iter().map(|mut r| r.remove("local").unwrap_or(Value::Null)).collect()))
}

#[derive(Deserialize)]
struct QueryArgs {
    #[serde(default)]
    query: PaymentShiftsQuery,
}

async fn list_payment_shifts_for_report(State(state): State<AppState>, Json(args): Json<QueryArgs>) -> ApiResult<Json<Vec<Value>>> {
    if args.query.matches_nothing() {
        return Ok(Json(Vec::new()));
    }
    let (sql_text, params) = report_sql(&args.query);
    let rows = sql::select(&state.db, &sql_text, &params).await?;
    Ok(Json(parse_report_rows(rows)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportPageArgs {
    #[serde(default)]
    query: PaymentShiftsQuery,
    page: Value,
    page_size: Value,
}

async fn list_payment_shifts_for_report_page(State(state): State<AppState>, Json(args): Json<ReportPageArgs>) -> ApiResult<Json<Value>> {
    if args.query.matches_nothing() {
        return Ok(Json(json!({ "rows": [], "total": 0 })));
    }
    let ((count_sql, count_params), (page_sql, page_params)) = report_page_sql(&args.query, &args.page, &args.page_size);
    let total = count_of(&sql::select(&state.db, &count_sql, &count_params).await?);
    let rows = parse_report_rows(sql::select(&state.db, &page_sql, &page_params).await?)?;
    Ok(Json(json!({ "rows": rows, "total": total })))
}

async fn count_payment_shifts_pending_audit(State(state): State<AppState>, Json(args): Json<QueryArgs>) -> ApiResult<Json<Value>> {
    if args.query.matches_nothing() {
        return Ok(Json(json!(0)));
    }
    let (sql_text, params) = pending_audit_sql(&args.query);
    Ok(Json(count_of(&sql::select(&state.db, &sql_text, &params).await?)))
}

const LATEST_SHIFT_DIFFS_SQL: &str = "SELECT d.id, d.check_log_id AS checkLogId, l.source_url AS sourceUrl, d.config_id AS configId, d.config_label AS configLabel,
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
     WHERE l.id = (SELECT MAX(l2.id) FROM source_url_check_log l2 WHERE l2.source_url = l.source_url)
     ORDER BY d.id DESC";

/// JavaScript truthiness of a column value, as `Boolean(r.applied)` read it.
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `parseCheckDiffRow`: `applied` 0/1 → boolean.
fn parse_check_diff_row(mut row: Row) -> Value {
    let applied = js_truthy(row.get("applied"));
    row.insert("applied".into(), Value::Bool(applied));
    Value::Object(row)
}

async fn list_all_latest_shift_diffs(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(&state.db, LATEST_SHIFT_DIFFS_SQL, &[]).await?;
    Ok(Json(rows.into_iter().map(parse_check_diff_row).collect()))
}

/// U+001F — the delimiter `diffContentFingerprint` joins fields with.
const FINGERPRINT_SEP: &str = "\x1f";

/// Field order of `diffContentFingerprint` (db.ts) — MUST stay identical to
/// it (and to `fingerprintSqlExpr`), or "Visto" lookups silently stop matching.
const FINGERPRINT_FIELDS: [&str; 15] = [
    "changeKind",
    "configId",
    "employeeId",
    "employeeName",
    "workDate",
    "local",
    "role",
    "scheduleStartMinutes",
    "scheduleEndMinutes",
    "sheetName",
    "rowNumber",
    "fieldName",
    "oldValue",
    "newValue",
    "message",
];

/// `diffContentFingerprint`: each field as JavaScript's `String(v)` (null → "").
fn diff_content_fingerprint(row: &Row) -> String {
    FINGERPRINT_FIELDS
        .iter()
        .map(|field| match row.get(*field) {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => match n.as_i64() {
                Some(i) => i.to_string(),
                None => js_number_string(n.as_f64().unwrap_or_default()),
            },
            Some(other) => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(FINGERPRINT_SEP)
}

#[derive(Deserialize)]
struct IdsArgs {
    #[serde(default)]
    ids: Vec<Value>,
}

/// "Visto": marks the rows dismissed and registers each one's content
/// fingerprint for its source URL. Same statements, in the same order, as
/// db.ts — wrapped in one transaction.
async fn dismiss_check_diffs(State(state): State<AppState>, Json(args): Json<IdsArgs>) -> ApiResult<StatusCode> {
    dismiss(&state.db, &args.ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn dismiss(db: &sqlx::SqlitePool, ids: &[Value]) -> ApiResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("${i}")).collect();
    let placeholders = placeholders.join(", ");
    let mut tx = db.begin().await?;
    sql::execute(
        &mut *tx,
        &format!("UPDATE source_url_check_diffs SET dismissed_at = datetime('now') WHERE id IN ({placeholders})"),
        ids,
    )
    .await?;

    let rows = sql::select(
        &mut *tx,
        &format!(
            "SELECT l.source_url AS sourceUrl, d.change_kind AS changeKind, d.config_id AS configId,
            d.employee_id AS employeeId, d.employee_name AS employeeName, d.work_date AS workDate,
            d.local, d.role, d.schedule_start_minutes AS scheduleStartMinutes,
            d.schedule_end_minutes AS scheduleEndMinutes, d.sheet_name AS sheetName, d.row_number AS rowNumber,
            d.field_name AS fieldName, d.old_value AS oldValue, d.new_value AS newValue, d.message
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
     WHERE d.id IN ({placeholders})"
        ),
        ids,
    )
    .await?;
    for r in &rows {
        let fingerprint = diff_content_fingerprint(r);
        let source_url = r.get("sourceUrl").cloned().unwrap_or(Value::Null);
        let existing = sql::select(
            &mut *tx,
            "SELECT id FROM dismissed_diff_fingerprints WHERE source_url = $1 AND fingerprint = $2 LIMIT 1",
            &params![source_url, fingerprint],
        )
        .await?;
        if existing.is_empty() {
            sql::execute(
                &mut *tx,
                "INSERT INTO dismissed_diff_fingerprints (source_url, fingerprint) VALUES ($1, $2)",
                &params![source_url, fingerprint],
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;
    use sqlx::SqlitePool;

    fn query(value: Value) -> PaymentShiftsQuery {
        serde_json::from_value(value).unwrap()
    }

    fn all_open() -> Value {
        json!({ "statuses": ["pendente", "erro", "pago"], "shiftPeriods": ["diurno", "noturno"] })
    }

    #[test]
    fn unfiltered_query_is_only_the_head_condition() {
        let mut params = Vec::new();
        let conditions = build_payment_shift_row_conditions(&query(all_open()), &mut params);
        assert_eq!(conditions, vec![head_shift_condition()]);
        assert!(params.is_empty());
    }

    #[test]
    fn filters_number_params_in_db_ts_order() {
        let q = query(json!({
            "employeeIds": [7], "companyIds": [1, 2], "clientIds": [], "roleIds": [9], "locals": ["Loja A"],
            "periodStart": "2026-01-01", "periodEnd": "", "statuses": ["pago", "erro"], "shiftPeriods": ["noturno"],
            "scheduleTimeFilter": { "rule": "start-after", "time": "8:30" },
            "attention": "pending-audit", "shiftIds": [3, 4], "page": 2
        }));
        let mut params = Vec::new();
        let c = build_payment_shift_row_conditions(&q, &mut params);
        assert_eq!(c[1], "e.id IN ($1)");
        assert_eq!(c[2], "c.id IN ($2, $3)");
        assert_eq!(c[3], "ps.role_id IN ($4)");
        assert_eq!(c[4], "ps.local IN ($5)");
        assert_eq!(c[5], "ps.work_date >= $6");
        // empty periodEnd is falsy in TS: no condition
        assert_eq!(c[6], "ps.status IN ($7, $8)");
        let (has_schedule, is_noturno) = shift_period_sql();
        assert_eq!(c[7], format!("({has_schedule} AND {is_noturno})"));
        assert_eq!(c[8], "(ps.schedule_start_minutes IS NOT NULL AND ps.schedule_start_minutes > $9)");
        assert_eq!(c[9], "ps.id IN (SELECT value FROM json_each($10))");
        assert_eq!(c[10], "ps.status = 'pago'");
        assert!(c[11].starts_with("NOT EXISTS"));
        assert_eq!(c.len(), 12);
        assert_eq!(params, vec![json!(7), json!(1), json!(2), json!(9), json!("Loja A"), json!("2026-01-01"), json!("pago"), json!("erro"), json!(510), json!("[3,4]")]);
    }

    #[test]
    fn diurno_and_bad_time_and_end_before() {
        let mut params = Vec::new();
        let q = query(json!({ "statuses": ["pendente","erro","pago"], "shiftPeriods": ["diurno"], "scheduleTimeFilter": { "rule": "end-before", "time": "25:00" } }));
        let c = build_payment_shift_row_conditions(&q, &mut params);
        assert!(c[1].contains("AND NOT (CASE"));
        assert_eq!(c.len(), 2);
        let q = query(json!({ "statuses": ["pendente","erro","pago"], "shiftPeriods": ["diurno","noturno"], "scheduleTimeFilter": { "rule": "end-before", "time": "05:07" } }));
        let c = build_payment_shift_row_conditions(&q, &mut params);
        assert_eq!(c[1], "(ps.schedule_end_minutes IS NOT NULL AND ps.schedule_end_minutes < $1)");
        assert_eq!(params, vec![json!(307)]);
    }

    #[test]
    fn analytics_drilldowns() {
        let base = |extra: Value| {
            let mut v = all_open();
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let mut params = Vec::new();
            let c = build_payment_shift_row_conditions(&query(v), &mut params);
            (c, params)
        };
        let (c, _) = base(json!({ "analytics": "journey-over-12h" }));
        assert_eq!(c[2], format!("{SHIFT_DURATION_SQL} > 720"));
        let (c, _) = base(json!({ "analytics": "journey-under-4h" }));
        assert_eq!(c[2], format!("{SHIFT_DURATION_SQL} BETWEEN 1 AND 239"));
        let (c, _) = base(json!({ "analytics": "rest-under-11h" }));
        assert_eq!(c[1], "0 = 1");
        let (c, p) = base(json!({ "analytics": "rest-under-11h", "analyticsShiftIds": [5, 6] }));
        assert_eq!((c[1].as_str(), p), ("ps.id IN ($1, $2)", vec![json!(5), json!(6)]));
        let (c, _) = base(json!({ "analytics": "heatmap", "analyticsWeekday": 3 }));
        assert_eq!(c[1], "0 = 1");
        let (c, p) = base(json!({ "analytics": "heatmap", "analyticsWeekday": 3, "analyticsTimeBucket": 4 }));
        assert_eq!(c[1], "strftime('%w', ps.work_date) = $1");
        assert_eq!(c[2], "ps.schedule_start_minutes BETWEEN $2 AND $3");
        assert_eq!(p, vec![json!("3"), json!(480.0), json!(599.0)]);
        let (c, _) = base(json!({ "attention": "missing-amount", "shiftIds": [] }));
        assert_eq!(c[1..], ["ps.amount IS NULL".to_owned(), "ps.id IN (SELECT value FROM json_each($1))".to_owned()]);
    }

    #[test]
    fn parse_time_matches_format_ts() {
        assert_eq!(parse_time_to_minutes("0:00"), Some(0));
        assert_eq!(parse_time_to_minutes("23:59"), Some(1439));
        assert_eq!(parse_time_to_minutes("24:00"), None);
        assert_eq!(parse_time_to_minutes("12:60"), None);
        assert_eq!(parse_time_to_minutes("123:00"), None);
        assert_eq!(parse_time_to_minutes("12:5"), None);
        assert_eq!(parse_time_to_minutes("+1:00"), None);
        assert_eq!(parse_time_to_minutes(""), None);
    }

    #[test]
    fn page_sql_appends_limit_and_offset() {
        let q = query(json!({ "statuses": ["pago"], "shiftPeriods": ["diurno", "noturno"] }));
        let ((count_sql, count_params), (page_sql, page_params)) = report_page_sql(&q, &json!(2), &json!(50));
        assert!(count_sql.starts_with("SELECT COUNT(*) AS count FROM payment_shifts ps"));
        assert_eq!(count_params, vec![json!("pago")]);
        assert!(page_sql.ends_with("ORDER BY ps.work_date, ps.local, e.name\n     LIMIT $2 OFFSET $3"));
        assert_eq!(page_params, vec![json!("pago"), json!(50), json!(100.0)]);
    }

    async fn seed(pool: &SqlitePool) {
        for stmt in [
            "INSERT INTO companies (id, name, cnpj) VALUES (1, 'Acme', '11222333000181')",
            "INSERT INTO clients (id, name, cnpj) VALUES (1, 'Cliente', '11444777000161')",
            "INSERT INTO employees (id, name, cpf) VALUES (1, 'ANA', '11111111111'), (2, 'BRUNO', '22222222222')",
            "INSERT INTO roles (id, company_id, name) VALUES (1, 1, 'Vigia')",
        ] {
            sqlx::query(stmt).execute(pool).await.unwrap();
        }
        // 8 shifts: day (08-16) and night (22-06) alternating; ids 1..8.
        for i in 1..=8i64 {
            let (start, end) = if i % 2 == 0 { (1320, 360) } else { (480, 960) };
            let status = ["pendente", "erro", "pago", "pago"][(i % 4) as usize];
            sqlx::query(
                "INSERT INTO payment_shifts (id, employee_id, client_id, company_id, role_id, local, work_date, status, schedule_start_minutes, schedule_end_minutes, amount, extra_data)
                 VALUES (?1, ?2, 1, 1, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .bind(i)
            .bind(1 + i % 2)
            .bind(if i <= 4 { "Loja A" } else { "Loja B" })
            .bind(format!("2026-03-{:02}", i))
            .bind(status)
            .bind(start)
            .bind(end)
            .bind(if i == 1 { None } else { Some(100.0) })
            .bind(if i == 1 { Some(r#"{"obs":"x"}"#) } else { None })
            .execute(pool)
            .await
            .unwrap();
        }
        // Shift 9 supersedes shift 8 (8 is no longer a head); shift 7 is soft-deleted.
        sqlx::query("INSERT INTO payment_shifts (id, employee_id, client_id, company_id, local, work_date, status, previous_shift_id) VALUES (9, 1, 1, 1, '', '2026-03-08', 'pago', 8)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE payment_shifts SET deleted_at = datetime('now') WHERE id = 7").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO payment_audits (payment_shift_id, result) VALUES (3, 'confirmado')").execute(pool).await.unwrap();
    }

    async fn run(pool: &SqlitePool, (sql_text, params): (String, Vec<Value>)) -> Vec<Row> {
        sql::select(pool, &sql_text, &params).await.unwrap()
    }

    #[tokio::test]
    async fn report_queries_against_a_seeded_database() {
        let pool = test_pool().await;
        seed(&pool).await;

        let rows = run(&pool, report_sql(&query(all_open()))).await;
        let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![1, 2, 3, 4, 5, 6, 9]);
        assert_eq!(rows[0]["shiftPeriod"], "diurno");
        assert_eq!(rows[1]["shiftPeriod"], "noturno");
        assert_eq!(rows[6]["shiftPeriod"], Value::Null);
        assert_eq!(rows[0]["role"], "Vigia");
        let parsed = parse_report_rows(rows).unwrap();
        assert_eq!(parsed[0]["extraData"], json!({ "obs": "x" }));
        assert_eq!(parsed[1]["extraData"], Value::Null);

        let night = query(json!({ "statuses": ["pendente","erro","pago"], "shiftPeriods": ["noturno"], "locals": ["Loja A"] }));
        let ids: Vec<i64> = run(&pool, report_sql(&night)).await.iter().map(|r| r["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![2, 4]);

        // Paging: 7 rows, page size 3 → pages of 3, 3, 1, same total each time.
        let mut seen = Vec::new();
        for page in 0..3 {
            let ((count_sql, count_params), page_stmt) = report_page_sql(&query(all_open()), &json!(page), &json!(3));
            let total = count_of(&sql::select(&pool, &count_sql, &count_params).await.unwrap());
            assert_eq!(total, json!(7));
            let rows = run(&pool, page_stmt).await;
            seen.extend(rows.iter().map(|r| r["id"].as_i64().unwrap()));
        }
        assert_eq!(seen, vec![1, 2, 3, 4, 5, 6, 9]);

        // Pending audit: pago heads are 2, 3, 6, 9; 3 has a verdict → 3 left.
        let count = count_of(&run(&pool, pending_audit_sql(&query(all_open()))).await);
        assert_eq!(count, json!(3));
    }

    #[tokio::test]
    async fn rpc_short_circuits_and_locals() {
        let state = AppState::for_tests().await;
        seed(&state.db).await;
        let Json(rows) = list_payment_shifts_for_report(State(state.clone()), Json(QueryArgs { query: query(json!({ "statuses": [], "shiftPeriods": ["diurno"] })) })).await.unwrap();
        assert!(rows.is_empty());
        let Json(page) = list_payment_shifts_for_report_page(
            State(state.clone()),
            Json(ReportPageArgs { query: query(json!({ "statuses": ["pago"], "shiftPeriods": [] })), page: json!(0), page_size: json!(10) }),
        )
        .await
        .unwrap();
        assert_eq!(page, json!({ "rows": [], "total": 0 }));
        let Json(locals) = list_distinct_payment_shift_locals(State(state)).await.unwrap();
        assert_eq!(locals, vec![json!("Loja A"), json!("Loja B")]);
    }

    #[tokio::test]
    async fn dismiss_registers_fingerprints_once_and_latest_diffs_are_scoped() {
        let pool = test_pool().await;
        for stmt in [
            "INSERT INTO source_url_check_log (id, source_url, file_name, result) VALUES (1, 'u', 'f.xlsx', 'changed'), (2, 'u', 'f.xlsx', 'changed')",
            "INSERT INTO source_url_check_diffs (id, check_log_id, change_kind, employee_id, employee_name, schedule_start_minutes, field_name, old_value, new_value, applied)
             VALUES (1, 1, 'field', 5, 'ANA', 480, 'amount', '1', '2', 0),
                    (2, 2, 'field', 5, 'ANA', 480, 'amount', '1', '2', 1),
                    (3, 2, 'error', NULL, NULL, NULL, NULL, NULL, NULL, 0)",
        ] {
            sqlx::query(stmt).execute(&pool).await.unwrap();
        }
        let rows = sql::select(&pool, LATEST_SHIFT_DIFFS_SQL, &[]).await.unwrap();
        let rows: Vec<Value> = rows.into_iter().map(parse_check_diff_row).collect();
        assert_eq!(rows.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, 2]);
        assert_eq!(rows[1]["applied"], json!(true));
        assert_eq!(rows[0]["applied"], json!(false));

        dismiss(&pool, &[json!(1), json!(2), json!(3)]).await.unwrap();
        dismiss(&pool, &[json!(2)]).await.unwrap();
        let dismissed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM source_url_check_diffs WHERE dismissed_at IS NOT NULL").fetch_one(&pool).await.unwrap();
        assert_eq!(dismissed, 3);
        let fps: Vec<String> = sqlx::query_scalar("SELECT fingerprint FROM dismissed_diff_fingerprints ORDER BY id").fetch_all(&pool).await.unwrap();
        // Rows 1 and 2 have identical content → one fingerprint; plus the error row.
        assert_eq!(fps.len(), 2);
        let sep = "\x1f";
        assert_eq!(fps[0], ["field", "", "5", "ANA", "", "", "", "480", "", "", "", "amount", "1", "2", ""].join(sep));
        assert_eq!(fps[1], ["error", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].join(sep));
        dismiss(&pool, &[]).await.unwrap();
    }

    #[test]
    fn js_number_strings() {
        assert_eq!(js_number_string(3.0), "3");
        assert_eq!(js_number_string(3.5), "3.5");
        assert_eq!(js_number_string(-0.0), "0");
    }
}
