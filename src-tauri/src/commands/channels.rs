// Channel commands: list, create, delete channels.
//
// Contract: SPEC_INTEGRATION.md#commands/channels

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::commands::state::{
    tab_layout, ensure_vault_fresh, read_owned_projection, AppState, CommandError,
};
use crate::commands::tags::MembershipRewrite;
use crate::domain::block::{
    parse_markdown_document, serialize_block, Block, BlockType, DateTime, Frontmatter,
};
use crate::domain::channel::Channel;
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::domain::source_patch::apply_block_changes;
use crate::domain::vault::{name_problem, normalize_typed_name, VaultLayout};
#[cfg(test)]
use crate::storage::db;
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
use crate::storage::{files, index, projection};
use crate::util::append_startup_trace;

const SOURCE_MUTATION_WATCHER_SUPPRESSION_MS: u64 = 1500;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Serializable channel data for the frontend.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ChannelDto {
    pub tag: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    /// Manual order, smallest first; a new collection takes one before the
    /// first (SPEC_DEEP_AUDIT.md, Е6.2), so it may be below zero.
    pub position: i64,
    pub created_at: String,
    /// Number of blocks with this tag.
    pub block_count: usize,
}

impl ChannelDto {
    fn from_channel(channel: &Channel, block_count: usize) -> Self {
        Self {
            tag: channel.tag.clone(),
            description: channel.description.clone(),
            color: channel.color.clone(),
            icon: channel.icon.clone(),
            position: channel.position,
            created_at: channel.created_at.as_str().to_string(),
            block_count,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TaxonomySnapshot {
    pub generation: projection::ProjectionRevision,
    pub tags: Vec<index::TagCount>,
    pub channels: Vec<ChannelDto>,
    pub total_blocks: usize,
    /// Which collections each card is in, from the same projection revision
    /// as `tags`. See SPEC_CARD_STATES.md, С3 and С4.
    pub memberships: Vec<BlockCollection>,
}

/// One card in one collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct BlockCollection {
    pub block_id: i64,
    pub tag: String,
}

// ─── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_taxonomy_snapshot(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TaxonomySnapshot, CommandError> {
    append_startup_trace(&app, "list_taxonomy_snapshot", "start");
    let vault = tab_layout(&state, &webview)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let app_for_query = app.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || -> Result<TaxonomySnapshot, CommandError> {
            read_owned_projection(&app_for_query, &vault, |conn| {
                Ok(projection::read_projection_snapshot(
                    conn,
                    |conn, generation| {
                        Ok(TaxonomySnapshot {
                            generation,
                            tags: index::get_all_tags(conn)?,
                            channels: load_channels(conn)?,
                            total_blocks: index::count_grid_blocks(conn)?,
                            memberships: crate::storage::block_queries::list_block_collections(conn)?
                                .into_iter()
                                .map(|(block_id, tag)| BlockCollection { block_id, tag })
                                .collect(),
                        })
                    },
                )?)
            })
        })
        .await
        .map_err(|e| {
            CommandError::Internal(format!("list_taxonomy_snapshot task join failed: {e}"))
        })??;
    append_startup_trace(
        &app,
        "list_taxonomy_snapshot",
        &format!(
            "done tags={} channels={} total={}",
            snapshot.tags.len(),
            snapshot.channels.len(),
            snapshot.total_blocks
        ),
    );
    Ok(snapshot)
}

/// Create a promoted collection from a Markdown collection ref.
fn create_channel_unannounced(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    tag: String,
) -> Result<ChannelDto, CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    let vault = files::layout_for_new_files(&vs.vault)?;
    create_channel_inner(&vs.conn, &vault, &tag)
}

/// [`create_channel_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(async)]
pub fn create_channel(webview: tauri::Webview, state: State<'_, AppState>, tag: String) -> Result<ChannelDto, CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = create_channel_unannounced(webview, state, tag);
    if outcome.is_ok() {
        announcing.send(Vec::new());
    }
    outcome
}

/// Whether a collection may be named `new_tag`: renamed from `old_tag`, or
/// created when there is none. It answers by the rules and checks the rename
/// and the creation use, while the name is typed, and writes nothing
/// (05.10.2026).
#[tauri::command(async, rename_all = "snake_case")]
pub fn check_collection_name(webview: tauri::Webview, state: State<'_, AppState>, old_tag: Option<String>, new_tag: String) -> Result<(), CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    check_collection_name_inner(&vs.conn, &vs.vault, old_tag.as_deref(), &new_tag)
}

/// Where a collection's page lives, for Reveal in Finder: the absolute path of
/// the page the collection's rename and deletion act on, or none when no page
/// is found. A bare name shared by several pages is ambiguous, as it is for
/// those mutations, and answers with that error. Reads only.
#[tauri::command(async)]
pub fn collection_page_path(webview: tauri::Webview, state: State<'_, AppState>, tag: String) -> Result<Option<String>, CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    collection_page_path_inner(&vs.conn, &vs.vault, &tag)
}

pub(crate) fn collection_page_path_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    tag: &str,
) -> Result<Option<String>, CommandError> {
    Ok(collection_document_for_mutation(conn, vault, tag)?
        .map(|page| page.path.to_string_lossy().into_owned()))
}

pub(crate) fn check_collection_name_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    old_tag: Option<&str>,
    new_tag: &str,
) -> Result<(), CommandError> {
    match old_tag {
        Some(old_tag) => CollectionRename::plan(conn, vault, old_tag, new_tag).map(|_| ()),
        None => new_collection_name(conn, vault, new_tag).map(|_| ()),
    }
}

pub(crate) fn create_channel_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    tag: &str,
) -> Result<ChannelDto, CommandError> {
    let now = crate::commands::state::now_saved_at();
    let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;

    let tag = new_collection_name(conn, vault, tag)?;
    // A note of that name elsewhere in the space keeps its name: the new
    // page takes the first free one, so links by name stay unambiguous
    // (SPEC_IDENTITY_ROBUSTNESS.md, «Запись и уникальность имён»).
    let occupied = files::scan_vault_file_paths(vault)?;
    let tag = mine_core::save::select_unique_file_stem(&tag, "md", &occupied)
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let mut channel = Channel::new(&tag, dt).map_err(|e| CommandError::Internal(e.to_string()))?;
    // First in the manual order, one write of this page only (Е6.2).
    channel.position = index::new_channel_position(conn)?;

    let block = channel_to_block(&channel);
    // Existing documents keep their paths; new ones follow the configured layout.
    let source_slug = vault.new_collection_slug(&channel.tag);
    let path = vault.block_path(&source_slug);
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::create(
        path,
        serialize_block(&block).into_bytes(),
    )])
    .map_err(CommandError::from)?;
    staged
        .commit_with_index(conn, "create_channel", |index_conn| {
            index::upsert_channel_with_source(index_conn, &channel, Some(source_slug.as_str()))
        })
        .map_err(CommandError::from)?;

    // Get block count for this tag
    let tags = index::get_all_tags(conn)?;
    let count = tags
        .iter()
        .find(|t| t.tag == channel.tag)
        .map(|t| t.count)
        .unwrap_or(0);

    Ok(ChannelDto::from_channel(&channel, count))
}

/// A single item in a reorder request: tag + new position.
#[derive(Debug, Deserialize)]
pub struct ReorderItem {
    pub tag: String,
    pub position: i64,
}

/// Reorder collections by writing each moved one's new `position` into its
/// page. Only existing pages are written: an item without a page is skipped
/// and no file is created, the other positions still apply, and the list read
/// afterwards shows what is really there (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md,
/// К6).
///
/// Off the main thread: it writes one document per moved collection, and a
/// synchronous command held the window still until the last write landed,
/// right at the moment of the drop.
async fn reorder_channels_unannounced(
    app: AppHandle,
    webview: tauri::Webview,
    items: Vec<ReorderItem>,
) -> Result<(), CommandError> {
    let space = crate::commands::state::tab_space(&app.state::<AppState>(), &webview)?;
    tauri::async_runtime::spawn_blocking(move || reorder_channels_blocking(&space, items))
    .await
    .map_err(|error| CommandError::Internal(format!("reorder worker failed: {error}")))?
}

/// [`reorder_channels_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command]
pub async fn reorder_channels(app: AppHandle, webview: tauri::Webview, items: Vec<ReorderItem>) -> Result<(), CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = reorder_channels_unannounced(app, webview, items).await;
    if outcome.is_ok() {
        announcing.send(Vec::new());
    }
    outcome
}

fn reorder_channels_blocking(
    space: &crate::commands::state::OpenSpace,
    items: Vec<ReorderItem>,
) -> Result<(), CommandError> {
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let existing = index::list_channels(&vs.conn)?;
    let existing_by_tag = existing
        .into_iter()
        .map(|channel| (channel.tag.clone(), channel))
        .collect::<HashMap<_, _>>();
    let mut seen = std::collections::HashSet::new();
    let mut planned_channels = Vec::with_capacity(items.len());
    let mut writes = Vec::with_capacity(items.len());
    for item in items {
        let tag = normalize_collection_ref(&item.tag);
        if tag.is_empty() {
            continue;
        }
        validate_collection_ref(&tag).map_err(CommandError::Internal)?;
        if !seen.insert(tag.clone()) {
            return Err(CommandError::Internal(format!(
                "duplicate collection in reorder: {tag}"
            )));
        }
        // Only a collection with a page is reordered: the reorder never
        // creates one (К6). The list read after it shows what is there.
        let Some(existing) = existing_by_tag.get(&tag) else {
            continue;
        };
        // A collection that keeps its place keeps its document untouched.
        if existing.position == item.position {
            continue;
        }
        let mut channel = existing.clone();
        channel.position = item.position;
        // The page went since the index saw it (deleted outside Mine): no
        // page, nothing to write; the watcher drops the row.
        let Some(page) = collection_document_for_mutation(&vs.conn, &vs.vault, &tag)? else {
            continue;
        };
        let path = page.path;
        // A reorder may only write the collection's own document: the file's
        // stem is the collection's name. A tag that resolves to a file with a
        // different stem is a stale index row aimed at another collection's
        // document — before this guard, such a row (e.g. a pre-rename
        // `Collections/Видео` phantom next to the real `Видео`) produced two
        // writes to one path, the staged mutation refused the duplicate, and
        // every reorder in the space rolled back. The phantom row itself is
        // swept out by reconciliation; skipping it here keeps the positions of
        // every real collection applying meanwhile.
        let owns_document = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem == tag.rsplit('/').next().unwrap_or(&tag));
        if !owns_document {
            continue;
        }
        let source_slug = vs
            .vault
            .slug_for_path(&path)
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        // The page is the user's note: its text, properties and membership
        // stay; only `position` changes. The write replaces exactly the bytes
        // the page was found with, so a page edited or removed since refuses
        // the reorder instead of being recreated.
        let content = String::from_utf8(page.read).map_err(|error| {
            CommandError::Internal(format!("collection page is not UTF-8: {error}"))
        })?;
        let before = parse_markdown_document(&source_slug, &content, channel.created_at.clone())
            .map_err(|error| CommandError::Internal(error.to_string()))?
            .block;
        let mut after = before.clone();
        after.frontmatter.position = Some(channel.position);
        let patched = apply_block_changes(&content, &before, &after).map_err(|_| {
            CommandError::FrontmatterNotWritable {
                path: path.display().to_string(),
            }
        })?;
        writes.push(SourceFileWrite::replace(path, content.into_bytes(), patched.into_bytes()));
        planned_channels.push((channel, source_slug));
    }

    let staged = StagedSourceMutation::stage(writes).map_err(CommandError::from)?;
    staged
        .commit_with_index(&vs.conn, "reorder_channels", |index_conn| {
            for (channel, source_slug) in &planned_channels {
                index::upsert_channel_with_source(index_conn, channel, Some(source_slug.as_str()))?;
            }
            Ok(())
        })
        .map_err(CommandError::from)?;
    Ok(())
}

/// Rename a collection: its page, its name in every member's
/// `Mine Collections`, and every link to the page in the text and in
/// `Mine Related Notes`, in one source mutation (SPEC_DEEP_AUDIT.md, Н2).
fn rename_channel_unannounced(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<ChannelDto, CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    rename_channel_inner(Some(&state), &vs.conn, &vs.vault, &old_tag, &new_tag)
}

/// [`rename_channel_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(async, rename_all = "snake_case")]
pub fn rename_channel(webview: tauri::Webview, state: State<'_, AppState>, old_tag: String, new_tag: String) -> Result<ChannelDto, CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let renamed_from = old_tag.clone();
    let outcome = rename_channel_unannounced(webview, state, old_tag, new_tag);
    if let Ok(renamed) = &outcome {
        // The name the collection took, as normalized, not as typed.
        announcing.send(vec![super::effects::SpaceRename::collection(&renamed_from, &renamed.tag)],
        );
    }
    outcome
}

/// Rename the collection `old_tag` to `new_tag`. The index is brought up to
/// the files first, so the members are the ones the files name
/// (SPEC_DEEP_AUDIT.md, Н2, Е1.4).
pub(crate) fn rename_channel_inner(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    old_tag: &str,
    new_tag: &str,
) -> Result<ChannelDto, CommandError> {
    reconcile_before_collection_mutation(conn, vault)?;
    rename_reconciled_collection(state, conn, vault, old_tag, new_tag).map(|renamed| renamed.channel)
}

/// Whether the note `slug` is a collection page: its file says
/// `type: channel`. A missing file is no page.
pub(crate) fn is_collection_page(vault: &VaultLayout, slug: &str) -> Result<bool, CommandError> {
    let path = vault.block_path(slug);
    if !path.is_file() {
        return Ok(false);
    }
    let (read_slug, content) = files::read_block_file(vault, &path)?;
    let parsed = parse_markdown_document(&read_slug, &content, file_saved_at(&path))
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    Ok(parsed.block.frontmatter.block_type == BlockType::Channel)
}

/// Rename the collection whose page is the note `page_slug` to the name
/// `new_stem` gives, the way a card's rename names it (a bare name stays in
/// the page's folder). A collection page renamed as a note is its collection
/// renamed, membership included (SPEC_DEEP_AUDIT.md, Н2, Е1.5). Returns the
/// page's new slug.
pub(crate) fn rename_collection_page(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    page_slug: &str,
    new_slug: &str,
) -> Result<String, CommandError> {
    let folder = |slug: &str| slug.rsplit_once('/').map(|(folder, _)| folder.to_string());
    if folder(page_slug) != folder(new_slug) {
        return Err(CommandError::NameRefused(
            "A collection stays in its folder: type its name without /.".into(),
        ));
    }
    reconcile_before_collection_mutation(conn, vault)?;
    let tag = index::channel_page_slugs(conn)?
        .into_iter()
        .find_map(|(tag, page)| (page == page_slug).then_some(tag))
        .ok_or_else(|| CommandError::CollectionNotFound {
            collection: crate::domain::collection::collection_ref_from_slug(page_slug),
        })?;
    let name = new_slug.rsplit('/').next().unwrap_or(new_slug);
    let renamed = rename_reconciled_collection(state, conn, vault, &tag, name)?;
    Ok(renamed.page_slug.unwrap_or_else(|| page_slug.to_string()))
}

/// What a collection rename did.
struct CollectionRenamed {
    channel: ChannelDto,
    /// The page's new slug; `None` when the name did not change.
    page_slug: Option<String>,
}

/// Bring the index up to the files before a collection mutation reads the
/// collection's members and pages from it: a card connected in Obsidian
/// while nothing watched the space is a member, as its file says
/// (SPEC_DEEP_AUDIT.md, Н2). Notes the pass cannot read, or whose contents
/// are in iCloud, stay as the index held them (SPEC_CLOUD_STORAGE.md, Х12);
/// the mutation reads its candidates again from disk.
fn reconcile_before_collection_mutation(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
) -> Result<(), CommandError> {
    crate::storage::reconcile::reconcile_vault_for_action(conn, vault)
        .map(|_| ())
        .map_err(|error| {
            CommandError::Internal(format!("bring the index up to the files: {error}"))
        })
}

/// Rename the collection in a membership list, in place: a link by name
/// gets the new name, a link by the page's path the page's new path
/// (`renamed_collection_link`, SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К4).
fn rename_membership(tags: &mut Vec<String>, old: (&str, &str), new: (&str, &str)) {
    let rename = |tag: &str| {
        crate::domain::collection::renamed_collection_link(tag, old.0, Some(old.1), new.0, Some(new.1))
    };
    if !tags.iter().any(|tag| rename(tag).is_some()) {
        return;
    }
    let mut renamed: Vec<String> = Vec::with_capacity(tags.len());
    for tag in tags.drain(..) {
        let tag = rename(&tag).unwrap_or(tag);
        if !renamed.contains(&tag) {
            renamed.push(tag);
        }
    }
    *tags = renamed;
}

/// The rename over an index already brought up to the files.
///
/// The page moves and the notes that link it are rewritten by the card
/// rename's own plan (`plan_note_move`: wikilinks and Markdown links in the
/// text, `Mine Related Notes`, SPEC_AUDIT_FIXES.md, Ф3), with the members'
/// `Mine Collections` renamed in the same pass; a member the index knows that
/// the pass did not reach is added. Every note is written over the bytes it
/// was read from (Ф1, Ф2), in one source mutation with the index.
fn rename_reconciled_collection(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    old_tag: &str,
    new_tag: &str,
) -> Result<CollectionRenamed, CommandError> {
    let plan = CollectionRename::plan(conn, vault, old_tag, new_tag)?;
    let Some(page_move) = plan.page_move else {
        // The same name after normalization: nothing to write.
        return Ok(CollectionRenamed {
            channel: channel_dto(conn, &plan.existing)?,
            page_slug: None,
        });
    };
    let CollectionRename {
        old: normalized_old,
        new: normalized_new,
        ..
    } = plan;
    let PageMove {
        from: old_path,
        to: new_path,
        slug: new_slug,
    } = page_move;
    let old_slug = vault
        .slug_for_path(&old_path)
        .map_err(|error| CommandError::Internal(error.to_string()))?;

    let retag = |tags: &mut Vec<String>| {
        rename_membership(tags, (&normalized_old, &old_slug), (&normalized_new, &new_slug));
    };
    let mut planned = crate::commands::blocks::plan_note_move(conn, vault, &old_slug, &new_slug, &retag)
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let mut reached: std::collections::BTreeSet<std::path::PathBuf> =
        planned.iter().map(|write| write.original_path.clone()).collect();
    // Members name the collection by its name or by its page's path (К4).
    let mut members = index::list_blocks_by_tag(conn, &normalized_old)?;
    members.extend(index::list_blocks_by_tag(conn, &old_slug)?);
    for member in members {
        if member.slug.is_empty() {
            continue;
        }
        let path = vault.block_path(&member.slug);
        if !reached.insert(path.clone()) {
            continue;
        }
        let (read_slug, content) = files::read_block_file(vault, &path)?;
        let before = parse_markdown_document(&read_slug, &content, file_saved_at(&path))
            .map_err(|error| CommandError::Internal(error.to_string()))?
            .block;
        let mut block = before.clone();
        retag(&mut block.frontmatter.tags);
        if block.frontmatter.tags == before.frontmatter.tags {
            continue;
        }
        planned.push(crate::commands::blocks::PlannedBlockWrite {
            original_path: path.clone(),
            target_path: path,
            source: content,
            before,
            block,
        });
    }

    // The page went since the plan found it: the rename never makes a new
    // one in its place (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К5).
    if !old_path.exists() {
        return Err(CommandError::CollectionNotFound {
            collection: normalized_old,
        });
    }
    let mut writes = Vec::with_capacity(planned.len());
    let mut written = Vec::with_capacity(planned.len());
    for write in &planned {
        let patched = apply_block_changes(&write.source, &write.before, &write.block).map_err(|_| {
            CommandError::FrontmatterNotWritable {
                path: write.original_path.display().to_string(),
            }
        })?;
        let expected = write.source.clone().into_bytes();
        writes.push(match (write.original_path == old_path, patched == write.source) {
            // The page carries no name inside it: renaming it renames the
            // file, its text and properties move unchanged.
            (true, true) => SourceFileWrite::rename(old_path.clone(), new_path.clone()),
            (true, false) => SourceFileWrite::rename_with_bytes(
                old_path.clone(),
                new_path.clone(),
                expected,
                patched.into_bytes(),
            ),
            (false, _) => SourceFileWrite::replace(write.target_path.clone(), expected, patched.into_bytes()),
        });
        written.push(write.target_path.clone());
    }
    if !planned.iter().any(|write| write.original_path == old_path) {
        writes.push(SourceFileWrite::rename(old_path.clone(), new_path.clone()));
        written.push(new_path.clone());
    }

    // Watcher suppression is only meaningful inside the app process; a CLI
    // mutation must stay visible to the app's watcher.
    if let Some(state) = state {
        state.suppress_paths(
            std::iter::once(old_path.clone()).chain(writes.iter().map(|write| write.path.clone())),
            Duration::from_millis(SOURCE_MUTATION_WATCHER_SUPPRESSION_MS),
        )?;
    }
    let staged = StagedSourceMutation::stage(writes).map_err(CommandError::from)?;
    staged
        .commit_with_index(conn, "rename_channel", |index_conn| {
            crate::storage::reconcile::remove_source_projection(index_conn, vault, &old_slug)?;
            index::remove_channel(index_conn, &normalized_old)?;
            for path in &written {
                crate::storage::reconcile::project_source_path(index_conn, vault, path)?;
            }
            Ok(())
        })
        .map_err(CommandError::from)?;

    // The page is indexed under the name its file now resolves to.
    let page_tag = index::channel_page_slugs(conn)?
        .into_iter()
        .find_map(|(tag, page)| (page == new_slug).then_some(tag))
        .unwrap_or_else(|| normalized_new.clone());
    let channel = index::list_channels(conn)?
        .into_iter()
        .find(|channel| channel.tag == page_tag)
        .ok_or_else(|| {
            CommandError::Internal(format!(
                "renamed collection {normalized_new} is missing from the index"
            ))
        })?;
    Ok(CollectionRenamed {
        channel: channel_dto(conn, &channel)?,
        page_slug: Some(new_slug),
    })
}

fn channel_dto(conn: &rusqlite::Connection, channel: &Channel) -> Result<ChannelDto, CommandError> {
    let count = index::get_all_tags(conn)?
        .iter()
        .find(|tag| tag.tag == channel.tag)
        .map(|tag| tag.count)
        .unwrap_or(0);
    Ok(ChannelDto::from_channel(channel, count))
}

// ─── Names ──────────────────────────────────────────────────────────────────
//
// A collection's name follows the rules of every name the user types (the
// card's file name too, `name_problem`), and a refusal says why in words the
// sidebar shows under the name (05.10.2026).

/// A collection name the user typed, normalized, or why it is refused.
fn typed_collection_name(raw: &str) -> Result<String, CommandError> {
    let name = normalize_typed_name(raw);
    match name_problem(&name) {
        Some(reason) => Err(CommandError::NameRefused(reason.to_string())),
        None => Ok(name),
    }
}

/// The name of a new collection, or why it is refused: the shared rules, no
/// folder, no other collection called that.
fn new_collection_name(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    raw: &str,
) -> Result<String, CommandError> {
    let name = typed_collection_name(raw)?;
    if name.contains('/') {
        return Err(CommandError::NameRefused(
            "A new collection cannot be in a folder: type its name without /.".into(),
        ));
    }
    refuse_collection_called(conn, vault, &name, None)?;
    Ok(name)
}

/// Refuses `name` when another collection is called that, letter case aside
/// (Obsidian finds a note by its name in any case). `renamed` is the
/// collection being renamed: its own name is not in the way.
///
/// A collection is its page (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1): an
/// index row whose page is gone from disk holds no name. Such a row lasts
/// while no watcher saw the page go: for the CLI and the MCP with the app
/// closed, in the app until its watcher hears of it. Only a row with the
/// name sends the check to the disk; a page that cannot be read keeps the
/// name taken.
fn refuse_collection_called(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    name: &str,
    renamed: Option<&str>,
) -> Result<(), CommandError> {
    let lowered = name.to_lowercase();
    for channel in index::list_channels(conn)? {
        if Some(channel.tag.as_str()) == renamed || channel.tag.to_lowercase() != lowered {
            continue;
        }
        if matches!(collection_pages_on_disk(vault, &channel.tag), Ok(pages) if pages.is_empty()) {
            continue;
        }
        return Err(CommandError::NameRefused(format!(
            "A collection named \"{}\" already exists.",
            name.rsplit('/').next().unwrap_or(name)
        )));
    }
    Ok(())
}

/// A collection rename the rules let through, planned before anything is
/// written. The check while the name is typed stops here.
struct CollectionRename {
    old: String,
    new: String,
    existing: Channel,
    /// Where the page moves; `None` when the new name is the old one.
    page_move: Option<PageMove>,
}

/// The collection's page, from its place to the new name's place.
struct PageMove {
    from: std::path::PathBuf,
    to: std::path::PathBuf,
    /// The slug of `to`.
    slug: String,
}

impl CollectionRename {
    fn plan(
        conn: &rusqlite::Connection,
        vault: &VaultLayout,
        old_tag: &str,
        new_tag: &str,
    ) -> Result<Self, CommandError> {
        let old = normalize_collection_ref(old_tag);
        validate_collection_ref(&old).map_err(CommandError::Internal)?;
        let requested = typed_collection_name(new_tag)?;
        // A bare name stays in the collection's folder; a name with a folder
        // may only name that same folder.
        let old_parent = old.rsplit_once('/').map(|(parent, _)| parent);
        let new = match (requested.rsplit_once('/'), old_parent) {
            (Some((parent, _)), _) if Some(parent) != old_parent => {
                return Err(CommandError::NameRefused(
                    "A collection stays in its folder: type its name without /.".into(),
                ));
            }
            (None, Some(parent)) => format!("{parent}/{requested}"),
            _ => requested,
        };
        validate_collection_ref(&new).map_err(CommandError::Internal)?;
        // A collection exists only as its page: without one there is nothing
        // to rename, and no page is made for it (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md).
        let existing = index::list_channels(conn)?
            .into_iter()
            .find(|channel| channel.tag == old)
            .ok_or_else(|| CommandError::CollectionNotFound { collection: old.clone() })?;
        if new == old {
            return Ok(Self {
                old,
                new,
                existing,
                page_move: None,
            });
        }
        refuse_collection_called(conn, vault, &new, Some(&old))?;

        // Rename in place: a collection that lives in its own folder must
        // stay there, so the new page is written beside the old one rather
        // than in the vault root.
        let from = collection_document_for_mutation(conn, vault, &old)?
            .map(|page| page.path)
            .ok_or_else(|| CommandError::CollectionNotFound { collection: old.clone() })?;
        let file_name = format!("{}.md", new.rsplit('/').next().unwrap_or(&new));
        let to = from
            .parent()
            .map(|parent| parent.join(&file_name))
            .unwrap_or_else(|| vault.block_path(&new));
        let slug = vault
            .slug_for_path(&to)
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        // A note already there (a card of that name in the folder) keeps its
        // file: the page moves to a free name only, as a card's file does.
        // The page's own name in other letter case finds the page itself
        // where the disk ignores case, and is free (06.10.2026).
        if (to.exists() && !files::names_same_entry(&from, &to)) || index::slug_exists(conn, &slug)? {
            return Err(CommandError::NameRefused(format!(
                "A file named \"{file_name}\" already exists."
            )));
        }
        Ok(Self {
            old,
            new,
            existing,
            page_move: Some(PageMove { from, to, slug }),
        })
    }
}

fn file_saved_at(path: &std::path::Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    DateTime::new(&crate::util::system_time_to_iso8601(time))
        // infallible inner unwrap: parsing a hardcoded valid ISO-8601 literal.
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

/// Sidebar preview: slug + whether it's a text-only thumbnail (for dark mode invert).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PreviewItem {
    pub slug: String,
    /// True for text-only articles (baked text thumbnail needs CSS invert in dark mode).
    pub text: bool,
    /// Unix timestamp (seconds) of the thumb file's last modification.
    /// Frontend uses this as a cache-buster (`?m=<mtime>`) so the browser
    /// refetches when the file changes on disk (e.g. Phase 2 worker
    /// overwrites a PNG placeholder with a decoded JPEG).
    pub mtime: u64,
    /// True if the thumb file exists on disk. False means the block was
    /// just saved and Phase 1/2 hasn't produced a thumb yet. Frontend
    /// renders a neutral placeholder tile for `has_thumb=false` so the
    /// card never collapses to empty space. Renamed from camelCase at
    /// the serde boundary via the struct default (snake_case in JSON).
    pub has_thumb: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ChannelPreviewsSnapshot {
    pub generation: projection::ProjectionRevision,
    pub previews: HashMap<String, Vec<PreviewItem>>,
}

/// Return preview items per channel for sidebar thumbnails.
/// Includes `__all__` key for all blocks regardless of channel.
/// Max `limit` thumbnails per channel.
#[tauri::command]
pub async fn list_channel_previews(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    limit: usize,
) -> Result<ChannelPreviewsSnapshot, CommandError> {
    let vault = tab_layout(&state, &webview)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    tauri::async_runtime::spawn_blocking(
        move || -> Result<ChannelPreviewsSnapshot, CommandError> {
            read_owned_projection(&app, &vault, |conn| {
                Ok(projection::read_projection_snapshot(
                    conn,
                    |conn, generation| {
                        let tags = index::get_all_tags(conn)?;
                        let all_previews = index::list_preview_blocks(conn, limit)?;
                        let per_tag_previews = index::list_preview_blocks_by_tag(conn, limit)?;

                        let to_item = |preview: &index::PreviewBlock| -> PreviewItem {
                            PreviewItem {
                                slug: preview.slug.clone(),
                                // Text-ness comes from the preview manifest, not
                                // from the thumbnail's format: a transparent
                                // picture is stored as PNG as well.
                                text: preview.is_text,
                                mtime: preview.thumb_mtime,
                                has_thumb: preview.thumb_format.is_some(),
                            }
                        };

                        let mut previews = HashMap::new();
                        previews.insert(
                            "__all__".to_string(),
                            all_previews.iter().map(to_item).collect(),
                        );
                        for (tag, items) in per_tag_previews {
                            previews.insert(tag, items.iter().map(to_item).collect());
                        }
                        for tag in &tags {
                            previews.entry(tag.tag.clone()).or_default();
                        }

                        Ok(ChannelPreviewsSnapshot {
                            generation,
                            previews,
                        })
                    },
                )?)
            })
        },
    )
    .await
    .map_err(|e| CommandError::Internal(format!("list_channel_previews task join failed: {e}")))?
}

/// What deleting a collection did (SPEC_DEEP_AUDIT.md, Н2, Е1.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct CollectionDeleted {
    /// Whether there was a collection to delete: its page or its row.
    pub deleted: bool,
    /// Cards that still link the collection, by slug: the deletion could not
    /// read them, or their properties cannot take the change in place. Their
    /// files are as they were; every other link is gone.
    pub kept_links: Vec<String>,
}

/// Delete a collection: take its link off every card that has it and send its
/// page to the Trash, as it was read, in one source mutation with the index
/// (SPEC_DEEP_AUDIT.md, Н2).
fn delete_channel_unannounced(webview: tauri::Webview, state: State<'_, AppState>, tag: String) -> Result<CollectionDeleted, CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    delete_channel_inner(Some(&state), &vs.conn, &vs.vault, &tag)
}

/// [`delete_channel_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(async)]
pub fn delete_channel(webview: tauri::Webview, state: State<'_, AppState>, tag: String) -> Result<CollectionDeleted, CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = delete_channel_unannounced(webview, state, tag);
    if outcome.is_ok() {
        announcing.send(Vec::new());
    }
    outcome
}

/// The one deletion of a collection the app, the CLI and the MCP run. The
/// index is brought up to the files first, so the members are the ones the
/// files name (SPEC_DEEP_AUDIT.md, Н2).
pub(crate) fn delete_channel_inner(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    tag: &str,
) -> Result<CollectionDeleted, CommandError> {
    reconcile_before_collection_mutation(conn, vault)?;
    ChannelDeletion::plan(conn, vault, tag)?
        .with_members(conn, vault)?
        .apply(state, conn, vault)
}

/// A collection deletion, planned from the collection's page as it was read
/// (`SPEC_AUDIT_FIXES.md`, Ф2, Д2.6) and from its members as their files say.
struct ChannelDeletion {
    tag: String,
    page: Option<CollectionPage>,
    /// The members' links taken off, each written over the bytes it was
    /// read from.
    members: Vec<(SourceFileWrite, crate::commands::tags::BlockProjection)>,
    kept_links: Vec<String>,
}

impl ChannelDeletion {
    fn plan(
        conn: &rusqlite::Connection,
        vault: &VaultLayout,
        tag: &str,
    ) -> Result<Self, CommandError> {
        let tag = normalize_collection_ref(tag);
        if tag.is_empty() {
            return Err(CommandError::Internal("collection ref is empty".into()));
        }
        validate_collection_ref(&tag).map_err(CommandError::Internal)?;
        let page = collection_document_for_mutation(conn, vault, &tag)?;
        Ok(Self {
            tag,
            page,
            members: Vec::new(),
            kept_links: Vec::new(),
        })
    }

    /// Take the collection's link off every member. A member that cannot be
    /// read, or whose properties cannot take the change in place, keeps its
    /// link and is named; it does not stop the deletion (Е1.3).
    fn with_members(mut self, conn: &rusqlite::Connection, vault: &VaultLayout) -> Result<Self, CommandError> {
        let page_path = self.page.as_ref().map(|page| page.path.clone());
        // Members name the collection by its name or by its page's path (К4).
        let mut members = index::list_blocks_by_tag(conn, &self.tag)?;
        if let Some(page) = &self.page {
            members.extend(index::list_blocks_by_tag(conn, &page.slug)?);
        }
        let mut seen = std::collections::BTreeSet::new();
        for member in members {
            if member.slug.is_empty() || !seen.insert(member.slug.clone()) {
                continue;
            }
            let path = vault.block_path(&member.slug);
            if Some(&path) == page_path.as_ref() {
                continue;
            }
            match self.member_rewrite(vault, &member.slug, path) {
                Ok(Some(rewrite)) => self.members.push(rewrite.into_source_write()),
                Ok(None) => {}
                Err(error) => {
                    log::warn!(
                        "collection {} deleted without its link in {}: {error}",
                        self.tag,
                        member.slug
                    );
                    self.kept_links.push(member.slug);
                }
            }
        }
        Ok(self)
    }

    fn member_rewrite(
        &self,
        vault: &VaultLayout,
        slug: &str,
        path: std::path::PathBuf,
    ) -> Result<Option<MembershipRewrite>, CommandError> {
        let (read_slug, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&read_slug, &content, file_saved_at(&path))
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        let mut collections = parsed.block.frontmatter.tags;
        let before = collections.len();
        let page_slug = self.page.as_ref().map(|page| page.slug.as_str());
        collections.retain(|collection| {
            !crate::domain::collection::link_names_collection(collection, &self.tag, page_slug)
        });
        if collections.len() == before {
            // The file no longer names it: nothing to take off.
            return Ok(None);
        }
        MembershipRewrite::prepare(vault, slug, path, content, &collections).map(Some)
    }

    /// Take the links off and send the page to the Trash only as the plan
    /// read them: an edit made since, in Obsidian or by iCloud, stays, and
    /// the deletion refuses with `SourceChanged`, leaving every file and the
    /// collection's record as they are.
    fn apply(
        self,
        state: Option<&AppState>,
        conn: &rusqlite::Connection,
        vault: &VaultLayout,
    ) -> Result<CollectionDeleted, CommandError> {
        let mut writes = Vec::with_capacity(self.members.len() + 1);
        let mut projections = Vec::with_capacity(self.members.len());
        for (write, projection) in self.members {
            writes.push(write);
            projections.push(projection);
        }
        let mut slugs = Vec::new();
        if let Some(page) = self.page {
            writes.push(SourceFileWrite::delete_if_unchanged(page.path, page.read));
            slugs.push(page.slug);
        }
        if let Some(state) = state {
            state.suppress_paths(
                writes.iter().map(|write| write.path.clone()),
                Duration::from_millis(SOURCE_MUTATION_WATCHER_SUPPRESSION_MS),
            )?;
        }
        let tag = self.tag;
        let staged = StagedSourceMutation::stage(writes).map_err(CommandError::from)?;
        let deleted = staged
            .commit_with_index(conn, "delete_channel", |index_conn| {
                for projection in &projections {
                    projection.upsert(index_conn, vault)?;
                }
                for slug in &slugs {
                    index::remove_block(index_conn, slug)?;
                }
                let removed = index::remove_channel(index_conn, &tag)?;
                Ok(removed || !slugs.is_empty())
            })
            .map_err(CommandError::from)?;
        Ok(CollectionDeleted {
            deleted,
            kept_links: self.kept_links,
        })
    }
}

/// A collection's page as a mutation found it.
struct CollectionPage {
    path: std::path::PathBuf,
    slug: String,
    /// The bytes read and found to be a collection page.
    read: Vec<u8>,
}

/// The collection pages on disk `collection_ref` can name: the notes with
/// its file name (its path, for a path-qualified one) and `type: channel`,
/// found by the files, not by the index.
fn collection_pages_on_disk(
    vault: &VaultLayout,
    collection_ref: &str,
) -> Result<Vec<CollectionPage>, CommandError> {
    let candidates =
        crate::storage::media_refs::collection_document_candidates(vault, collection_ref).map_err(
            |error| CommandError::Internal(format!("find collection documents: {error}")),
        )?;
    let fallback_date = DateTime::new(&crate::commands::state::now_saved_at())
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let mut pages = Vec::new();
    for path in candidates {
        let (slug, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&slug, &content, fallback_date.clone())
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        if parsed.block.frontmatter.block_type == BlockType::Channel {
            pages.push(CollectionPage {
                path,
                slug,
                read: content.into_bytes(),
            });
        }
    }
    Ok(pages)
}

/// Resolve a collection mutation to one source page. A bare name shared by
/// multiple collection pages is ambiguous and must not mutate either page.
fn collection_document_for_mutation(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    collection_ref: &str,
) -> Result<Option<CollectionPage>, CommandError> {
    let mut pages = collection_pages_on_disk(vault, collection_ref)?;
    if let Some(source_slug) = index::channel_source_slug(conn, collection_ref)? {
        if let Some(position) = pages.iter().position(|page| page.slug == source_slug) {
            return Ok(Some(pages.swap_remove(position)));
        }
    }
    let page_count = pages.len();
    let mut slugs: std::collections::BTreeSet<String> =
        pages.iter().map(|page| page.slug.clone()).collect();
    for path in files::scan_vault_file_paths(vault)? {
        if let Some(slug) = path.strip_suffix(".md") {
            slugs.insert(slug.to_string());
        }
    }
    let mut matches = pages.into_iter().filter(|page| {
        crate::domain::collection::collection_ref_for_slug(&page.slug, &slugs) == collection_ref
    });
    let result = matches.next();
    if matches.next().is_some()
        || (result.is_none() && page_count > 1 && !collection_ref.contains('/'))
    {
        return Err(CommandError::Internal(format!(
            "collection reference '{collection_ref}' is ambiguous; use its path"
        )));
    }
    Ok(result)
}

/// The collection an Are.na import writes its cards into
/// (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К5).
pub(crate) enum ImportCollection {
    /// The page of that name is there: its collection is reused.
    Page(String),
    /// No page yet: one is made under this name, which the rules of a new
    /// collection name let through, the way `create_channel` makes it.
    Create(String),
}

/// Where an import of a channel called `name` puts its cards: the page with
/// this name when there is one (found as rename and delete find it),
/// otherwise a new page. A name the rules of a new collection refuse
/// refuses the import of this channel, before any card is written.
pub(crate) fn import_collection(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    name: &str,
) -> Result<ImportCollection, CommandError> {
    let collection_ref = normalize_collection_ref(name);
    if !collection_ref.is_empty()
        && validate_collection_ref(&collection_ref).is_ok()
        && collection_document_for_mutation(conn, vault, &collection_ref)?.is_some()
    {
        return Ok(ImportCollection::Page(collection_ref));
    }
    Ok(ImportCollection::Create(new_collection_name(conn, vault, name)?))
}

/// The one check every path that writes a new link into `Mine Collections`
/// runs before it writes (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7): the
/// collection `collection_ref` has a page. The page is found the way the
/// rename, the deletion and Reveal in Finder find it
/// ([`collection_document_for_mutation`]): by the files on disk, not only by
/// the index row. No page refuses with [`CommandError::CollectionNotFound`];
/// a bare name shared by several pages refuses with the same ambiguity error
/// those commands give. Disconnecting needs no page (К8) and never calls it.
pub(crate) fn require_collection_page(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    collection_ref: &str,
) -> Result<(), CommandError> {
    match collection_document_for_mutation(conn, vault, collection_ref)? {
        Some(_) => Ok(()),
        None => Err(CommandError::CollectionNotFound {
            collection: collection_ref.to_string(),
        }),
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Convert a Channel to a Block with type: channel for writing to .md file.
fn channel_to_block(channel: &Channel) -> Block {
    Block {
        slug: channel.tag.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Channel,
            title: None,
            description: channel.description.clone(),
            url: None,
            file: None,
            thumbnail: None,
            tags: Vec::new(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at: channel.created_at.clone(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: Some(channel.position),
            color: channel.color.clone(),
            icon: channel.icon.clone(),
        },
        body: String::new(),
    }
}

fn load_channels(conn: &rusqlite::Connection) -> anyhow::Result<Vec<ChannelDto>> {
    let channels = index::list_channels(conn)?;
    let tags = index::get_all_tags(conn)?;
    let tag_counts: HashMap<String, usize> =
        tags.into_iter().map(|tag| (tag.tag, tag.count)).collect();

    Ok(channels
        .iter()
        .map(|ch| {
            let count = tag_counts.get(&ch.tag).copied().unwrap_or(0);
            ChannelDto::from_channel(ch, count)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reorder_writes_only_the_collections_that_moved() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"))
            .with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        for (name, position) in [("Art", 0), ("Cities", 1), ("Games", 2)] {
            std::fs::write(
                vault.block_path(&format!("Collections/{name}")),
                format!("---\ntype: channel\nposition: {position}\nsaved_at: 2026-04-25T14:00:40Z\n---\n"),
            )
            .unwrap();
        }
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let state = AppState::new();
        let main_space = state.open_space_for_test("main", crate::commands::state::VaultState {
            conn,
            vault: vault.clone(),
        });
        let art_before = std::fs::read(vault.block_path("Collections/Art")).unwrap();

        // Games moves above Cities; Art keeps its place.
        reorder_channels_blocking(
            &main_space,
            vec![
                ReorderItem { tag: "Art".into(), position: 0 },
                ReorderItem { tag: "Games".into(), position: 1 },
                ReorderItem { tag: "Cities".into(), position: 2 },
            ],
        )
        .unwrap();

        assert_eq!(std::fs::read(vault.block_path("Collections/Art")).unwrap(), art_before);
        let games = std::fs::read_to_string(vault.block_path("Collections/Games")).unwrap();
        assert!(games.contains("position: 1"), "{games}");
        let cities = std::fs::read_to_string(vault.block_path("Collections/Cities")).unwrap();
        assert!(cities.contains("position: 2"), "{cities}");
    }

    /// Every file path of the space, relative to its root, sorted.
    fn space_paths(vault: &VaultLayout) -> Vec<String> {
        let mut paths = files::scan_vault_file_paths(vault).unwrap();
        paths.sort();
        paths
    }

    /// К6 (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md): a reorder that names a
    /// collection without a page creates no file; the pages that moved get
    /// their positions.
    #[test]
    fn a_reorder_creates_no_page_for_a_name_without_one() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"))
            .with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        for (name, position) in [("Art", 0), ("Cities", 1)] {
            std::fs::write(
                vault.block_path(&format!("Collections/{name}")),
                format!("---\ntype: channel\nposition: {position}\nsaved_at: 2026-04-25T14:00:40Z\n---\n"),
            )
            .unwrap();
        }
        // A card links a name that has no page.
        std::fs::write(
            vault.block_path("Cards/Loose"),
            "---\nsaved_at: 2026-04-25T14:00:40Z\nMine Collections:\n  - \"[[Pageless]]\"\n---\nBody",
        )
        .unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let state = AppState::new();
        let main_space = state.open_space_for_test("main", crate::commands::state::VaultState {
            conn,
            vault: vault.clone(),
        });
        let files_before = space_paths(&vault);

        reorder_channels_blocking(
            &main_space,
            vec![
                ReorderItem { tag: "Pageless".into(), position: 0 },
                ReorderItem { tag: "Cities".into(), position: 1 },
                ReorderItem { tag: "Art".into(), position: 2 },
            ],
        )
        .unwrap();

        assert_eq!(space_paths(&vault), files_before, "the reorder created a file");
        let cities = std::fs::read_to_string(vault.block_path("Collections/Cities")).unwrap();
        assert!(cities.contains("position: 1"), "{cities}");
        let art = std::fs::read_to_string(vault.block_path("Collections/Art")).unwrap();
        assert!(art.contains("position: 2"), "{art}");
        let guard = main_space.vault_state.lock().unwrap();
        let conn = &guard.as_ref().unwrap().conn;
        let listed: Vec<(String, i64)> = index::list_channels(conn)
            .unwrap()
            .into_iter()
            .map(|channel| (channel.tag, channel.position))
            .collect();
        assert_eq!(listed, vec![("Cities".to_string(), 1), ("Art".to_string(), 2)]);
    }

    /// «Что не меняется» (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md): a rename needs
    /// the page; without one it refuses with `CollectionNotFound`, writes
    /// nothing and makes no page.
    #[test]
    fn renaming_a_collection_without_a_page_refuses_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        std::fs::write(
            vault.block_path("Loose"),
            "---\nsaved_at: 2026-04-25T14:00:40Z\nMine Collections:\n  - \"[[Pageless]]\"\n---\nBody",
        )
        .unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let before = space_files(&vault);

        let refused = rename_channel_inner(None, &conn, &vault, "Pageless", "Renamed");

        match refused {
            Err(CommandError::CollectionNotFound { collection }) => assert_eq!(collection, "Pageless"),
            other => panic!("expected CollectionNotFound, got {other:?}"),
        }
        assert_eq!(space_files(&vault), before);
        assert!(matches!(
            check_collection_name_inner(&conn, &vault, Some("Pageless"), "Renamed"),
            Err(CommandError::CollectionNotFound { .. })
        ));
    }

    #[test]
    fn new_collection_uses_layout_despite_legacy_root_collection() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf()).with_write_layout(
            crate::domain::vault::VaultWriteLayout {
                cards: "Notes".into(),
                media: "Assets".into(),
                collections: "Groups/Sets".into(),
            },
        );
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let legacy = "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n";
        std::fs::write(vault.block_path("Legacy"), legacy).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        create_channel_inner(&conn, &vault, "New").unwrap();
        assert!(vault.block_path("Groups/Sets/New").exists());
        assert!(!vault.block_path("New").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Legacy")).unwrap(),
            legacy
        );
    }

    #[test]
    fn collection_delete_requires_exact_ref_when_pages_share_a_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let channel = "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n";
        let article = "---\ntype: article\nsaved_at: 2026-04-25T14:00:40Z\n---\nKeep this note";
        for name in ["Design", "Collections/Design"] {
            std::fs::write(vault.block_path(name), channel).unwrap();
        }
        std::fs::write(vault.block_path("Cards/Design"), article).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        assert!(delete_channel_inner(None, &conn, &vault, "Design").unwrap().deleted);
        assert!(!vault.block_path("Design").exists());
        assert!(vault.block_path("Collections/Design").exists());
        assert!(delete_channel_inner(None, &conn, &vault, "Collections/Design").unwrap().deleted);
        assert!(!vault.block_path("Collections/Design").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Design")).unwrap(),
            article
        );
        for _ in 0..2 {
            crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
            assert!(index::list_channels(&conn).unwrap().is_empty());
        }
        assert!(!delete_channel_inner(None, &conn, &vault, "Design").unwrap().deleted);
    }

    /// Д2.6: the page is edited after the deletion read it. The edit is not
    /// sent to the Trash: the deletion refuses, the page stays as edited and
    /// the collection stays listed.
    #[test]
    fn deleting_a_collection_refuses_when_its_page_changed_after_it_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let deletion = ChannelDeletion::plan(&conn, &vault, "Photos").unwrap();
        let edited = WRITTEN_PAGE.replace("Why I keep these.", "Why I keep these, edited in Obsidian.");
        std::fs::write(vault.block_path("Collections/Photos"), &edited).unwrap();

        let refused = deletion.apply(None, &conn, &vault);

        assert!(matches!(refused, Err(CommandError::SourceChanged { .. })), "{refused:?}");
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            edited
        );
        let listed: Vec<String> = index::list_channels(&conn)
            .unwrap()
            .into_iter()
            .map(|channel| channel.tag)
            .collect();
        assert_eq!(listed, ["Photos"]);
    }

    #[test]
    fn a_collection_page_is_found_where_it_lives_for_reveal_in_finder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        std::fs::write(
            dir.path().join("Collections").join("Design.md"),
            "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
        )
        .unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        assert_eq!(
            collection_page_path_inner(&conn, &vault, "Design").unwrap(),
            Some(dir.path().join("Collections").join("Design.md").to_string_lossy().into_owned())
        );
        assert_eq!(collection_page_path_inner(&conn, &vault, "Missing").unwrap(), None);
    }

    #[test]
    fn ambiguous_short_ref_never_deletes_nested_collection_pages() {
        let dir = tempfile::tempdir().unwrap();
        for folder in ["A", "B"] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
            std::fs::write(
                dir.path().join(folder).join("Design.md"),
                "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
            )
            .unwrap();
        }
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        assert!(delete_channel_inner(None, &conn, &vault, "Design").is_err());
        assert!(vault.block_path("A/Design").exists());
        assert!(vault.block_path("B/Design").exists());
    }

    #[test]
    fn collection_sync_never_materializes_a_root_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        std::fs::write(
            vault.block_path("Collections/Design"),
            "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
        )
        .unwrap();
        for _ in 0..2 {
            crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
            assert!(!vault.block_path("Design").exists());
            assert_eq!(index::list_channels(&conn).unwrap().len(), 1);
        }
        std::fs::remove_file(vault.block_path("Collections/Design")).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert!(index::list_channels(&conn).unwrap().is_empty());
        assert!(!vault.block_path("Design").exists());
    }

    #[test]
    fn channel_page_rename_never_overwrites_disk_only_target() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("Old.md");
        let new_path = dir.path().join("New.md");
        std::fs::write(&old_path, b"old page").unwrap();
        std::fs::write(&new_path, b"disk-only target").unwrap();

        let result = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old_path.clone(),
            new_path.clone(),
            b"old page".to_vec(),
            b"new page".to_vec(),
        )]);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old page");
        assert_eq!(std::fs::read(&new_path).unwrap(), b"disk-only target");
    }

    #[test]
    fn channel_page_rename_can_be_rolled_back_after_index_failure() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("Old.md");
        let new_path = dir.path().join("New.md");
        std::fs::write(&old_path, b"old page").unwrap();

        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old_path.clone(),
            new_path.clone(),
            b"old page".to_vec(),
            b"new page".to_vec(),
        )])
        .unwrap();
        staged
            .commit()
            .unwrap()
            .rollback("injected index failure")
            .unwrap();

        assert_eq!(std::fs::read(&old_path).unwrap(), b"old page");
        assert!(!new_path.exists());
    }

    fn standard_space(dir: &std::path::Path) -> VaultLayout {
        let vault = VaultLayout::with_derived_root(dir.join("space"), dir.join("derived"))
            .with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        vault
    }

    fn app_state(vault: &VaultLayout) -> AppState {
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, vault).unwrap();
        let state = AppState::new();
        state.open_space_for_test("main", crate::commands::state::VaultState {
            conn,
            vault: vault.clone(),
        });
        state
    }

    /// A collection page the user wrote into: text, own properties, a
    /// comment, blank lines, and its own membership in another collection.
    const WRITTEN_PAGE: &str = "---\ntype: channel\n# my note on this collection\naliases:\n  - Pics\nMine Collections:\n  - \"[[Archive]]\"\n\nposition: 0\nsaved_at: 2026-04-25T14:00:40Z\n---\n# Photos\n\nWhy I keep these.\n\n\n\nEnd.\n";

    #[test]
    fn a_reorder_changes_only_the_position_of_a_written_page() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        std::fs::write(
            vault.block_path("Collections/Art"),
            "---\ntype: channel\nposition: 1\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
        )
        .unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");

        reorder_channels_blocking(
            &main_space,
            vec![
                ReorderItem { tag: "Art".into(), position: 0 },
                ReorderItem { tag: "Photos".into(), position: 1 },
            ],
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            WRITTEN_PAGE.replace("position: 0", "position: 1")
        );
    }

    #[test]
    fn a_rename_moves_a_written_page_unchanged_and_updates_member_cards() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\naliases:\n  - Sunset\n# kept\nMine Collections:\n  - \"[[Photos]]\"\n\nrating: 5\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures").unwrap();

        assert!(!vault.block_path("Collections/Photos").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Pictures")).unwrap(),
            WRITTEN_PAGE
        );
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(),
            card.replace("[[Photos]]", "[[Pictures]]")
        );
    }

    /// К4: a card that names the collection with its page's folder keeps that
    /// form through a rename, the folder with the page's new name; a card
    /// naming it by name gets the new name.
    #[test]
    fn a_rename_keeps_a_link_with_the_page_folder_in_that_form() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let by_folder = "---\nMine Collections:\n  - \"[[Collections/Photos]]\"\n  - \"[[Other]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        let by_name = "---\nMine Collections:\n  - \"[[Photos]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Folder"), by_folder).unwrap();
        std::fs::write(vault.block_path("Cards/Name"), by_name).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures").unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Folder")).unwrap(),
            by_folder.replace("[[Collections/Photos]]", "[[Collections/Pictures]]")
        );
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Name")).unwrap(),
            by_name.replace("[[Photos]]", "[[Pictures]]")
        );
        let counted: Vec<(String, usize)> = index::get_all_tags(&vs.conn)
            .unwrap()
            .into_iter()
            .map(|tag| (tag.tag, tag.count))
            .collect();
        assert_eq!(counted, vec![("Pictures".to_string(), 2)]);
    }

    /// К4 and К12: deleting a collection takes its link off a card that names
    /// it with its page's folder too; other links stay.
    #[test]
    fn a_delete_takes_off_a_link_with_the_page_folder() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let by_folder = "---\nMine Collections:\n  - \"[[Collections/Photos]]\"\n  - \"[[Other]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Folder"), by_folder).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        assert!(delete_channel_inner(None, &vs.conn, &vs.vault, "Photos").unwrap().deleted);

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Folder")).unwrap(),
            by_folder.replace("  - \"[[Collections/Photos]]\"\n", "")
        );
    }

    /// Г1.5: a member card whose properties are a flow mapping is renamed
    /// inside the braces and indexed as the file reads.
    #[test]
    fn a_rename_keeps_a_flow_mapping_card_valid() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\n{aliases: [Sunset], Mine Collections: [\"[[Photos]]\"], saved_at: 2026-04-25T14:00:40Z}\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures").unwrap();

        let written = std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap();
        assert_eq!(written, card.replace("[[Photos]]", "[[Pictures]]"));
        let fallback = DateTime::new("2026-01-01").unwrap();
        let read = parse_markdown_document("Cards/Sunset", &written, fallback).unwrap();
        assert_eq!(read.origin, "partial_frontmatter");
        assert_eq!(read.block.frontmatter.tags, vec!["Pictures"]);
        assert_eq!(
            index::get_block(&vs.conn, "Cards/Sunset").unwrap().unwrap().tags,
            vec!["Pictures"]
        );
    }

    /// Г1.5: a member card whose properties cannot take the rename refuses
    /// the whole rename: no card, no page moves.
    #[test]
    fn a_rename_with_an_unwritable_member_card_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\n  Mine Collections: [\"[[Photos]]\"]\n  saved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        let refused = rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures");

        assert!(
            matches!(refused, Err(CommandError::FrontmatterNotWritable { .. })),
            "{refused:?}"
        );
        assert_eq!(std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(), card);
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            WRITTEN_PAGE
        );
        assert!(!vault.block_path("Collections/Pictures").exists());
    }

    /// SPEC_DEEP_AUDIT.md, Е1.3 (Н2): deleting a collection takes its links
    /// off every member and sends its page to the Trash in one mutation. A
    /// member the deletion cannot read keeps its link and is named; it does
    /// not stop the deletion.
    #[test]
    fn deleting_a_collection_takes_its_links_off_past_a_card_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let member = "---\naliases:\n  - Sunset\nMine Collections:\n  - \"[[Photos]]\"\n  - \"[[Archive]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), member).unwrap();
        let locked = "---\nMine Collections:\n  - \"[[Photos]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nLocked\n";
        std::fs::write(vault.block_path("Cards/Locked"), locked).unwrap();
        let state = app_state(&vault);
        let locked_path = vault.block_path("Cards/Locked");
        std::fs::set_permissions(&locked_path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        let outcome = delete_channel_inner(None, &vs.conn, &vs.vault, "Photos");

        std::fs::set_permissions(&locked_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            outcome.unwrap(),
            CollectionDeleted {
                deleted: true,
                kept_links: vec!["Cards/Locked".to_string()],
            }
        );
        assert!(!vault.block_path("Collections/Photos").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(),
            "---\naliases:\n  - Sunset\nMine Collections:\n  - \"[[Archive]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n"
        );
        assert_eq!(std::fs::read_to_string(&locked_path).unwrap(), locked);
        assert_eq!(
            index::get_block(&vs.conn, "Cards/Sunset").unwrap().unwrap().tags,
            Vec::<String>::new(),
            "Archive has no page, so the index shows no membership"
        );
    }

    /// SPEC_DEEP_AUDIT.md, Е1.11, live in the CLI on 13.10.2026: a collection
    /// created and deleted, then created again under the same name and
    /// deleted again, while the Trash already holds the first page. The
    /// iCloud Trash took the second name the delete kept of the page and left
    /// the page in a hidden folder. Each page goes to the Trash, nothing
    /// hidden is left in the collections folder, and no collection remains.
    #[test]
    fn deleting_a_collection_whose_name_the_trash_holds_sends_the_page_there() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        let page = vault.block_path("Collections/Проба 2");

        for round in ["first", "second"] {
            let created = create_channel_inner(&vs.conn, &vs.vault, "Проба 2").unwrap();
            assert_eq!(created.tag, "Проба 2", "{round}");
            assert!(page.exists(), "{round}");

            let deleted = delete_channel_inner(None, &vs.conn, &vs.vault, "Проба 2");

            assert_eq!(
                deleted.unwrap(),
                CollectionDeleted {
                    deleted: true,
                    kept_links: Vec::new(),
                },
                "{round}"
            );
            assert!(!page.exists(), "{round}");
            let hidden: Vec<String> = std::fs::read_dir(vault.root().join("Collections"))
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with('.'))
                .collect();
            assert!(hidden.is_empty(), "{round}: {hidden:?}");
            assert!(index::list_channels(&vs.conn).unwrap().is_empty(), "{round}");
        }
    }

    /// Е1.11: the Trash answers that it took the page and leaves it. The
    /// deletion changes nothing: the page stays in its place, the member
    /// keeps its link, the collection stays, and the refusal says why.
    #[test]
    fn a_collection_page_the_trash_left_keeps_the_collection_whole() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let member = "---\nMine Collections:\n  - \"[[Photos]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), member).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        crate::storage::files::test_trash::hooks::leave_next_in_place();

        let refused = delete_channel_inner(None, &vs.conn, &vs.vault, "Photos").unwrap_err();

        assert_eq!(refused.to_string(), "Could not move “Photos.md” to the Trash. Nothing was deleted.");
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            WRITTEN_PAGE
        );
        assert_eq!(std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(), member);
        assert_eq!(
            index::list_channels(&vs.conn)
                .unwrap()
                .into_iter()
                .map(|channel| channel.tag)
                .collect::<Vec<_>>(),
            vec!["Photos".to_string()]
        );
    }

    /// SPEC_DEEP_AUDIT.md, Е1.4 (Н2): the rename takes its members from the
    /// index brought up to the files first; a member written while nothing
    /// watched the space follows the collection to its new name.
    #[test]
    fn renaming_a_collection_moves_a_member_the_index_had_not_seen() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let state = app_state(&vault);
        let late = "---\nMine Collections:\n  - \"[[Photos]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nLate\n";
        std::fs::write(vault.block_path("Cards/Late"), late).unwrap();
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures").unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Late")).unwrap(),
            late.replace("[[Photos]]", "[[Pictures]]")
        );
    }

    fn refusal(outcome: Result<impl std::fmt::Debug, CommandError>) -> String {
        match outcome {
            Err(CommandError::NameRefused(reason)) => reason,
            other => panic!("expected a refused name, got {other:?}"),
        }
    }

    /// Every file in the space, with its bytes: what a refusal must leave.
    fn space_files(vault: &VaultLayout) -> Vec<(String, Vec<u8>)> {
        files::scan_vault_file_paths(vault)
            .unwrap()
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(vault.root().join(&path)).unwrap();
                (path, bytes)
            })
            .collect()
    }

    #[test]
    fn a_refused_name_reaches_the_page_as_kind_and_message() {
        let error = CommandError::NameRefused("The name is empty.".into());
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "kind": "name_refused", "message": "The name is empty." })
        );
    }

    /// 05.10.2026: a new collection's name follows the card's rules and is
    /// refused in words, and nothing is written.
    #[test]
    fn a_new_collection_name_follows_the_card_rules_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        let before = space_files(&vault);

        let create = |name: &str| create_channel_inner(&vs.conn, &vs.vault, name);
        assert_eq!(refusal(create("   ")), "The name is empty.");
        assert_eq!(refusal(create("a#b")), "A name cannot contain \\ : # ^ | [ or ].");
        assert_eq!(refusal(create("[[Photos]]")), "A name cannot contain \\ : # ^ | [ or ].");
        assert_eq!(refusal(create(".hidden")), "A name cannot start with a dot.");
        assert_eq!(
            refusal(create("Shelf/Books")),
            "A new collection cannot be in a folder: type its name without /."
        );
        assert_eq!(refusal(create("photos")), "A collection named \"photos\" already exists.");
        assert_eq!(space_files(&vault), before);

        assert_eq!(create(" Books.md ").unwrap().tag, "Books");
        assert!(vault.block_path("Collections/Books").exists());
    }

    /// SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1 (10.10.2026): an index row whose
    /// page left while no watcher saw it holds no name. The name check and
    /// the creation take the name again and write the page under it, not
    /// under a free one; a page that is there keeps refusing it, in any case.
    #[test]
    fn a_collection_whose_page_left_unwatched_can_be_created_again() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        assert_eq!(
            refusal(create_channel_inner(&vs.conn, &vs.vault, "Photos")),
            "A collection named \"Photos\" already exists."
        );

        std::fs::remove_file(vault.block_path("Collections/Photos")).unwrap();
        assert!(index::list_channels(&vs.conn).unwrap().iter().any(|channel| channel.tag == "Photos"));
        assert!(check_collection_name_inner(&vs.conn, &vs.vault, None, "Photos").is_ok());
        assert!(check_collection_name_inner(&vs.conn, &vs.vault, None, "photos").is_ok());
        assert_eq!(create_channel_inner(&vs.conn, &vs.vault, "Photos").unwrap().tag, "Photos");
        let page = std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap();
        assert!(page.contains("type: channel"), "{page}");

        let before = space_files(&vault);
        assert_eq!(
            refusal(create_channel_inner(&vs.conn, &vs.vault, "photos")),
            "A collection named \"photos\" already exists."
        );
        assert_eq!(space_files(&vault), before);
    }

    /// 05.10.2026: a rename to a name a card already has in the page's folder
    /// is refused up front, in words; the card and the page stay.
    #[test]
    fn a_collection_rename_refuses_a_file_already_in_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\nsaved_at: 2026-04-25T14:00:40Z\n---\nA note, not a collection\n";
        std::fs::write(vault.block_path("Collections/Pictures"), card).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        let before = space_files(&vault);

        let refused = rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures");

        assert_eq!(refusal(refused), "A file named \"Pictures.md\" already exists.");
        assert_eq!(space_files(&vault), before);
    }

    #[test]
    fn a_collection_rename_refuses_another_collection_name_and_another_folder() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        std::fs::write(
            vault.block_path("Collections/Art"),
            "---\ntype: channel\nposition: 1\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
        )
        .unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        let before = space_files(&vault);

        let rename = |name: &str| rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", name);
        assert_eq!(refusal(rename("ART")), "A collection named \"ART\" already exists.");
        assert_eq!(
            refusal(rename("Elsewhere/Pictures")),
            "A collection stays in its folder: type its name without /."
        );
        assert_eq!(refusal(rename("")), "The name is empty.");
        assert_eq!(refusal(rename("a|b")), "A name cannot contain \\ : # ^ | [ or ].");
        assert_eq!(space_files(&vault), before);
        assert_eq!(rename(" Photos ").unwrap().tag, "Photos");
    }

    /// The check while a name is typed answers as the rename and the creation
    /// would, and writes nothing.
    #[test]
    fn the_collection_name_check_answers_as_the_write_would_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        std::fs::write(vault.block_path("Collections/Taken"), "A note\n").unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();
        let before = space_files(&vault);

        let check = |old: Option<&str>, name: &str| {
            check_collection_name_inner(&vs.conn, &vs.vault, old, name)
        };
        assert!(check(Some("Photos"), "Pictures").is_ok());
        assert!(check(Some("Photos"), "Photos").is_ok());
        assert_eq!(refusal(check(Some("Photos"), "Taken")), "A file named \"Taken.md\" already exists.");
        assert_eq!(refusal(check(Some("Photos"), "a:b")), "A name cannot contain \\ : # ^ | [ or ].");
        assert!(check(None, "Fresh").is_ok());
        assert_eq!(refusal(check(None, "Photos")), "A collection named \"Photos\" already exists.");
        assert_eq!(refusal(check(None, "")), "The name is empty.");
        assert_eq!(space_files(&vault), before);
    }

    /// 06.10.2026: a collection renamed to its own name in other letter case
    /// is not in its own way, nor is its page, which the new spelling names
    /// where the disk ignores case. The page takes the new spelling and every
    /// member card links it so; a new collection that differs from it only in
    /// case stays refused.
    #[test]
    fn a_case_only_collection_rename_respells_the_page_and_memberships() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\nMine Collections:\n  - \"[[Photos]]\"\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let main_space = state.space_for("main").expect("main tab");
        let guard = main_space.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        assert!(check_collection_name_inner(&vs.conn, &vs.vault, Some("Photos"), "photos").is_ok());
        let renamed = rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "photos").unwrap();

        assert_eq!(renamed.tag, "photos");
        let pages: Vec<String> = std::fs::read_dir(vault.root().join("Collections"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(pages, ["photos.md"]);
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/photos")).unwrap(),
            WRITTEN_PAGE
        );
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(),
            card.replace("[[Photos]]", "[[photos]]")
        );
        let tags: Vec<String> =
            index::list_channels(&vs.conn).unwrap().into_iter().map(|channel| channel.tag).collect();
        assert!(tags.iter().any(|tag| tag == "photos") && !tags.iter().any(|tag| tag == "Photos"), "{tags:?}");
        assert_eq!(
            refusal(create_channel_inner(&vs.conn, &vs.vault, "PHOTOS")),
            "A collection named \"PHOTOS\" already exists."
        );
        assert_eq!(
            refusal(check_collection_name_inner(&vs.conn, &vs.vault, None, "Photos")),
            "A collection named \"Photos\" already exists."
        );
    }
}
