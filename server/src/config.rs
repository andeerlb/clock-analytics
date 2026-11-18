use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;

/// Everything the server reads from the environment, resolved once at
/// startup. See `server/README.md` for what each variable means.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub db_path: PathBuf,
    /// Where uploaded and imported files live (`imports/`, `uploads/`).
    /// Defaults to the database's own folder.
    pub data_dir: PathBuf,
    /// Folder holding the built frontend (`dist/`). `None` = API only (the
    /// usual setup when the frontend is served by Firebase Hosting).
    pub static_dir: Option<PathBuf>,
    /// Origins allowed to call the API from a browser, e.g.
    /// `https://pontoscan.web.app`. Empty = same-origin only.
    pub cors_origins: Vec<String>,
    /// The team's time zone: "today" for the automatic check's relative
    /// períodos (the desktop used the computer's own clock).
    pub timezone: chrono_tz::Tz,
    /// Whether the automatic check runs in the background (`off` for local
    /// tests against a copy of the real database).
    pub remote_checks: bool,
    pub auth: AuthConfig,
}

#[derive(Debug, Clone)]
pub enum AuthConfig {
    /// Production: verify Firebase ID tokens and only let in the listed
    /// e-mails. Firebase lets *any* Google account sign in, so the
    /// allowlist is what actually decides who can use the system.
    Firebase {
        project_id: String,
        allowed_emails: HashSet<String>,
    },
    /// Local development only (debug builds): every request is treated as
    /// this user, no token needed.
    DevBypass { email: String },
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(String);

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let bind = var("PONTOSCAN_BIND")
            .unwrap_or_else(|| "127.0.0.1:8787".into())
            .parse()
            .map_err(|e| ConfigError(format!("PONTOSCAN_BIND inválido: {e}")))?;

        let db_path = var("PONTOSCAN_DB_PATH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("data/pontoscan.db"));
        let data_dir = var("PONTOSCAN_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
            db_path.parent().filter(|p| !p.as_os_str().is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
        });
        let static_dir = var("PONTOSCAN_STATIC_DIR").map(PathBuf::from);
        let cors_origins = var("PONTOSCAN_CORS_ORIGINS")
            .map(|v| v.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();

        let timezone = var("PONTOSCAN_TIMEZONE")
            .unwrap_or_else(|| "America/Sao_Paulo".into())
            .parse()
            .map_err(|e| ConfigError(format!("PONTOSCAN_TIMEZONE inválido: {e}")))?;
        let remote_checks = match var("PONTOSCAN_REMOTE_CHECKS").map(|v| v.to_lowercase()).as_deref() {
            None | Some("on") => true,
            Some("off") => false,
            Some(other) => return Err(ConfigError(format!("PONTOSCAN_REMOTE_CHECKS deve ser on ou off, não {other}."))),
        };

        Ok(Config { bind, db_path, data_dir, static_dir, cors_origins, timezone, remote_checks, auth: AuthConfig::from_env()? })
    }
}

impl AuthConfig {
    fn from_env() -> Result<Self, ConfigError> {
        if let Some(email) = var("PONTOSCAN_DEV_USER_EMAIL") {
            if cfg!(debug_assertions) {
                return Ok(AuthConfig::DevBypass { email: email.to_lowercase() });
            }
            // A release binary must never run without real auth, even if the
            // variable leaked into its environment.
            return Err(ConfigError(
                "PONTOSCAN_DEV_USER_EMAIL só é aceito em build de desenvolvimento; remova-o do ambiente de produção.".into(),
            ));
        }

        let project_id = var("FIREBASE_PROJECT_ID").ok_or_else(|| ConfigError("FIREBASE_PROJECT_ID não definido.".into()))?;
        let allowed_emails: HashSet<String> = var("PONTOSCAN_ALLOWED_EMAILS")
            .map(|v| v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if allowed_emails.is_empty() {
            return Err(ConfigError("PONTOSCAN_ALLOWED_EMAILS vazio: ninguém conseguiria entrar.".into()));
        }
        Ok(AuthConfig::Firebase { project_id, allowed_emails })
    }
}
