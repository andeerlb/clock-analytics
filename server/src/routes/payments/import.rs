//! Importing payment spreadsheets: matching candidate rows against existing
//! shifts, saving an import's shifts, and turning on URL tracking.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{bool_field, field, head_shift_condition, json_text, STRUCTURAL_HEAD_CONDITION};
use crate::error::ApiResult;
use crate::sql::{self, BatchStatement};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/findDuplicatePaymentShifts", post(find_duplicate_payment_shifts))
        .route("/rpc/findPaymentShiftByPosition", post(find_payment_shift_by_position))
        .route("/rpc/listHeadShiftsForSourceUrl", post(list_head_shifts_for_source_url))
        .route("/rpc/trackUrlForAutoReimport", post(track_url_for_auto_reimport))
        .route("/rpc/savePaymentShifts", post(save_payment_shifts))
}

/// Shown when a transition (or a reprocessed import row) loses the race for a head.
pub(crate) const SHIFT_ALREADY_SUPERSEDED_ERROR: &str =
    "Esse turno já foi alterado em outro lugar (outra janela ou a verificação automática). Atualize a lista e tente de novo.";

// --- findDuplicatePaymentShifts ------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DuplicateCandidate {
    pub employee_id: i64,
    pub work_date: String,
    pub local: String,
    pub role_id: Option<f64>,
    pub schedule_start_minutes: Option<f64>,
    pub schedule_end_minutes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DuplicateMatch {
    pub shift_id: i64,
    pub edited_manually: bool,
    pub status: String,
    pub identity_changed: bool,
    pub deleted: bool,
}

#[derive(Deserialize)]
struct DuplicateArgs {
    rows: Vec<DuplicateCandidate>,
}

fn num(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// For each candidate, the *current* head matching the same identity —
/// directly, or by walking forward from a historical row whose identity a
/// manual edit has since changed. Returns `[index, match]` pairs: the TS
/// rebuilds its `Map<number, DuplicatePaymentShiftMatch>` from them.
pub(crate) async fn find_duplicates_impl(state: &AppState, rows: &[DuplicateCandidate]) -> ApiResult<Vec<(usize, DuplicateMatch)>> {
    let mut matches = Vec::new();
    let sql_text = format!(
        "WITH RECURSIVE lineage(id) AS (
         SELECT ps.id FROM payment_shifts ps
         WHERE ps.employee_id = $1 AND ps.work_date = $2 AND ps.local = $3
           AND IFNULL(ps.role_id, -1) = IFNULL($4, -1)
           AND IFNULL(ps.schedule_start_minutes, -1) = IFNULL($5, -1)
           AND IFNULL(ps.schedule_end_minutes, -1) = IFNULL($6, -1)
         UNION ALL
         SELECT next_ps.id FROM payment_shifts next_ps
         JOIN lineage ON next_ps.previous_shift_id = lineage.id
       )
       SELECT ps.id, ps.edited_manually AS editedManually, ps.status, ps.deleted_at AS deletedAt,
              ps.work_date AS currentWorkDate, ps.local AS currentLocal, ps.role_id AS currentRoleId,
              ps.schedule_start_minutes AS currentScheduleStart, ps.schedule_end_minutes AS currentScheduleEnd
       FROM payment_shifts ps
       WHERE ps.id IN (SELECT id FROM lineage) AND {STRUCTURAL_HEAD_CONDITION}
       ORDER BY ps.id DESC
       LIMIT 1"
    );
    // One snapshot for the whole lookup, instead of one per candidate.
    let mut tx = state.db.begin().await?;
    for (i, r) in rows.iter().enumerate() {
        let Some(mut head) = sql::select_one(
            &mut *tx,
            &sql_text,
            &params![r.employee_id, r.work_date, r.local, r.role_id, r.schedule_start_minutes, r.schedule_end_minutes],
        )
        .await?
        else {
            continue;
        };
        let identity_changed = head.get("currentWorkDate").and_then(Value::as_str) != Some(r.work_date.as_str())
            || head.get("currentLocal").and_then(Value::as_str) != Some(r.local.as_str())
            || num(&field(&head, "currentRoleId")) != r.role_id
            || num(&field(&head, "currentScheduleStart")) != r.schedule_start_minutes
            || num(&field(&head, "currentScheduleEnd")) != r.schedule_end_minutes;
        bool_field(&mut head, "editedManually");
        matches.push((
            i,
            DuplicateMatch {
                shift_id: field(&head, "id").as_i64().unwrap_or_default(),
                edited_manually: head["editedManually"] == Value::Bool(true),
                status: field(&head, "status").as_str().unwrap_or_default().to_owned(),
                identity_changed,
                deleted: !field(&head, "deletedAt").is_null(),
            },
        ));
    }
    tx.commit().await?;
    Ok(matches)
}

async fn find_duplicate_payment_shifts(State(state): State<AppState>, Json(args): Json<DuplicateArgs>) -> ApiResult<Json<Vec<(usize, DuplicateMatch)>>> {
    Ok(Json(find_duplicates_impl(&state, &args.rows).await?))
}

// --- findPaymentShiftByPosition / listHeadShiftsForSourceUrl --------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionArgs {
    source_url: String,
    sheet_name: Option<String>,
    row_number: f64,
}

async fn find_payment_shift_by_position(State(state): State<AppState>, Json(args): Json<PositionArgs>) -> ApiResult<Json<Value>> {
    let row = sql::select_one(
        &state.db,
        &format!(
            "SELECT ps.id AS shiftId, ps.employee_id AS employeeId, e.name AS employeeName, ps.work_date AS workDate,
            ps.local, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.extra_data AS extraData, ps.edited_manually AS editedManually
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN source_files sf ON sf.id = ps.source_file_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE sf.source_url = $1
       AND IFNULL(ps.source_sheet_name, '') = IFNULL($2, '')
       AND ps.source_row_number = $3
       AND {STRUCTURAL_HEAD_CONDITION}
     ORDER BY ps.id DESC
     LIMIT 1"
        ),
        &params![args.source_url, args.sheet_name, args.row_number],
    )
    .await?;
    Ok(Json(match row {
        Some(row) => super::parse_shift_row(row)?,
        None => Value::Null,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceUrlArgs {
    source_url: String,
    period_start: Option<String>,
    period_end: Option<String>,
}

async fn list_head_shifts_for_source_url(State(state): State<AppState>, Json(args): Json<SourceUrlArgs>) -> ApiResult<Json<Vec<Value>>> {
    let mut conditions = vec!["sf.source_url = $1".to_owned(), head_shift_condition()];
    let mut params = params![args.source_url];
    if let Some(start) = args.period_start.filter(|s| !s.is_empty()) {
        params.push(json!(start));
        conditions.push(format!("ps.work_date >= ${}", params.len()));
    }
    if let Some(end) = args.period_end.filter(|s| !s.is_empty()) {
        params.push(json!(end));
        conditions.push(format!("ps.work_date <= ${}", params.len()));
    }
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT ps.id AS shiftId, ps.employee_id AS employeeId, e.name AS employeeName, ps.work_date AS workDate,
            ps.local, COALESCE(r.name, '') AS role, ps.role_id AS roleId,
            ps.schedule_start_minutes AS scheduleStartMinutes, ps.schedule_end_minutes AS scheduleEndMinutes,
            ps.status, ps.source_sheet_name AS sheetName, ps.source_row_number AS rowNumber,
            ps.edited_manually AS editedManually
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN source_files sf ON sf.id = ps.source_file_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE {}",
            conditions.join(" AND ")
        ),
        &params,
    )
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|mut row| {
                bool_field(&mut row, "editedManually");
                Value::Object(row)
            })
            .collect(),
    ))
}

// --- trackUrlForAutoReimport ---------------------------------------------------

/// `DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES` in db.ts.
const DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES: i64 = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackUrlArgs {
    pub source_url: String,
    pub template_id: i64,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub keep_manual_edits: bool,
}

/// Turns tracking on for the URL and creates its first reimport config
/// (fixed período, auto-apply off) — `createReimportConfig`'s insert, inline,
/// in the same transaction.
pub(crate) async fn track_url_impl(state: &AppState, args: &TrackUrlArgs) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    sql::execute(
        &mut *tx,
        "INSERT INTO source_url_settings (source_url, tracking_enabled, updated_at)
     VALUES ($1, 1, datetime('now'))
     ON CONFLICT(source_url) DO UPDATE SET
       tracking_enabled = 1,
       updated_at = excluded.updated_at",
        &params![args.source_url],
    )
    .await?;
    sql::execute(
        &mut *tx,
        "INSERT INTO source_url_reimport_configs
       (source_url, label, template_id, date_mode, period_start, period_end, start_offset_days, end_offset_days,
        check_interval_minutes, keep_manual_edits, auto_apply_enabled, auto_apply_overwrite_manual_edits,
        auto_apply_overwrite_paid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        &[
            json!(args.source_url),
            json!(""),
            json!(args.template_id),
            json!("fixed"),
            json!(args.period_start),
            json!(args.period_end),
            Value::Null,
            Value::Null,
            json!(DEFAULT_REIMPORT_CHECK_INTERVAL_MINUTES),
            json!(if args.keep_manual_edits { 1 } else { 0 }),
            // Auto-apply is an explicit opt-in, turned on later from the
            // Verificação automática page.
            json!(0),
            json!(1),
            json!(0),
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn track_url_for_auto_reimport(State(state): State<AppState>, Json(args): Json<TrackUrlArgs>) -> ApiResult<StatusCode> {
    track_url_impl(&state, &args).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- savePaymentShifts -----------------------------------------------------------

/// `PaymentShiftInput`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaymentShiftInput {
    pub employee_id: i64,
    pub template_id: Option<i64>,
    pub source_file_id: Option<i64>,
    pub client_id: i64,
    pub company_id: i64,
    pub local: String,
    pub work_date: String,
    pub role_id: Option<i64>,
    pub schedule_start_minutes: Option<i64>,
    pub schedule_end_minutes: Option<i64>,
    pub status: String,
    pub extra_data: Option<Value>,
    pub previous_shift_id: Option<i64>,
    pub source_row_number: Option<i64>,
    pub source_sheet_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveShiftsArgs {
    pub rows: Vec<PaymentShiftInput>,
    #[serde(default)]
    pub saved_file_hashes: Vec<String>,
}

/// One transaction for the whole import. A row reprocessing an existing shift
/// gets the fork guard (only inserted while nothing points at its previous
/// row yet); if it trips, the whole batch rolls back. The saved files are
/// marked in the same transaction, so shifts never exist without their file
/// marked as saved.
pub(crate) async fn save_shifts_impl(state: &AppState, args: &SaveShiftsArgs) -> ApiResult<()> {
    let mut statements = Vec::with_capacity(args.rows.len() + args.saved_file_hashes.len());
    for r in &args.rows {
        let extra = match &r.extra_data {
            Some(v) if !v.is_null() => json!(json_text(v)?),
            _ => Value::Null,
        };
        statements.push(
            BatchStatement::new(
                "INSERT INTO payment_shifts
         (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
          schedule_start_minutes, schedule_end_minutes, status, extra_data, previous_shift_id,
          source_row_number, source_sheet_name)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       WHERE $13 IS NULL OR NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $13)",
                params![
                    r.employee_id,
                    r.template_id,
                    r.source_file_id,
                    r.client_id,
                    r.company_id,
                    r.local,
                    r.work_date,
                    r.role_id,
                    r.schedule_start_minutes,
                    r.schedule_end_minutes,
                    r.status,
                    extra,
                    r.previous_shift_id,
                    r.source_row_number,
                    r.source_sheet_name,
                ],
            )
            .expect_changes(SHIFT_ALREADY_SUPERSEDED_ERROR),
        );
    }
    for hash in &args.saved_file_hashes {
        statements.push(BatchStatement::new("UPDATE source_files SET saved_at = datetime('now') WHERE file_hash = $1", params![hash]));
    }
    sql::run_batch(&state.db, statements).await?;
    Ok(())
}

async fn save_payment_shifts(State(state): State<AppState>, Json(args): Json<SaveShiftsArgs>) -> ApiResult<StatusCode> {
    save_shifts_impl(&state, &args).await?;
    Ok(StatusCode::NO_CONTENT)
}

