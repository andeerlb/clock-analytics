//! Payment shifts: the Pagamentos lists, the append-only transitions (pay,
//! revert, audit error, edit, auto-sync), audits, history and soft delete.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{Sqlite, Transaction};

use super::import::SHIFT_ALREADY_SUPERSEDED_ERROR;
use super::{
    bool_field, build_row_conditions, build_summary_conditions, field, find_role_id_by_name, json_text, parse_shift_row,
    parse_shift_rows, placeholders, shift_period_select_sql, values, ShiftQuery, PAYMENT_SHIFT_FROM_CLAUSE,
    PAYMENT_SHIFT_SELECT_COLUMNS,
};
use crate::error::{ApiError, ApiResult};
use crate::sql::{self, ExecResult, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/getPaymentShiftsByIds", post(get_payment_shifts_by_ids))
        .route("/rpc/listPaymentShiftSummaries", post(list_payment_shift_summaries))
        .route("/rpc/listPaymentShiftsFlat", post(list_payment_shifts_flat))
        .route("/rpc/countPaymentShiftsByStatus", post(count_payment_shifts_by_status))
        .route("/rpc/listPaymentShiftsForGroup", post(list_payment_shifts_for_group))
        .route("/rpc/getPaymentShift", post(get_payment_shift))
        .route("/rpc/markPaymentShiftPaid", post(mark_payment_shift_paid))
        .route("/rpc/revertPaymentShiftToPending", post(revert_payment_shift_to_pending))
        .route("/rpc/markPaymentShiftAuditError", post(mark_payment_shift_audit_error))
        .route("/rpc/undoPaymentShiftAuditError", post(undo_payment_shift_audit_error))
        .route("/rpc/recordPaymentAudit", post(record_payment_audit))
        .route("/rpc/listPaymentAuditsForShiftIds", post(list_payment_audits_for_shift_ids))
        .route("/rpc/deletePaymentAudit", post(delete_payment_audit))
        .route("/rpc/editPaymentShift", post(edit_payment_shift))
        .route("/rpc/applyAutoSyncedFieldUpdate", post(apply_auto_synced_field_update))
        .route("/rpc/getPaymentShiftHistory", post(get_payment_shift_history))
        .route("/rpc/deletePaymentShift", post(delete_payment_shift))
        .route("/rpc/getPaymentVisibleColumns", post(get_payment_visible_columns))
        .route("/rpc/setPaymentVisibleColumns", post(set_payment_visible_columns))
        .route("/rpc/listLatestFieldDiffsForShifts", post(list_latest_field_diffs_for_shifts))
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PagedQuery {
    #[serde(flatten)]
    pub filters: ShiftQuery,
    pub page: i64,
    pub page_size: i64,
}

fn paged(rows: Vec<Value>, total: Value) -> Value {
    json!({ "rows": rows, "total": total })
}

fn count_of(rows: &[Row]) -> Value {
    rows.first().map(|r| field(r, "count")).filter(|v| !v.is_null()).unwrap_or(json!(0))
}

// --- lists ---------------------------------------------------------------------

#[derive(Deserialize)]
struct IdsArgs {
    ids: Vec<i64>,
}

/// Batched lookup for the deep-check diff pass.
async fn get_payment_shifts_by_ids(State(state): State<AppState>, Json(args): Json<IdsArgs>) -> ApiResult<Json<Vec<Value>>> {
    if args.ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT {PAYMENT_SHIFT_SELECT_COLUMNS} {PAYMENT_SHIFT_FROM_CLAUSE} WHERE ps.id IN ({})",
            placeholders(args.ids.len())
        ),
        &values(&args.ids),
    )
    .await?;
    Ok(Json(parse_shift_rows(rows)?))
}

#[derive(Deserialize)]
struct QueryArgs<Q> {
    query: Q,
}

/// One row per (colaborador, competência) — the Pagamentos list.
pub(crate) async fn list_summaries_impl(state: &AppState, query: &PagedQuery) -> ApiResult<Value> {
    if query.filters.is_empty_selection() {
        return Ok(paged(vec![], json!(0)));
    }
    let mut params = Vec::new();
    let (conditions, having) = build_summary_conditions(&query.filters, &mut params)?;
    let where_clause = if conditions.is_empty() { String::new() } else { format!("WHERE {}", conditions.join(" AND ")) };
    let having_clause = if having.is_empty() { String::new() } else { format!("HAVING {}", having.join(" AND ")) };
    let from = "FROM payment_shifts ps
    JOIN employees e ON e.id = ps.employee_id
    JOIN clients cl ON cl.id = ps.client_id
    JOIN companies c ON c.id = ps.company_id";

    let count_rows = sql::select(
        &state.db,
        &format!(
            "SELECT COUNT(*) AS count FROM (
       SELECT e.id {from} {where_clause} GROUP BY e.id, strftime('%Y-%m', ps.work_date) {having_clause}
     ) t"
        ),
        &params,
    )
    .await?;
    let total = count_of(&count_rows);

    let n = params.len();
    params.push(json!(query.page_size));
    params.push(json!(query.page * query.page_size));
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT
      e.id AS employeeId, e.name AS employeeName,
      cl.id AS clientId, cl.name AS clientName,
      c.id AS companyId, c.name AS companyName,
      strftime('%Y-%m', ps.work_date) AS competencia,
      COUNT(*) AS total,
      SUM(CASE WHEN ps.status = 'pendente' THEN 1 ELSE 0 END) AS pendente,
      SUM(CASE WHEN ps.status = 'erro' THEN 1 ELSE 0 END) AS erro,
      SUM(CASE WHEN ps.status = 'pago' THEN 1 ELSE 0 END) AS pago
    {from}
    {where_clause}
    GROUP BY e.id, competencia
    {having_clause}
    ORDER BY competencia DESC, e.name
    LIMIT ${} OFFSET ${}",
            n + 1,
            n + 2
        ),
        &params,
    )
    .await?;
    Ok(paged(rows.into_iter().map(Value::Object).collect(), total))
}

async fn list_payment_shift_summaries(State(state): State<AppState>, Json(args): Json<QueryArgs<PagedQuery>>) -> ApiResult<Json<Value>> {
    Ok(Json(list_summaries_impl(&state, &args.query).await?))
}

/// One row per turno — the "desagrupado" view.
pub(crate) async fn list_flat_impl(state: &AppState, query: &PagedQuery) -> ApiResult<Value> {
    if query.filters.is_empty_selection() {
        return Ok(paged(vec![], json!(0)));
    }
    let mut params = Vec::new();
    let conditions = build_row_conditions(&query.filters, &mut params)?;
    let from = "FROM payment_shifts ps
    JOIN employees e ON e.id = ps.employee_id
    JOIN clients cl ON cl.id = ps.client_id
    JOIN companies c ON c.id = ps.company_id
    LEFT JOIN source_files sf ON sf.id = ps.source_file_id
    LEFT JOIN roles r ON r.id = ps.role_id";
    let where_clause = format!("WHERE {}", conditions.join(" AND "));

    let count_rows = sql::select(&state.db, &format!("SELECT COUNT(*) AS count {from} {where_clause}"), &params).await?;
    let total = count_of(&count_rows);

    let n = params.len();
    params.push(json!(query.page_size));
    params.push(json!(query.page * query.page_size));
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT {PAYMENT_SHIFT_SELECT_COLUMNS},
            c.name AS companyName, cl.name AS clientName,
            {} AS shiftPeriod
     {from}
     {where_clause}
     ORDER BY ps.work_date DESC, e.name
     LIMIT ${} OFFSET ${}",
            shift_period_select_sql(),
            n + 1,
            n + 2
        ),
        &params,
    )
    .await?;
    Ok(paged(parse_shift_rows(rows)?, total))
}

async fn list_payment_shifts_flat(State(state): State<AppState>, Json(args): Json<QueryArgs<PagedQuery>>) -> ApiResult<Json<Value>> {
    Ok(Json(list_flat_impl(&state, &args.query).await?))
}

/// Shifts per status for the current filters, ignoring the status filter itself.
pub(crate) async fn count_by_status_impl(state: &AppState, query: &ShiftQuery) -> ApiResult<Value> {
    let mut counts = Map::new();
    for status in ["pendente", "erro", "pago"] {
        counts.insert(status.into(), json!(0));
    }
    if query.shift_periods.is_empty() {
        return Ok(Value::Object(counts));
    }
    let mut params = Vec::new();
    let all_statuses = ShiftQuery { statuses: vec!["pendente".into(), "erro".into(), "pago".into()], ..query.clone() };
    let conditions = build_row_conditions(&all_statuses, &mut params)?;
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT ps.status AS status, COUNT(*) AS count
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN clients cl ON cl.id = ps.client_id
     JOIN companies c ON c.id = ps.company_id
     WHERE {}
     GROUP BY ps.status",
            conditions.join(" AND ")
        ),
        &params,
    )
    .await?;
    for row in rows {
        if let Some(status) = row.get("status").and_then(Value::as_str) {
            if counts.contains_key(status) {
                counts.insert(status.to_owned(), field(&row, "count"));
            }
        }
    }
    Ok(Value::Object(counts))
}

async fn count_payment_shifts_by_status(State(state): State<AppState>, Json(args): Json<QueryArgs<ShiftQuery>>) -> ApiResult<Json<Value>> {
    Ok(Json(count_by_status_impl(&state, &args.query).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupArgs {
    employee_id: i64,
    competencia: String,
    filters: ShiftQuery,
}

/// Every current shift of one colaborador in one competência matching the filters.
async fn list_payment_shifts_for_group(State(state): State<AppState>, Json(args): Json<GroupArgs>) -> ApiResult<Json<Vec<Value>>> {
    // The TS type is a `Pick<...>`, but callers pass the whole table query and
    // the desktop applied every filter in it — so does this.
    let filters = args.filters;
    if filters.is_empty_selection() {
        return Ok(Json(vec![]));
    }
    let mut params = params![args.employee_id, args.competencia];
    let mut conditions = vec!["ps.employee_id = $1".to_owned(), "strftime('%Y-%m', ps.work_date) = $2".to_owned()];
    conditions.extend(build_row_conditions(&filters, &mut params)?);
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT {PAYMENT_SHIFT_SELECT_COLUMNS}, {} AS shiftPeriod
     FROM payment_shifts ps
     JOIN employees e ON e.id = ps.employee_id
     JOIN companies c ON c.id = ps.company_id
     JOIN clients cl ON cl.id = ps.client_id
     LEFT JOIN source_files sf ON sf.id = ps.source_file_id
     LEFT JOIN roles r ON r.id = ps.role_id
     WHERE {}
     ORDER BY ps.work_date, ps.id",
            shift_period_select_sql(),
            conditions.join(" AND ")
        ),
        &params,
    )
    .await?;
    Ok(Json(parse_shift_rows(rows)?))
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

pub(crate) async fn get_shift_impl(state: &AppState, id: i64) -> ApiResult<Value> {
    let row = sql::select_one(
        &state.db,
        &format!("SELECT {PAYMENT_SHIFT_SELECT_COLUMNS} {PAYMENT_SHIFT_FROM_CLAUSE} WHERE ps.id = $1"),
        &params![id],
    )
    .await?
    .ok_or_else(|| ApiError::NotFound("Turno não encontrado.".into()))?;
    parse_shift_row(row)
}

/// A single shift by id, current or superseded.
async fn get_payment_shift(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(get_shift_impl(&state, args.id).await?))
}

// --- append-only transitions -----------------------------------------------------

/// `readPaymentShiftCoreFields`: the fields every transition carries over.
async fn read_core_fields(tx: &mut Transaction<'_, Sqlite>, shift_id: i64) -> ApiResult<Row> {
    sql::select_one(
        &mut **tx,
        "SELECT employee_id AS employeeId, template_id AS templateId, source_file_id AS sourceFileId,
            client_id AS clientId, company_id AS companyId,
            local, work_date AS workDate, role_id AS roleId,
            schedule_start_minutes AS scheduleStartMinutes, schedule_end_minutes AS scheduleEndMinutes,
            extra_data AS extraData, status,
            source_row_number AS sourceRowNumber, source_sheet_name AS sourceSheetName, amount,
            edited_manually AS editedManually, previous_shift_id AS previousShiftId
     FROM payment_shifts WHERE id = $1",
        &params![shift_id],
    )
    .await?
    .ok_or_else(|| ApiError::NotFound("Turno não encontrado.".into()))
}

/// `successorShiftId`: zero rows inserted means another writer superseded the
/// head first (the `WHERE NOT EXISTS` guard kept the chain from forking).
fn successor_shift_id(result: ExecResult) -> ApiResult<i64> {
    if result.rows_affected == 0 {
        return Err(ApiError::Conflict(SHIFT_ALREADY_SUPERSEDED_ERROR.into()));
    }
    Ok(result.last_insert_id)
}

/// The first ten core fields, in the order every transition's INSERT binds them ($1–$10).
fn leading_core_params(s: &Row) -> Vec<Value> {
    ["employeeId", "templateId", "sourceFileId", "clientId", "companyId", "local", "workDate", "roleId", "scheduleStartMinutes", "scheduleEndMinutes"]
        .iter()
        .map(|k| field(s, k))
        .collect()
}

/// Runs one transition's guarded INSERT and commits it.
async fn insert_successor(mut tx: Transaction<'_, Sqlite>, sql_text: &str, params: Vec<Value>) -> ApiResult<i64> {
    let result = sql::execute(&mut *tx, sql_text, &params).await?;
    let id = successor_shift_id(result)?;
    tx.commit().await?;
    Ok(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftIdArgs {
    shift_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayArgs {
    shift_id: i64,
    amount: f64,
}

/// "Fazer pagamento": a new `pago` row linked back to `shift_id`; `edited_manually` inherited.
pub(crate) async fn mark_paid_impl(state: &AppState, shift_id: i64, amount: f64) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let s = read_core_fields(&mut tx, shift_id).await?;
    let mut params = leading_core_params(&s);
    params.extend([json!(amount), json!(shift_id), field(&s, "extraData"), field(&s, "editedManually"), field(&s, "sourceRowNumber"), field(&s, "sourceSheetName")]);
    insert_successor(
        tx,
        "INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pago', $11, $12, $13, $14, $15, $16
     WHERE NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $12)",
        params,
    )
    .await
}

async fn mark_payment_shift_paid(State(state): State<AppState>, Json(args): Json<PayArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(mark_paid_impl(&state, args.shift_id, args.amount).await?))
}

/// Undoes a payment: a new `pendente` row (amount cleared) linked back to `shift_id`.
pub(crate) async fn revert_impl(state: &AppState, shift_id: i64) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let s = read_core_fields(&mut tx, shift_id).await?;
    let mut params = leading_core_params(&s);
    params.extend([json!(shift_id), field(&s, "extraData"), field(&s, "editedManually"), field(&s, "sourceRowNumber"), field(&s, "sourceSheetName")]);
    insert_successor(
        tx,
        "INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendente', NULL, $11, $12, $13, $14, $15
     WHERE NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $11)",
        params,
    )
    .await
}

async fn revert_payment_shift_to_pending(State(state): State<AppState>, Json(args): Json<ShiftIdArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(revert_impl(&state, args.shift_id).await?))
}

/// Shown alongside the "Erro" badge for a shift `markPaymentShiftAuditError` transitioned.
const AUDIT_ERROR_MESSAGE: &str = "Marcado como erro na Conferência de Pagamentos.";

/// "Marcar erro" in Conferência: a new `erro` row (amount cleared) linked back to `shift_id`.
pub(crate) async fn mark_audit_error_impl(state: &AppState, shift_id: i64) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let s = read_core_fields(&mut tx, shift_id).await?;
    let mut params = leading_core_params(&s);
    params.extend([
        json!(AUDIT_ERROR_MESSAGE),
        json!(shift_id),
        field(&s, "extraData"),
        field(&s, "editedManually"),
        field(&s, "sourceRowNumber"),
        field(&s, "sourceSheetName"),
    ]);
    insert_successor(
        tx,
        "INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, error_message, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'erro', $11, NULL, $12, $13, $14, $15, $16
     WHERE NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $12)",
        params,
    )
    .await
}

async fn mark_payment_shift_audit_error(State(state): State<AppState>, Json(args): Json<ShiftIdArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(mark_audit_error_impl(&state, args.shift_id).await?))
}

/// "Desfazer" on an audit error: a new `pago` row with the amount of the
/// `pago` row the `erro` one superseded (one hop back).
pub(crate) async fn undo_audit_error_impl(state: &AppState, shift_id: i64) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let s = read_core_fields(&mut tx, shift_id).await?;
    let Some(previous_id) = field(&s, "previousShiftId").as_i64() else {
        return Err(ApiError::BadRequest("Não foi possível encontrar o pagamento original para restaurar.".into()));
    };
    let previous = read_core_fields(&mut tx, previous_id).await?;
    let mut params = leading_core_params(&s);
    params.extend([
        field(&previous, "amount"),
        json!(shift_id),
        field(&s, "extraData"),
        field(&s, "editedManually"),
        field(&s, "sourceRowNumber"),
        field(&s, "sourceSheetName"),
    ]);
    insert_successor(
        tx,
        "INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pago', $11, $12, $13, $14, $15, $16
     WHERE NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $12)",
        params,
    )
    .await
}

async fn undo_payment_shift_audit_error(State(state): State<AppState>, Json(args): Json<ShiftIdArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(undo_audit_error_impl(&state, args.shift_id).await?))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditFields {
    pub work_date: String,
    pub local: String,
    pub role: String,
    pub schedule_start_minutes: Option<i64>,
    pub schedule_end_minutes: Option<i64>,
    pub amount: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditArgs {
    shift_id: i64,
    fields: EditFields,
}

/// Manual override of a pendente/erro shift's data: a new row with the given
/// fields, the old status, `edited_manually = 1`. A paid shift is never edited.
pub(crate) async fn edit_impl(state: &AppState, shift_id: i64, fields: &EditFields) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let s = read_core_fields(&mut tx, shift_id).await?;
    if s.get("status").and_then(Value::as_str) == Some("pago") {
        return Err(ApiError::BadRequest("Não é possível editar um turno já pago.".into()));
    }
    // Função is only ever a role_id: the text must resolve to a cadastro of the
    // shift's own empresa (by name or apelido), or be blank.
    let trimmed_role = fields.role.trim();
    let role_id = if trimmed_role.is_empty() {
        None
    } else {
        Some(find_role_id_by_name(&mut *tx, &field(&s, "companyId"), Some(trimmed_role)).await?.ok_or_else(|| {
            ApiError::BadRequest(format!("Função \"{trimmed_role}\" não encontrada. Cadastre-a em Funções antes de vincular a este turno."))
        })?)
    };
    let params = vec![
        field(&s, "employeeId"),
        field(&s, "templateId"),
        field(&s, "sourceFileId"),
        field(&s, "clientId"),
        field(&s, "companyId"),
        json!(fields.local),
        json!(fields.work_date),
        json!(role_id),
        json!(fields.schedule_start_minutes),
        json!(fields.schedule_end_minutes),
        field(&s, "status"),
        json!(fields.amount),
        json!(shift_id),
        field(&s, "extraData"),
        field(&s, "sourceRowNumber"),
        field(&s, "sourceSheetName"),
    ];
    insert_successor(
        tx,
        "INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data, edited_manually,
        source_row_number, source_sheet_name)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $16
     WHERE NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $13)",
        params,
    )
    .await
}

async fn edit_payment_shift(State(state): State<AppState>, Json(args): Json<EditArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(edit_impl(&state, args.shift_id, &args.fields).await?))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoSyncFields {
    pub work_date: String,
    pub local: String,
    pub role: String,
    pub schedule_start_minutes: Option<i64>,
    pub schedule_end_minutes: Option<i64>,
    pub status: String,
    pub extra_data: Option<Value>,
    pub client_id: i64,
    pub company_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoSyncArgs {
    pub shift_id: i64,
    pub fields: AutoSyncFields,
    pub source_file_id: i64,
    pub source_row_number: Option<i64>,
    pub source_sheet_name: Option<String>,
}

/// Auto-apply's counterpart to `editPaymentShift`: no paid guard (the caller
/// decides), the current amount carried forward, fresh client/empresa and
/// função, `edited_manually = 0`.
pub(crate) async fn auto_sync_impl(state: &AppState, args: &AutoSyncArgs) -> ApiResult<i64> {
    let mut tx = state.db.begin().await?;
    let s = read_core_fields(&mut tx, args.shift_id).await?;
    let f = &args.fields;
    let role_id = find_role_id_by_name(&mut *tx, &json!(f.company_id), Some(&f.role)).await?;
    let extra = match &f.extra_data {
        Some(v) if !v.is_null() => json!(json_text(v)?),
        _ => Value::Null,
    };
    let params = vec![
        field(&s, "employeeId"),
        field(&s, "templateId"),
        json!(args.source_file_id),
        json!(f.client_id),
        json!(f.company_id),
        json!(f.local),
        json!(f.work_date),
        json!(role_id),
        json!(f.schedule_start_minutes),
        json!(f.schedule_end_minutes),
        json!(f.status),
        field(&s, "amount"),
        json!(args.shift_id),
        extra,
        json!(args.source_row_number),
        json!(args.source_sheet_name),
    ];
    insert_successor(
        tx,
        "INSERT INTO payment_shifts
       (employee_id, template_id, source_file_id, client_id, company_id, local, work_date, role_id,
        schedule_start_minutes, schedule_end_minutes, status, amount, previous_shift_id, extra_data,
        edited_manually, source_row_number, source_sheet_name)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16
     WHERE NOT EXISTS (SELECT 1 FROM payment_shifts WHERE previous_shift_id = $13)",
        params,
    )
    .await
}

async fn apply_auto_synced_field_update(State(state): State<AppState>, Json(args): Json<AutoSyncArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(auto_sync_impl(&state, &args).await?))
}

// --- audits ------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordAuditArgs {
    payment_shift_id: i64,
    result: String,
    note: Option<String>,
}

/// Upserts Conferência's bank-statement verdict for a shift.
async fn record_payment_audit(State(state): State<AppState>, Json(args): Json<RecordAuditArgs>) -> ApiResult<StatusCode> {
    sql::execute(
        &state.db,
        "INSERT INTO payment_audits (payment_shift_id, result, note)
     VALUES ($1, $2, $3)
     ON CONFLICT(payment_shift_id) DO UPDATE SET result = excluded.result, note = excluded.note, audited_at = datetime('now')",
        &params![args.payment_shift_id, args.result, args.note],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftIdsArgs {
    shift_ids: Vec<i64>,
}

async fn list_payment_audits_for_shift_ids(State(state): State<AppState>, Json(args): Json<ShiftIdsArgs>) -> ApiResult<Json<Vec<Row>>> {
    if args.shift_ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT id, payment_shift_id AS paymentShiftId, result, note, audited_at AS auditedAt
     FROM payment_audits
     WHERE payment_shift_id IN ({})",
            placeholders(args.shift_ids.len())
        ),
        &values(&args.shift_ids),
    )
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaymentShiftIdArgs {
    payment_shift_id: i64,
}

async fn delete_payment_audit(State(state): State<AppState>, Json(args): Json<PaymentShiftIdArgs>) -> ApiResult<StatusCode> {
    sql::execute(&state.db, "DELETE FROM payment_audits WHERE payment_shift_id = $1", &params![args.payment_shift_id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- history / delete ----------------------------------------------------------------

/// The whole append-only chain backward from `shift_id`, most recent first.
pub(crate) async fn history_impl(state: &AppState, shift_id: i64) -> ApiResult<Vec<Value>> {
    let rows = sql::select(
        &state.db,
        &format!(
            "WITH RECURSIVE chain(id) AS (
       SELECT $1
       UNION ALL
       SELECT ps.previous_shift_id
       FROM payment_shifts ps
       JOIN chain ON chain.id = ps.id
       WHERE ps.previous_shift_id IS NOT NULL
     )
     SELECT {PAYMENT_SHIFT_SELECT_COLUMNS}
     {PAYMENT_SHIFT_FROM_CLAUSE}
     JOIN chain ON chain.id = ps.id
     ORDER BY ps.id DESC"
        ),
        &params![shift_id],
    )
    .await?;
    parse_shift_rows(rows)
}

async fn get_payment_shift_history(State(state): State<AppState>, Json(args): Json<ShiftIdArgs>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(history_impl(&state, args.shift_id).await?))
}

/// "Remover": soft-deletes the shift and its whole history chain, so a later
/// reimport can still recognize it (flagged "excluído").
pub(crate) async fn delete_shift_impl(state: &AppState, shift_id: i64) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    let mut ids = vec![shift_id];
    let mut current = shift_id;
    loop {
        let row = sql::select_one(&mut *tx, "SELECT previous_shift_id AS previousShiftId FROM payment_shifts WHERE id = $1", &params![current]).await?;
        let Some(previous) = row.and_then(|r| r.get("previousShiftId").and_then(Value::as_i64)) else { break };
        if ids.contains(&previous) {
            break;
        }
        ids.push(previous);
        current = previous;
    }
    sql::execute(
        &mut *tx,
        &format!("UPDATE payment_shifts SET deleted_at = datetime('now') WHERE id IN ({})", placeholders(ids.len())),
        &values(&ids),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn delete_payment_shift(State(state): State<AppState>, Json(args): Json<ShiftIdArgs>) -> ApiResult<StatusCode> {
    delete_shift_impl(&state, args.shift_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- settings / diffs --------------------------------------------------------------

/// Which Pagamentos columns are shown — null means every column.
async fn get_payment_visible_columns(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let row = sql::select_one(&state.db, "SELECT visible_columns_json AS visibleColumnsJson FROM payment_settings WHERE id = 1", &[]).await?;
    let mut row = row.unwrap_or_default();
    super::parse_json_field(&mut row, "visibleColumnsJson")?;
    Ok(Json(field(&row, "visibleColumnsJson")))
}

#[derive(Deserialize)]
struct ColumnsArgs {
    columns: Vec<String>,
}

async fn set_payment_visible_columns(State(state): State<AppState>, Json(args): Json<ColumnsArgs>) -> ApiResult<StatusCode> {
    sql::execute(
        &state.db,
        "UPDATE payment_settings SET visible_columns_json = $1, updated_at = datetime('now') WHERE id = 1",
        &params![json_text(&args.columns)?],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What the latest automatic check of each shift's source URL found for it.
async fn list_latest_field_diffs_for_shifts(State(state): State<AppState>, Json(args): Json<ShiftIdsArgs>) -> ApiResult<Json<Vec<Value>>> {
    if args.shift_ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT d.matched_shift_id AS shiftId, d.check_log_id AS checkLogId, l.checked_at AS checkedAt,
            d.config_id AS configId, d.config_label AS configLabel, d.change_kind AS changeKind,
            d.field_name AS fieldName, d.column_letter AS columnLetter, d.old_value AS oldValue,
            d.new_value AS newValue, d.message, d.applied
     FROM source_url_check_diffs d
     JOIN source_url_check_log l ON l.id = d.check_log_id
     WHERE d.change_kind IN ('field', 'removed')
       AND d.matched_shift_id IN ({})
       AND l.id = (SELECT MAX(l2.id) FROM source_url_check_log l2 WHERE l2.source_url = l.source_url)
     ORDER BY d.matched_shift_id, d.id",
            placeholders(args.shift_ids.len())
        ),
        &values(&args.shift_ids),
    )
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|mut row| {
                bool_field(&mut row, "applied");
                Value::Object(row)
            })
            .collect(),
    ))
}
