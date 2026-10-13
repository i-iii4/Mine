//! The `mine` command-line interface — AI and human access to the vault.
//!
//! Reads open the index read-only, without watchers or reconciliation. Mutations
//! keep the known-space guard and delegate to shared capture or native source
//! transactions; field/body patches retain their surgical backup semantics.
//!
//! Lives in the library so the commands are testable against a fixture vault;
//! the `mine-cli` binary is a thin `main` around [`run`].

use std::path::PathBuf;

use serde_json::json;

use crate::cli_mutations::{self, MutationError};
#[cfg(test)]
use crate::domain::block::DateTime;
use crate::domain::vault::VaultLayout;
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
    /// The space an MCP process acts on when a call names none: the app's
    /// current space at the first such call, kept for the life of the
    /// process (SPEC_TABS.md, В75).
    pub pinned_space: std::sync::OnceLock<Option<String>>,
}

impl CliEnv {
    pub fn from_system() -> Option<Self> {
        let home = std::env::var_os("HOME")?;
        Some(Self::in_dir(
            PathBuf::from(home).join("Library/Application Support/com.mine.app"),
        ))
    }

    /// An environment reading the app's data in `app_data_dir`.
    pub fn in_dir(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            pinned_space: std::sync::OnceLock::new(),
        }
    }

    /// A line saying this program is another build than the Mine app, when it
    /// is (SPEC_DEEP_AUDIT.md, Е2.22): an old CLI keeps working after the app
    /// changed and gives answers the app would not.
    pub fn build_warning(&self) -> Option<String> {
        let app = crate::runtime_protocol::recorded_app_build(&self.app_data_dir);
        crate::runtime_protocol::build_mismatch_warning(
            &crate::runtime_protocol::BuildIdentity::this_build(),
            app.as_ref(),
        )
    }

    /// The space a call that names none acts on, pinned at first use.
    pub fn default_space(&self) -> Option<String> {
        self.pinned_space
            .get_or_init(|| {
                load_space_config(self)
                    .active
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .clone()
    }
}

struct SpaceConfig {
    active: Option<PathBuf>,
    known: Vec<PathBuf>,
}

fn load_space_config(env: &CliEnv) -> SpaceConfig {
    // Read through the settings' one owner (SPEC_VAULT_LIFECYCLE.md, П28);
    // unreadable settings list no space rather than a guessed one.
    let settings = crate::app_config::AppConfig::in_dir(&env.app_data_dir)
        .read()
        .unwrap_or_default();
    let active = crate::space_registry::current_path(&settings).map(PathBuf::from);
    let mut known: Vec<PathBuf> = crate::space_registry::records(&settings)
        .into_iter()
        .map(|record| PathBuf::from(record.path))
        .collect();
    if let Some(ref active) = active {
        if !known.contains(active) {
            known.insert(0, active.clone());
        }
    }
    SpaceConfig { active, known }
}

/// A space the CLI may read: the app's active vault or one of the known ones.
/// Anything else is refused — the CLI must not wander the file system.
pub(crate) fn resolve_space(
    env: &CliEnv,
    requested: Option<&str>,
) -> Result<VaultLayout, CliError> {
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
    let vault = VaultLayout::with_derived_root(root, derived);
    let layout = crate::storage::files::load_vault_write_layout(&vault)
        .map_err(|error| CliError::space(format!("invalid write layout: {error:#}")))?;
    let vault = vault.with_write_layout(layout);
    // The index generation Mine selected, looked up without creating,
    // migrating or recovering anything: the index belongs to the app
    // (SPEC_AI_ACCESS.md, «Read-only гарантия»; SPEC_DEEP_AUDIT.md, Е2.21).
    // A space without one keeps the layout's own path, and opening it says
    // the space needs Mine first.
    match db::existing_selected_index(&vault) {
        Ok(Some(selected)) => Ok(selected),
        Ok(None) => Ok(vault),
        Err(error) => Err(CliError::space(format!("index of {}: {error:#}", vault.root().display()))),
    }
}

/// What a read says when the space has no index it can read.
fn index_not_built(vault: &VaultLayout) -> CliError {
    CliError::space(format!(
        "the index of {} is not built yet; open the space in Mine to build it",
        vault.root().display()
    ))
}

pub(crate) struct CliError {
    pub(crate) code: i32,
    pub(crate) message: String,
}

impl CliError {
    fn usage(message: String) -> Self {
        Self {
            code: EXIT_USAGE,
            message,
        }
    }
    fn space(message: String) -> Self {
        Self {
            code: EXIT_SPACE,
            message,
        }
    }
    fn not_found(message: String) -> Self {
        Self {
            code: EXIT_NOT_FOUND,
            message,
        }
    }
    fn internal(message: String) -> Self {
        // Internal errors are space-class: the caller can do nothing finer.
        Self {
            code: EXIT_SPACE,
            message,
        }
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
    let mut output = match run_inner(env, args) {
        Ok(stdout) => CliOutput {
            code: EXIT_OK,
            stdout,
            stderr: String::new(),
        },
        Err(e) => CliOutput {
            code: e.code,
            stdout: String::new(),
            stderr: format!("{}\n", e.message),
        },
    };
    // Stderr, so the JSON on stdout stays whole.
    if let Some(warning) = env.build_warning() {
        output.stderr = format!("{warning}\n{}", output.stderr);
    }
    output
}

/// `mine --version`: the build of this program, and of the app when it
/// recorded one (Е2.22).
fn version_text(env: &CliEnv) -> String {
    let own = crate::runtime_protocol::BuildIdentity::this_build();
    let mut text = format!("mine {} build {} commit {}\n", own.version, own.build_id, own.commit);
    if let Some(app) = crate::runtime_protocol::recorded_app_build(&env.app_data_dir) {
        text.push_str(&format!("Mine app {} build {} commit {}\n", app.version, app.build_id, app.commit));
    }
    text
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
  mine collection delete <name>\n\
  mine mcp\n\
  mine --version\n";

fn run_inner(env: &CliEnv, args: &[String]) -> Result<String, CliError> {
    let Some((command, rest)) = args.split_first() else {
        return Err(CliError::usage(USAGE.to_string()));
    };
    if command == "--version" {
        return Ok(version_text(env));
    }
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
        other => Err(CliError::usage(format!(
            "unknown command {other}\n\n{USAGE}"
        ))),
    }
}

/// Open the space's index for a read: read-only, as Mine left it. Reading
/// builds nothing and reconciles nothing (SPEC_AI_ACCESS.md, «Read-only
/// гарантия»; SPEC_DEEP_AUDIT.md, Е2.21): until 13.10.2026 a read created the
/// index of a space Mine never opened and ran a full reconciliation of one
/// still being built. An index not built, still being built or damaged is
/// said so; Mine builds and repairs it when it opens the space.
fn open_index(vault: &VaultLayout) -> Result<rusqlite::Connection, CliError> {
    if !vault.index_db_path().is_file() {
        return Err(index_not_built(vault));
    }
    let conn = db::open_read_only(&vault.index_db_path())
        .map_err(|error| CliError::internal(format!("open index: {error:#}")))?;
    match db::index_is_ready(&conn) {
        Ok(true) => Ok(conn),
        Ok(false) => Err(index_not_built(vault)),
        Err(error) if db::is_index_corruption(&error) => Err(CliError::space(format!(
            "the index of {} is damaged; open the space in Mine to rebuild it",
            vault.root().display()
        ))),
        Err(error) => Err(CliError::internal(format!("read index: {error:#}"))),
    }
}

/// One read of the index. A damaged index is said so, not rebuilt: the
/// rebuild is a write, and it belongs to the app (Е2.21).
fn read_index<T>(
    conn: &rusqlite::Connection,
    query: impl FnOnce(&rusqlite::Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    query(conn).map_err(|error| {
        if db::is_index_corruption(&error) {
            error.context("the index is damaged; open the space in Mine to rebuild it")
        } else {
            error
        }
    })
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
        let marker = if Some(path) == config.active.as_ref() {
            "* "
        } else {
            "  "
        };
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
    let (blocks, has_more) = read_index(&conn, |conn| {
        search_engine::search_grid_blocks_read_only(conn, None, flags.offset, flags.limit, &query)
    })
    .map_err(|e| CliError::internal(format!("search: {e:#}")))?;
    // The embedding model is warmed inside the app process; a cold CLI process
    // runs the lexical half only. Said out loud per the honest-degrade rule.
    let semantic = false;
    if flags.json {
        let rows: Vec<_> = blocks.iter().map(search_result_json).collect();
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
        out.push_str(&format!("{}\t{}\n", block.slug, card_file_name(&block.slug)));
    }
    if blocks.is_empty() {
        out.push_str("nothing found (lexical search; semantic runs inside the app)\n");
    }
    Ok(out)
}

/// The collections of the space with how many cards each holds: the
/// collection pages, an empty one with 0, most cards first, then by name. A
/// name cards link without a page is no collection and is not listed
/// (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1 and К9).
fn collection_counts(conn: &rusqlite::Connection) -> anyhow::Result<Vec<crate::storage::index::TagCount>> {
    let counts: std::collections::HashMap<String, usize> = block_queries::get_all_tags(conn)?
        .into_iter()
        .map(|tag| (tag.tag, tag.count))
        .collect();
    let mut collections: Vec<crate::storage::index::TagCount> = crate::storage::index::list_channels(conn)?
        .into_iter()
        .map(|channel| crate::storage::index::TagCount {
            count: counts.get(&channel.tag).copied().unwrap_or(0),
            tag: channel.tag,
        })
        .collect();
    collections.sort_by(|left, right| right.count.cmp(&left.count).then_with(|| left.tag.cmp(&right.tag)));
    Ok(collections)
}

/// Whether `collection` is a collection of the indexed space: it has a page
/// (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1).
fn collection_has_page(conn: &rusqlite::Connection, collection: &str) -> anyhow::Result<bool> {
    let collection_ref = crate::domain::collection::normalize_collection_ref(collection);
    Ok(crate::storage::index::list_channels(conn)?
        .iter()
        .any(|channel| channel.tag == collection_ref))
}

fn cmd_collections(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index(&vault)?;
    let tags = read_index(&conn, collection_counts)
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
    let listed = read_index(&conn, |conn| {
        if !collection_has_page(conn, collection)? {
            return Ok(None);
        }
        block_queries::list_grid_blocks(conn, Some(collection), flags.offset, flags.limit).map(Some)
    })
    .map_err(|e| CliError::internal(format!("cards: {e:#}")))?;
    let Some((blocks, has_more)) = listed else {
        return Err(CliError::not_found(cli_mutations::collection_not_found_message(
            &crate::domain::collection::normalize_collection_ref(collection),
        )));
    };
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
            block
                .display_title
                .as_deref()
                .unwrap_or(&block.fallback_label),
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
    let Some(block) =
        read_index(&conn, |conn| block_queries::get_block(conn, slug))
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
                "saved_at": crate::util::saved_at_with_zone(&block.saved_at),
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
    out.push_str(&format!("saved_at: {}\n", crate::util::saved_at_with_zone(&block.saved_at)));
    if !block.tags.is_empty() {
        out.push_str(&format!("collections: {}\n", block.tags.join(", ")));
    }
    for path in &media {
        out.push_str(&format!("media: {}\n", path.display()));
    }
    out.push_str(&format!(
        "path: {}\n",
        vault.block_path(&block.slug).display()
    ));
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
        let message = e.message();
        match e {
            MutationError::Usage(_) => CliError::usage(message),
            MutationError::NotFound(_) | MutationError::CollectionNotFound { .. } => {
                CliError::not_found(message)
            }
            MutationError::Refused(_) => CliError {
                code: EXIT_USAGE,
                message,
            },
            MutationError::Internal(_) => CliError::internal(message),
        }
    }
}

/// The report of a field, body or membership mutation. `index` is how the
/// index took the written note: a failure is said, not swallowed
/// (SPEC_DEEP_AUDIT.md, Н11); the file is written either way, and Mine
/// indexes it when it next reads the space.
fn mutation_report(
    outcome: cli_mutations::MutationOutcome,
    json: bool,
    index: Result<(), String>,
) -> String {
    if json {
        let mut report = json!({
            "contract": CONTRACT_VERSION,
            "applied": !outcome.dry_run,
            "summary": outcome.summary,
        });
        if let Err(error) = &index {
            report["index_error"] = json!(error);
        }
        format!("{report}\n")
    } else {
        match index {
            Ok(()) => format!("{}\n", outcome.summary),
            Err(error) => format!(
                "{}\nthe index was not updated ({error}); Mine updates it when it next reads the space\n",
                outcome.summary
            ),
        }
    }
}

/// Index the note an applied mutation wrote, or nothing for a dry run.
fn reindex_applied(vault: &VaultLayout, slug: &str, outcome: &cli_mutations::MutationOutcome) -> Result<(), String> {
    if outcome.dry_run {
        Ok(())
    } else {
        reindex_note(vault, slug)
    }
}

fn cmd_card_body(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.get(1) else {
        return Err(CliError::usage("card body needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    // The part after the closing fence the app finds; `card set-body`
    // writes exactly this part (SPEC_DEEP_AUDIT.md, Н1).
    Ok(cli_mutations::card_body(&vault, slug)?)
}

fn cmd_card_set(env: &CliEnv, flags: &Flags, set: bool) -> Result<String, CliError> {
    let (Some(slug), Some(field)) = (flags.positional.get(1), flags.positional.get(2)) else {
        return Err(CliError::usage(
            "card set/unset needs <slug> <field>".into(),
        ));
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
    let index = reindex_applied(&vault, slug, &outcome);
    Ok(mutation_report(outcome, flags.json, index))
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
    let index = reindex_applied(&vault, slug, &outcome);
    Ok(mutation_report(outcome, flags.json, index))
}

fn cmd_membership(env: &CliEnv, flags: &Flags, connected: bool) -> Result<String, CliError> {
    let (Some(slug), Some(collection)) = (flags.positional.first(), flags.positional.get(1)) else {
        return Err(CliError::usage(
            "connect/disconnect needs <slug> <collection>".into(),
        ));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    // A connect needs the collection's page, found the way `collection
    // rename` and `delete` find it (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7).
    let outcome = cli_mutations::set_collection_membership(
        &vault,
        slug,
        collection,
        connected,
        flags.dry_run,
        |collection_ref| {
            let conn = open_index(&vault).map_err(|error| {
                MutationError::Internal(format!("collection page: {}", error.message))
            })?;
            cli_mutations::require_collection_page(&conn, &vault, collection_ref)
        },
    )?;
    let index = reindex_applied(&vault, slug, &outcome);
    Ok(mutation_report(outcome, flags.json, index))
}

fn cmd_restore(env: &CliEnv, flags: &Flags) -> Result<String, CliError> {
    let Some(slug) = flags.positional.first() else {
        return Err(CliError::usage("restore needs a slug".into()));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let outcome = cli_mutations::restore(&vault, slug)?;
    let index = reindex_applied(&vault, slug, &outcome);
    Ok(mutation_report(outcome, flags.json, index))
}

/// Index one note after an applied file mutation the way the app projects a
/// written note (`reconcile::project_source_path`): a collection page as its
/// collection, a card as a card (SPEC_DEEP_AUDIT.md, Е1.6), a note gone as
/// gone. Commands later in the same CLI session see it as written; the
/// app's watcher indexes the file too.
fn reindex_note(vault: &VaultLayout, slug: &str) -> Result<(), String> {
    let path = vault.block_path(slug);
    let conn = db::open_or_create(&vault.index_db_path()).map_err(|error| format!("{error:#}"))?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if path.is_file() {
        crate::storage::reconcile::project_source_path(&transaction, vault, &path)
            .map(|_| ())
            .map_err(|error| format!("{error:#}"))?;
    } else {
        crate::storage::reconcile::remove_source_projection(&transaction, vault, slug)
            .map_err(|error| format!("{error:#}"))?;
    }
    transaction.commit().map_err(|error| error.to_string())
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
    if flags.title.is_none()
        && flags.url.is_none()
        && flags.file.is_none()
        && body.trim().is_empty()
    {
        return Err(CliError::usage(
            "card create needs at least one of --title, --url, --file, --from".into(),
        ));
    }
    let media_ext = flags.file.as_deref().map(|f| {
        std::path::Path::new(f)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string()
    });
    if let Some(ref f) = flags.file {
        if !std::path::Path::new(f).is_file() {
            return Err(CliError::usage(format!("--file {f}: no such file")));
        }
    }
    // A card created into a collection links it only when it has a page;
    // the check runs before anything is written
    // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7).
    if let Some(collection) = flags.collection.as_deref() {
        cli_mutations::require_collection_page(&conn, &vault, collection)?;
    }
    let name = crate::commands::blocks::select_capture_name(
        &conn,
        &vault,
        flags.title.as_deref(),
        flags.url.as_deref(),
    )
    .map_err(|e| CliError::internal(format!("slug: {e:#}")))?;
    let media_file = media_ext.as_ref().map(|ext| format!("{name}.{ext}"));
    let slug = vault.new_card_slug(&name);
    let now = crate::util::now_saved_at();
    let tags = flags
        .collection
        .as_deref()
        .map(|c| vec![c.to_owned()])
        .unwrap_or_default();
    let block = mine_core::save::build_capture(&mine_core::save::CaptureRequest {
        slug,
        intent: mine_core::save::CaptureIntent::Manual,
        title: flags.title.clone(),
        url: flags.url.clone(),
        file: media_file,
        tags,
        saved_at: now,
        body,
        ..Default::default()
    })
    .map_err(|error| CliError::usage(error.to_string()))?;
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
        return Err(CliError::usage(
            "card rename needs <slug> <new-name>".into(),
        ));
    };
    let vault = resolve_space(env, flags.space.as_deref())?;
    let conn = open_index_rw(&vault)?;
    let result =
        crate::commands::blocks::rename_block_file_inner(None, None, &conn, &vault, slug, new_name)
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
        let unused: Vec<_> = plan
            .unused_media
            .iter()
            .map(|m| m.file_name.clone())
            .collect();
        let shared: Vec<_> = plan
            .shared_media
            .iter()
            .map(|m| m.file_name.clone())
            .collect();
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
            if unused.is_empty() {
                "none".to_string()
            } else {
                unused.join(", ")
            },
            if shared.is_empty() {
                "none".to_string()
            } else {
                shared.join(", ")
            },
        ));
    }
    // The card file is backed up before the transactional delete runs, so
    // `mine restore` can bring the text back even after a deletion; the
    // backup records that the deletion left no file, and restore puts the
    // text back only while none took its place (SPEC_DEEP_AUDIT.md, Е1.9).
    cli_mutations::checked_slug(slug)?;
    let content = std::fs::read_to_string(vault.block_path(slug))
        .map_err(|error| CliError::internal(format!("read {slug} for its backup: {error}")))?;
    let backup = cli_mutations::CliBackup::record(&vault, slug, &content, &cli_mutations::Left::Absent)?;
    let deleted = crate::commands::blocks::delete_block_inner(
        None,
        &conn,
        &vault,
        slug,
        Some(flags.delete_unused_media), None,
    )
    .map_err(|e| CliError::internal(format!("delete: {e:?}")))?
    .removed;
    backup.keep();
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
    let mutation =
        crate::commands::blocks::merge_blocks_inner(None, &conn, &vault, flags.positional.clone())
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
        return Err(CliError::usage(
            "collection rename needs <old> <new>".into(),
        ));
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
    // One deletion with the app's: the page goes to the Trash and its link
    // comes off every card, in one mutation (SPEC_DEEP_AUDIT.md, Н2).
    let deletion = crate::commands::channels::delete_channel_inner(None, &conn, &vault, name)
        .map_err(|e| CliError::internal(format!("collection delete: {e:?}")))?;
    if flags.json {
        return Ok(format!(
            "{}\n",
            json!({
                "contract": CONTRACT_VERSION,
                "deleted": deletion.deleted,
                "collection": name,
                "kept_links": deletion.kept_links,
            })
        ));
    }
    let mut out = format!("deleted collection {name}\n");
    if !deletion.kept_links.is_empty() {
        out.push_str(&format!(
            "these cards could not be changed and still link it: {}\n",
            deletion.kept_links.join(", ")
        ));
    }
    Ok(out)
}

fn light_block_json(block: &crate::storage::index::LightBlock) -> serde_json::Value {
    json!({
        "slug": block.slug,
        "title": block.display_title,
        "url": block.url,
        "saved_at": crate::util::saved_at_with_zone(&block.saved_at),
        // Derived, not stored: how the card presents (decision 044).
        "card_kind": { "value": block.card_kind.as_str(), "derived": true },
    })
}

/// One search result. Search names a result by its file name, as the app's
/// search list does (user's decision of 05.10.2026, SPEC_SEARCH.md): `name`
/// is that name. `title` keeps its contract-1 meaning, the note's visible
/// title (its H1 or legacy `frontmatter.title`), and is null without one.
fn search_result_json(block: &crate::storage::index::LightBlock) -> serde_json::Value {
    let mut row = light_block_json(block);
    row["name"] = json!(card_file_name(&block.slug));
    row
}

/// The card's file name: its slug without the folder (a slug never carries
/// `.md`), the name `mine card rename` changes. The same text the search
/// `title` match field holds (`search_file_name` in `search_engine.rs`).
fn card_file_name(slug: &str) -> String {
    let name = crate::domain::block::fallback_title_from_slug(slug);
    if name.trim().is_empty() {
        slug.to_string()
    } else {
        name
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::domain::block::parse_markdown_document;
    use crate::domain::block::DateTime;

    /// A disposable app-data dir + one initialized space with two cards and
    /// the page of the collection `Nature` one of them is in: a collection
    /// exists only as its page (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1).
    pub(crate) fn fixture() -> (tempfile::TempDir, CliEnv, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let vault_root = dir.path().join("Space");
        std::fs::create_dir_all(vault_root.join(".mine")).unwrap();
        std::fs::create_dir_all(vault_root.join("Cards")).unwrap();
        std::fs::create_dir_all(vault_root.join("Collections")).unwrap();
        std::fs::write(
            vault_root.join("Collections/Nature.md"),
            "---\ntype: channel\nposition: 0\nsaved_at: 2026-01-01T00:00:00Z\n---\n",
        )
        .unwrap();
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
            let content = std::fs::read_to_string(vault_root.join(format!("{slug}.md"))).unwrap();
            let parsed = parse_markdown_document(
                slug,
                &content,
                DateTime::new("2026-01-01T00:00:00Z").unwrap(),
            )
            .unwrap();
            crate::storage::index::upsert_block(&conn, &parsed.block, None).unwrap();
        }
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        drop(conn);

        (
            dir,
            CliEnv::in_dir(app_data),
            vault_root,
        )
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
    fn cli_layout_uses_saved_paths_and_rejects_invalid_settings() {
        let (_dir, env, root) = fixture();
        let marker = root.join(".mine/layout.json");
        std::fs::write(
            &marker,
            r#"{"cards":"Notes/Clips","media":"Assets","collections":"Sets"}"#,
        )
        .unwrap();
        let vault = resolve_space(&env, None).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(vault.new_card_slug("New"), "Notes/Clips/New");
        assert_eq!(vault.new_media_stem("New.png"), "Assets/New.png");
        assert_eq!(vault.new_collection_slug("New"), "Sets/New");
        std::fs::write(&marker, "broken json").unwrap();
        assert!(resolve_space(&env, None).is_err());
    }

    /// Е2.21: reading builds no index and runs no reconciliation
    /// (SPEC_AI_ACCESS.md, «Read-only гарантия»): a space Mine never opened
    /// and an index still being built are said so, and nothing is written.
    #[test]
    fn reading_builds_no_index_and_reconciles_nothing() {
        let (_dir, env, root) = fixture();
        let derived = env.app_data_dir.join("vaults/testspace");
        let index = resolve_space(&env, None)
            .unwrap_or_else(|error| panic!("{}", error.message))
            .index_db_path();

        // The index is not ready yet, and a card came meanwhile.
        let conn = db::open_or_create(&index).unwrap();
        crate::storage::db::set_index_ready(&conn, false).unwrap();
        drop(conn);
        std::fs::write(root.join("Cards/new.md"), "---\nsaved_at: 2026-01-04T00:00:00Z\n---\nA new card.").unwrap();
        let out = run(&env, &args(&["cards", "--collection", "Nature"]));
        assert_eq!(out.code, EXIT_SPACE, "{}", out.stdout);
        assert!(out.stderr.contains("open the space in Mine"), "{}", out.stderr);
        let conn = db::open_read_only(&index).unwrap();
        assert!(!db::index_is_ready(&conn).unwrap(), "a read finished the index");
        let indexed: i64 = conn.query_row("SELECT COUNT(*) FROM blocks WHERE slug = 'Cards/new'", [], |row| row.get(0)).unwrap();
        assert_eq!(indexed, 0, "a read reconciled the space");
        drop(conn);

        // No index at all: nothing is built.
        std::fs::remove_dir_all(&derived).unwrap();
        for command in [&["collections"][..], &["search", "sunset"][..], &["card", "Cards/sunset"][..]] {
            let out = run(&env, &args(command));
            assert_eq!(out.code, EXIT_SPACE, "{command:?}: {}", out.stdout);
            assert!(out.stderr.contains("open the space in Mine"), "{command:?}: {}", out.stderr);
            assert!(!derived.exists(), "{command:?} built an index");
        }
    }

    /// Е2.22: `saved_at` written as local time without a zone goes out with
    /// the zone of this Mac, so an agent reads the moment, not a guess.
    #[test]
    fn saved_at_goes_out_with_its_zone() {
        let (_dir, env, root) = fixture();
        std::fs::write(root.join("Cards/local.md"), "---\nsaved_at: 2026-01-03T10:00:00\n---\nLocal time.").unwrap();
        let vault = resolve_space(&env, None).unwrap_or_else(|error| panic!("{}", error.message));
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        drop(conn);
        let out = run(&env, &args(&["card", "Cards/local", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let card: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        let saved_at = card["saved_at"].as_str().unwrap();
        assert!(saved_at.starts_with("2026-01-03T10:00:00"), "{saved_at}");
        let zone = &saved_at["2026-01-03T10:00:00".len()..];
        assert!(zone == "Z" || (zone.len() == 6 && (zone.starts_with('+') || zone.starts_with('-'))), "{saved_at}");
        // A value written in UTC names the same moment, in this Mac's zone.
        let out = run(&env, &args(&["card", "Cards/sunset", "--json"]));
        let card: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        let sunset = card["saved_at"].as_str().unwrap();
        assert!(
            sunset.ends_with('Z') || sunset.len() == "2026-01-01T00:00:00+00:00".len(),
            "{sunset}"
        );
    }

    /// Е2.22: the CLI names its build.
    #[test]
    fn the_cli_names_its_build() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["--version"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(out.stdout.contains(env!("MINE_BUILD_ID")), "{}", out.stdout);
    }

    /// Е2.22: a CLI of another build than the app says so on every call, on
    /// stderr, and its answer stays whole.
    #[test]
    fn a_cli_of_another_build_than_the_app_says_so() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["collections", "--json"]));
        assert!(out.stderr.is_empty(), "{}", out.stderr);
        std::fs::write(
            env.app_data_dir.join(crate::runtime_protocol::APP_BUILD_FILE),
            r#"{"version":"0.1.0","build_id":"0123456789abcdef","commit":"other"}"#,
        )
        .unwrap();
        let out = run(&env, &args(&["collections", "--json"]));
        assert_eq!(out.code, EXIT_OK);
        assert!(out.stderr.starts_with("warning: this mine CLI is build"), "{}", out.stderr);
        assert!(serde_json::from_str::<serde_json::Value>(&out.stdout).is_ok());
        let version = run(&env, &args(&["--version"]));
        assert!(version.stdout.contains("Mine app 0.1.0 build 0123456789abcdef"), "{}", version.stdout);
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
    fn search_names_a_result_by_its_file_name() {
        // Search names a result by the card's file name, as the app's search
        // list does (SPEC_SEARCH.md); the note's H1 stays its own field.
        let (dir, env, _root) = fixture();
        let body = dir.path().join("body.md");
        std::fs::write(&body, "# Typography notes\n\nNotes about typography.\n").unwrap();
        let out = run(
            &env,
            &args(&["card", "set-body", "Cards/plain", "--from", body.to_str().unwrap()]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);

        let out = run(&env, &args(&["search", "typography", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        let result = &value["results"][0];
        assert_eq!(result["slug"], "Cards/plain");
        assert_eq!(result["name"], "plain");
        assert_eq!(result["title"], "Typography notes");

        let out = run(&env, &args(&["search", "typography"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert_eq!(out.stdout, "Cards/plain\tplain\n");
    }

    #[test]
    fn never_writes_to_the_index() {
        // The whole read layer's contract in one assertion: the index file is
        // byte-identical after every command.
        let (_dir, env, root) = fixture();
        let db_path = resolve_space(&env, None)
            .map_err(|error| error.message)
            .unwrap()
            .index_db_path();
        use sha2::{Digest, Sha256};
        let before = Sha256::digest(std::fs::read(&db_path).unwrap());
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
        let after = Sha256::digest(std::fs::read(&db_path).unwrap());
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

        let out = run(
            &env,
            &args(&["card", "set", "Cards/sunset", "title", "Evening: light"]),
        );
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
        let out = run(
            &env,
            &args(&[
                "card",
                "create",
                "--title",
                "Fresh Note",
                "--from",
                body.to_str().unwrap(),
            ]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        // The fixture has no layout.json, so new cards land in the vault root.
        let content = card_content(&root, "Fresh Note");
        assert!(content.starts_with("---\n"), "front matter present");
        assert!(!content.contains("type:"), "044: no type field on cards");
        assert!(
            !content.contains("title:"),
            "explicit title belongs to the body"
        );
        assert!(content.contains("# Fresh Note"));
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
    fn title_only_creation_uses_the_shared_manual_heading_policy() {
        let (_dir, env, root) = fixture();
        let out = run(
            &env,
            &args(&["card", "create", "--title", "Explicit title"]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let content = card_content(&root, "Explicit title");
        assert!(!content.contains("title:"));
        assert!(content.ends_with("# Explicit title"));
    }

    #[test]
    fn create_rejects_invalid_collection_before_writing_source() {
        let (_dir, env, root) = fixture();
        let out = run(
            &env,
            &args(&[
                "card",
                "create",
                "--title",
                "Invalid",
                "--collection",
                "../outside",
            ]),
        );
        assert_eq!(out.code, EXIT_USAGE, "{}", out.stderr);
        assert!(!root.join("Invalid.md").exists());
    }

    #[test]
    fn create_without_a_file_extension_keeps_a_reference_to_copied_bytes() {
        let (dir, env, root) = fixture();
        let source = dir.path().join("plain-file");
        std::fs::write(&source, b"local payload").unwrap();
        let out = run(
            &env,
            &args(&[
                "card",
                "create",
                "--title",
                "Attachment",
                "--file",
                source.to_str().unwrap(),
            ]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let content = card_content(&root, "Attachment");
        assert!(content.contains("[[Attachment.bin]]"));
        assert!(!content.contains("title:"));
        assert!(!content.contains("# Attachment"));
        assert_eq!(
            std::fs::read(root.join("Attachment.bin")).unwrap(),
            b"local payload"
        );
    }

    #[test]
    fn renames_a_card_on_disk_and_in_the_index() {
        let (_dir, env, root) = fixture();
        let out = run(
            &env,
            &args(&["card", "rename", "Cards/plain", "Typography Notes"]),
        );
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
    fn delete_keeps_media_an_unindexed_note_links_percent_encoded() {
        let (dir, env, root) = fixture();
        let source = dir.path().join("source.jpg");
        std::fs::write(&source, b"\xff\xd8\xff\xdbphoto").unwrap();
        let out = run(
            &env,
            &args(&[
                "card",
                "create",
                "--title",
                "Фото",
                "--file",
                source.to_str().unwrap(),
            ]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(root.join("Фото.jpg").is_file());
        // Written by another editor a moment ago: on disk, not in the index.
        std::fs::write(
            root.join("Cards/Note.md"),
            "Look: ![](../%D0%A4%D0%BE%D1%82%D0%BE.jpg)\n",
        )
        .unwrap();

        let out = run(
            &env,
            &args(&["card", "delete", "Фото", "--delete-unused-media"]),
        );

        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Фото.md").exists());
        assert_eq!(
            std::fs::read(root.join("Фото.jpg")).unwrap(),
            b"\xff\xd8\xff\xdbphoto"
        );
    }

    #[test]
    fn creates_a_media_card_from_a_file() {
        let (dir, env, root) = fixture();
        let source = dir.path().join("shot.jpg");
        std::fs::write(&source, b"\xff\xd8\xff\xdbfake-jpeg-bytes").unwrap();
        let out = run(
            &env,
            &args(&[
                "card",
                "create",
                "--title",
                "Shot",
                "--file",
                source.to_str().unwrap(),
            ]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        // Flat fixture layout: card and media land in the vault root.
        let content = card_content(&root, "Shot");
        assert!(
            content.contains("file:"),
            "front matter references the media"
        );
        assert!(
            content.contains("Shot.jpg"),
            "media reference uses the card name"
        );
        let media = root.join("Shot.jpg");
        assert!(media.is_file(), "media file copied into the vault");
        assert_eq!(
            std::fs::read(&media).unwrap(),
            std::fs::read(&source).unwrap()
        );
        let out = run(&env, &args(&["card", "Shot"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
    }

    #[test]
    fn mutations_survive_a_concurrently_open_writable_index() {
        let (_dir, env, root) = fixture();
        let vault = resolve_space(&env, None).map_err(|e| e.message).unwrap();

        // Another process (the app) keeps a writable connection open the whole
        // time — the everyday scenario for a CLI run.
        let held = db::open_or_create(&vault.index_db_path()).unwrap();

        let out = run(
            &env,
            &args(&["card", "set", "Cards/plain", "title", "Kept open"]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let out = run(
            &env,
            &args(&["card", "rename", "Cards/plain", "Busy Rename"]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(root.join("Cards/Busy Rename.md").exists());

        // Now the other side holds an actual write transaction; the CLI must
        // wait it out (busy_timeout) instead of failing. The lock is released
        // from a background thread mid-wait.
        held.execute_batch("BEGIN IMMEDIATE; INSERT INTO channels (tag, title, position, created_at) VALUES ('held', 'held', 999, '2026-01-01T00:00:00Z');").unwrap();
        let held = std::sync::Mutex::new(held);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(300));
                held.lock().unwrap().execute_batch("COMMIT;").unwrap();
            });
            let out = run(
                &env,
                &args(&["card", "rename", "Cards/Busy Rename", "After Lock"]),
            );
            assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        });
        assert!(root.join("Cards/After Lock.md").exists());
    }

    #[test]
    fn restore_resurrects_a_deleted_card() {
        let (_dir, env, root) = fixture();
        let before = card_content(&root, "Cards/plain");
        let out = run(&env, &args(&["card", "delete", "Cards/plain"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Cards/plain.md").exists());

        let out = run(&env, &args(&["restore", "Cards/plain"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert_eq!(card_content(&root, "Cards/plain"), before);
        // Back in the index too: the read side sees the card again.
        let out = run(&env, &args(&["card", "Cards/plain"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
    }

    #[test]
    fn structural_commands_emit_parseable_json() {
        let (_dir, env, _root) = fixture();
        let parse = |out: &CliOutput| -> serde_json::Value {
            assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
            serde_json::from_str(out.stdout.trim()).expect("valid JSON")
        };

        let v = parse(&run(
            &env,
            &args(&["card", "create", "--title", "Json Card", "--json"]),
        ));
        assert_eq!(v["contract"], 1);
        let created = v["created"].as_str().unwrap().to_string();

        let v = parse(&run(
            &env,
            &args(&["card", "rename", &created, "Json Card 2", "--json"]),
        ));
        let renamed_to = v["to"].as_str().unwrap().to_string();

        let v = parse(&run(
            &env,
            &args(&["card", "delete", &renamed_to, "--dry-run", "--json"]),
        ));
        assert_eq!(v["applied"], false);
        let v = parse(&run(
            &env,
            &args(&["card", "delete", &renamed_to, "--json"]),
        ));
        assert_eq!(v["deleted"], true);

        let v = parse(&run(
            &env,
            &args(&["collection", "create", "Json Shelf", "--json"]),
        ));
        assert_eq!(v["created"], "Json Shelf");
        let v = parse(&run(
            &env,
            &args(&[
                "collection",
                "rename",
                "Json Shelf",
                "Json Shelf 2",
                "--json",
            ]),
        ));
        assert_eq!(v["to"], "Json Shelf 2");
        let v = parse(&run(
            &env,
            &args(&["collection", "delete", "Json Shelf 2", "--json"]),
        ));
        assert_eq!(v["deleted"], true);
    }

    #[test]
    fn structural_error_paths_fail_without_side_effects() {
        let (_dir, env, root) = fixture();
        let sunset_before = card_content(&root, "Cards/sunset");

        // Rename onto an occupied name.
        let out = run(&env, &args(&["card", "rename", "Cards/plain", "sunset"]));
        assert_ne!(out.code, EXIT_OK, "occupied rename must fail");
        assert!(root.join("Cards/plain.md").exists());

        // Structural commands aimed at a missing card.
        let out = run(&env, &args(&["card", "delete", "Cards/ghost"]));
        assert_ne!(out.code, EXIT_OK);
        let out = run(&env, &args(&["card", "rename", "Cards/ghost", "anything"]));
        assert_ne!(out.code, EXIT_OK);
        let out = run(&env, &args(&["merge", "Cards/sunset", "Cards/ghost"]));
        assert_ne!(out.code, EXIT_OK);
        assert_eq!(
            card_content(&root, "Cards/sunset"),
            sunset_before,
            "failed merge left sources alone"
        );

        // Duplicate collection.
        let out = run(&env, &args(&["collection", "create", "Dup"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let out = run(&env, &args(&["collection", "create", "Dup"]));
        assert_ne!(out.code, EXIT_OK, "duplicate collection must fail");
    }

    #[test]
    fn space_flag_routes_mutations_to_the_chosen_space() {
        let (dir, env, root) = fixture();
        // A second known space with its own card and index.
        let second_root = dir.path().join("Second");
        std::fs::create_dir_all(second_root.join(".mine")).unwrap();
        std::fs::write(second_root.join(".mine/vault-id"), "secondspace").unwrap();
        std::fs::write(
            second_root.join("note.md"),
            "---\nsaved_at: 2026-02-01T00:00:00Z\n---\nSecond space note.",
        )
        .unwrap();
        let derived = env.app_data_dir.join("vaults/secondspace");
        std::fs::create_dir_all(&derived).unwrap();
        let vault = VaultLayout::with_derived_root(second_root.clone(), derived);
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let content = std::fs::read_to_string(second_root.join("note.md")).unwrap();
        let parsed = crate::domain::block::parse_markdown_document(
            "note",
            &content,
            DateTime::new("2026-02-01T00:00:00Z").unwrap(),
        )
        .unwrap();
        crate::storage::index::upsert_block(&conn, &parsed.block, None).unwrap();
        drop(conn);
        std::fs::write(
            env.app_data_dir.join("config.json"),
            serde_json::to_string(&json!({
                "vault_path": root,
                "known_vaults": [root.clone(), second_root.clone()],
            }))
            .unwrap(),
        )
        .unwrap();

        let out = run(
            &env,
            &args(&[
                "card",
                "set",
                "note",
                "title",
                "Routed",
                "--space",
                second_root.to_str().unwrap(),
            ]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(std::fs::read_to_string(second_root.join("note.md"))
            .unwrap()
            .contains("title: Routed"));
        // The active space is untouched.
        assert!(!card_content(&root, "Cards/plain").contains("Routed"));
    }

    #[test]
    fn collection_lifecycle_create_rename_delete() {
        let (_dir, env, root) = fixture();
        let out = run(&env, &args(&["collection", "create", "Reading"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let page = std::fs::read_to_string(root.join("Reading.md")).unwrap();
        assert!(
            page.contains("type: channel"),
            "collection page keeps its type"
        );

        let out = run(
            &env,
            &args(&["collection", "rename", "Reading", "Reading List"]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Reading.md").exists());
        assert!(root.join("Reading List.md").exists());

        // Membership follows the rename inside card front matter.
        let out = run(&env, &args(&["connect", "Cards/plain", "Reading List"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let out = run(
            &env,
            &args(&["collection", "rename", "Reading List", "Shelf"]),
        );
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(card_content(&root, "Cards/plain").contains("[[Shelf]]"));

        let out = run(&env, &args(&["collection", "delete", "Shelf"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(!root.join("Shelf.md").exists());
    }

    #[test]
    fn merges_two_cards_into_the_first() {
        let (_dir, env, root) = fixture();
        let out = run(
            &env,
            &args(&["merge", "Cards/sunset", "Cards/plain", "--json"]),
        );
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
        let out = run(
            &env,
            &args(&["card", "set-body", "Cards/gallery", "--from", "/dev/null"]),
        );
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stderr.contains("a.jpg"));

        // …a rewrite that keeps it goes through, front matter untouched.
        let body = root.join("new-body.md");
        std::fs::write(&body, "Перевод строки.\n\n![[a.jpg]]\n").unwrap();
        let out = run(
            &env,
            &args(&[
                "card",
                "set-body",
                "Cards/gallery",
                "--from",
                body.to_str().unwrap(),
            ]),
        );
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
        let out = run(
            &env,
            &args(&["card", "set", "Cards/sunset", "title", "X", "--dry-run"]),
        );
        assert_eq!(out.code, EXIT_OK);
        assert!(out.stdout.contains("would apply"));
        assert_eq!(card_content(&root, "Cards/sunset"), before);
    }

    /// Every file of the space with its bytes, `.mine` aside.
    fn space_snapshot(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let vault = VaultLayout::new(root.to_path_buf());
        let mut paths = crate::storage::files::scan_vault_file_paths(&vault).unwrap();
        paths.sort();
        paths
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(root.join(&path)).unwrap();
                (path, bytes)
            })
            .collect()
    }

    /// К1, К2, К7, К8, К9 (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) through the
    /// CLI: a name a card links without a page is no collection. Reads do not
    /// show it, `connect`, `card create --collection` and
    /// `cards --collection` refuse it with code 4 and write nothing, and
    /// `disconnect` takes the link off.
    /// SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1 (10.10.2026): with the app
    /// closed nothing drops the index row of a page sent to the Trash. The
    /// row is no page: a connect to it refuses before any write, and
    /// `collection create` takes the name again.
    #[test]
    fn a_collection_whose_page_left_with_the_app_closed_is_no_collection_for_writes() {
        let (_dir, env, root) = fixture();
        let out = run(&env, &args(&["collection", "create", "Reading"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        std::fs::remove_file(root.join("Reading.md")).unwrap();
        let before = space_snapshot(&root);

        let out = run(&env, &args(&["connect", "Cards/plain", "Reading"]));
        assert_eq!(out.code, EXIT_NOT_FOUND, "{}", out.stderr);
        let out = run(
            &env,
            &args(&["card", "create", "--title", "Into the Trash", "--collection", "Reading"]),
        );
        assert_eq!(out.code, EXIT_NOT_FOUND, "{}", out.stderr);
        assert_eq!(space_snapshot(&root), before);

        let out = run(&env, &args(&["collection", "create", "Reading"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(out.stdout.contains("created collection Reading\n"), "{}", out.stdout);
        let page = std::fs::read_to_string(root.join("Reading.md")).unwrap();
        assert!(page.contains("type: channel"), "{page}");
        let out = run(&env, &args(&["collection", "create", "Reading"]));
        assert_ne!(out.code, EXIT_OK, "a page that is there keeps its name");
    }

    #[test]
    fn a_name_without_a_page_is_no_collection_for_the_cli() {
        let (_dir, env, root) = fixture();
        let loose = "---\nsaved_at: 2026-01-03T00:00:00Z\nMine Collections:\n  - \"[[Pageless]]\"\n  - \"[[Nature]]\"\n---\nA loose note.";
        std::fs::write(root.join("Cards/loose.md"), loose).unwrap();
        {
            let vault = resolve_space(&env, None).map_err(|error| error.message).unwrap();
            let conn = db::open_or_create(&vault.index_db_path()).unwrap();
            let parsed = crate::domain::block::parse_markdown_document(
                "Cards/loose",
                loose,
                DateTime::new("2026-01-03T00:00:00Z").unwrap(),
            )
            .unwrap();
            crate::storage::index::upsert_block(&conn, &parsed.block, None).unwrap();
        }
        let refusal = "no collection \"Pageless\": its page does not exist; create it with mine collection create";
        let before = space_snapshot(&root);

        let out = run(&env, &args(&["connect", "Cards/plain", "Pageless"]));
        assert_eq!(out.code, EXIT_NOT_FOUND, "{}", out.stderr);
        assert!(out.stderr.contains(refusal), "{}", out.stderr);

        let out = run(&env, &args(&["cards", "--collection", "Pageless"]));
        assert_eq!(out.code, EXIT_NOT_FOUND, "{}", out.stdout);
        assert!(out.stderr.contains(refusal), "{}", out.stderr);

        let out = run(
            &env,
            &args(&["card", "create", "--title", "Into nowhere", "--collection", "Pageless"]),
        );
        assert_eq!(out.code, EXIT_NOT_FOUND, "{}", out.stderr);
        assert!(out.stderr.contains(refusal), "{}", out.stderr);
        assert_eq!(space_snapshot(&root), before, "a refused command wrote a file");

        let out = run(&env, &args(&["collections", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["collections"], json!([{ "name": "Nature", "count": 2 }]));

        let out = run(&env, &args(&["card", "Cards/loose", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["collections"], json!(["Nature"]));
        let out = run(&env, &args(&["card", "Cards/loose"]));
        assert!(!out.stdout.contains("Pageless"), "{}", out.stdout);

        let out = run(&env, &args(&["disconnect", "Cards/loose", "Pageless"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let after = card_content(&root, "Cards/loose");
        assert!(!after.contains("Pageless"), "{after}");
        assert!(after.contains("[[Nature]]"), "{after}");
    }

    /// К1: an empty collection page is a collection with a count of 0.
    #[test]
    fn an_empty_collection_page_is_listed_with_zero() {
        let (_dir, env, _root) = fixture();
        let out = run(&env, &args(&["collection", "create", "Empty shelf"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);

        let out = run(&env, &args(&["collections", "--json"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(
            value["collections"],
            json!([{ "name": "Nature", "count": 1 }, { "name": "Empty shelf", "count": 0 }])
        );
        let out = run(&env, &args(&["cards", "--collection", "Empty shelf"]));
        assert_eq!(out.code, EXIT_OK, "{}", out.stderr);
        assert!(out.stdout.contains("no cards in this collection"));
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

/// SPEC_DEEP_AUDIT.md, Е1 (Н1, Н2): the CLI and the MCP change notes the way
/// the app reads them, on real files in a disposable space.
#[cfg(test)]
pub(crate) mod source_fidelity_tests {
    use super::tests::*;
    use super::*;

    pub(crate) fn read(root: &std::path::Path, slug: &str) -> String {
        std::fs::read_to_string(root.join(format!("{slug}.md"))).unwrap()
    }

    pub(crate) fn write(root: &std::path::Path, slug: &str, text: &str) {
        let path = root.join(format!("{slug}.md"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// The note as the app reads it.
    pub(crate) fn parsed(root: &std::path::Path, slug: &str) -> crate::domain::block::ParsedMarkdownBlock {
        crate::domain::block::parse_markdown_document(
            slug,
            &read(root, slug),
            DateTime::new("1999-01-01T00:00:00Z").unwrap(),
        )
        .unwrap()
    }

    fn body_file(dir: &tempfile::TempDir, text: &str) -> String {
        let path = dir.path().join(format!("body-{}.md", text.len()));
        std::fs::write(&path, text).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn ok(out: &CliOutput) {
        assert_eq!(out.code, EXIT_OK, "stdout: {} stderr: {}", out.stdout, out.stderr);
    }

    /// The index of the fixture space, opened for a look.
    fn index(env: &CliEnv) -> rusqlite::Connection {
        let vault = resolve_space(env, None).map_err(|error| error.message).unwrap();
        db::open_or_create(&vault.index_db_path()).unwrap()
    }

    // ── Е1.1: one frontmatter boundary ──────────────────────────────────────

    #[test]
    fn set_body_keeps_a_crlf_front_matter() {
        let (dir, env, root) = fixture();
        write(&root, "Cards/crlf", "---\r\nsaved_at: 2026-01-03T00:00:00Z\r\nauthor: Ann\r\n---\r\nOld body\r\n");

        let out = run(&env, &args(&["card", "set-body", "Cards/crlf", "--from", &body_file(&dir, "New body\n")]));

        ok(&out);
        assert_eq!(
            read(&root, "Cards/crlf"),
            "---\r\nsaved_at: 2026-01-03T00:00:00Z\r\nauthor: Ann\r\n---\r\nNew body\n"
        );
        let note = parsed(&root, "Cards/crlf");
        assert_eq!(note.block.frontmatter.author.as_deref(), Some("Ann"));
        assert_eq!(note.block.body, "New body\n");
    }

    #[test]
    fn set_body_starts_on_its_own_line_after_a_closing_fence_without_a_line_break() {
        let (dir, env, root) = fixture();
        write(&root, "Cards/bare", "---\nsaved_at: 2026-01-03T00:00:00Z\n---");

        let out = run(&env, &args(&["card", "set-body", "Cards/bare", "--from", &body_file(&dir, "Body\n")]));

        ok(&out);
        assert_eq!(read(&root, "Cards/bare"), "---\nsaved_at: 2026-01-03T00:00:00Z\n---\nBody\n");
        assert_eq!(parsed(&root, "Cards/bare").block.body, "Body\n");
    }

    #[test]
    fn an_empty_front_matter_is_found_and_a_rule_in_the_body_stays_body() {
        let (dir, env, root) = fixture();
        let note = "---\n---\nIntro\n---\nMore\n";
        write(&root, "Cards/empty", note);

        let out = run(&env, &args(&["card", "set", "Cards/empty", "author", "Ann"]));
        ok(&out);
        assert_eq!(read(&root, "Cards/empty"), "---\nauthor: Ann\n---\nIntro\n---\nMore\n");

        write(&root, "Cards/empty", note);
        let out = run(&env, &args(&["card", "set-body", "Cards/empty", "--from", &body_file(&dir, "New\n")]));
        ok(&out);
        assert_eq!(read(&root, "Cards/empty"), "---\n---\nNew\n");

        write(&root, "Cards/empty", note);
        let out = run(&env, &args(&["card", "body", "Cards/empty"]));
        ok(&out);
        assert_eq!(out.stdout, "Intro\n---\nMore\n");
    }

    // ── Е1.2: a key with its continuation lines ─────────────────────────────

    pub(crate) const MULTILINE: &str = "---\nsaved_at: 2026-01-03T00:00:00Z\ndescription: |\n  First line\n  Second line\nauthor: Ann\n---\nBody\n";

    #[test]
    fn set_replaces_a_block_scalar_whole() {
        let (_dir, env, root) = fixture();
        write(&root, "Cards/multi", MULTILINE);

        let out = run(&env, &args(&["card", "set", "Cards/multi", "description", "Short"]));

        ok(&out);
        let note = parsed(&root, "Cards/multi");
        assert_eq!(note.block.frontmatter.description.as_deref(), Some("Short"));
        assert_eq!(note.block.frontmatter.author.as_deref(), Some("Ann"));
        assert_eq!(note.block.frontmatter.saved_at.as_str(), "2026-01-03T00:00:00Z");
        assert_eq!(note.block.body, "Body\n");
        assert!(!read(&root, "Cards/multi").contains("First line"));
    }

    #[test]
    fn unset_takes_a_folded_value_with_its_lines() {
        let (_dir, env, root) = fixture();
        write(
            &root,
            "Cards/folded",
            "---\nsaved_at: 2026-01-03T00:00:00Z\ndescription: >\n  folded\n  text\nauthor: Ann\n---\nBody\n",
        );

        let out = run(&env, &args(&["card", "unset", "Cards/folded", "description"]));

        ok(&out);
        assert_eq!(
            read(&root, "Cards/folded"),
            "---\nsaved_at: 2026-01-03T00:00:00Z\nauthor: Ann\n---\nBody\n"
        );
    }

    #[test]
    fn a_value_with_line_breaks_reads_back_as_written() {
        let (_dir, env, root) = fixture();
        write(&root, "Cards/multi", MULTILINE);

        let value = "Line one\nLine two: \"quoted\"\n";
        let out = run(&env, &args(&["card", "set", "Cards/multi", "description", value]));

        ok(&out);
        let note = parsed(&root, "Cards/multi");
        assert_eq!(note.origin, "partial_frontmatter");
        assert_eq!(note.block.frontmatter.description.as_deref(), Some(value));
        assert_eq!(note.block.frontmatter.author.as_deref(), Some("Ann"));
    }

    // ── Е1.6: a collection page stays a collection ──────────────────────────

    #[test]
    fn card_set_on_a_collection_page_keeps_it_a_collection() {
        let (_dir, env, _root) = fixture();

        let out = run(&env, &args(&["card", "set", "Collections/Nature", "description", "Wild things"]));

        ok(&out);
        let conn = index(&env);
        let as_card: i64 = conn
            .query_row("SELECT COUNT(*) FROM blocks WHERE slug = 'Collections/Nature'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(as_card, 0, "the page was indexed as a card");
        let description: Option<String> = conn
            .query_row("SELECT description FROM channels WHERE tag = 'Nature'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(description.as_deref(), Some("Wild things"));
    }

    // ── Е1.9: writes and restore check the file they read ───────────────────

    #[test]
    fn restore_refuses_a_card_edited_after_the_cli_wrote_it() {
        let (_dir, env, root) = fixture();
        ok(&run(&env, &args(&["card", "set", "Cards/plain", "author", "Ann"])));
        let edited = "---\nsaved_at: 2026-01-02T00:00:00Z\nauthor: Ann\n---\nEdited in Obsidian.\n";
        write(&root, "Cards/plain", edited);

        let out = run(&env, &args(&["restore", "Cards/plain"]));

        assert_ne!(out.code, EXIT_OK, "{}", out.stdout);
        assert_eq!(read(&root, "Cards/plain"), edited);
    }

    #[test]
    fn restore_never_puts_a_backup_over_another_card_that_took_the_name() {
        let (_dir, env, root) = fixture();
        ok(&run(&env, &args(&["card", "set", "Cards/plain", "author", "Ann"])));
        ok(&run(&env, &args(&["card", "rename", "Cards/plain", "Typography"])));
        let other = "---\nsaved_at: 2026-02-01T00:00:00Z\n---\nAnother card under the old name.\n";
        write(&root, "Cards/plain", other);

        let out = run(&env, &args(&["restore", "Cards/plain"]));

        assert_ne!(out.code, EXIT_OK, "{}", out.stdout);
        assert_eq!(read(&root, "Cards/plain"), other);
    }

    // ── Е1.3: deleting a collection takes its links off ─────────────────────

    #[test]
    fn deleting_a_collection_takes_its_links_off_and_a_new_page_starts_empty() {
        let (_dir, env, root) = fixture();

        let out = run(&env, &args(&["collection", "delete", "Nature"]));

        ok(&out);
        assert!(!root.join("Collections/Nature.md").exists());
        let sunset = read(&root, "Cards/sunset");
        assert!(!sunset.contains("Nature"), "{sunset}");
        assert_eq!(parsed(&root, "Cards/sunset").block.body, "A sunset over the bay.");

        ok(&run(&env, &args(&["collection", "create", "Nature"])));
        let out = run(&env, &args(&["cards", "--collection", "Nature"]));
        ok(&out);
        assert!(!out.stdout.contains("Cards/sunset"), "{}", out.stdout);
    }

    // ── Е1.4: renaming a collection finds every member and every link ───────

    #[test]
    fn renaming_a_collection_finds_members_the_index_missed_and_rewrites_links() {
        let (_dir, env, root) = fixture();
        // Written with the app closed: on disk, not in the index.
        write(
            &root,
            "Cards/fresh",
            "---\nsaved_at: 2026-01-05T00:00:00Z\nMine Collections:\n  - \"[[Nature]]\"\n---\nFresh.\n",
        );
        write(
            &root,
            "Cards/notes",
            "---\nsaved_at: 2026-01-05T00:00:00Z\nMine Related Notes:\n  - \"[[Nature]]\"\n---\nSee [[Nature]] and [[Nature|the shelf]].\n",
        );

        let out = run(&env, &args(&["collection", "rename", "Nature", "Wild"]));

        ok(&out);
        assert!(root.join("Collections/Wild.md").exists());
        assert_eq!(parsed(&root, "Cards/fresh").block.frontmatter.tags, vec!["Wild"]);
        assert_eq!(parsed(&root, "Cards/sunset").block.frontmatter.tags, vec!["Wild"]);
        let notes = parsed(&root, "Cards/notes");
        assert_eq!(notes.block.frontmatter.related_notes, vec!["Wild"]);
        assert_eq!(notes.block.body, "See [[Wild]] and [[Wild|the shelf]].\n");
        let out = run(&env, &args(&["collections", "--json"]));
        ok(&out);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["collections"], json!([{ "name": "Wild", "count": 2 }]));
    }

    // ── Е1.5: renaming a collection page renames the collection ─────────────

    #[test]
    fn card_rename_of_a_collection_page_renames_the_collection() {
        let (_dir, env, root) = fixture();

        let out = run(&env, &args(&["card", "rename", "Collections/Nature", "Wild"]));

        ok(&out);
        assert!(!root.join("Collections/Nature.md").exists());
        assert!(root.join("Collections/Wild.md").exists());
        assert_eq!(parsed(&root, "Cards/sunset").block.frontmatter.tags, vec!["Wild"]);
        let out = run(&env, &args(&["collections", "--json"]));
        ok(&out);
        let value: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(value["collections"], json!([{ "name": "Wild", "count": 1 }]));
    }
}
