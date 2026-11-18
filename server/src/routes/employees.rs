//! Colaboradores (db.ts: listEmployeesGlobal … createEmployeesFromImport),
//! including their PIX keys, apelidos, identifier matching and the
//! employee-import templates.
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.

use std::collections::HashMap;
use std::sync::LazyLock;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};
use crate::sql::{self, BatchStatement, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listEmployeesGlobal", post(list_employees_global))
        .route("/rpc/getEmployeesByIds", post(get_employees_by_ids))
        .route("/rpc/createEmployeeManual", post(create_employee_manual))
        .route("/rpc/getEmployee", post(get_employee))
        .route("/rpc/linkEmployeeToClientCompany", post(link_employee_to_client_company))
        .route("/rpc/updateEmployeeClientCompanyMatricula", post(update_employee_client_company_matricula))
        .route("/rpc/unlinkEmployeeClientCompany", post(unlink_employee_client_company))
        .route("/rpc/updateEmployee", post(update_employee))
        .route("/rpc/getEmployeeDeletionImpact", post(get_employee_deletion_impact))
        .route("/rpc/deleteEmployee", post(delete_employee))
        .route("/rpc/reassignEmployeeHistoryToClientCompany", post(reassign_employee_history))
        .route("/rpc/listEmployeePixKeys", post(list_employee_pix_keys))
        .route("/rpc/addEmployeePixKey", post(add_employee_pix_key))
        .route("/rpc/updateEmployeePixKeyType", post(update_employee_pix_key_type))
        .route("/rpc/removeEmployeePixKey", post(remove_employee_pix_key))
        .route("/rpc/listEmployeeAliases", post(list_employee_aliases))
        .route("/rpc/findEmployeeAliasOwner", post(find_employee_alias_owner))
        .route("/rpc/addEmployeeAlias", post(add_employee_alias))
        .route("/rpc/removeEmployeeAlias", post(remove_employee_alias))
        .route("/rpc/findEmployeeByAttempts", post(find_employee_by_attempts))
        .route("/rpc/findEmployeeAnywhereByAttempts", post(find_employee_anywhere_by_attempts))
        .route("/rpc/listEmployeeTemplates", post(list_employee_templates))
        .route("/rpc/getEmployeeTemplate", post(get_employee_template))
        .route("/rpc/createEmployeeTemplate", post(create_employee_template))
        .route("/rpc/updateEmployeeTemplate", post(update_employee_template))
        .route("/rpc/deleteEmployeeTemplate", post(delete_employee_template))
        .route("/rpc/createEmployeesFromImport", post(create_employees_from_import))
}

// --- shared helpers -----------------------------------------------------------

/// `HEAD_SHIFT_CONDITION` from db.ts: the current (head, not soft-deleted)
/// row of a shift chain.
const HEAD_SHIFT_CONDITION: &str =
    "ps.id NOT IN (SELECT previous_shift_id FROM payment_shifts WHERE previous_shift_id IS NOT NULL) AND ps.deleted_at IS NULL";

const NOT_LINKED: &str = "Esse cliente não está vinculado à empresa selecionada.";
const CPF_TAKEN: &str = "Já existe um colaborador com esse CPF.";

/// `normalizeCpf` from format.ts: digits only.
fn normalize_cpf(cpf: &str) -> String {
    cpf.chars().filter(char::is_ascii_digit).collect()
}

/// `matricula?.trim() || null`.
fn trimmed_or_null(value: Option<&str>) -> Value {
    match value.map(str::trim) {
        Some(v) if !v.is_empty() => Value::from(v),
        _ => Value::Null,
    }
}

fn id_of(row: &Row) -> Option<i64> {
    row.get("id").and_then(Value::as_i64)
}

/// `markSourceFilesSavedStatements` from db.ts.
fn mark_source_files_saved_statements(file_hashes: &[String]) -> Vec<BatchStatement> {
    file_hashes
        .iter()
        .map(|hash| BatchStatement::new("UPDATE source_files SET saved_at = datetime('now') WHERE file_hash = $1", params![hash]))
        .collect()
}

/// `detectPixKeyType` from pix.ts — best-effort classification only; the
/// employee screen always lets the user correct it.
pub(crate) fn detect_pix_key_type(raw: &str) -> &'static str {
    static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap());
    static RANDOM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").unwrap());
    let value = raw.trim();
    if EMAIL.is_match(value) {
        return "email";
    }
    if RANDOM.is_match(value) {
        return "random";
    }
    let digits: Vec<u32> = value.chars().filter_map(|c| if c.is_ascii_digit() { c.to_digit(10) } else { None }).collect();
    if !value.starts_with('+') && has_valid_cpf_check_digits(&digits) {
        return "cpf";
    }
    if has_valid_cnpj_check_digits(&digits) {
        return "cnpj";
    }
    let starts_with_55 = digits.len() >= 2 && digits[0] == 5 && digits[1] == 5;
    if digits.len() == 10 || digits.len() == 11 || ((digits.len() == 12 || digits.len() == 13) && starts_with_55) {
        return "phone";
    }
    "other"
}

fn all_same(digits: &[u32]) -> bool {
    digits.iter().all(|&d| d == digits[0])
}

fn has_valid_cpf_check_digits(digits: &[u32]) -> bool {
    if digits.len() != 11 || all_same(digits) {
        return false;
    }
    let digit = |length: usize| {
        let sum: u32 = digits[..length].iter().enumerate().map(|(i, &d)| d * (length as u32 + 1 - i as u32)).sum();
        let remainder = (sum * 10) % 11;
        if remainder == 10 { 0 } else { remainder }
    };
    digit(9) == digits[9] && digit(10) == digits[10]
}

fn has_valid_cnpj_check_digits(digits: &[u32]) -> bool {
    if digits.len() != 14 || all_same(digits) {
        return false;
    }
    let calculate = |base: &[u32], weights: &[u32]| {
        let sum: u32 = base.iter().zip(weights).map(|(d, w)| d * w).sum();
        let remainder = sum % 11;
        if remainder < 2 { 0 } else { 11 - remainder }
    };
    let first = calculate(&digits[..12], &[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    let mut base: Vec<u32> = digits[..12].to_vec();
    base.push(first);
    let second = calculate(&base, &[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    first == digits[12] && second == digits[13]
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmployeeIdArgs {
    employee_id: i64,
}

// --- employees ------------------------------------------------------------------

/// `hydrateEmployeeRows`: full `EmployeeRow`s (with every (cliente, empresa)
/// link) for a batch of ids, in two queries. Order is NOT guaranteed to match
/// `employee_ids`.
async fn hydrate_employee_rows(db: &SqlitePool, employee_ids: &[i64]) -> ApiResult<Vec<Value>> {
    if employee_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=employee_ids.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
    let params: Vec<Value> = employee_ids.iter().map(|&id| Value::from(id)).collect();
    let base = sql::select(db, &format!("SELECT e.id, e.name, e.cpf FROM employees e WHERE e.id IN ({placeholders})"), &params).await?;
    let link_rows = sql::select(
        db,
        &format!(
            "SELECT ecc.employee_id AS employeeId, cl.id AS clientId, cl.name AS clientName,
            c.id AS companyId, c.name AS companyName, ecc.matricula
     FROM employee_client_companies ecc
     JOIN clients cl ON cl.id = ecc.client_id
     JOIN companies c ON c.id = ecc.company_id
     WHERE ecc.employee_id IN ({placeholders})
     ORDER BY cl.name, c.name"
        ),
        &params,
    )
    .await?;
    let mut links_by_employee: HashMap<i64, Vec<Value>> = HashMap::new();
    for mut row in link_rows {
        let employee_id = row.shift_remove("employeeId").and_then(|v| v.as_i64()).unwrap_or_default();
        links_by_employee.entry(employee_id).or_default().push(Value::Object(row));
    }
    Ok(base
        .into_iter()
        .map(|mut e| {
            let links = id_of(&e).and_then(|id| links_by_employee.remove(&id)).unwrap_or_default();
            e.insert("links".into(), Value::Array(links));
            Value::Object(e)
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmployeesGlobalQuery {
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    company_ids: Vec<i64>,
    #[serde(default)]
    client_ids: Vec<i64>,
    page: i64,
    page_size: i64,
}

#[derive(Deserialize)]
struct ListEmployeesGlobalArgs {
    query: EmployeesGlobalQuery,
}

/// `/^[\d.\s-]+$/` — a search made only of digits and CPF punctuation.
fn looks_like_cpf(search: &str) -> bool {
    !search.is_empty() && search.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c.is_whitespace())
}

/// The Colaboradores directory: filtered and paginated in SQL; `total` counts
/// matching colaboradores before pagination.
async fn list_employees_global_in(db: &SqlitePool, query: &EmployeesGlobalQuery) -> ApiResult<Value> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    let search = query.search.as_deref().map(str::trim).unwrap_or_default();
    if !search.is_empty() {
        params.push(Value::from(search));
        let by_name = format!(
            "{} LIKE '%' || {} || '%'",
            sql::fold_accents_sql("e.name"),
            sql::fold_accents_sql(&format!("${}", params.len()))
        );
        let cpf_digits = if looks_like_cpf(search) { normalize_cpf(search) } else { String::new() };
        if cpf_digits.len() >= 3 {
            params.push(Value::from(cpf_digits));
            conditions.push(format!("({by_name} OR REPLACE(REPLACE(e.cpf, '.', ''), '-', '') LIKE '%' || ${} || '%')", params.len()));
        } else {
            conditions.push(by_name);
        }
    }
    let company_ids: Vec<Value> = query.company_ids.iter().map(|&id| Value::from(id)).collect();
    if let Some(clause) = sql::in_clause("ecc_company.company_id", &company_ids, &mut params) {
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM employee_client_companies ecc_company WHERE ecc_company.employee_id = e.id AND {clause})"
        ));
    }
    let client_ids: Vec<Value> = query.client_ids.iter().map(|&id| Value::from(id)).collect();
    if let Some(clause) = sql::in_clause("ecc_client.client_id", &client_ids, &mut params) {
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM employee_client_companies ecc_client WHERE ecc_client.employee_id = e.id AND {clause})"
        ));
    }

    let where_clause = if conditions.is_empty() { String::new() } else { format!("WHERE {}", conditions.join(" AND ")) };
    let from = "FROM employees e";

    let count = sql::select_one(db, &format!("SELECT COUNT(*) AS count {from} {where_clause}"), &params).await?;
    let total = count.and_then(|r| r.get("count").and_then(Value::as_i64)).unwrap_or(0);

    let mut page_params = params.clone();
    page_params.push(Value::from(query.page_size));
    page_params.push(Value::from(query.page * query.page_size));
    let id_rows = sql::select(
        db,
        &format!(
            "SELECT e.id
     {from}
     {where_clause}
     ORDER BY e.name
     LIMIT ${} OFFSET ${}",
            params.len() + 1,
            params.len() + 2
        ),
        &page_params,
    )
    .await?;
    let ids: Vec<i64> = id_rows.iter().filter_map(id_of).collect();
    let mut hydrated: HashMap<i64, Value> = hydrate_employee_rows(db, &ids)
        .await?
        .into_iter()
        .filter_map(|row| row.get("id").and_then(Value::as_i64).map(|id| (id, row)))
        .collect();
    let rows: Vec<Value> = ids.iter().filter_map(|id| hydrated.remove(id)).collect();
    Ok(json!({ "rows": rows, "total": total }))
}

async fn list_employees_global(State(state): State<AppState>, Json(args): Json<ListEmployeesGlobalArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(list_employees_global_in(&state.db, &args.query).await?))
}

#[derive(Deserialize)]
struct IdsArgs {
    ids: Vec<i64>,
}

async fn get_employees_by_ids(State(state): State<AppState>, Json(args): Json<IdsArgs>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(hydrate_employee_rows(&state.db, &args.ids).await?))
}

async fn get_employee_in(db: &SqlitePool, id: i64) -> ApiResult<Value> {
    hydrate_employee_rows(db, &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::NotFound("Colaborador não encontrado.".into()))
}

async fn get_employee(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(get_employee_in(&state.db, args.id).await?))
}

async fn ensure_client_company_link(db: &SqlitePool, client_id: i64, company_id: i64) -> ApiResult<()> {
    let link = sql::select(
        db,
        "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
        &params![client_id, company_id],
    )
    .await?;
    if link.is_empty() {
        return Err(ApiError::BadRequest(NOT_LINKED.into()));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateEmployeeManualArgs {
    client_id: i64,
    company_id: i64,
    name: String,
    cpf: String,
    #[serde(default)]
    matricula: Option<String>,
}

async fn create_employee_manual_in(db: &SqlitePool, args: &CreateEmployeeManualArgs) -> ApiResult<i64> {
    let normalized_cpf = normalize_cpf(&args.cpf);
    if normalized_cpf.len() != 11 {
        return Err(ApiError::BadRequest("CPF deve ter 11 dígitos.".into()));
    }
    ensure_client_company_link(db, args.client_id, args.company_id).await?;
    let existing = sql::select(db, "SELECT id FROM employees WHERE cpf = $1", &params![normalized_cpf]).await?;
    if !existing.is_empty() {
        return Err(ApiError::Conflict(CPF_TAKEN.into()));
    }
    let result = sql::execute(db, "INSERT INTO employees (name, cpf) VALUES ($1, $2)", &params![args.name.trim(), normalized_cpf]).await?;
    let employee_id = result.last_insert_id;
    link_employee_in(db, employee_id, args.client_id, args.company_id, args.matricula.as_deref()).await?;
    Ok(employee_id)
}

async fn create_employee_manual(State(state): State<AppState>, Json(args): Json<CreateEmployeeManualArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_employee_manual_in(&state.db, &args).await?))
}

/// Creates the link, or just updates its matrícula when it already exists.
async fn link_employee_in(db: &SqlitePool, employee_id: i64, client_id: i64, company_id: i64, matricula: Option<&str>) -> ApiResult<()> {
    ensure_client_company_link(db, client_id, company_id).await?;
    sql::execute(
        db,
        "INSERT INTO employee_client_companies (employee_id, client_id, company_id, matricula) VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, client_id, company_id) DO UPDATE SET matricula = excluded.matricula",
        &[Value::from(employee_id), Value::from(client_id), Value::from(company_id), trimmed_or_null(matricula)],
    )
    .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmployeeLinkArgs {
    employee_id: i64,
    client_id: i64,
    company_id: i64,
    #[serde(default)]
    matricula: Option<String>,
}

async fn link_employee_to_client_company(State(state): State<AppState>, Json(args): Json<EmployeeLinkArgs>) -> ApiResult<StatusCode> {
    link_employee_in(&state.db, args.employee_id, args.client_id, args.company_id, args.matricula.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_employee_client_company_matricula(State(state): State<AppState>, Json(args): Json<EmployeeLinkArgs>) -> ApiResult<StatusCode> {
    sql::execute(
        &state.db,
        "UPDATE employee_client_companies SET matricula = $1 WHERE employee_id = $2 AND client_id = $3 AND company_id = $4",
        &[trimmed_or_null(args.matricula.as_deref()), Value::from(args.employee_id), Value::from(args.client_id), Value::from(args.company_id)],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Refuses to drop the last link: a colaborador with none can't be resolved
/// by any future import.
async fn unlink_employee_in(db: &SqlitePool, employee_id: i64, client_id: i64, company_id: i64) -> ApiResult<()> {
    let count = sql::select_one(db, "SELECT COUNT(*) AS n FROM employee_client_companies WHERE employee_id = $1", &params![employee_id]).await?;
    if count.and_then(|r| r.get("n").and_then(Value::as_i64)).unwrap_or(0) <= 1 {
        return Err(ApiError::BadRequest("O colaborador precisa estar vinculado a pelo menos um cliente/empresa.".into()));
    }
    sql::execute(
        db,
        "DELETE FROM employee_client_companies WHERE employee_id = $1 AND client_id = $2 AND company_id = $3",
        &params![employee_id, client_id, company_id],
    )
    .await?;
    Ok(())
}

async fn unlink_employee_client_company(State(state): State<AppState>, Json(args): Json<EmployeeLinkArgs>) -> ApiResult<StatusCode> {
    unlink_employee_in(&state.db, args.employee_id, args.client_id, args.company_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateEmployeeArgs {
    id: i64,
    name: String,
    cpf: String,
}

async fn update_employee_in(db: &SqlitePool, args: &UpdateEmployeeArgs) -> ApiResult<()> {
    let normalized_cpf = normalize_cpf(&args.cpf);
    if normalized_cpf.len() != 11 {
        return Err(ApiError::BadRequest("CPF deve ter 11 dígitos.".into()));
    }
    let current = sql::select(db, "SELECT id FROM employees WHERE id = $1", &params![args.id]).await?;
    if current.is_empty() {
        return Err(ApiError::NotFound("Colaborador não encontrado.".into()));
    }
    let existing = sql::select(db, "SELECT id FROM employees WHERE cpf = $1 AND id != $2", &params![normalized_cpf, args.id]).await?;
    if !existing.is_empty() {
        return Err(ApiError::Conflict(CPF_TAKEN.into()));
    }
    sql::execute(db, "UPDATE employees SET name = $1, cpf = $2 WHERE id = $3", &params![args.name.trim(), normalized_cpf, args.id]).await?;
    Ok(())
}

async fn update_employee(State(state): State<AppState>, Json(args): Json<UpdateEmployeeArgs>) -> ApiResult<StatusCode> {
    update_employee_in(&state.db, &args).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What `deleteEmployee` would erase.
async fn deletion_impact(db: &SqlitePool, employee_id: i64) -> ApiResult<Row> {
    let sql_text = format!(
        "SELECT
       (SELECT COUNT(*) FROM payment_shifts WHERE employee_id = $1 AND status = 'pago') AS paymentRecords,
       (SELECT COUNT(*) FROM payment_shifts ps WHERE ps.employee_id = $1 AND {HEAD_SHIFT_CONDITION}) AS shifts,
       (SELECT COUNT(*) FROM payment_shifts ps WHERE ps.employee_id = $1 AND ps.status = 'pago' AND {HEAD_SHIFT_CONDITION}) AS paidShifts,
       (SELECT COALESCE(SUM(ps.amount), 0) FROM payment_shifts ps WHERE ps.employee_id = $1 AND ps.status = 'pago' AND {HEAD_SHIFT_CONDITION}) AS paidAmount,
       (SELECT COUNT(*) FROM imports WHERE employee_id = $1) AS timesheets,
       (SELECT COUNT(*) FROM employee_pix_keys WHERE employee_id = $1) AS pixKeys"
    );
    Ok(sql::select_one(db, &sql_text, &params![employee_id]).await?.unwrap_or_default())
}

async fn get_employee_deletion_impact(State(state): State<AppState>, Json(args): Json<EmployeeIdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(deletion_impact(&state.db, args.employee_id).await?)))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DeleteEmployeeOptions {
    #[serde(default)]
    allow_paid: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteEmployeeArgs {
    employee_id: i64,
    #[serde(default)]
    options: DeleteEmployeeOptions,
}

/// Hard delete of the colaborador and everything tied to them — refused for
/// one with any paid shift in their history unless `allow_paid`.
async fn delete_employee_in(db: &SqlitePool, employee_id: i64, allow_paid: bool) -> ApiResult<()> {
    if !allow_paid {
        let impact = deletion_impact(db, employee_id).await?;
        let payment_records = impact.get("paymentRecords").and_then(Value::as_i64).unwrap_or(0);
        if payment_records > 0 {
            let noun = if payment_records == 1 { "registro de pagamento" } else { "registros de pagamento" };
            return Err(ApiError::Conflict(format!(
                "Este colaborador tem {payment_records} {noun} no histórico e não pode ser excluído sem confirmação — isso apagaria pagamentos já feitos."
            )));
        }
    }
    let p = params![employee_id];
    sql::run_batch(
        db,
        vec![
            BatchStatement::new(
                "DELETE FROM punches WHERE day_record_id IN (
       SELECT id FROM day_records WHERE import_id IN (SELECT id FROM imports WHERE employee_id = $1)
     )",
                p.clone(),
            ),
            BatchStatement::new("DELETE FROM day_records WHERE import_id IN (SELECT id FROM imports WHERE employee_id = $1)", p.clone()),
            BatchStatement::new("DELETE FROM imports WHERE employee_id = $1", p.clone()),
            BatchStatement::new("DELETE FROM payment_shifts WHERE employee_id = $1", p.clone()),
            BatchStatement::new("DELETE FROM employee_aliases WHERE employee_id = $1", p.clone()),
            BatchStatement::new("DELETE FROM employee_pix_keys WHERE employee_id = $1", p.clone()),
            BatchStatement::new("DELETE FROM employee_client_companies WHERE employee_id = $1", p.clone()),
            BatchStatement::new("DELETE FROM employees WHERE id = $1", p),
        ],
    )
    .await?;
    Ok(())
}

async fn delete_employee(State(state): State<AppState>, Json(args): Json<DeleteEmployeeArgs>) -> ApiResult<StatusCode> {
    delete_employee_in(&state.db, args.employee_id, args.options.allow_paid).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReassignArgs {
    employee_id: i64,
    new_client_id: i64,
    new_company_id: i64,
    #[serde(default)]
    period_start: Option<String>,
    #[serde(default)]
    period_end: Option<String>,
}

/// Opt-in rewrite of the snapshotted cliente/empresa on the colaborador's
/// already-imported shifts and cartões; the optional period scopes it
/// (shifts by `work_date`, imports by any overlap with the window).
async fn reassign_history_in(db: &SqlitePool, args: &ReassignArgs) -> ApiResult<()> {
    let period_start = args.period_start.as_deref().filter(|s| !s.is_empty());
    let period_end = args.period_end.as_deref().filter(|s| !s.is_empty());

    let mut shift_conditions = vec!["employee_id = $3".to_owned()];
    let mut shift_params = params![args.new_client_id, args.new_company_id, args.employee_id];
    if let Some(start) = period_start {
        shift_params.push(Value::from(start));
        shift_conditions.push(format!("work_date >= ${}", shift_params.len()));
    }
    if let Some(end) = period_end {
        shift_params.push(Value::from(end));
        shift_conditions.push(format!("work_date <= ${}", shift_params.len()));
    }

    let mut import_conditions = vec!["employee_id = $3".to_owned()];
    let mut import_params = params![args.new_client_id, args.new_company_id, args.employee_id];
    if let Some(end) = period_end {
        import_params.push(Value::from(end));
        import_conditions.push(format!("period_start <= ${}", import_params.len()));
    }
    if let Some(start) = period_start {
        import_params.push(Value::from(start));
        import_conditions.push(format!("period_end >= ${}", import_params.len()));
    }
    sql::run_batch(
        db,
        vec![
            BatchStatement::new(
                format!("UPDATE payment_shifts SET client_id = $1, company_id = $2 WHERE {}", shift_conditions.join(" AND ")),
                shift_params,
            ),
            BatchStatement::new(
                format!("UPDATE imports SET client_id = $1, company_id = $2 WHERE {}", import_conditions.join(" AND ")),
                import_params,
            ),
        ],
    )
    .await?;
    Ok(())
}

async fn reassign_employee_history(State(state): State<AppState>, Json(args): Json<ReassignArgs>) -> ApiResult<StatusCode> {
    reassign_history_in(&state.db, &args).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- PIX keys -------------------------------------------------------------------

const UPSERT_PIX_KEY: &str = "INSERT INTO employee_pix_keys (employee_id, key_value, key_type) VALUES ($1, $2, $3)
     ON CONFLICT(employee_id, key_value) DO UPDATE SET key_type = excluded.key_type";

async fn list_employee_pix_keys(State(state): State<AppState>, Json(args): Json<EmployeeIdArgs>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(
        sql::select(
            &state.db,
            "SELECT id, employee_id AS employeeId, key_value AS keyValue, key_type AS keyType
     FROM employee_pix_keys WHERE employee_id = $1 ORDER BY id",
            &params![args.employee_id],
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddPixKeyArgs {
    employee_id: i64,
    raw_value: String,
    #[serde(default)]
    key_type: Option<String>,
}

async fn add_pix_key_in(db: &SqlitePool, employee_id: i64, raw_value: &str, key_type: Option<&str>) -> ApiResult<()> {
    let key_value = raw_value.trim();
    if key_value.is_empty() {
        return Err(ApiError::BadRequest("Informe uma chave PIX.".into()));
    }
    let key_type = key_type.unwrap_or_else(|| detect_pix_key_type(key_value));
    sql::execute(db, UPSERT_PIX_KEY, &params![employee_id, key_value, key_type]).await?;
    Ok(())
}

async fn add_employee_pix_key(State(state): State<AppState>, Json(args): Json<AddPixKeyArgs>) -> ApiResult<StatusCode> {
    add_pix_key_in(&state.db, args.employee_id, &args.raw_value, args.key_type.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PixKeyTypeArgs {
    id: i64,
    key_type: String,
}

async fn update_employee_pix_key_type(State(state): State<AppState>, Json(args): Json<PixKeyTypeArgs>) -> ApiResult<StatusCode> {
    sql::execute(&state.db, "UPDATE employee_pix_keys SET key_type = $1 WHERE id = $2", &params![args.key_type, args.id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_employee_pix_key(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    sql::execute(&state.db, "DELETE FROM employee_pix_keys WHERE id = $1", &params![args.id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- apelidos -------------------------------------------------------------------

async fn list_employee_aliases(State(state): State<AppState>, Json(args): Json<EmployeeIdArgs>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(
        sql::select(
            &state.db,
            "SELECT id, employee_id AS employeeId, alias FROM employee_aliases WHERE employee_id = $1 ORDER BY id DESC",
            &params![args.employee_id],
        )
        .await?,
    ))
}

/// Whether `alias` belongs to another colaborador sharing at least one
/// (cliente, empresa) pair with `employee_id` — only there could it cause a
/// wrong match.
async fn employee_alias_owner(db: &SqlitePool, employee_id: i64, alias: &str) -> ApiResult<Option<Row>> {
    sql::select_one(
        db,
        "SELECT DISTINCT e.id, e.name
     FROM employee_aliases ea
     JOIN employees e ON e.id = ea.employee_id
     WHERE lower(ea.alias) = lower($1)
       AND e.id != $2
       AND EXISTS (
         SELECT 1 FROM employee_client_companies mine
         JOIN employee_client_companies theirs
           ON theirs.client_id = mine.client_id AND theirs.company_id = mine.company_id
         WHERE mine.employee_id = $2 AND theirs.employee_id = e.id
       )",
        &params![alias.trim(), employee_id],
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmployeeAliasArgs {
    employee_id: i64,
    alias: String,
}

async fn find_employee_alias_owner(State(state): State<AppState>, Json(args): Json<EmployeeAliasArgs>) -> ApiResult<Json<Option<Row>>> {
    Ok(Json(employee_alias_owner(&state.db, args.employee_id, &args.alias).await?))
}

async fn add_employee_alias_in(db: &SqlitePool, employee_id: i64, alias: &str) -> ApiResult<()> {
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        return Err(ApiError::BadRequest("Nome não pode ser vazio.".into()));
    }
    let employee = sql::select(db, "SELECT id FROM employees WHERE id = $1", &params![employee_id]).await?;
    if employee.is_empty() {
        return Err(ApiError::NotFound("Colaborador não encontrado.".into()));
    }
    if let Some(owner) = employee_alias_owner(db, employee_id, trimmed).await? {
        let name = owner.get("name").and_then(Value::as_str).unwrap_or_default();
        return Err(ApiError::Conflict(format!("Esse nome já está vinculado a {name}.")));
    }
    let already_mine = sql::select(
        db,
        "SELECT id FROM employee_aliases WHERE employee_id = $1 AND lower(alias) = lower($2)",
        &params![employee_id, trimmed],
    )
    .await?;
    if !already_mine.is_empty() {
        return Ok(());
    }
    sql::execute(db, "INSERT INTO employee_aliases (employee_id, alias) VALUES ($1, $2)", &params![employee_id, trimmed]).await?;
    Ok(())
}

async fn add_employee_alias(State(state): State<AppState>, Json(args): Json<EmployeeAliasArgs>) -> ApiResult<StatusCode> {
    add_employee_alias_in(&state.db, args.employee_id, &args.alias).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AliasIdArgs {
    alias_id: i64,
}

async fn remove_employee_alias(State(state): State<AppState>, Json(args): Json<AliasIdArgs>) -> ApiResult<StatusCode> {
    sql::execute(&state.db, "DELETE FROM employee_aliases WHERE id = $1", &params![args.alias_id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- identifier matching ----------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct IdentifierAttempt {
    fields: Vec<String>,
    #[serde(default)]
    case_insensitive: bool,
}

#[derive(Deserialize, Debug, Default, Clone)]
struct IdentifierValues {
    #[serde(default)]
    cpf: Option<String>,
    #[serde(default)]
    matricula: Option<String>,
    #[serde(default)]
    nome: Option<String>,
}

/// How a matrícula condition is scoped: one specific pair already joined as
/// `ecc`, or any of the employee's pairs.
#[derive(Clone, Copy)]
enum MatriculaScope {
    JoinedPair,
    AnyPair,
}

impl MatriculaScope {
    fn condition(self, placeholder: &str, case_insensitive: bool) -> String {
        let cmp = if case_insensitive {
            format!("lower(ecc.matricula) = lower({placeholder})")
        } else {
            format!("ecc.matricula = {placeholder}")
        };
        match self {
            MatriculaScope::JoinedPair => cmp,
            MatriculaScope::AnyPair => format!("EXISTS (SELECT 1 FROM employee_client_companies ecc WHERE ecc.employee_id = e.id AND {cmp})"),
        }
    }
}

/// `findEmployeeIdByAttempts`: tries each tentativa in order — every field
/// of one tentativa must match the same employee (AND); the first tentativa
/// that finds someone wins. A tentativa missing a raw value is skipped.
async fn find_employee_id_by_attempts(
    db: &SqlitePool,
    base_select: &str,
    base_params: &[Value],
    attempts: &[IdentifierAttempt],
    values: &IdentifierValues,
    scope: MatriculaScope,
) -> ApiResult<Option<i64>> {
    'attempts: for attempt in attempts {
        if attempt.fields.is_empty() {
            continue;
        }
        let mut conditions: Vec<String> = Vec::new();
        let mut params: Vec<Value> = base_params.to_vec();

        for field in &attempt.fields {
            if field == "cpf" {
                // Always digit-normalized — case doesn't apply.
                let normalized = values.cpf.as_deref().map(normalize_cpf).unwrap_or_default();
                if normalized.len() != 11 {
                    continue 'attempts;
                }
                params.push(Value::from(normalized));
                conditions.push(format!("e.cpf = ${}", params.len()));
            } else if field == "matricula" {
                let trimmed = values.matricula.as_deref().map(str::trim).unwrap_or_default();
                if trimmed.is_empty() {
                    continue 'attempts;
                }
                params.push(Value::from(trimmed));
                conditions.push(scope.condition(&format!("${}", params.len()), attempt.case_insensitive));
            } else {
                let trimmed = values.nome.as_deref().map(str::trim).unwrap_or_default();
                if trimmed.is_empty() {
                    continue 'attempts;
                }
                // The colaborador's own name, or any of their apelidos.
                params.push(Value::from(trimmed));
                let name_param = params.len();
                params.push(Value::from(trimmed));
                let alias_param = params.len();
                let (name_cmp, alias_cmp) = if attempt.case_insensitive {
                    (format!("lower(e.name) = lower(${name_param})"), format!("lower(ea.alias) = lower(${alias_param})"))
                } else {
                    (format!("e.name = ${name_param}"), format!("ea.alias = ${alias_param}"))
                };
                conditions.push(format!(
                    "({name_cmp} OR EXISTS (SELECT 1 FROM employee_aliases ea WHERE ea.employee_id = e.id AND {alias_cmp}))"
                ));
            }
        }

        let rows = sql::select(db, &format!("{base_select} AND {}", conditions.join(" AND ")), &params).await?;
        if let Some(id) = rows.first().and_then(id_of) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

async fn hydrated_or_null(db: &SqlitePool, id: Option<i64>) -> ApiResult<Value> {
    match id {
        Some(id) => Ok(hydrate_employee_rows(db, &[id]).await?.into_iter().next().unwrap_or(Value::Null)),
        None => Ok(Value::Null),
    }
}

/// Matches only a colaborador linked to this exact (cliente, empresa) pair.
async fn find_by_attempts_in(
    db: &SqlitePool,
    client_id: i64,
    company_id: i64,
    attempts: &[IdentifierAttempt],
    values: &IdentifierValues,
) -> ApiResult<Option<i64>> {
    let select = "SELECT e.id
    FROM employees e
    JOIN employee_client_companies ecc ON ecc.employee_id = e.id AND ecc.client_id = $1 AND ecc.company_id = $2
    WHERE 1=1";
    find_employee_id_by_attempts(db, select, &params![client_id, company_id], attempts, values, MatriculaScope::JoinedPair).await
}

/// Same matching with no cliente/empresa scope — "does this person already
/// exist somewhere else?".
async fn find_anywhere_by_attempts_in(db: &SqlitePool, attempts: &[IdentifierAttempt], values: &IdentifierValues) -> ApiResult<Option<i64>> {
    let select = "SELECT e.id FROM employees e WHERE 1=1";
    find_employee_id_by_attempts(db, select, &[], attempts, values, MatriculaScope::AnyPair).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindByAttemptsArgs {
    client_id: i64,
    company_id: i64,
    attempts: Vec<IdentifierAttempt>,
    values: IdentifierValues,
}

async fn find_employee_by_attempts(State(state): State<AppState>, Json(args): Json<FindByAttemptsArgs>) -> ApiResult<Json<Value>> {
    let id = find_by_attempts_in(&state.db, args.client_id, args.company_id, &args.attempts, &args.values).await?;
    Ok(Json(hydrated_or_null(&state.db, id).await?))
}

#[derive(Deserialize)]
struct FindAnywhereArgs {
    attempts: Vec<IdentifierAttempt>,
    values: IdentifierValues,
}

async fn find_employee_anywhere_by_attempts(State(state): State<AppState>, Json(args): Json<FindAnywhereArgs>) -> ApiResult<Json<Value>> {
    let id = find_anywhere_by_attempts_in(&state.db, &args.attempts, &args.values).await?;
    Ok(Json(hydrated_or_null(&state.db, id).await?))
}

// --- employee-import templates ------------------------------------------------------

/// `parseAcceptedFileKinds`: NULL (templates predating the column) means
/// just the template's own `fileKind`.
fn accepted_file_kinds(row: &mut Row) -> ApiResult<Value> {
    match row.shift_remove("acceptedFileKindsJson") {
        Some(Value::String(text)) if !text.is_empty() => serde_json::from_str(&text).map_err(|e| ApiError::Internal(e.to_string())),
        _ => Ok(json!([row.get("fileKind").cloned().unwrap_or(Value::Null)])),
    }
}

async fn list_employee_templates_in(db: &SqlitePool) -> ApiResult<Vec<Value>> {
    let rows = sql::select(
        db,
        "
    SELECT et.id, et.name, et.file_kind AS fileKind, et.accepted_file_kinds_json AS acceptedFileKindsJson, et.updated_at AS updatedAt
    FROM employee_templates et
    ORDER BY et.updated_at DESC
  ",
        &[],
    )
    .await?;
    rows.into_iter()
        .map(|mut row| {
            let kinds = accepted_file_kinds(&mut row)?;
            row.insert("acceptedFileKinds".into(), kinds);
            Ok(Value::Object(row))
        })
        .collect()
}

async fn list_employee_templates(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(list_employee_templates_in(&state.db).await?))
}

async fn get_employee_template_in(db: &SqlitePool, id: i64) -> ApiResult<Value> {
    let mut row = sql::select_one(
        db,
        "SELECT et.id, et.name, et.file_kind AS fileKind, et.accepted_file_kinds_json AS acceptedFileKindsJson, et.delimiter,
            et.identifier_priority AS identifierPriority,
            et.created_at AS createdAt, et.updated_at AS updatedAt
     FROM employee_templates et
     WHERE et.id = $1",
        &params![id],
    )
    .await?
    .ok_or_else(|| ApiError::NotFound("Template não encontrado.".into()))?;

    let group_rows = sql::select(db, "SELECT id, header_row AS headerRow FROM employee_template_groups WHERE template_id = $1", &params![id]).await?;
    let mut groups = Vec::with_capacity(group_rows.len());
    for g in group_rows {
        let group_id = g.get("id").cloned().unwrap_or(Value::Null);
        let sheet_rows = sql::select(
            db,
            "SELECT sheet_name AS sheetName, included
       FROM employee_template_sheets
       WHERE group_id = $1
       ORDER BY sheet_name",
            std::slice::from_ref(&group_id),
        )
        .await?;
        let field_mappings = sql::select(
            db,
            "SELECT column_letter AS columnLetter, target_field AS targetField, header_label AS headerLabel
       FROM employee_template_fields
       WHERE group_id = $1
       ORDER BY column_letter",
            &[group_id],
        )
        .await?;
        let included = |r: &Row| r.get("included").and_then(Value::as_i64).unwrap_or(0) != 0;
        let names = |want: bool| -> Vec<Value> {
            sheet_rows.iter().filter(|r| included(r) == want).map(|r| r.get("sheetName").cloned().unwrap_or(Value::Null)).collect()
        };
        groups.push(json!({
            "sheetNames": names(true),
            "excludedSheetNames": names(false),
            "fieldMappings": field_mappings,
            "headerRow": g.get("headerRow").cloned().unwrap_or(Value::Null),
        }));
    }

    let identifier_priority: Value = match row.get("identifierPriority") {
        Some(Value::String(text)) => serde_json::from_str(text).map_err(|e| ApiError::Internal(e.to_string()))?,
        _ => Value::Null,
    };
    let kinds = accepted_file_kinds(&mut row)?;
    row.insert("identifierPriority".into(), identifier_priority);
    row.insert("acceptedFileKinds".into(), kinds);
    row.insert("groups".into(), Value::Array(groups));
    Ok(Value::Object(row))
}

async fn get_employee_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(get_employee_template_in(&state.db, args.id).await?))
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EmployeeTemplateFieldMapping {
    column_letter: String,
    target_field: String,
    #[serde(default)]
    header_label: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EmployeeTemplateGroup {
    #[serde(default)]
    sheet_names: Vec<String>,
    #[serde(default)]
    excluded_sheet_names: Vec<String>,
    #[serde(default)]
    field_mappings: Vec<EmployeeTemplateFieldMapping>,
    #[serde(default)]
    header_row: Option<i64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EmployeeTemplateInput {
    name: String,
    file_kind: String,
    /// Kept as raw JSON so it's stored byte-for-byte as `JSON.stringify` wrote it.
    accepted_file_kinds: Value,
    #[serde(default)]
    delimiter: Option<String>,
    identifier_priority: Value,
    #[serde(default)]
    groups: Vec<EmployeeTemplateGroup>,
}

fn to_json_text(value: &Value) -> ApiResult<String> {
    serde_json::to_string(value).map_err(|e| ApiError::Internal(e.to_string()))
}

/// `pushEmployeeTemplateGroupInserts`.
fn push_group_inserts(statements: &mut Vec<BatchStatement>, template_id: Value, groups: &[EmployeeTemplateGroup]) {
    for group in groups {
        let group_id = sql::last_insert_id_of(statements.len());
        statements.push(BatchStatement::new(
            "INSERT INTO employee_template_groups (template_id, header_row) VALUES ($1, $2)",
            vec![template_id.clone(), json!(group.header_row)],
        ));
        for sheet_name in &group.sheet_names {
            statements.push(BatchStatement::new(
                "INSERT INTO employee_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 1)",
                vec![group_id.clone(), json!(sheet_name)],
            ));
        }
        for sheet_name in &group.excluded_sheet_names {
            statements.push(BatchStatement::new(
                "INSERT INTO employee_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 0)",
                vec![group_id.clone(), json!(sheet_name)],
            ));
        }
        for mapping in &group.field_mappings {
            statements.push(BatchStatement::new(
                "INSERT INTO employee_template_fields (group_id, column_letter, target_field, header_label)
         VALUES ($1, $2, $3, $4)",
                vec![group_id.clone(), json!(mapping.column_letter), json!(mapping.target_field), json!(mapping.header_label)],
            ));
        }
    }
}

/// `deleteEmployeeTemplateGroupsStatements`.
fn delete_groups_statements(template_id: i64) -> Vec<BatchStatement> {
    let group_ids = "SELECT id FROM employee_template_groups WHERE template_id = $1";
    vec![
        BatchStatement::new(format!("DELETE FROM employee_template_fields WHERE group_id IN ({group_ids})"), params![template_id]),
        BatchStatement::new(format!("DELETE FROM employee_template_sheets WHERE group_id IN ({group_ids})"), params![template_id]),
        BatchStatement::new("DELETE FROM employee_template_groups WHERE template_id = $1", params![template_id]),
    ]
}

async fn create_employee_template_in(db: &SqlitePool, input: &EmployeeTemplateInput) -> ApiResult<i64> {
    let mut statements = vec![BatchStatement::new(
        "INSERT INTO employee_templates (name, file_kind, accepted_file_kinds_json, delimiter, identifier_priority)
     VALUES ($1, $2, $3, $4, $5)",
        params![
            input.name,
            input.file_kind,
            to_json_text(&input.accepted_file_kinds)?,
            input.delimiter,
            to_json_text(&input.identifier_priority)?
        ],
    )];
    push_group_inserts(&mut statements, sql::last_insert_id_of(0), &input.groups);
    let results = sql::run_batch(db, statements).await?;
    Ok(results[0].last_insert_id)
}

#[derive(Deserialize)]
struct CreateTemplateArgs {
    input: EmployeeTemplateInput,
}

async fn create_employee_template(State(state): State<AppState>, Json(args): Json<CreateTemplateArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_employee_template_in(&state.db, &args.input).await?))
}

async fn update_employee_template_in(db: &SqlitePool, id: i64, input: &EmployeeTemplateInput) -> ApiResult<()> {
    let mut statements = vec![BatchStatement::new(
        "UPDATE employee_templates SET
       name = $1, file_kind = $2, accepted_file_kinds_json = $3, delimiter = $4,
       identifier_priority = $5, updated_at = datetime('now')
     WHERE id = $6",
        params![
            input.name,
            input.file_kind,
            to_json_text(&input.accepted_file_kinds)?,
            input.delimiter,
            to_json_text(&input.identifier_priority)?,
            id
        ],
    )];
    statements.extend(delete_groups_statements(id));
    push_group_inserts(&mut statements, Value::from(id), &input.groups);
    sql::run_batch(db, statements).await?;
    Ok(())
}

#[derive(Deserialize)]
struct UpdateTemplateArgs {
    id: i64,
    input: EmployeeTemplateInput,
}

async fn update_employee_template(State(state): State<AppState>, Json(args): Json<UpdateTemplateArgs>) -> ApiResult<StatusCode> {
    update_employee_template_in(&state.db, args.id, &args.input).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_employee_template_in(db: &SqlitePool, id: i64) -> ApiResult<()> {
    let mut statements = delete_groups_statements(id);
    statements.push(BatchStatement::new("DELETE FROM employee_templates WHERE id = $1", params![id]));
    sql::run_batch(db, statements).await?;
    Ok(())
}

async fn delete_employee_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    delete_employee_template_in(&state.db, args.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- import -------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EmployeeImportRow {
    client_id: i64,
    company_id: i64,
    /// Existing employee resolved during preview; null means create by CPF.
    #[serde(default)]
    employee_id: Option<i64>,
    /// Null means the field was not mapped and the saved value must be preserved.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    cpf: Option<String>,
    #[serde(default)]
    matricula: Option<String>,
    #[serde(default)]
    matricula_mapped: bool,
    #[serde(default)]
    pix_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFromImportArgs {
    rows: Vec<EmployeeImportRow>,
    #[serde(default)]
    saved_file_hashes: Vec<String>,
}

/// Upsert of every row: links an already-registered colaborador (by
/// resolved id or CPF) to the row's pair, or creates a new one. Everything is
/// checked with reads first, then written as one transaction together with
/// marking `saved_file_hashes` saved — a bad row fails the whole import.
async fn create_employees_from_import_in(db: &SqlitePool, rows: &[EmployeeImportRow], saved_file_hashes: &[String]) -> ApiResult<()> {
    let mut pairs: Vec<(i64, i64)> = Vec::new();
    for row in rows {
        if !pairs.contains(&(row.client_id, row.company_id)) {
            pairs.push((row.client_id, row.company_id));
        }
    }
    for (client_id, company_id) in pairs {
        ensure_client_company_link(db, client_id, company_id).await?;
    }

    let mut statements: Vec<BatchStatement> = Vec::new();
    // A CPF new to the database can appear on several rows (one person under
    // several pairs): the first row creates the colaborador, later ones reuse it.
    let mut created_by_cpf: HashMap<String, Value> = HashMap::new();
    for row in rows {
        let normalized_cpf = row.cpf.as_deref().map(normalize_cpf).unwrap_or_default();
        let existing_id = match row.employee_id {
            Some(id) => Some(id),
            None => sql::select_one(db, "SELECT id FROM employees WHERE cpf = $1", &params![normalized_cpf]).await?.as_ref().and_then(id_of),
        };
        let name = row.name.as_deref().map(str::trim).unwrap_or_default();
        let employee_id: Value = if let Some(existing_id) = existing_id {
            if !name.is_empty() {
                statements.push(BatchStatement::new("UPDATE employees SET name = $1 WHERE id = $2", params![name, existing_id]));
            }
            if row.cpf.is_some() {
                if normalized_cpf.len() != 11 {
                    return Err(ApiError::BadRequest("CPF mapeado deve ter 11 dígitos.".into()));
                }
                let cpf_owner =
                    sql::select(db, "SELECT id FROM employees WHERE cpf = $1 AND id != $2", &params![normalized_cpf, existing_id]).await?;
                if !cpf_owner.is_empty() {
                    return Err(ApiError::Conflict("O CPF mapeado já pertence a outro colaborador.".into()));
                }
                statements.push(BatchStatement::new("UPDATE employees SET cpf = $1 WHERE id = $2", params![normalized_cpf, existing_id]));
            }
            Value::from(existing_id)
        } else if let Some(created) = created_by_cpf.get(&normalized_cpf) {
            created.clone()
        } else {
            if normalized_cpf.len() != 11 || name.is_empty() {
                return Err(ApiError::BadRequest("Para criar um colaborador novo, a linha precisa ter CPF válido e Nome.".into()));
            }
            let id = sql::last_insert_id_of(statements.len());
            statements.push(BatchStatement::new("INSERT INTO employees (name, cpf) VALUES ($1, $2)", params![name, normalized_cpf]));
            created_by_cpf.insert(normalized_cpf.clone(), id.clone());
            id
        };

        // An existing link keeps its matrícula unless the template maps one.
        let on_conflict = if row.matricula_mapped { "UPDATE SET matricula = excluded.matricula" } else { "NOTHING" };
        statements.push(BatchStatement::new(
            format!(
                "INSERT INTO employee_client_companies (employee_id, client_id, company_id, matricula) VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, client_id, company_id) DO {on_conflict}"
            ),
            vec![employee_id.clone(), json!(row.client_id), json!(row.company_id), trimmed_or_null(row.matricula.as_deref())],
        ));
        for raw_key in &row.pix_keys {
            let key_value = raw_key.trim();
            if key_value.is_empty() {
                return Err(ApiError::BadRequest("Informe uma chave PIX.".into()));
            }
            statements.push(BatchStatement::new(
                UPSERT_PIX_KEY,
                vec![employee_id.clone(), json!(key_value), json!(detect_pix_key_type(key_value))],
            ));
        }
    }
    statements.extend(mark_source_files_saved_statements(saved_file_hashes));
    sql::run_batch(db, statements).await?;
    Ok(())
}

async fn create_employees_from_import(State(state): State<AppState>, Json(args): Json<CreateFromImportArgs>) -> ApiResult<StatusCode> {
    create_employees_from_import_in(&state.db, &args.rows, &args.saved_file_hashes).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;

    /// Two companies, two clients; client 1 is linked to both companies,
    /// client 2 only to company 1.
    async fn pool() -> SqlitePool {
        let pool = test_pool().await;
        for statement in [
            "INSERT INTO companies (id, name, cnpj) VALUES (1, 'Empresa A', '11111111111111'), (2, 'Empresa B', '22222222222222')",
            "INSERT INTO clients (id, name, cnpj) VALUES (1, 'Cliente 1', '33333333333333'), (2, 'Cliente 2', '44444444444444')",
            "INSERT INTO client_companies (client_id, company_id) VALUES (1, 1), (1, 2), (2, 1)",
        ] {
            sql::execute(&pool, statement, &[]).await.unwrap();
        }
        pool
    }

    fn manual(client_id: i64, company_id: i64, name: &str, cpf: &str, matricula: Option<&str>) -> CreateEmployeeManualArgs {
        CreateEmployeeManualArgs { client_id, company_id, name: name.into(), cpf: cpf.into(), matricula: matricula.map(Into::into) }
    }

    fn attempt(fields: &[&str], case_insensitive: bool) -> IdentifierAttempt {
        IdentifierAttempt { fields: fields.iter().map(|f| f.to_string()).collect(), case_insensitive }
    }

    fn values(cpf: Option<&str>, matricula: Option<&str>, nome: Option<&str>) -> IdentifierValues {
        IdentifierValues { cpf: cpf.map(Into::into), matricula: matricula.map(Into::into), nome: nome.map(Into::into) }
    }

    #[test]
    fn pix_key_types_match_the_frontend_detector() {
        assert_eq!(detect_pix_key_type(" ana@ex.com "), "email");
        assert_eq!(detect_pix_key_type("123e4567-e89b-12d3-a456-426614174000"), "random");
        assert_eq!(detect_pix_key_type("529.982.247-25"), "cpf");
        assert_eq!(detect_pix_key_type("11.222.333/0001-81"), "cnpj");
        assert_eq!(detect_pix_key_type("(11) 98765-4321"), "phone");
        assert_eq!(detect_pix_key_type("+55 11 98765-4321"), "phone");
        assert_eq!(detect_pix_key_type("111.111.111-11"), "phone");
        assert_eq!(detect_pix_key_type("abc"), "other");
    }

    #[tokio::test]
    async fn manual_create_validates_and_links_with_matricula() {
        let pool = pool().await;
        let err = create_employee_manual_in(&pool, &manual(2, 2, "X", "52998224725", None)).await.unwrap_err();
        assert_eq!(err.to_string(), NOT_LINKED);
        let err = create_employee_manual_in(&pool, &manual(1, 1, "X", "123", None)).await.unwrap_err();
        assert_eq!(err.to_string(), "CPF deve ter 11 dígitos.");

        let id = create_employee_manual_in(&pool, &manual(1, 1, " Ana ", "529.982.247-25", Some(" 77 "))).await.unwrap();
        let err = create_employee_manual_in(&pool, &manual(2, 1, "Ana", "52998224725", None)).await.unwrap_err();
        assert_eq!(err.to_string(), CPF_TAKEN);

        let row = get_employee_in(&pool, id).await.unwrap();
        assert_eq!(row["name"], json!("Ana"));
        assert_eq!(row["cpf"], json!("52998224725"));
        assert_eq!(
            row["links"],
            json!([{ "clientId": 1, "clientName": "Cliente 1", "companyId": 1, "companyName": "Empresa A", "matricula": "77" }])
        );

        // Last link can't be removed.
        let err = unlink_employee_in(&pool, id, 1, 1).await.unwrap_err();
        assert!(err.to_string().starts_with("O colaborador precisa"));
        link_employee_in(&pool, id, 2, 1, None).await.unwrap();
        unlink_employee_in(&pool, id, 1, 1).await.unwrap();
        assert_eq!(get_employee_in(&pool, id).await.unwrap()["links"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn global_list_searches_names_without_accents_and_cpf_digits_and_paginates() {
        let pool = pool().await;
        create_employee_manual_in(&pool, &manual(1, 1, "JOÃO GONÇALVES", "52998224725", None)).await.unwrap();
        create_employee_manual_in(&pool, &manual(2, 1, "Maria Souza", "11144477735", None)).await.unwrap();
        create_employee_manual_in(&pool, &manual(1, 2, "Ana Lima", "39053344705", None)).await.unwrap();

        let query = |search: Option<&str>, company_ids: Vec<i64>, client_ids: Vec<i64>, page: i64, page_size: i64| EmployeesGlobalQuery {
            search: search.map(Into::into),
            company_ids,
            client_ids,
            page,
            page_size,
        };
        let names = |v: &Value| v["rows"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();

        let all = list_employees_global_in(&pool, &query(None, vec![], vec![], 0, 2)).await.unwrap();
        assert_eq!(all["total"], json!(3));
        assert_eq!(names(&all), ["Ana Lima", "JOÃO GONÇALVES"]);
        let page2 = list_employees_global_in(&pool, &query(None, vec![], vec![], 1, 2)).await.unwrap();
        assert_eq!(names(&page2), ["Maria Souza"]);

        let by_name = list_employees_global_in(&pool, &query(Some(" goncalves "), vec![], vec![], 0, 10)).await.unwrap();
        assert_eq!(names(&by_name), ["JOÃO GONÇALVES"]);
        let by_cpf = list_employees_global_in(&pool, &query(Some("111.444"), vec![], vec![], 0, 10)).await.unwrap();
        assert_eq!(names(&by_cpf), ["Maria Souza"]);

        let company_b = list_employees_global_in(&pool, &query(None, vec![2], vec![], 0, 10)).await.unwrap();
        assert_eq!(names(&company_b), ["Ana Lima"]);
        let client_1_company_a = list_employees_global_in(&pool, &query(None, vec![1], vec![1], 0, 10)).await.unwrap();
        assert_eq!(names(&client_1_company_a), ["JOÃO GONÇALVES"]);
        assert_eq!(client_1_company_a["rows"][0]["links"][0]["companyName"], json!("Empresa A"));
    }

    #[tokio::test]
    async fn attempts_walk_in_order_and_respect_scope_and_aliases() {
        let pool = pool().await;
        let ana = create_employee_manual_in(&pool, &manual(1, 1, "Ana Lima", "52998224725", Some("M-10"))).await.unwrap();
        add_employee_alias_in(&pool, ana, "Aninha").await.unwrap();

        let cpf_then_name = [attempt(&["cpf"], true), attempt(&["nome"], true)];
        // No CPF: the cpf tentativa is skipped and the alias matches.
        let found = find_by_attempts_in(&pool, 1, 1, &cpf_then_name, &values(None, None, Some("ANINHA"))).await.unwrap();
        assert_eq!(found, Some(ana));
        // Case-sensitive name doesn't match a different case.
        let strict = [attempt(&["nome"], false)];
        assert_eq!(find_by_attempts_in(&pool, 1, 1, &strict, &values(None, None, Some("ana lima"))).await.unwrap(), None);
        // Same CPF, but under a pair she isn't linked to.
        assert_eq!(find_by_attempts_in(&pool, 1, 2, &cpf_then_name, &values(Some("529.982.247-25"), None, None)).await.unwrap(), None);
        // ... which the unscoped variant still finds.
        assert_eq!(find_anywhere_by_attempts_in(&pool, &cpf_then_name, &values(Some("529.982.247-25"), None, None)).await.unwrap(), Some(ana));
        // Matrícula + nome must both match the same person.
        let both = [attempt(&["matricula", "nome"], true)];
        assert_eq!(find_anywhere_by_attempts_in(&pool, &both, &values(None, Some("m-10"), Some("ana lima"))).await.unwrap(), Some(ana));
        assert_eq!(find_anywhere_by_attempts_in(&pool, &both, &values(None, Some("m-10"), Some("outra"))).await.unwrap(), None);
        assert_eq!(find_by_attempts_in(&pool, 1, 1, &both, &values(None, Some("M-10"), Some("Ana Lima"))).await.unwrap(), Some(ana));
    }

    #[tokio::test]
    async fn alias_collisions_only_matter_within_a_shared_pair() {
        let pool = pool().await;
        let ana = create_employee_manual_in(&pool, &manual(1, 1, "Ana", "52998224725", None)).await.unwrap();
        let bia = create_employee_manual_in(&pool, &manual(1, 1, "Bia", "11144477735", None)).await.unwrap();
        let cris = create_employee_manual_in(&pool, &manual(1, 2, "Cris", "39053344705", None)).await.unwrap();
        add_employee_alias_in(&pool, ana, "Silva").await.unwrap();
        add_employee_alias_in(&pool, ana, "silva").await.unwrap(); // no-op
        let err = add_employee_alias_in(&pool, bia, "SILVA").await.unwrap_err();
        assert_eq!(err.to_string(), "Esse nome já está vinculado a Ana.");
        // Cris never shares a pair with Ana.
        add_employee_alias_in(&pool, cris, "Silva").await.unwrap();
        let count = sql::select(&pool, "SELECT id FROM employee_aliases", &[]).await.unwrap().len();
        assert_eq!(count, 2);
        assert!(matches!(add_employee_alias_in(&pool, 999, "x").await.unwrap_err(), ApiError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_refuses_paid_history_unless_allowed() {
        let pool = pool().await;
        let ana = create_employee_manual_in(&pool, &manual(1, 1, "Ana", "52998224725", None)).await.unwrap();
        add_pix_key_in(&pool, ana, " ana@ex.com ", None).await.unwrap();
        sql::execute(
            &pool,
            "INSERT INTO payment_shifts (employee_id, client_id, company_id, work_date, status, amount) VALUES ($1, 1, 1, '2026-01-01', 'pago', 100)",
            &params![ana],
        )
        .await
        .unwrap();
        let impact = deletion_impact(&pool, ana).await.unwrap();
        assert_eq!(impact["paymentRecords"], json!(1));
        assert_eq!(impact["shifts"], json!(1));
        assert_eq!(impact["pixKeys"], json!(1));
        let err = delete_employee_in(&pool, ana, false).await.unwrap_err();
        assert!(err.to_string().starts_with("Este colaborador tem 1 registro de pagamento no histórico"));
        delete_employee_in(&pool, ana, true).await.unwrap();
        assert!(sql::select(&pool, "SELECT id FROM employees", &[]).await.unwrap().is_empty());
        assert!(sql::select(&pool, "SELECT id FROM payment_shifts", &[]).await.unwrap().is_empty());
        assert!(sql::select(&pool, "SELECT id FROM employee_pix_keys", &[]).await.unwrap().is_empty());
    }

    fn import_row(client_id: i64, company_id: i64, employee_id: Option<i64>, name: Option<&str>, cpf: Option<&str>) -> EmployeeImportRow {
        EmployeeImportRow {
            client_id,
            company_id,
            employee_id,
            name: name.map(Into::into),
            cpf: cpf.map(Into::into),
            matricula: Some("9".into()),
            matricula_mapped: true,
            pix_keys: vec!["ana@ex.com".into()],
        }
    }

    #[tokio::test]
    async fn import_creates_once_per_new_cpf_and_rolls_back_on_a_bad_row() {
        let pool = pool().await;
        // The same new person under two pairs → one colaborador, two links.
        create_employees_from_import_in(
            &pool,
            &[import_row(1, 1, None, Some("Ana"), Some("529.982.247-25")), import_row(1, 2, None, Some("Ana"), Some("52998224725"))],
            &[],
        )
        .await
        .unwrap();
        let employees = sql::select(&pool, "SELECT id FROM employees", &[]).await.unwrap();
        assert_eq!(employees.len(), 1);
        let ana = id_of(&employees[0]).unwrap();
        let row = get_employee_in(&pool, ana).await.unwrap();
        assert_eq!(row["links"].as_array().unwrap().len(), 2);
        let keys = sql::select(&pool, "SELECT key_type AS t FROM employee_pix_keys", &[]).await.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0]["t"], json!("email"));

        // A row whose pair isn't linked fails everything before writing.
        let err = create_employees_from_import_in(&pool, &[import_row(1, 1, None, Some("Bia"), Some("11144477735")), import_row(2, 2, None, Some("C"), Some("39053344705"))], &[])
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), NOT_LINKED);
        // A row with no name for a new CPF also fails the whole batch.
        let err = create_employees_from_import_in(&pool, &[import_row(1, 1, None, Some("Bia"), Some("11144477735")), import_row(1, 1, None, None, Some("39053344705"))], &[])
            .await
            .unwrap_err();
        assert!(err.to_string().starts_with("Para criar um colaborador novo"));
        assert_eq!(sql::select(&pool, "SELECT id FROM employees", &[]).await.unwrap().len(), 1);

        // Mapping a CPF already owned by someone else is refused.
        create_employees_from_import_in(&pool, &[import_row(1, 1, None, Some("Bia"), Some("11144477735"))], &[]).await.unwrap();
        let err = create_employees_from_import_in(&pool, &[import_row(1, 1, Some(ana), None, Some("11144477735"))], &[]).await.unwrap_err();
        assert_eq!(err.to_string(), "O CPF mapeado já pertence a outro colaborador.");

        // Unmapped matrícula leaves the existing one alone.
        let mut keep = import_row(1, 1, Some(ana), None, None);
        keep.matricula = None;
        keep.matricula_mapped = false;
        keep.pix_keys.clear();
        create_employees_from_import_in(&pool, &[keep], &[]).await.unwrap();
        let link = sql::select(&pool, "SELECT matricula FROM employee_client_companies WHERE employee_id = $1 AND company_id = 1", &params![ana])
            .await
            .unwrap();
        assert_eq!(link[0]["matricula"], json!("9"));
    }

    #[tokio::test]
    async fn templates_round_trip_with_groups_and_replace_them_on_update() {
        let pool = pool().await;
        let input: EmployeeTemplateInput = serde_json::from_value(json!({
            "name": "Planilha RH",
            "fileKind": "xlsx",
            "acceptedFileKinds": ["xlsx", "csv"],
            "delimiter": null,
            "identifierPriority": [{ "fields": ["cpf"], "caseInsensitive": true }],
            "groups": [{
                "sheetNames": ["B", "A"],
                "excludedSheetNames": ["Resumo"],
                "fieldMappings": [{ "columnLetter": "B", "targetField": "nome", "headerLabel": "Nome" }, { "columnLetter": "A", "targetField": "cpf", "headerLabel": null }],
                "headerRow": 2
            }]
        }))
        .unwrap();
        let id = create_employee_template_in(&pool, &input).await.unwrap();
        let stored: Option<String> = sqlx::query_scalar("SELECT identifier_priority FROM employee_templates").fetch_one(&pool).await.unwrap();
        assert_eq!(stored.as_deref(), Some(r#"[{"fields":["cpf"],"caseInsensitive":true}]"#));

        let t = get_employee_template_in(&pool, id).await.unwrap();
        assert_eq!(t["acceptedFileKinds"], json!(["xlsx", "csv"]));
        assert_eq!(t["identifierPriority"], json!([{ "fields": ["cpf"], "caseInsensitive": true }]));
        assert_eq!(t["groups"][0]["sheetNames"], json!(["A", "B"]));
        assert_eq!(t["groups"][0]["excludedSheetNames"], json!(["Resumo"]));
        assert_eq!(t["groups"][0]["fieldMappings"][0]["columnLetter"], json!("A"));
        assert_eq!(t["groups"][0]["headerRow"], json!(2));

        let mut changed = input.clone();
        changed.groups[0].sheet_names = vec!["C".into()];
        update_employee_template_in(&pool, id, &changed).await.unwrap();
        let t = get_employee_template_in(&pool, id).await.unwrap();
        assert_eq!(t["groups"].as_array().unwrap().len(), 1);
        assert_eq!(t["groups"][0]["sheetNames"], json!(["C"]));

        // A template from before accepted_file_kinds_json falls back to its own kind.
        sql::execute(&pool, "UPDATE employee_templates SET accepted_file_kinds_json = NULL", &[]).await.unwrap();
        let list = list_employee_templates_in(&pool).await.unwrap();
        assert_eq!(list[0]["acceptedFileKinds"], json!(["xlsx"]));
        assert!(list[0].get("acceptedFileKindsJson").is_none());

        delete_employee_template_in(&pool, id).await.unwrap();
        assert!(sql::select(&pool, "SELECT id FROM employee_template_fields", &[]).await.unwrap().is_empty());
        assert!(matches!(get_employee_template_in(&pool, id).await.unwrap_err(), ApiError::NotFound(_)));
    }

    #[tokio::test]
    async fn reassign_scopes_history_by_period() {
        let pool = pool().await;
        let ana = create_employee_manual_in(&pool, &manual(1, 1, "Ana", "52998224725", None)).await.unwrap();
        for date in ["2026-01-10", "2026-02-10"] {
            sql::execute(
                &pool,
                "INSERT INTO payment_shifts (employee_id, client_id, company_id, work_date, status) VALUES ($1, 1, 1, $2, 'pendente')",
                &params![ana, date],
            )
            .await
            .unwrap();
        }
        reassign_history_in(
            &pool,
            &ReassignArgs { employee_id: ana, new_client_id: 1, new_company_id: 2, period_start: Some("2026-02-01".into()), period_end: Some(String::new()) },
        )
        .await
        .unwrap();
        let rows = sql::select(&pool, "SELECT work_date AS d, company_id AS c FROM payment_shifts ORDER BY work_date", &[]).await.unwrap();
        assert_eq!(rows[0]["c"], json!(1));
        assert_eq!(rows[1]["c"], json!(2));
    }
}
