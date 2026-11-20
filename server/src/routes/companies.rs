//! Empresas — port of `listCompanies` / `getCompany` / `createCompany` /
//! `updateCompany` from the desktop app's `src/lib/db.ts`, same rules and
//! same error messages.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};

use crate::error::{ApiError, ApiResult};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/companies", get(list).post(create))
        .route("/companies/{id}", get(detail).put(update))
}

const NIGHT_SHIFT_RULES: [&str; 5] = ["start-in-range", "end-in-range", "start-or-end-in-range", "overlap", "majority-overlap"];
const VALUE_RULE_OPERATORS: [&str; 6] = ["=", "!=", ">", ">=", "<", "<="];

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CompanyRow {
    pub id: i64,
    pub name: String,
    pub cnpj: String,
    pub night_start_time: String,
    pub night_end_time: String,
    pub night_shift_rule: String,
}

/// `CompanyRow` plus the Empresas list's counts — only `list_companies`
/// returns these; `get_company` stays on the plain row.
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CompanyListRow {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub company: CompanyRow,
    /// Clientes linked through `client_companies`.
    pub client_count: i64,
    /// Distinct colaboradores linked through `employee_client_companies`.
    pub employee_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaymentValueRule {
    /// "condition" | "else"
    pub kind: String,
    /// Column conditions, stored as-is in `conditions_json` — the server
    /// doesn't interpret them, only the payment value resolver does.
    #[serde(default)]
    pub conditions: Vec<JsonValue>,
    pub operator: Option<String>,
    pub threshold_minutes: Option<i64>,
    pub amount: f64,
}

/// kind, conditions_json, operator, threshold_minutes, amount
type ValueRuleRow = (String, Option<String>, Option<String>, Option<i64>, f64);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyDetail {
    #[serde(flatten)]
    pub company: CompanyRow,
    pub value_rules: Vec<PaymentValueRule>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyInput {
    pub name: String,
    pub cnpj: String,
    #[serde(default = "default_night_start")]
    pub night_start_time: String,
    #[serde(default = "default_night_end")]
    pub night_end_time: String,
    #[serde(default = "default_night_rule")]
    pub night_shift_rule: String,
    #[serde(default)]
    pub value_rules: Vec<PaymentValueRule>,
}

fn default_night_start() -> String {
    "22:00".into()
}
fn default_night_end() -> String {
    "05:00".into()
}
fn default_night_rule() -> String {
    "overlap".into()
}

#[derive(Debug, Serialize)]
pub struct Created {
    pub id: i64,
}

async fn list(State(state): State<AppState>) -> ApiResult<Json<Vec<CompanyListRow>>> {
    Ok(Json(list_companies(&state.db).await?))
}

async fn detail(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<CompanyDetail>> {
    Ok(Json(get_company(&state.db, id).await?))
}

async fn create(State(state): State<AppState>, Json(input): Json<CompanyInput>) -> ApiResult<(StatusCode, Json<Created>)> {
    let id = create_company(&state.db, input).await?;
    Ok((StatusCode::CREATED, Json(Created { id })))
}

async fn update(State(state): State<AppState>, Path(id): Path<i64>, Json(input): Json<CompanyInput>) -> ApiResult<StatusCode> {
    update_company(&state.db, id, input).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_companies(db: &SqlitePool) -> ApiResult<Vec<CompanyListRow>> {
    Ok(sqlx::query_as::<_, CompanyListRow>(
        "SELECT c.id, c.name, c.cnpj, c.night_start_time, c.night_end_time, c.night_shift_rule,
           (SELECT COUNT(*) FROM client_companies cc WHERE cc.company_id = c.id) AS client_count,
           (SELECT COUNT(DISTINCT ecc.employee_id) FROM employee_client_companies ecc WHERE ecc.company_id = c.id) AS employee_count
         FROM companies c ORDER BY c.name",
    )
    .fetch_all(db)
    .await?)
}

pub async fn get_company(db: &SqlitePool, id: i64) -> ApiResult<CompanyDetail> {
    let company = sqlx::query_as::<_, CompanyRow>(
        "SELECT id, name, cnpj, night_start_time, night_end_time, night_shift_rule FROM companies WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::NotFound("Empresa não encontrada.".into()))?;

    let rows: Vec<ValueRuleRow> = sqlx::query_as(
        "SELECT kind, conditions_json, operator, threshold_minutes, amount FROM payment_value_rules WHERE company_id = ?1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let value_rules = rows
        .into_iter()
        .map(|(kind, conditions_json, operator, threshold_minutes, amount)| {
            let conditions = match conditions_json {
                Some(json) => serde_json::from_str(&json).map_err(|e| ApiError::Internal(format!("conditions_json inválido na empresa {id}: {e}")))?,
                None => Vec::new(),
            };
            Ok(PaymentValueRule { kind, conditions, operator, threshold_minutes, amount })
        })
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(CompanyDetail { company, value_rules })
}

/// CNPJ is the natural key: registering one that already exists is rejected
/// instead of silently merging into the other company's record.
pub async fn create_company(db: &SqlitePool, input: CompanyInput) -> ApiResult<i64> {
    let input = validate(input)?;
    let mut tx = db.begin().await?;
    ensure_cnpj_free(&mut tx, &input.cnpj, None).await?;
    let id = sqlx::query("INSERT INTO companies (name, cnpj, night_start_time, night_end_time, night_shift_rule) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(&input.name)
        .bind(&input.cnpj)
        .bind(&input.night_start_time)
        .bind(&input.night_end_time)
        .bind(&input.night_shift_rule)
        .execute(&mut *tx)
        .await
        .map_err(unique_cnpj)?
        .last_insert_rowid();
    insert_value_rules(&mut tx, id, &input.value_rules).await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn update_company(db: &SqlitePool, id: i64, input: CompanyInput) -> ApiResult<()> {
    let input = validate(input)?;
    let mut tx = db.begin().await?;
    ensure_cnpj_free(&mut tx, &input.cnpj, Some(id)).await?;
    let changed = sqlx::query("UPDATE companies SET name = ?1, cnpj = ?2, night_start_time = ?3, night_end_time = ?4, night_shift_rule = ?5 WHERE id = ?6")
        .bind(&input.name)
        .bind(&input.cnpj)
        .bind(&input.night_start_time)
        .bind(&input.night_end_time)
        .bind(&input.night_shift_rule)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(unique_cnpj)?
        .rows_affected();
    if changed == 0 {
        return Err(ApiError::NotFound("Empresa não encontrada.".into()));
    }
    sqlx::query("DELETE FROM payment_value_rules WHERE company_id = ?1").bind(id).execute(&mut *tx).await?;
    insert_value_rules(&mut tx, id, &input.value_rules).await?;
    tx.commit().await?;
    Ok(())
}

/// Same order of insertion as given — the value chain is evaluated in that
/// order (see `resolvePaymentValue` in the frontend).
async fn insert_value_rules(tx: &mut Transaction<'_, Sqlite>, company_id: i64, rules: &[PaymentValueRule]) -> ApiResult<()> {
    for rule in rules {
        let is_condition = rule.kind == "condition";
        let conditions_json = if is_condition && !rule.conditions.is_empty() {
            Some(serde_json::to_string(&rule.conditions).map_err(|e| ApiError::Internal(e.to_string()))?)
        } else {
            None
        };
        sqlx::query("INSERT INTO payment_value_rules (company_id, kind, conditions_json, operator, threshold_minutes, amount) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .bind(company_id)
            .bind(&rule.kind)
            .bind(conditions_json)
            .bind(if is_condition { rule.operator.as_deref() } else { None })
            .bind(if is_condition { rule.threshold_minutes } else { None })
            .bind(rule.amount)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn ensure_cnpj_free(tx: &mut Transaction<'_, Sqlite>, cnpj: &str, except_id: Option<i64>) -> ApiResult<()> {
    let taken: Option<i64> = sqlx::query_scalar("SELECT id FROM companies WHERE cnpj = ?1 AND id IS NOT ?2")
        .bind(cnpj)
        .bind(except_id)
        .fetch_optional(&mut **tx)
        .await?;
    match taken {
        Some(_) => Err(cnpj_taken()),
        None => Ok(()),
    }
}

fn cnpj_taken() -> ApiError {
    ApiError::Conflict("Já existe uma empresa cadastrada com esse CNPJ.".into())
}

/// Two people saving the same CNPJ at the same moment both pass
/// `ensure_cnpj_free`; the UNIQUE index catches the second one.
fn unique_cnpj(error: sqlx::Error) -> ApiError {
    match &error {
        sqlx::Error::Database(db) if db.is_unique_violation() => cnpj_taken(),
        _ => ApiError::Database(error),
    }
}

/// `normalizeCnpj` from `src/lib/format.ts`: digits only.
pub fn normalize_cnpj(cnpj: &str) -> String {
    cnpj.chars().filter(char::is_ascii_digit).collect()
}

fn is_hh_mm(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && value[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && value[3..].parse::<u8>().is_ok_and(|m| m < 60)
        && bytes.iter().enumerate().all(|(i, b)| i == 2 || b.is_ascii_digit())
}

/// The browser is not trusted: everything the form already restricts is
/// checked again here.
fn validate(mut input: CompanyInput) -> ApiResult<CompanyInput> {
    input.name = input.name.trim().to_owned();
    if input.name.is_empty() {
        return Err(ApiError::BadRequest("Informe o nome da empresa.".into()));
    }
    input.cnpj = normalize_cnpj(&input.cnpj);
    if input.cnpj.len() != 14 {
        return Err(ApiError::BadRequest("CNPJ deve ter 14 dígitos.".into()));
    }
    if !is_hh_mm(&input.night_start_time) || !is_hh_mm(&input.night_end_time) {
        return Err(ApiError::BadRequest("Horário noturno inválido (use HH:MM).".into()));
    }
    if !NIGHT_SHIFT_RULES.contains(&input.night_shift_rule.as_str()) {
        return Err(ApiError::BadRequest("Regra de turno noturno inválida.".into()));
    }
    for rule in &input.value_rules {
        let valid = match rule.kind.as_str() {
            "condition" => rule.operator.as_deref().is_some_and(|op| VALUE_RULE_OPERATORS.contains(&op)),
            "else" => true,
            _ => false,
        };
        if !valid || !rule.amount.is_finite() {
            return Err(ApiError::BadRequest("Regra de valor inválida.".into()));
        }
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;
    use serde_json::json;

    fn input(name: &str, cnpj: &str, rules: Vec<PaymentValueRule>) -> CompanyInput {
        CompanyInput {
            name: name.into(),
            cnpj: cnpj.into(),
            night_start_time: default_night_start(),
            night_end_time: default_night_end(),
            night_shift_rule: default_night_rule(),
            value_rules: rules,
        }
    }

    fn rules() -> Vec<PaymentValueRule> {
        vec![
            PaymentValueRule {
                kind: "condition".into(),
                conditions: vec![json!({ "column": "local", "values": ["A"] })],
                operator: Some(">=".into()),
                threshold_minutes: Some(440),
                amount: 150.5,
            },
            PaymentValueRule { kind: "else".into(), conditions: vec![], operator: None, threshold_minutes: None, amount: 100.0 },
        ]
    }

    #[tokio::test]
    async fn creates_and_reads_back_a_company_with_its_value_chain_in_order() {
        let db = test_pool().await;
        let id = create_company(&db, input("  Acme  ", "11.222.333/0001-81", rules())).await.unwrap();
        let detail = get_company(&db, id).await.unwrap();
        assert_eq!(detail.company.name, "Acme");
        assert_eq!(detail.company.cnpj, "11222333000181");
        assert_eq!(detail.company.night_shift_rule, "overlap");
        assert_eq!(detail.value_rules, rules());
    }

    #[tokio::test]
    async fn rejects_a_duplicate_cnpj() {
        let db = test_pool().await;
        create_company(&db, input("A", "11222333000181", vec![])).await.unwrap();
        let err = create_company(&db, input("B", "11.222.333/0001-81", vec![])).await.unwrap_err();
        assert_eq!(err.to_string(), "Já existe uma empresa cadastrada com esse CNPJ.");
    }

    #[tokio::test]
    async fn rejects_a_cnpj_without_14_digits() {
        let db = test_pool().await;
        let err = create_company(&db, input("A", "123", vec![])).await.unwrap_err();
        assert_eq!(err.to_string(), "CNPJ deve ter 14 dígitos.");
    }

    #[tokio::test]
    async fn update_replaces_the_value_chain_and_allows_keeping_its_own_cnpj() {
        let db = test_pool().await;
        let id = create_company(&db, input("A", "11222333000181", rules())).await.unwrap();
        update_company(&db, id, input("A2", "11222333000181", vec![rules()[1].clone()])).await.unwrap();
        let detail = get_company(&db, id).await.unwrap();
        assert_eq!(detail.company.name, "A2");
        assert_eq!(detail.value_rules, vec![rules()[1].clone()]);
    }

    #[tokio::test]
    async fn update_cannot_take_another_companys_cnpj() {
        let db = test_pool().await;
        create_company(&db, input("A", "11222333000181", vec![])).await.unwrap();
        let b = create_company(&db, input("B", "99888777000166", vec![])).await.unwrap();
        let err = update_company(&db, b, input("B", "11222333000181", vec![])).await.unwrap_err();
        assert!(matches!(err, ApiError::Conflict(_)));
    }

    #[tokio::test]
    async fn update_of_a_missing_company_is_not_found_and_changes_nothing() {
        let db = test_pool().await;
        let err = update_company(&db, 999, input("X", "11222333000181", rules())).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound(_)));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payment_value_rules").fetch_one(&db).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn list_is_sorted_by_name() {
        let db = test_pool().await;
        create_company(&db, input("Zeta", "11222333000181", vec![])).await.unwrap();
        create_company(&db, input("Alfa", "99888777000166", vec![])).await.unwrap();
        let names: Vec<_> = list_companies(&db).await.unwrap().into_iter().map(|c| c.company.name).collect();
        assert_eq!(names, ["Alfa", "Zeta"]);
    }

    #[tokio::test]
    async fn list_counts_clients_and_distinct_employees() {
        let db = test_pool().await;
        let company = create_company(&db, input("Alfa", "11222333000181", vec![])).await.unwrap();
        create_company(&db, input("Zeta", "99888777000166", vec![])).await.unwrap();
        for sql in [
            "INSERT INTO clients (id, name, cnpj) VALUES (1, 'C1', '1'), (2, 'C2', '2')",
            "INSERT INTO client_companies (client_id, company_id) VALUES (1, ?1), (2, ?1)",
            "INSERT INTO employees (id, name, cpf) VALUES (1, 'Ana', '1'), (2, 'Bia', '2')",
            // Ana works at both clientes through this empresa: still one colaborador.
            "INSERT INTO employee_client_companies (employee_id, client_id, company_id) VALUES (1, 1, ?1), (1, 2, ?1), (2, 1, ?1)",
        ] {
            sqlx::query(sql).bind(company).execute(&db).await.unwrap();
        }
        let rows = list_companies(&db).await.unwrap();
        let counts: Vec<_> = rows.iter().map(|c| (c.company.name.as_str(), c.client_count, c.employee_count)).collect();
        assert_eq!(counts, [("Alfa", 2, 2), ("Zeta", 0, 0)]);
    }

    #[test]
    fn validates_times() {
        assert!(is_hh_mm("22:00"));
        assert!(is_hh_mm("05:30"));
        assert!(!is_hh_mm("24:00"));
        assert!(!is_hh_mm("5:30"));
        assert!(!is_hh_mm("+1:00"));
    }
}
