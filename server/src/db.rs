use std::borrow::Cow;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::error::BoxDynError;
use sqlx::migrate::{Migration, MigrationSource, MigrationType, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

/// Builds the list from `migrations_list.rs`: the same versions, SQL and
/// order the desktop app used. sqlx stores a checksum of each migration's
/// SQL, so a `tapago.db` from the desktop app is recognized here as
/// already migrated instead of failing with "previously applied but has
/// been modified". Never edit an applied migration.
macro_rules! migration_list {
    ($(($version:expr, $description:expr, $file:literal)),* $(,)?) => {
        vec![$(($version, $description, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations/", $file)))),*]
    };
}

fn migration_specs() -> Vec<(i64, &'static str, &'static str)> {
    include!("migrations_list.rs")
}

/// Same conversion tauri-plugin-sql does (`MigrationList::resolve`), kept in
/// list order — not sorted by version.
#[derive(Debug)]
struct SharedMigrations;

impl MigrationSource<'static> for SharedMigrations {
    fn resolve(self) -> futures_core::future::BoxFuture<'static, Result<Vec<Migration>, BoxDynError>> {
        Box::pin(async move {
            Ok(migration_specs()
                .into_iter()
                .map(|(version, description, sql)| Migration::new(version, Cow::Borrowed(description), MigrationType::Simple, Cow::Borrowed(sql), false))
                .collect())
        })
    }
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    Migrator::new(SharedMigrations).await?.run(pool).await
}

pub async fn connect(path: &Path) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        // WAL: readers don't block the writer, and Litestream (the backup
        // to Cloud Storage) requires it.
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(options).await?;
    migrate(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
pub async fn test_pool() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap().foreign_keys(true);
    // One connection: every connection to `:memory:` is a separate database.
    let pool = SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
    migrate(&pool).await.unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_desktop_order_where_71001_runs_between_71_and_72() {
        let versions: Vec<i64> = migration_specs().iter().map(|m| m.0).collect();
        let at = versions.iter().position(|&v| v == 71001).unwrap();
        assert_eq!((versions[at - 1], versions[at + 1]), (71, 72));
    }

    #[tokio::test]
    async fn every_migration_applies_on_a_fresh_database() {
        let pool = test_pool().await;
        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1").fetch_one(&pool).await.unwrap();
        assert_eq!(applied as usize, migration_specs().len());
    }
}
