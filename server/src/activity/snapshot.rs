//! What a record looks like, field by field, in words a person reads — taken
//! right before and right after a change, so the activity log can say
//! "Valor: R$ 100,00 → R$ 120,00".

use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::ApiResult;
use crate::params;
use crate::sql::{self, Row};

/// The kinds of record the activity log knows how to describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entity {
    Shift,
    Employee,
    Company,
    Client,
    Role,
    PaymentTemplate,
    EmployeeTemplate,
    ExportTemplate,
    PdfTemplate,
    ReimportConfig,
    AppUser,
    Profile,
    Import,
}

impl Entity {
    /// Stored in `activity_log.entity_type`; the frontend links on it.
    pub fn key(self) -> &'static str {
        match self {
            Entity::Shift => "shift",
            Entity::Employee => "employee",
            Entity::Company => "company",
            Entity::Client => "client",
            Entity::Role => "role",
            Entity::PaymentTemplate => "paymentTemplate",
            Entity::EmployeeTemplate => "employeeTemplate",
            Entity::ExportTemplate => "exportTemplate",
            Entity::PdfTemplate => "pdfTemplate",
            Entity::ReimportConfig => "reimportConfig",
            Entity::AppUser => "appUser",
            Entity::Profile => "profile",
            Entity::Import => "import",
        }
    }
}

/// A field whose value isn't worth showing (a whole layout's JSON): the log
/// only says it changed.
pub const OPAQUE_PREFIX: &str = "~";

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub label: String,
    pub fields: Vec<(String, String)>,
}

pub async fn take(db: &SqlitePool, entity: Entity, id: &str) -> ApiResult<Option<Snapshot>> {
    match entity {
        Entity::Shift => shift(db, id).await,
        Entity::Employee => employee(db, id).await,
        Entity::Company => company(db, id).await,
        Entity::Client => client(db, id).await,
        Entity::Role => role(db, id).await,
        Entity::PaymentTemplate => payment_template(db, id).await,
        Entity::EmployeeTemplate => employee_template(db, id).await,
        Entity::ExportTemplate => config_template(db, "payment_export_templates", id).await,
        Entity::PdfTemplate => config_template(db, "payment_pdf_templates", id).await,
        Entity::ReimportConfig => reimport_config(db, id).await,
        Entity::AppUser => app_user(db, id).await,
        Entity::Profile => profile(db, id).await,
        Entity::Import => import(db, id).await,
    }
}

/* ---------- formatting ---------- */

fn s(row: &Row, key: &str) -> String {
    match row.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(v)) => v.trim().to_owned(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => if *b { "sim".into() } else { "não".into() },
        Some(other) => other.to_string(),
    }
}

fn n(row: &Row, key: &str) -> Option<f64> {
    row.get(key).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|t| t.parse().ok())))
}

/// "2026-11-18" → "18/11/2026" (anything else as it is).
pub fn date_br(iso: &str) -> String {
    let p: Vec<&str> = iso.get(..10).unwrap_or(iso).split('-').collect();
    if p.len() == 3 { format!("{}/{}/{}", p[2], p[1], p[0]) } else { iso.to_owned() }
}

fn hhmm(minutes: f64) -> String {
    let m = minutes.round() as i64;
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// 1234.5 → "R$ 1.234,50".
pub fn money(value: f64) -> String {
    let cents = (value * 100.0).round() as i64;
    let (int, frac) = (cents.abs() / 100, cents.abs() % 100);
    let digits = int.to_string();
    let mut grouped = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push('.');
        }
        grouped.push(ch);
    }
    format!("{}R$ {grouped},{frac:02}", if cents < 0 { "-" } else { "" })
}

fn or_dash(v: String) -> String {
    if v.is_empty() { "—".into() } else { v }
}

fn json_of(row: &Row, key: &str) -> Value {
    match row.get(key) {
        Some(Value::String(t)) => serde_json::from_str(t).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

fn field_label(field: &str) -> &str {
    match field {
        "funcao" => "Função",
        "local" => "Local",
        "data" => "Data",
        "horario" => "Horário",
        "status" => "Status",
        "nome" => "Nome",
        "cpf" => "CPF",
        "matricula" => "Matrícula",
        "pix" => "PIX",
        "aba" => "Aba",
        other => other,
    }
}

fn status_label(status: &str) -> &str {
    match status {
        "pendente" => "Pendente",
        "pago" => "Pago",
        "erro" => "Erro",
        other => other,
    }
}

/// A rule's tests: `[{field, values}]` (or the older single field/values_json columns).
fn tests_text(row: &Row) -> String {
    let conditions = json_of(row, "conditions_json");
    let mut parts: Vec<String> = Vec::new();
    if let Some(list) = conditions.as_array().filter(|l| !l.is_empty()) {
        for c in list {
            let field = c.get("field").and_then(Value::as_str).unwrap_or("");
            let values: Vec<String> = c.get("values").and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            parts.push(format!("{} {}", field_label(field), if values.is_empty() { "vazio".into() } else { values.join(" ou ") }));
        }
    } else {
        let field = s(row, "field");
        let values: Vec<String> = json_of(row, "values_json").as_array().map(|v| v.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        if !field.is_empty() {
            parts.push(format!("{} {}", field_label(&field), if values.is_empty() { "vazio".into() } else { values.join(" ou ") }));
        }
    }
    parts.join(" e ")
}

/// A pay-value rule as a sentence: "Função Caixa · 6h ou mais → R$ 120,00".
fn value_rule_text(row: &Row) -> String {
    let amount = n(row, "amount").map(money).unwrap_or_else(|| "—".into());
    if s(row, "kind") == "else" {
        return format!("Qualquer outro turno → {amount}");
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(list) = json_of(row, "conditions_json").as_array() {
        for c in list {
            let field = c.get("field").and_then(Value::as_str).unwrap_or("");
            if field == "horario" {
                let rule = c.get("scheduleRule").and_then(Value::as_str).unwrap_or("");
                let minutes = c.get("scheduleMinutes").and_then(Value::as_f64).unwrap_or(0.0);
                let what = if rule.starts_with("start") { "começando" } else { "terminando" };
                let when = if rule.ends_with("after") { "depois das" } else { "antes das" };
                parts.push(format!("{what} {when} {}", hhmm(minutes)));
            } else {
                let values: Vec<String> = c.get("values").and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                parts.push(format!("{} {}", field_label(field), values.join(" ou ")));
            }
        }
    }
    let op = s(row, "operator");
    let threshold = n(row, "threshold_minutes").unwrap_or(0.0);
    if !(op == ">=" && threshold == 0.0) && !op.is_empty() {
        let h = format!("{}h{}", (threshold as i64) / 60, if (threshold as i64) % 60 > 0 { format!("{:02}", (threshold as i64) % 60) } else { String::new() });
        parts.push(match op.as_str() {
            "=" => format!("{h} exatas"),
            ">=" => format!("{h} ou mais"),
            "<=" => format!("{h} ou menos"),
            ">" => format!("mais de {h}"),
            "<" => format!("menos de {h}"),
            "!=" => format!("diferente de {h}"),
            other => format!("{other} {h}"),
        });
    }
    if parts.is_empty() {
        parts.push("Todo turno".into());
    }
    format!("{} → {amount}", parts.join(" · "))
}

fn night_text(start: &str, end: &str, rule: &str) -> String {
    if start.is_empty() {
        return "o da empresa".into();
    }
    let rule = match rule {
        "start-in-range" => "início no intervalo",
        "end-in-range" => "fim no intervalo",
        "start-or-end-in-range" => "início ou fim no intervalo",
        "overlap" => "qualquer sobreposição",
        "majority-overlap" => "mais da metade no intervalo",
        other => other,
    };
    format!("{start}–{end} ({rule})")
}

/* ---------- entities ---------- */

async fn shift(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let Some(r) = sql::select_one(
        db,
        "SELECT e.name AS employee, cl.name AS client, c.name AS company, ps.work_date, ps.local, r.name AS role,
                ps.schedule_start_minutes AS s, ps.schedule_end_minutes AS e2, ps.amount, ps.status, ps.error_message,
                ps.deleted_at, ps.note, pa.result AS audit, pa.note AS audit_note
         FROM payment_shifts ps
         LEFT JOIN employees e ON e.id = ps.employee_id
         LEFT JOIN clients cl ON cl.id = ps.client_id
         LEFT JOIN companies c ON c.id = ps.company_id
         LEFT JOIN roles r ON r.id = ps.role_id
         LEFT JOIN payment_audits pa ON pa.payment_shift_id = ps.id
         WHERE ps.id = $1",
        &params![id.parse::<i64>().unwrap_or(-1)],
    )
    .await?
    else {
        return Ok(None);
    };
    let horario = match (n(&r, "s"), n(&r, "e2")) {
        (Some(a), Some(b)) => format!("{} – {}", hhmm(a), hhmm(b)),
        _ => "—".into(),
    };
    let mut status = status_label(&s(&r, "status")).to_owned();
    if s(&r, "status") == "erro" && !s(&r, "error_message").is_empty() {
        status = format!("{status} — {}", s(&r, "error_message"));
    }
    let audit = match s(&r, "audit").as_str() {
        "" => "—".to_owned(),
        result => {
            let note = s(&r, "audit_note");
            if note.is_empty() { result.to_owned() } else { format!("{result} — {note}") }
        }
    };
    let mut fields = vec![
        ("Colaborador".into(), or_dash(s(&r, "employee"))),
        ("Cliente".into(), or_dash(s(&r, "client"))),
        ("Empresa".into(), or_dash(s(&r, "company"))),
        ("Data".into(), date_br(&s(&r, "work_date"))),
        ("Local".into(), or_dash(s(&r, "local"))),
        ("Função".into(), or_dash(s(&r, "role"))),
        ("Horário".into(), horario),
        ("Valor".into(), n(&r, "amount").map(money).unwrap_or_else(|| "—".into())),
        ("Status".into(), status),
        ("Conferência".into(), audit),
        ("Observação".into(), or_dash(s(&r, "note"))),
    ];
    if !s(&r, "deleted_at").is_empty() {
        fields.push(("Excluído".into(), "sim".into()));
    }
    let date = s(&r, "work_date");
    Ok(Some(Snapshot { label: format!("{} · {}", s(&r, "employee"), date_br(&date).get(..5).unwrap_or("")), fields }))
}

async fn employee(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT name, cpf FROM employees WHERE id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let pix = sql::select(db, "SELECT key_value FROM employee_pix_keys WHERE employee_id = $1 ORDER BY id", &params![id]).await?;
    let aliases = sql::select(db, "SELECT alias FROM employee_aliases WHERE employee_id = $1 ORDER BY alias", &params![id]).await?;
    let links = sql::select(
        db,
        "SELECT cl.name AS client, c.name AS company, ecc.matricula
         FROM employee_client_companies ecc JOIN clients cl ON cl.id = ecc.client_id JOIN companies c ON c.id = ecc.company_id
         WHERE ecc.employee_id = $1 ORDER BY cl.name, c.name",
        &params![id],
    )
    .await?;
    let join = |rows: &[Row], key: &str| or_dash(rows.iter().map(|x| s(x, key)).collect::<Vec<_>>().join("; "));
    let links_text = or_dash(
        links
            .iter()
            .map(|l| {
                let m = s(l, "matricula");
                if m.is_empty() { format!("{} / {}", s(l, "client"), s(l, "company")) } else { format!("{} / {} (matrícula {m})", s(l, "client"), s(l, "company")) }
            })
            .collect::<Vec<_>>()
            .join("; "),
    );
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![
            ("Nome".into(), s(&r, "name")),
            ("CPF".into(), or_dash(s(&r, "cpf"))),
            ("PIX".into(), join(&pix, "key_value")),
            ("Outros nomes".into(), join(&aliases, "alias")),
            ("Vínculos".into(), links_text),
        ],
    }))
}

async fn company(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT name, cnpj, night_start_time, night_end_time, night_shift_rule FROM companies WHERE id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let rules = sql::select(db, "SELECT * FROM payment_value_rules WHERE company_id = $1 ORDER BY id", &params![id]).await?;
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![
            ("Nome".into(), s(&r, "name")),
            ("CNPJ".into(), s(&r, "cnpj")),
            ("Adicional noturno".into(), night_text(&s(&r, "night_start_time"), &s(&r, "night_end_time"), &s(&r, "night_shift_rule"))),
            ("Valor do turno".into(), or_dash(rules.iter().map(value_rule_text).collect::<Vec<_>>().join("; "))),
        ],
    }))
}

async fn client(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT name, cnpj, night_start_time, night_end_time, night_shift_rule FROM clients WHERE id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let companies = sql::select(db, "SELECT c.name FROM client_companies cc JOIN companies c ON c.id = cc.company_id WHERE cc.client_id = $1 ORDER BY c.name", &params![id]).await?;
    let rules = sql::select(db, "SELECT * FROM client_payment_value_rules WHERE client_id = $1 ORDER BY id", &params![id]).await?;
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![
            ("Nome".into(), s(&r, "name")),
            ("CNPJ".into(), s(&r, "cnpj")),
            ("Empresas".into(), or_dash(companies.iter().map(|c| s(c, "name")).collect::<Vec<_>>().join(", "))),
            ("Adicional noturno".into(), night_text(&s(&r, "night_start_time"), &s(&r, "night_end_time"), &s(&r, "night_shift_rule"))),
            (
                "Valor do turno".into(),
                if rules.is_empty() { "o da empresa".into() } else { rules.iter().map(value_rule_text).collect::<Vec<_>>().join("; ") },
            ),
        ],
    }))
}

async fn role(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT r.name, c.name AS company FROM roles r LEFT JOIN companies c ON c.id = r.company_id WHERE r.id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let aliases = sql::select(db, "SELECT alias FROM role_aliases WHERE role_id = $1 ORDER BY alias", &params![id]).await?;
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![
            ("Nome".into(), s(&r, "name")),
            ("Empresa".into(), or_dash(s(&r, "company"))),
            ("Outros nomes".into(), or_dash(aliases.iter().map(|a| s(a, "alias")).collect::<Vec<_>>().join("; "))),
        ],
    }))
}

fn identification_text(row: &Row) -> String {
    let attempts = json_of(row, "identifier_priority");
    let mut order: Vec<&str> = Vec::new();
    for a in attempts.as_array().into_iter().flatten() {
        for f in a.get("fields").and_then(Value::as_array).into_iter().flatten() {
            if let Some(f) = f.as_str() {
                order.push(field_label(f));
            }
        }
    }
    or_dash(order.join(", depois "))
}

fn kinds_text(row: &Row) -> String {
    let mut kinds = vec![s(row, "file_kind").to_uppercase()];
    for k in json_of(row, "accepted_file_kinds_json").as_array().into_iter().flatten() {
        if let Some(k) = k.as_str() {
            let k = k.to_uppercase();
            if !kinds.contains(&k) {
                kinds.push(k);
            }
        }
    }
    kinds.join(", ")
}

/// Sheets and columns of a template's groups (payment or employee tables).
async fn groups_text(db: &SqlitePool, prefix: &str, template_id: i64) -> ApiResult<(String, String, String)> {
    let groups = sql::select(db, &format!("SELECT id FROM {prefix}_template_groups WHERE template_id = $1 ORDER BY id"), &params![template_id]).await?;
    let (mut included, mut ignored, mut columns) = (Vec::new(), Vec::new(), Vec::new());
    for g in &groups {
        let gid = n(g, "id").unwrap_or(-1.0) as i64;
        let sheets = sql::select(db, &format!("SELECT sheet_name, included FROM {prefix}_template_sheets WHERE group_id = $1 ORDER BY sheet_name"), &params![gid]).await?;
        let fields = sql::select(db, &format!("SELECT column_letter, target_field FROM {prefix}_template_fields WHERE group_id = $1 ORDER BY length(column_letter), column_letter"), &params![gid]).await?;
        let names: Vec<String> = sheets.iter().filter(|x| n(x, "included").unwrap_or(1.0) != 0.0).map(|x| s(x, "sheet_name")).collect();
        ignored.extend(sheets.iter().filter(|x| n(x, "included").unwrap_or(1.0) == 0.0).map(|x| s(x, "sheet_name")));
        if fields.is_empty() {
            included.extend(names);
            continue;
        }
        let cols = fields.iter().map(|f| format!("{} {}", s(f, "column_letter"), field_label(&s(f, "target_field")))).collect::<Vec<_>>().join(", ");
        columns.push(if names.is_empty() { cols } else { format!("{}: {cols}", names.join(", ")) });
        included.extend(names);
    }
    Ok((or_dash(included.join(", ")), or_dash(ignored.join(", ")), or_dash(columns.join(" | "))))
}

async fn payment_template(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT * FROM payment_templates WHERE id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let (sheets, ignored, columns) = groups_text(db, "payment", id).await?;
    let rules = sql::select(
        db,
        "SELECT r.*, c.name AS company, cl.name AS client FROM payment_template_rules r
         LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN clients cl ON cl.id = r.client_id
         WHERE r.template_id = $1 ORDER BY r.id",
        &params![id],
    )
    .await?;
    let destinations = rules
        .iter()
        .map(|x| {
            let dest = format!("{} ({})", s(x, "client"), s(x, "company"));
            if s(x, "kind") == "else" { format!("Qualquer outro → {dest}") } else { format!("{} → {dest}", tests_text(x)) }
        })
        .collect::<Vec<_>>()
        .join("; ");
    let status_rules = sql::select(db, "SELECT * FROM payment_template_status_rules WHERE template_id = $1 ORDER BY id", &params![id]).await?;
    let statuses = status_rules
        .iter()
        .map(|x| {
            let st = status_label(&s(x, "status")).to_owned();
            if s(x, "kind") == "else" { format!("Qualquer outro → {st}") } else { format!("{} → {st}", tests_text(x)) }
        })
        .collect::<Vec<_>>()
        .join("; ");
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![
            ("Nome".into(), s(&r, "name")),
            ("Formatos".into(), kinds_text(&r)),
            ("Formato das datas".into(), s(&r, "date_format")),
            ("Abas".into(), sheets),
            ("Abas ignoradas".into(), ignored),
            ("Colunas".into(), columns),
            ("Destinos".into(), or_dash(destinations)),
            ("Status".into(), if statuses.is_empty() { "todo turno entra como Pendente".into() } else { statuses }),
            ("Identificação".into(), identification_text(&r)),
        ],
    }))
}

async fn employee_template(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT * FROM employee_templates WHERE id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let (sheets, ignored, columns) = groups_text(db, "employee", id).await?;
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![
            ("Nome".into(), s(&r, "name")),
            ("Formatos".into(), kinds_text(&r)),
            ("Abas".into(), sheets),
            ("Abas ignoradas".into(), ignored),
            ("Colunas".into(), columns),
            ("Identificação".into(), identification_text(&r)),
        ],
    }))
}

async fn config_template(db: &SqlitePool, table: &str, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, &format!("SELECT name, config_json FROM {table} WHERE id = $1"), &params![id]).await? else {
        return Ok(None);
    };
    Ok(Some(Snapshot {
        label: s(&r, "name"),
        fields: vec![("Nome".into(), s(&r, "name")), (format!("{OPAQUE_PREFIX}Layout"), s(&r, "config_json"))],
    }))
}

async fn reimport_config(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(
        db,
        "SELECT rc.*, t.name AS template FROM source_url_reimport_configs rc LEFT JOIN payment_templates t ON t.id = rc.template_id WHERE rc.id = $1",
        &params![id],
    )
    .await?
    else {
        return Ok(None);
    };
    let period = if s(&r, "date_mode") == "relative" {
        format!("de {} a {} dias a partir de hoje", s(&r, "start_offset_days"), s(&r, "end_offset_days"))
    } else {
        format!("{} a {}", date_br(&s(&r, "period_start")), date_br(&s(&r, "period_end")))
    };
    let label = if s(&r, "label").is_empty() { s(&r, "source_url") } else { s(&r, "label") };
    Ok(Some(Snapshot {
        label,
        fields: vec![
            ("Nome".into(), or_dash(s(&r, "label"))),
            ("Link".into(), s(&r, "source_url")),
            ("Template".into(), or_dash(s(&r, "template"))),
            ("Período".into(), period),
            ("Pausada".into(), if n(&r, "check_disabled").unwrap_or(0.0) != 0.0 { "sim".into() } else { "não".into() }),
        ],
    }))
}

async fn app_user(db: &SqlitePool, email: &str) -> ApiResult<Option<Snapshot>> {
    let Some(r) = sql::select_one(db, "SELECT p.name AS profile FROM app_users u JOIN access_profiles p ON p.id = u.profile_id WHERE u.email = $1", &params![email]).await? else {
        return Ok(None);
    };
    Ok(Some(Snapshot { label: email.to_owned(), fields: vec![("Perfil".into(), s(&r, "profile"))] }))
}

async fn profile(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(db, "SELECT name, permissions_json FROM access_profiles WHERE id = $1", &params![id]).await? else {
        return Ok(None);
    };
    let p = json_of(&r, "permissions_json");
    let mut parts: Vec<String> = Vec::new();
    if let Some(areas) = p.get("areas").and_then(Value::as_object) {
        let mut keys: Vec<&String> = areas.keys().collect();
        keys.sort();
        for k in keys {
            let level = match areas[k].as_str().unwrap_or("") {
                "edit" => "editar",
                "view" => "ver",
                _ => continue,
            };
            parts.push(format!("{k}: {level}"));
        }
    }
    for (flag, text) in [("export", "exportar"), ("ai", "assistente"), ("users", "usuários")] {
        if p.get(flag).and_then(Value::as_bool).unwrap_or(false) {
            parts.push(text.into());
        }
    }
    Ok(Some(Snapshot { label: s(&r, "name"), fields: vec![("Nome".into(), s(&r, "name")), ("Permissões".into(), or_dash(parts.join(", ")))] }))
}

async fn import(db: &SqlitePool, id: &str) -> ApiResult<Option<Snapshot>> {
    let id = id.parse::<i64>().unwrap_or(-1);
    let Some(r) = sql::select_one(
        db,
        "SELECT e.name AS employee, i.period_start, i.period_end, i.provider FROM imports i LEFT JOIN employees e ON e.id = i.employee_id WHERE i.id = $1",
        &params![id],
    )
    .await?
    else {
        return Ok(None);
    };
    let period = format!("{} a {}", date_br(&s(&r, "period_start")), date_br(&s(&r, "period_end")));
    Ok(Some(Snapshot {
        label: format!("{} · {period}", s(&r, "employee")),
        fields: vec![("Colaborador".into(), s(&r, "employee")), ("Período".into(), period), ("Provedor".into(), s(&r, "provider"))],
    }))
}

/// Field-by-field differences between two snapshots (either may be missing:
/// a record created or deleted). Opaque fields only say that they changed.
pub fn diff(before: Option<&Snapshot>, after: Option<&Snapshot>) -> Vec<(String, String, String)> {
    let empty: Vec<(String, String)> = Vec::new();
    let b = before.map(|x| &x.fields).unwrap_or(&empty);
    let a = after.map(|x| &x.fields).unwrap_or(&empty);
    let mut names: Vec<&String> = b.iter().map(|(k, _)| k).collect();
    for (k, _) in a {
        if !names.contains(&k) {
            names.push(k);
        }
    }
    let get = |list: &Vec<(String, String)>, k: &str| list.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let mut out = Vec::new();
    for name in names {
        let (old, new) = (get(b, name), get(a, name));
        if old == new {
            continue;
        }
        let blank = |v: &Option<String>| v.as_deref().map(|x| x == "—" || x.is_empty()).unwrap_or(true);
        if before.is_none() && blank(&new) {
            continue; // a new record: only what it was created with
        }
        if after.is_none() && blank(&old) {
            continue;
        }
        if let Some(label) = name.strip_prefix(OPAQUE_PREFIX) {
            let text = match (&old, &new) {
                (None, _) => "definido",
                (_, None) => "removido",
                _ => "alterado",
            };
            out.push((label.to_owned(), String::new(), text.to_owned()));
            continue;
        }
        out.push((name.clone(), old.unwrap_or_default(), new.unwrap_or_default()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_and_dates_read_like_the_app() {
        assert_eq!(money(1234.5), "R$ 1.234,50");
        assert_eq!(money(120.0), "R$ 120,00");
        assert_eq!(date_br("2026-11-18"), "18/11/2026");
    }

    #[test]
    fn diff_lists_only_what_changed() {
        let a = Snapshot { label: "x".into(), fields: vec![("Valor".into(), "R$ 100,00".into()), ("Local".into(), "A".into()), ("~Layout".into(), "{1}".into())] };
        let b = Snapshot { label: "x".into(), fields: vec![("Valor".into(), "R$ 120,00".into()), ("Local".into(), "A".into()), ("~Layout".into(), "{2}".into())] };
        assert_eq!(
            diff(Some(&a), Some(&b)),
            vec![("Valor".into(), "R$ 100,00".into(), "R$ 120,00".into()), ("Layout".into(), String::new(), "alterado".into())]
        );
        // Created: what it was created with, blanks left out.
        let c = Snapshot { label: "x".into(), fields: vec![("Nome".into(), "Ana".into()), ("CPF".into(), "—".into())] };
        assert_eq!(diff(None, Some(&c)), vec![("Nome".into(), String::new(), "Ana".into())]);
    }
}
