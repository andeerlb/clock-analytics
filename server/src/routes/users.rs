//! Usuários e perfis: the screen where whoever may manage users adds people
//! by e-mail and builds the profiles (see `access.rs` for what a profile
//! allows and how every request is checked).

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::access::{parse_permissions, Access, Permissions};
use crate::error::{ApiError, ApiResult};
use crate::sql::{self, Row};
use crate::{params, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listAppUsers", post(list_app_users))
        .route("/rpc/addAppUser", post(add_app_user))
        .route("/rpc/setAppUserProfile", post(set_app_user_profile))
        .route("/rpc/removeAppUser", post(remove_app_user))
        .route("/rpc/listAccessProfiles", post(list_access_profiles))
        .route("/rpc/createAccessProfile", post(create_access_profile))
        .route("/rpc/updateAccessProfile", post(update_access_profile))
        .route("/rpc/deleteAccessProfile", post(delete_access_profile))
}

fn normalize_email(email: &str) -> ApiResult<String> {
    let email = email.trim().to_lowercase();
    let valid = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if !valid {
        return Err(ApiError::BadRequest("Informe um e-mail válido.".into()));
    }
    Ok(email)
}

fn is_initial_admin(state: &AppState, email: &str) -> bool {
    state.initial_admins.iter().any(|e| e == email)
}

async fn profile_exists(state: &AppState, id: i64) -> ApiResult<()> {
    sql::select_one(&state.db, "SELECT id FROM access_profiles WHERE id = $1", &params![id])
        .await?
        .map(|_| ())
        .ok_or_else(|| ApiError::NotFound("Esse perfil não existe mais.".into()))
}

// --- Usuários -----------------------------------------------------------------

/// Initial admins first (fixed), then everyone registered on screen.
async fn list_app_users(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let mut out: Vec<Value> = state
        .initial_admins
        .iter()
        .map(|email| json!({ "email": email, "initialAdmin": true, "profileId": null, "profileName": "Admin", "addedBy": null, "createdAt": null, "lastSeenAt": null }))
        .collect();
    let rows = sql::select(
        &state.db,
        "SELECT u.email, u.profile_id AS profileId, p.name AS profileName, u.added_by AS addedBy,
                u.created_at AS createdAt, u.last_seen_at AS lastSeenAt
         FROM app_users u JOIN access_profiles p ON p.id = u.profile_id
         ORDER BY u.email",
        &[],
    )
    .await?;
    out.extend(rows.into_iter().filter(|r| !r.get("email").and_then(Value::as_str).is_some_and(|e| is_initial_admin(&state, e))).map(|mut r: Row| {
        r.insert("initialAdmin".into(), Value::Bool(false));
        Value::Object(r)
    }));
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserArgs {
    email: String,
    profile_id: i64,
}

async fn add_app_user(State(state): State<AppState>, Extension(me): Extension<Access>, Json(args): Json<UserArgs>) -> ApiResult<StatusCode> {
    let email = normalize_email(&args.email)?;
    if is_initial_admin(&state, &email) {
        return Err(ApiError::Conflict("Esse e-mail já é admin inicial, definido no servidor.".into()));
    }
    profile_exists(&state, args.profile_id).await?;
    let inserted = sql::execute(
        &state.db,
        "INSERT INTO app_users (email, profile_id, added_by) VALUES ($1, $2, $3) ON CONFLICT(email) DO NOTHING",
        &params![email, args.profile_id, me.email],
    )
    .await?;
    if inserted.rows_affected == 0 {
        return Err(ApiError::Conflict("Esse e-mail já está cadastrado.".into()));
    }
    tracing::info!(%email, added_by = %me.email, "usuário adicionado");
    Ok(StatusCode::NO_CONTENT)
}

async fn set_app_user_profile(State(state): State<AppState>, Json(args): Json<UserArgs>) -> ApiResult<StatusCode> {
    let email = normalize_email(&args.email)?;
    if is_initial_admin(&state, &email) {
        return Err(ApiError::BadRequest("O perfil de um admin inicial não muda por aqui.".into()));
    }
    profile_exists(&state, args.profile_id).await?;
    let updated = sql::execute(
        &state.db,
        "UPDATE app_users SET profile_id = $2, updated_at = datetime('now') WHERE email = $1",
        &params![email, args.profile_id],
    )
    .await?;
    if updated.rows_affected == 0 {
        return Err(ApiError::NotFound("Esse usuário não existe mais.".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct EmailArgs {
    email: String,
}

async fn remove_app_user(State(state): State<AppState>, Extension(me): Extension<Access>, Json(args): Json<EmailArgs>) -> ApiResult<StatusCode> {
    let email = normalize_email(&args.email)?;
    if is_initial_admin(&state, &email) {
        return Err(ApiError::BadRequest("Um admin inicial não pode ser removido por aqui.".into()));
    }
    if email == me.email {
        return Err(ApiError::BadRequest("Você não pode remover a si mesmo.".into()));
    }
    sql::execute(&state.db, "DELETE FROM app_users WHERE email = $1", &params![email]).await?;
    tracing::info!(%email, removed_by = %me.email, "usuário removido");
    Ok(StatusCode::NO_CONTENT)
}

// --- Perfis -------------------------------------------------------------------

async fn list_access_profiles(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let rows = sql::select(
        &state.db,
        "SELECT p.id, p.name, p.permissions_json AS permissionsJson, p.is_admin AS isAdmin,
                (SELECT COUNT(*) FROM app_users u WHERE u.profile_id = p.id) AS userCount
         FROM access_profiles p
         ORDER BY p.is_admin DESC, p.name",
        &[],
    )
    .await?;
    rows.into_iter()
        .map(|mut row| {
            let is_admin = row.get("isAdmin").and_then(Value::as_i64).unwrap_or(0) != 0;
            let permissions = if is_admin { Permissions::admin() } else { parse_permissions(row.get("permissionsJson"))? };
            row.remove("permissionsJson");
            row.insert("isAdmin".into(), Value::Bool(is_admin));
            row.insert("permissions".into(), serde_json::to_value(permissions).map_err(|e| ApiError::Internal(e.to_string()))?);
            Ok(Value::Object(row))
        })
        .collect::<ApiResult<Vec<_>>>()
        .map(Json)
}

#[derive(Deserialize)]
struct ProfileInput {
    name: String,
    permissions: Permissions,
}

fn validate_profile(input: ProfileInput) -> ApiResult<(String, String)> {
    let name = input.name.trim().to_owned();
    if name.is_empty() {
        return Err(ApiError::BadRequest("Dê um nome ao perfil.".into()));
    }
    if name.chars().count() > 60 {
        return Err(ApiError::BadRequest("O nome do perfil pode ter até 60 caracteres.".into()));
    }
    let permissions = serde_json::to_string(&input.permissions.normalized()).map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok((name, permissions))
}

fn name_taken(error: ApiError) -> ApiError {
    match &error {
        ApiError::Database(sqlx::Error::Database(db)) if db.is_unique_violation() => ApiError::Conflict("Já existe um perfil com esse nome.".into()),
        _ => error,
    }
}

async fn create_access_profile(State(state): State<AppState>, Json(args): Json<ProfileInput>) -> ApiResult<Json<i64>> {
    let (name, permissions) = validate_profile(args)?;
    let result = sql::execute(&state.db, "INSERT INTO access_profiles (name, permissions_json) VALUES ($1, $2)", &params![name, permissions])
        .await
        .map_err(name_taken)?;
    Ok(Json(result.last_insert_id))
}

#[derive(Deserialize)]
struct UpdateProfileArgs {
    id: i64,
    #[serde(flatten)]
    input: ProfileInput,
}

async fn is_fixed_admin(state: &AppState, id: i64) -> ApiResult<bool> {
    let row = sql::select_one(&state.db, "SELECT is_admin AS isAdmin FROM access_profiles WHERE id = $1", &params![id])
        .await?
        .ok_or_else(|| ApiError::NotFound("Esse perfil não existe mais.".into()))?;
    Ok(row.get("isAdmin").and_then(Value::as_i64).unwrap_or(0) != 0)
}

async fn update_access_profile(State(state): State<AppState>, Json(args): Json<UpdateProfileArgs>) -> ApiResult<StatusCode> {
    if is_fixed_admin(&state, args.id).await? {
        return Err(ApiError::BadRequest("O perfil Admin é fixo: tem tudo liberado e não pode ser alterado.".into()));
    }
    let (name, permissions) = validate_profile(args.input)?;
    sql::execute(
        &state.db,
        "UPDATE access_profiles SET name = $2, permissions_json = $3, updated_at = datetime('now') WHERE id = $1",
        &params![args.id, name, permissions],
    )
    .await
    .map_err(name_taken)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct IdArgs {
    id: i64,
}

async fn delete_access_profile(State(state): State<AppState>, Json(args): Json<IdArgs>) -> ApiResult<StatusCode> {
    if is_fixed_admin(&state, args.id).await? {
        return Err(ApiError::BadRequest("O perfil Admin é fixo e não pode ser excluído.".into()));
    }
    let in_use = sql::select_one(&state.db, "SELECT COUNT(*) AS n FROM app_users WHERE profile_id = $1", &params![args.id]).await?;
    let count = in_use.and_then(|r| r.get("n").and_then(Value::as_i64)).unwrap_or(0);
    if count > 0 {
        return Err(ApiError::Conflict(format!(
            "Esse perfil está em uso por {count} {}. Troque o perfil {} antes de excluir.",
            if count == 1 { "pessoa" } else { "pessoas" },
            if count == 1 { "dela" } else { "delas" }
        )));
    }
    sql::execute(&state.db, "DELETE FROM access_profiles WHERE id = $1", &params![args.id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::call;

    fn admin(email: &str) -> Access {
        Access { email: email.into(), initial_admin: false, profile_name: "Admin".into(), is_admin: true, permissions: Permissions::admin() }
    }

    async fn state() -> AppState {
        AppState::for_tests().await.with_initial_admins(vec!["dono@gmail.com".into()])
    }

    async fn profile_id(state: &AppState, name: &str) -> i64 {
        sql::select_one(&state.db, "SELECT id FROM access_profiles WHERE name = $1", &params![name]).await.unwrap().unwrap()["id"].as_i64().unwrap()
    }

    async fn add(state: &AppState, by: &str, email: &str, profile: i64) -> ApiResult<Value> {
        let me = admin(by);
        call(state, move |s, j| add_app_user(s, Extension(me), j), json!({ "email": email, "profileId": profile })).await
    }

    #[tokio::test]
    async fn adding_listing_and_removing_people() {
        let state = state().await;
        let viewer = profile_id(&state, "Visualizador").await;
        add(&state, "dono@gmail.com", "  Contabil@Escritorio.com.br ", viewer).await.unwrap();

        let users = call(&state, |s, _: Json<Value>| list_app_users(s), json!({})).await.unwrap();
        assert_eq!(users[0]["email"], "dono@gmail.com");
        assert_eq!(users[0]["initialAdmin"], true);
        assert_eq!(users[1]["email"], "contabil@escritorio.com.br", "stored lowercase and trimmed");
        assert_eq!(users[1]["profileName"], "Visualizador");
        assert_eq!(users[1]["addedBy"], "dono@gmail.com");

        assert_eq!(add(&state, "dono@gmail.com", "contabil@escritorio.com.br", viewer).await.unwrap_err().to_string(), "Esse e-mail já está cadastrado.");
        assert!(add(&state, "dono@gmail.com", "DONO@gmail.com", viewer).await.is_err(), "initial admins aren't managed here");
        assert_eq!(add(&state, "dono@gmail.com", "sem-arroba", viewer).await.unwrap_err().to_string(), "Informe um e-mail válido.");
        assert!(add(&state, "dono@gmail.com", "x@y.com", 999).await.is_err());

        let financeiro = profile_id(&state, "Financeiro").await;
        call(&state, set_app_user_profile, json!({ "email": "contabil@escritorio.com.br", "profileId": financeiro })).await.unwrap();
        assert!(call(&state, set_app_user_profile, json!({ "email": "dono@gmail.com", "profileId": financeiro })).await.is_err());

        let me = admin("contabil@escritorio.com.br");
        let self_removal = call(&state, move |s, j| remove_app_user(s, Extension(me), j), json!({ "email": "contabil@escritorio.com.br" })).await;
        assert_eq!(self_removal.unwrap_err().to_string(), "Você não pode remover a si mesmo.");
        let me = admin("dono@gmail.com");
        call(&state, move |s, j| remove_app_user(s, Extension(me), j), json!({ "email": "contabil@escritorio.com.br" })).await.unwrap();
        assert_eq!(call(&state, |s, _: Json<Value>| list_app_users(s), json!({})).await.unwrap().as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn profiles_are_editable_except_admin_and_in_use_ones_stay() {
        let state = state().await;
        let profiles = call(&state, |s, _: Json<Value>| list_access_profiles(s), json!({})).await.unwrap();
        assert_eq!(profiles[0]["name"], "Admin");
        assert_eq!(profiles[0]["isAdmin"], true);
        assert_eq!(profiles[0]["permissions"]["users"], true);

        let id = call(&state, create_access_profile, json!({ "name": " Conferência ", "permissions": { "areas": { "pagamentos": "edit", "analises": "edit" }, "export": true } }))
            .await
            .unwrap()
            .as_i64()
            .unwrap();
        let created = call(&state, |s, _: Json<Value>| list_access_profiles(s), json!({})).await.unwrap();
        let created = created.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone();
        assert_eq!(created["name"], "Conferência");
        assert_eq!(created["permissions"]["areas"]["analises"], "view", "Análises is never editable");
        assert_eq!(created["permissions"]["areas"]["cadastros"], "none");

        let dup = call(&state, create_access_profile, json!({ "name": "Visualizador", "permissions": {} })).await.unwrap_err();
        assert_eq!(dup.to_string(), "Já existe um perfil com esse nome.");
        assert!(call(&state, create_access_profile, json!({ "name": "  ", "permissions": {} })).await.is_err());

        let admin_id = profile_id(&state, "Admin").await;
        assert!(call(&state, update_access_profile, json!({ "id": admin_id, "name": "Chefe", "permissions": {} })).await.is_err());
        assert!(call(&state, delete_access_profile, json!({ "id": admin_id })).await.is_err());

        call(&state, update_access_profile, json!({ "id": id, "name": "Conferência 2", "permissions": { "areas": { "pagamentos": "view" } } })).await.unwrap();
        add(&state, "dono@gmail.com", "ana@gmail.com", id).await.unwrap();
        let in_use = call(&state, delete_access_profile, json!({ "id": id })).await.unwrap_err();
        assert_eq!(in_use.to_string(), "Esse perfil está em uso por 1 pessoa. Troque o perfil dela antes de excluir.");
        let viewer = profile_id(&state, "Visualizador").await;
        call(&state, set_app_user_profile, json!({ "email": "ana@gmail.com", "profileId": viewer })).await.unwrap();
        call(&state, delete_access_profile, json!({ "id": id })).await.unwrap();
    }
}
