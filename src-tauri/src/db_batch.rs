use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::sqlite::{Sqlite, SqliteArguments};
use sqlx::Pool;
use sqlx::query::Query;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

/// One statement of a `run_write_batch` call. A param shaped like
/// `{"$lastInsertId": n}` is replaced with the `last_insert_rowid()` of the
/// batch's own statement `n` (0-based) — how a child row (a day_record, a
/// punch) points at a parent inserted earlier in the same batch.
#[derive(Debug, Deserialize)]
pub struct BatchStatement {
    sql: String,
    #[serde(default)]
    params: Vec<JsonValue>,
    /// When set, the statement must change at least one row — otherwise the
    /// whole batch is rolled back and this message is returned as the error
    /// (e.g. a guarded `INSERT ... WHERE NOT EXISTS` that found its guard
    /// already tripped by another writer).
    #[serde(default, rename = "expectChanges")]
    expect_changes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStatementResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn last_insert_ref(value: &JsonValue) -> Option<u64> {
    value.as_object()?.get("$lastInsertId")?.as_u64()
}

/// Binds `value` the same way tauri-plugin-sql's own `execute` does (null,
/// string, number-as-f64, anything else as JSON), so a statement behaves
/// identically whether it goes through `db.execute` or through a batch.
fn bind_value<'q>(query: Query<'q, Sqlite, SqliteArguments<'q>>, value: JsonValue) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    if value.is_null() {
        query.bind(None::<JsonValue>)
    } else if let Some(s) = value.as_str() {
        query.bind(s.to_owned())
    } else if let Some(number) = value.as_number() {
        query.bind(number.as_f64().unwrap_or_default())
    } else {
        query.bind(value)
    }
}

/// Runs every statement in `statements` inside ONE sqlx transaction on the
/// same pool tauri-plugin-sql opened for `db` — all of them apply, or (on
/// the first error) none do. The frontend can't do this itself: the
/// plugin's `execute` hands each call to whichever pooled connection is
/// free, so a `BEGIN`/`COMMIT` sent as separate calls isn't guaranteed to
/// land on the same connection as the statements in between.
#[tauri::command]
pub async fn run_write_batch(
    db_instances: State<'_, DbInstances>,
    db: String,
    statements: Vec<BatchStatement>,
) -> Result<Vec<BatchStatementResult>, String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get(&db) {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err(format!("Banco de dados não carregado: {db}")),
    };

    run_batch(pool, statements).await
}

async fn run_batch(pool: &Pool<Sqlite>, statements: Vec<BatchStatement>) -> Result<Vec<BatchStatementResult>, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let mut results: Vec<BatchStatementResult> = Vec::with_capacity(statements.len());
    for (index, statement) in statements.into_iter().enumerate() {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.params {
            query = match last_insert_ref(&value) {
                Some(n) => {
                    let id = results
                        .get(n as usize)
                        .ok_or_else(|| format!("Instrução {index} referencia a instrução {n}, que ainda não rodou"))?
                        .last_insert_id;
                    query.bind(id)
                }
                None => bind_value(query, value),
            };
        }
        // Dropping `tx` on this early return rolls the whole batch back.
        let result = query.execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if result.rows_affected() == 0 {
            if let Some(message) = statement.expect_changes {
                return Err(message);
            }
        }
        results.push(BatchStatementResult {
            rows_affected: result.rows_affected(),
            last_insert_id: result.last_insert_rowid(),
        });
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn statement(value: JsonValue) -> BatchStatement {
        serde_json::from_value(value).unwrap()
    }

    async fn pool() -> Pool<Sqlite> {
        // One connection: each new `sqlite::memory:` connection is its own empty database.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, previous_id INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn count(pool: &Pool<Sqlite>, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(pool).await.unwrap()
    }

    #[test]
    fn links_children_to_parents_inserted_earlier_in_the_batch() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            let results = run_batch(
                &pool,
                vec![
                    statement(json!({ "sql": "INSERT INTO parent (name) VALUES ($1)", "params": ["a"] })),
                    statement(json!({ "sql": "INSERT INTO child (parent_id) VALUES ($1)", "params": [{ "$lastInsertId": 0 }] })),
                ],
            )
            .await
            .unwrap();
            let parent_id: i64 = sqlx::query_scalar("SELECT parent_id FROM child").fetch_one(&pool).await.unwrap();
            assert_eq!(parent_id, results[0].last_insert_id);
        });
    }

    #[test]
    fn rolls_back_everything_when_a_statement_fails() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            let result = run_batch(
                &pool,
                vec![
                    statement(json!({ "sql": "INSERT INTO parent (name) VALUES ($1)", "params": ["a"] })),
                    statement(json!({ "sql": "INSERT INTO parent (name) VALUES ($1)", "params": [null] })),
                ],
            )
            .await;
            assert!(result.is_err());
            assert_eq!(count(&pool, "parent").await, 0);
        });
    }

    #[test]
    fn expect_changes_rolls_back_a_guarded_insert_that_found_its_guard_tripped() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            sqlx::query("INSERT INTO child (id, parent_id, previous_id) VALUES (2, 1, 1)")
                .execute(&pool)
                .await
                .unwrap();
            // `$2` appears twice — the same bound value both times.
            let guarded = json!({
                "sql": "INSERT INTO child (parent_id, previous_id) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM child WHERE previous_id = $2)",
                "params": [1, 1],
                "expectChanges": "já alterado",
            });
            let result = run_batch(
                &pool,
                vec![
                    statement(json!({ "sql": "INSERT INTO parent (name) VALUES ($1)", "params": ["a"] })),
                    statement(guarded),
                ],
            )
            .await;
            assert_eq!(result.err().as_deref(), Some("já alterado"));
            assert_eq!(count(&pool, "parent").await, 0);
            assert_eq!(count(&pool, "child").await, 1);
        });
    }
}
