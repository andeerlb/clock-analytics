//! Usuários e perfis: who can sign in and what each person can do.
//!
//! `auth::require_auth` only proves *who* is calling (a Google account). This
//! module decides *what* they may do:
//! - the server's `PONTOSCAN_ALLOWED_EMAILS` are initial admins: always
//!   allowed everything, never stored in the database, so nobody gets locked
//!   out;
//! - everyone else must be in `app_users`, with an `access_profiles` profile:
//!   per area none/view/edit, plus export, the AI assistant and user
//!   management.
//!
//! Every API route is classified in `rule_for` (area, and whether it reads or
//! writes). A route missing there is admin-only, so a new endpoint is never
//! open by accident; a test checks that every route of the server is listed.

use std::collections::BTreeMap;

use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use axum::Extension;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::{params, sql, AppState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Area {
    Cadastros,
    Espelhos,
    Pagamentos,
    Analises,
    Verificacao,
    Configuracoes,
}

impl Area {
    pub const ALL: [Area; 6] = [Area::Cadastros, Area::Espelhos, Area::Pagamentos, Area::Analises, Area::Verificacao, Area::Configuracoes];

    /// How the area is called on screen, for error messages.
    pub fn label(self) -> &'static str {
        match self {
            Area::Cadastros => "Cadastros",
            Area::Espelhos => "Espelhos e Cartão Ponto",
            Area::Pagamentos => "Pagamentos",
            Area::Analises => "Análises",
            Area::Verificacao => "Verificação automática",
            Area::Configuracoes => "Configurações",
        }
    }

    /// Análises has nothing to edit.
    pub fn editable(self) -> bool {
        self != Area::Analises
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    None,
    View,
    Edit,
}

/// What a profile allows (`access_profiles.permissions_json`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Permissions {
    pub areas: BTreeMap<Area, Level>,
    pub export: bool,
    pub ai: bool,
    pub users: bool,
}

impl Permissions {
    pub fn admin() -> Self {
        Permissions {
            areas: Area::ALL.iter().map(|a| (*a, if a.editable() { Level::Edit } else { Level::View })).collect(),
            export: true,
            ai: true,
            users: true,
        }
    }

    pub fn level(&self, area: Area) -> Level {
        self.areas.get(&area).copied().unwrap_or_default()
    }

    /// Cleans what came from the browser: every area present, nothing above
    /// what the area supports.
    pub fn normalized(mut self) -> Self {
        for area in Area::ALL {
            let level = self.level(area);
            let level = if !area.editable() && level == Level::Edit { Level::View } else { level };
            self.areas.insert(area, level);
        }
        self
    }

    fn sees_anything(&self) -> bool {
        Area::ALL.iter().any(|a| self.level(*a) >= Level::View)
    }
}

/// Who is calling and what they may do; handlers get it as `Extension<Access>`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub email: String,
    /// Configured on the server: always Admin, not managed on screen.
    pub initial_admin: bool,
    pub profile_name: String,
    /// The fixed Admin profile (or an initial admin).
    pub is_admin: bool,
    pub permissions: Permissions,
}

/// One condition of a route; every condition of its rule must hold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Req {
    /// Any signed-in user with access to the system.
    Signed,
    /// At least "Ver" in one of these areas.
    View(&'static [Area]),
    /// "Editar" in one of these areas.
    Edit(&'static [Area]),
    Export,
    Ai,
    Users,
    /// Not classified: admins only.
    AdminOnly,
}

use Area::{Analises as AN, Cadastros as CA, Configuracoes as CF, Espelhos as ES, Pagamentos as PG, Verificacao as VE};

/// Read endpoints other areas use as lookups (filters, pickers, names).
const ANY_AREA: &[Area] = &[CA, ES, PG, AN, VE, CF];

/// The rule for a request: `path` is relative to `/api`.
pub fn rule_for(method: &Method, path: &str) -> &'static [Req] {
    use Req::*;
    if let Some(name) = path.strip_prefix("/rpc/") {
        return rpc_rule(name);
    }
    match (method, path) {
        (_, "/me") => &[Signed],
        (&Method::GET, "/companies") => &[View(ANY_AREA)],
        (&Method::GET, p) if p.starts_with("/companies/") => &[View(&[CA])],
        (_, p) if p == "/companies" || p.starts_with("/companies/") => &[Edit(&[CA])],
        (_, "/files/upload") => &[Edit(&[ES, PG, CA])],
        (_, "/files/content") => &[View(ANY_AREA)],
        (_, "/files/list") => &[Edit(&[ES, PG])],
        _ => &[AdminOnly],
    }
}

fn rpc_rule(name: &str) -> &'static [Req] {
    use Req::*;
    match name {
        // --- Cadastros: lookups every screen uses ---
        "listClients" | "listRoles" | "listRolesGlobal" | "listEmployeesGlobal" | "getEmployeesByIds" | "listProviders" => &[View(ANY_AREA)],
        "findEmployeeByAttempts" | "findEmployeeAnywhereByAttempts" | "findRoleByName" => &[View(&[CA, ES, PG])],
        "getEffectivePaymentRules" => &[View(&[CA, PG, AN])],
        // --- Cadastros ---
        "getClient" | "getRole" | "listRoleAliases" | "findRoleAliasOwner" | "getEmployee" | "listEmployeeAliases" | "listEmployeePixKeys"
        | "findEmployeeAliasOwner" | "getEmployeeDeletionImpact" | "listEmployeeTemplates" | "getEmployeeTemplate" => &[View(&[CA])],
        "addClientCompany" | "createClient" | "removeClientCompany" | "updateClient" | "addRoleAlias" | "createRole" | "deleteRole"
        | "removeRoleAlias" | "updateRole" | "addEmployeeAlias" | "addEmployeePixKey" | "createEmployeeManual" | "createEmployeesFromImport"
        | "createEmployeeTemplate" | "deleteEmployee" | "deleteEmployeeTemplate" | "linkEmployeeToClientCompany"
        | "reassignEmployeeHistoryToClientCompany" | "removeEmployeeAlias" | "removeEmployeePixKey" | "unlinkEmployeeClientCompany"
        | "updateEmployee" | "updateEmployeeClientCompanyMatricula" | "updateEmployeePixKeyType" | "updateEmployeeTemplate" => &[Edit(&[CA])],

        // --- Espelhos e Cartão Ponto ---
        "countImportsByStatus" | "findConflictingImport" | "findConflicts" | "getImportById" | "listImports" | "listStoredDayRecords" => {
            &[View(&[ES, AN])]
        }
        // The import history and duplicate check serve both import flows.
        "countImportFiles" | "listImportFiles" | "findDuplicateFiles" => &[View(&[ES, PG])],
        "deleteImport" | "saveParsedTimesheet" | "hashFiles" | "parseImport" => &[Edit(&[ES])],
        "logSourceFile" | "markSourceFileSaved" => &[Edit(&[ES, PG])],
        "generateReportZip" => &[View(&[ES]), Export],

        // --- Spreadsheets: payment import, payment and employee templates ---
        "listSpreadsheetSheets" | "previewSpreadsheet" | "applyPaymentTemplate" | "hashPaymentFile" | "readSpreadsheetAuthor" => {
            &[Edit(&[PG, CA])]
        }
        "downloadPaymentFileFromUrl" | "checkRemotePaymentFile" => &[Edit(&[PG])],

        // --- Pagamentos ---
        "listPaymentTemplates" | "getPaymentTemplate" | "listPaymentExportTemplates" | "getPaymentExportTemplate" | "listPaymentPdfTemplates"
        | "getPaymentPdfTemplate" | "findDuplicatePaymentShifts" | "findPaymentShiftByPosition" | "listHeadShiftsForSourceUrl"
        | "countPaymentShiftsByStatus" | "getPaymentShift" | "getPaymentShiftHistory" | "getPaymentShiftsByIds" | "getPaymentVisibleColumns"
        | "setPaymentVisibleColumns" | "listLatestFieldDiffsForShifts" | "listPaymentAuditsForShiftIds" | "listPaymentShiftsFlat"
        | "listPaymentShiftsForGroup" | "listPaymentShiftSummaries" => &[View(&[PG])],
        "createPaymentTemplate" | "updatePaymentTemplate" | "deletePaymentTemplate" | "createPaymentExportTemplate"
        | "updatePaymentExportTemplate" | "deletePaymentExportTemplate" | "clonePaymentExportTemplate" | "createPaymentPdfTemplate"
        | "updatePaymentPdfTemplate" | "deletePaymentPdfTemplate" | "clonePaymentPdfTemplate" | "savePaymentShifts"
        | "trackUrlForAutoReimport" | "applyAutoSyncedFieldUpdate" | "deletePaymentAudit" | "deletePaymentShift" | "editPaymentShift"
        | "markPaymentShiftAuditError" | "markPaymentShiftPaid" | "recordPaymentAudit" | "revertPaymentShiftToPending"
        | "undoPaymentShiftAuditError" | "acceptShiftChange" => &[Edit(&[PG])],

        // --- Análises (shared with the Pagamentos filters) ---
        "countPaymentShiftsPendingAudit" | "listDistinctPaymentShiftLocals" | "listPaymentShiftsForReport" | "listPaymentShiftsForReportPage" => {
            &[View(&[AN, PG])]
        }

        // --- Verificação automática (its status shows on many screens) ---
        "listTrackedPaymentUrls" | "listReimportConfigs" | "getRemoteCheckStatus" | "listCheckDiffCountsByLogIds" | "listCheckDiffs"
        | "listUrlCheckLogForConfig" | "listAllLatestShiftDiffs" => &[View(&[VE, PG, AN])],
        "createReimportConfig" | "updateReimportConfig" | "deleteReimportConfig" | "setConfigCheckDisabled" | "untrackPaymentUrl"
        | "forceCheckAll" | "forceCheckConfig" => &[Edit(&[VE])],
        "dismissCheckDiffs" => &[Edit(&[VE, PG])],

        // --- Configurações ---
        "getStorageUsage" | "getImportsFileList" | "getDatabaseTableSizes" | "listImportedFileNames" | "findRedundantOriginals" => {
            &[View(&[CF])]
        }
        "vacuumDatabase" | "markOriginalsRemoved" | "clearAllData" | "clearImportsDir" | "aiSetApiKey" | "aiClearApiKey" => &[Edit(&[CF])],
        // Also used to drop spreadsheets downloaded by link after an import.
        "deleteImportedFiles" => &[Edit(&[CF, PG])],
        "exportDatabase" => &[View(&[CF]), Export],
        "backupAppData" => &[Edit(&[CF]), Export],

        // --- Assistente com IA ---
        "aiStatus" => &[Signed],
        "aiAsk" => &[Ai],

        // --- Usuários e perfis ---
        "listAppUsers" | "addAppUser" | "setAppUserProfile" | "removeAppUser" | "listAccessProfiles" | "createAccessProfile"
        | "updateAccessProfile" | "deleteAccessProfile" => &[Users],

        _ => &[AdminOnly],
    }
}

fn allowed(req: Req, access: &Access) -> Result<(), String> {
    if access.is_admin {
        return Ok(());
    }
    let p = &access.permissions;
    let ok = match req {
        Req::Signed => true,
        Req::View(areas) => areas.iter().any(|a| p.level(*a) >= Level::View),
        Req::Edit(areas) => areas.iter().any(|a| p.level(*a) == Level::Edit),
        Req::Export => p.export,
        Req::Ai => p.ai,
        Req::Users => p.users,
        Req::AdminOnly => false,
    };
    if ok {
        return Ok(());
    }
    Err(match req {
        Req::View(areas) => format!("Seu perfil não tem acesso a {}.", areas[0].label()),
        Req::Edit(areas) => format!("Seu perfil só permite visualizar {}.", areas[0].label()),
        Req::Export => "Seu perfil não permite exportar ou baixar arquivos.".into(),
        Req::Ai => "Seu perfil não permite usar o assistente com IA.".into(),
        Req::Users => "Só quem gerencia usuários pode fazer isso.".into(),
        Req::AdminOnly | Req::Signed => "Só um admin pode fazer isso.".into(),
    })
}

/// Checks a whole rule against what the caller may do.
pub fn check(rule: &[Req], access: &Access) -> ApiResult<()> {
    for req in rule {
        allowed(*req, access).map_err(ApiError::PermissionDenied)?;
    }
    Ok(())
}

/// What `email` may do: an initial admin, or their profile in `app_users`.
/// `None` when the e-mail isn't registered (no access at all).
pub async fn load_access(state: &AppState, user: &AuthUser) -> ApiResult<Option<Access>> {
    if user.initial_admin {
        return Ok(Some(Access {
            email: user.email.clone(),
            initial_admin: true,
            profile_name: "Admin".into(),
            is_admin: true,
            permissions: Permissions::admin(),
        }));
    }
    let row = sql::select_one(
        &state.db,
        "SELECT p.name, p.permissions_json AS permissionsJson, p.is_admin AS isAdmin
         FROM app_users u JOIN access_profiles p ON p.id = u.profile_id
         WHERE u.email = $1",
        &params![user.email],
    )
    .await?;
    let Some(row) = row else { return Ok(None) };
    let is_admin = row.get("isAdmin").and_then(Value::as_i64).unwrap_or(0) != 0;
    let permissions = if is_admin { Permissions::admin() } else { parse_permissions(row.get("permissionsJson"))? };
    // Cheap "last seen", at most once every 5 minutes per person.
    sql::execute(
        &state.db,
        "UPDATE app_users SET last_seen_at = datetime('now')
         WHERE email = $1 AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))",
        &params![user.email],
    )
    .await?;
    Ok(Some(Access {
        email: user.email.clone(),
        initial_admin: false,
        profile_name: row.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
        is_admin,
        permissions,
    }))
}

pub fn parse_permissions(value: Option<&Value>) -> ApiResult<Permissions> {
    let text = value.and_then(Value::as_str).unwrap_or("{}");
    serde_json::from_str::<Permissions>(text).map(Permissions::normalized).map_err(|e| ApiError::Internal(format!("perfil inválido: {e}")))
}

/// Axum middleware (after `auth::require_auth`): loads what the caller may
/// do, refuses unregistered e-mails and requests the profile doesn't allow,
/// and hands `Access` to the handlers.
pub async fn authorize(State(state): State<AppState>, Extension(user): Extension<AuthUser>, mut request: Request, next: Next) -> ApiResult<Response> {
    let Some(access) = load_access(&state, &user).await? else {
        tracing::warn!(email = %user.email, "login recusado: e-mail sem cadastro de acesso");
        return Err(ApiError::Forbidden);
    };
    if !access.is_admin && !access.permissions.sees_anything() && request.uri().path() != "/me" {
        return Err(ApiError::PermissionDenied("Seu perfil não dá acesso a nenhuma área do sistema.".into()));
    }
    let path = request.uri().path().trim_start_matches("/api");
    check(rule_for(request.method(), path), &access)?;
    request.extensions_mut().insert(access);
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(permissions: Permissions) -> Access {
        Access { email: "a@b.com".into(), initial_admin: false, profile_name: "P".into(), is_admin: false, permissions }
    }

    fn perms(areas: &[(Area, Level)], export: bool) -> Permissions {
        Permissions { areas: areas.iter().copied().collect(), export, ai: false, users: false }.normalized()
    }

    /// Every route the server registers, read from its source: a route
    /// added later without a rule here would silently be admin-only.
    fn registered_routes() -> Vec<String> {
        fn walk(dir: &std::path::Path, re: &regex::Regex, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, re, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    out.extend(re.captures_iter(&text).map(|c| c[1].to_owned()));
                }
            }
        }
        let mut out = Vec::new();
        let re = regex::Regex::new(r#"\.route\("([^"]+)""#).unwrap();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &re, &mut out);
        out.sort();
        out.dedup();
        out
    }

    #[test]
    fn every_route_has_a_rule() {
        let public = ["/health", "/version"];
        let unclassified: Vec<String> = registered_routes()
            .into_iter()
            .filter(|r| !public.contains(&r.as_str()))
            .filter(|r| rule_for(&Method::POST, r) == [Req::AdminOnly] && rule_for(&Method::GET, r) == [Req::AdminOnly])
            .collect();
        assert!(unclassified.is_empty(), "routes without an access rule: {unclassified:?}");
        assert!(registered_routes().len() > 150);
    }

    #[test]
    fn view_and_edit_by_area() {
        let viewer = access(perms(&[(PG, Level::View), (CA, Level::View)], false));
        assert!(check(rule_for(&Method::POST, "/rpc/listPaymentShiftsFlat"), &viewer).is_ok());
        let denied = check(rule_for(&Method::POST, "/rpc/markPaymentShiftPaid"), &viewer).unwrap_err();
        assert_eq!(denied.to_string(), "Seu perfil só permite visualizar Pagamentos.");
        assert!(check(rule_for(&Method::POST, "/rpc/listImports"), &viewer).is_err(), "no Espelhos/Análises");
        assert!(check(rule_for(&Method::GET, "/companies"), &viewer).is_ok());
        assert!(check(rule_for(&Method::POST, "/companies"), &viewer).is_err());
        assert!(check(rule_for(&Method::POST, "/rpc/whateverNew"), &viewer).is_err(), "unknown routes are admin-only");

        let finance = access(perms(&[(PG, Level::Edit)], true));
        assert!(check(rule_for(&Method::POST, "/rpc/markPaymentShiftPaid"), &finance).is_ok());
        assert!(check(rule_for(&Method::POST, "/rpc/listEmployeesGlobal"), &finance).is_ok(), "lookups work from any area");
        assert!(check(rule_for(&Method::POST, "/rpc/updateEmployee"), &finance).is_err());
        assert!(check(rule_for(&Method::POST, "/rpc/listAppUsers"), &finance).is_err());
    }

    #[test]
    fn export_needs_its_own_flag() {
        let no_export = access(perms(&[(ES, Level::Edit)], false));
        let err = check(rule_for(&Method::POST, "/rpc/generateReportZip"), &no_export).unwrap_err();
        assert_eq!(err.to_string(), "Seu perfil não permite exportar ou baixar arquivos.");
        let with_export = access(perms(&[(ES, Level::View)], true));
        assert!(check(rule_for(&Method::POST, "/rpc/generateReportZip"), &with_export).is_ok());
    }

    #[test]
    fn admin_passes_everything_and_analises_is_never_editable() {
        let mut admin = access(Permissions::default());
        admin.is_admin = true;
        assert!(check(rule_for(&Method::POST, "/rpc/anythingAtAll"), &admin).is_ok());
        let p = perms(&[(AN, Level::Edit)], false);
        assert_eq!(p.level(AN), Level::View);
        assert_eq!(p.level(CF), Level::None, "every area is present after normalizing");
    }

    /// The real router behind the real `authorize`, with a fake login in
    /// front that says who is calling.
    async fn call_as(state: &AppState, email: &str, method: Method, path: &str, body: &str) -> (axum::http::StatusCode, Value) {
        use axum::body::Body;
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let user = AuthUser { email: email.into(), initial_admin: false };
        let app = crate::routes::protected()
            .route_layer(axum::middleware::from_fn_with_state(state.clone(), authorize))
            .layer(axum::middleware::from_fn(move |mut req: Request, next: Next| {
                let user = user.clone();
                async move {
                    req.extensions_mut().insert(user);
                    next.run(req).await
                }
            }))
            .with_state(state.clone());
        let request = axum::http::Request::builder().method(method).uri(path).header("content-type", "application/json").body(Body::from(body.to_owned())).unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn requests_are_checked_against_the_callers_profile() {
        let state = AppState::for_tests().await;
        let viewer_id = sql::select_one(&state.db, "SELECT id FROM access_profiles WHERE name = 'Visualizador'", &[]).await.unwrap().unwrap()["id"].as_i64().unwrap();
        sql::execute(&state.db, "INSERT INTO app_users (email, profile_id, added_by) VALUES ('vera@gmail.com', $1, 'admin@x.com')", &params![viewer_id]).await.unwrap();

        // Not registered: no access at all (the frontend signs out on this one).
        let (status, body) = call_as(&state, "estranho@gmail.com", Method::GET, "/me", "").await;
        assert_eq!(status, 403);
        assert!(body.get("reason").is_none());

        let (status, me) = call_as(&state, "vera@gmail.com", Method::GET, "/me", "").await;
        assert_eq!(status, 200);
        assert_eq!(me["profileName"], "Visualizador");
        assert_eq!(me["permissions"]["areas"]["pagamentos"], "view");

        let (status, _) = call_as(&state, "vera@gmail.com", Method::POST, "/rpc/listPaymentShiftsFlat", r#"{"query":{}}"#).await;
        assert_ne!(status, 403, "viewing is allowed");

        let (status, body) = call_as(&state, "vera@gmail.com", Method::POST, "/rpc/deletePaymentShift", r#"{"shiftId":1}"#).await;
        assert_eq!(status, 403);
        assert_eq!(body["reason"], "permission");
        assert_eq!(body["error"], "Seu perfil só permite visualizar Pagamentos.");

        let (status, _) = call_as(&state, "vera@gmail.com", Method::POST, "/rpc/getStorageUsage", "{}").await;
        assert_eq!(status, 403, "Configurações is off for viewers");

        // Moving her to Admin takes effect on the very next request.
        sql::execute(&state.db, "UPDATE app_users SET profile_id = (SELECT id FROM access_profiles WHERE is_admin = 1)", &[]).await.unwrap();
        let (status, _) = call_as(&state, "vera@gmail.com", Method::POST, "/rpc/getStorageUsage", "{}").await;
        assert_eq!(status, 200);
    }

    #[test]
    fn stored_permissions_parse() {
        let p = parse_permissions(Some(&Value::String(r#"{"areas":{"pagamentos":"edit"},"export":true}"#.into()))).unwrap();
        assert_eq!(p.level(PG), Level::Edit);
        assert_eq!(p.level(CA), Level::None);
        assert!(p.export && !p.ai);
    }
}
