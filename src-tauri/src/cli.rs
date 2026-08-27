//! The `mine` command-line interface — AI and human access to the vault.
//!
//! Read layer of SPEC_AI_ACCESS: everything here opens the index read-only,
//! starts no watcher and runs no reconciliation. Freshness is honest — the
//! CLI reads what the app has indexed, and says nothing more.
//!
//! Lives in the library so the commands are testable against a fixture vault;
//! the `mine-cli` binary is a thin `main` around [`run`].

use std::path::PathBuf;

use serde_json::json;

use crate::domain::vault::VaultLayout;
use crate::cli_mutations::{self, MutationError};
use crate::storage::{block_queries, db, media_refs, search_engine};

/// Exit codes per SPEC_AI_ACCESS: 0 success, 2 bad arguments, 3 space
/// unavailable, 4 not found.
pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_SPACE: i32 = 3;
pub const EXIT_NOT_FOUND: i32 = 4;

const CONTRACT_VERSION: u32 = 1;

/// Where the app keeps its config and derived stores. Overridable so tests
/// run against a fixture directory instead of the user's real one.
pub struct CliEnv {
    pub app_data_dir: PathBuf,
}

impl CliEnv {
    pub fn from_system() -> Option<Self> {
        let home = std::env::var_os("HOME")?;
        Some(Self {
            app_data_dir: PathBuf::from(home)
                .join("Library/Application Support/com.mine.app"),
        })
    }
}

struct SpaceConfig {
    active: Option<PathBuf>,
    known: Vec<PathBuf>,
}

fn load_space_config(env: &CliEnv) -> SpaceConfig {
    let raw = std::fs::read_to_string(env.app_data_dir.join("config.json")).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let active = value
        .get("vault_path")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    let mut known: Vec<PathBuf> = value
        .get("known_vaults")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    if let Some(ref active) = active {
        if !known.contains(active) {
            known.insert(0, active.clone());
        }
    }
    SpaceConfig { active, known }
}

/// A space the CLI may read: the app's active vault or one of the known ones.
/// Anything else is refused — the CLI must not wander the file system.
fn resolve_space(env: &CliEnv, requested: Option<&str>) -> Result<VaultLayout, CliError> {
    let config = load_space_config(env);
    let root = match requested {
        Some(path) => {
            let requested_path = PathBuf::from(path);
            if !config.known.contains(&requested_path) {
                return Err(CliError::space(format!(
                    "{path} is not a known space; `mine spaces` lists them"
                )));
            }
            requested_path
        }
        None => config.active.clone().ok_or_else(|| {
            CliError::space("no active space in the app config; pass --space".to_string())
        })?,
    };
    let vault_id = std::fs::read_to_string(root.join(".mine/vault-id"))
        .map(|s| s.trim().to_string())
        .map_err(|_| {
            CliError::space(format!(
                "{} has no .mine/vault-id — not an initialized space",
                root.display()
            ))
        })?;
    let derived = env.app_data_dir.join("vaults").join(vault_id);
    Ok(VaultLayout::with_derived_root(root, derived))
}

struct CliError {
    code: i32,
    message: String,
}

impl CliError {
    fn usage(message: String) -> Self {
        Self { code: EXIT_USAGE, message }
    }
    fn space(message: String) -> Self {
        Self { code: EXIT_SPACE, message }
    }
    fn not_found(message: String) -> Self {
        Self { code: EXIT_NOT_FOUND, message }
    }
    fn internal(message: String) -> Self {
        // Internal errors are space-class: the caller can do nothing finer.
        Self { code: EXIT_SPACE, message }
    }
}

/// Parsed common flags; whatever remains is positional.
struct Flags {
    space: Option<String>,
    limit: usize,
    offset: usize,
    collection: Option<String>,
    json: bool,
    dry_run: bool,
    allow_media_changes: bool,
    from_file: Option<String>,
    positional: Vec<String>,
}

fn parse_flags(args: &[String]) -> Result<Flags, CliError> {
    let mut flags = Flags {
        space: None,
        limit: 20,
        offset: 0,
        collection: None,
        json: false,
        dry_run: false,
        allow_media_changes: false,
        from_file: None,
        positional: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let mut take_value = |name: &str| -> Result<String, CliError> {
            i += 1;
            args.get(i)
                .cloned()
                .ok_or_else(|| CliError::usage(format!("{name} needs a value")))
        };
        match arg.as_str() {
            "--space" => flags.space = Some(take_value("--space")?),
            "--limit" => {
                flags.limit = take_value("--limit")?
                    .parse()
                    .map_err(|_| CliError::usage("--limit needs a number".into()))?;
            }
            "--offset" => {
                flags.offset = take_value("--offset")?
                    .parse()
                    .map_err(|_| CliError::usage("--offset needs a number".into()))?;
            }
            "--collection" => flags.collection = Some(take_value("--collection")?),
            "--json" => flags.json = true,
            "--dry-run" => flags.dry_run = true,
            "--allow-media-changes" => flags.allow_media_changes = true,
            "--from" => flags.from_file = Some(take_value("--from")?),
            other if other.starts_with("--") => {
                return Err(CliError::usage(format!("unknown flag {other}")));
            }
            _ => flags.positional.push(arg.clone()),
        }
        i += 1;
    }
    Ok(flags)
}

pub struct CliOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run one CLI invocation. Pure with respect to the process: no exit, no
/// global state — the binary prints and exits with what this returns.
pub fn run(env: &CliEnv, args: &[String]) -> CliOutput {
    match run_inner(env, args) {
        Ok(stdout) => CliOutput { code: EXIT_OK, stdout, stderr: String::new() },
        Err(e) => CliOutput { code: e.code, stdout: String::new(), stderr: format!("{}\n", e.message) },
    }
}

const USAGE: &str = "mine — read access to Mine spaces\n\n\
  mine spaces [--json]\n\
  mine search <query> [--space P] [--limit N] [--json]\n\
  mine collections [--space P] [--json]\n\
  mine cards --collection C [--space P] [--limit N] [--offset K] [--json]\n\
  mine card <slug> [--space P] [--json]\n\
  mine card body <slug>\n\
  mine card set <slug> <field> <value> [--dry-run]   (title|description|url|author|source)\n\
  mine card unset <slug> <field> [--dry-run]\n\
  mine card set-body <slug> [--from FILE] [--allow-media-changes] [--dry-run]\n\
  mine connect <slug> <collection> [--dry-run]\n\
  mine disconnect <slug> <collection> [--dry-run]\n\
  mine restore <slug>\n";

fn run_inner(env: &CliEnv, args: &[String]) -> Result<String, CliError> {
    let Some((command, rest)) = args.split_first() else {
        return Err(CliError::usage(USAGE.to_string()));
    };
    let flags = parse_flags(rest)?;
    match command.as_str() {
        "spaces" => cmd_spaces(env, &flags),
        "search" => cmd_search(env, &flags),
        "collections" => cmd_collections(env, &flags),
        "cards" => cmd_cards(env, &flags),
        "card" => match flags.positional.first().map(String::as_str) {
            Some("body") => cmd_card_body(env, &flags),
            Some("set") => cmd_card_set(env, &flags, true),
            Some("unset") => cmd_card_set(env, &flags, false),
            Some("set-body") => cmd_card_set_body(env, &flags),
            _ => cmd_card(env, &flags),
        },
        "connect" => cmd_membership(env, &flags, true),
        "disconnect" => cmd_membership(env, &flags, false),
        "restore" => cmd_restore(env, &flags),
        other => Err(CliError::usage(format!("unknown command {other}\n\n{USAGE}"))),
    }
}

fn open_index(vault: &VaultLayout) -> Result<rusqlite::Connection, CliError> {
    let path = vault.index_db_path();
    if !path.is_file() {
        return Err(CliError::space(format!(
            "no index at {} — open the space in Mine once to build it",
            path.display()
        )));
    }
    db::open_read_only(&path).map_err(|e| CliError::internal(format!("open index: {e:#}")))
}

fn cmd_spaces(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let config = load_space_config(env);
    if flags.json {
        let spaces: Vec<_> = config
            .known
            .iter()
            .map(|path| {
                json!({
                    "path": path,
                    "active": Some(path) == config.active.as_ref(),
                })
            })
            .collect();
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "spaces": spaces })
        ));
    }
    let mut out = String::new();
    for path in &config.known {
        let marker = if Some(path) == config.active.as_ref() { "* " } else { "  " };
        out.push_str(&format!("{marker}{}\n", path.display()));
    }
    if out.is_empty() {
        out.push_str("no known spaces\n");
    }
    Ok(out)
}

fn cmd_search(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let query = flags.positional.join(" ");
    if query.trim().is_empty() {
        return Err(CliError::usage("search needs a query".into()));
    }
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index(&vault)?;
    let (blocks, has_more) =
        search_engine::search_grid_blocks_read_only(&conn, None, flags.offset, flags.limit, &query)
            .map_err(|e| CliError::internal(format!("search: {e:#}")))?;
    // The embedding model is warmed inside the app process; a cold CLI process
    // runs the lexical half only. Said out loud per the honest-degrade rule.
    let semantic = false;
    if flags.json {
        let rows: Vec<_> = blocks.iter().map(light_block_json).collect();
        return Ok(format!(
            "{}\n",
            json!({
                "contract": CONTRACT_VERSION,
                "query": query,
                "semantic": semantic,
                "has_more": has_more,
                "results": rows,
            })
        ));
    }
    let mut out = String::new();
    for block in &blocks {
        out.push_str(&format!(
            "{}\t{}\n",
            block.slug,
            block.display_title.as_deref().unwrap_or(&block.fallback_label),
        ));
    }
    if blocks.is_empty() {
        out.push_str("nothing found (lexical search; semantic runs inside the app)\n");
    }
    Ok(out)
}

fn cmd_collections(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index(&vault)?;
    let tags = block_queries::get_all_tags(&conn)
        .map_err(|e| CliError::internal(format!("collections: {e:#}")))?;
    if flags.json {
        let rows: Vec<_> = tags
            .iter()
            .map(|t| json!({ "name": t.tag, "count": t.count }))
            .collect();
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "collections": rows })
        ));
    }
    let mut out = String::new();
    for tag in &tags {
        out.push_str(&format!("{}\t{}\n", tag.tag, tag.count));
    }
    if out.is_empty() {
        out.push_str("no collections\n");
    }
    Ok(out)
}

fn cmd_cards(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(ref collection) = flags.collection else {
        return Err(CliError::usage("cards needs --collection".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index(&vault)?;
    let (blocks, has_more) =
        block_queries::list_grid_blocks(&conn, Some(collection), flags.offset, flags.limit)
            .map_err(|e| CliError::internal(format!("cards: {e:#}")))?;
    if flags.json {
        let rows: Vec<_> = blocks.iter().map(light_block_json).collect();
        return Ok(format!(
            "{}\n",
            json!({
                "contract": CONTRACT_VERSION,
                "collection": collection,
                "has_more": has_more,
                "cards": rows,
            })
        ));
    }
    let mut out = String::new();
    for block in &blocks {
        out.push_str(&format!(
            "{}\t{}\n",
            block.slug,
            block.display_title.as_deref().unwrap_or(&block.fallback_label),
        ));
    }
    if blocks.is_empty() {
        out.push_str("no cards in this collection\n");
    }
    Ok(out)
}

fn cmd_card(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.first() else {
        return Err(CliError::usage("card needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index(&vault)?;
    let Some(block) = block_queries::get_block(&conn, slug)
        .map_err(|e| CliError::internal(format!("card: {e:#}")))?
    else {
        return Err(CliError::not_found(format!("no card {slug}")));
    };

    // Media: absolute paths, resolved the same way the app resolves them.
    let mut media: Vec<PathBuf> = Vec::new();
    if let Some(ref file) = block.media_file {
        if let Some(path) = media_refs::resolve_indexed_media(&vault, slug, file) {
            media.push(path);
        }
    }
    for reference in crate::domain::block::iter_inline_media_sources(&block.body) {
        if let Some(path) = media_refs::resolve_indexed_media(&vault, slug, &reference) {
            if !media.contains(&path) {
                media.push(path);
            }
        }
    }

    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({
                "contract": CONTRACT_VERSION,
                "slug": block.slug,
                "title": block.display_title,
                "url": block.url,
                "author": block.author,
                "saved_at": block.saved_at,
                // Derived, not stored: how the card presents (decision 044).
                "card_kind": { "value": block.card_kind.as_str(), "derived": true },
                "collections": block.tags,
                "body": block.body,
                "media": media,
                "source_path": vault.block_path(&block.slug),
            })
        ));
    }
    let mut out = String::new();
    out.push_str(&format!("slug: {}\n", block.slug));
    if let Some(ref title) = block.display_title {
        out.push_str(&format!("title: {title}\n"));
    }
    if let Some(ref url) = block.url {
        out.push_str(&format!("url: {url}\n"));
    }
    out.push_str(&format!("saved_at: {}\n", block.saved_at));
    if !block.tags.is_empty() {
        out.push_str(&format!("collections: {}\n", block.tags.join(", ")));
    }
    for path in &media {
        out.push_str(&format!("media: {}\n", path.display()));
    }
    out.push_str(&format!("path: {}\n", vault.block_path(&block.slug).display()));
    if !block.body.trim().is_empty() {
        out.push_str("\n");
        out.push_str(&block.body);
        if !block.body.ends_with('\n') {
            out.push('\n');
        }
    }
    Ok(out)
}

impl From<MutationError> for CliError {
    fn from(e: MutationError) -> Self {
        let message = e.message().to_string();
        match e {
            MutationError::Usage(_) => CliError::usage(message),
            MutationError::NotFound(_) => CliError::not_found(message),
            MutationError::Refused(_) => CliError { code: EXIT_USAGE, message },
            MutationError::Internal(_) => CliError::internal(message),
        }
    }
}

fn mutation_report(outcome: cli_mutations::MutationOutcome, json: bool) -> String {
    if json {
        format!(
            "{}\n",
            json!({
                "contract": CONTRACT_VERSION,
                "applied": !outcome.dry_run,
                "summary": outcome.summary,
            })
        )
    } else {
        format!("{}\n", outcome.summary)
    }
}

fn cmd_card_body(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.get(1) else {
        return Err(CliError::usage("card body needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let path = vault.block_path(slug);
    let content = std::fs::read_to_string(&path)
        .map_err(|_| CliError::not_found(format!("no card {slug}")))?;
    let body = match content.strip_prefix("---\n").and_then(|rest| rest.find("\n---").map(|i| i + 4)) {
        Some(close) => {
            let after = &content[4 + close..];
            after.split_once('\n').map(|(_, b)| b).unwrap_or("").to_string()
        }
        None => content,
    };
    Ok(body)
}

fn cmd_card_set(env: &CliEnv, flags: &Flags, set: bool) -> Result<String, CliError> {
    let (Some(slug), Some(field)) = (flags.positional.get(1), flags.positional.get(2)) else {
        return Err(CliError::usage("card set/unset needs <slug> <field>".into()));
    };
    let value = if set {
        Some(
            flags
                .positional
                .get(3)
                .ok_or_else(|| CliError::usage("card set needs a value".into()))?
                .as_str(),
        )
    } else {
        None
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let outcome = cli_mutations::set_field(&vault, slug, field, value, flags.dry_run)?;
    Ok(mutation_report(outcome, flags.json))
}

fn cmd_card_set_body(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.get(1) else {
        return Err(CliError::usage("card set-body needs a slug".into()));
    };
    let new_body = match flags.from_file.as_deref() {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| CliError::usage(format!("cannot read {path}: {e}")))?,
        None => {
            use std::io::Read;
            let mut buffer = String::new();
            std::io::stdin()
                .read_to_string(&mut buffer)
                .map_err(|e| CliError::usage(format!("stdin: {e}")))?;
            buffer
        }
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let outcome = cli_mutations::set_body(
        &vault,
        slug,
        &new_body,
        flags.allow_media_changes,
        flags.dry_run,
    )?;
    Ok(mutation_report(outcome, flags.json))
}

fn cmd_membership(env: &CliEnv, flags: &Flags, connected: bool) -> Result<String, CliError> {
    let (Some(slug), Some(collection)) = (flags.positional.first(), flags.positional.get(1)) else {
        return Err(CliError::usage("connect/disconnect needs <slug> <collection>".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let outcome = cli_mutations::set_collection_membership(
        &vault,
        slug,
        collection,
        connected,
        flags.dry_run,
    )?;
    Ok(mutation_report(outcome, flags.json))
}

fn cmd_restore(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.first() else {
        return Err(CliError::usage("restore needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let outcome = cli_mutations::restore(&vault, slug)?;
    Ok(mutation_report(outcome, flags.json))
}

fn light_block_json(block: &crate::storage::index::LightBlock) -> serde_json::Value {
    json!({
        "slug": block.slug,
        "title": block.display_title,
        "url": block.url,
        "saved_at": block.saved_at,
        // Derived, not stored: how the card presents (decision 044).
        "card_kind": { "value": block.card_kind.as_str(), "derived": true },
    })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::domain::block::parse_markdown_document;
    use crate::domain::block::DateTime;

    /// A disposable app-data dir + one initialized space with two cards.
    pub(crate) fn fixture() -> (tempfile::TempDir, CliEnv, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let vault_root = dir.path().join("Space");
        std::fs::create_dir_all(vault_root.join(".mine")).unwrap();
        std::fs::create_dir_all(vault_root.join("Cards")).unwrap();
        std::fs::write(vault_root.join(".mine/vault-id"), "testspace").unwrap();

        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(
            app_data.join("config.json"),
            serde_json::to_string(&json!({
                "vault_path": vault_root,
                "known_vaults": [vault_root],
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            vault_root.join("Cards/sunset.md"),
            "---\nsaved_at: 2026-01-01T00:00:00Z\nMine Collections:\n  - \"[[Nature]]\"\n---\nA sunset over the bay.",
        )
        .unwrap();
        std::fs::write(
            vault_root.join("Cards/plain.md"),
            "---\nsaved_at: 2026-01-02T00:00:00Z\n---\nNotes about typography.",
        )
        .unwrap();

        let derived = app_data.join("vaults/testspace");
        std::fs::create_dir_all(&derived).unwrap();
        let vault = VaultLayout::with_derived_root(vault_root.clone(), derived);
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        for slug in ["Cards/sunset", "Cards/plain"] {
            let content =
                std::fs::read_to_string(vault_root.join(format!("{slug}.md"))).unwrap();
            let parsed = parse_markdown_document(
                slug,
                &content,
                DateTime::new("2026-01-01T00:00:00Z").unwrap(),
            )
            .unwrap();
            crate::storage::index::upsert_block(&conn, &parsed.block, None).unwrap();
        }
        drop(conn);

        (dir, CliEnv { app_data_dir: app_data }, vault_root)
    }

    pub(crate) fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn lists_spaces_with_the_active_marked() {
        let (_dir, env, root) = fixture();
        let out = run(&env, &args(&["spaces"]));
        assert_eq!(out.code, EXIT_OK);
        assert!(out.stdout.contains(&format!("* {}", root.display())));
    }

    #[test]
    fn refuses_a_space_outside_the_known_list() {
        // The CLI must not wander the file system: unknown paths are refused,
        // not opened.
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["collections", "--space", "/tmp/elsewhere"]));
        assert_eq!(out.code, EXIT_SPACE);
        assert!(out.stderr.contains("not a known space"));
    }

    #[test]
    fn lists_collections_with_counts() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["collections", "--json"]));
        assert_eq!(out.code, EXIT_OK);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["contract"], 1);
        assert_eq!(value["collections"][0]["name"], "Nature");
        assert_eq!(value["collections"][0]["count"], 1);
    }

    #[test]
    fn lists_cards_of_a_collection() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["cards", "--collection", "Nature"]));
        assert_eq!(out.code, EXIT_OK);
        assert!(out.stdout.contains("Cards/sunset"));
        assert!(!out.stdout.contains("Cards/plain"));
    }

    #[test]
    fn returns_a_card_with_body_and_derived_kind() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["card", "Cards/sunset", "--json"]));
        assert_eq!(out.code, EXIT_OK);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["body"], "A sunset over the bay.");
        assert_eq!(value["card_kind"]["derived"], true);
        assert_eq!(value["card_kind"]["value"], "article");
        // No `type` anywhere: the taxonomy is gone (decision 044).
        assert!(!out.stdout.contains("\"type\""));
    }

    #[test]
    fn reports_a_missing_card_as_not_found() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["card", "Cards/absent"]));
        assert_eq!(out.code, EXIT_NOT_FOUND);
    }

    #[test]
    fn finds_by_lexical_search_and_says_semantic_was_off() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["search", "typography", "--json"]));
        assert_eq!(out.code, EXIT_OK);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["semantic"], false);
        assert_eq!(value["results"][0]["slug"], "Cards/plain");
    }

    #[test]
    fn never_writes_to_the_index() {
        // The whole read layer's contract in one assertion: the index file is
        // byte-identical after every command.
        let (_dir, env, root) = fixture();
        let db_path = env.app_data_dir.join("vaults/testspace/index.db");
        let before = std::fs::read(&db_path).unwrap();
        for command in [
            args(&["spaces"]),
            args(&["collections"]),
            args(&["cards", "--collection", "Nature"]),
            args(&["card", "Cards/sunset"]),
            args(&["search", "sunset"]),
        ] {
            let out = run(&env, &command);
            assert_eq!(out.code, EXIT_OK, "command failed: {:?}", command);
        }
        let after = std::fs::read(&db_path).unwrap();
        assert_eq!(before, after, "a read command changed the index");
        let _ = root;
    }
}

#[cfg(test)]
mod mutation_tests {
    use super::tests::*;
    use super::*;

    fn card_content(root: &std::path::Path, slug: &str) -> String {
        std::fs::read_to_string(root.join(format!("{slug}.md"))).unwrap()
    }

    #[test]
    fn sets_and_unsets_a_known_field_surgically() {
        let (_dir, env, root) = fixture();
        let before = card_content(&root, "Cards/sunset");

        let out = run(&env, &args(&["card", "set", "Cards/sunset", "title", "Evening: light"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let after = card_content(&root, "Cards/sunset");
        // The colon forces quoting; everything else is byte-identical.
        assert!(after.contains("title: \"Evening: light\""));
        assert_eq!(after.replace("title: \"Evening: light\"\n", ""), before);

        let out = run(&env, &args(&["card", "unset", "Cards/sunset", "title"]));
        assert_eq!(out.code, EXIT_OK);
        assert_eq!(card_content(&root, "Cards/sunset"), before);
    }

    #[test]
    fn refuses_unknown_and_managed_fields() {
        let (_dir, env, _root) = fixture();
        for field in ["type", "saved_at", "file", "Mine Collections", "custom"] {
            let out = run(&env, &args(&["card", "set", "Cards/sunset", field, "x"]));
            assert_eq!(out.code, EXIT_USAGE, "{field} must be refused");
        }
    }

    #[test]
    fn set_body_keeps_front_matter_and_guards_embeds() {
        let (_dir, env, root) = fixture();
        std::fs::write(
            root.join("Cards/gallery.md"),
            "---\nsaved_at: 2026-01-03T00:00:00Z\n---\nA line.\n\n![[a.jpg]]\n",
        )
        .unwrap();

        // Losing the embed is refused…
        let out = run(&env, &args(&["card", "set-body", "Cards/gallery", "--from", "/dev/null"]));
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stderr.contains("a.jpg"));

        // …a rewrite that keeps it goes through, front matter untouched.
        let body = root.join("new-body.md");
        std::fs::write(&body, "Перевод строки.\n\n![[a.jpg]]\n").unwrap();
        let out = run(&env, &args(&[
            "card", "set-body", "Cards/gallery", "--from", body.to_str().unwrap(),
        ]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let after = card_content(&root, "Cards/gallery");
        assert!(after.starts_with("---\nsaved_at: 2026-01-03T00:00:00Z\n---\n"));
        assert!(after.contains("Перевод строки."));
        assert!(after.contains("![[a.jpg]]"));
    }

    #[test]
    fn dry_run_changes_nothing() {
        let (_dir, env, root) = fixture();
        let before = card_content(&root, "Cards/sunset");
        let out = run(&env, &args(&["card", "set", "Cards/sunset", "title", "X", "--dry-run"]));
        assert_eq!(out.code, EXIT_OK);
        assert!(out.stdout.contains("would apply"));
        assert_eq!(card_content(&root, "Cards/sunset"), before);
    }

    #[test]
    fn connect_disconnect_and_restore_round_trip() {
        let (_dir, env, root) = fixture();
        let before = card_content(&root, "Cards/plain");

        let out = run(&env, &args(&["connect", "Cards/plain", "Nature"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let connected = card_content(&root, "Cards/plain");
        assert!(connected.contains("Mine Collections"));
        assert!(connected.contains("[[Nature]]"));

        let out = run(&env, &args(&["restore", "Cards/plain"]));
        assert_eq!(out.code, EXIT_OK);
        assert_eq!(card_content(&root, "Cards/plain"), before);

        // The swap keeps one level in the other direction too.
        let out = run(&env, &args(&["restore", "Cards/plain"]));
        assert_eq!(out.code, EXIT_OK);
        assert_eq!(card_content(&root, "Cards/plain"), connected);
    }

    #[test]
    fn refuses_field_edits_on_a_foreign_note() {
        // A note without front matter keeps its shape: the CLI does not
        // invent metadata blocks inside other people's files.
        let (_dir, env, root) = fixture();
        std::fs::write(root.join("Cards/foreign.md"), "Just an Obsidian note.\n").unwrap();
        let out = run(&env, &args(&["card", "set", "Cards/foreign", "title", "X"]));
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stderr.contains("no front matter"));
    }
}
