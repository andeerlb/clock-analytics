mod ai;
mod access;
mod auth;
mod domain;
mod config;
mod db;
mod error;
mod files;
mod remote_checks;
mod routes;
mod sql;

use std::sync::Arc;

use axum::http::{header, HeaderValue, Method};
use axum::routing::get;
use axum::{middleware, Router};
use sqlx::SqlitePool;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::auth::Authenticator;
use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    /// Root for every file the server stores or serves; see `files.rs`.
    pub data_dir: Arc<std::path::PathBuf>,
    /// Verificação automática: what is being checked right now.
    pub remote_checks: Arc<remote_checks::Runtime>,
    /// `PONTOSCAN_ALLOWED_EMAILS` (or the dev user): always Admin, listed as
    /// fixed on "Usuários e perfis".
    pub initial_admins: Arc<Vec<String>>,
}

impl AppState {
    pub fn new(db: SqlitePool, data_dir: std::path::PathBuf, timezone: chrono_tz::Tz) -> Self {
        AppState {
            db,
            data_dir: Arc::new(data_dir),
            remote_checks: Arc::new(remote_checks::Runtime::new(timezone)),
            initial_admins: Arc::new(Vec::new()),
        }
    }

    pub fn with_initial_admins(mut self, emails: Vec<String>) -> Self {
        self.initial_admins = Arc::new(emails);
        self
    }

    #[cfg(test)]
    pub async fn for_tests() -> Self {
        let dir = std::env::temp_dir().join(format!("pontoscan-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        AppState::new(db::test_pool().await, dir.canonicalize().unwrap(), chrono_tz::America::Sao_Paulo)
    }
}

pub fn app(config: &Config, state: AppState, auth: Arc<Authenticator>) -> Router {
    let state = state.with_initial_admins(config.auth.initial_admins());
    // Layers run bottom-up: who is calling (auth), then what they may do (access).
    let api = routes::protected()
        .route_layer(middleware::from_fn_with_state(state.clone(), access::authorize))
        .route_layer(middleware::from_fn_with_state(auth, auth::require_auth))
        .route("/health", get(routes::health))
        .route("/version", get(routes::version))
        .with_state(state);

    let mut app = Router::new().nest("/api", api);

    if let Some(dir) = &config.static_dir {
        // The frontend uses a HashRouter, so every real path is a file in
        // dist/; anything else falls back to index.html.
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }

    if !config.cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = config.cors_origins.iter().filter_map(|o| o.parse().ok()).collect();
        app = app.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        );
    }

    app.layer(TraceLayer::new_for_http())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn")))
        .init();

    if let Err(error) = run().await {
        tracing::error!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let pool = db::connect(&config.db_path).await?;
    tracing::info!(db = %config.db_path.display(), "banco aberto e migrations aplicadas");

    std::fs::create_dir_all(&config.data_dir)?;
    let data_dir = config.data_dir.canonicalize()?;
    files::spawn_upload_cleanup(data_dir.clone());

    let auth = Arc::new(Authenticator::new(&config.auth));
    let state = AppState::new(pool.clone(), data_dir, config.timezone);
    if config.remote_checks {
        remote_checks::spawn_scheduler(state.clone());
        tracing::info!(timezone = %config.timezone, "verificação automática ligada");
    } else {
        tracing::warn!("verificação automática desligada (PONTOSCAN_REMOTE_CHECKS=off)");
    }
    let app = app(&config, state, auth);

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(addr = %config.bind, "servidor no ar");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;

    // Checkpoints the WAL into the main file on the way out.
    pool.close().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthConfig;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use std::collections::HashSet;
    use tower::ServiceExt;

    fn config(auth: AuthConfig) -> Config {
        Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            db_path: "unused".into(),
            data_dir: "unused".into(),
            static_dir: None,
            cors_origins: vec![],
            timezone: chrono_tz::America::Sao_Paulo,
            remote_checks: false,
            auth,
        }
    }

    async fn firebase_app() -> Router {
        let auth = AuthConfig::Firebase { project_id: "p".into(), allowed_emails: HashSet::from(["a@b.com".to_owned()]) };
        let cfg = config(auth);
        app(&cfg, AppState::for_tests().await, Arc::new(Authenticator::new(&cfg.auth)))
    }

    #[tokio::test]
    async fn api_routes_require_a_login() {
        let response = firebase_app().await.oneshot(Request::get("/api/companies").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], "{\"error\":\"Faça login para continuar.\"}".as_bytes());
    }

    #[tokio::test]
    async fn health_is_public() {
        let response = firebase_app().await.oneshot(Request::get("/api/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn dev_bypass_reaches_the_handlers_end_to_end() {
        let cfg = config(AuthConfig::DevBypass { email: "dev@local".into(), admin: true });
        let app = app(&cfg, AppState::for_tests().await, Arc::new(Authenticator::new(&cfg.auth)));

        let create = Request::post("/api/companies")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"Acme","cnpj":"11.222.333/0001-81"}"#))
            .unwrap();
        let response = app.clone().oneshot(create).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app.oneshot(Request::get("/api/companies").body(Body::empty()).unwrap()).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body[0]["name"], "Acme");
        assert_eq!(body[0]["nightShiftRule"], "overlap");
    }
}
