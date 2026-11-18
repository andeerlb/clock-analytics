//! Pure helpers the automatic check used from the frontend's
//! `src/lib/format.ts` / `calendar.ts`, ported one-for-one: same inputs give
//! the same strings. Each function names its TS original.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

/// `SHEET_NAME_RULE_FIELD` (types.ts).
pub const SHEET_NAME_RULE_FIELD: &str = "aba";

/// JavaScript's `String.prototype.trim`: Unicode whitespace plus the BOM, but
/// not U+0085 (which Rust's `trim` would strip).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `parseSqliteDateTime`: SQLite's `datetime('now')` text is UTC without a marker.
pub fn parse_sqlite_datetime(text: &str) -> Option<DateTime<Utc>> {
    if text.contains('T') {
        return DateTime::parse_from_rfc3339(text)
            .map(|d| d.with_timezone(&Utc))
            .ok()
            .or_else(|| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok().map(|n| n.and_utc()));
    }
    NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").ok().map(|n| n.and_utc())
}

/// `addDaysIso` with `toIso`.
fn add_days_iso(today: NaiveDate, days: i64) -> String {
    (today + Duration::days(days)).format("%Y-%m-%d").to_string()
}

/// The fields of a reimport config `resolveReimportPeriod` / `resolveReimportConfigLabel` read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSpec {
    pub label: String,
    pub date_mode: String,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub start_offset_days: Option<f64>,
    pub end_offset_days: Option<f64>,
}

/// `resolveReimportPeriod`. `today` is the team's local date (the desktop
/// used the computer's own clock; the server uses `TAPAGO_TIMEZONE`).
pub fn resolve_reimport_period(config: &PeriodSpec, today: NaiveDate) -> (Option<String>, Option<String>) {
    if config.date_mode == "fixed" {
        return (config.period_start.clone(), config.period_end.clone());
    }
    let today_iso = today.format("%Y-%m-%d").to_string();
    if config.date_mode == "month" {
        return (Some(format!("{}01", &today_iso[..8])), Some(today_iso));
    }
    // `setUTCDate(d + n)` truncates a fractional n toward zero.
    let offset = |days: Option<f64>| days.map(|n| add_days_iso(today, -(n.trunc() as i64)));
    (offset(config.start_offset_days), offset(config.end_offset_days))
}

/// `resolveReimportConfigLabel`.
pub fn resolve_reimport_config_label(config: &PeriodSpec) -> String {
    if !js_trim(&config.label).is_empty() {
        return config.label.clone();
    }
    if config.date_mode == "month" {
        return "Mês atual".into();
    }
    if config.date_mode != "relative" {
        return "Período fixo".into();
    }
    let (start, end) = (config.start_offset_days, config.end_offset_days);
    match (start, end) {
        (Some(s), Some(e)) if s == 0.0 && e == 0.0 => "Hoje".into(),
        (Some(s), Some(e)) if s == 1.0 && e == 1.0 => "Ontem".into(),
        (Some(s), Some(e)) if s == 1.0 && e == 0.0 => "Hoje e ontem".into(),
        (Some(s), Some(0.0)) => format!("Últimos {} dias", js_number(s)),
        (Some(s), Some(e)) => format!("{} a {} dias atrás", js_number(s), js_number(e)),
        _ => "Personalizado".into(),
    }
}

/// `String(n)` for the integral values these fields hold.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

static ISO_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}").unwrap());
static NON_DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^0-9]+").unwrap());
static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9]{1,2}):([0-9]{2})").unwrap());

/// `parseDateWithFormat`.
pub fn parse_date_with_format(raw: &str, date_format: &str) -> Option<String> {
    let trimmed = js_trim(raw);
    if ISO_PREFIX.is_match(trimmed) {
        return Some(trimmed[..10].to_owned());
    }
    let digits_only = NON_DIGITS.replace_all(trimmed, " ");
    let parts: Vec<&str> = digits_only.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }
    let (a, b, c) = (parts[0], parts[1], parts[2]);
    let (day, month, year) = match date_format {
        "DD/MM/YYYY" | "DD/MM/YY" => (a, b, c),
        "MM/DD/YYYY" => (b, a, c),
        "YYYY-MM-DD" => (c, b, a),
        _ => return None,
    };
    let year = if year.len() == 2 { format!("20{year}") } else { year.to_owned() };
    let day_num: u64 = day.parse().ok()?;
    let month_num: u64 = month.parse().ok()?;
    let year_num: u64 = year.parse().ok()?;
    if day_num == 0 || month_num == 0 || year_num == 0 || month_num > 12 || day_num > 31 {
        return None;
    }
    Some(format!("{year_num:04}-{month_num:02}-{day_num:02}"))
}

/// `parseScheduleToMinutes`: the first two `H:MM` in the text.
pub fn parse_schedule_to_minutes(raw: &str) -> Option<(i64, i64)> {
    let matches: Vec<_> = TIME.captures_iter(raw).take(2).collect();
    if matches.len() < 2 {
        return None;
    }
    let to_minutes = |c: &regex::Captures| -> Option<i64> {
        let h: i64 = c[1].parse().ok()?;
        let m: i64 = c[2].parse().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        Some(h * 60 + m)
    };
    Some((to_minutes(&matches[0])?, to_minutes(&matches[1])?))
}

/// `formatMinutesAsTime`.
pub fn format_minutes_as_time(minutes: i64) -> String {
    let h = minutes.div_euclid(60);
    let m = minutes % 60;
    format!("{h:02}:{m:02}")
}

/// One routing/status condition (see `PaymentRuleCondition`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub field: String,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub case_insensitive: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRule {
    pub kind: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    pub company_id: i64,
    pub company_name: String,
    pub client_id: i64,
    pub client_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusRule {
    pub kind: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub company_id: i64,
    pub company_name: String,
    pub client_id: i64,
    pub client_name: String,
}

pub type Fields = HashMap<String, String>;

/// `withSheetNameField`.
pub fn with_sheet_name_field(fields: &Fields, sheet_name: Option<&str>) -> Fields {
    let mut out = fields.clone();
    out.insert(SHEET_NAME_RULE_FIELD.to_owned(), sheet_name.unwrap_or("").to_owned());
    out
}

fn fold(s: &str, case_insensitive: bool) -> String {
    if case_insensitive {
        s.to_lowercase()
    } else {
        s.to_owned()
    }
}

/// `matchesRouteCondition`: no raw value never matches.
fn matches_route_condition(condition: &Condition, fields: &Fields) -> bool {
    let raw = match fields.get(&condition.field) {
        Some(raw) if !raw.is_empty() => raw,
        _ => return false,
    };
    let normalized = fold(js_trim(raw), condition.case_insensitive);
    condition.values.iter().any(|v| fold(js_trim(v), condition.case_insensitive) == normalized)
}

/// `resolvePaymentRoute`: first matching rule wins; `else` always matches.
pub fn resolve_payment_route(rules: &[RouteRule], fields: &Fields) -> Option<Route> {
    for rule in rules {
        let route = || Route {
            company_id: rule.company_id,
            company_name: rule.company_name.clone(),
            client_id: rule.client_id,
            client_name: rule.client_name.clone(),
        };
        if rule.kind == "else" {
            return Some(route());
        }
        if rule.conditions.is_empty() {
            continue;
        }
        if rule.conditions.iter().all(|c| matches_route_condition(c, fields)) {
            return Some(route());
        }
    }
    None
}

/// `matchesStatusCondition`: empty `values` tests for an empty field.
fn matches_status_condition(condition: &Condition, fields: &Fields) -> bool {
    let raw = fields.get(&condition.field).map(|r| js_trim(r)).unwrap_or("");
    if condition.values.is_empty() {
        return raw.is_empty();
    }
    if raw.is_empty() {
        return false;
    }
    let normalized = fold(raw, condition.case_insensitive);
    condition.values.iter().any(|v| fold(js_trim(v), condition.case_insensitive) == normalized)
}

/// `resolvePaymentStatus`.
pub fn resolve_payment_status(rules: &[StatusRule], fields: &Fields) -> Option<String> {
    for rule in rules {
        if rule.kind == "else" {
            return Some(rule.status.clone());
        }
        if rule.conditions.is_empty() {
            continue;
        }
        if rule.conditions.iter().all(|c| matches_status_condition(c, fields)) {
            return Some(rule.status.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(date_mode: &str, start: Option<f64>, end: Option<f64>) -> PeriodSpec {
        PeriodSpec { label: String::new(), date_mode: date_mode.into(), period_start: Some("2026-01-01".into()), period_end: None, start_offset_days: start, end_offset_days: end }
    }

    #[test]
    fn dates_parse_like_the_frontend() {
        assert_eq!(parse_date_with_format(" 2026-02-18T00:00:00 ", "DD/MM/YYYY").as_deref(), Some("2026-02-18"));
        assert_eq!(parse_date_with_format("18/02/2026", "DD/MM/YYYY").as_deref(), Some("2026-02-18"));
        assert_eq!(parse_date_with_format("18/2/26", "DD/MM/YY").as_deref(), Some("2026-02-18"));
        assert_eq!(parse_date_with_format("02-18-2026", "MM/DD/YYYY").as_deref(), Some("2026-02-18"));
        assert_eq!(parse_date_with_format("2026.2.18", "YYYY-MM-DD").as_deref(), Some("2026-02-18"));
        assert_eq!(parse_date_with_format("seg 18 fev", "DD/MM/YYYY"), None);
        assert_eq!(parse_date_with_format("31/13/2026", "DD/MM/YYYY"), None);
        assert_eq!(parse_date_with_format("00/12/2026", "DD/MM/YYYY"), None);
        assert_eq!(parse_date_with_format("", "DD/MM/YYYY"), None);
        assert_eq!(parse_date_with_format("TOTAL", "DD/MM/YYYY"), None);
        assert_eq!(parse_date_with_format("18/02/2026", "outro"), None);
    }

    #[test]
    fn schedules_take_the_first_two_times() {
        assert_eq!(parse_schedule_to_minutes("9:00 - 15:00"), Some((540, 900)));
        assert_eq!(parse_schedule_to_minutes("7:30 às 13:30 (19:00)"), Some((450, 810)));
        assert_eq!(parse_schedule_to_minutes("22:00 x 06:00"), Some((1320, 360)));
        assert_eq!(parse_schedule_to_minutes("123:45 / 1:00"), Some((1425, 60)));
        assert_eq!(parse_schedule_to_minutes("24:00 - 06:00"), None);
        assert_eq!(parse_schedule_to_minutes("folga"), None);
        assert_eq!(format_minutes_as_time(450), "07:30");
        assert_eq!(format_minutes_as_time(0), "00:00");
    }

    #[test]
    fn periods_and_labels() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        assert_eq!(resolve_reimport_period(&spec("fixed", None, None), today), (Some("2026-01-01".into()), None));
        assert_eq!(resolve_reimport_period(&spec("month", None, None), today), (Some("2026-03-01".into()), Some("2026-03-01".into())));
        assert_eq!(resolve_reimport_period(&spec("relative", Some(1.0), Some(0.0)), today), (Some("2026-02-28".into()), Some("2026-03-01".into())));
        assert_eq!(resolve_reimport_period(&spec("relative", None, Some(2.0)), today), (None, Some("2026-02-27".into())));

        assert_eq!(resolve_reimport_config_label(&spec("relative", Some(0.0), Some(0.0))), "Hoje");
        assert_eq!(resolve_reimport_config_label(&spec("relative", Some(1.0), Some(1.0))), "Ontem");
        assert_eq!(resolve_reimport_config_label(&spec("relative", Some(1.0), Some(0.0))), "Hoje e ontem");
        assert_eq!(resolve_reimport_config_label(&spec("relative", Some(7.0), Some(0.0))), "Últimos 7 dias");
        assert_eq!(resolve_reimport_config_label(&spec("relative", Some(7.0), Some(2.0))), "7 a 2 dias atrás");
        assert_eq!(resolve_reimport_config_label(&spec("relative", None, Some(2.0))), "Personalizado");
        assert_eq!(resolve_reimport_config_label(&spec("month", None, None)), "Mês atual");
        assert_eq!(resolve_reimport_config_label(&spec("fixed", None, None)), "Período fixo");
        let mut named = spec("fixed", None, None);
        named.label = "Escala".into();
        assert_eq!(resolve_reimport_config_label(&named), "Escala");
        named.label = "   ".into();
        assert_eq!(resolve_reimport_config_label(&named), "Período fixo");
    }

    #[test]
    fn sqlite_datetimes_are_utc() {
        let parsed = parse_sqlite_datetime("2026-08-03 20:55:52").unwrap();
        assert_eq!(parsed.to_rfc3339(), "2026-08-03T20:55:52+00:00");
        assert!(parse_sqlite_datetime("lixo").is_none());
    }

    #[test]
    fn rules_route_and_status() {
        let cond = |field: &str, values: &[&str], ci: bool| Condition { field: field.into(), values: values.iter().map(|v| v.to_string()).collect(), case_insensitive: ci };
        let route = |kind: &str, conditions: Vec<Condition>, id: i64| RouteRule { kind: kind.into(), conditions, company_id: id, company_name: format!("E{id}"), client_id: id, client_name: format!("C{id}") };
        let rules = vec![route("condition", vec![], 1), route("condition", vec![cond("aba", &["Norte"], true), cond("local", &[" HQ "], false)], 2), route("else", vec![], 3)];
        let mut fields = with_sheet_name_field(&Fields::from([("local".to_owned(), "HQ".to_owned())]), Some("NORTE"));
        assert_eq!(resolve_payment_route(&rules, &fields).unwrap().company_id, 2);
        fields.insert("local".into(), "hq".into());
        assert_eq!(resolve_payment_route(&rules, &fields).unwrap().company_id, 3);
        assert_eq!(resolve_payment_route(&rules[..2], &Fields::new()), None);

        let status = |kind: &str, conditions: Vec<Condition>, s: &str| StatusRule { kind: kind.into(), conditions, status: s.into() };
        let rules = vec![status("condition", vec![cond("status", &[], false)], "pendente"), status("condition", vec![cond("status", &["Pago"], true)], "pago")];
        assert_eq!(resolve_payment_status(&rules, &Fields::new()).as_deref(), Some("pendente"));
        assert_eq!(resolve_payment_status(&rules, &Fields::from([("status".to_owned(), " PAGO ".to_owned())])).as_deref(), Some("pago"));
        assert_eq!(resolve_payment_status(&rules, &Fields::from([("status".to_owned(), "x".to_owned())])), None);
    }
}
