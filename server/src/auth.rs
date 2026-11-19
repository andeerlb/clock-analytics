//! Login. The browser signs in with Google through Firebase Authentication
//! and sends the resulting Firebase ID token on every API call
//! (`Authorization: Bearer <token>`). This module checks that token
//! (signature, audience, issuer, expiry) and tells who is calling. Firebase
//! accepts *any* Google account: whether that person may use the system, and
//! what they may do, is decided next by `access::authorize` (initial admins
//! from the configuration, everyone else from "Usuários e perfis").

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL};
use axum::middleware::Next;
use axum::response::Response;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::config::AuthConfig;
use crate::error::ApiError;

/// Google's public keys for Firebase ID tokens, as a JWK set.
const FIREBASE_JWKS_URL: &str = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/// Used when Google's response has no usable `Cache-Control: max-age`.
const DEFAULT_KEY_TTL: Duration = Duration::from_secs(60 * 60);
/// A token signed with a key we don't know yet triggers a refetch, but not
/// more often than this — otherwise garbage tokens could make us hammer Google.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Tolerated clock difference between this server and Google.
const LEEWAY_SECS: u64 = 60;

/// The signed-in user, available to handlers as `Extension<AuthUser>`.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub email: String,
    /// The name on the Google account, when the token carries one — what
    /// the activity log shows for this person.
    pub name: Option<String>,
    /// Listed in `TAPAGO_ALLOWED_EMAILS` (or the dev user): always Admin.
    pub initial_admin: bool,
}

pub struct Authenticator {
    mode: Mode,
}

enum Mode {
    Firebase { verifier: FirebaseVerifier, allowed_emails: HashSet<String> },
    DevBypass { email: String, admin: bool },
}

impl Authenticator {
    pub fn new(config: &AuthConfig) -> Self {
        let mode = match config {
            AuthConfig::Firebase { project_id, allowed_emails } => Mode::Firebase {
                verifier: FirebaseVerifier::new(project_id.clone()),
                allowed_emails: allowed_emails.clone(),
            },
            AuthConfig::DevBypass { email, admin } => {
                tracing::warn!(%email, "login desativado (modo de desenvolvimento): toda requisição entra como este usuário");
                Mode::DevBypass { email: email.clone(), admin: *admin }
            }
        };
        Authenticator { mode }
    }

    #[cfg(test)]
    fn with_static_keys(project_id: &str, keys: HashMap<String, DecodingKey>, allowed: &[&str]) -> Self {
        Authenticator {
            mode: Mode::Firebase {
                verifier: FirebaseVerifier::with_static_keys(project_id.to_owned(), keys),
                allowed_emails: allowed.iter().map(|e| e.to_lowercase()).collect(),
            },
        }
    }

    pub async fn authenticate(&self, authorization: Option<&str>) -> Result<AuthUser, ApiError> {
        match &self.mode {
            Mode::DevBypass { email, admin } => Ok(AuthUser { email: email.clone(), name: None, initial_admin: *admin }),
            Mode::Firebase { verifier, allowed_emails } => {
                let token = authorization
                    .and_then(|h| h.strip_prefix("Bearer "))
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| ApiError::Unauthorized("Faça login para continuar.".into()))?;
                let claims = verifier.verify(token).await?;
                let email = claims.email.as_deref().map(str::to_lowercase).unwrap_or_default();
                if email.is_empty() || !claims.email_verified.unwrap_or(false) {
                    return Err(ApiError::Forbidden);
                }
                let initial_admin = allowed_emails.contains(&email);
                let name = claims.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_owned);
                Ok(AuthUser { email, name, initial_admin })
            }
        }
    }
}

/// Axum middleware: rejects the request unless it carries a valid login,
/// and hands the user to the handler via request extensions.
pub async fn require_auth(State(auth): State<Arc<Authenticator>>, mut request: Request, next: Next) -> Result<Response, ApiError> {
    let header = request.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
    let user = auth.authenticate(header).await?;
    request.extensions_mut().insert(user);
    Ok(next.run(request).await)
}

#[derive(Debug, Deserialize)]
struct FirebaseClaims {
    sub: String,
    iat: u64,
    auth_time: u64,
    email: Option<String>,
    email_verified: Option<bool>,
    #[serde(default)]
    name: Option<String>,
}

struct CachedKeys {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Instant,
    ttl: Duration,
}

struct FirebaseVerifier {
    project_id: String,
    http: reqwest::Client,
    cache: RwLock<Option<CachedKeys>>,
    /// Tests inject keys and never hit the network.
    static_keys: bool,
}

impl FirebaseVerifier {
    fn new(project_id: String) -> Self {
        FirebaseVerifier { project_id, http: reqwest::Client::new(), cache: RwLock::new(None), static_keys: false }
    }

    #[cfg(test)]
    fn with_static_keys(project_id: String, keys: HashMap<String, DecodingKey>) -> Self {
        FirebaseVerifier {
            project_id,
            http: reqwest::Client::new(),
            cache: RwLock::new(Some(CachedKeys { keys, fetched_at: Instant::now(), ttl: Duration::MAX })),
            static_keys: true,
        }
    }

    async fn verify(&self, token: &str) -> Result<FirebaseClaims, ApiError> {
        let invalid = || ApiError::Unauthorized("Sessão inválida ou expirada. Faça login novamente.".into());

        let header = decode_header(token).map_err(|_| invalid())?;
        if header.alg != Algorithm::RS256 {
            return Err(invalid());
        }
        let kid = header.kid.ok_or_else(invalid)?;
        let key = self.key(&kid).await?.ok_or_else(invalid)?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[&self.project_id]);
        validation.set_issuer(&[format!("https://securetoken.google.com/{}", self.project_id)]);
        validation.set_required_spec_claims(&["exp", "iat", "aud", "iss", "sub"]);
        validation.leeway = LEEWAY_SECS;
        let claims = decode::<FirebaseClaims>(token, &key, &validation).map_err(|_| invalid())?.claims;

        // Checks Firebase documents that `Validation` doesn't cover.
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if claims.sub.is_empty() || claims.iat > now + LEEWAY_SECS || claims.auth_time > now + LEEWAY_SECS {
            return Err(invalid());
        }
        Ok(claims)
    }

    async fn key(&self, kid: &str) -> Result<Option<DecodingKey>, ApiError> {
        {
            let cache = self.cache.read().await;
            if let Some(cached) = cache.as_ref() {
                let fresh = cached.fetched_at.elapsed() < cached.ttl;
                if let Some(key) = cached.keys.get(kid) {
                    if fresh {
                        return Ok(Some(key.clone()));
                    }
                } else if self.static_keys || (fresh && cached.fetched_at.elapsed() < MIN_REFRESH_INTERVAL) {
                    return Ok(None);
                }
            }
        }
        if self.static_keys {
            return Ok(None);
        }

        let mut cache = self.cache.write().await;
        // Another request may have refreshed while we waited for the lock.
        if let Some(cached) = cache.as_ref() {
            if cached.fetched_at.elapsed() < MIN_REFRESH_INTERVAL {
                return Ok(cached.keys.get(kid).cloned());
            }
        }
        let fresh = self.fetch_keys().await?;
        let key = fresh.keys.get(kid).cloned();
        *cache = Some(fresh);
        Ok(key)
    }

    async fn fetch_keys(&self) -> Result<CachedKeys, ApiError> {
        let fail = |e: reqwest::Error| ApiError::Internal(format!("não foi possível buscar as chaves do Firebase: {e}"));
        let response = self.http.get(FIREBASE_JWKS_URL).send().await.map_err(fail)?.error_for_status().map_err(fail)?;
        let ttl = response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .and_then(max_age)
            .unwrap_or(DEFAULT_KEY_TTL);
        let set: JwkSet = response.json().await.map_err(fail)?;
        let keys = set
            .keys
            .iter()
            .filter_map(|jwk| Some((jwk.common.key_id.clone()?, DecodingKey::from_jwk(jwk).ok()?)))
            .collect();
        Ok(CachedKeys { keys, fetched_at: Instant::now(), ttl })
    }
}

fn max_age(cache_control: &str) -> Option<Duration> {
    cache_control
        .split(',')
        .find_map(|part| part.trim().strip_prefix("max-age="))
        .and_then(|v| v.parse().ok())
        .map(Duration::from_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    // Throwaway 2048-bit RSA key pair, generated only for these tests.
    const PRIVATE_PEM: &[u8] = include_bytes!("../tests/fixtures/test_rsa_private.pem");
    const PUBLIC_PEM: &[u8] = include_bytes!("../tests/fixtures/test_rsa_public.pem");
    const PROJECT: &str = "tapago-test";

    fn now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    fn token(claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("k1".into());
        encode(&header, &claims, &EncodingKey::from_rsa_pem(PRIVATE_PEM).unwrap()).unwrap()
    }

    fn good_claims(email: &str) -> serde_json::Value {
        json!({
            "iss": format!("https://securetoken.google.com/{PROJECT}"),
            "aud": PROJECT,
            "sub": "uid-1",
            "iat": now() - 10,
            "auth_time": now() - 10,
            "exp": now() + 3600,
            "email": email,
            "email_verified": true,
        })
    }

    fn authenticator() -> Authenticator {
        let keys = HashMap::from([("k1".to_owned(), DecodingKey::from_rsa_pem(PUBLIC_PEM).unwrap())]);
        Authenticator::with_static_keys(PROJECT, keys, &["Ana@Exemplo.com"])
    }

    async fn check(claims: serde_json::Value) -> Result<AuthUser, ApiError> {
        authenticator().authenticate(Some(&format!("Bearer {}", token(claims)))).await
    }

    #[tokio::test]
    async fn accepts_a_valid_token_for_an_allowed_email_case_insensitively() {
        let user = check(good_claims("ana@exemplo.com")).await.unwrap();
        assert_eq!(user.email, "ana@exemplo.com");
        assert!(user.initial_admin);
    }

    #[tokio::test]
    async fn rejects_a_missing_header() {
        assert!(matches!(authenticator().authenticate(None).await, Err(ApiError::Unauthorized(_))));
    }

    #[tokio::test]
    async fn an_email_outside_the_initial_admins_is_identified_but_not_an_admin() {
        // Whether it may use the system at all is `access::authorize`'s call.
        let user = check(good_claims("intruso@gmail.com")).await.unwrap();
        assert_eq!(user.email, "intruso@gmail.com");
        assert!(!user.initial_admin);
    }

    #[tokio::test]
    async fn rejects_an_unverified_email() {
        let mut claims = good_claims("ana@exemplo.com");
        claims["email_verified"] = json!(false);
        assert!(matches!(check(claims).await, Err(ApiError::Forbidden)));
    }

    #[tokio::test]
    async fn rejects_a_token_for_another_firebase_project() {
        let mut claims = good_claims("ana@exemplo.com");
        claims["aud"] = json!("outro-projeto");
        assert!(matches!(check(claims).await, Err(ApiError::Unauthorized(_))));
    }

    #[tokio::test]
    async fn rejects_a_wrong_issuer() {
        let mut claims = good_claims("ana@exemplo.com");
        claims["iss"] = json!("https://securetoken.google.com/outro-projeto");
        assert!(matches!(check(claims).await, Err(ApiError::Unauthorized(_))));
    }

    #[tokio::test]
    async fn rejects_an_expired_token() {
        let mut claims = good_claims("ana@exemplo.com");
        claims["exp"] = json!(now() - 3600);
        assert!(matches!(check(claims).await, Err(ApiError::Unauthorized(_))));
    }

    #[tokio::test]
    async fn rejects_a_token_signed_with_an_unknown_key() {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("desconhecida".into());
        let t = encode(&header, &good_claims("ana@exemplo.com"), &EncodingKey::from_rsa_pem(PRIVATE_PEM).unwrap()).unwrap();
        let result = authenticator().authenticate(Some(&format!("Bearer {t}"))).await;
        assert!(matches!(result, Err(ApiError::Unauthorized(_))));
    }

    #[tokio::test]
    async fn rejects_garbage() {
        let result = authenticator().authenticate(Some("Bearer nao-e-um-jwt")).await;
        assert!(matches!(result, Err(ApiError::Unauthorized(_))));
    }

    #[test]
    fn parses_max_age() {
        assert_eq!(max_age("public, max-age=19826, must-revalidate"), Some(Duration::from_secs(19826)));
        assert_eq!(max_age("no-cache"), None);
    }
}
