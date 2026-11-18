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

/// Git commit this binary was built from (set by CI via PONTOSCAN_BUILD_SHA;
/// "dev" for local builds). Public so the deploy can wait until the VM is
/// really running the new build before publishing the frontend.
pub async fn version() -> &'static str {
    option_env!("PONTOSCAN_BUILD_SHA").unwrap_or("dev")
}
