//! Pagamentos: modelos, importação de planilhas, turnos, conferência e exportação.
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.
//!
//! Port of the payment functions of the desktop app's `src/lib/db.ts`, same
//! SQL text, same rules, same messages:
//! - `templates`: import (spreadsheet), Excel export and PDF templates;
//! - `import`: duplicate/position matching and saving an imported file's shifts;
//! - `shifts`: lists, the append-only status/edit transitions, audits, history.

use axum::Router;
use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::sql::{self, Row};
use crate::AppState;

pub(crate) mod import;
pub(crate) mod shifts;
pub(crate) mod templates;

#[cfg(test)]
mod tests;

pub fn router() -> Router<AppState> {
    Router::new().merge(templates::router()).merge(import::router()).merge(shifts::router())
}

// --- row shaping (what the TS did after `db.select`) --------------------------

/// `row[key] ? JSON.parse(row[key]) : null` — a JSON text column replaced by
/// its parsed value in place. NULL and "" stay null, like the TS truthiness check.
pub(crate) fn parse_json_field(row: &mut Row, key: &str) -> ApiResult<()> {
    let parsed = match row.get(key) {
        Some(Value::String(text)) if !text.is_empty() => {
            serde_json::from_str(text).map_err(|e| ApiError::Internal(format!("JSON inválido em {key}: {e}")))?
        }
        _ => Value::Null,
    };
    row.insert(key.to_owned(), parsed);
    Ok(())
}

/// `Boolean(row[key])` for a 0/1 INTEGER column.
pub(crate) fn bool_field(row: &mut Row, key: &str) {
    let truthy = match row.get(key) {
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(b)) => *b,
        _ => false,
    };
    row.insert(key.to_owned(), Value::Bool(truthy));
}

/// `parsePaymentShiftRow`: `extraData` parsed, `editedManually` as a boolean.
pub(crate) fn parse_shift_row(mut row: Row) -> ApiResult<Value> {
    parse_json_field(&mut row, "extraData")?;
    bool_field(&mut row, "editedManually");
    Ok(Value::Object(row))
}

pub(crate) fn parse_shift_rows(rows: Vec<Row>) -> ApiResult<Vec<Value>> {
    rows.into_iter().map(parse_shift_row).collect()
}

/// `row[key]`, or null when the column isn't there.
pub(crate) fn field(row: &Row, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

pub(crate) fn json_text(value: &impl serde::Serialize) -> ApiResult<String> {
    serde_json::to_string(value).map_err(|e| ApiError::Internal(e.to_string()))
}

/// `$1, $2, …` for a list bound starting at `$1` (the TS `placeholders` idiom).
pub(crate) fn placeholders(count: usize) -> String {
    (1..=count).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ")
}

pub(crate) fn values<T: serde::Serialize>(items: &[T]) -> Vec<Value> {
    items.iter().map(|v| serde_json::json!(v)).collect()
}

// --- shared SQL fragments (db.ts, verbatim) ----------------------------------

/// A shift's "current" row is whichever one nothing else points to via
/// `previous_shift_id`. Purely structural — ignores `deleted_at`, so a
/// deleted chain's head can still be found (see `findDuplicatePaymentShifts`).
pub(crate) const STRUCTURAL_HEAD_CONDITION: &str =
    "ps.id NOT IN (SELECT previous_shift_id FROM payment_shifts WHERE previous_shift_id IS NOT NULL)";

/// The "currently visible" condition: structurally the head AND not soft-deleted.
pub(crate) fn head_shift_condition() -> String {
    format!("{STRUCTURAL_HEAD_CONDITION} AND ps.deleted_at IS NULL")
}

pub(crate) const PAYMENT_SHIFT_SELECT_COLUMNS: &str = "
  ps.id, ps.employee_id AS employeeId, e.name AS employeeName,
  ps.client_id AS clientId, ps.company_id AS companyId,
  ps.local, ps.work_date AS workDate, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
  ps.schedule_start_minutes AS scheduleStartMinutes,
  ps.schedule_end_minutes AS scheduleEndMinutes,
  ps.status, ps.error_message AS errorMessage, ps.amount, ps.imported_at AS importedAt,
  ps.previous_shift_id AS previousShiftId, ps.extra_data AS extraData,
  ps.edited_manually AS editedManually,
  ps.source_row_number AS sourceRowNumber, ps.source_sheet_name AS sourceSheetName,
  sf.file_name AS sourceFileName, sf.source_url AS sourceUrl
";

pub(crate) const PAYMENT_SHIFT_FROM_CLAUSE: &str = "
  FROM payment_shifts ps
  JOIN employees e ON e.id = ps.employee_id
  LEFT JOIN source_files sf ON sf.id = ps.source_file_id
  LEFT JOIN roles r ON r.id = ps.role_id
";

/// Which aggregated column each "Status" checkbox reads.
pub(crate) fn status_having_condition(status: &str) -> Option<&'static str> {
    match status {
        "pendente" => Some("SUM(CASE WHEN ps.status = 'pendente' THEN 1 ELSE 0 END) > 0"),
        "erro" => Some("SUM(CASE WHEN ps.status = 'erro' THEN 1 ELSE 0 END) > 0"),
        "pago" => Some("SUM(CASE WHEN ps.status = 'pago' THEN 1 ELSE 0 END) > 0"),
        _ => None,
    }
}

struct Pieces {
    p1s: String,
    p1e: String,
    p2s: String,
    p2e: String,
}

/// Splits a possibly midnight-wrapping range into two non-wrapping pieces.
fn interval_pieces_sql(start: &str, end: &str) -> Pieces {
    let wraps = format!("({end} < {start})");
    Pieces {
        p1s: start.to_owned(),
        p1e: format!("(CASE WHEN {wraps} THEN 1440 ELSE {end} END)"),
        p2s: "0".to_owned(),
        p2e: format!("(CASE WHEN {wraps} THEN {end} ELSE 0 END)"),
    }
}

fn piece_pairs<'a>(a: &'a Pieces, b: &'a Pieces) -> [[&'a str; 4]; 4] {
    [
        [&a.p1s, &a.p1e, &b.p1s, &b.p1e],
        [&a.p1s, &a.p1e, &b.p2s, &b.p2e],
        [&a.p2s, &a.p2e, &b.p1s, &b.p1e],
        [&a.p2s, &a.p2e, &b.p2s, &b.p2e],
    ]
}

fn ranges_overlap_sql(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> String {
    let (a, b) = (interval_pieces_sql(a_start, a_end), interval_pieces_sql(b_start, b_end));
    let parts: Vec<String> = piece_pairs(&a, &b).iter().map(|[s1, e1, s2, e2]| format!("({s1} < {e2} AND {s2} < {e1})")).collect();
    format!("({})", parts.join(" OR "))
}

fn overlap_minutes_sql(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> String {
    let (a, b) = (interval_pieces_sql(a_start, a_end), interval_pieces_sql(b_start, b_end));
    let parts: Vec<String> =
        piece_pairs(&a, &b).iter().map(|[s1, e1, s2, e2]| format!("MAX(0, MIN({e1}, {e2}) - MAX({s1}, {s2}))")).collect();
    format!("({})", parts.join(" + "))
}

fn time_in_range_sql(point: &str, start: &str, end: &str) -> String {
    format!(
        "(CASE WHEN {end} < {start}
    THEN ({point} >= {start} OR {point} < {end})
    ELSE ({point} >= {start} AND {point} < {end}) END)"
    )
}

pub(crate) struct ShiftPeriodSql {
    pub has_schedule: String,
    pub is_noturno: String,
}

/// SQL mirror of `classifyShiftPeriod` (format.ts), with the client's night
/// window/rule overriding the company's. Needs `ps`, `c` and `cl` joined.
pub(crate) fn shift_period_sql() -> ShiftPeriodSql {
    let effective_start = "COALESCE(cl.night_start_time, c.night_start_time)";
    let effective_end = "COALESCE(cl.night_end_time, c.night_end_time)";
    let effective_rule = "COALESCE(cl.night_shift_rule, c.night_shift_rule)";
    let night_start = format!(
        "((CAST(substr({effective_start},1,2) AS INTEGER) * 60) + CAST(substr({effective_start},4,2) AS INTEGER))"
    );
    let night_end =
        format!("((CAST(substr({effective_end},1,2) AS INTEGER) * 60) + CAST(substr({effective_end},4,2) AS INTEGER))");
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
        "(CASE {effective_rule}
    WHEN 'start-in-range' THEN {start_in_range}
    WHEN 'end-in-range' THEN {end_in_range}
    WHEN 'start-or-end-in-range' THEN ({start_in_range} OR {end_in_range})
    WHEN 'majority-overlap' THEN {majority_overlap}
    ELSE {overlaps}
  END)"
    );

    ShiftPeriodSql { has_schedule: format!("({shift_start} IS NOT NULL AND {shift_end} IS NOT NULL)"), is_noturno }
}

/// A shift's Diurno/Noturno classification as a SQL expression (NULL without a schedule).
pub(crate) fn shift_period_select_sql() -> String {
    let ShiftPeriodSql { has_schedule, is_noturno } = shift_period_sql();
    format!("(CASE WHEN NOT {has_schedule} THEN NULL WHEN {is_noturno} THEN 'noturno' ELSE 'diurno' END)")
}

/// `parseTimeToMinutes` (format.ts): "H:MM"/"HH:MM" → minutes, else None.
pub(crate) fn parse_time_to_minutes(value: &str) -> Option<i64> {
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

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ScheduleTimeFilter {
    pub rule: String,
    pub time: String,
}

/// The "Horário" filter: the shift's own start/end before/after a reference time.
/// None for an unparseable time (= no filter).
pub(crate) fn schedule_time_condition_sql(filter: &ScheduleTimeFilter, params: &mut Vec<Value>) -> Option<String> {
    let reference = parse_time_to_minutes(&filter.time)?;
    let column = if filter.rule.starts_with("start") { "ps.schedule_start_minutes" } else { "ps.schedule_end_minutes" };
    let op = if filter.rule.ends_with("before") { "<" } else { ">" };
    params.push(Value::from(reference));
    Some(format!("({column} IS NOT NULL AND {column} {op} ${})", params.len()))
}

/// SQL twin of `shiftDurationMinutes` (start == end is a full 24h).
const SHIFT_DURATION_SQL: &str = "(CASE WHEN ps.schedule_end_minutes > ps.schedule_start_minutes THEN ps.schedule_end_minutes - ps.schedule_start_minutes ELSE 1440 - ps.schedule_start_minutes + ps.schedule_end_minutes END)";

/// `ListPaymentShiftSummariesQuery` (minus page/pageSize, which the callers read themselves).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ShiftQuery {
    pub employee_ids: Option<Vec<i64>>,
    pub company_ids: Option<Vec<i64>>,
    pub client_ids: Option<Vec<i64>>,
    pub role_ids: Option<Vec<i64>>,
    pub locals: Option<Vec<String>>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub statuses: Vec<String>,
    pub shift_periods: Vec<String>,
    pub schedule_time_filter: Option<ScheduleTimeFilter>,
    pub attention: Option<String>,
    pub analytics: Option<String>,
    pub analytics_weekday: Option<i64>,
    pub analytics_time_bucket: Option<i64>,
    pub analytics_shift_ids: Option<Vec<i64>>,
    pub shift_ids: Option<Vec<i64>>,
}

impl ShiftQuery {
    /// The "matches nothing" short-circuit every list starts with.
    pub fn is_empty_selection(&self) -> bool {
        self.statuses.is_empty() || self.shift_periods.is_empty()
    }
}

fn push_in(conditions: &mut Vec<String>, column: &str, items: &Option<Vec<impl serde::Serialize>>, params: &mut Vec<Value>) {
    let items = items.as_deref().map(values).unwrap_or_default();
    if let Some(clause) = sql::in_clause(column, &items, params) {
        conditions.push(clause);
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

/// `ps.id IN (...)` for `shiftIds`, as one JSON array param (no bound-parameter limit).
fn shift_ids_condition(shift_ids: &Option<Vec<i64>>, params: &mut Vec<Value>) -> ApiResult<Option<String>> {
    let Some(ids) = shift_ids else { return Ok(None) };
    params.push(Value::String(json_text(ids)?));
    Ok(Some(format!("ps.id IN (SELECT value FROM json_each(${}))", params.len())))
}

/// The scope filters every list shares (colaborador/empresa/cliente/função/local/período).
fn push_scope_conditions(query: &ShiftQuery, conditions: &mut Vec<String>, params: &mut Vec<Value>) {
    push_in(conditions, "e.id", &query.employee_ids, params);
    push_in(conditions, "c.id", &query.company_ids, params);
    push_in(conditions, "cl.id", &query.client_ids, params);
    push_in(conditions, "ps.role_id", &query.role_ids, params);
    push_in(conditions, "ps.local", &query.locals, params);
    if let Some(start) = non_empty(&query.period_start) {
        params.push(Value::from(start));
        conditions.push(format!("ps.work_date >= ${}", params.len()));
    }
    if let Some(end) = non_empty(&query.period_end) {
        params.push(Value::from(end));
        conditions.push(format!("ps.work_date <= ${}", params.len()));
    }
}

fn push_pending_audit(query: &ShiftQuery, conditions: &mut Vec<String>) {
    if query.attention.as_deref() == Some("pending-audit") {
        conditions.push("ps.status = 'pago'".into());
        conditions.push("NOT EXISTS (SELECT 1 FROM payment_audits pa_attention WHERE pa_attention.payment_shift_id = ps.id)".into());
    }
}

/// `buildPaymentShiftRowConditions`: row-level WHERE conditions for every flat
/// (non-aggregated) shift query.
pub(crate) fn build_row_conditions(query: &ShiftQuery, params: &mut Vec<Value>) -> ApiResult<Vec<String>> {
    let mut conditions = vec![head_shift_condition()];
    push_scope_conditions(query, &mut conditions, params);
    if query.statuses.len() < 3 {
        let placeholders: Vec<String> = query
            .statuses
            .iter()
            .map(|s| {
                params.push(Value::from(s.as_str()));
                format!("${}", params.len())
            })
            .collect();
        conditions.push(format!("ps.status IN ({})", placeholders.join(", ")));
    }
    let ShiftPeriodSql { has_schedule, is_noturno } = shift_period_sql();
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
    if query.attention.as_deref() == Some("missing-amount") {
        conditions.push("ps.amount IS NULL".into());
    }
    if let Some(cond) = shift_ids_condition(&query.shift_ids, params)? {
        conditions.push(cond);
    }
    push_pending_audit(query, &mut conditions);
    match query.analytics.as_deref() {
        Some("journey-over-12h") => {
            conditions.push("ps.schedule_start_minutes IS NOT NULL AND ps.schedule_end_minutes IS NOT NULL".into());
            conditions.push(format!("{SHIFT_DURATION_SQL} > 720"));
        }
        Some("journey-under-4h") => {
            conditions.push("ps.schedule_start_minutes IS NOT NULL AND ps.schedule_end_minutes IS NOT NULL".into());
            conditions.push(format!("{SHIFT_DURATION_SQL} BETWEEN 1 AND 239"));
        }
        Some("rest-under-11h") => {
            // The explicit ids are computed from the already-filtered dashboard rows.
            let ids = query.analytics_shift_ids.as_deref().map(values).unwrap_or_default();
            conditions.push(sql::in_clause("ps.id", &ids, params).unwrap_or_else(|| "0 = 1".into()));
        }
        Some("heatmap") => match (query.analytics_weekday, query.analytics_time_bucket) {
            (Some(weekday), Some(bucket)) => {
                params.push(Value::from(weekday.to_string()));
                conditions.push(format!("strftime('%w', ps.work_date) = ${}", params.len()));
                // Análises' heatmap uses 2-hour start buckets (0 = 00:00–01:59 … 11 = 22:00–23:59).
                params.push(Value::from(bucket * 120));
                params.push(Value::from(bucket * 120 + 119));
                conditions.push(format!("ps.schedule_start_minutes BETWEEN ${} AND ${}", params.len() - 1, params.len()));
            }
            _ => conditions.push("0 = 1".into()),
        },
        _ => {}
    }
    Ok(conditions)
}

/// The WHERE + HAVING of `listPaymentShiftSummaries` (status and diurno/noturno
/// read aggregated SUMs there, so they go in HAVING).
pub(crate) fn build_summary_conditions(query: &ShiftQuery, params: &mut Vec<Value>) -> ApiResult<(Vec<String>, Vec<String>)> {
    let mut conditions = vec![head_shift_condition()];
    push_scope_conditions(query, &mut conditions, params);
    if query.attention.as_deref() == Some("missing-amount") {
        conditions.push("ps.amount IS NULL".into());
    }
    if let Some(cond) = shift_ids_condition(&query.shift_ids, params)? {
        conditions.push(cond);
    }
    push_pending_audit(query, &mut conditions);

    let mut having = Vec::new();
    if query.statuses.len() < 3 {
        // An unknown status name would have produced "undefined" in the TS SQL (a
        // syntax error); here it is simply rejected.
        let parts = query
            .statuses
            .iter()
            .map(|s| status_having_condition(s).ok_or_else(|| ApiError::BadRequest("Status inválido.".into())))
            .collect::<ApiResult<Vec<_>>>()?;
        having.push(format!("({})", parts.join(" OR ")));
    }
    if query.shift_periods.len() < 2 {
        let ShiftPeriodSql { has_schedule, is_noturno } = shift_period_sql();
        let parts: Vec<String> = query
            .shift_periods
            .iter()
            .map(|p| {
                if p == "noturno" {
                    format!("SUM(CASE WHEN {has_schedule} AND {is_noturno} THEN 1 ELSE 0 END) > 0")
                } else {
                    format!("SUM(CASE WHEN {has_schedule} AND NOT {is_noturno} THEN 1 ELSE 0 END) > 0")
                }
            })
            .collect();
        having.push(format!("({})", parts.join(" OR ")));
    }
    if let Some(filter) = &query.schedule_time_filter {
        if let Some(cond) = schedule_time_condition_sql(filter, params) {
            having.push(format!("SUM(CASE WHEN {cond} THEN 1 ELSE 0 END) > 0"));
        }
    }
    Ok((conditions, having))
}

/// `findRoleByName`: a função within `company_id` by name or apelido, case-insensitive.
pub(crate) async fn find_role_id_by_name<'e, E>(executor: E, company_id: &Value, text: Option<&str>) -> ApiResult<Option<i64>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let Some(trimmed) = text.map(str::trim).filter(|t| !t.is_empty()) else { return Ok(None) };
    let row = sql::select_one(
        executor,
        "SELECT r.id, r.company_id AS companyId, r.name
     FROM roles r
     WHERE r.company_id = $1
       AND (lower(r.name) = lower($2) OR EXISTS (
         SELECT 1 FROM role_aliases ra WHERE ra.role_id = r.id AND lower(ra.alias) = lower($2)
       ))",
        &[company_id.clone(), Value::from(trimmed)],
    )
    .await?;
    Ok(row.and_then(|r| r.get("id").and_then(Value::as_i64)))
}
