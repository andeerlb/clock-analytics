//! Importação de espelhos de ponto e Cartão Ponto (imports, day_records, source_files).
//! Port of `logSourceFile`, `markSourceFileSaved`, `deleteImport`,
//! `saveParsedTimesheet`, `getImportById`, `countImportsByStatus`,
//! `listImports`, `listStoredDayRecords`, `findDuplicateFiles`,
//! `findConflictingImport`, `findConflicts`, `countImportFiles` and
//! `listImportFiles` from the desktop's `src/lib/db.ts` — same SQL, same
//! rules, same messages.
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::domain::model::ParsedTimesheet;
use crate::error::{ApiError, ApiResult};
use crate::sql::{self, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/logSourceFile", post(log_source_file))
        .route("/rpc/markSourceFileSaved", post(mark_source_file_saved))
        .route("/rpc/deleteImport", post(delete_import))
        .route("/rpc/saveParsedTimesheet", post(save_parsed_timesheet))
        .route("/rpc/getImportById", post(get_import_by_id))
        .route("/rpc/countImportsByStatus", post(count_imports_by_status))
        .route("/rpc/listImports", post(list_imports))
        .route("/rpc/listStoredDayRecords", post(list_stored_day_records))
        .route("/rpc/findDuplicateFiles", post(find_duplicate_files))
        .route("/rpc/findConflictingImport", post(find_conflicting_import))
        .route("/rpc/findConflicts", post(find_conflicts))
        .route("/rpc/countImportFiles", post(count_import_files))
        .route("/rpc/listImportFiles", post(list_import_files))
}

// --- source_files ------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFileInput {
    file_hash: String,
    file_name: String,
    page_count: i64,
    provider: String,
    import_type: String,
    status: String,
    error_message: Option<String>,
    original_pdf_path: String,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    source_etag: Option<String>,
    #[serde(default)]
    source_last_modified: Option<String>,
    #[serde(default)]
    source_content_length: Option<f64>,
}

#[derive(Deserialize)]
struct LogSourceFileArgs {
    input: SourceFileInput,
}

/// Logs one import attempt; re-processing the same file (same hash)
/// refreshes the row. Returns the `source_files.id`.
async fn log_source_file(State(state): State<AppState>, Json(args): Json<LogSourceFileArgs>) -> ApiResult<Json<i64>> {
    let input = args.input;
    sql::execute(
        &state.db,
        "INSERT INTO source_files
       (file_name, file_hash, page_count, provider, import_type, status, error_message, original_pdf_path,
        source_url, source_etag, source_last_modified, source_content_length)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT(file_hash) DO UPDATE SET
       file_name = excluded.file_name,
       page_count = excluded.page_count,
       provider = excluded.provider,
       import_type = excluded.import_type,
       status = excluded.status,
       error_message = excluded.error_message,
       original_pdf_path = excluded.original_pdf_path,
       source_url = excluded.source_url,
       source_etag = excluded.source_etag,
       source_last_modified = excluded.source_last_modified,
       source_content_length = excluded.source_content_length,
       imported_at = datetime('now')",
        &params![
            input.file_name,
            input.file_hash,
            input.page_count,
            input.provider,
            input.import_type,
            input.status,
            input.error_message,
            input.original_pdf_path,
            input.source_url,
            input.source_etag,
            input.source_last_modified,
            input.source_content_length,
        ],
    )
    .await?;
    // `lastInsertId` isn't reliable across the ON CONFLICT DO UPDATE path, so
    // look the row up explicitly rather than trust it.
    let row = sql::select_one(&state.db, "SELECT id FROM source_files WHERE file_hash = $1", &params![input.file_hash])
        .await?
        .ok_or_else(|| ApiError::Internal("source_files row vanished right after upsert".into()))?;
    Ok(Json(row_i64(&row, "id")))
}

const MARK_SOURCE_FILE_SAVED_SQL: &str = "UPDATE source_files SET saved_at = datetime('now') WHERE file_hash = $1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHashArgs {
    file_hash: String,
}

async fn mark_source_file_saved(State(state): State<AppState>, Json(args): Json<FileHashArgs>) -> ApiResult<StatusCode> {
    sql::run_batch(&state.db, vec![sql::BatchStatement::new(MARK_SOURCE_FILE_SAVED_SQL, params![args.file_hash])]).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- imports: delete / save ----------------------------------------------------

/// Deletes an import and its day_records/punches, cascading by hand (see db.ts).
fn delete_import_statements(import_id: i64) -> Vec<sql::BatchStatement> {
    vec![
        sql::BatchStatement::new(
            "DELETE FROM punches WHERE day_record_id IN (SELECT id FROM day_records WHERE import_id = $1)",
            params![import_id],
        ),
        sql::BatchStatement::new("DELETE FROM day_records WHERE import_id = $1", params![import_id]),
        sql::BatchStatement::new("DELETE FROM imports WHERE id = $1", params![import_id]),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteImportArgs {
    import_id: i64,
}

async fn delete_import(State(state): State<AppState>, Json(args): Json<DeleteImportArgs>) -> ApiResult<StatusCode> {
    sql::run_batch(&state.db, delete_import_statements(args.import_id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Period aggregates `saveParsedTimesheet` computes in the frontend with
/// `analysis.ts` (pure computation, kept there so the stored values stay
/// identical to the desktop's).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimesheetAggregates {
    max_punches: i64,
    total_worked_minutes: i64,
    overtime_minutes: i64,
    absence_minutes: i64,
    late_minutes: i64,
    regular_minutes: i64,
    interval_minutes: i64,
    pending_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveParsedTimesheetArgs {
    sheet: ParsedTimesheet,
    client_id: i64,
    company_id: i64,
    #[serde(default)]
    replace_import_id: Option<i64>,
    #[serde(default)]
    source_file_id: Option<i64>,
    aggregates: TimesheetAggregates,
}

async fn save_parsed_timesheet(State(state): State<AppState>, Json(args): Json<SaveParsedTimesheetArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(save_timesheet(&state.db, args).await?))
}

/// digits-only, as `normalizeCpf` in format.ts.
fn normalize_cpf(cpf: &str) -> String {
    cpf.chars().filter(char::is_ascii_digit).collect()
}

fn row_i64(row: &Row, key: &str) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or_default()
}

/// `upsertEmployee`: one person per cpf globally; links the
/// (cliente, empresa) pair this import is under.
async fn upsert_employee(tx: &mut Transaction<'_, Sqlite>, company_id: i64, client_id: i64, name: &str, cpf: &str) -> ApiResult<i64> {
    let normalized_cpf = normalize_cpf(cpf);
    let existing = sql::select_one(&mut **tx, "SELECT id FROM employees WHERE cpf = $1", &params![normalized_cpf]).await?;
    let employee_id = match existing {
        Some(row) => {
            let id = row_i64(&row, "id");
            sql::execute(&mut **tx, "UPDATE employees SET name = $1 WHERE id = $2", &params![name, id]).await?;
            id
        }
        None => {
            sql::execute(&mut **tx, "INSERT INTO employees (name, cpf) VALUES ($1, $2)", &params![name, normalized_cpf])
                .await?
                .last_insert_id
        }
    };
    sql::execute(
        &mut **tx,
        "INSERT INTO employee_client_companies (employee_id, client_id, company_id) VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, client_id, company_id) DO NOTHING",
        &params![employee_id, client_id, company_id],
    )
    .await?;
    Ok(employee_id)
}

async fn upsert_import_file(tx: &mut Transaction<'_, Sqlite>, file_name: &str, file_hash: &str) -> ApiResult<i64> {
    if let Some(row) = sql::select_one(&mut **tx, "SELECT id FROM import_files WHERE file_hash = $1", &params![file_hash]).await? {
        return Ok(row_i64(&row, "id"));
    }
    Ok(sql::execute(&mut **tx, "INSERT INTO import_files (file_name, file_hash) VALUES ($1, $2)", &params![file_name, file_hash])
        .await?
        .last_insert_id)
}

/// `saveParsedTimesheet`. The desktop ran the link check and the
/// employee/import_files upserts as separate statements before the batch;
/// here the whole sequence (same order) runs in one transaction.
async fn save_timesheet(pool: &SqlitePool, args: SaveParsedTimesheetArgs) -> ApiResult<i64> {
    let SaveParsedTimesheetArgs { sheet, client_id, company_id, replace_import_id, source_file_id, aggregates: agg } = args;
    let mut tx = pool.begin().await?;

    // A client can be linked to more than one company, so the pairing has to
    // be validated explicitly rather than derived.
    let link = sql::select(
        &mut *tx,
        "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
        &params![client_id, company_id],
    )
    .await?;
    if link.is_empty() {
        return Err(ApiError::BadRequest("Esse cliente não está vinculado à empresa selecionada.".into()));
    }

    let employee_id = upsert_employee(&mut tx, company_id, client_id, &sheet.employee.name, &sheet.employee.cpf).await?;
    let import_file_id = upsert_import_file(&mut tx, &sheet.original_file_name, &sheet.original_file_hash).await?;

    if let Some(replace_id) = replace_import_id {
        for statement in delete_import_statements(replace_id) {
            sql::execute(&mut *tx, &statement.sql, &statement.params).await?;
        }
    }

    let import_id = sql::execute(
        &mut *tx,
        "INSERT INTO imports
       (provider, employee_id, client_id, company_id, period_start, period_end, original_pdf_path, import_file_id,
        source_file_id, max_punches, total_worked_minutes, overtime_minutes, absence_minutes,
        late_minutes, regular_minutes, interval_minutes, pending_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
        &params![
            sheet.provider,
            employee_id,
            client_id,
            company_id,
            sheet.period.start,
            sheet.period.end,
            sheet.original_pdf_path,
            import_file_id,
            source_file_id,
            agg.max_punches,
            agg.total_worked_minutes,
            agg.overtime_minutes,
            agg.absence_minutes,
            agg.late_minutes,
            agg.regular_minutes,
            agg.interval_minutes,
            agg.pending_count,
        ],
    )
    .await?
    .last_insert_id;

    for day in &sheet.days {
        let day_id = sql::execute(
            &mut *tx,
            "INSERT INTO day_records
         (import_id, date, weekday, total_worked_minutes, normal_hours_minutes, absence_minutes, observation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &params![
                import_id,
                day.date,
                day.weekday,
                day.total_worked_minutes,
                day.normal_hours_minutes,
                day.absence_minutes,
                day.observation,
            ],
        )
        .await?
        .last_insert_id;
        for (i, punch) in day.punches.iter().enumerate() {
            sql::execute(
                &mut *tx,
                "INSERT INTO punches (day_record_id, punch_time, sequence_index) VALUES ($1, $2, $3)",
                &params![day_id, punch, i],
            )
            .await?;
        }
    }

    tx.commit().await?;
    Ok(import_id)
}

// --- imports: reads -------------------------------------------------------------

const IMPORT_SELECT_COLUMNS: &str = "
  i.id AS importId,
  i.provider AS provider,
  i.employee_id AS employeeId,
  e.name AS employeeName,
  e.cpf AS employeeCpf,
  c.id AS companyId,
  c.name AS companyName,
  cl.id AS clientId,
  cl.name AS clientName,
  i.period_start AS periodStart,
  i.period_end AS periodEnd,
  i.original_pdf_path AS originalPdfPath,
  sf.original_pdf_path AS sourceOriginalPdfPath,
  i.max_punches AS maxPunches,
  i.total_worked_minutes AS totalWorkedMinutes,
  i.overtime_minutes AS overtimeMinutes,
  i.absence_minutes AS absenceMinutes,
  i.late_minutes AS lateMinutes,
  i.regular_minutes AS regularMinutes,
  i.interval_minutes AS intervalMinutes,
  i.pending_count AS pendingCount,
  i.imported_at AS importedAt
";

const IMPORT_FROM_CLAUSE: &str = "
  FROM imports i
  JOIN employees e ON e.id = i.employee_id
  JOIN companies c ON c.id = i.company_id
  LEFT JOIN clients cl ON cl.id = i.client_id
  LEFT JOIN source_files sf ON sf.id = i.source_file_id
";

/// `STATUS_SQL_CONDITIONS`, in the same key order (the order of `PERIOD_STATUS_OPTIONS`).
const STATUS_SQL_CONDITIONS: [(&str, &str); 7] = [
    ("overtime", "i.overtime_minutes > 0"),
    ("absence", "i.absence_minutes > 0"),
    ("late", "i.late_minutes > 0"),
    ("regular", "i.regular_minutes > 0"),
    ("no-punch", "i.total_worked_minutes = 0"),
    ("pending", "i.pending_count > 0"),
    ("interval", "i.interval_minutes > 0"),
];

fn status_condition(id: &str) -> ApiResult<&'static str> {
    STATUS_SQL_CONDITIONS
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, condition)| *condition)
        .ok_or_else(|| ApiError::BadRequest(format!("Status desconhecido: {id}")))
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

async fn get_import_by_id(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    let row = sql::select_one(
        &state.db,
        &format!("SELECT {IMPORT_SELECT_COLUMNS} {IMPORT_FROM_CLAUSE} WHERE i.id = $1"),
        &params![args.id],
    )
    .await?;
    Ok(Json(row.map(Value::Object).unwrap_or(Value::Null)))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListImportsQuery {
    #[serde(default)]
    employee_ids: Vec<Value>,
    #[serde(default)]
    company_ids: Vec<Value>,
    #[serde(default)]
    client_ids: Vec<Value>,
    period_start: String,
    period_end: String,
    #[serde(default)]
    statuses: Vec<String>,
    #[serde(default)]
    page: Option<i64>,
    #[serde(default)]
    page_size: Option<i64>,
}

#[derive(Deserialize)]
struct QueryArgs<T> {
    query: T,
}

/// `importScopeConditions`: colaborador, empresa, cliente and the period overlap.
fn import_scope_conditions(query: &ListImportsQuery) -> (Vec<String>, Vec<Value>) {
    let mut conditions = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(c) = sql::in_clause("e.id", &query.employee_ids, &mut params) {
        conditions.push(c);
    }
    if let Some(c) = sql::in_clause("c.id", &query.company_ids, &mut params) {
        conditions.push(c);
    }
    if let Some(c) = sql::in_clause("cl.id", &query.client_ids, &mut params) {
        conditions.push(c);
    }
    params.push(json!(query.period_start));
    params.push(json!(query.period_end));
    conditions.push(format!("i.period_end >= ${} AND i.period_start <= ${}", params.len() - 1, params.len()));
    (conditions, params)
}

async fn count_imports_by_status(State(state): State<AppState>, Json(args): Json<QueryArgs<ListImportsQuery>>) -> ApiResult<Json<Value>> {
    let (conditions, params) = import_scope_conditions(&args.query);
    let sums = STATUS_SQL_CONDITIONS
        .iter()
        .enumerate()
        .map(|(index, (_, condition))| format!("COALESCE(SUM(CASE WHEN {condition} THEN 1 ELSE 0 END), 0) AS s{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let row = sql::select_one(&state.db, &format!("SELECT {sums} {IMPORT_FROM_CLAUSE} WHERE {}", conditions.join(" AND ")), &params).await?;
    let mut counts = Map::new();
    for (index, (id, _)) in STATUS_SQL_CONDITIONS.iter().enumerate() {
        let n = row.as_ref().and_then(|r| r.get(&format!("s{index}"))).cloned().unwrap_or(json!(0));
        counts.insert((*id).to_owned(), n);
    }
    Ok(Json(Value::Object(counts)))
}

async fn list_imports(State(state): State<AppState>, Json(args): Json<QueryArgs<ListImportsQuery>>) -> ApiResult<Json<Value>> {
    let query = args.query;
    if query.statuses.is_empty() {
        return Ok(Json(json!({ "rows": [], "total": 0 })));
    }
    let (mut conditions, params) = import_scope_conditions(&query);
    if query.statuses.len() < STATUS_SQL_CONDITIONS.len() {
        let parts = query.statuses.iter().map(|s| status_condition(s)).collect::<ApiResult<Vec<_>>>()?;
        conditions.push(format!("({})", parts.join(" OR ")));
    }
    let where_clause = format!("WHERE {}", conditions.join(" AND "));

    let total = sql::select_one(&state.db, &format!("SELECT COUNT(*) AS count {IMPORT_FROM_CLAUSE} {where_clause}"), &params)
        .await?
        .map(|r| row_i64(&r, "count"))
        .unwrap_or(0);

    let mut all_params = params.clone();
    let limit_clause = match (query.page, query.page_size) {
        (Some(page), Some(page_size)) => {
            let clause = format!("LIMIT ${} OFFSET ${}", params.len() + 1, params.len() + 2);
            all_params.push(json!(page_size));
            all_params.push(json!(page * page_size));
            clause
        }
        _ => String::new(),
    };
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT {IMPORT_SELECT_COLUMNS}
     {IMPORT_FROM_CLAUSE}
     {where_clause}
     ORDER BY i.imported_at DESC
     {limit_clause}"
        ),
        &all_params,
    )
    .await?;
    Ok(Json(json!({ "rows": rows, "total": total })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayRecordFilters {
    import_id: Option<Value>,
    company_id: Option<Value>,
    client_id: Option<Value>,
    period_start: Option<String>,
    period_end: Option<String>,
}

#[derive(Deserialize)]
struct DayRecordArgs {
    filters: DayRecordFilters,
}

/// Day records joined with their employee/company, punches attached.
async fn list_stored_day_records(State(state): State<AppState>, Json(args): Json<DayRecordArgs>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(stored_day_records(&state.db, &args.filters).await?))
}

async fn stored_day_records(pool: &SqlitePool, filters: &DayRecordFilters) -> ApiResult<Vec<Row>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    let mut push = |value: Value, column: &str| {
        params.push(value);
        conditions.push(format!("{column} ${}", params.len()));
    };
    if let Some(v) = filters.import_id.clone().filter(|v| !v.is_null()) {
        push(v, "i.id =");
    }
    if let Some(v) = filters.company_id.clone().filter(|v| !v.is_null()) {
        push(v, "c.id =");
    }
    if let Some(v) = filters.client_id.clone().filter(|v| !v.is_null()) {
        push(v, "cl.id =");
    }
    if let Some(v) = &filters.period_start {
        push(json!(v), "d.date >=");
    }
    if let Some(v) = &filters.period_end {
        push(json!(v), "d.date <=");
    }
    let where_clause = if conditions.is_empty() { String::new() } else { format!("WHERE {}", conditions.join(" AND ")) };

    let mut rows = sql::select(
        pool,
        &format!(
            "
    SELECT
      d.id AS dayRecordId,
      d.import_id AS importId,
      e.id AS employeeId,
      e.name AS employeeName,
      e.cpf AS employeeCpf,
      c.id AS companyId,
      c.name AS companyName,
      cl.id AS clientId,
      cl.name AS clientName,
      i.original_pdf_path AS originalPdfPath,
      d.date AS date,
      d.weekday AS weekday,
      d.total_worked_minutes AS totalWorkedMinutes,
      d.normal_hours_minutes AS normalHoursMinutes,
      d.absence_minutes AS absenceMinutes,
      d.observation AS observation
    FROM day_records d
    JOIN imports i ON i.id = d.import_id
    JOIN employees e ON e.id = i.employee_id
    JOIN companies c ON c.id = i.company_id
    LEFT JOIN clients cl ON cl.id = i.client_id
    {where_clause}
    ORDER BY e.name, d.date
    "
        ),
        &params,
    )
    .await?;
    if rows.is_empty() {
        return Ok(rows);
    }

    let day_record_ids: Vec<Value> = rows.iter().map(|r| r.get("dayRecordId").cloned().unwrap_or(Value::Null)).collect();
    let placeholders = (1..=day_record_ids.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
    let punch_rows = sql::select(
        pool,
        &format!(
            "SELECT day_record_id AS dayRecordId, punch_time AS punchTime, sequence_index AS sequenceIndex
     FROM punches WHERE day_record_id IN ({placeholders}) ORDER BY day_record_id, sequence_index"
        ),
        &day_record_ids,
    )
    .await?;

    let mut punches_by_day: std::collections::HashMap<i64, Vec<Value>> = std::collections::HashMap::new();
    for p in punch_rows {
        punches_by_day.entry(row_i64(&p, "dayRecordId")).or_default().push(p.get("punchTime").cloned().unwrap_or(Value::Null));
    }
    for row in &mut rows {
        let punches = punches_by_day.remove(&row_i64(row, "dayRecordId")).unwrap_or_default();
        row.insert("punches".into(), Value::Array(punches));
    }
    Ok(rows)
}

// --- duplicates / conflicts ------------------------------------------------------

#[derive(Deserialize)]
struct HashesArgs {
    hashes: Vec<String>,
}

/// `findDuplicateFiles`: hash → info, for the hashes whose file was already
/// *saved*. The frontend turns the object back into a `Map`.
async fn find_duplicate_files(State(state): State<AppState>, Json(args): Json<HashesArgs>) -> ApiResult<Json<Map<String, Value>>> {
    Ok(Json(duplicate_files(&state.db, &args.hashes).await?))
}

async fn duplicate_files(pool: &SqlitePool, hashes: &[String]) -> ApiResult<Map<String, Value>> {
    let mut by_hash = Map::new();
    if hashes.is_empty() {
        return Ok(by_hash);
    }
    let placeholders = (1..=hashes.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
    let hash_params: Vec<Value> = hashes.iter().map(|h| json!(h)).collect();
    let source_rows = sql::select(
        pool,
        &format!(
            "SELECT file_hash AS fileHash, file_name AS fileName, imported_at AS importedAt,
            page_count AS pageCount
     FROM source_files WHERE file_hash IN ({placeholders}) AND saved_at IS NOT NULL"
        ),
        &hash_params,
    )
    .await?;
    if source_rows.is_empty() {
        return Ok(by_hash);
    }

    let single_page_hashes: Vec<Value> =
        source_rows.iter().filter(|r| row_i64(r, "pageCount") == 1).filter_map(|r| r.get("fileHash").cloned()).collect();
    let mut employees_by_hash: Map<String, Value> = Map::new();
    if !single_page_hashes.is_empty() {
        let ph = (1..=single_page_hashes.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
        // The desktop joined `companies` on `e.company_id`, a column that no
        // longer exists since 0071/0072 (the query failed outright); the
        // empresa now comes from the import's own `company_id` snapshot.
        let emp_rows = sql::select(
            pool,
            &format!(
                "
      SELECT f.file_hash AS fileHash, i.id AS importId, e.name AS employeeName, c.name AS companyName
      FROM import_files f
      JOIN imports i ON i.import_file_id = f.id
      JOIN employees e ON e.id = i.employee_id
      JOIN companies c ON c.id = i.company_id
      WHERE f.file_hash IN ({ph})
      "
            ),
            &single_page_hashes,
        )
        .await?;
        for row in emp_rows {
            let hash = row.get("fileHash").and_then(Value::as_str).unwrap_or_default().to_owned();
            let entry = json!({ "importId": row.get("importId"), "employeeName": row.get("employeeName"), "companyName": row.get("companyName") });
            match employees_by_hash.entry(hash).or_insert_with(|| json!([])) {
                Value::Array(list) => list.push(entry),
                _ => unreachable!(),
            }
        }
    }

    for row in source_rows {
        let hash = row.get("fileHash").and_then(Value::as_str).unwrap_or_default().to_owned();
        let employees = employees_by_hash.get(&hash).cloned().unwrap_or(json!([]));
        by_hash.insert(
            hash,
            json!({
                "fileName": row.get("fileName"),
                "importedAt": row.get("importedAt"),
                "pageCount": row.get("pageCount"),
                "employees": employees,
            }),
        );
    }
    Ok(by_hash)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictingImportArgs {
    employee_cpf: String,
    client_id: i64,
    company_id: i64,
    period_start: String,
    period_end: String,
}

async fn conflicting_import(pool: &SqlitePool, args: &ConflictingImportArgs) -> ApiResult<Option<Row>> {
    sql::select_one(
        pool,
        "
    SELECT i.id AS importId, i.period_start AS periodStart, i.period_end AS periodEnd,
           i.imported_at AS importedAt
    FROM imports i
    JOIN employees e ON e.id = i.employee_id
    WHERE e.cpf = $1 AND i.client_id = $2 AND i.company_id = $3
      AND i.period_start <= $5 AND i.period_end >= $4
    ORDER BY i.imported_at DESC
    LIMIT 1
    ",
        &params![args.employee_cpf, args.client_id, args.company_id, args.period_start, args.period_end],
    )
    .await
}

async fn find_conflicting_import(State(state): State<AppState>, Json(args): Json<ConflictingImportArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(conflicting_import(&state.db, &args).await?.map(Value::Object).unwrap_or(Value::Null)))
}

#[derive(Deserialize)]
struct SheetEmployee {
    cpf: String,
}

#[derive(Deserialize)]
struct SheetPeriod {
    start: String,
    end: String,
}

/// The parts of a `ParsedTimesheet` the conflict check reads.
#[derive(Deserialize)]
struct ConflictSheet {
    employee: SheetEmployee,
    period: SheetPeriod,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindConflictsArgs {
    sheets: Vec<ConflictSheet>,
    client_id: i64,
    company_id: i64,
}

async fn find_conflicts(State(state): State<AppState>, Json(args): Json<FindConflictsArgs>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(conflicts(&state.db, &args).await?))
}

async fn conflicts(pool: &SqlitePool, args: &FindConflictsArgs) -> ApiResult<Vec<Value>> {
    let mut conflicts = Vec::new();
    for (i, sheet) in args.sheets.iter().enumerate() {
        let lookup = ConflictingImportArgs {
            employee_cpf: sheet.employee.cpf.clone(),
            client_id: args.client_id,
            company_id: args.company_id,
            period_start: sheet.period.start.clone(),
            period_end: sheet.period.end.clone(),
        };
        if let Some(existing) = conflicting_import(pool, &lookup).await? {
            conflicts.push(json!({
                "sheetIndex": i,
                "existingImportId": existing.get("importId"),
                "existingPeriodStart": existing.get("periodStart"),
                "existingPeriodEnd": existing.get("periodEnd"),
                "existingImportedAt": existing.get("importedAt"),
            }));
        }
    }
    Ok(conflicts)
}

// --- import history -------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportTypeArgs {
    import_type: String,
}

async fn count_import_files(State(state): State<AppState>, Json(args): Json<ImportTypeArgs>) -> ApiResult<Json<Value>> {
    let row = sql::select_one(
        &state.db,
        "SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN source_url IS NOT NULL THEN 1 ELSE 0 END), 0) AS link,
      COALESCE(SUM(CASE WHEN source_url IS NULL THEN 1 ELSE 0 END), 0) AS local,
      COALESCE(SUM(CASE WHEN status <> 'success' THEN 1 ELSE 0 END), 0) AS problems
    FROM source_files
    WHERE import_type = $1",
        &params![args.import_type],
    )
    .await?;
    Ok(Json(row.map(Value::Object).unwrap_or_else(|| json!({ "total": 0, "link": 0, "local": 0, "problems": 0 }))))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportFilesQuery {
    import_type: String,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    problems_only: Option<bool>,
    page: i64,
    page_size: i64,
}

async fn list_import_files(State(state): State<AppState>, Json(args): Json<QueryArgs<ImportFilesQuery>>) -> ApiResult<Json<Value>> {
    Ok(Json(import_files(&state.db, &args.query).await?))
}

async fn import_files(pool: &SqlitePool, query: &ImportFilesQuery) -> ApiResult<Value> {
    let mut conditions = vec!["sf.import_type = $1".to_owned()];
    let mut params: Vec<Value> = vec![json!(query.import_type)];

    if let Some(search) = query.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.push(json!(search));
        let n = params.len();
        conditions.push(format!("(LOWER(sf.file_name) LIKE '%' || LOWER(${n}) || '%' OR LOWER(sf.provider) LIKE '%' || LOWER(${n}) || '%')"));
    }
    match query.source.as_deref() {
        Some("link") => conditions.push("sf.source_url IS NOT NULL".into()),
        Some("local") => conditions.push("sf.source_url IS NULL".into()),
        _ => {}
    }
    if query.problems_only == Some(true) {
        conditions.push("sf.status <> 'success'".into());
    }
    let where_clause = format!("WHERE {}", conditions.join(" AND "));

    let total = sql::select_one(pool, &format!("SELECT COUNT(*) AS count FROM source_files sf {where_clause}"), &params)
        .await?
        .map(|r| row_i64(&r, "count"))
        .unwrap_or(0);

    let mut all_params = params.clone();
    all_params.push(json!(query.page_size));
    all_params.push(json!(query.page * query.page_size));
    let mut rows = sql::select(
        pool,
        &format!(
            "SELECT
      sf.id,
      sf.file_name AS fileName,
      sf.file_hash AS fileHash,
      sf.provider,
      sf.import_type AS importType,
      sf.status,
      sf.error_message AS errorMessage,
      sf.original_pdf_path AS originalPdfPath,
      sf.page_count AS pageCount,
      sf.imported_at AS importedAt,
      sf.saved_at AS savedAt,
      sf.source_url AS sourceUrl,
      COALESCE(sus.check_disabled, 0) AS checkDisabled
    FROM source_files sf
    LEFT JOIN source_url_settings sus ON sus.source_url = sf.source_url
    {where_clause}
    ORDER BY sf.imported_at DESC
    LIMIT ${} OFFSET ${}",
            params.len() + 1,
            params.len() + 2
        ),
        &all_params,
    )
    .await?;
    for row in &mut rows {
        let disabled = row.get("checkDisabled").is_some_and(|v| v.as_i64().unwrap_or(0) != 0 || v.as_bool() == Some(true));
        row.insert("checkDisabled".into(), Value::Bool(disabled));
    }
    Ok(json!({ "rows": rows, "total": total }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;
    use crate::domain::model::{Company, DayRecord, Employee, Period};

    async fn seed(pool: &SqlitePool) -> (i64, i64) {
        let company = sql::execute(pool, "INSERT INTO companies (name, cnpj) VALUES ('Acme', '11222333000181')", &[]).await.unwrap().last_insert_id;
        let client = sql::execute(pool, "INSERT INTO clients (name, cnpj) VALUES ('Cliente', '')", &[]).await.unwrap().last_insert_id;
        sql::execute(pool, "INSERT INTO client_companies (client_id, company_id) VALUES ($1, $2)", &params![client, company]).await.unwrap();
        (client, company)
    }

    fn day(date: &str, punches: &[&str]) -> DayRecord {
        DayRecord {
            date: date.into(),
            weekday: "Seg".into(),
            punches: punches.iter().map(|p| (*p).to_owned()).collect(),
            total_worked_minutes: 480,
            normal_hours_minutes: 480,
            absence_minutes: 0,
            observation: None,
        }
    }

    fn sheet(cpf: &str, hash: &str, start: &str, end: &str) -> ParsedTimesheet {
        ParsedTimesheet {
            provider: "coalize".into(),
            company: Company { name: "ACME".into(), cnpj: "".into() },
            employee: Employee { name: "MARIA DA SILVA".into(), cpf: cpf.into() },
            period: Period { start: start.into(), end: end.into() },
            days: vec![day(start, &["08:00", "12:00", "13:00", "17:00"]), day(end, &["08:00"])],
            original_pdf_path: format!("/data/imports/{hash}.pdf"),
            original_file_hash: hash.into(),
            original_file_name: format!("{hash}.pdf"),
        }
    }

    fn agg() -> TimesheetAggregates {
        TimesheetAggregates {
            max_punches: 4,
            total_worked_minutes: 960,
            overtime_minutes: 10,
            absence_minutes: 0,
            late_minutes: 5,
            regular_minutes: 960,
            interval_minutes: 60,
            pending_count: 1,
        }
    }

    fn args(sheet: ParsedTimesheet, client: i64, company: i64, replace: Option<i64>, source_file_id: Option<i64>) -> SaveParsedTimesheetArgs {
        SaveParsedTimesheetArgs { sheet, client_id: client, company_id: company, replace_import_id: replace, source_file_id, aggregates: agg() }
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    async fn save_writes_import_days_punches_and_links_the_employee() {
        let pool = test_pool().await;
        let (client, company) = seed(&pool).await;
        let id = save_timesheet(&pool, args(sheet("123.456.789-01", "h1", "2026-01-01", "2026-01-31"), client, company, None, None)).await.unwrap();

        let cpf: String = sqlx::query_scalar("SELECT cpf FROM employees").fetch_one(&pool).await.unwrap();
        assert_eq!(cpf, "12345678901", "cpf stored digits-only");
        assert_eq!(count(&pool, "employee_client_companies").await, 1);
        assert_eq!(count(&pool, "import_files").await, 1);
        assert_eq!(count(&pool, "day_records").await, 2);
        assert_eq!(count(&pool, "punches").await, 5);
        let seq: Vec<i64> = sqlx::query_scalar("SELECT sequence_index FROM punches ORDER BY id").fetch_all(&pool).await.unwrap();
        assert_eq!(seq, vec![0, 1, 2, 3, 0]);

        let row: (i64, i64, i64, i64) =
            sqlx::query_as("SELECT pending_count, late_minutes, interval_minutes, typeof(max_punches) = 'integer' FROM imports WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row, (1, 5, 60, 1));

        let rows = stored_day_records(&pool, &DayRecordFilters { import_id: Some(json!(id)), ..Default::default() }).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["punches"], json!(["08:00", "12:00", "13:00", "17:00"]));
        assert_eq!(rows[1]["punches"], json!(["08:00"]));
        assert_eq!(rows[0]["clientName"], json!("Cliente"));
    }

    #[tokio::test]
    async fn save_refuses_an_unlinked_client_company_pair_and_writes_nothing() {
        let pool = test_pool().await;
        let (client, _) = seed(&pool).await;
        let other = sql::execute(&pool, "INSERT INTO companies (name, cnpj) VALUES ('Outra', '1')", &[]).await.unwrap().last_insert_id;
        let err = save_timesheet(&pool, args(sheet("1", "h1", "2026-01-01", "2026-01-31"), client, other, None, None)).await.unwrap_err();
        assert_eq!(err.to_string(), "Esse cliente não está vinculado à empresa selecionada.");
        assert_eq!(count(&pool, "employees").await, 0);
        assert_eq!(count(&pool, "imports").await, 0);
    }

    #[tokio::test]
    async fn replace_import_id_swaps_the_old_import_and_reuses_employee_and_file() {
        let pool = test_pool().await;
        let (client, company) = seed(&pool).await;
        let first = save_timesheet(&pool, args(sheet("1", "h1", "2026-01-01", "2026-01-31"), client, company, None, None)).await.unwrap();

        let conflict_args = FindConflictsArgs {
            sheets: vec![
                ConflictSheet { employee: SheetEmployee { cpf: "1".into() }, period: SheetPeriod { start: "2026-01-15".into(), end: "2026-02-14".into() } },
                ConflictSheet { employee: SheetEmployee { cpf: "1".into() }, period: SheetPeriod { start: "2026-02-01".into(), end: "2026-02-28".into() } },
                ConflictSheet { employee: SheetEmployee { cpf: "2".into() }, period: SheetPeriod { start: "2026-01-01".into(), end: "2026-01-31".into() } },
            ],
            client_id: client,
            company_id: company,
        };
        let found = conflicts(&pool, &conflict_args).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["sheetIndex"], json!(0));
        assert_eq!(found[0]["existingImportId"], json!(first));
        assert_eq!(found[0]["existingPeriodEnd"], json!("2026-01-31"));
        // Another empresa of the same colaborador is not a conflict.
        let other = FindConflictsArgs { company_id: company + 100, ..conflict_args };
        assert!(conflicts(&pool, &other).await.unwrap().is_empty());

        let mut renamed = sheet("1", "h1", "2026-01-01", "2026-01-31");
        renamed.employee.name = "MARIA SOUZA".into();
        let source_file = sql::execute(&pool, "INSERT INTO source_files (file_name, file_hash, page_count) VALUES ('b.pdf', 'b', 3)", &[]).await.unwrap().last_insert_id;
        let second = save_timesheet(&pool, args(renamed, client, company, Some(first), Some(source_file))).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(count(&pool, "imports").await, 1);
        assert_eq!(count(&pool, "day_records").await, 2);
        assert_eq!(count(&pool, "punches").await, 5);
        assert_eq!(count(&pool, "employees").await, 1);
        assert_eq!(count(&pool, "import_files").await, 1);
        let name: String = sqlx::query_scalar("SELECT name FROM employees").fetch_one(&pool).await.unwrap();
        assert_eq!(name, "MARIA SOUZA");
        let source: Option<i64> = sqlx::query_scalar("SELECT source_file_id FROM imports").fetch_one(&pool).await.unwrap();
        assert_eq!(source, Some(source_file));
    }

    #[tokio::test]
    async fn duplicates_only_count_saved_files_and_name_single_page_employees() {
        let pool = test_pool().await;
        let (client, company) = seed(&pool).await;
        save_timesheet(&pool, args(sheet("1", "single", "2026-01-01", "2026-01-31"), client, company, None, None)).await.unwrap();
        for (hash, pages, saved) in [("single", 1, true), ("batch", 3, true), ("unsaved", 1, false)] {
            sql::execute(
                &pool,
                "INSERT INTO source_files (file_name, file_hash, page_count, saved_at) VALUES ($1, $1, $2, CASE WHEN $3 = 1 THEN datetime('now') END)",
                &params![hash, pages, if saved { 1 } else { 0 }],
            )
            .await
            .unwrap();
        }
        let found = duplicate_files(&pool, &["single".into(), "batch".into(), "unsaved".into(), "nope".into()]).await.unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found["single"]["employees"], json!([{ "importId": 1, "employeeName": "MARIA DA SILVA", "companyName": "Acme" }]));
        assert_eq!(found["batch"]["employees"], json!([]));
        assert_eq!(found["batch"]["pageCount"], json!(3));
        assert!(duplicate_files(&pool, &[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn import_history_filters_and_counts() {
        let pool = test_pool().await;
        for (hash, url, status) in [("a", None, "success"), ("b", Some("https://x/1"), "error"), ("c", None, "warning")] {
            sql::execute(
                &pool,
                "INSERT INTO source_files (file_name, file_hash, page_count, provider, import_type, status, source_url) VALUES ($1, $1, 1, 'Coalize', 'timesheet', $2, $3)",
                &params![format!("Espelho {hash}.pdf"), status, url],
            )
            .await
            .unwrap();
        }
        sql::execute(&pool, "INSERT INTO source_url_settings (source_url, check_disabled) VALUES ('https://x/1', 1)", &[]).await.unwrap();
        let query = |search: Option<&str>, source: Option<&str>, problems: bool| ImportFilesQuery {
            import_type: "timesheet".into(),
            search: search.map(Into::into),
            source: source.map(Into::into),
            problems_only: Some(problems),
            page: 0,
            page_size: 2,
        };
        let all = import_files(&pool, &query(None, None, false)).await.unwrap();
        assert_eq!(all["total"], json!(3));
        assert_eq!(all["rows"].as_array().unwrap().len(), 2);
        let linked = import_files(&pool, &query(None, Some("link"), false)).await.unwrap();
        assert_eq!(linked["rows"][0]["checkDisabled"], json!(true));
        assert_eq!(import_files(&pool, &query(None, Some("local"), true)).await.unwrap()["total"], json!(1));
        assert_eq!(import_files(&pool, &query(Some(" ESPELHO B "), None, false)).await.unwrap()["total"], json!(1));
        assert_eq!(import_files(&pool, &query(Some("coalize"), None, false)).await.unwrap()["total"], json!(3));
    }

    #[tokio::test]
    async fn list_imports_filters_by_scope_and_status() {
        let state = AppState::for_tests().await;
        let (client, company) = seed(&state.db).await;
        save_timesheet(&state.db, args(sheet("1", "h1", "2026-01-01", "2026-01-31"), client, company, None, None)).await.unwrap();
        let mut no_overtime = args(sheet("2", "h2", "2026-01-01", "2026-01-31"), client, company, None, None);
        no_overtime.aggregates.overtime_minutes = 0;
        save_timesheet(&state.db, no_overtime).await.unwrap();

        let list = |statuses: Vec<&str>, start: &str| ListImportsQuery {
            client_ids: vec![json!(client)],
            period_start: start.into(),
            period_end: "2026-12-31".into(),
            statuses: statuses.into_iter().map(Into::into).collect(),
            page: Some(0),
            page_size: Some(1),
            ..Default::default()
        };
        let all_statuses: Vec<&str> = STATUS_SQL_CONDITIONS.iter().map(|(id, _)| *id).collect();
        let Json(all) = list_imports(State(state.clone()), Json(QueryArgs { query: list(all_statuses, "2026-01-01") })).await.unwrap();
        assert_eq!(all["total"], json!(2));
        assert_eq!(all["rows"].as_array().unwrap().len(), 1);
        let Json(overtime) = list_imports(State(state.clone()), Json(QueryArgs { query: list(vec!["overtime"], "2026-01-01") })).await.unwrap();
        assert_eq!(overtime["total"], json!(1));
        let Json(none) = list_imports(State(state.clone()), Json(QueryArgs { query: list(vec![], "2026-01-01") })).await.unwrap();
        assert_eq!(none, json!({ "rows": [], "total": 0 }));
        let Json(later) = list_imports(State(state.clone()), Json(QueryArgs { query: list(vec!["overtime"], "2026-02-01") })).await.unwrap();
        assert_eq!(later["total"], json!(0));

        let Json(counts) = count_imports_by_status(State(state.clone()), Json(QueryArgs { query: list(vec![], "2026-01-01") })).await.unwrap();
        assert_eq!(counts, json!({ "overtime": 1, "absence": 0, "late": 2, "regular": 2, "no-punch": 0, "pending": 2, "interval": 2 }));

        let Json(one) = get_import_by_id(State(state.clone()), Json(IdArgs { id: 1 })).await.unwrap();
        assert_eq!(one["employeeCpf"], json!("1"));
        assert_eq!(one["sourceOriginalPdfPath"], Value::Null);
        let Json(missing) = get_import_by_id(State(state), Json(IdArgs { id: 99 })).await.unwrap();
        assert_eq!(missing, Value::Null);
    }
}
