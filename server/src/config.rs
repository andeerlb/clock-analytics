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
    /// `https://tapago.web.app`. Empty = same-origin only.
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
    /// Production: verify Firebase ID tokens. `allowed_emails` are the
    /// initial admins (always Admin); everyone else needs to be registered
    /// on "Usuários e perfis" (see `access.rs`).
    Firebase {
        project_id: String,
        allowed_emails: HashSet<String>,
    },
    /// Local development only (debug builds): every request is treated as
    /// this user, no token needed. `admin`: an initial admin, unless
    /// TAPAGO_ALLOWED_EMAILS is also set and doesn't list it (to try a
    /// profile registered on "Usuários e perfis").
    DevBypass { email: String, admin: bool },
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(String);

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let bind = var("TAPAGO_BIND")
            .unwrap_or_else(|| "127.0.0.1:8787".into())
            .parse()
            .map_err(|e| ConfigError(format!("TAPAGO_BIND inválido: {e}")))?;

        let db_path = var("TAPAGO_DB_PATH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("data/tapago.db"));
        let data_dir = var("TAPAGO_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
            db_path.parent().filter(|p| !p.as_os_str().is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
        });
        let static_dir = var("TAPAGO_STATIC_DIR").map(PathBuf::from);
        let cors_origins = var("TAPAGO_CORS_ORIGINS")
            .map(|v| v.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();

        let timezone = var("TAPAGO_TIMEZONE")
            .unwrap_or_else(|| "America/Sao_Paulo".into())
            .parse()
            .map_err(|e| ConfigError(format!("TAPAGO_TIMEZONE inválido: {e}")))?;
        let remote_checks = match var("TAPAGO_REMOTE_CHECKS").map(|v| v.to_lowercase()).as_deref() {
            None | Some("on") => true,
            Some("off") => false,
            Some(other) => return Err(ConfigError(format!("TAPAGO_REMOTE_CHECKS deve ser on ou off, não {other}."))),
        };

        Ok(Config { bind, db_path, data_dir, static_dir, cors_origins, timezone, remote_checks, auth: AuthConfig::from_env()? })
    }
}

impl AuthConfig {
    /// Always Admin, whatever "Usuários e perfis" says, so nobody gets locked out.
    pub fn initial_admins(&self) -> Vec<String> {
        let mut emails: Vec<String> = match self {
            AuthConfig::Firebase { allowed_emails, .. } => allowed_emails.iter().cloned().collect(),
            AuthConfig::DevBypass { email, admin: true } => vec![email.clone()],
            AuthConfig::DevBypass { admin: false, .. } => Vec::new(),
        };
        emails.sort();
        emails
    }

    fn from_env() -> Result<Self, ConfigError> {
        if let Some(email) = var("TAPAGO_DEV_USER_EMAIL") {
            if cfg!(debug_assertions) {
                let email = email.to_lowercase();
                let admin = var("TAPAGO_ALLOWED_EMAILS").is_none_or(|list| list.split(',').any(|e| e.trim().eq_ignore_ascii_case(&email)));
                return Ok(AuthConfig::DevBypass { email, admin });
            }
            // A release binary must never run without real auth, even if the
            // variable leaked into its environment.
            return Err(ConfigError(
                "TAPAGO_DEV_USER_EMAIL só é aceito em build de desenvolvimento; remova-o do ambiente de produção.".into(),
            ));
        }

        let project_id = var("FIREBASE_PROJECT_ID").ok_or_else(|| ConfigError("FIREBASE_PROJECT_ID não definido.".into()))?;
        let allowed_emails: HashSet<String> = var("TAPAGO_ALLOWED_EMAILS")
            .map(|v| v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if allowed_emails.is_empty() {
            return Err(ConfigError("TAPAGO_ALLOWED_EMAILS vazio: ninguém conseguiria entrar.".into()));
        }
        Ok(AuthConfig::Firebase { project_id, allowed_emails })
    }
}
