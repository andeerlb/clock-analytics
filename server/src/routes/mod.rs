use axum::routing::get;
use axum::{Extension, Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::AppState;

pub mod companies;

/// Everything here sits behind `auth::require_auth`.
pub fn protected() -> Router<AppState> {
    Router::new().route("/me", get(me)).merge(companies::router())
}

/// Who the server thinks is signed in — the frontend uses it to confirm the
/// e-mail is on the access list right after the Google login.
async fn me(Extension(user): Extension<AuthUser>) -> Json<Value> {
    Json(json!({ "email": user.email }))
}

/// Unauthenticated liveness probe for deploy scripts / uptime checks.
pub async fn health() -> &'static str {
    "ok"
}
