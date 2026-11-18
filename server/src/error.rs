use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Every handler error. The message of the user-facing variants is shown
/// as-is by the frontend (same texts the desktop app used to throw from
/// `db.ts`), so keep them in Portuguese and actionable.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("Seu e-mail não tem acesso a este sistema.")]
    Forbidden,
    /// Signed in, but the profile doesn't allow this (see `access.rs`). Sent
    /// as 403 with `reason: "permission"`, so the frontend shows the message
    /// instead of signing the person out.
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

pub type ApiResult<T> = Result<T, ApiError>;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let ApiError::PermissionDenied(message) = &self {
            return (StatusCode::FORBIDDEN, Json(json!({ "error": message, "reason": "permission" }))).into_response();
        }
        let (status, message) = match &self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m.clone()),
            ApiError::Forbidden | ApiError::PermissionDenied(_) => (StatusCode::FORBIDDEN, self.to_string()),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            // Never leak SQL or internals to the browser; the details go to the log.
            ApiError::Database(_) | ApiError::Internal(_) => {
                tracing::error!(error = %self, "request failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "Erro interno no servidor.".to_owned())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
