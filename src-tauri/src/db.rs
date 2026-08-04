use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:pontoscan.db";

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create core schema",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "track imported files for duplicate detection",
            sql: include_str!("../migrations/0002_import_files.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "track whole source files for multi-page batch imports",
            sql: include_str!("../migrations/0003_source_files.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "log every import attempt with a real status",
            sql: include_str!("../migrations/0004_source_file_status.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "link imports back to their whole original file",
            sql: include_str!("../migrations/0005_import_source_file.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "store how many punch columns an import's grid needs",
            sql: include_str!("../migrations/0006_import_max_punches.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add clients, scoped one-to-many under companies",
            sql: include_str!("../migrations/0007_clients.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "clients are many-to-many with companies, not one-to-many",
            sql: include_str!("../migrations/0008_clients_many_to_many.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "store each import's period aggregates instead of recomputing them live",
            sql: include_str!("../migrations/0009_import_period_aggregates.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "split absence minutes into falta (no valid pair) and atraso (short despite a pair)",
            sql: include_str!("../migrations/0010_import_late_minutes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "count days with a pending (odd) punch count per import",
            sql: include_str!("../migrations/0011_import_pending_count.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "scope source files to their import type (timesheet vs. payment)",
            sql: include_str!("../migrations/0012_source_file_import_type.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "define reusable payment import templates (column mapping only, not execution)",
            sql: include_str!("../migrations/0013_payment_templates.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "let a payment template target a set of sheets instead of a single fixed one",
            sql: include_str!("../migrations/0014_payment_template_multi_sheet.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "split a payment template into per-sheet-group header row + column mapping",
            sql: include_str!("../migrations/0015_payment_template_groups.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "let each company set its own night-shift hour boundaries",
            sql: include_str!("../migrations/0016_company_night_shift_hours.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "add matricula to employees, completing the cpf/matricula/nome identifier precedence",
            sql: include_str!("../migrations/0017_employee_matricula.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "track imported payment shifts, one row per work shift",
            sql: include_str!("../migrations/0018_payment_shifts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "drop payment_template_groups.header_row — row validity is decided at import time by date-parseability instead",
            sql: include_str!("../migrations/0019_payment_template_drop_header_row.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "drop payment_templates.client_id and decimal_separator — client is now resolved per row via rules, decimal separator was never used",
            sql: include_str!("../migrations/0020_payment_template_drop_client_and_decimal.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "add payment_template_rules — an if/else-if/else chain routing each row to a company/client by a mapped field's value",
            sql: include_str!("../migrations/0021_payment_template_rules.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "normalize payment_shifts.schedule into start/end minutes instead of raw text",
            sql: include_str!("../migrations/0022_payment_shift_schedule_minutes.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
