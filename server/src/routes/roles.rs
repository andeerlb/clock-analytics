//! Funções (db.ts: listRoles … findRoleByName).
//! RPC endpoints: `POST /api/rpc/<nomeDaFunção>` — see server/PORTING.md.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};
use crate::sql::{self, BatchStatement, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listRoles", post(list_roles))
        .route("/rpc/listRolesGlobal", post(list_roles_global))
        .route("/rpc/getRole", post(get_role))
        .route("/rpc/createRole", post(create_role))
        .route("/rpc/updateRole", post(update_role))
        .route("/rpc/deleteRole", post(delete_role))
        .route("/rpc/listRoleAliases", post(list_role_aliases))
        .route("/rpc/findRoleAliasOwner", post(find_role_alias_owner))
        .route("/rpc/addRoleAlias", post(add_role_alias))
        .route("/rpc/removeRoleAlias", post(remove_role_alias))
        .route("/rpc/findRoleByName", post(find_role_by_name))
}

const DUPLICATE_ROLE: &str = "Já existe uma função com esse nome para essa empresa.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanyIdArgs {
    company_id: i64,
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleIdArgs {
    role_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AliasIdArgs {
    alias_id: i64,
}

async fn list_roles(State(state): State<AppState>, Json(args): Json<CompanyIdArgs>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(
        sql::select(
            &state.db,
            "SELECT id, company_id AS companyId, name FROM roles WHERE company_id = $1 ORDER BY name",
            &params![args.company_id],
        )
        .await?,
    ))
}

async fn list_roles_global(State(state): State<AppState>) -> ApiResult<Json<Vec<Row>>> {
    // Função lives on the turno, not the colaborador, so "colaboradores" here
    // means distinct people with at least one live turno in this função.
    Ok(Json(
        sql::select(
            &state.db,
            "SELECT r.id, r.company_id AS companyId, r.name,
               (SELECT COUNT(DISTINCT ps.employee_id) FROM payment_shifts ps WHERE ps.role_id = r.id AND ps.deleted_at IS NULL) AS employeeCount,
               (SELECT COUNT(*) FROM payment_shifts ps WHERE ps.role_id = r.id AND ps.deleted_at IS NULL) AS shiftCount
             FROM roles r ORDER BY r.name",
            &[],
        )
        .await?,
    ))
}

async fn get_role(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<Json<Value>> {
    let row = sql::select_one(&state.db, "SELECT id, company_id AS companyId, name FROM roles WHERE id = $1", &params![args.id])
        .await?
        .ok_or_else(|| ApiError::NotFound("Função não encontrada.".into()))?;
    Ok(Json(Value::Object(row)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoleArgs {
    company_id: i64,
    name: String,
}

pub(crate) async fn create_role_in(db: &SqlitePool, company_id: i64, name: &str) -> ApiResult<i64> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::BadRequest("Nome não pode ser vazio.".into()));
    }
    let existing = sql::select(db, "SELECT id FROM roles WHERE company_id = $1 AND lower(name) = lower($2)", &params![company_id, trimmed]).await?;
    if !existing.is_empty() {
        return Err(ApiError::Conflict(DUPLICATE_ROLE.into()));
    }
    let result = sql::execute(db, "INSERT INTO roles (company_id, name) VALUES ($1, $2)", &params![company_id, trimmed]).await?;
    Ok(result.last_insert_id)
}

async fn create_role(State(state): State<AppState>, Json(args): Json<CreateRoleArgs>) -> ApiResult<Json<i64>> {
    Ok(Json(create_role_in(&state.db, args.company_id, &args.name).await?))
}

#[derive(Deserialize)]
struct UpdateRoleArgs {
    id: i64,
    name: String,
}

async fn update_role_in(db: &SqlitePool, id: i64, name: &str) -> ApiResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::BadRequest("Nome não pode ser vazio.".into()));
    }
    let current = sql::select_one(db, "SELECT company_id AS companyId FROM roles WHERE id = $1", &params![id])
        .await?
        .ok_or_else(|| ApiError::NotFound("Função não encontrada.".into()))?;
    let company_id = current.get("companyId").cloned().unwrap_or(Value::Null);
    let existing = sql::select(
        db,
        "SELECT id FROM roles WHERE company_id = $1 AND lower(name) = lower($2) AND id != $3",
        &params![company_id, trimmed, id],
    )
    .await?;
    if !existing.is_empty() {
        return Err(ApiError::Conflict(DUPLICATE_ROLE.into()));
    }
    sql::execute(db, "UPDATE roles SET name = $1 WHERE id = $2", &params![trimmed, id]).await?;
    Ok(())
}

async fn update_role(State(state): State<AppState>, Json(args): Json<UpdateRoleArgs>) -> ApiResult<StatusCode> {
    update_role_in(&state.db, args.id, &args.name).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Existing shifts just lose the link (`role_id` → NULL) and keep their raw
/// `role` text, instead of being deleted along with the função.
async fn delete_role(State(state): State<AppState>, Json(args): Json<RoleIdArgs>) -> ApiResult<StatusCode> {
    let id = args.role_id;
    sql::run_batch(
        &state.db,
        vec![
            BatchStatement::new("UPDATE payment_shifts SET role_id = NULL WHERE role_id = $1", params![id]),
            BatchStatement::new("DELETE FROM role_aliases WHERE role_id = $1", params![id]),
            BatchStatement::new("DELETE FROM roles WHERE id = $1", params![id]),
        ],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_role_aliases(State(state): State<AppState>, Json(args): Json<RoleIdArgs>) -> ApiResult<Json<Vec<Row>>> {
    Ok(Json(
        sql::select(
            &state.db,
            "SELECT id, role_id AS roleId, alias FROM role_aliases WHERE role_id = $1 ORDER BY id DESC",
            &params![args.role_id],
        )
        .await?,
    ))
}

/// Scoped per empresa only, same granularity as `roles` itself.
async fn role_alias_owner(db: &SqlitePool, company_id: &Value, alias: &str) -> ApiResult<Option<Row>> {
    sql::select_one(
        db,
        "SELECT r.id, r.name
     FROM role_aliases ra
     JOIN roles r ON r.id = ra.role_id
     WHERE r.company_id = $1 AND lower(ra.alias) = lower($2)",
        &params![company_id, alias.trim()],
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindAliasOwnerArgs {
    company_id: i64,
    alias: String,
}

async fn find_role_alias_owner(State(state): State<AppState>, Json(args): Json<FindAliasOwnerArgs>) -> ApiResult<Json<Option<Row>>> {
    Ok(Json(role_alias_owner(&state.db, &Value::from(args.company_id), &args.alias).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddAliasArgs {
    role_id: i64,
    alias: String,
}

async fn add_role_alias_in(db: &SqlitePool, role_id: i64, alias: &str) -> ApiResult<()> {
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        return Err(ApiError::BadRequest("Nome não pode ser vazio.".into()));
    }
    let role = sql::select_one(db, "SELECT company_id AS companyId FROM roles WHERE id = $1", &params![role_id])
        .await?
        .ok_or_else(|| ApiError::NotFound("Função não encontrada.".into()))?;
    let company_id = role.get("companyId").cloned().unwrap_or(Value::Null);
    if let Some(owner) = role_alias_owner(db, &company_id, trimmed).await? {
        if owner.get("id").and_then(Value::as_i64) != Some(role_id) {
            let name = owner.get("name").and_then(Value::as_str).unwrap_or_default();
            return Err(ApiError::Conflict(format!("Esse nome já está vinculado à função {name}.")));
        }
        // Already registered to this same função: a silent no-op.
        return Ok(());
    }
    sql::execute(db, "INSERT INTO role_aliases (role_id, alias) VALUES ($1, $2)", &params![role_id, trimmed]).await?;
    Ok(())
}

async fn add_role_alias(State(state): State<AppState>, Json(args): Json<AddAliasArgs>) -> ApiResult<StatusCode> {
    add_role_alias_in(&state.db, args.role_id, &args.alias).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_role_alias(State(state): State<AppState>, Json(args): Json<AliasIdArgs>) -> ApiResult<StatusCode> {
    sql::execute(&state.db, "DELETE FROM role_aliases WHERE id = $1", &params![args.alias_id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FindByNameArgs {
    company_id: i64,
    #[serde(default)]
    text: Option<String>,
}

async fn find_role_by_name_in(db: &SqlitePool, company_id: i64, text: Option<&str>) -> ApiResult<Option<Row>> {
    let trimmed = text.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return Ok(None);
    }
    sql::select_one(
        db,
        "SELECT r.id, r.company_id AS companyId, r.name
     FROM roles r
     WHERE r.company_id = $1
       AND (lower(r.name) = lower($2) OR EXISTS (
         SELECT 1 FROM role_aliases ra WHERE ra.role_id = r.id AND lower(ra.alias) = lower($2)
       ))",
        &params![company_id, trimmed],
    )
    .await
}

pub(crate) async fn find_role_by_name(State(state): State<AppState>, Json(args): Json<FindByNameArgs>) -> ApiResult<Json<Option<Row>>> {
    Ok(Json(find_role_by_name_in(&state.db, args.company_id, args.text.as_deref()).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;

    async fn pool_with_company() -> SqlitePool {
        let pool = test_pool().await;
        sql::execute(&pool, "INSERT INTO companies (id, name, cnpj) VALUES (1, 'A', '11111111111111'), (2, 'B', '22222222222222')", &[])
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn names_are_unique_per_company_case_insensitively() {
        let pool = pool_with_company().await;
        let id = create_role_in(&pool, 1, "  Vigilante ").await.unwrap();
        let err = create_role_in(&pool, 1, "VIGILANTE").await.unwrap_err();
        assert_eq!(err.to_string(), DUPLICATE_ROLE);
        // Another empresa can use the same name.
        let other = create_role_in(&pool, 2, "Vigilante").await.unwrap();
        assert!(matches!(create_role_in(&pool, 1, "  ").await.unwrap_err(), ApiError::BadRequest(_)));

        // Renaming to itself is fine; to a taken name is not.
        update_role_in(&pool, id, "vigilante").await.unwrap();
        let second = create_role_in(&pool, 1, "Porteiro").await.unwrap();
        assert_eq!(update_role_in(&pool, second, "Vigilante").await.unwrap_err().to_string(), DUPLICATE_ROLE);
        assert!(matches!(update_role_in(&pool, 999, "x").await.unwrap_err(), ApiError::NotFound(_)));
        assert_ne!(id, other);
    }

    #[tokio::test]
    async fn aliases_resolve_names_and_refuse_another_roles_alias() {
        let pool = pool_with_company().await;
        let vig = create_role_in(&pool, 1, "Vigilante").await.unwrap();
        let por = create_role_in(&pool, 1, "Porteiro").await.unwrap();
        add_role_alias_in(&pool, vig, "Vig. Patrimonial").await.unwrap();
        // Same função again is a no-op, not a duplicate row.
        add_role_alias_in(&pool, vig, "vig. patrimonial").await.unwrap();
        let count = sql::select(&pool, "SELECT id FROM role_aliases", &[]).await.unwrap().len();
        assert_eq!(count, 1);

        let err = add_role_alias_in(&pool, por, "VIG. PATRIMONIAL").await.unwrap_err();
        assert_eq!(err.to_string(), "Esse nome já está vinculado à função Vigilante.");

        let found = find_role_by_name_in(&pool, 1, Some(" vig. PATRIMONIAL ")).await.unwrap().unwrap();
        assert_eq!(found.get("id").and_then(Value::as_i64), Some(vig));
        let by_name = find_role_by_name_in(&pool, 1, Some("porteiro")).await.unwrap().unwrap();
        assert_eq!(by_name.get("companyId").and_then(Value::as_i64), Some(1));
        assert!(find_role_by_name_in(&pool, 2, Some("porteiro")).await.unwrap().is_none());
        assert!(find_role_by_name_in(&pool, 1, None).await.unwrap().is_none());
    }
}
