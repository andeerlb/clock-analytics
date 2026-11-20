//! Tests for the Pagamentos port: the import save (incl. the fork guard),
//! the append-only transitions, the edit history chain, list filters and
//! the template JSON round-trips.

use serde_json::{json, Value};

use super::import::{self, DuplicateCandidate, PaymentShiftInput, SaveShiftsArgs, SHIFT_ALREADY_SUPERSEDED_ERROR};
use super::shifts::{self, AutoSyncArgs, AutoSyncFields, EditFields, PagedQuery};
use super::templates::{self, ConfigTable, ConfigTemplateInput, PaymentTemplateInput};
use super::{parse_time_to_minutes, ShiftQuery};
use crate::error::ApiError;
use crate::AppState;

struct Seed {
    company: i64,
    client: i64,
    employee: i64,
    role: i64,
    source_file: i64,
}

async fn exec(state: &AppState, sql: &str) -> i64 {
    sqlx::query(sql).execute(&state.db).await.unwrap().last_insert_rowid()
}

async fn seed(state: &AppState) -> Seed {
    let company = exec(state, "INSERT INTO companies (name, cnpj) VALUES ('Acme', '11222333000181')").await;
    let client = exec(state, "INSERT INTO clients (name, cnpj) VALUES ('Cliente', '99888777000166')").await;
    let employee = exec(state, "INSERT INTO employees (name, cpf) VALUES ('ANA', '12345678909')").await;
    let role = exec(state, &format!("INSERT INTO roles (company_id, name) VALUES ({company}, 'Vigilante')")).await;
    exec(state, &format!("INSERT INTO role_aliases (role_id, alias) VALUES ({role}, 'VIG')")).await;
    let source_file = exec(
        state,
        "INSERT INTO source_files (file_name, file_hash, page_count, import_type, source_url) VALUES ('p.xlsx', 'h1', 1, 'payment', 'https://x/p.xlsx')",
    )
    .await;
    Seed { company, client, employee, role, source_file }
}

fn shift_input(s: &Seed, previous: Option<i64>) -> PaymentShiftInput {
    PaymentShiftInput {
        employee_id: s.employee,
        template_id: None,
        source_file_id: Some(s.source_file),
        client_id: s.client,
        company_id: s.company,
        local: "Portaria".into(),
        work_date: "2026-10-05".into(),
        role_id: Some(s.role),
        schedule_start_minutes: Some(420),
        schedule_end_minutes: Some(1140),
        status: "pendente".into(),
        extra_data: Some(json!({ "H": "obs", "A": "1" })),
        previous_shift_id: previous,
        source_row_number: Some(2),
        source_sheet_name: Some("Out".into()),
    }
}

async fn save(state: &AppState, rows: Vec<PaymentShiftInput>, hashes: Vec<&str>) -> Result<(), ApiError> {
    import::save_shifts_impl(state, &SaveShiftsArgs { rows, saved_file_hashes: hashes.into_iter().map(String::from).collect() }).await
}

async fn only_shift_id(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT MAX(id) FROM payment_shifts").fetch_one(&state.db).await.unwrap()
}

async fn count(state: &AppState, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&state.db).await.unwrap()
}

fn all_filters() -> ShiftQuery {
    ShiftQuery {
        statuses: vec!["pendente".into(), "erro".into(), "pago".into()],
        shift_periods: vec!["diurno".into(), "noturno".into()],
        ..ShiftQuery::default()
    }
}

// --- savePaymentShifts ------------------------------------------------------------

#[tokio::test]
async fn save_inserts_shifts_and_marks_the_file_saved_in_one_go() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec!["h1"]).await.unwrap();

    let id = only_shift_id(&state).await;
    let shift = shifts::get_shift_impl(&state, id).await.unwrap();
    assert_eq!(shift["extraData"], json!({ "H": "obs", "A": "1" }));
    assert_eq!(shift["editedManually"], json!(false));
    assert_eq!(shift["role"], "Vigilante");
    assert_eq!(shift["sourceUrl"], "https://x/p.xlsx");
    let stored: String = sqlx::query_scalar("SELECT extra_data FROM payment_shifts").fetch_one(&state.db).await.unwrap();
    assert_eq!(stored, r#"{"H":"obs","A":"1"}"#, "key order kept, as JSON.stringify wrote it");
    assert_eq!(count(&state, "SELECT COUNT(*) FROM source_files WHERE saved_at IS NOT NULL").await, 1);
}

#[tokio::test]
async fn save_refuses_to_fork_a_history_and_rolls_back_everything() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;
    // Someone pays it first: `original` now has a successor.
    shifts::mark_paid_impl(&state, original, 100.0).await.unwrap();

    let before = count(&state, "SELECT COUNT(*) FROM payment_shifts").await;
    let err = save(&state, vec![shift_input(&s, None), shift_input(&s, Some(original))], vec!["h1"]).await.unwrap_err();
    assert!(matches!(err, ApiError::Conflict(_)));
    assert_eq!(err.to_string(), SHIFT_ALREADY_SUPERSEDED_ERROR);
    assert_eq!(count(&state, "SELECT COUNT(*) FROM payment_shifts").await, before, "nothing from the batch stays");
    assert_eq!(count(&state, "SELECT COUNT(*) FROM source_files WHERE saved_at IS NOT NULL").await, 0);
}

#[tokio::test]
async fn reprocessing_a_head_links_the_new_row_to_it() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;
    save(&state, vec![shift_input(&s, Some(original))], vec![]).await.unwrap();
    let head = only_shift_id(&state).await;
    let history = shifts::history_impl(&state, head).await.unwrap();
    let ids: Vec<i64> = history.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [head, original]);
}

// --- findDuplicatePaymentShifts ---------------------------------------------------

fn candidate(s: &Seed, local: &str) -> DuplicateCandidate {
    DuplicateCandidate {
        employee_id: s.employee,
        work_date: "2026-10-05".into(),
        local: local.into(),
        role_id: Some(s.role as f64),
        schedule_start_minutes: Some(420.0),
        schedule_end_minutes: Some(1140.0),
    }
}

#[tokio::test]
async fn duplicates_follow_the_chain_to_the_head_and_flag_identity_changes() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;

    let found = import::find_duplicates_impl(&state, &[candidate(&s, "Portaria"), candidate(&s, "Outro")]).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, 0);
    assert_eq!(found[0].1.shift_id, original);
    assert!(!found[0].1.identity_changed);

    // A manual edit of the local: the file's row still finds the (new) head.
    let edited = shifts::edit_impl(
        &state,
        original,
        &EditFields {
            work_date: "2026-10-05".into(),
            local: "Recepção".into(),
            role: "vig".into(),
            schedule_start_minutes: Some(420),
            schedule_end_minutes: Some(1140),
            amount: None,
        },
    )
    .await
    .unwrap();
    let found = import::find_duplicates_impl(&state, &[candidate(&s, "Portaria")]).await.unwrap();
    assert_eq!(found[0].1.shift_id, edited);
    assert!(found[0].1.identity_changed);
    assert!(found[0].1.edited_manually);
    assert!(!found[0].1.deleted);

    shifts::delete_shift_impl(&state, edited).await.unwrap();
    let found = import::find_duplicates_impl(&state, &[candidate(&s, "Portaria")]).await.unwrap();
    assert!(found[0].1.deleted, "a soft-deleted chain is still found, flagged");
}

#[tokio::test]
async fn duplicates_match_the_same_named_role_of_another_company_and_report_the_route() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;

    // A corrected routing rule now sends the row to another empresa, whose own
    // função is named differently but shares the "VIG" apelido.
    let other_company = exec(&state, "INSERT INTO companies (name, cnpj) VALUES ('Beta', '55444333000122')").await;
    let other_role = exec(&state, &format!("INSERT INTO roles (company_id, name) VALUES ({other_company}, 'vig')")).await;
    let unrelated_role = exec(&state, &format!("INSERT INTO roles (company_id, name) VALUES ({other_company}, 'Porteiro')")).await;

    let moved = DuplicateCandidate { role_id: Some(other_role as f64), ..candidate(&s, "Portaria") };
    let found = import::find_duplicates_impl(&state, &[moved]).await.unwrap();
    assert_eq!(found.len(), 1, "same função by apelido is still the same turno");
    let m = &found[0].1;
    assert_eq!(m.shift_id, original);
    assert!(!m.identity_changed, "a função equivalent by name is not a manual identity change");
    assert_eq!(m.company_id, Some(s.company));
    assert_eq!(m.company_name.as_deref(), Some("Acme"));
    assert_eq!(m.client_id, Some(s.client));
    assert_eq!(m.client_name.as_deref(), Some("Cliente"));
    assert_eq!(m.role_name.as_deref(), Some("Vigilante"));

    let other = DuplicateCandidate { role_id: Some(unrelated_role as f64), ..candidate(&s, "Portaria") };
    assert!(import::find_duplicates_impl(&state, &[other]).await.unwrap().is_empty(), "a different função is a different turno");
}

// --- transitions --------------------------------------------------------------------

#[tokio::test]
async fn pay_revert_and_audit_error_are_append_only_and_inherit_the_manual_flag() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;

    let paid = shifts::mark_paid_impl(&state, original, 150.5).await.unwrap();
    let row = shifts::get_shift_impl(&state, paid).await.unwrap();
    assert_eq!((row["status"].as_str(), row["amount"].as_f64(), row["previousShiftId"].as_i64()), (Some("pago"), Some(150.5), Some(original)));
    assert_eq!(row["editedManually"], json!(false));
    assert_eq!(row["extraData"], json!({ "H": "obs", "A": "1" }));

    // The superseded row can't be paid again: that would fork the chain.
    let err = shifts::mark_paid_impl(&state, original, 1.0).await.unwrap_err();
    assert_eq!(err.to_string(), SHIFT_ALREADY_SUPERSEDED_ERROR);

    let error_row = shifts::mark_audit_error_impl(&state, paid).await.unwrap();
    let row = shifts::get_shift_impl(&state, error_row).await.unwrap();
    assert_eq!(row["status"], "erro");
    assert_eq!(row["amount"], Value::Null);
    assert_eq!(row["errorMessage"], "Marcado como erro na Conferência de Pagamentos.");

    let restored = shifts::undo_audit_error_impl(&state, error_row).await.unwrap();
    let row = shifts::get_shift_impl(&state, restored).await.unwrap();
    assert_eq!((row["status"].as_str(), row["amount"].as_f64()), (Some("pago"), Some(150.5)));

    let reverted = shifts::revert_impl(&state, restored).await.unwrap();
    let row = shifts::get_shift_impl(&state, reverted).await.unwrap();
    assert_eq!((row["status"].as_str(), row["amount"].clone()), (Some("pendente"), Value::Null));

    let history = shifts::history_impl(&state, reverted).await.unwrap();
    let statuses: Vec<&str> = history.iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["pendente", "pago", "erro", "pago", "pendente"]);
}

#[tokio::test]
async fn undo_audit_error_needs_a_previous_row_and_missing_shifts_are_not_found() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;
    let err = shifts::undo_audit_error_impl(&state, original).await.unwrap_err();
    assert_eq!(err.to_string(), "Não foi possível encontrar o pagamento original para restaurar.");
    let err = shifts::mark_paid_impl(&state, 9999, 1.0).await.unwrap_err();
    assert_eq!(err.to_string(), "Turno não encontrado.");
}

#[tokio::test]
async fn edit_builds_a_chain_resolves_the_role_and_refuses_paid_shifts() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;
    let fields = |role: &str, amount: Option<f64>| EditFields {
        work_date: "2026-10-06".into(),
        local: "Recepção".into(),
        role: role.into(),
        schedule_start_minutes: Some(1320),
        schedule_end_minutes: Some(300),
        amount,
    };

    let err = shifts::edit_impl(&state, original, &fields("Gerente", None)).await.unwrap_err();
    assert_eq!(err.to_string(), "Função \"Gerente\" não encontrada. Cadastre-a em Funções antes de vincular a este turno.");

    let first = shifts::edit_impl(&state, original, &fields("  vig ", Some(200.0))).await.unwrap();
    let second = shifts::edit_impl(&state, first, &fields("", None)).await.unwrap();
    let row = shifts::get_shift_impl(&state, second).await.unwrap();
    assert_eq!(row["roleId"], Value::Null);
    assert_eq!(row["role"], "");
    assert_eq!(row["editedManually"], json!(true));
    assert_eq!(row["status"], "pendente");
    let history = shifts::history_impl(&state, second).await.unwrap();
    let chain: Vec<(i64, Value)> = history.iter().map(|r| (r["id"].as_i64().unwrap(), r["roleId"].clone())).collect();
    assert_eq!(chain, [(second, Value::Null), (first, json!(s.role)), (original, json!(s.role))]);
    assert_eq!(history[1]["amount"], json!(200.0));

    let paid = shifts::mark_paid_impl(&state, second, 10.0).await.unwrap();
    let paid_row = shifts::get_shift_impl(&state, paid).await.unwrap();
    assert_eq!(paid_row["editedManually"], json!(true), "paying keeps the manual flag");
    let err = shifts::edit_impl(&state, paid, &fields("", None)).await.unwrap_err();
    assert_eq!(err.to_string(), "Não é possível editar um turno já pago.");
}

#[tokio::test]
async fn auto_sync_keeps_the_amount_and_clears_the_manual_flag() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;
    let paid = shifts::mark_paid_impl(&state, original, 80.0).await.unwrap();
    let synced = shifts::auto_sync_impl(
        &state,
        &AutoSyncArgs {
            shift_id: paid,
            fields: AutoSyncFields {
                work_date: "2026-10-05".into(),
                local: "Portaria 2".into(),
                role: "Vigilante".into(),
                schedule_start_minutes: Some(420),
                schedule_end_minutes: Some(1140),
                status: "pago".into(),
                extra_data: None,
                client_id: s.client,
                company_id: s.company,
            },
            source_file_id: s.source_file,
            source_row_number: Some(3),
            source_sheet_name: None,
        },
    )
    .await
    .unwrap();
    let row = shifts::get_shift_impl(&state, synced).await.unwrap();
    assert_eq!(row["amount"], json!(80.0));
    assert_eq!(row["local"], "Portaria 2");
    assert_eq!(row["roleId"], json!(s.role));
    assert_eq!(row["extraData"], Value::Null);
    assert_eq!(row["sourceRowNumber"], json!(3));
    assert_eq!(row["editedManually"], json!(false));
}

#[tokio::test]
async fn delete_soft_deletes_the_whole_chain_and_hides_it_from_lists() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    save(&state, vec![shift_input(&s, None)], vec![]).await.unwrap();
    let original = only_shift_id(&state).await;
    let paid = shifts::mark_paid_impl(&state, original, 1.0).await.unwrap();
    let query = PagedQuery { filters: all_filters(), page: 0, page_size: 50 };
    assert_eq!(shifts::list_flat_impl(&state, &query).await.unwrap()["total"], json!(1));

    shifts::delete_shift_impl(&state, paid).await.unwrap();
    assert_eq!(count(&state, "SELECT COUNT(*) FROM payment_shifts WHERE deleted_at IS NOT NULL").await, 2);
    assert_eq!(shifts::list_flat_impl(&state, &query).await.unwrap()["total"], json!(0));
}

// --- lists ----------------------------------------------------------------------------

#[tokio::test]
async fn lists_and_counts_only_see_heads_and_apply_filters() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    let mut night = shift_input(&s, None);
    night.schedule_start_minutes = Some(1320);
    night.schedule_end_minutes = Some(300);
    night.local = "Galpão".into();
    let mut other_month = shift_input(&s, None);
    other_month.work_date = "2026-09-30".into();
    save(&state, vec![shift_input(&s, None), night, other_month], vec![]).await.unwrap();
    let first: i64 = sqlx::query_scalar("SELECT MIN(id) FROM payment_shifts").fetch_one(&state.db).await.unwrap();
    shifts::mark_paid_impl(&state, first, 50.0).await.unwrap();

    let counts = shifts::count_by_status_impl(&state, &all_filters()).await.unwrap();
    assert_eq!(counts, json!({ "pendente": 2, "erro": 0, "pago": 1 }));

    let summaries = shifts::list_summaries_impl(&state, &PagedQuery { filters: all_filters(), page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(summaries["total"], json!(2));
    let first_row = &summaries["rows"][0];
    assert_eq!(first_row["competencia"], "2026-10");
    assert_eq!((first_row["total"].as_i64(), first_row["pago"].as_i64(), first_row["pendente"].as_i64()), (Some(2), Some(1), Some(1)));

    let mut only_night = all_filters();
    only_night.shift_periods = vec!["noturno".into()];
    let flat = shifts::list_flat_impl(&state, &PagedQuery { filters: only_night.clone(), page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(flat["total"], json!(1));
    assert_eq!(flat["rows"][0]["local"], "Galpão");
    assert_eq!(flat["rows"][0]["shiftPeriod"], "noturno");
    assert_eq!(flat["rows"][0]["companyName"], "Acme");

    let mut by_local = all_filters();
    by_local.locals = Some(vec!["Portaria".into()]);
    by_local.period_start = Some("2026-10-01".into());
    let flat = shifts::list_flat_impl(&state, &PagedQuery { filters: by_local, page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(flat["total"], json!(1));
    assert_eq!(flat["rows"][0]["status"], "pago");

    let mut pending_only = all_filters();
    pending_only.statuses = vec!["pendente".into()];
    let summaries = shifts::list_summaries_impl(&state, &PagedQuery { filters: pending_only, page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(summaries["total"], json!(2), "October still has a pendente (the night one)");

    let mut none = all_filters();
    none.statuses = vec![];
    let empty = shifts::list_flat_impl(&state, &PagedQuery { filters: none, page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(empty, json!({ "rows": [], "total": 0 }));
}

#[tokio::test]
async fn schedule_time_filter_and_shift_ids_restrict_rows() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    let mut late = shift_input(&s, None);
    late.schedule_start_minutes = Some(900);
    save(&state, vec![shift_input(&s, None), late], vec![]).await.unwrap();
    let mut q = all_filters();
    q.schedule_time_filter = Some(super::ScheduleTimeFilter { rule: "start-after".into(), time: "12:00".into() });
    let flat = shifts::list_flat_impl(&state, &PagedQuery { filters: q, page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(flat["total"], json!(1));
    assert_eq!(flat["rows"][0]["scheduleStartMinutes"], json!(900));

    let mut ids = all_filters();
    ids.shift_ids = Some(vec![]);
    let flat = shifts::list_flat_impl(&state, &PagedQuery { filters: ids, page: 0, page_size: 50 }).await.unwrap();
    assert_eq!(flat["total"], json!(0), "an empty shiftIds list matches nothing");
}

#[test]
fn parses_times_like_format_ts() {
    assert_eq!(parse_time_to_minutes("7:05"), Some(425));
    assert_eq!(parse_time_to_minutes("23:59"), Some(1439));
    assert_eq!(parse_time_to_minutes("24:00"), None);
    assert_eq!(parse_time_to_minutes("7:5"), None);
    assert_eq!(parse_time_to_minutes("ab:cd"), None);
}

// --- templates --------------------------------------------------------------------------

#[tokio::test]
async fn import_template_round_trips_groups_rules_and_json_columns() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    let input: PaymentTemplateInput = serde_json::from_value(json!({
        "name": "Modelo",
        "fileKind": "xlsx",
        "acceptedFileKinds": ["xlsx", "csv"],
        "delimiter": null,
        "dateFormat": "DD/MM/YYYY",
        "identifierPriority": [{ "fields": ["cpf"], "caseInsensitive": false }],
        "groups": [{
            "sheetNames": ["Out", "Nov"],
            "excludedSheetNames": ["Resumo"],
            "fieldMappings": [{ "columnLetter": "A", "targetField": "nome", "headerLabel": "Nome" },
                              { "columnLetter": "B", "targetField": "data", "headerLabel": null }]
        }],
        "rules": [
            { "kind": "condition", "conditions": [{ "field": "local", "values": ["X"], "caseInsensitive": true }], "companyId": s.company, "clientId": s.client },
            { "kind": "else", "conditions": [], "companyId": s.company, "clientId": s.client }
        ],
        "statusRules": [{ "kind": "else", "conditions": [], "status": "pendente" }]
    }))
    .unwrap();
    let id = templates::create_payment_template_impl(&state, &input).await.unwrap();
    let t = templates::get_payment_template_impl(&state, id).await.unwrap();
    assert_eq!(t["acceptedFileKinds"], json!(["xlsx", "csv"]));
    assert_eq!(t["identifierPriority"], json!([{ "fields": ["cpf"], "caseInsensitive": false }]));
    assert_eq!(
        t["groups"],
        json!([{
            "sheetNames": ["Nov", "Out"],
            "excludedSheetNames": ["Resumo"],
            "fieldMappings": [{ "columnLetter": "A", "targetField": "nome", "headerLabel": "Nome" },
                              { "columnLetter": "B", "targetField": "data", "headerLabel": null }]
        }])
    );
    assert_eq!(t["rules"][0]["conditions"], json!([{ "field": "local", "values": ["X"], "caseInsensitive": true }]));
    assert_eq!(t["rules"][0]["companyName"], "Acme");
    assert_eq!(t["rules"][1]["conditions"], json!([]));
    assert!(t["rules"][0].get("conditionsJson").is_none());
    assert_eq!(t["statusRules"], json!([{ "kind": "else", "status": "pendente", "conditions": [] }]));

    let mut updated = input.clone();
    updated.name = "Modelo 2".into();
    updated.groups.clear();
    updated.rules.truncate(1);
    templates::update_payment_template_impl(&state, id, &updated).await.unwrap();
    let t = templates::get_payment_template_impl(&state, id).await.unwrap();
    assert_eq!(t["name"], "Modelo 2");
    assert_eq!(t["groups"], json!([]));
    assert_eq!(t["rules"].as_array().unwrap().len(), 1);
    assert_eq!(count(&state, "SELECT COUNT(*) FROM payment_template_sheets").await, 0);

    let list = templates::list_payment_templates_impl(&state).await.unwrap();
    assert_eq!(list[0]["acceptedFileKinds"], json!(["xlsx", "csv"]));
}

#[tokio::test]
async fn legacy_template_rows_fall_back_to_their_old_columns() {
    let state = AppState::for_tests().await;
    let s = seed(&state).await;
    let id = exec(&state, "INSERT INTO payment_templates (name, file_kind, date_format, identifier_priority) VALUES ('Velho', 'csv', 'DD/MM/YYYY', '[]')").await;
    exec(
        &state,
        &format!(
            "INSERT INTO payment_template_rules (template_id, kind, field, values_json, case_insensitive, company_id, client_id) VALUES ({id}, 'condition', 'local', '[\"A\"]', 1, {}, {})",
            s.company, s.client
        ),
    )
    .await;
    let t = templates::get_payment_template_impl(&state, id).await.unwrap();
    assert_eq!(t["acceptedFileKinds"], json!(["csv"]));
    assert_eq!(t["rules"][0]["conditions"], json!([{ "field": "local", "values": ["A"], "caseInsensitive": true }]));
    let err = templates::get_payment_template_impl(&state, 999).await.unwrap_err();
    assert_eq!(err.to_string(), "Template não encontrado.");
}

#[tokio::test]
async fn export_and_pdf_templates_round_trip_their_config_and_clone() {
    let state = AppState::for_tests().await;
    let config = json!({ "zeta": 1, "alpha": { "cells": [["{{nome}}", null]] }, "ratio": 1.5 });
    for (kind, missing) in [(ConfigTable::Export, "Template de exportação não encontrado."), (ConfigTable::Pdf, "Template de PDF não encontrado.")] {
        let input = ConfigTemplateInput { name: "Layout".into(), config: config.clone() };
        let id = templates::create_config_template(&state, kind, &input).await.unwrap();
        let row = templates::get_config_template(&state, kind, id).await.unwrap();
        assert_eq!(row["config"], config);
        assert!(row.get("configJson").is_none());

        let copy = templates::clone_config_template(&state, kind, id).await.unwrap();
        let row = templates::get_config_template(&state, kind, copy).await.unwrap();
        assert_eq!(row["name"], "Layout (cópia)");
        assert_eq!(row["config"], config);

        templates::update_config_template(&state, kind, id, &ConfigTemplateInput { name: "Novo".into(), config: json!({}) }).await.unwrap();
        assert_eq!(templates::get_config_template(&state, kind, id).await.unwrap()["config"], json!({}));
        assert_eq!(templates::list_config_templates(&state, kind).await.unwrap().len(), 2);

        assert_eq!(templates::clone_config_template(&state, kind, 999).await.unwrap_err().to_string(), missing);
    }
    let stored: String = sqlx::query_scalar("SELECT config_json FROM payment_pdf_templates WHERE name = 'Layout (cópia)'").fetch_one(&state.db).await.unwrap();
    assert_eq!(stored, r#"{"zeta":1,"alpha":{"cells":[["{{nome}}",null]]},"ratio":1.5}"#);
}

#[tokio::test]
async fn tracking_a_url_creates_its_first_config() {
    let state = AppState::for_tests().await;
    let tpl = exec(&state, "INSERT INTO payment_templates (name, file_kind, date_format, identifier_priority) VALUES ('T', 'xlsx', 'DD/MM/YYYY', '[]')").await;
    let args = import::TrackUrlArgs {
        source_url: "https://x/p.xlsx".into(),
        template_id: tpl,
        period_start: Some("2026-10-01".into()),
        period_end: None,
        keep_manual_edits: false,
    };
    import::track_url_impl(&state, &args).await.unwrap();
    import::track_url_impl(&state, &args).await.unwrap();
    assert_eq!(count(&state, "SELECT COUNT(*) FROM source_url_settings WHERE tracking_enabled = 1").await, 1);
    let row: (String, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT date_mode, check_interval_minutes, keep_manual_edits, auto_apply_enabled, auto_apply_overwrite_manual_edits FROM source_url_reimport_configs LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(row, ("fixed".into(), 5, 0, 0, 1));
}
