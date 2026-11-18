//! Clientes (db.ts: listClients … getEffectivePaymentRules).
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};
use crate::routes::companies::{self, normalize_cnpj, PaymentValueRule};
use crate::sql::{self, BatchStatement, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listClients", post(list_clients))
        .route("/rpc/createClient", post(create_client))
        .route("/rpc/getClient", post(get_client))
        .route("/rpc/addClientCompany", post(add_client_company))
        .route("/rpc/removeClientCompany", post(remove_client_company))
        .route("/rpc/updateClient", post(update_client))
        .route("/rpc/getEffectivePaymentRules", post(get_effective_payment_rules))
}

async fn list_clients(State(state): State<AppState>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(
        sql::select(
            &state.db,
            "
    SELECT cl.id, cl.name, cl.cnpj, c.id AS companyId, c.name AS companyName
    FROM clients cl
    JOIN client_companies cc ON cc.client_id = cl.id
    JOIN companies c ON c.id = cc.company_id
    ORDER BY c.name, cl.name
  ",
            &[],
        )
        .await?,
    ))
}

/// `valueRuleInserts("client_payment_value_rules", "client_id", ...)`: one
/// INSERT per rule, in array order (the chain is evaluated in that order).
fn client_value_rule_inserts(owner_id: Value, rules: &[PaymentValueRule]) -> ApiResult<Vec<BatchStatement>> {
    rules
        .iter()
        .map(|rule| {
            let is_condition = rule.kind == "condition";
            let conditions_json = if is_condition && !rule.conditions.is_empty() {
                Value::from(serde_json::to_string(&rule.conditions).map_err(|e| ApiError::Internal(e.to_string()))?)
            } else {
                Value::Null
            };
            Ok(BatchStatement::new(
                "INSERT INTO client_payment_value_rules (client_id, kind, conditions_json, operator, threshold_minutes, amount)
       VALUES ($1, $2, $3, $4, $5, $6)",
                vec![
                    owner_id.clone(),
                    json!(rule.kind),
                    conditions_json,
                    if is_condition { json!(rule.operator) } else { Value::Null },
                    if is_condition { json!(rule.threshold_minutes) } else { Value::Null },
                    json!(rule.amount),
                ],
            ))
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateClientArgs {
    company_ids: Vec<i64>,
    name: String,
    cnpj: String,
    #[serde(default)]
    night_start_time: Option<String>,
    #[serde(default)]
    night_end_time: Option<String>,
    #[serde(default)]
    night_shift_rule: Option<String>,
    #[serde(default)]
    value_rules: Vec<PaymentValueRule>,
}

/// Creates a brand new client, or links an existing one (found by CNPJ) to
/// whichever of `company_ids` it isn't linked to yet. Linking an existing
/// client leaves its rule overrides untouched.
async fn create_client_in(db: &SqlitePool, args: CreateClientArgs) -> ApiResult<i64> {
    let normalized_cnpj = normalize_cnpj(&args.cnpj);
    if normalized_cnpj.len() != 14 {
        return Err(ApiError::BadRequest("CNPJ deve ter 14 dígitos.".into()));
    }
    if args.company_ids.is_empty() {
        return Err(ApiError::BadRequest("Selecione pelo menos uma empresa.".into()));
    }

    let existing = sql::select_one(db, "SELECT id FROM clients WHERE cnpj = $1", &params![normalized_cnpj]).await?;

    let mut statements = Vec::new();
    let existing_id = existing.as_ref().and_then(|r| r.get("id")).and_then(Value::as_i64);
    let client_id = match existing_id {
        Some(id) => Value::from(id),
        None => {
            statements.push(BatchStatement::new(
                "INSERT INTO clients (name, cnpj, night_start_time, night_end_time, night_shift_rule) VALUES ($1, $2, $3, $4, $5)",
                params![args.name.trim(), normalized_cnpj, args.night_start_time, args.night_end_time, args.night_shift_rule],
            ));
            let id = sql::last_insert_id_of(0);
            statements.extend(client_value_rule_inserts(id.clone(), &args.value_rules)?);
            id
        }
    };

    for company_id in &args.company_ids {
        statements.push(BatchStatement::new(
            "INSERT INTO client_companies (client_id, company_id)
            SELECT $1, $2
            WHERE NOT EXISTS (SELECT 1 FROM client_companies WHERE client_id = $1 AND company_id = $2)",
            vec![client_id.clone(), json!(company_id)],
        ));
    }

    let results = sql::run_batch(db, statements).await?;
    Ok(existing_id.unwrap_or(results[0].last_insert_id))
}

async fn create_client(State(state): State<AppState>, Json(args): Json<CreateClientArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_client_in(&state.db, args).await?))
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

/// `getClient`'s `ClientDetail`, as JSON.
pub(crate) async fn client_detail(db: &SqlitePool, id: i64) -> ApiResult<Row> {
    let mut row = sql::select_one(
        db,
        "SELECT id, name, cnpj, night_start_time AS nightStartTime, night_end_time AS nightEndTime,
            night_shift_rule AS nightShiftRule
     FROM clients WHERE id = $1",
        &params![id],
    )
    .await?
    .ok_or_else(|| ApiError::NotFound("Cliente não encontrado.".into()))?;
    let companies = sql::select(
        db,
        "SELECT c.id, c.name
     FROM client_companies cc
     JOIN companies c ON c.id = cc.company_id
     WHERE cc.client_id = $1
     ORDER BY c.name",
        &params![id],
    )
    .await?;
    let value_rule_rows = sql::select(
        db,
        "SELECT kind, conditions_json AS conditionsJson, operator, threshold_minutes AS thresholdMinutes, amount
     FROM client_payment_value_rules WHERE client_id = $1 ORDER BY id",
        &params![id],
    )
    .await?;
    let value_rules = value_rule_rows
        .into_iter()
        .map(|mut rule| {
            let conditions = match rule.shift_remove("conditionsJson") {
                Some(Value::String(text)) if !text.is_empty() => {
                    serde_json::from_str(&text).map_err(|e| ApiError::Internal(format!("conditions_json inválido no cliente {id}: {e}")))?
                }
                _ => json!([]),
            };
            rule.insert("conditions".into(), conditions);
            Ok(Value::Object(rule))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    row.insert("companies".into(), Value::Array(companies.into_iter().map(Value::Object).collect()));
    row.insert("valueRules".into(), Value::Array(value_rules));
    Ok(row)
}

async fn get_client(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(client_detail(&state.db, args.id).await?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientCompanyArgs {
    client_id: i64,
    company_id: i64,
}

async fn add_client_company(State(state): State<AppState>, Json(args): Json<ClientCompanyArgs>) -> ApiResult<StatusCode> {
    let existing_link = sql::select(
        &state.db,
        "SELECT client_id AS clientId FROM client_companies WHERE client_id = $1 AND company_id = $2",
        &params![args.client_id, args.company_id],
    )
    .await?;
    if existing_link.is_empty() {
        sql::execute(
            &state.db,
            "INSERT INTO client_companies (client_id, company_id) VALUES ($1, $2)",
            &params![args.client_id, args.company_id],
        )
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

fn count_of(row: Option<Row>) -> i64 {
    row.and_then(|r| r.get("count").and_then(Value::as_i64)).unwrap_or(0)
}

/// Refused when it would leave the client with no empresa, or when there are
/// colaboradores linked to that exact (cliente, empresa) pair.
async fn remove_client_company_in(db: &SqlitePool, client_id: i64, company_id: i64) -> ApiResult<()> {
    let link_count = sql::select_one(db, "SELECT COUNT(*) AS count FROM client_companies WHERE client_id = $1", &params![client_id]).await?;
    if count_of(link_count) <= 1 {
        return Err(ApiError::BadRequest("O cliente precisa continuar vinculado a pelo menos uma empresa.".into()));
    }
    let employee_count = sql::select_one(
        db,
        "SELECT COUNT(*) AS count FROM employee_client_companies WHERE client_id = $1 AND company_id = $2",
        &params![client_id, company_id],
    )
    .await?;
    if count_of(employee_count) > 0 {
        return Err(ApiError::Conflict(
            "Existem colaboradores cadastrados para esse cliente nessa empresa — desvincule ou mova-os antes.".into(),
        ));
    }
    sql::execute(db, "DELETE FROM client_companies WHERE client_id = $1 AND company_id = $2", &params![client_id, company_id]).await?;
    Ok(())
}

async fn remove_client_company(State(state): State<AppState>, Json(args): Json<ClientCompanyArgs>) -> ApiResult<StatusCode> {
    remove_client_company_in(&state.db, args.client_id, args.company_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateClientArgs {
    id: i64,
    name: String,
    cnpj: String,
    #[serde(default)]
    night_start_time: Option<String>,
    #[serde(default)]
    night_end_time: Option<String>,
    #[serde(default)]
    night_shift_rule: Option<String>,
    #[serde(default)]
    value_rules: Vec<PaymentValueRule>,
}

async fn update_client_in(db: &SqlitePool, args: UpdateClientArgs) -> ApiResult<()> {
    let normalized_cnpj = normalize_cnpj(&args.cnpj);
    if normalized_cnpj.len() != 14 {
        return Err(ApiError::BadRequest("CNPJ deve ter 14 dígitos.".into()));
    }
    let existing = sql::select(db, "SELECT id FROM clients WHERE cnpj = $1 AND id != $2", &params![normalized_cnpj, args.id]).await?;
    if !existing.is_empty() {
        return Err(ApiError::Conflict("Já existe um cliente cadastrado com esse CNPJ.".into()));
    }
    let mut statements = vec![
        BatchStatement::new(
            "UPDATE clients SET name = $1, cnpj = $2, night_start_time = $3, night_end_time = $4, night_shift_rule = $5 WHERE id = $6",
            params![args.name.trim(), normalized_cnpj, args.night_start_time, args.night_end_time, args.night_shift_rule, args.id],
        ),
        BatchStatement::new("DELETE FROM client_payment_value_rules WHERE client_id = $1", params![args.id]),
    ];
    statements.extend(client_value_rule_inserts(Value::from(args.id), &args.value_rules)?);
    sql::run_batch(db, statements).await?;
    Ok(())
}

async fn update_client(State(state): State<AppState>, Json(args): Json<UpdateClientArgs>) -> ApiResult<StatusCode> {
    update_client_in(&state.db, args).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The client's own override when it has one, falling back field by field
/// (night window) or as a whole chain (value rules) to the company's.
async fn effective_payment_rules(db: &SqlitePool, client_id: i64, company_id: i64) -> ApiResult<Value> {
    let client = client_detail(db, client_id).await?;
    let company = companies::get_company(db, company_id).await?;
    let field = |key: &str, fallback: &str| match client.get(key) {
        Some(Value::Null) | None => Value::from(fallback),
        Some(v) => v.clone(),
    };
    let client_rules = client.get("valueRules").and_then(Value::as_array).cloned().unwrap_or_default();
    let value_rules = if client_rules.is_empty() {
        serde_json::to_value(&company.value_rules).map_err(|e| ApiError::Internal(e.to_string()))?
    } else {
        Value::Array(client_rules)
    };
    Ok(json!({
        "nightStartTime": field("nightStartTime", &company.company.night_start_time),
        "nightEndTime": field("nightEndTime", &company.company.night_end_time),
        "nightShiftRule": field("nightShiftRule", &company.company.night_shift_rule),
        "valueRules": value_rules,
    }))
}

async fn get_effective_payment_rules(State(state): State<AppState>, Json(args): Json<ClientCompanyArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(effective_payment_rules(&state.db, args.client_id, args.company_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;

    async fn pool_with_companies() -> SqlitePool {
        let pool = test_pool().await;
        sql::execute(&pool, "INSERT INTO companies (id, name, cnpj) VALUES (1, 'A', '11111111111111'), (2, 'B', '22222222222222')", &[])
            .await
            .unwrap();
        pool
    }

    fn rule(kind: &str, amount: f64) -> PaymentValueRule {
        PaymentValueRule {
            kind: kind.into(),
            conditions: if kind == "condition" { vec![json!({ "column": "local", "value": "X" })] } else { vec![] },
            operator: (kind == "condition").then(|| ">=".into()),
            threshold_minutes: (kind == "condition").then_some(440),
            amount,
        }
    }

    fn create(company_ids: Vec<i64>, cnpj: &str, value_rules: Vec<PaymentValueRule>) -> CreateClientArgs {
        CreateClientArgs {
            company_ids,
            name: "  Cliente X ".into(),
            cnpj: cnpj.into(),
            night_start_time: None,
            night_end_time: None,
            night_shift_rule: None,
            value_rules,
        }
    }

    #[tokio::test]
    async fn create_then_recreate_by_cnpj_links_more_companies_without_touching_rules() {
        let pool = pool_with_companies().await;
        let id = create_client_in(&pool, create(vec![1], "33.333.333/3333-33", vec![rule("condition", 50.0), rule("else", 10.0)])).await.unwrap();
        let again = create_client_in(&pool, create(vec![1, 2], "33333333333333", vec![rule("else", 99.0)])).await.unwrap();
        assert_eq!(id, again);

        let detail = client_detail(&pool, id).await.unwrap();
        assert_eq!(detail["name"], json!("Cliente X"));
        assert_eq!(detail["companies"].as_array().unwrap().len(), 2);
        let rules = detail["valueRules"].as_array().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["conditions"], json!([{ "column": "local", "value": "X" }]));
        assert_eq!(rules[0]["thresholdMinutes"], json!(440));
        assert_eq!(rules[1]["conditions"], json!([]));
        assert_eq!(rules[1]["operator"], Value::Null);

        let err = create_client_in(&pool, create(vec![], "33333333333333", vec![])).await.unwrap_err();
        assert_eq!(err.to_string(), "Selecione pelo menos uma empresa.");
        let err = create_client_in(&pool, create(vec![1], "123", vec![])).await.unwrap_err();
        assert_eq!(err.to_string(), "CNPJ deve ter 14 dígitos.");
    }

    #[tokio::test]
    async fn effective_rules_fall_back_to_the_company() {
        let pool = pool_with_companies().await;
        let id = create_client_in(&pool, create(vec![1], "33333333333333", vec![])).await.unwrap();
        let rules = effective_payment_rules(&pool, id, 1).await.unwrap();
        assert_eq!(rules["nightStartTime"], json!("22:00"));
        assert_eq!(rules["valueRules"], json!([]));

        update_client_in(
            &pool,
            UpdateClientArgs {
                id,
                name: "Y".into(),
                cnpj: "33333333333333".into(),
                night_start_time: Some("21:00".into()),
                night_end_time: Some("06:00".into()),
                night_shift_rule: Some("majority-overlap".into()),
                value_rules: vec![rule("else", 7.5)],
            },
        )
        .await
        .unwrap();
        let rules = effective_payment_rules(&pool, id, 1).await.unwrap();
        assert_eq!(rules["nightStartTime"], json!("21:00"));
        assert_eq!(rules["nightShiftRule"], json!("majority-overlap"));
        assert_eq!(rules["valueRules"][0]["amount"], json!(7.5));
    }

    #[tokio::test]
    async fn update_refuses_another_clients_cnpj_and_unlink_keeps_one_company() {
        let pool = pool_with_companies().await;
        let a = create_client_in(&pool, create(vec![1, 2], "33333333333333", vec![])).await.unwrap();
        create_client_in(&pool, create(vec![1], "44444444444444", vec![])).await.unwrap();
        let err = update_client_in(
            &pool,
            UpdateClientArgs {
                id: a,
                name: "A".into(),
                cnpj: "44444444444444".into(),
                night_start_time: None,
                night_end_time: None,
                night_shift_rule: None,
                value_rules: vec![],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "Já existe um cliente cadastrado com esse CNPJ.");

        sql::execute(&pool, "INSERT INTO employees (id, name, cpf) VALUES (1, 'E', '12345678901')", &[]).await.unwrap();
        sql::execute(&pool, "INSERT INTO employee_client_companies (employee_id, client_id, company_id) VALUES (1, $1, 2)", &params![a])
            .await
            .unwrap();
        let err = remove_client_company_in(&pool, a, 2).await.unwrap_err();
        assert!(err.to_string().starts_with("Existem colaboradores"));
        remove_client_company_in(&pool, a, 1).await.unwrap();
        let err = remove_client_company_in(&pool, a, 2).await.unwrap_err();
        assert_eq!(err.to_string(), "O cliente precisa continuar vinculado a pelo menos uma empresa.");
    }
}
