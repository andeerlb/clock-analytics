//! "Atividade": who changed what, when, with the before → after of each
//! field. Every request that changes data passes through `record` (after
//! the access check), which pictures the touched record before and after
//! the change and writes one line to `activity_log`. Nothing depends on a
//! screen remembering to log: an operation without an entry in
//! `actions::def` (or `actions::NOT_LOGGED`) fails a test.

pub mod actions;
pub mod snapshot;

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::sql::{self, Row};
use crate::{params, AppState};
use actions::{After, Bulk, Target};
use snapshot::{Entity, Snapshot};

/// Bodies are buffered to read the arguments and the created id; imports can be big.
const BODY_LIMIT: usize = 64 * 1024 * 1024;
/// How many records a bulk line lists (it always says how many there were).
const MAX_ITEMS: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/listActivity", post(list_activity))
        .route("/rpc/listActivityFilters", post(list_activity_filters))
        .route("/rpc/listLastActivity", post(list_last_activity))
}

/// Axum middleware (inside `access::authorize`): runs the request and, when
/// it changed data, records it.
pub async fn record(State(state): State<AppState>, Extension(user): Extension<AuthUser>, request: Request, next: Next) -> Response {
    let path = request.uri().path().trim_start_matches("/api").to_owned();
    let Some(name) = actions::name_of(request.method(), &path) else {
        return next.run(request).await;
    };
    let Some(def) = actions::def(&name) else {
        return next.run(request).await;
    };

    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, BODY_LIMIT).await else {
        return next.run(Request::from_parts(parts, Body::empty())).await;
    };
    let args: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let path_id = path.rsplit('/').next().map(str::to_owned);

    // Before the change: which record, and how it looked.
    let target_id = match def.target {
        Target::Arg(key) => arg_id(&args, key),
        Target::Path => path_id.clone(),
        Target::Lookup { sql: query, arg } => match arg_id(&args, arg) {
            Some(id) => lookup(&state, query, &id).await,
            None => None,
        },
        Target::Reply | Target::None => None,
    };
    let before = match (def.entity, &target_id) {
        (Some(entity), Some(id)) => snapshot::take(&state.db, entity, id).await.unwrap_or_default(),
        _ => None,
    };
    let touches_shifts = def.entity == Some(Entity::Shift) || def.bulk == Bulk::NewShifts;
    let shift_mark = if touches_shifts { max_id(&state, "payment_shifts").await } else { 0 };
    let employee_mark = if def.bulk == Bulk::NewEmployees { max_id(&state, "employees").await } else { 0 };

    let response = next.run(Request::from_parts(parts, Body::from(bytes))).await;
    if !response.status().is_success() {
        return response;
    }
    let (rparts, rbody) = response.into_parts();
    let Ok(rbytes) = to_bytes(rbody, BODY_LIMIT).await else {
        return Response::from_parts(rparts, Body::empty());
    };
    let reply: Value = serde_json::from_slice(&rbytes).unwrap_or(Value::Null);

    let actor = Actor { email: Some(user.email.clone()), name: actor_name(&state, &user).await };
    if let Err(error) = write(&state, &name, def, &args, target_id, before, &reply, &actor, shift_mark, employee_mark).await {
        tracing::warn!(%error, action = %name, "não consegui registrar a atividade");
    }
    Response::from_parts(rparts, Body::from(rbytes))
}

struct Actor {
    email: Option<String>,
    name: String,
}

#[allow(clippy::too_many_arguments)]
async fn write(
    state: &AppState,
    name: &str,
    def: actions::Def,
    args: &Value,
    target_id: Option<String>,
    before: Option<Snapshot>,
    reply: &Value,
    actor: &Actor,
    shift_mark: i64,
    employee_mark: i64,
) -> ApiResult<()> {
    // Who wrote each new version of a turno.
    if shift_mark > 0 || def.entity == Some(Entity::Shift) || def.bulk == Bulk::NewShifts {
        if let Some(email) = &actor.email {
            sql::execute(&state.db, "UPDATE payment_shifts SET created_by = $1 WHERE id > $2 AND created_by IS NULL", &params![email, shift_mark]).await?;
        }
    }

    let reply_id = match reply {
        Value::Number(n) => Some(n.to_string()),
        Value::Object(o) => o.get("id").map(|v| v.to_string().trim_matches('"').to_owned()),
        _ => None,
    };
    let mut verb = def.verb.to_owned();
    if name == "setConfigCheckDisabled" {
        verb = if args.get("disabled").and_then(Value::as_bool).unwrap_or(false) { "pausou a verificação" } else { "retomou a verificação" }.into();
    }

    let (mut entity_id, mut after) = (target_id.clone(), None);
    if let Some(entity) = def.entity {
        let after_id = match (def.after, def.target) {
            (_, Target::Reply) => reply_id.clone(),
            (After::Reply, _) => reply_id.clone().or(target_id.clone()),
            (After::ShiftHead, _) => match &target_id {
                Some(id) => Some(shift_head(state, id).await?),
                None => None,
            },
            (After::Same, _) => target_id.clone(),
        };
        if let Some(id) = &after_id {
            after = snapshot::take(&state.db, entity, id).await?;
            entity_id = Some(id.clone());
        }
    }
    let changes = snapshot::diff(before.as_ref(), after.as_ref());
    // Saved without changing anything: nothing to tell.
    if before.is_some() && after.is_some() && changes.is_empty() {
        return Ok(());
    }

    let mut summary: Option<String> = None;
    let mut items: Vec<Value> = Vec::new();
    match def.bulk {
        Bulk::NewShifts => {
            let rows = sql::select(
                &state.db,
                "SELECT ps.id, e.name AS employee, ps.work_date FROM payment_shifts ps LEFT JOIN employees e ON e.id = ps.employee_id
                 WHERE ps.id > $1 ORDER BY ps.id",
                &params![shift_mark],
            )
            .await?;
            if rows.is_empty() {
                return Ok(());
            }
            summary = Some(count_text(rows.len(), "turno", "turnos"));
            items = rows
                .iter()
                .take(MAX_ITEMS)
                .map(|r| json!({ "id": r.get("id"), "label": format!("{} · {}", text(r, "employee"), snapshot::date_br(&text(r, "work_date"))) }))
                .collect();
        }
        Bulk::NewEmployees => {
            let rows = sql::select(&state.db, "SELECT id, name FROM employees WHERE id > $1 ORDER BY id", &params![employee_mark]).await?;
            if rows.is_empty() {
                return Ok(());
            }
            summary = Some(count_text(rows.len(), "colaborador", "colaboradores"));
            items = rows.iter().take(MAX_ITEMS).map(|r| json!({ "id": r.get("id"), "label": text(r, "name") })).collect();
        }
        Bulk::Count { arg, noun } => {
            let n = args.get(arg).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            summary = Some(format!("{n} {noun}"));
        }
        Bulk::No => {}
    }
    if def.entity.is_none() && summary.is_none() {
        summary = args.get("sourceUrl").and_then(Value::as_str).map(str::to_owned);
    }

    let label = after.as_ref().or(before.as_ref()).map(|s| s.label.clone());
    let changes_json = if changes.is_empty() {
        None
    } else {
        Some(Value::Array(changes.into_iter().map(|(field, before, after)| json!({ "field": field, "before": before, "after": after })).collect()).to_string())
    };
    let items_json = if items.is_empty() { None } else { Some(Value::Array(items).to_string()) };
    sql::execute(
        &state.db,
        "INSERT INTO activity_log (actor_email, actor_name, area, action, verb, entity_type, entity_id, entity_label, summary, changes_json, items_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        &params![
            actor.email,
            actor.name,
            def.area,
            name,
            verb,
            def.entity.map(Entity::key),
            entity_id,
            label,
            summary,
            changes_json,
            items_json
        ],
    )
    .await?;
    Ok(())
}

fn count_text(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn text(row: &Row, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}

fn arg_id(args: &Value, key: &str) -> Option<String> {
    match args.get(key)? {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

async fn lookup(state: &AppState, query: &str, id: &str) -> Option<String> {
    let row = sql::select_one(&state.db, query, &params![id.parse::<i64>().unwrap_or(-1)]).await.ok().flatten()?;
    row.get("id").map(|v| v.to_string())
}

async fn max_id(state: &AppState, table: &str) -> i64 {
    sql::select_one(&state.db, &format!("SELECT COALESCE(MAX(id), 0) AS m FROM {table}"), &[])
        .await
        .ok()
        .flatten()
        .and_then(|r| r.get("m").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// The newest version of a turno: follows `previous_shift_id` forward.
async fn shift_head(state: &AppState, id: &str) -> ApiResult<String> {
    let mut current = id.to_owned();
    for _ in 0..1000 {
        let next = sql::select_one(&state.db, "SELECT id FROM payment_shifts WHERE previous_shift_id = $1", &params![current.parse::<i64>().unwrap_or(-1)]).await?;
        match next.and_then(|r| r.get("id").map(|v| v.to_string())) {
            Some(n) => current = n,
            None => break,
        }
    }
    Ok(current)
}

/// The person's name: from their Google account (kept in `known_users`), else the e-mail.
async fn actor_name(state: &AppState, user: &AuthUser) -> String {
    if let Some(name) = &user.name {
        let _ = sql::execute(
            &state.db,
            "INSERT INTO known_users (email, name) VALUES ($1, $2)
             ON CONFLICT(email) DO UPDATE SET name = excluded.name, updated_at = datetime('now') WHERE known_users.name <> excluded.name",
            &params![user.email, name],
        )
        .await;
        return name.clone();
    }
    sql::select_one(&state.db, "SELECT name FROM known_users WHERE email = $1", &params![user.email])
        .await
        .ok()
        .flatten()
        .map(|r| text(&r, "name"))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| user.email.clone())
}

/* ---------- reading the log ---------- */

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ListArgs {
    actor: Option<String>,
    /// "system" for the automatic verification.
    area: Option<String>,
    from: Option<String>,
    to: Option<String>,
    entity_type: Option<String>,
    entity_id: Option<String>,
    /// Older than this id (the next page).
    before_id: Option<i64>,
    limit: Option<i64>,
}

const ROW_COLUMNS: &str = "id, at, actor_email AS actorEmail, actor_name AS actorName, area, action, verb, entity_type AS entityType,
    entity_id AS entityId, entity_label AS entityLabel, summary, changes_json AS changesJson, items_json AS itemsJson";

async fn list_activity(State(state): State<AppState>, Json(args): Json<ListArgs>) -> ApiResult<Json<Value>> {
    let limit = args.limit.unwrap_or(100).clamp(1, 500);
    let mut wheres: Vec<String> = Vec::new();
    let mut ps: Vec<Value> = Vec::new();
    if args.actor.as_deref() == Some("system") {
        wheres.push("actor_email IS NULL".into());
    }
    let mut add = |cond: &str, value: Value| {
        ps.push(value);
        wheres.push(cond.replace('?', &format!("${}", ps.len())));
    };
    match args.actor.as_deref() {
        Some("system") => {}
        Some(email) if !email.is_empty() => add("actor_email = ?", json!(email)),
        _ => {}
    }
    if let Some(area) = args.area.filter(|a| !a.is_empty()) {
        add("area = ?", json!(area));
    }
    if let Some(from) = args.from.filter(|a| !a.is_empty()) {
        add("at >= ?", json!(from));
    }
    if let Some(to) = args.to.filter(|a| !a.is_empty()) {
        add("at < date(?, '+1 day')", json!(to));
    }
    if let Some(t) = args.entity_type.filter(|a| !a.is_empty()) {
        add("entity_type = ?", json!(t));
    }
    if let Some(id) = args.entity_id.filter(|a| !a.is_empty()) {
        add("entity_id = ?", json!(id));
    }
    if let Some(before) = args.before_id {
        add("id < ?", json!(before));
    }
    let where_clause = if wheres.is_empty() { String::new() } else { format!("WHERE {}", wheres.join(" AND ")) };
    let mut rows = sql::select(&state.db, &format!("SELECT {ROW_COLUMNS} FROM activity_log {where_clause} ORDER BY id DESC LIMIT {}", limit + 1), &ps).await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    for row in &mut rows {
        for (from, to) in [("changesJson", "changes"), ("itemsJson", "items")] {
            let parsed = row.remove(from).and_then(|v| v.as_str().and_then(|t| serde_json::from_str::<Value>(t).ok())).unwrap_or(Value::Array(vec![]));
            row.insert(to.into(), parsed);
        }
    }
    Ok(Json(json!({ "rows": rows, "hasMore": has_more })))
}

/// Who and which areas appear in the log — the Atividade filters.
async fn list_activity_filters(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let people = sql::select(
        &state.db,
        "SELECT actor_email AS email, MAX(actor_name) AS name FROM activity_log WHERE actor_email IS NOT NULL GROUP BY actor_email ORDER BY name",
        &[],
    )
    .await?;
    let system = sql::select_one(&state.db, "SELECT 1 AS x FROM activity_log WHERE actor_email IS NULL LIMIT 1", &[]).await?.is_some();
    let areas = sql::select(&state.db, "SELECT DISTINCT area FROM activity_log ORDER BY area", &[]).await?;
    Ok(Json(json!({ "people": people, "hasSystem": system, "areas": areas.iter().map(|r| text(r, "area")).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastArgs {
    entity_type: String,
    ids: Vec<Value>,
}

/// For a list screen: who last changed each record (and who created it).
async fn list_last_activity(State(state): State<AppState>, Json(args): Json<LastArgs>) -> ApiResult<Json<Vec<Row>>> {
    let ids: Vec<String> = args.ids.iter().map(|v| v.to_string().trim_matches('"').to_owned()).collect();
    if ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let mut ps: Vec<Value> = vec![json!(args.entity_type)];
    let placeholders: Vec<String> = ids
        .iter()
        .map(|id| {
            ps.push(json!(id));
            format!("${}", ps.len())
        })
        .collect();
    let rows = sql::select(
        &state.db,
        &format!(
            "SELECT entity_id AS entityId,
                    (SELECT actor_name FROM activity_log l WHERE l.entity_type = a.entity_type AND l.entity_id = a.entity_id ORDER BY id DESC LIMIT 1) AS actorName,
                    MAX(at) AS at,
                    (SELECT actor_name FROM activity_log l WHERE l.entity_type = a.entity_type AND l.entity_id = a.entity_id ORDER BY id ASC LIMIT 1) AS firstActorName,
                    MIN(at) AS firstAt,
                    (SELECT verb FROM activity_log l WHERE l.entity_type = a.entity_type AND l.entity_id = a.entity_id ORDER BY id ASC LIMIT 1) AS firstVerb,
                    COUNT(*) AS total
             FROM activity_log a
             WHERE entity_type = $1 AND entity_id IN ({})
             GROUP BY entity_id",
            placeholders.join(", ")
        ),
        &ps,
    )
    .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every operation the access rules let someone *edit* with is either
    /// described for the log or deliberately left out — a new one fails here
    /// until it's decided.
    #[test]
    fn every_editing_operation_is_logged_or_listed_as_not_logged() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/access.rs")).unwrap();
        let rules = &source[source.find("fn rpc_rule").unwrap()..source.find("fn allowed").unwrap()];
        let arm = regex::Regex::new(r#"((?:"[A-Za-z]+"\s*\|?\s*)+)=>\s*\{?\s*&\[([^\]]*)\]"#).unwrap();
        let name = regex::Regex::new(r#""([A-Za-z]+)""#).unwrap();
        let mut missing = Vec::new();
        for caps in arm.captures_iter(rules) {
            if !(caps[2].contains("Edit") || caps[2].contains("Users")) {
                continue;
            }
            for n in name.captures_iter(&caps[1]) {
                let n = &n[1];
                if actions::def(n).is_none() && !actions::NOT_LOGGED.contains(&n) {
                    missing.push(n.to_owned());
                }
            }
        }
        assert!(missing.is_empty(), "sem descrição na atividade (actions.rs): {missing:?}");
    }
}
