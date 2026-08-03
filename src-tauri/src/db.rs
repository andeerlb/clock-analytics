use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:clock-analytics.db";

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
    ]
}
