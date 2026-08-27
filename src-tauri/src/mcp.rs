// MCP adapter: `mine mcp` serves the CLI's subcommands as MCP tools over
// stdio (JSON-RPC 2.0, newline-delimited). Every tool call is translated to
// an argv vector and dispatched through `cli::run`, so behaviour, guards and
// output are identical to the CLI by construction — the adapter owns no
// domain logic of its own.
//
// Contract: SPEC_AI_ACCESS.md (этап 2).

use serde_json::{json, Value};

use crate::cli::{run, CliEnv};

const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_NAME: &str = "mine";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Serve MCP over the process's stdin/stdout. Blocks until stdin closes.
pub fn serve(env: &CliEnv) {
    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(env, &line) {
            // Newline-delimited framing: one JSON-RPC message per line.
            let _ = writeln!(stdout, "{response}");
            let _ = stdout.flush();
        }
    }
}

/// Handle one JSON-RPC message; `None` for notifications (no response).
pub fn handle_message(env: &CliEnv, raw: &str) -> Option<String> {
    let message: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            return Some(
                error_response(Value::Null, -32700, "parse error").to_string(),
            )
        }
    };
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    // A message without an id is a notification: process nothing, answer nothing.
    let id = id?;

    let result = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_definitions() }),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(env, name, &arguments) {
                Ok(result) => result,
                Err(message) => {
                    return Some(error_response(id, -32602, &message).to_string())
                }
            }
        }
        _ => return Some(error_response(id, -32601, "method not found").to_string()),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// ─── Tools ──────────────────────────────────────────────────────────────────

struct ToolSpec {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

fn prop(name: &str, ty: &str, description: &str) -> (String, Value) {
    (name.to_string(), json!({ "type": ty, "description": description }))
}

fn schema(required: &[&str], props: Vec<(String, Value)>) -> Value {
    let mut map = serde_json::Map::new();
    for (name, value) in props {
        map.insert(name, value);
    }
    json!({ "type": "object", "properties": map, "required": required })
}

fn space_prop() -> (String, Value) {
    prop("space", "string", "Absolute path of the space; defaults to the active one")
}

fn slug_prop() -> (String, Value) {
    prop("slug", "string", "Vault-relative card slug, e.g. Cards/sunset")
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "spaces",
        description: "List known spaces; the active one is marked",
        schema: || schema(&[], vec![]),
    },
    ToolSpec {
        name: "search",
        description: "Hybrid search over cards (lexical when the embedding model is absent)",
        schema: || schema(&["query"], vec![
            prop("query", "string", "Search query"),
            prop("limit", "integer", "Max results"),
            prop("offset", "integer", "Results offset"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "collections",
        description: "List collections with card counts",
        schema: || schema(&[], vec![space_prop()]),
    },
    ToolSpec {
        name: "cards",
        description: "List cards of one collection",
        schema: || schema(&["collection"], vec![
            prop("collection", "string", "Collection name"),
            prop("limit", "integer", "Max results"),
            prop("offset", "integer", "Results offset"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "card",
        description: "Read one card's metadata",
        schema: || schema(&["slug"], vec![slug_prop(), space_prop()]),
    },
    ToolSpec {
        name: "card_body",
        description: "Read one card's markdown body",
        schema: || schema(&["slug"], vec![slug_prop(), space_prop()]),
    },
    ToolSpec {
        name: "card_set",
        description: "Set one known front-matter field (title|description|url|author|source)",
        schema: || schema(&["slug", "field", "value"], vec![
            slug_prop(),
            prop("field", "string", "Field name"),
            prop("value", "string", "New value"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "card_unset",
        description: "Remove one known front-matter field",
        schema: || schema(&["slug", "field"], vec![
            slug_prop(),
            prop("field", "string", "Field name"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "card_set_body",
        description: "Replace a card's body; media embeds are guarded unless allow_media_changes",
        schema: || schema(&["slug", "body"], vec![
            slug_prop(),
            prop("body", "string", "New markdown body"),
            prop("allow_media_changes", "boolean", "Permit changing the set of media embeds"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "card_create",
        description: "Create a card from title/url/body/media file",
        schema: || schema(&[], vec![
            prop("title", "string", "Card title"),
            prop("url", "string", "Source URL"),
            prop("collection", "string", "Collection to connect the card to"),
            prop("file", "string", "Absolute path of a media file to copy in"),
            prop("body", "string", "Markdown body"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "card_rename",
        description: "Rename a card; references and index follow",
        schema: || schema(&["slug", "new_name"], vec![
            slug_prop(),
            prop("new_name", "string", "New card name (no folder, no extension)"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "card_delete",
        description: "Delete a card (files go to the OS trash; text backed up for restore)",
        schema: || schema(&["slug"], vec![
            slug_prop(),
            prop("delete_unused_media", "boolean", "Also trash unused media files"),
            prop("dry_run", "boolean", "Report the plan without deleting"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "merge",
        description: "Merge two or more cards into a new one (sources removed)",
        schema: || schema(&["slugs"], vec![
            ("slugs".to_string(), json!({
                "type": "array", "items": { "type": "string" },
                "description": "Card slugs in merge order, first defines the base",
            })),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "connect",
        description: "Add a card to a collection",
        schema: || schema(&["slug", "collection"], vec![
            slug_prop(),
            prop("collection", "string", "Collection name"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "disconnect",
        description: "Remove a card from a collection",
        schema: || schema(&["slug", "collection"], vec![
            slug_prop(),
            prop("collection", "string", "Collection name"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "collection_create",
        description: "Create a collection",
        schema: || schema(&["name"], vec![
            prop("name", "string", "Collection name"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "collection_rename",
        description: "Rename a collection; membership in cards is rewritten",
        schema: || schema(&["old", "new"], vec![
            prop("old", "string", "Current name"),
            prop("new", "string", "New name"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "collection_delete",
        description: "Delete a collection page (cards keep their files)",
        schema: || schema(&["name"], vec![
            prop("name", "string", "Collection name"),
            space_prop(),
        ]),
    },
    ToolSpec {
        name: "restore",
        description: "Swap a card with its CLI backup (one level of undo)",
        schema: || schema(&["slug"], vec![slug_prop(), space_prop()]),
    },
];

fn tool_definitions() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.schema)(),
            })
        })
        .collect()
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

fn required_str(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing required argument: {key}"))
}

fn push_opt_str(argv: &mut Vec<String>, arguments: &Value, key: &str, flag: &str) {
    if let Some(value) = arguments.get(key).and_then(Value::as_str) {
        argv.push(flag.to_string());
        argv.push(value.to_string());
    }
}

fn push_opt_int(argv: &mut Vec<String>, arguments: &Value, key: &str, flag: &str) {
    if let Some(value) = arguments.get(key).and_then(Value::as_i64) {
        argv.push(flag.to_string());
        argv.push(value.to_string());
    }
}

fn flag_on(arguments: &Value, key: &str) -> bool {
    arguments.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Write a body argument to a temp file so it can travel through `--from`.
/// The CLI reads bodies from files/stdin; MCP arguments arrive as strings.
fn body_to_temp_file(body: &str) -> Result<tempfile::NamedTempFile, String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new().map_err(|e| format!("temp file: {e}"))?;
    file.write_all(body.as_bytes()).map_err(|e| format!("temp file: {e}"))?;
    Ok(file)
}

/// Build the argv for one tool call. Returns the argv plus a temp file that
/// must stay alive until the CLI has run (bodies travel through `--from`).
fn tool_argv(
    name: &str,
    arguments: &Value,
) -> Result<(Vec<String>, Option<tempfile::NamedTempFile>), String> {
    let mut argv: Vec<String> = Vec::new();
    let mut temp: Option<tempfile::NamedTempFile> = None;
    match name {
        "spaces" => argv.push("spaces".into()),
        "search" => {
            argv.push("search".into());
            argv.push(required_str(arguments, "query")?);
            push_opt_int(&mut argv, arguments, "limit", "--limit");
            push_opt_int(&mut argv, arguments, "offset", "--offset");
        }
        "collections" => argv.push("collections".into()),
        "cards" => {
            argv.push("cards".into());
            argv.push("--collection".into());
            argv.push(required_str(arguments, "collection")?);
            push_opt_int(&mut argv, arguments, "limit", "--limit");
            push_opt_int(&mut argv, arguments, "offset", "--offset");
        }
        "card" => {
            argv.push("card".into());
            argv.push(required_str(arguments, "slug")?);
        }
        "card_body" => {
            argv.extend(["card".into(), "body".into()]);
            argv.push(required_str(arguments, "slug")?);
        }
        "card_set" => {
            argv.extend(["card".into(), "set".into()]);
            argv.push(required_str(arguments, "slug")?);
            argv.push(required_str(arguments, "field")?);
            argv.push(required_str(arguments, "value")?);
        }
        "card_unset" => {
            argv.extend(["card".into(), "unset".into()]);
            argv.push(required_str(arguments, "slug")?);
            argv.push(required_str(arguments, "field")?);
        }
        "card_set_body" => {
            argv.extend(["card".into(), "set-body".into()]);
            argv.push(required_str(arguments, "slug")?);
            let file = body_to_temp_file(&required_str(arguments, "body")?)?;
            argv.push("--from".into());
            argv.push(file.path().display().to_string());
            temp = Some(file);
            if flag_on(arguments, "allow_media_changes") {
                argv.push("--allow-media-changes".into());
            }
        }
        "card_create" => {
            argv.extend(["card".into(), "create".into()]);
            push_opt_str(&mut argv, arguments, "title", "--title");
            push_opt_str(&mut argv, arguments, "url", "--url");
            push_opt_str(&mut argv, arguments, "collection", "--collection");
            push_opt_str(&mut argv, arguments, "file", "--file");
            if let Some(body) = arguments.get("body").and_then(Value::as_str) {
                let file = body_to_temp_file(body)?;
                argv.push("--from".into());
                argv.push(file.path().display().to_string());
                temp = Some(file);
            }
        }
        "card_rename" => {
            argv.extend(["card".into(), "rename".into()]);
            argv.push(required_str(arguments, "slug")?);
            argv.push(required_str(arguments, "new_name")?);
        }
        "card_delete" => {
            argv.extend(["card".into(), "delete".into()]);
            argv.push(required_str(arguments, "slug")?);
            if flag_on(arguments, "delete_unused_media") {
                argv.push("--delete-unused-media".into());
            }
            if flag_on(arguments, "dry_run") {
                argv.push("--dry-run".into());
            }
        }
        "merge" => {
            argv.push("merge".into());
            let slugs = arguments
                .get("slugs")
                .and_then(Value::as_array)
                .ok_or_else(|| "missing required argument: slugs".to_string())?;
            for slug in slugs {
                argv.push(
                    slug.as_str()
                        .ok_or_else(|| "slugs must be strings".to_string())?
                        .to_string(),
                );
            }
        }
        "connect" | "disconnect" => {
            argv.push(name.into());
            argv.push(required_str(arguments, "slug")?);
            argv.push(required_str(arguments, "collection")?);
        }
        "collection_create" => {
            argv.extend(["collection".into(), "create".into()]);
            argv.push(required_str(arguments, "name")?);
        }
        "collection_rename" => {
            argv.extend(["collection".into(), "rename".into()]);
            argv.push(required_str(arguments, "old")?);
            argv.push(required_str(arguments, "new")?);
        }
        "collection_delete" => {
            argv.extend(["collection".into(), "delete".into()]);
            argv.push(required_str(arguments, "name")?);
        }
        "restore" => {
            argv.push("restore".into());
            argv.push(required_str(arguments, "slug")?);
        }
        other => return Err(format!("unknown tool: {other}")),
    }
    if let Some(space) = arguments.get("space").and_then(Value::as_str) {
        argv.push("--space".into());
        argv.push(space.to_string());
    }
    argv.push("--json".into());
    Ok((argv, temp))
}

fn call_tool(env: &CliEnv, name: &str, arguments: &Value) -> Result<Value, String> {
    let (argv, _temp) = tool_argv(name, arguments)?;
    let output = run(env, &argv);
    // Tool-level failures travel inside the result as isError, per MCP; only
    // malformed calls become JSON-RPC errors (handled by the caller).
    if output.code == 0 {
        Ok(json!({
            "content": [{ "type": "text", "text": output.stdout.trim_end() }],
            "isError": false,
        }))
    } else {
        Ok(json!({
            "content": [{ "type": "text", "text": output.stderr.trim_end() }],
            "isError": true,
        }))
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::tests::{args, fixture};

    fn request(env: &CliEnv, method: &str, params: Value) -> Value {
        let raw = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let response = handle_message(env, &raw.to_string()).expect("a response");
        serde_json::from_str(&response).unwrap()
    }

    fn call(env: &CliEnv, name: &str, arguments: Value) -> Value {
        let response = request(env, "tools/call", json!({ "name": name, "arguments": arguments }));
        response["result"].clone()
    }

    fn text_of(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn initialize_and_list_all_tools() {
        let (_dir, env, _root) = fixture();
        let response = request(&env, "initialize", json!({}));
        assert_eq!(response["result"]["serverInfo"]["name"], "mine");

        let response = request(&env, "tools/list", json!({}));
        let tools = response["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        for expected in [
            "spaces", "search", "collections", "cards", "card", "card_body",
            "card_set", "card_unset", "card_set_body", "card_create",
            "card_rename", "card_delete", "merge", "connect", "disconnect",
            "collection_create", "collection_rename", "collection_delete",
            "restore",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert_eq!(names.len(), 19, "no undocumented tools");
        for tool in tools {
            assert!(tool["inputSchema"]["type"] == "object", "schema present for {}", tool["name"]);
        }
    }

    #[test]
    fn notifications_get_no_response_and_unknown_methods_error() {
        let (_dir, env, _root) = fixture();
        let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle_message(&env, &notification.to_string()).is_none());

        let response = request(&env, "no/such", json!({}));
        assert_eq!(response["error"]["code"], -32601);

        let garbage = handle_message(&env, "{not json").unwrap();
        let parsed: Value = serde_json::from_str(&garbage).unwrap();
        assert_eq!(parsed["error"]["code"], -32700);
    }

    #[test]
    fn read_tools_return_the_cli_json() {
        let (_dir, env, _root) = fixture();
        let result = call(&env, "card", json!({ "slug": "Cards/sunset" }));
        assert_eq!(result["isError"], false);
        let payload: Value = serde_json::from_str(&text_of(&result)).unwrap();
        assert_eq!(payload["contract"], 1);
        assert_eq!(payload["slug"], "Cards/sunset");
    }

    #[test]
    fn mutation_tools_mirror_the_cli() {
        let (_dir, env, root) = fixture();
        let result = call(&env, "card_set", json!({
            "slug": "Cards/plain", "field": "title", "value": "Via MCP",
        }));
        assert_eq!(result["isError"], false, "{}", text_of(&result));
        let content = std::fs::read_to_string(root.join("Cards/plain.md")).unwrap();
        assert!(content.contains("title: Via MCP"));

        let result = call(&env, "card_set_body", json!({
            "slug": "Cards/plain", "body": "Тело через MCP.\n",
        }));
        assert_eq!(result["isError"], false, "{}", text_of(&result));
        let content = std::fs::read_to_string(root.join("Cards/plain.md")).unwrap();
        assert!(content.contains("Тело через MCP."));

        let result = call(&env, "card_create", json!({ "title": "MCP Card", "body": "Раз.\n" }));
        assert_eq!(result["isError"], false, "{}", text_of(&result));
        assert!(root.join("MCP Card.md").exists());

        let result = call(&env, "collection_create", json!({ "name": "MCP Shelf" }));
        assert_eq!(result["isError"], false, "{}", text_of(&result));
        let result = call(&env, "connect", json!({ "slug": "MCP Card", "collection": "MCP Shelf" }));
        assert_eq!(result["isError"], false, "{}", text_of(&result));
        assert!(std::fs::read_to_string(root.join("MCP Card.md")).unwrap().contains("[[MCP Shelf]]"));
    }

    #[test]
    fn tool_failures_come_back_as_is_error_not_rpc_errors() {
        let (_dir, env, _root) = fixture();
        let result = call(&env, "card", json!({ "slug": "Cards/ghost" }));
        assert_eq!(result["isError"], true);
        assert!(!text_of(&result).is_empty());

        // A malformed call (missing argument) is a JSON-RPC error instead.
        let response = request(&env, "tools/call", json!({
            "name": "card_set", "arguments": { "slug": "Cards/plain" },
        }));
        assert_eq!(response["error"]["code"], -32602);

        let response = request(&env, "tools/call", json!({ "name": "nope", "arguments": {} }));
        assert_eq!(response["error"]["code"], -32602);
    }

    #[test]
    fn read_only_check_still_holds_under_mcp() {
        let (_dir, env, _root) = fixture();
        // args() is imported for parity with cli tests; silence unused warning.
        let _ = args(&[]);
        let vault = crate::cli::resolve_space(&env, None).map_err(|e| e.message).unwrap();
        let before = std::fs::read(vault.index_db_path()).unwrap();
        let result = call(&env, "search", json!({ "query": "sunset" }));
        assert_eq!(result["isError"], false);
        let after = std::fs::read(vault.index_db_path()).unwrap();
        assert_eq!(before, after, "reads must not touch the index");
    }
}
