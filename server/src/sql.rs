//! Runs the desktop app's SQL as-is and returns rows as JSON — the server-side
//! twin of what `@tauri-apps/plugin-sql` did for `src/lib/db.ts`.
//!
//! This is what makes porting `db.ts` mechanical and safe: each function's
//! SQL text (with its `$1` placeholders and `AS camelCase` aliases) moves to
//! Rust unchanged, parameters are bound exactly the way the plugin bound
//! them, and rows come back in exactly the JSON shape the frontend already
//! expects. See `server/PORTING.md`.


use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::query::Query;
use sqlx::sqlite::{Sqlite, SqliteArguments, SqliteRow, SqliteValueRef};
use sqlx::{Column, Executor, Row as _, SqlitePool, TypeInfo, ValueRef};

use crate::error::{ApiError, ApiResult};

/// One result row: column name (the SQL alias) → value.
pub type Row = Map<String, Value>;

/// Builds a JSON array of parameters: `params![a, b, c]`.
#[macro_export]
macro_rules! params {
    ($($value:expr),* $(,)?) => {{
        let params: Vec<::serde_json::Value> = vec![$(::serde_json::json!($value)),*];
        params
    }};
}

/// Binds one parameter exactly like tauri-plugin-sql did: numbers as f64
/// (SQLite's column affinity turns them back into integers where the column
/// is INTEGER), strings as text, null as NULL, anything else as JSON text.
fn bind<'q>(query: Query<'q, Sqlite, SqliteArguments<'q>>, value: &Value) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    if value.is_null() {
        query.bind(None::<String>)
    } else if let Some(s) = value.as_str() {
        query.bind(s.to_owned())
    } else if let Some(number) = value.as_number() {
        query.bind(number.as_f64().unwrap_or_default())
    } else {
        query.bind(value.clone())
    }
}

fn build<'q>(sql: &'q str, params: &[Value]) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    params.iter().fold(sqlx::query(sql), bind)
}

/// tauri-plugin-sql's `decode::sqlite::to_json`, minus the date/time types
/// no column in this schema declares.
fn to_json(value: SqliteValueRef<'_>) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    let v = ValueRef::to_owned(&value);
    match value.type_info().name() {
        "INTEGER" | "NUMERIC" => sqlx::Value::try_decode::<i64>(&v).map(Value::from).unwrap_or(Value::Null),
        "REAL" => sqlx::Value::try_decode::<f64>(&v).map(Value::from).unwrap_or(Value::Null),
        "BOOLEAN" => sqlx::Value::try_decode::<bool>(&v).map(Value::Bool).unwrap_or(Value::Null),
        "BLOB" => sqlx::Value::try_decode::<Vec<u8>>(&v)
            .map(|bytes| Value::Array(bytes.into_iter().map(Value::from).collect()))
            .unwrap_or(Value::Null),
        "NULL" => Value::Null,
        // TEXT, and the date/time names, which SQLite stores as text anyway.
        _ => sqlx::Value::try_decode::<String>(&v).map(Value::String).unwrap_or(Value::Null),
    }
}

fn row_to_json(row: &SqliteRow) -> Result<Row, sqlx::Error> {
    let mut out = Map::with_capacity(row.columns().len());
    for (i, column) in row.columns().iter().enumerate() {
        out.insert(column.name().to_owned(), to_json(row.try_get_raw(i)?));
    }
    Ok(out)
}

/// `db.select(sql, params)`.
pub async fn select<'e, E>(executor: E, sql: &str, params: &[Value]) -> ApiResult<Vec<Row>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let rows = executor.fetch_all(build(sql, params)).await?;
    Ok(rows.iter().map(row_to_json).collect::<Result<_, _>>()?)
}

/// `select` that expects at most one row.
pub async fn select_one<'e, E>(executor: E, sql: &str, params: &[Value]) -> ApiResult<Option<Row>>
where
    E: Executor<'e, Database = Sqlite>,
{
    Ok(select(executor, sql, params).await?.into_iter().next())
}

/// Result of `db.execute`.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// `db.execute(sql, params)`.
pub async fn execute<'e, E>(executor: E, sql: &str, params: &[Value]) -> ApiResult<ExecResult>
where
    E: Executor<'e, Database = Sqlite>,
{
    let result = executor.execute(build(sql, params)).await?;
    Ok(ExecResult { rows_affected: result.rows_affected(), last_insert_id: result.last_insert_rowid() })
}

/// One statement of `runWriteBatch`. A parameter `{"$lastInsertId": n}`
/// stands for the id inserted by statement `n` (0-based) of the same batch.
#[derive(Debug, Clone, Deserialize)]
pub struct BatchStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    /// Fails (and rolls back) the whole batch with this message when the
    /// statement changes no rows — a guard against concurrent edits.
    #[serde(default, rename = "expectChanges")]
    pub expect_changes: Option<String>,
}

impl BatchStatement {
    pub fn new(sql: impl Into<String>, params: Vec<Value>) -> Self {
        BatchStatement { sql: sql.into(), params, expect_changes: None }
    }

    pub fn expect_changes(mut self, message: impl Into<String>) -> Self {
        self.expect_changes = Some(message.into());
        self
    }
}

/// Placeholder for "the id statement `n` of this batch inserted".
pub fn last_insert_id_of(n: usize) -> Value {
    serde_json::json!({ "$lastInsertId": n })
}

/// The desktop's `runWriteBatch`: every statement in one
/// transaction — all apply, or on the first error none do. A tripped
/// `expect_changes` guard becomes a 409 with its message.
pub async fn run_batch(pool: &SqlitePool, statements: Vec<BatchStatement>) -> ApiResult<Vec<ExecResult>> {
    let mut tx = pool.begin().await?;
    let mut results: Vec<ExecResult> = Vec::with_capacity(statements.len());
    for (index, statement) in statements.into_iter().enumerate() {
        let mut params = Vec::with_capacity(statement.params.len());
        for value in statement.params {
            match value.as_object().and_then(|o| o.get("$lastInsertId")).and_then(Value::as_u64) {
                Some(n) => {
                    let id = results
                        .get(n as usize)
                        .ok_or_else(|| ApiError::Internal(format!("instrução {index} referencia a instrução {n}, que ainda não rodou")))?
                        .last_insert_id;
                    params.push(Value::from(id));
                }
                None => params.push(value),
            }
        }
        let result = execute(&mut *tx, &statement.sql, &params).await?;
        if result.rows_affected == 0 {
            if let Some(message) = statement.expect_changes {
                return Err(ApiError::Conflict(message));
            }
        }
        results.push(result);
    }
    tx.commit().await?;
    Ok(results)
}

/// `foldAccentsSql` from db.ts: LOWER() plus REPLACE() for every accented
/// PT-BR letter, so `LIKE` matches "goncalves" against "GONÇALVES".
pub fn fold_accents_sql(expr: &str) -> String {
    const PAIRS: &[(&str, &str)] = &[
        ("á", "a"), ("à", "a"), ("ã", "a"), ("â", "a"), ("ä", "a"),
        ("Á", "a"), ("À", "a"), ("Ã", "a"), ("Â", "a"), ("Ä", "a"),
        ("é", "e"), ("è", "e"), ("ê", "e"), ("ë", "e"),
        ("É", "e"), ("È", "e"), ("Ê", "e"), ("Ë", "e"),
        ("í", "i"), ("ì", "i"), ("î", "i"), ("ï", "i"),
        ("Í", "i"), ("Ì", "i"), ("Î", "i"), ("Ï", "i"),
        ("ó", "o"), ("ò", "o"), ("õ", "o"), ("ô", "o"), ("ö", "o"),
        ("Ó", "o"), ("Ò", "o"), ("Õ", "o"), ("Ô", "o"), ("Ö", "o"),
        ("ú", "u"), ("ù", "u"), ("û", "u"), ("ü", "u"),
        ("Ú", "u"), ("Ù", "u"), ("Û", "u"), ("Ü", "u"),
        ("ç", "c"), ("Ç", "c"), ("ñ", "n"), ("Ñ", "n"),
    ];
    PAIRS.iter().fold(format!("LOWER({expr})"), |acc, (from, to)| format!("REPLACE({acc}, '{from}', '{to}')"))
}

/// `inClause` from db.ts: appends `column IN ($n, …)` built off the current
/// length of `params` and pushes the values; `None` for an empty list (an
/// empty `IN ()` isn't valid SQL, and the caller means "no filter").
pub fn in_clause(column: &str, values: &[Value], params: &mut Vec<Value>) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    let start = params.len();
    let placeholders: Vec<String> = (0..values.len()).map(|i| format!("${}", start + i + 1)).collect();
    params.extend(values.iter().cloned());
    Some(format!("{column} IN ({})", placeholders.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_pool;
    use serde_json::json;

    async fn pool() -> SqlitePool {
        let pool = test_pool().await;
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, n INTEGER)").execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn rows_come_back_with_aliases_and_plugin_types() {
        let pool = pool().await;
        execute(&pool, "INSERT INTO t (name, amount, n) VALUES ($1, $2, $3)", &params!["Ana", 10.5, 7]).await.unwrap();
        let rows = select(&pool, "SELECT id, name AS displayName, amount, n, NULL AS empty, n * 2 AS doubled FROM t WHERE n = $1", &params![7]).await.unwrap();
        assert_eq!(
            Value::Object(rows[0].clone()),
            json!({ "id": 1, "displayName": "Ana", "amount": 10.5, "n": 7, "empty": null, "doubled": 14 })
        );
    }

    #[tokio::test]
    async fn numbers_bound_as_f64_still_land_as_integers_in_integer_columns() {
        let pool = pool().await;
        execute(&pool, "INSERT INTO t (n) VALUES ($1)", &params![42]).await.unwrap();
        let kind: String = sqlx::query_scalar("SELECT typeof(n) FROM t").fetch_one(&pool).await.unwrap();
        assert_eq!(kind, "integer");
    }

    #[tokio::test]
    async fn repeated_and_out_of_order_placeholders_bind_by_number() {
        let pool = pool().await;
        execute(&pool, "INSERT INTO t (name, n) VALUES ($2, $1)", &params![5, "x"]).await.unwrap();
        let rows = select(&pool, "SELECT name FROM t WHERE n = $1 AND name = $2 AND n = $1", &params![5, "x"]).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn batch_links_last_insert_ids_and_rolls_back_on_guard() {
        let pool = pool().await;
        let results = run_batch(
            &pool,
            vec![
                BatchStatement::new("INSERT INTO t (name) VALUES ($1)", params!["parent"]),
                BatchStatement::new("INSERT INTO t (name, n) VALUES ($1, $2)", vec![json!("child"), last_insert_id_of(0)]),
            ],
        )
        .await
        .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT n FROM t WHERE name = 'child'").fetch_one(&pool).await.unwrap();
        assert_eq!(n, results[0].last_insert_id);

        let err = run_batch(
            &pool,
            vec![
                BatchStatement::new("INSERT INTO t (name) VALUES ($1)", params!["nope"]),
                BatchStatement::new("UPDATE t SET name = 'z' WHERE id = $1", params![999]).expect_changes("já alterado"),
            ],
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "já alterado");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM t WHERE name = 'nope'").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn in_clause_numbers_from_current_params() {
        let mut params = params!["a"];
        let clause = in_clause("c.id", &params![1, 2], &mut params).unwrap();
        assert_eq!(clause, "c.id IN ($2, $3)");
        assert_eq!(params.len(), 3);
        assert!(in_clause("c.id", &[], &mut params).is_none());
    }

    #[test]
    fn fold_accents_wraps_lower_and_replaces() {
        let sql = fold_accents_sql("e.name");
        assert!(sql.starts_with("REPLACE("));
        assert!(sql.contains("LOWER(e.name)"));
        assert!(sql.contains("'Ç', 'c'"));
    }
}
