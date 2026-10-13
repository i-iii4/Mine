// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::commands::channels::require_collection_page;
use crate::commands::state::{tab_layout, ensure_vault_fresh, AppState, CommandError};
use crate::domain::block::{parse_markdown_document, Block, DateTime};
use crate::domain::collection::{
    normalize_collection_ref, patch_collections_frontmatter, validate_collection_ref,
};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::index::{IndexedBlock, TagCount};
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
use crate::storage::{files, index, media_refs};
use crate::util::append_startup_trace;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all tags with their block counts.
#[tauri::command]
pub async fn list_tags(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TagCount>, CommandError> {
    append_startup_trace(&app, "list_tags", "start");
    let vault = tab_layout(&state, &webview)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let app_for_query = app.clone();
    let tags =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TagCount>, CommandError> {
            super::state::read_owned_projection(&app_for_query, &vault, |conn| {
                Ok(index::get_all_tags(conn)?)
            })
        })
        .await
        .map_err(|e| CommandError::Internal(format!("list_tags task join failed: {e}")))??;
    append_startup_trace(&app, "list_tags", &format!("done count={}", tags.len()));
    Ok(tags)
}

/// Add a tag to a block: read .md, update frontmatter, write back, re-index.
fn add_tag_unannounced(webview: tauri::Webview, state: State<'_, AppState>, slug: String, tag: String) -> Result<(), CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    set_block_membership(&vs.conn, &vs.vault, &slug, &tag, true)
}

/// [`add_tag_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(async)]
pub fn add_tag(webview: tauri::Webview, state: State<'_, AppState>, slug: String, tag: String) -> Result<(), CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = add_tag_unannounced(webview, state, slug, tag);
    if outcome.is_ok() {
        announcing.send(Vec::new());
    }
    outcome
}

/// Remove a tag from a block: read .md, update frontmatter, write back, re-index.
fn remove_tag_unannounced(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    slug: String,
    tag: String,
) -> Result<(), CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    set_block_membership(&vs.conn, &vs.vault, &slug, &tag, false)
}

/// [`remove_tag_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(async)]
pub fn remove_tag(webview: tauri::Webview, state: State<'_, AppState>, slug: String, tag: String) -> Result<(), CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = remove_tag_unannounced(webview, state, slug, tag);
    if outcome.is_ok() {
        announcing.send(Vec::new());
    }
    outcome
}

/// [`set_blocks_membership_inner`] on the calling tab's space.
fn set_blocks_membership_unannounced(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    slugs: Vec<String>,
    tag: String,
    connected: bool,
) -> Result<(), CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    set_blocks_membership_inner(&vs.conn, &vs.vault, &slugs, &tag, connected)
}

/// Connect every card of `slugs` to the collection `tag`, or disconnect them
/// all, then the other tabs of the space hear of the change (SPEC_TABS.md,
/// В15). One command for the group selection's Connect and Disconnect and a
/// drop of several cards (SPEC_DEEP_AUDIT.md, Е6.1).
#[tauri::command(async)]
pub fn set_blocks_membership(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    slugs: Vec<String>,
    tag: String,
    connected: bool,
) -> Result<(), CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = set_blocks_membership_unannounced(webview, state, slugs, tag, connected);
    if outcome.is_ok() {
        announcing.send(Vec::new());
    }
    outcome
}

/// The membership of many cards in one source mutation: every card changes,
/// or none does (SPEC_DEEP_AUDIT.md, Е6.1). Before 13.10.2026 the interface
/// called `add_tag` or `remove_tag` card after card, and a failure in the
/// middle left the first cards changed and the rest not.
///
/// A card that already is as asked is not written: a stale selection may
/// hold a card already out of the collection (SPEC_GROUP_SELECTION.md,
/// «Collection-Scoped Disconnect»). A card whose file is gone is skipped:
/// there is nothing left to connect. Connecting needs the collection's page,
/// as for one card (К7); a card that cannot take the change refuses the
/// whole batch, nothing written.
pub(crate) fn set_blocks_membership_inner(
    conn: &Connection,
    vault: &VaultLayout,
    slugs: &[String],
    tag: &str,
    connected: bool,
) -> Result<(), CommandError> {
    let collection_ref = normalize_collection_ref(tag);
    if collection_ref.is_empty() {
        return Err(CommandError::Internal("collection ref is empty".to_string()));
    }
    validate_collection_ref(&collection_ref).map_err(CommandError::Internal)?;
    if connected {
        require_collection_page(conn, vault, &collection_ref)?;
    }

    let mut seen = std::collections::HashSet::new();
    let mut writes = Vec::with_capacity(slugs.len());
    let mut projections = Vec::with_capacity(slugs.len());
    for slug in slugs {
        if !seen.insert(slug.as_str()) {
            continue;
        }
        validate_slug(slug).map_err(|e| CommandError::Internal(e.to_string()))?;
        let path = vault.block_path(slug);
        if !path.exists() {
            continue;
        }
        let (_, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut collections = parsed.block.frontmatter.tags;
        if collections.contains(&collection_ref) == connected {
            continue;
        }
        if connected {
            collections.push(collection_ref.clone());
        } else {
            collections.retain(|t| t != &collection_ref);
        }
        let (write, projection) =
            MembershipRewrite::prepare(vault, slug, path, content, &collections)?.into_source_write();
        writes.push(write);
        projections.push(projection);
    }
    if writes.is_empty() {
        return Ok(());
    }

    StagedSourceMutation::stage(writes)?.commit_with_index(
        conn,
        "set_blocks_membership",
        |index_conn| {
            for projection in &projections {
                projection.upsert(index_conn, vault)?;
            }
            Ok(())
        },
    )?;
    Ok(())
}

/// Connect the card `slug` to the collection `tag`, or disconnect it.
///
/// Connecting needs the collection's page and refuses before anything is
/// written without one; disconnecting takes the link off whether the page
/// exists or not (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7 and К8). The new
/// list is built from the card's text, never from the index, so links to
/// names without a page stay where they are (К2).
fn set_block_membership(
    conn: &Connection,
    vault: &VaultLayout,
    slug: &str,
    tag: &str,
    connected: bool,
) -> Result<(), CommandError> {
    validate_slug(slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let collection_ref = normalize_collection_ref(tag);
    if connected && collection_ref.is_empty() {
        return Err(CommandError::Internal(
            "collection ref is empty".to_string(),
        ));
    }
    if !collection_ref.is_empty() {
        validate_collection_ref(&collection_ref).map_err(CommandError::Internal)?;
    }
    if connected {
        require_collection_page(conn, vault, &collection_ref)?;
    }

    let path = vault.block_path(slug);
    let (_, content) = files::read_block_file(vault, &path)?;
    let parsed = parse_markdown_document(slug, &content, file_saved_at(&path))
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut collections = parsed.block.frontmatter.tags;
    if connected {
        if !collections.contains(&collection_ref) {
            collections.push(collection_ref);
        }
    } else {
        collections.retain(|t| t != &collection_ref);
    }

    let rewrite = MembershipRewrite::prepare(vault, slug, path, content, &collections)?;
    commit_block_rewrite(conn, vault, rewrite)
}

/// A card's membership written into its source, with what the written file
/// reads as. The index holds that reading, never the model the change was
/// planned on: what the file says is what Mine shows.
pub(crate) struct MembershipRewrite {
    path: PathBuf,
    /// The bytes the rewrite was built from.
    pub(crate) expected: Vec<u8>,
    /// The bytes to write.
    pub(crate) bytes: Vec<u8>,
    /// The written file as the index holds it.
    projection: BlockProjection,
}

/// One card as the index holds it.
pub(crate) struct BlockProjection {
    block: Block,
    origin: String,
    index_warning: Option<String>,
}

impl BlockProjection {
    /// Write the card's row.
    pub(crate) fn upsert(&self, conn: &Connection, vault: &VaultLayout) -> anyhow::Result<()> {
        index::upsert_block_with_diagnostics(
            conn,
            &self.block,
            Some(vault.root()),
            Some(self.origin.as_str()),
            self.index_warning.as_deref(),
        )
        .map(|_| ())
    }
}

impl MembershipRewrite {
    /// Write `collections` as the membership of `content`, the text read from
    /// `path`, and read the result back. Properties that cannot take the
    /// change in place are refused: nothing is written, nothing indexed
    /// (`SPEC_AUDIT_FIXES.md`, Ф1).
    pub(crate) fn prepare(
        vault: &VaultLayout,
        slug: &str,
        path: PathBuf,
        content: String,
        collections: &[String],
    ) -> Result<Self, CommandError> {
        let patched = patch_collections_frontmatter(&content, collections).map_err(|_| {
            CommandError::FrontmatterNotWritable {
                path: path.display().to_string(),
            }
        })?;
        let written = parse_markdown_document(slug, &patched, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut block = written.block;
        files::normalize_block_media_refs_for_index(
            &mut media_refs::MediaResolver::new(vault),
            &mut block,
        );
        Ok(Self {
            path,
            expected: content.into_bytes(),
            bytes: patched.into_bytes(),
            projection: BlockProjection {
                block,
                origin: written.origin,
                index_warning: written.index_warning,
            },
        })
    }

    /// The source write, refused when the file no longer holds what was read,
    /// and the row the index takes with it.
    pub(crate) fn into_source_write(self) -> (SourceFileWrite, BlockProjection) {
        (
            SourceFileWrite::replace(self.path, self.expected, self.bytes),
            self.projection,
        )
    }
}

fn commit_block_rewrite(
    conn: &Connection,
    vault: &VaultLayout,
    rewrite: MembershipRewrite,
) -> Result<(), CommandError> {
    let (write, projection) = rewrite.into_source_write();
    StagedSourceMutation::stage(vec![write])?.commit_with_index(
        conn,
        "rewrite_block_collections",
        |index_conn| projection.upsert(index_conn, vault),
    )?;
    Ok(())
}

/// Apply a frontmatter collection rewrite through one staged source batch and
/// one SQLite transaction.
fn rewrite_collection_membership(
    conn: &Connection,
    vault: &VaultLayout,
    affected: &[IndexedBlock],
    mut transform: impl FnMut(&mut Vec<String>),
) -> Result<(), CommandError> {
    let mut writes = Vec::with_capacity(affected.len());
    let mut projections = Vec::with_capacity(affected.len());
    for indexed_block in affected {
        let path = vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut collections = parsed.block.frontmatter.tags;
        transform(&mut collections);
        let (write, projection) =
            MembershipRewrite::prepare(vault, &indexed_block.slug, path, content, &collections)?
                .into_source_write();
        writes.push(write);
        projections.push(projection);
    }

    StagedSourceMutation::stage(writes)?.commit_with_index(
        conn,
        "rewrite_collection_membership",
        |index_conn| {
            for projection in &projections {
                projection.upsert(index_conn, vault)?;
            }
            Ok(())
        },
    )?;
    Ok(())
}

/// Rename a tag in ALL blocks: find blocks with old_tag, replace with new_tag
/// in frontmatter, write back, re-index.
fn rename_tag_unannounced(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<(), CommandError> {
    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized_old = normalize_collection_ref(&old_tag);
    let normalized_new = normalize_collection_ref(&new_tag);

    if normalized_new.is_empty() {
        return Err(CommandError::Internal("new collection ref is empty".into()));
    }
    validate_collection_ref(&normalized_old).map_err(CommandError::Internal)?;
    validate_collection_ref(&normalized_new).map_err(CommandError::Internal)?;
    if normalized_old == normalized_new {
        return Ok(());
    }
    // Every card gains a link to the new name: like any new link, it needs
    // that collection's page (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7).
    require_collection_page(&vs.conn, &vs.vault, &normalized_new)?;

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    rewrite_collection_membership(&vs.conn, &vs.vault, &affected_blocks, |tags| {
        tags.retain(|t| t != &normalized_old);
        if !tags.contains(&normalized_new) {
            tags.push(normalized_new.clone());
        }
    })
}

/// [`rename_tag_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(async, rename_all = "snake_case")]
pub fn rename_tag(webview: tauri::Webview, state: State<'_, AppState>, old_tag: String, new_tag: String) -> Result<(), CommandError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let renamed = super::effects::SpaceRename::collection(&old_tag, &new_tag);
    let outcome = rename_tag_unannounced(webview, state, old_tag, new_tag);
    if outcome.is_ok() {
        announcing.send(vec![renamed]);
    }
    outcome
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;

    #[test]
    fn patch_collections_frontmatter_inserts_minimal_frontmatter_for_foreign_markdown() {
        let input = "# Note\n\nBody";
        let output = patch_collections_frontmatter(input, &["design".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\nMine Collections:\n  - \"[[design]]\"\n---\n# Note\n\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_preserves_unknown_fields_and_obsidian_tags() {
        let input = "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\n---\nBody";
        let output =
            patch_collections_frontmatter(input, &["design/typography".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\nMine Collections:\n  - \"[[design/typography]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_preserves_scalar_obsidian_tags() {
        let input = "---\ntype: meeting\ntags: \"design typography\"\n---\nBody";
        let output = patch_collections_frontmatter(
            input,
            &[
                "design".to_string(),
                "typography".to_string(),
                "аркада".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            output,
            "---\ntype: meeting\ntags: \"design typography\"\nMine Collections:\n  - \"[[design]]\"\n  - \"[[typography]]\"\n  - \"[[аркада]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_updates_existing_mine_collections() {
        let input = "---\ntags: design typography\nMine Collections:\n  - old\n---\nBody";
        let output = patch_collections_frontmatter(
            input,
            &[
                "design".to_string(),
                "typography".to_string(),
                "local-first".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            output,
            "---\ntags: design typography\nMine Collections:\n  - \"[[design]]\"\n  - \"[[typography]]\"\n  - \"[[local-first]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_removes_collections_but_preserves_obsidian_tags() {
        let input = "---\ntags:\n  - old\nMine Collections:\n  - design\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(
            output,
            "---\ntags:\n  - old\nMine Collections: []\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_writes_empty_override_for_legacy_tags() {
        let input = "---\ntags:\n  - old\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(
            output,
            "---\ntags:\n  - old\nMine Collections: []\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_treats_unclosed_fence_as_body() {
        let input = "---\ntags:\n  - old";
        let output = patch_collections_frontmatter(input, &["new".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\nMine Collections:\n  - \"[[new]]\"\n---\n---\ntags:\n  - old"
        );
    }

    #[test]
    fn patch_collections_frontmatter_rejects_invalid_yaml_inside_fence() {
        let input = "---\ntype: article\n\tbad\n---\nBody";
        let err = patch_collections_frontmatter(input, &["new".to_string()]).unwrap_err();
        assert_eq!(
            err,
            crate::domain::source_patch::SourcePatchError::MalformedFrontmatter {
                field: crate::domain::collection::MINE_COLLECTIONS_FIELD
            }
        );
    }

    /// A space with one indexed card written as `source`.
    fn space_with_card(source: &str) -> (tempfile::TempDir, VaultLayout, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let path = vault.block_path("Note");
        std::fs::write(&path, source).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let parsed = parse_markdown_document("Note", source, file_saved_at(&path)).unwrap();
        index::upsert_block(&conn, &parsed.block, Some(vault.root())).unwrap();
        (dir, vault, conn)
    }

    /// A collection page `<name>.md` at the root of the space, indexed: only a
    /// collection with a page is one (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1).
    fn collection_page(vault: &VaultLayout, conn: &Connection, name: &str) {
        let source = "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\n---\n";
        let path = vault.block_path(name);
        std::fs::write(&path, source).unwrap();
        let parsed = parse_markdown_document(name, source, file_saved_at(&path)).unwrap();
        index::upsert_block(conn, &parsed.block, Some(vault.root())).unwrap();
        index::upsert_channel_from_block_in_vault(conn, vault, &parsed.block).unwrap();
    }

    /// The membership Mine reads from the card on disk, after checking that
    /// its properties are still valid YAML.
    fn membership_on_disk(vault: &VaultLayout) -> Vec<String> {
        let path = vault.block_path("Note");
        let source = std::fs::read_to_string(&path).unwrap();
        let parsed = parse_markdown_document("Note", &source, file_saved_at(&path)).unwrap();
        assert_eq!(parsed.origin, "partial_frontmatter", "{source}");
        assert_eq!(parsed.index_warning, None, "{source}");
        parsed.block.frontmatter.tags
    }

    /// Г1.5: a card whose properties are a flow mapping joins a collection
    /// inside the braces; the file stays valid YAML and the index says what
    /// the file says.
    #[test]
    fn flow_mapping_card_joins_a_collection_and_stays_valid() {
        let (_dir, vault, conn) = space_with_card(
            "---\n{aliases: [A], saved_at: 2026-07-10T00:00:00Z}\n---\nBody",
        );
        collection_page(&vault, &conn, "Design");

        set_block_membership(&conn, &vault, "Note", "Design", true).unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Note")).unwrap(),
            "---\n{aliases: [A], saved_at: 2026-07-10T00:00:00Z, Mine Collections: [\"[[Design]]\"]}\n---\nBody"
        );
        assert_eq!(membership_on_disk(&vault), vec!["Design"]);
        assert_eq!(index::get_block(&conn, "Note").unwrap().unwrap().tags, vec!["Design"]);

        set_block_membership(&conn, &vault, "Note", "Design", false).unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Note")).unwrap(),
            "---\n{aliases: [A], saved_at: 2026-07-10T00:00:00Z}\n---\nBody"
        );
        assert!(index::get_block(&conn, "Note").unwrap().unwrap().tags.is_empty());
    }

    /// Г1.5: properties the writer would break are refused with a typed error;
    /// the file stays byte for byte and the index keeps its row.
    #[test]
    fn properties_the_writer_would_break_are_refused_and_left_alone() {
        let source = "---\n  aliases: [A]\n  saved_at: 2026-07-10T00:00:00Z\n---\nBody";
        let (_dir, vault, conn) = space_with_card(source);
        collection_page(&vault, &conn, "Design");

        let refused = set_block_membership(&conn, &vault, "Note", "Design", true);

        assert!(
            matches!(refused, Err(CommandError::FrontmatterNotWritable { .. })),
            "{refused:?}"
        );
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), source);
        assert!(index::get_block(&conn, "Note").unwrap().unwrap().tags.is_empty());
    }

    /// Г1.5: a collection rename across cards refuses as a whole when one
    /// card cannot take it; no card is written.
    #[test]
    fn bulk_rename_with_one_unwritable_card_writes_none() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let sources = [
            ("A", "---\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Old]]\"\n---\nA"),
            ("B", "---\n  saved_at: 2026-07-10T00:00:00Z\n  Mine Collections: [\"[[Old]]\"]\n---\nB"),
        ];
        for (slug, source) in sources {
            let path = vault.block_path(slug);
            std::fs::write(&path, source).unwrap();
            let parsed = parse_markdown_document(slug, source, file_saved_at(&path)).unwrap();
            index::upsert_block(&conn, &parsed.block, Some(vault.root())).unwrap();
        }
        collection_page(&vault, &conn, "Old");
        let affected = index::list_blocks_by_tag(&conn, "Old").unwrap();
        assert_eq!(affected.len(), 2);

        let refused = rewrite_collection_membership(&conn, &vault, &affected, |tags| {
            tags.retain(|tag| tag != "Old");
            tags.push("New".to_string());
        });

        assert!(
            matches!(refused, Err(CommandError::FrontmatterNotWritable { .. })),
            "{refused:?}"
        );
        for (slug, source) in sources {
            assert_eq!(std::fs::read_to_string(vault.block_path(slug)).unwrap(), source);
            assert_eq!(index::get_block(&conn, slug).unwrap().unwrap().tags, vec!["Old"]);
        }
    }

    #[test]
    fn membership_write_refuses_a_card_edited_after_it_was_read() {
        let source = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nBody";
        let (_dir, vault, conn) = space_with_card(source);
        let path = vault.block_path("Note");
        let rewrite =
            MembershipRewrite::prepare(&vault, "Note", path.clone(), source.to_string(), &["New".to_string()])
                .unwrap();
        std::fs::write(&path, "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nEdited in Obsidian").unwrap();

        let refused = commit_block_rewrite(&conn, &vault, rewrite);

        assert!(matches!(refused, Err(CommandError::SourceChanged { .. })), "{refused:?}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nEdited in Obsidian"
        );
    }

    #[test]
    fn block_rewrite_restores_source_when_index_update_fails() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let path = vault.block_path("Note");
        let original = "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Old]]\"\n---\nBody";
        std::fs::write(&path, original).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let original_parsed =
            parse_markdown_document("Note", original, file_saved_at(&path)).unwrap();
        index::upsert_block(&conn, &original_parsed.block, Some(vault.root())).unwrap();
        collection_page(&vault, &conn, "Old");
        let rewrite = MembershipRewrite::prepare(
            &vault,
            "Note",
            path.clone(),
            original.to_string(),
            &["New".to_string()],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_tag_update
             BEFORE UPDATE ON blocks
             WHEN new.slug = 'Note'
             BEGIN
                 SELECT RAISE(ABORT, 'injected tag index failure');
             END;",
        )
        .unwrap();

        let result = commit_block_rewrite(&conn, &vault, rewrite);

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert_eq!(
            index::get_block(&conn, "Note").unwrap().unwrap().tags,
            vec!["Old"]
        );
    }

    #[test]
    fn bulk_collection_rewrite_rolls_back_every_file_and_index_row() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let source = |slug: &str| {
            format!(
                "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Old]]\"\n---\n{slug} body"
            )
        };
        for slug in ["A", "B"] {
            let content = source(slug);
            let path = vault.block_path(slug);
            std::fs::write(&path, &content).unwrap();
            let parsed = parse_markdown_document(slug, &content, file_saved_at(&path)).unwrap();
            index::upsert_block(&conn, &parsed.block, Some(vault.root())).unwrap();
        }
        collection_page(&vault, &conn, "Old");
        conn.execute_batch(
            "CREATE TRIGGER reject_second_bulk_update
             BEFORE UPDATE ON blocks
             WHEN new.slug = 'B'
             BEGIN
                 SELECT RAISE(ABORT, 'injected bulk index failure');
             END;",
        )
        .unwrap();
        let affected = index::list_blocks_by_tag(&conn, "Old").unwrap();

        let result = rewrite_collection_membership(&conn, &vault, &affected, |tags| {
            tags.clear();
            tags.push("New".to_string());
        });

        assert!(result.is_err());
        for slug in ["A", "B"] {
            assert_eq!(
                std::fs::read_to_string(vault.block_path(slug)).unwrap(),
                source(slug)
            );
            assert_eq!(
                index::get_block(&conn, slug).unwrap().unwrap().tags,
                vec!["Old"]
            );
        }
    }

    /// A space with cards `slug -> source`, indexed.
    fn space_with_cards(cards: &[(&str, &str)]) -> (tempfile::TempDir, VaultLayout, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        for (slug, source) in cards {
            let path = vault.block_path(slug);
            std::fs::write(&path, source).unwrap();
            let parsed = parse_markdown_document(slug, source, file_saved_at(&path)).unwrap();
            index::upsert_block(&conn, &parsed.block, Some(vault.root())).unwrap();
        }
        (dir, vault, conn)
    }

    fn tags_on_disk(vault: &VaultLayout, slug: &str) -> Vec<String> {
        let path = vault.block_path(slug);
        let source = std::fs::read_to_string(&path).unwrap();
        parse_markdown_document(slug, &source, file_saved_at(&path))
            .unwrap()
            .block
            .frontmatter
            .tags
    }

    /// Е6.1: the group selection's Connect and Disconnect change every card
    /// at once, file and index.
    #[test]
    fn many_cards_join_and_leave_a_collection_in_one_mutation() {
        let plain = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nBody";
        let (_dir, vault, conn) = space_with_cards(&[("A", plain), ("B", plain), ("C", plain)]);
        collection_page(&vault, &conn, "Design");
        let slugs = vec!["A".to_string(), "B".to_string(), "C".to_string(), "A".to_string()];

        set_blocks_membership_inner(&conn, &vault, &slugs, "Design", true).unwrap();
        for slug in ["A", "B", "C"] {
            assert_eq!(tags_on_disk(&vault, slug), vec!["Design"], "{slug}");
        }
        assert_eq!(index::list_blocks_by_tag(&conn, "Design").unwrap().len(), 3);

        set_blocks_membership_inner(&conn, &vault, &slugs, "Design", false).unwrap();
        for slug in ["A", "B", "C"] {
            assert!(tags_on_disk(&vault, slug).is_empty(), "{slug}");
        }
        assert!(index::list_blocks_by_tag(&conn, "Design").unwrap().is_empty());
    }

    /// Е6.1: one card that cannot take the change leaves every card as it
    /// was; card after card, the cards before it were already changed.
    #[test]
    fn one_card_that_cannot_change_leaves_the_whole_selection_as_it_was() {
        let plain = "---\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Design]]\"\n---\nBody";
        let unwritable = "---\n  saved_at: 2026-07-10T00:00:00Z\n  Mine Collections: [\"[[Design]]\"]\n---\nBody";
        let (_dir, vault, conn) = space_with_cards(&[("A", plain), ("B", unwritable), ("C", plain)]);
        collection_page(&vault, &conn, "Design");
        let slugs = vec!["A".to_string(), "B".to_string(), "C".to_string()];

        let refused = set_blocks_membership_inner(&conn, &vault, &slugs, "Design", false);

        assert!(matches!(refused, Err(CommandError::FrontmatterNotWritable { .. })), "{refused:?}");
        assert_eq!(std::fs::read_to_string(vault.block_path("A")).unwrap(), plain);
        assert_eq!(std::fs::read_to_string(vault.block_path("B")).unwrap(), unwritable);
        assert_eq!(std::fs::read_to_string(vault.block_path("C")).unwrap(), plain);
        assert_eq!(index::list_blocks_by_tag(&conn, "Design").unwrap().len(), 3);
    }

    /// Е6.1: a card already out of the collection (a stale selection) and a
    /// card gone from the space are skipped; the rest leave it. Connecting to
    /// a name without a page refuses before anything is written (К7).
    #[test]
    fn a_stale_or_vanished_card_is_skipped_and_a_pageless_name_refuses() {
        let member = "---\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Design]]\"\n---\nBody";
        let outsider = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nBody";
        let (_dir, vault, conn) = space_with_cards(&[("A", member), ("B", outsider), ("Gone", member)]);
        collection_page(&vault, &conn, "Design");
        std::fs::remove_file(vault.block_path("Gone")).unwrap();
        let slugs = vec!["A".to_string(), "B".to_string(), "Gone".to_string()];

        set_blocks_membership_inner(&conn, &vault, &slugs, "Design", false).unwrap();
        assert!(tags_on_disk(&vault, "A").is_empty());
        assert_eq!(std::fs::read_to_string(vault.block_path("B")).unwrap(), outsider);

        let refused = set_blocks_membership_inner(&conn, &vault, &slugs, "Pageless", true);
        assert!(matches!(refused, Err(CommandError::CollectionNotFound { .. })), "{refused:?}");
        assert_eq!(std::fs::read_to_string(vault.block_path("B")).unwrap(), outsider);
    }

    /// The links of the card on disk, in file order, pages or not.
    fn links_on_disk(vault: &VaultLayout) -> Vec<String> {
        let path = vault.block_path("Note");
        let source = std::fs::read_to_string(&path).unwrap();
        parse_markdown_document("Note", &source, file_saved_at(&path))
            .unwrap()
            .block
            .frontmatter
            .tags
    }

    /// К7 (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md): connecting to a name without
    /// a page refuses with `CollectionNotFound`, and the card stays byte for
    /// byte; nothing reaches the index.
    #[test]
    fn connecting_to_a_name_without_a_page_refuses_and_writes_nothing() {
        let source = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nBody";
        let (_dir, vault, conn) = space_with_card(source);

        let refused = set_block_membership(&conn, &vault, "Note", "Pageless", true);

        match refused {
            Err(CommandError::CollectionNotFound { collection }) => assert_eq!(collection, "Pageless"),
            other => panic!("expected CollectionNotFound, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), source);
        assert!(index::list_blocks_by_tag(&conn, "Pageless").unwrap().is_empty());
        // A note of that name that is no collection page is no page either.
        std::fs::write(vault.block_path("Pageless"), "---\ntype: article\n---\nJust a note").unwrap();
        assert!(matches!(
            set_block_membership(&conn, &vault, "Note", "Pageless", true),
            Err(CommandError::CollectionNotFound { .. })
        ));
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), source);
    }

    /// К7: the page is found on disk, as rename and delete find it, even when
    /// the index has not seen it yet.
    #[test]
    fn connecting_finds_a_page_the_index_has_not_seen() {
        let (_dir, vault, conn) = space_with_card("---\nsaved_at: 2026-07-10T00:00:00Z\n---\nBody");
        std::fs::write(
            vault.block_path("Fresh"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\n---\n",
        )
        .unwrap();

        set_block_membership(&conn, &vault, "Note", "Fresh", true).unwrap();

        assert_eq!(links_on_disk(&vault), vec!["Fresh"]);
    }

    /// К7: a bare name two pages share is ambiguous and refuses with the
    /// ambiguity error rename and delete give; the card is untouched.
    #[test]
    fn connecting_to_an_ambiguous_name_refuses_like_rename_and_delete() {
        let source = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nBody";
        let (_dir, vault, conn) = space_with_card(source);
        for folder in ["A", "B"] {
            std::fs::create_dir_all(vault.root().join(folder)).unwrap();
            std::fs::write(
                vault.block_path(&format!("{folder}/Design")),
                "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\n---\n",
            )
            .unwrap();
        }
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        let refused = set_block_membership(&conn, &vault, "Note", "Design", true);

        match refused {
            Err(CommandError::Internal(message)) => assert!(message.contains("ambiguous"), "{message}"),
            other => panic!("expected the ambiguity error, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), source);
    }

    /// К8: disconnecting takes off a link whose collection has no page.
    #[test]
    fn disconnecting_a_link_without_a_page_takes_it_off() {
        let (_dir, vault, conn) = space_with_card(
            "---\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Pageless]]\"\n---\nBody",
        );

        set_block_membership(&conn, &vault, "Note", "Pageless", false).unwrap();

        assert!(links_on_disk(&vault).is_empty());
        assert!(index::list_blocks_by_tag(&conn, "Pageless").unwrap().is_empty());
    }

    /// К2: connecting and disconnecting another collection leaves a link
    /// whose name has no page where it is: the write is built from the file.
    #[test]
    fn other_membership_writes_keep_a_link_without_a_page_in_place() {
        let (_dir, vault, conn) = space_with_card(
            "---\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[First]]\"\n  - \"[[Pageless]]\"\n  - \"[[Last]]\"\n---\nBody",
        );
        for name in ["First", "Last", "Design"] {
            collection_page(&vault, &conn, name);
        }

        set_block_membership(&conn, &vault, "Note", "Design", true).unwrap();
        assert_eq!(links_on_disk(&vault), vec!["First", "Pageless", "Last", "Design"]);

        set_block_membership(&conn, &vault, "Note", "First", false).unwrap();
        assert_eq!(links_on_disk(&vault), vec!["Pageless", "Last", "Design"]);
        // The index shows the collections with pages only, and still
        // mirrors the link (К9).
        assert_eq!(index::get_block(&conn, "Note").unwrap().unwrap().tags, vec!["Design", "Last"]);
        assert_eq!(index::list_blocks_by_tag(&conn, "Pageless").unwrap().len(), 1);
    }
}
