use std::future::Future;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::AppState;

pub mod analytics;
pub mod clients;
pub mod commands;
pub mod companies;
pub mod employees;
pub mod payments;
pub mod roles;
pub mod storage;
pub mod timesheets;

/// Everything here sits behind `auth::require_auth`.
pub fn protected() -> Router<AppState> {
    Router::new().route("/me", get(me))
        .merge(companies::router())
        .merge(commands::router())
        .merge(clients::router())
        .merge(roles::router())
        .merge(employees::router())
        .merge(timesheets::router())
        .merge(payments::router())
        .merge(analytics::router())
        .merge(storage::router())
        .merge(crate::remote_checks::router())
        .merge(crate::files::router())
        .merge(crate::ai::router())
}

/// What a handler answered, as the JSON the browser would have received.
pub(crate) trait RpcReply {
    fn into_value(self) -> ApiResult<Value>;
}

impl<T: Serialize> RpcReply for Json<T> {
    fn into_value(self) -> ApiResult<Value> {
        serde_json::to_value(self.0).map_err(|e| ApiError::Internal(e.to_string()))
    }
}

impl RpcReply for StatusCode {
    fn into_value(self) -> ApiResult<Value> {
        Ok(Value::Null)
    }
}

/// Calls an RPC handler from inside the server with the same JSON arguments
/// the frontend sends — `await rpc("name", args)` for server-side code. The
/// automatic check (`remote_checks`) was TypeScript calling these exact
/// functions; going through the handlers keeps it on the very same code.
pub(crate) async fn call<A, R, F, Fut>(state: &AppState, handler: F, args: Value) -> ApiResult<Value>
where
    A: DeserializeOwned,
    R: RpcReply,
    F: FnOnce(State<AppState>, Json<A>) -> Fut,
    Fut: Future<Output = ApiResult<R>>,
{
    let args = serde_json::from_value(args).map_err(|e| ApiError::Internal(format!("argumentos inválidos: {e}")))?;
    handler(State(state.clone()), Json(args)).await?.into_value()
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
