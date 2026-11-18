//! Import templates (`payment_templates` + groups/sheets/fields/rules), Excel
//! export templates and PDF templates.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{bool_field, json_text, parse_json_field};
use crate::error::{ApiError, ApiResult};
use crate::sql::{self, BatchStatement, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listPaymentTemplates", post(list_payment_templates))
        .route("/rpc/getPaymentTemplate", post(get_payment_template))
        .route("/rpc/createPaymentTemplate", post(create_payment_template))
        .route("/rpc/updatePaymentTemplate", post(update_payment_template))
        .route("/rpc/deletePaymentTemplate", post(delete_payment_template))
        .route("/rpc/listPaymentExportTemplates", post(list_payment_export_templates))
        .route("/rpc/getPaymentExportTemplate", post(get_payment_export_template))
        .route("/rpc/createPaymentExportTemplate", post(create_payment_export_template))
        .route("/rpc/updatePaymentExportTemplate", post(update_payment_export_template))
        .route("/rpc/clonePaymentExportTemplate", post(clone_payment_export_template))
        .route("/rpc/deletePaymentExportTemplate", post(delete_payment_export_template))
        .route("/rpc/listPaymentPdfTemplates", post(list_payment_pdf_templates))
        .route("/rpc/getPaymentPdfTemplate", post(get_payment_pdf_template))
        .route("/rpc/createPaymentPdfTemplate", post(create_payment_pdf_template))
        .route("/rpc/updatePaymentPdfTemplate", post(update_payment_pdf_template))
        .route("/rpc/clonePaymentPdfTemplate", post(clone_payment_pdf_template))
        .route("/rpc/deletePaymentPdfTemplate", post(delete_payment_pdf_template))
}

#[derive(Deserialize)]
pub(crate) struct IdArgs {
    pub id: i64,
}

// --- import templates --------------------------------------------------------

/// `parseAcceptedFileKinds`: NULL (templates predating the column) → `[fileKind]`.
fn take_accepted_file_kinds(row: &mut Row) -> ApiResult<()> {
    let json = row.remove("acceptedFileKindsJson");
    let kinds = match json {
        Some(Value::String(text)) if !text.is_empty() => {
            serde_json::from_str(&text).map_err(|e| ApiError::Internal(format!("accepted_file_kinds_json inválido: {e}")))?
        }
        _ => json!([super::field(row, "fileKind")]),
    };
    row.insert("acceptedFileKinds".into(), kinds);
    Ok(())
}

pub(crate) async fn list_payment_templates_impl(state: &AppState) -> ApiResult<Vec<Value>> {
    let rows = sql::select(
        &state.db,
        "
    SELECT pt.id, pt.name, pt.file_kind AS fileKind, pt.accepted_file_kinds_json AS acceptedFileKindsJson, pt.updated_at AS updatedAt
    FROM payment_templates pt
    ORDER BY pt.updated_at DESC
  ",
        &[],
    )
    .await?;
    rows.into_iter()
        .map(|mut row| {
            take_accepted_file_kinds(&mut row)?;
            Ok(Value::Object(row))
        })
        .collect()
}

async fn list_payment_templates(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(list_payment_templates_impl(&state).await?))
}

/// A routing/status rule row → `{ ...rest, conditions }`: `conditions_json`
/// when set, else the legacy single `field`/`values_json`/`case_insensitive`
/// condition, else `[]`.
fn rule_conditions(mut row: Row) -> ApiResult<Value> {
    let field = row.remove("field").unwrap_or(Value::Null);
    let values_json = row.remove("valuesJson").unwrap_or(Value::Null);
    let mut case_row = Row::new();
    case_row.insert("c".into(), row.remove("caseInsensitive").unwrap_or(Value::Null));
    bool_field(&mut case_row, "c");
    let conditions_json = row.remove("conditionsJson").unwrap_or(Value::Null);

    let parse = |text: &str| serde_json::from_str::<Value>(text).map_err(|e| ApiError::Internal(format!("regra com JSON inválido: {e}")));
    let conditions = match (&conditions_json, &field) {
        (Value::String(text), _) if !text.is_empty() => parse(text)?,
        (_, Value::String(f)) if !f.is_empty() => {
            let values = match &values_json {
                Value::String(text) if !text.is_empty() => parse(text)?,
                _ => json!([]),
            };
            json!([{ "field": field, "values": values, "caseInsensitive": case_row["c"] }])
        }
        _ => json!([]),
    };
    row.insert("conditions".into(), conditions);
    Ok(Value::Object(row))
}

pub(crate) async fn get_payment_template_impl(state: &AppState, id: i64) -> ApiResult<Value> {
    let db = &state.db;
    let mut row = sql::select_one(
        db,
        "SELECT pt.id, pt.name, pt.file_kind AS fileKind, pt.accepted_file_kinds_json AS acceptedFileKindsJson, pt.delimiter,
            pt.date_format AS dateFormat, pt.identifier_priority AS identifierPriority,
            pt.created_at AS createdAt, pt.updated_at AS updatedAt
     FROM payment_templates pt
     WHERE pt.id = $1",
        &params![id],
    )
    .await?
    .ok_or_else(|| ApiError::NotFound("Template não encontrado.".into()))?;

    let group_rows = sql::select(db, "SELECT id FROM payment_template_groups WHERE template_id = $1", &params![id]).await?;
    let mut groups = Vec::with_capacity(group_rows.len());
    for g in group_rows {
        let group_id = super::field(&g, "id");
        let sheet_rows = sql::select(
            db,
            "SELECT sheet_name AS sheetName, included
       FROM payment_template_sheets
       WHERE group_id = $1
       ORDER BY sheet_name",
            std::slice::from_ref(&group_id),
        )
        .await?;
        let field_mappings = sql::select(
            db,
            "SELECT column_letter AS columnLetter, target_field AS targetField, header_label AS headerLabel
       FROM payment_template_fields
       WHERE group_id = $1
       ORDER BY column_letter",
            std::slice::from_ref(&group_id),
        )
        .await?;
        let (mut included, mut excluded) = (Vec::new(), Vec::new());
        for mut sheet in sheet_rows {
            bool_field(&mut sheet, "included");
            let name = super::field(&sheet, "sheetName");
            if sheet["included"] == Value::Bool(true) {
                included.push(name);
            } else {
                excluded.push(name);
            }
        }
        groups.push(json!({ "sheetNames": included, "excludedSheetNames": excluded, "fieldMappings": field_mappings }));
    }

    let rule_rows = sql::select(
        db,
        "SELECT r.kind, r.field, r.values_json AS valuesJson, r.case_insensitive AS caseInsensitive,
            r.conditions_json AS conditionsJson,
            r.company_id AS companyId, c.name AS companyName,
            r.client_id AS clientId, cl.name AS clientName
     FROM payment_template_rules r
     JOIN companies c ON c.id = r.company_id
     JOIN clients cl ON cl.id = r.client_id
     WHERE r.template_id = $1
     ORDER BY r.id",
        &params![id],
    )
    .await?;
    let rules = rule_rows.into_iter().map(rule_conditions).collect::<ApiResult<Vec<_>>>()?;

    let status_rule_rows = sql::select(
        db,
        "SELECT kind, field, values_json AS valuesJson, case_insensitive AS caseInsensitive,
            conditions_json AS conditionsJson, status
     FROM payment_template_status_rules
     WHERE template_id = $1
     ORDER BY id",
        &params![id],
    )
    .await?;
    let status_rules = status_rule_rows.into_iter().map(rule_conditions).collect::<ApiResult<Vec<_>>>()?;

    parse_json_field(&mut row, "identifierPriority")?;
    take_accepted_file_kinds(&mut row)?;
    row.insert("groups".into(), Value::Array(groups));
    row.insert("rules".into(), Value::Array(rules));
    row.insert("statusRules".into(), Value::Array(status_rules));
    Ok(Value::Object(row))
}

async fn get_payment_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(get_payment_template_impl(&state, args.id).await?))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplateFieldMapping {
    pub column_letter: String,
    pub target_field: String,
    pub header_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplateGroup {
    pub sheet_names: Vec<String>,
    pub excluded_sheet_names: Vec<String>,
    pub field_mappings: Vec<TemplateFieldMapping>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplateRuleInput {
    pub kind: String,
    #[serde(default)]
    pub conditions: Vec<Value>,
    pub company_id: i64,
    pub client_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplateStatusRuleInput {
    pub kind: String,
    #[serde(default)]
    pub conditions: Vec<Value>,
    pub status: String,
}

/// `PaymentTemplateInput`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaymentTemplateInput {
    pub name: String,
    pub file_kind: String,
    pub accepted_file_kinds: Vec<String>,
    pub delimiter: Option<String>,
    pub date_format: String,
    pub identifier_priority: Vec<Value>,
    pub groups: Vec<TemplateGroup>,
    pub rules: Vec<TemplateRuleInput>,
    pub status_rules: Vec<TemplateStatusRuleInput>,
}

fn push_group_inserts(statements: &mut Vec<BatchStatement>, template_id: &Value, groups: &[TemplateGroup]) {
    for group in groups {
        let group_id = sql::last_insert_id_of(statements.len());
        statements.push(BatchStatement::new("INSERT INTO payment_template_groups (template_id) VALUES ($1)", vec![template_id.clone()]));
        for sheet in &group.sheet_names {
            statements.push(BatchStatement::new(
                "INSERT INTO payment_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 1)",
                vec![group_id.clone(), json!(sheet)],
            ));
        }
        for sheet in &group.excluded_sheet_names {
            statements.push(BatchStatement::new(
                "INSERT INTO payment_template_sheets (group_id, sheet_name, included) VALUES ($1, $2, 0)",
                vec![group_id.clone(), json!(sheet)],
            ));
        }
        for mapping in &group.field_mappings {
            statements.push(BatchStatement::new(
                "INSERT INTO payment_template_fields (group_id, column_letter, target_field, header_label)
         VALUES ($1, $2, $3, $4)",
                vec![group_id.clone(), json!(mapping.column_letter), json!(mapping.target_field), json!(mapping.header_label)],
            ));
        }
    }
}

fn delete_groups_statements(template_id: i64) -> Vec<BatchStatement> {
    let group_ids = "SELECT id FROM payment_template_groups WHERE template_id = $1";
    vec![
        BatchStatement::new(format!("DELETE FROM payment_template_fields WHERE group_id IN ({group_ids})"), params![template_id]),
        BatchStatement::new(format!("DELETE FROM payment_template_sheets WHERE group_id IN ({group_ids})"), params![template_id]),
        BatchStatement::new("DELETE FROM payment_template_groups WHERE template_id = $1", params![template_id]),
    ]
}

/// Inserted in array order — evaluation order matches insertion (id) order.
fn push_rule_inserts(statements: &mut Vec<BatchStatement>, template_id: &Value, rules: &[TemplateRuleInput]) -> ApiResult<()> {
    for rule in rules {
        let conditions = if rule.kind == "condition" { Value::String(json_text(&rule.conditions)?) } else { Value::Null };
        statements.push(BatchStatement::new(
            "INSERT INTO payment_template_rules
         (template_id, kind, conditions_json, company_id, client_id)
       VALUES ($1, $2, $3, $4, $5)",
            vec![template_id.clone(), json!(rule.kind), conditions, json!(rule.company_id), json!(rule.client_id)],
        ));
    }
    Ok(())
}

fn push_status_rule_inserts(statements: &mut Vec<BatchStatement>, template_id: &Value, rules: &[TemplateStatusRuleInput]) -> ApiResult<()> {
    for rule in rules {
        let conditions = if rule.kind == "condition" { Value::String(json_text(&rule.conditions)?) } else { Value::Null };
        statements.push(BatchStatement::new(
            "INSERT INTO payment_template_status_rules
         (template_id, kind, conditions_json, status)
       VALUES ($1, $2, $3, $4)",
            vec![template_id.clone(), json!(rule.kind), conditions, json!(rule.status)],
        ));
    }
    Ok(())
}

pub(crate) async fn create_payment_template_impl(state: &AppState, input: &PaymentTemplateInput) -> ApiResult<i64> {
    let mut statements = vec![BatchStatement::new(
        "INSERT INTO payment_templates (name, file_kind, accepted_file_kinds_json, delimiter, date_format, identifier_priority)
     VALUES ($1, $2, $3, $4, $5, $6)",
        vec![
            json!(input.name),
            json!(input.file_kind),
            json!(json_text(&input.accepted_file_kinds)?),
            json!(input.delimiter),
            json!(input.date_format),
            json!(json_text(&input.identifier_priority)?),
        ],
    )];
    let template_id = sql::last_insert_id_of(0);
    push_group_inserts(&mut statements, &template_id, &input.groups);
    push_rule_inserts(&mut statements, &template_id, &input.rules)?;
    push_status_rule_inserts(&mut statements, &template_id, &input.status_rules)?;
    let results = sql::run_batch(&state.db, statements).await?;
    Ok(results[0].last_insert_id)
}

#[derive(Deserialize)]
struct CreateTemplateArgs {
    input: PaymentTemplateInput,
}

async fn create_payment_template(State(state): State<AppState>, Json(args): Json<CreateTemplateArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_payment_template_impl(&state, &args.input).await?))
}

pub(crate) async fn update_payment_template_impl(state: &AppState, id: i64, input: &PaymentTemplateInput) -> ApiResult<()> {
    let mut statements = vec![BatchStatement::new(
        "UPDATE payment_templates SET
       name = $1, file_kind = $2, accepted_file_kinds_json = $3, delimiter = $4, date_format = $5,
       identifier_priority = $6, updated_at = datetime('now')
     WHERE id = $7",
        vec![
            json!(input.name),
            json!(input.file_kind),
            json!(json_text(&input.accepted_file_kinds)?),
            json!(input.delimiter),
            json!(input.date_format),
            json!(json_text(&input.identifier_priority)?),
            json!(id),
        ],
    )];
    statements.extend(delete_groups_statements(id));
    statements.push(BatchStatement::new("DELETE FROM payment_template_rules WHERE template_id = $1", params![id]));
    statements.push(BatchStatement::new("DELETE FROM payment_template_status_rules WHERE template_id = $1", params![id]));
    let template_id = json!(id);
    push_group_inserts(&mut statements, &template_id, &input.groups);
    push_rule_inserts(&mut statements, &template_id, &input.rules)?;
    push_status_rule_inserts(&mut statements, &template_id, &input.status_rules)?;
    sql::run_batch(&state.db, statements).await?;
    Ok(())
}

#[derive(Deserialize)]
struct UpdateTemplateArgs {
    id: i64,
    input: PaymentTemplateInput,
}

async fn update_payment_template(State(state): State<AppState>, Json(args): Json<UpdateTemplateArgs>) -> ApiResult<StatusCode> {
    update_payment_template_impl(&state, args.id, &args.input).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes the template and its groups/rules; imported shifts keep existing,
/// only losing the informational back-reference.
async fn delete_payment_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    let id = args.id;
    let mut statements = vec![BatchStatement::new("UPDATE payment_shifts SET template_id = NULL WHERE template_id = $1", params![id])];
    statements.extend(delete_groups_statements(id));
    statements.extend([
        BatchStatement::new("DELETE FROM payment_template_rules WHERE template_id = $1", params![id]),
        BatchStatement::new("DELETE FROM payment_template_status_rules WHERE template_id = $1", params![id]),
        BatchStatement::new("DELETE FROM payment_templates WHERE id = $1", params![id]),
    ]);
    sql::run_batch(&state.db, statements).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- export (Excel) and PDF templates: same shape, different table -----------

/// The two `config_json` template tables, which share every function.
#[derive(Clone, Copy)]
pub(crate) enum ConfigTable {
    Export,
    Pdf,
}

impl ConfigTable {
    fn table(self) -> &'static str {
        match self {
            ConfigTable::Export => "payment_export_templates",
            ConfigTable::Pdf => "payment_pdf_templates",
        }
    }

    fn not_found(self) -> ApiError {
        ApiError::NotFound(
            match self {
                ConfigTable::Export => "Template de exportação não encontrado.",
                ConfigTable::Pdf => "Template de PDF não encontrado.",
            }
            .into(),
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ConfigTemplateInput {
    pub name: String,
    pub config: Value,
}

pub(crate) async fn list_config_templates(state: &AppState, kind: ConfigTable) -> ApiResult<Vec<Row>> {
    sql::select(&state.db, &format!("SELECT id, name, updated_at AS updatedAt FROM {} ORDER BY updated_at DESC", kind.table()), &[]).await
}

pub(crate) async fn get_config_template(state: &AppState, kind: ConfigTable, id: i64) -> ApiResult<Value> {
    let mut row = sql::select_one(
        &state.db,
        &format!(
            "SELECT id, name, config_json AS configJson, created_at AS createdAt, updated_at AS updatedAt FROM {} WHERE id = $1",
            kind.table()
        ),
        &params![id],
    )
    .await?
    .ok_or_else(|| kind.not_found())?;
    let config_json = row.remove("configJson").unwrap_or(Value::Null);
    let config: Value = match config_json {
        Value::String(text) => serde_json::from_str(&text).map_err(|e| ApiError::Internal(format!("config_json inválido: {e}")))?,
        _ => return Err(ApiError::Internal("config_json ausente".into())),
    };
    row.insert("config".into(), config);
    Ok(Value::Object(row))
}

pub(crate) async fn create_config_template(state: &AppState, kind: ConfigTable, input: &ConfigTemplateInput) -> ApiResult<i64> {
    let result = sql::execute(
        &state.db,
        &format!("INSERT INTO {} (name, config_json) VALUES ($1, $2)", kind.table()),
        &params![input.name, json_text(&input.config)?],
    )
    .await?;
    Ok(result.last_insert_id)
}

pub(crate) async fn update_config_template(state: &AppState, kind: ConfigTable, id: i64, input: &ConfigTemplateInput) -> ApiResult<()> {
    sql::execute(
        &state.db,
        &format!("UPDATE {} SET name = $1, config_json = $2, updated_at = datetime('now') WHERE id = $3", kind.table()),
        &params![input.name, json_text(&input.config)?, id],
    )
    .await?;
    Ok(())
}

/// An independent copy, including the entire grid configuration.
pub(crate) async fn clone_config_template(state: &AppState, kind: ConfigTable, id: i64) -> ApiResult<i64> {
    let table = kind.table();
    let result = sql::execute(
        &state.db,
        &format!(
            "INSERT INTO {table} (name, config_json)
     SELECT name || ' (cópia)', config_json
     FROM {table}
     WHERE id = $1"
        ),
        &params![id],
    )
    .await?;
    if result.rows_affected == 0 {
        return Err(kind.not_found());
    }
    Ok(result.last_insert_id)
}

async fn delete_config_template(state: &AppState, kind: ConfigTable, id: i64) -> ApiResult<()> {
    sql::execute(&state.db, &format!("DELETE FROM {} WHERE id = $1", kind.table()), &params![id]).await?;
    Ok(())
}

#[derive(Deserialize)]
struct CreateConfigArgs {
    input: ConfigTemplateInput,
}

#[derive(Deserialize)]
struct UpdateConfigArgs {
    id: i64,
    input: ConfigTemplateInput,
}

async fn list_payment_export_templates(State(state): State<AppState>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(list_config_templates(&state, ConfigTable::Export).await?))
}

async fn get_payment_export_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(get_config_template(&state, ConfigTable::Export, args.id).await?))
}

async fn create_payment_export_template(State(state): State<AppState>, Json(args): Json<CreateConfigArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_config_template(&state, ConfigTable::Export, &args.input).await?))
}

async fn update_payment_export_template(State(state): State<AppState>, Json(args): Json<UpdateConfigArgs>) -> ApiResult<StatusCode> {
    update_config_template(&state, ConfigTable::Export, args.id, &args.input).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clone_payment_export_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(clone_config_template(&state, ConfigTable::Export, args.id).await?))
}

async fn delete_payment_export_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    delete_config_template(&state, ConfigTable::Export, args.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_payment_pdf_templates(State(state): State<AppState>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(list_config_templates(&state, ConfigTable::Pdf).await?))
}

async fn get_payment_pdf_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    Ok(Json(get_config_template(&state, ConfigTable::Pdf, args.id).await?))
}

async fn create_payment_pdf_template(State(state): State<AppState>, Json(args): Json<CreateConfigArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_config_template(&state, ConfigTable::Pdf, &args.input).await?))
}

async fn update_payment_pdf_template(State(state): State<AppState>, Json(args): Json<UpdateConfigArgs>) -> ApiResult<StatusCode> {
    update_config_template(&state, ConfigTable::Pdf, args.id, &args.input).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clone_payment_pdf_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(clone_config_template(&state, ConfigTable::Pdf, args.id).await?))
}

async fn delete_payment_pdf_template(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    delete_config_template(&state, ConfigTable::Pdf, args.id).await?;
    Ok(StatusCode::NO_CONTENT)
}
