//! `computeReimportDiff` and `acceptShiftChange` (`src/lib/remoteCheckDiff.ts`),
//! line by line. Every database lookup goes through the same RPC handler the
//! TS called (`routes::call`), with the same arguments, so the matching rules
//! (employee by CPF/matrícula/nome, duplicates, position fallback, auto-sync)
//! are literally the code the import screen uses.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::rules::{self, Fields, RouteRule, StatusRule};
use super::ReimportConfig;
use crate::error::{ApiError, ApiResult};
use crate::routes::payments::import::{find_duplicates_impl, DuplicateCandidate};
use crate::routes::payments::templates::get_payment_template_impl;
use crate::routes::{call, commands, employees, payments, roles, timesheets};
use crate::AppState;

/// "Aceitar" on one turno (`AutoApplyOptions` with `onlyShiftId`, both
/// protections lifted). The web version has no unattended auto-apply, so
/// this is the only way the diff ever writes, and it only ever updates the
/// fields of this one shift: it never creates or deletes one.
#[derive(Debug, Clone)]
pub struct Accept {
    pub shift_id: i64,
    pub source_file_id: i64,
}

/// `CheckDiffInput`: one row of `source_url_check_diffs`, before saving.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub config_id: Option<i64>,
    pub config_label: String,
    pub change_kind: String,
    pub matched_shift_id: Option<i64>,
    pub employee_id: Option<i64>,
    pub employee_name: Option<String>,
    pub work_date: Option<String>,
    pub local: Option<String>,
    pub role: Option<String>,
    pub schedule_start_minutes: Option<i64>,
    pub schedule_end_minutes: Option<i64>,
    pub sheet_name: Option<String>,
    pub row_number: Option<i64>,
    pub column_letter: Option<String>,
    pub field_name: Option<String>,
    /// Text for status/identity fields; for an `extra:` column, whatever the
    /// stored JSON held (always text in practice).
    pub old_value: Option<Value>,
    pub new_value: Option<Value>,
    pub message: Option<String>,
    pub applied: bool,
}

impl DiffEntry {
    /// `errorDiffEntry` (RemoteFileUpdatesContext.tsx).
    pub fn error(config_id: Option<i64>, config_label: &str, message: String) -> Self {
        DiffEntry {
            config_id,
            config_label: config_label.to_owned(),
            change_kind: "error".into(),
            matched_shift_id: None,
            employee_id: None,
            employee_name: None,
            work_date: None,
            local: None,
            role: None,
            schedule_start_minutes: None,
            schedule_end_minutes: None,
            sheet_name: None,
            row_number: None,
            column_letter: None,
            field_name: None,
            old_value: None,
            new_value: None,
            message: Some(message),
            applied: false,
        }
    }
}

/// `String(e instanceof Error ? e.message : e)` for a failed RPC: what the
/// browser would have shown for that error.
pub fn error_text(error: &ApiError) -> String {
    match error {
        ApiError::Database(_) | ApiError::Internal(_) => {
            tracing::error!(%error, "verificação automática: erro interno");
            "Erro interno no servidor.".into()
        }
        other => other.to_string(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldMapping {
    column_letter: String,
    target_field: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateGroup {
    #[serde(default)]
    sheet_names: Vec<String>,
    #[serde(default)]
    field_mappings: Vec<FieldMapping>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Template {
    groups: Vec<TemplateGroup>,
    delimiter: Option<String>,
    #[serde(default)]
    date_format: String,
    identifier_priority: Value,
    rules: Vec<RouteRule>,
    status_rules: Vec<StatusRule>,
}

/// `AppliedPaymentRow`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppliedRow {
    sheet_name: Option<String>,
    row_number: i64,
    fields: Fields,
    extra_fields: Map<String, Value>,
}

/// `ParsedCandidate`.
struct Candidate {
    employee_id: i64,
    employee_name: String,
    client_id: i64,
    company_id: i64,
    work_date: String,
    local: String,
    role: String,
    role_id: Option<i64>,
    schedule_start_minutes: Option<i64>,
    schedule_end_minutes: Option<i64>,
    sheet_name: Option<String>,
    row_number: i64,
    status: String,
    extra_fields: Map<String, Value>,
}

/// The shift a candidate is compared against (`CurrentShift`).
struct CurrentShift {
    shift_id: i64,
    work_date: String,
    local: String,
    role: String,
    role_id: Option<i64>,
    schedule_start_minutes: Option<i64>,
    schedule_end_minutes: Option<i64>,
    status: String,
    extra_data: Value,
}

/// Synthetic `extra_data` keys the import adds (arquivo/linha/aba de origem).
const PROVENANCE_EXTRA_KEYS: [&str; 3] = ["arquivo de origem", "linha de origem", "aba de origem"];

fn int(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

impl CurrentShift {
    fn from_row(shift_id: i64, row: &Value) -> Self {
        CurrentShift {
            shift_id,
            work_date: text(row, "workDate").unwrap_or_default(),
            local: text(row, "local").unwrap_or_default(),
            role: text(row, "role").unwrap_or_default(),
            role_id: int(row, "roleId"),
            schedule_start_minutes: int(row, "scheduleStartMinutes"),
            schedule_end_minutes: int(row, "scheduleEndMinutes"),
            status: text(row, "status").unwrap_or_default(),
            extra_data: row.get("extraData").cloned().unwrap_or(Value::Null),
        }
    }
}

/// "08:00–17:00", or "—" with no schedule.
fn format_schedule_range(start: Option<i64>, end: Option<i64>) -> String {
    match (start, end) {
        (Some(s), Some(e)) => format!("{}–{}", rules::format_minutes_as_time(s), rules::format_minutes_as_time(e)),
        _ => "—".into(),
    }
}

/// `row.fields.x || null`.
fn non_empty(fields: &Fields, key: &str) -> Option<String> {
    fields.get(key).filter(|v| !v.is_empty()).cloned()
}

fn extra_or_null(extra: &Map<String, Value>) -> Value {
    if extra.is_empty() {
        Value::Null
    } else {
        Value::Object(extra.clone())
    }
}

/// `computeReimportDiff`: what reimporting `downloaded_path` through this
/// config would change. Read-only, except for the one shift of an `accept`.
/// Fails only for a whole-config problem (template gone, unreadable file);
/// the caller turns that into one `error` entry.
pub async fn compute_reimport_diff(state: &AppState, config: &ReimportConfig, downloaded_path: &str, accept: Option<&Accept>) -> ApiResult<Vec<DiffEntry>> {
    let template: Template = serde_json::from_value(get_payment_template_impl(state, config.template_id).await?)
        .map_err(|e| ApiError::Internal(format!("template inesperado: {e}")))?;
    let groups: Vec<Value> = template
        .groups
        .iter()
        .map(|g| json!({ "sheetNames": g.sheet_names, "fieldMappings": g.field_mappings.iter().map(|fm| [&fm.column_letter, &fm.target_field]).collect::<Vec<_>>() }))
        .collect();
    let applied: Vec<AppliedRow> = serde_json::from_value(
        call(state, commands::apply_payment_template, json!({ "path": downloaded_path, "groups": groups, "delimiter": template.delimiter })).await?,
    )
    .map_err(|e| ApiError::Internal(e.to_string()))?;

    let (period_start, period_end) = rules::resolve_reimport_period(&config.period, state.remote_checks.today());
    let config_label = config.label();
    let source_url = &config.source_url;

    let unresolved_entry = |row: &AppliedRow, work_date: &str, schedule: Option<(i64, i64)>, message: String| DiffEntry {
        config_id: Some(config.id),
        config_label: config_label.clone(),
        change_kind: "unresolved".into(),
        matched_shift_id: None,
        employee_id: None,
        employee_name: non_empty(&row.fields, "nome"),
        work_date: Some(work_date.to_owned()),
        local: row.fields.get("local").cloned(),
        role: row.fields.get("funcao").cloned(),
        schedule_start_minutes: schedule.map(|s| s.0),
        schedule_end_minutes: schedule.map(|s| s.1),
        sheet_name: row.sheet_name.clone(),
        row_number: Some(row.row_number),
        column_letter: None,
        field_name: None,
        old_value: None,
        new_value: None,
        message: Some(message),
        applied: false,
    };

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut unresolved_entries: Vec<DiffEntry> = Vec::new();
    let mut accounted_for: HashSet<i64> = HashSet::new();

    for row in &applied {
        let work_date_raw = row.fields.get("data").map(String::as_str).unwrap_or("");
        let work_date = if work_date_raw.is_empty() { None } else { rules::parse_date_with_format(work_date_raw, &template.date_format) };
        let Some(work_date) = work_date else { continue };
        if period_start.as_deref().is_some_and(|s| !s.is_empty() && work_date.as_str() < s)
            || period_end.as_deref().is_some_and(|e| !e.is_empty() && work_date.as_str() > e)
        {
            continue;
        }

        let parsed_schedule = rules::parse_schedule_to_minutes(row.fields.get("horario").map(String::as_str).unwrap_or(""));
        let fields_with_sheet = rules::with_sheet_name_field(&row.fields, row.sheet_name.as_deref());

        let Some(route) = rules::resolve_payment_route(&template.rules, &fields_with_sheet) else {
            unresolved_entries.push(unresolved_entry(
                row,
                &work_date,
                parsed_schedule,
                "Nenhuma regra de rota bateu com esta linha — não dá pra saber a qual cliente/empresa ela pertence.".into(),
            ));
            continue;
        };

        let values = json!({
            "cpf": non_empty(&row.fields, "cpf"),
            "matricula": non_empty(&row.fields, "matricula"),
            "nome": non_empty(&row.fields, "nome"),
        });
        let employee = call(
            state,
            employees::find_employee_by_attempts,
            json!({ "clientId": route.client_id, "companyId": route.company_id, "attempts": template.identifier_priority, "values": values }),
        )
        .await?;
        if employee.is_null() {
            let positional = call(
                state,
                payments::import::find_payment_shift_by_position,
                json!({ "sourceUrl": source_url, "sheetName": row.sheet_name, "rowNumber": row.row_number }),
            )
            .await?;
            if let Some(id) = int(&positional, "shiftId") {
                accounted_for.insert(id);
            }
            let elsewhere = call(state, employees::find_employee_anywhere_by_attempts, json!({ "attempts": template.identifier_priority, "values": values })).await?;
            let shown_name = non_empty(&row.fields, "nome").unwrap_or_else(|| "(nome vazio)".into());
            let mut message = if positional.is_null() {
                format!("Colaborador não encontrado para \"{shown_name}\".")
            } else {
                let sheet = row.sheet_name.as_ref().filter(|s| !s.is_empty()).map(|s| format!("aba {s}, ")).unwrap_or_default();
                format!(
                    "Colaborador não encontrado para \"{shown_name}\" — nesta posição ({sheet}linha {}) havia antes um turno de \"{}\".",
                    row.row_number,
                    text(&positional, "employeeName").unwrap_or_default()
                )
            };
            if !elsewhere.is_null() {
                let pairs = elsewhere
                    .get("links")
                    .and_then(Value::as_array)
                    .map(|links| {
                        links
                            .iter()
                            .map(|l| format!("{} ({})", text(l, "clientName").unwrap_or_default(), text(l, "companyName").unwrap_or_default()))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                message.push_str(&format!(
                    " Existe um colaborador com esse nome cadastrado em {pairs}, mas a regra desta linha aponta para {} ({}) — reveja em \"Importar pagamentos\" para vincular o cadastro, se for o caso.",
                    route.client_name, route.company_name
                ));
            }
            unresolved_entries.push(unresolved_entry(row, &work_date, parsed_schedule, message));
            continue;
        }

        let role = call(state, roles::find_role_by_name, json!({ "companyId": route.company_id, "text": row.fields.get("funcao") })).await?;
        candidates.push(Candidate {
            employee_id: int(&employee, "id").unwrap_or_default(),
            employee_name: text(&employee, "name").unwrap_or_default(),
            client_id: route.client_id,
            company_id: route.company_id,
            work_date,
            local: row.fields.get("local").cloned().unwrap_or_default(),
            role: row.fields.get("funcao").cloned().unwrap_or_default(),
            role_id: int(&role, "id"),
            schedule_start_minutes: parsed_schedule.map(|s| s.0),
            schedule_end_minutes: parsed_schedule.map(|s| s.1),
            sheet_name: row.sheet_name.clone(),
            row_number: row.row_number,
            status: rules::resolve_payment_status(&template.status_rules, &fields_with_sheet).unwrap_or_else(|| "pendente".into()),
            extra_fields: row.extra_fields.clone(),
        });
    }

    // Only the first occurrence of an identity within the file is compared.
    let mut seen = HashSet::new();
    let deduped: Vec<Candidate> = candidates
        .into_iter()
        .filter(|c| seen.insert((c.employee_id, c.work_date.clone(), c.local.clone(), c.role.clone(), c.schedule_start_minutes, c.schedule_end_minutes)))
        .collect();

    let duplicate_rows: Vec<DuplicateCandidate> = deduped
        .iter()
        .map(|c| DuplicateCandidate {
            employee_id: c.employee_id,
            work_date: c.work_date.clone(),
            local: c.local.clone(),
            role_id: c.role_id.map(|v| v as f64),
            schedule_start_minutes: c.schedule_start_minutes.map(|v| v as f64),
            schedule_end_minutes: c.schedule_end_minutes.map(|v| v as f64),
        })
        .collect();
    let matches: HashMap<usize, i64> = find_duplicates_impl(state, &duplicate_rows).await?.into_iter().map(|(i, m)| (i, m.shift_id)).collect();

    let mut matched_ids: Vec<i64> = Vec::new();
    for i in 0..deduped.len() {
        if let Some(&id) = matches.get(&i) {
            if !matched_ids.contains(&id) {
                matched_ids.push(id);
            }
        }
    }
    let current_shifts = call(state, payments::shifts::get_payment_shifts_by_ids, json!({ "ids": matched_ids })).await?;
    let current_by_id: HashMap<i64, Value> = current_shifts
        .as_array()
        .map(|rows| rows.iter().filter_map(|r| int(r, "id").map(|id| (id, r.clone()))).collect())
        .unwrap_or_default();

    let identity_base = |c: &Candidate, change_kind: &str| DiffEntry {
        config_id: Some(config.id),
        config_label: config_label.clone(),
        change_kind: change_kind.into(),
        matched_shift_id: None,
        employee_id: Some(c.employee_id),
        employee_name: Some(c.employee_name.clone()),
        work_date: Some(c.work_date.clone()),
        local: Some(c.local.clone()),
        role: Some(c.role.clone()),
        schedule_start_minutes: c.schedule_start_minutes,
        schedule_end_minutes: c.schedule_end_minutes,
        sheet_name: c.sheet_name.clone(),
        row_number: Some(c.row_number),
        column_letter: None,
        field_name: None,
        old_value: None,
        new_value: None,
        message: None,
        applied: false,
    };

    let mut entries: Vec<DiffEntry> = Vec::new();
    for (i, c) in deduped.iter().enumerate() {
        let mut current: Option<CurrentShift> = None;
        // Only for the position fallback: the row's own identity changed.
        let mut report_identity_field_changes = false;

        if let Some(&shift_id) = matches.get(&i) {
            if let Some(matched) = current_by_id.get(&shift_id) {
                current = Some(CurrentShift::from_row(shift_id, matched));
            }
        } else {
            let positional = call(
                state,
                payments::import::find_payment_shift_by_position,
                json!({ "sourceUrl": source_url, "sheetName": c.sheet_name, "rowNumber": c.row_number }),
            )
            .await?;
            if let Some(shift_id) = int(&positional, "shiftId") {
                current = Some(CurrentShift::from_row(shift_id, &positional));
                report_identity_field_changes = true;
            }
        }

        let Some(shift) = current else {
            // No existing head for this identity or this position: a new shift.
            entries.push(identity_base(c, "new-shift"));
            continue;
        };

        accounted_for.insert(shift.shift_id);
        let mut shift_field_entries: Vec<DiffEntry> = Vec::new();
        let field_diff = |name: &str, old: String, new: String| DiffEntry {
            matched_shift_id: Some(shift.shift_id),
            field_name: Some(name.to_owned()),
            old_value: Some(Value::String(old)),
            new_value: Some(Value::String(new)),
            ..identity_base(c, "field")
        };

        if report_identity_field_changes {
            if shift.work_date != c.work_date {
                shift_field_entries.push(field_diff("data", shift.work_date.clone(), c.work_date.clone()));
            }
            if shift.local != c.local {
                shift_field_entries.push(field_diff("local", shift.local.clone(), c.local.clone()));
            }
            if shift.role_id != c.role_id {
                shift_field_entries.push(field_diff("função", shift.role.clone(), c.role.clone()));
            }
            if shift.schedule_start_minutes != c.schedule_start_minutes || shift.schedule_end_minutes != c.schedule_end_minutes {
                shift_field_entries.push(field_diff(
                    "horário",
                    format_schedule_range(shift.schedule_start_minutes, shift.schedule_end_minutes),
                    format_schedule_range(c.schedule_start_minutes, c.schedule_end_minutes),
                ));
            }
        }

        // "pago" is set inside the app; the file can never say it.
        if shift.status != "pago" && shift.status != c.status {
            shift_field_entries.push(field_diff("status", shift.status.clone(), c.status.clone()));
        }

        let empty = Map::new();
        let current_extra = shift.extra_data.as_object().unwrap_or(&empty);
        let fresh_extra = &c.extra_fields;
        let mut extra_keys: Vec<&String> = current_extra.keys().collect();
        extra_keys.extend(fresh_extra.keys().filter(|k| !current_extra.contains_key(*k)));
        for key in extra_keys {
            if PROVENANCE_EXTRA_KEYS.contains(&key.as_str()) {
                continue;
            }
            let old = current_extra.get(key).cloned().unwrap_or(Value::Null);
            let new = fresh_extra.get(key).cloned().unwrap_or(Value::Null);
            if old == new {
                continue;
            }
            shift_field_entries.push(DiffEntry {
                matched_shift_id: Some(shift.shift_id),
                column_letter: Some(key.clone()),
                field_name: Some(format!("extra:{key}")),
                old_value: Some(old),
                new_value: Some(new),
                ..identity_base(c, "field")
            });
        }

        if shift_field_entries.is_empty() {
            continue;
        }

        if let Some(a) = accept.filter(|a| a.shift_id == shift.shift_id) {
            let status = if shift.status == "pago" { shift.status.clone() } else { c.status.clone() };
            let new_shift_id = call(
                state,
                payments::shifts::apply_auto_synced_field_update,
                json!({
                    "shiftId": shift.shift_id,
                    "fields": {
                        "workDate": c.work_date,
                        "local": c.local,
                        "role": c.role,
                        "scheduleStartMinutes": c.schedule_start_minutes,
                        "scheduleEndMinutes": c.schedule_end_minutes,
                        "status": status,
                        "extraData": extra_or_null(&c.extra_fields),
                        "clientId": c.client_id,
                        "companyId": c.company_id,
                    },
                    "sourceFileId": a.source_file_id,
                    "sourceRowNumber": c.row_number,
                    "sourceSheetName": c.sheet_name,
                }),
            )
            .await?
            .as_i64();
            entries.extend(shift_field_entries.into_iter().map(|e| DiffEntry { matched_shift_id: new_shift_id, applied: true, ..e }));
        } else {
            entries.extend(shift_field_entries);
        }
    }

    // Shifts this file used to have that this read didn't land on at all.
    let expected_sheet_names: HashSet<&str> = template.groups.iter().flat_map(|g| g.sheet_names.iter().map(String::as_str)).collect();
    let heads = call(
        state,
        payments::import::list_head_shifts_for_source_url,
        json!({ "sourceUrl": source_url, "periodStart": period_start, "periodEnd": period_end }),
    )
    .await?;
    for h in heads.as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(shift_id) = int(h, "shiftId") else { continue };
        if accounted_for.contains(&shift_id) {
            continue;
        }
        let sheet_name = text(h, "sheetName");
        if !expected_sheet_names.is_empty() && !expected_sheet_names.contains(sheet_name.as_deref().unwrap_or("")) {
            continue;
        }
        entries.push(DiffEntry {
            config_id: Some(config.id),
            config_label: config_label.clone(),
            change_kind: "removed".into(),
            matched_shift_id: Some(shift_id),
            employee_id: int(h, "employeeId"),
            employee_name: text(h, "employeeName"),
            work_date: text(h, "workDate"),
            local: text(h, "local"),
            role: text(h, "role"),
            schedule_start_minutes: int(h, "scheduleStartMinutes"),
            schedule_end_minutes: int(h, "scheduleEndMinutes"),
            sheet_name,
            row_number: int(h, "rowNumber"),
            column_letter: None,
            field_name: None,
            old_value: None,
            new_value: None,
            message: Some("Este turno não foi encontrado na leitura mais recente do arquivo — pode ter sido removido na fonte.".into()),
            applied: false,
        });
    }

    unresolved_entries.extend(entries);
    Ok(unresolved_entries)
}

/// A spreadsheet the check downloaded (`downloadPaymentFileFromUrl`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub path: String,
    pub file_name: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<i64>,
}

pub async fn download(state: &AppState, url: &str) -> ApiResult<Downloaded> {
    serde_json::from_value(call(state, commands::download_payment_file_from_url, json!({ "url": url })).await?).map_err(|e| ApiError::Internal(e.to_string()))
}

/// The downloaded copy is scratch: nothing references it after the check.
pub fn discard(downloaded: &Downloaded) {
    if let Err(error) = std::fs::remove_file(&downloaded.path) {
        tracing::warn!(%error, path = %downloaded.path, "não deu pra apagar a planilha baixada");
    }
}

pub async fn hash_file(state: &AppState, path: &str) -> ApiResult<String> {
    let hashed = call(state, commands::hash_payment_file, json!({ "path": path })).await?;
    text(&hashed, "hash").ok_or_else(|| ApiError::Internal("hash ausente".into()))
}

/// `logSourceFile` for a downloaded payment file, as "Aceitar" logs it.
pub async fn log_downloaded_source_file(state: &AppState, hash: &str, file_name: &str, provider: &str, source_url: &str, signature: (&Option<String>, &Option<String>, Option<i64>)) -> ApiResult<i64> {
    let id = call(
        state,
        timesheets::log_source_file,
        json!({ "input": {
            "fileHash": hash,
            "fileName": file_name,
            "pageCount": 1,
            "provider": provider,
            "importType": "payment",
            "status": "success",
            "errorMessage": null,
            "originalPdfPath": "",
            "sourceUrl": source_url,
            "sourceEtag": signature.0,
            "sourceLastModified": signature.1,
            "sourceContentLength": signature.2,
        }}),
    )
    .await?;
    id.as_i64().ok_or_else(|| ApiError::Internal("id do arquivo ausente".into()))
}

pub async fn mark_source_file_saved(state: &AppState, hash: &str) -> ApiResult<()> {
    call(state, timesheets::mark_source_file_saved, json!({ "fileHash": hash })).await?;
    Ok(())
}

/// `acceptShiftChange`: "Aceitar e atualizar" on one turno. Downloads the file
/// fresh and writes this one shift's fields from it, even if it was edited by
/// hand or already paid: clicking "Aceitar" is that consent.
pub async fn accept_shift_change(state: &AppState, config: &ReimportConfig, shift_id: i64) -> ApiResult<()> {
    let downloaded = download(state, &config.source_url).await?;
    let result = async {
        let hash = hash_file(state, &downloaded.path).await?;
        let source_file_id = log_downloaded_source_file(
            state,
            &hash,
            &downloaded.file_name,
            &config.label(),
            &config.source_url,
            (&downloaded.etag, &downloaded.last_modified, downloaded.content_length),
        )
        .await?;
        compute_reimport_diff(state, config, &downloaded.path, Some(&Accept { shift_id, source_file_id })).await?;
        mark_source_file_saved(state, &hash).await
    }
    .await;
    discard(&downloaded);
    result
}
