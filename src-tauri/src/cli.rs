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
use crate::domain::block::{Block, DateTime, Frontmatter};
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
    title: Option<String>,
    url: Option<String>,
    file: Option<String>,
    delete_unused_media: bool,
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
        title: None,
        url: None,
        file: None,
        delete_unused_media: false,
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
            "--title" => flags.title = Some(take_value("--title")?),
            "--url" => flags.url = Some(take_value("--url")?),
            "--file" => flags.file = Some(take_value("--file")?),
            "--delete-unused-media" => flags.delete_unused_media = true,
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
  mine restore <slug>\n\
  mine card create [--title T] [--url U] [--collection C] [--file PATH] [--from BODYFILE]\n\
  mine card rename <slug> <new-name>\n\
  mine card delete <slug> [--delete-unused-media] [--dry-run]\n\
  mine merge <slug> <slug> [...]\n\
  mine collection create <name>\n\
  mine collection rename <old> <new>\n\
  mine collection delete <name>\n";

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
            Some("create") => cmd_card_create(env, &flags),
            Some("rename") => cmd_card_rename(env, &flags),
            Some("delete") => cmd_card_delete(env, &flags),
            _ => cmd_card(env, &flags),
        },
        "merge" => cmd_merge(env, &flags),
        "collection" => match flags.positional.first().map(String::as_str) {
            Some("create") => cmd_collection_create(env, &flags),
            Some("rename") => cmd_collection_rename(env, &flags),
            Some("delete") => cmd_collection_delete(env, &flags),
            _ => Err(CliError::usage(
                "collection needs a subcommand: create, rename, delete".into(),
            )),
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
        out.push('\n');
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
    if !outcome.dry_run {
        reindex_card(&vault, slug);
    }
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
    if !outcome.dry_run {
        reindex_card(&vault, slug);
    }
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
    if !outcome.dry_run {
        reindex_card(&vault, slug);
    }
    Ok(mutation_report(outcome, flags.json))
}

fn cmd_restore(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.first() else {
        return Err(CliError::usage("restore needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let outcome = cli_mutations::restore(&vault, slug)?;
    if !outcome.dry_run {
        reindex_card(&vault, slug);
    }
    Ok(mutation_report(outcome, flags.json))
}

/// Re-index one card after an applied file mutation, so structural commands
/// (collection rename, merge) in the same CLI session see fresh membership.
/// Best effort: the app's watcher re-indexes the file anyway.
fn reindex_card(vault: &VaultLayout, slug: &str) {
    let path = vault.block_path(slug);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let saved_at = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(crate::util::system_time_to_iso8601)
        .and_then(|iso| crate::domain::block::DateTime::new(&iso).ok())
        .unwrap_or_else(|| crate::domain::block::DateTime::new("1970-01-01T00:00:00Z").unwrap());
    let Ok(parsed) = crate::domain::block::parse_markdown_document(slug, &content, saved_at)
    else {
        return;
    };
    let Ok(conn) = db::open_or_create(&vault.index_db_path()) else {
        return;
    };
    let _ = crate::storage::index::upsert_block(&conn, &parsed.block, Some(vault.root()));
}

fn open_index_rw(vault: &VaultLayout) -> Result<rusqlite::Connection, CliError> {
    let path = vault.index_db_path();
    if !path.is_file() {
        return Err(CliError::space(format!(
            "no index at {} — open the space in Mine once to build it",
            path.display()
        )));
    }
    db::open_or_create(&path).map_err(|e| CliError::internal(format!("open index: {e:#}")))
}

fn cmd_card_create(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let body = match flags.from_file.as_deref() {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| CliError::usage(format!("cannot read {path}: {e}")))?,
        None => String::new(),
    };
    if flags.title.is_none() && flags.url.is_none() && flags.file.is_none() && body.trim().is_empty()
    {
        return Err(CliError::usage(
            "card create needs at least one of --title, --url, --file, --from".into(),
        ));
    }
    let media_ext = flags.file.as_deref().and_then(|f| {
        std::path::Path::new(f)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_string)
    });
    if let Some(ref f) = flags.file {
        if !std::path::Path::new(f).is_file() {
            return Err(CliError::usage(format!("--file {f}: no such file")));
        }
    }
    let raw = crate::domain::block::suggest_slug(flags.title.as_deref(), flags.url.as_deref());
    let name = crate::commands::blocks::resolve_unique_block_slug(
        &conn,
        &vault,
        &raw,
        media_ext.as_deref(),
    )
    .map_err(|e| CliError::internal(format!("slug: {e:#}")))?;
    let media_file = media_ext.as_ref().map(|ext| format!("{name}.{ext}"));
    let slug = vault.new_card_slug(&name);
    let now = crate::commands::state::now_iso8601();
    let tags = flags
        .collection
        .as_deref()
        .map(|c| vec![crate::domain::collection::normalize_collection_ref(c)])
        .unwrap_or_default();
    let mut block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: crate::domain::block::BlockType::Article,
            title: flags.title.clone(),
            description: None,
            url: flags.url.clone(),
            file: media_file,
            thumbnail: None,
            tags,
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new(&now)
                .map_err(|e| CliError::internal(e.to_string()))?,
            source: Some("mine-cli".to_string()),
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body,
    };
    block.frontmatter.block_type =
        crate::domain::block::derive_block_type(&block.frontmatter, &block.body);
    let source = flags.file.as_deref().map(std::path::Path::new);
    let indexed = crate::storage::files::persist_new_block(&conn, &vault, &block, source)
        .map_err(|e| CliError::internal(format!("create: {e:#}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "created": indexed.slug })
        ));
    }
    Ok(format!("created {}\n", indexed.slug))
}

fn cmd_card_rename(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let (Some(slug), Some(new_name)) = (flags.positional.get(1), flags.positional.get(2)) else {
        return Err(CliError::usage("card rename needs <slug> <new-name>".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let result = crate::commands::blocks::rename_block_file_inner(
        None, None, &conn, &vault, slug, new_name,
    )
    .map_err(|e| CliError::internal(format!("rename: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "renamed": slug, "to": result.new_slug })
        ));
    }
    Ok(format!("renamed {slug} -> {}\n", result.new_slug))
}

fn cmd_card_delete(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.get(1) else {
        return Err(CliError::usage("card delete needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let plan = crate::commands::blocks::build_delete_block_plan(&conn, &vault, slug)
        .map_err(|e| CliError::not_found(format!("delete plan: {e:?}")))?;
    if flags.dry_run {
        let unused: Vec<_> = plan.unused_media.iter().map(|m| m.file_name.clone()).collect();
        let shared: Vec<_> = plan.shared_media.iter().map(|m| m.file_name.clone()).collect();
        if flags.json {
            return Ok(format!(
                "{}\n",
                json!({
                    "contract": CONTRACT_VERSION,
                    "applied": false,
                    "would_delete": slug,
                    "unused_media": unused,
                    "shared_media": shared,
                    "delete_unused_media": flags.delete_unused_media,
                })
            ));
        }
        return Ok(format!(
            "would delete {slug}; unused media: {}; shared media: {}\n",
            if unused.is_empty() { "none".to_string() } else { unused.join(", ") },
            if shared.is_empty() { "none".to_string() } else { shared.join(", ") },
        ));
    }
    // The card file is backed up before the transactional delete runs, so
    // `mine restore` can bring the text back even after a deletion.
    let path = vault.block_path(slug);
    if let Ok(content) = std::fs::read_to_string(&path) {
        let backup = vault.derived_root().join("cli-backups").join(format!("{slug}.md"));
        if let Some(parent) = backup.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&backup, content);
    }
    let deleted = crate::commands::blocks::delete_block_inner(
        None,
        &conn,
        &vault,
        slug,
        Some(flags.delete_unused_media),
    )
    .map_err(|e| CliError::internal(format!("delete: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "deleted": deleted, "slug": slug })
        ));
    }
    Ok(format!("deleted {slug}\n"))
}

fn cmd_merge(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    if flags.positional.len() < 2 {
        return Err(CliError::usage("merge needs at least two slugs".into()));
    }
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let mutation = crate::commands::blocks::merge_blocks_inner(
        None,
        &conn,
        &vault,
        flags.positional.clone(),
    )
    .map_err(|e| CliError::internal(format!("merge: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({
                "contract": CONTRACT_VERSION,
                "merged": mutation.result.merged_slug,
                "removed": mutation.result.removed_slugs,
            })
        ));
    }
    Ok(format!("merged into {}\n", mutation.result.merged_slug))
}

fn cmd_collection_create(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(name) = flags.positional.get(1) else {
        return Err(CliError::usage("collection create needs a name".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let dto = crate::commands::channels::create_channel_inner(&conn, &vault, name)
        .map_err(|e| CliError::internal(format!("collection create: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "created": dto.tag })
        ));
    }
    Ok(format!("created collection {}\n", dto.tag))
}

fn cmd_collection_rename(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let (Some(old), Some(new)) = (flags.positional.get(1), flags.positional.get(2)) else {
        return Err(CliError::usage("collection rename needs <old> <new>".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let dto = crate::commands::channels::rename_channel_inner(None, &conn, &vault, old, new)
        .map_err(|e| CliError::internal(format!("collection rename: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "renamed": old, "to": dto.tag })
        ));
    }
    Ok(format!("renamed collection {old} -> {}\n", dto.tag))
}

fn cmd_collection_delete(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(name) = flags.positional.get(1) else {
        return Err(CliError::usage("collection delete needs a name".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let deleted = crate::commands::channels::delete_channel_inner(&conn, &vault, name)
        .map_err(|e| CliError::internal(format!("collection delete: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({ "contract": CONTRACT_VERSION, "deleted": deleted, "collection": name })
        ));
    }
    Ok(format!("deleted collection {name}\n"))
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
    fn creates_a_card_without_a_type_field() {
        let (dir, env, root) = fixture();
        let body = dir.path().join("body.md");
        std::fs::write(&body, "Первый абзац.\n").unwrap();
        let out = run(&env, &args(&[
            "card", "create", "--title", "Fresh Note", "--from", body.to_str().unwrap(),
        ]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        // The fixture has no layout.json, so new cards land in the vault root.
        let content = card_content(&root, "Fresh Note");
        assert!(content.starts_with("---\n"), "front matter present");
        assert!(!content.contains("type:"), "044: no type field on cards");
        assert!(content.contains("saved_at:"));
        assert!(content.contains("Первый абзац."));
        // The new card is visible to the read side immediately.
        let out = run(&env, &args(&["card", "Fresh Note", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
    }

    #[test]
    fn create_requires_some_content() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["card", "create"]));
        assert_eq!(out.code, EXIT_USAGE);
    }

    #[test]
    fn renames_a_card_on_disk_and_in_the_index() {
        let (_dir, env, root) = fixture();
        let out = run(&env, &args(&["card", "rename", "Cards/plain", "Typography Notes"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Cards/plain.md").exists());
        assert!(root.join("Cards/Typography Notes.md").exists());
        let out = run(&env, &args(&["card", "Cards/Typography Notes"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
    }

    #[test]
    fn delete_dry_run_touches_nothing_and_delete_backs_up() {
        let (_dir, env, root) = fixture();
        let before = card_content(&root, "Cards/plain");

        let out = run(&env, &args(&["card", "delete", "Cards/plain", "--dry-run"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert_eq!(card_content(&root, "Cards/plain"), before);

        let out = run(&env, &args(&["card", "delete", "Cards/plain"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Cards/plain.md").exists());
        let vault = resolve_space(&env, None).map_err(|e| e.message).unwrap();
        let backup = vault.derived_root().join("cli-backups/Cards/plain.md");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), before);
    }

    #[test]
    fn collection_lifecycle_create_rename_delete() {
        let (_dir, env, root) = fixture();
        let out = run(&env, &args(&["collection", "create", "Reading"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let page = std::fs::read_to_string(root.join("Reading.md")).unwrap();
        assert!(page.contains("type: channel"), "collection page keeps its type");

        let out = run(&env, &args(&["collection", "rename", "Reading", "Reading List"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Reading.md").exists());
        assert!(root.join("Reading List.md").exists());

        // Membership follows the rename inside card front matter.
        let out = run(&env, &args(&["connect", "Cards/plain", "Reading List"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let out = run(&env, &args(&["collection", "rename", "Reading List", "Shelf"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(card_content(&root, "Cards/plain").contains("[[Shelf]]"));

        let out = run(&env, &args(&["collection", "delete", "Shelf"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Shelf.md").exists());
    }

    #[test]
    fn merges_two_cards_into_the_first() {
        let (_dir, env, root) = fixture();
        let out = run(&env, &args(&["merge", "Cards/sunset", "Cards/plain", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let parsed: serde_json::Value = serde_json::from_str(out.stdout.trim()).unwrap();
        let merged_slug = parsed["merged"].as_str().unwrap();
        // Merge composes a new card and removes both sources.
        assert!(!root.join("Cards/sunset.md").exists());
        assert!(!root.join("Cards/plain.md").exists());
        let merged = card_content(&root, merged_slug);
        assert!(merged.contains("A sunset over the bay."));
        assert!(merged.contains("Notes about typography."));
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
