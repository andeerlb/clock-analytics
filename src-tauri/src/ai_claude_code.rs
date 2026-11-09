//! Runs the assistant through a locally installed, logged-in Claude Code
//! instead of an API key.
//!
//! Claude Code ships with its own tools (shell, file editing), which would
//! break the assistant's "only answers" guarantee. So it's started with every
//! built-in tool off, none of the user's settings, and exactly one tool: the
//! guarded `run_sql`, served by this same executable in a child process
//! (`--assistant-tool-server`). `ask` then checks the tool list Claude Code
//! itself reports and aborts if it's anything other than that one tool.

use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::ai_investigation::{guard, load_scrubber, run_sql, tool_definitions, GuardedDb, Scrubber, EFFORT, MODEL};

const TOOL_SERVER_FLAG: &str = "--assistant-tool-server";
const SERVER_NAME: &str = "pontoscan";
const TOOL_ID: &str = "mcp__pontoscan__run_sql";
const STATUS_TIME_LIMIT: Duration = Duration::from_secs(15);
const ANSWER_TIME_LIMIT: Duration = Duration::from_secs(300);

#[cfg(windows)]
const EXECUTABLE: &str = "claude.exe";
#[cfg(not(windows))]
const EXECUTABLE: &str = "claude";

/// PATH first, then the usual install spots: an app opened from the desktop
/// often gets a minimal PATH without them (same issue as `poppler::resolve`).
fn find_executable() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".claude/local"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.into_iter().map(|dir| dir.join(EXECUTABLE)).find(|path| path.is_file())
}

/// The installed Claude Code, if there is one and it's logged in.
pub(crate) async fn available() -> Option<PathBuf> {
    let executable = find_executable()?;
    let status = Command::new(&executable).args(["auth", "status"]).stdin(Stdio::null()).kill_on_drop(true).output();
    let output = tokio::time::timeout(STATUS_TIME_LIMIT, status).await.ok()?.ok()?;
    let parsed: Value = serde_json::from_slice(&output.stdout).ok()?;
    (parsed["loggedIn"] == true).then_some(executable)
}

pub(crate) struct Reply {
    pub text: String,
    pub session_id: String,
}

/// What's safe to accept from Claude Code's own startup report.
fn verify_startup(init: &Value) -> Result<(), String> {
    let tools = init["tools"].as_array().map(Vec::as_slice).unwrap_or_default();
    if tools.len() != 1 || tools[0] != TOOL_ID {
        return Err("O Claude Code iniciou com ferramentas inesperadas, então a consulta foi cancelada por segurança.".to_string());
    }
    Ok(())
}

fn command_args(server_exe: &Path, db_path: &str, system: &str, resume: Option<&str>) -> Vec<String> {
    let server = json!({
        "mcpServers": { SERVER_NAME: {
            "type": "stdio",
            "command": server_exe.to_string_lossy(),
            "args": [TOOL_SERVER_FLAG, db_path],
        }},
    });
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
        "--allowedTools",
        TOOL_ID,
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-chrome",
        "--model",
        MODEL,
        "--effort",
        EFFORT,
        "--system-prompt",
        system,
        "--mcp-config",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    args.push(server.to_string());
    if let Some(session) = resume {
        args.push("--resume".to_string());
        args.push(session.to_string());
    }
    args
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn ask(
    progress: &(dyn Fn(&str) + Send + Sync),
    executable: &Path,
    server_exe: &Path,
    work_dir: &Path,
    db_path: &str,
    system: &str,
    prompt: &str,
    resume: Option<&str>,
) -> Result<Reply, String> {
    let mut child = Command::new(executable)
        .args(command_args(server_exe, db_path, system, resume))
        .current_dir(work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o Claude Code: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("Falha ao falar com o Claude Code.")?;
    stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or("Falha ao ler o Claude Code.")?;

    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut result = None;
        let mut verified = false;
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            match event["type"].as_str().unwrap_or_default() {
                "system" if event["subtype"] == "init" => {
                    verify_startup(&event)?;
                    verified = true;
                }
                "assistant" => {
                    let blocks = event["message"]["content"].as_array().map(Vec::as_slice).unwrap_or_default();
                    if blocks.iter().any(|b| b["type"] == "tool_use") {
                        progress("Consultando os dados");
                    }
                }
                "result" => result = Some(event),
                _ => {}
            }
        }
        if !verified {
            return Err("O Claude Code não confirmou como iniciou, então a consulta foi cancelada por segurança.".to_string());
        }
        Ok::<_, String>(result)
    };
    // Returning early drops `child`, and `kill_on_drop` stops it.
    let result = tokio::time::timeout(ANSWER_TIME_LIMIT, read)
        .await
        .map_err(|_| "O Claude Code demorou demais para responder.".to_string())??
        .ok_or("O Claude Code terminou sem responder.")?;

    let text = result["result"].as_str().unwrap_or_default().to_string();
    if result["is_error"] == true {
        return Err(if text.is_empty() { "O Claude Code devolveu um erro.".to_string() } else { format!("Claude Code: {text}") });
    }
    if text.trim().is_empty() {
        return Err("O modelo não devolveu nenhuma resposta.".to_string());
    }
    let session_id = result["session_id"].as_str().ok_or("O Claude Code não informou a sessão.")?.to_string();
    Ok(Reply { text, session_id })
}

// ---------------------------------------------------------------------------
// Tool server (child process)
// ---------------------------------------------------------------------------

fn tools_for_mcp() -> Value {
    let tools: Vec<Value> = tool_definitions()
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|tool| json!({ "name": tool["name"], "description": tool["description"], "inputSchema": tool["input_schema"] }))
        .collect();
    json!({ "tools": tools })
}

/// One MCP JSON-RPC message in, at most one reply out: notifications carry no
/// `id` and get none.
async fn handle_message(db: &mut GuardedDb, scrubber: &Scrubber, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let params = &message["params"];
    Some(match message["method"].as_str().unwrap_or_default() {
        "initialize" => reply(json!({
            "protocolVersion": params["protocolVersion"],
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => reply(json!({})),
        "tools/list" => reply(tools_for_mcp()),
        "tools/call" => {
            let outcome = match params["name"].as_str() {
                Some("run_sql") => run_sql(db, scrubber, params["arguments"]["sql"].as_str().unwrap_or_default()).await,
                other => Err(format!("Ferramenta desconhecida: {other:?}")),
            };
            match outcome {
                Ok(value) => reply(json!({ "content": [{ "type": "text", "text": value.to_string() }] })),
                Err(error) => reply(json!({ "content": [{ "type": "text", "text": error }], "isError": true })),
            }
        }
        _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } }),
    })
}

async fn serve(db_path: &str) -> Result<(), String> {
    let options = SqliteConnectOptions::new().filename(db_path).read_only(true);
    let mut trusted = SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
    let scrubber = load_scrubber(&mut trusted).await?;
    let _ = trusted.close().await;
    let mut db = guard(SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?).await?;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(reply) = handle_message(&mut db, &scrubber, &message).await {
            writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Runs the tool server instead of the app when started with its flag.
/// Returns whether it did, so `main` knows not to open the window.
pub fn run_tool_server_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(TOOL_SERVER_FLAG) {
        return false;
    }
    let Some(db_path) = args.get(2) else { return true };
    if let Err(error) = tauri::async_runtime::block_on(serve(db_path)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_investigation::tests::fixtures;

    #[test]
    fn startup_is_accepted_only_with_exactly_the_guarded_tool() {
        assert!(verify_startup(&json!({ "tools": [TOOL_ID] })).is_ok());
        assert!(verify_startup(&json!({ "tools": [TOOL_ID, "Bash"] })).is_err());
        assert!(verify_startup(&json!({ "tools": ["Bash"] })).is_err());
        assert!(verify_startup(&json!({ "tools": [] })).is_err());
        assert!(verify_startup(&json!({})).is_err());
    }

    #[test]
    fn every_built_in_tool_and_user_setting_is_switched_off() {
        let args = command_args(Path::new("/app"), "/db", "sistema", Some("sessao"));
        let value_after = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].clone();
        assert_eq!(value_after("--tools"), "");
        assert_eq!(value_after("--setting-sources"), "");
        assert_eq!(value_after("--allowedTools"), TOOL_ID);
        assert_eq!(value_after("--resume"), "sessao");
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        let server: Value = serde_json::from_str(&value_after("--mcp-config")).unwrap();
        assert_eq!(server["mcpServers"][SERVER_NAME]["args"], json!([TOOL_SERVER_FLAG, "/db"]));
    }

    #[test]
    fn mcp_server_answers_the_protocol_and_keeps_every_guard() {
        tauri::async_runtime::block_on(async {
            let (mut db, scrubber, _) = fixtures().await;
            let init = json!({ "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } });
            let reply = handle_message(&mut db, &scrubber, &init).await.unwrap();
            assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");

            let notification = json!({ "method": "notifications/initialized" });
            assert!(handle_message(&mut db, &scrubber, &notification).await.is_none());

            let list = handle_message(&mut db, &scrubber, &json!({ "id": 2, "method": "tools/list" })).await.unwrap();
            assert_eq!(list["result"]["tools"][0]["name"], "run_sql");
            assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 1);

            let call = |sql: &str| json!({ "id": 3, "method": "tools/call", "params": { "name": "run_sql", "arguments": { "sql": sql } } });
            let ok = handle_message(&mut db, &scrubber, &call("SELECT local FROM payment_shifts WHERE id = 10")).await.unwrap();
            assert!(ok["result"]["content"][0]["text"].as_str().unwrap().contains("FUNC_3"));
            let refused = handle_message(&mut db, &scrubber, &call("SELECT cpf FROM employees")).await.unwrap();
            assert_eq!(refused["result"]["isError"], true);

            let unknown = handle_message(&mut db, &scrubber, &json!({ "id": 4, "method": "resources/list" })).await.unwrap();
            assert_eq!(unknown["error"]["code"], -32601);
        });
    }
}
