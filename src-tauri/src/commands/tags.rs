// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TagCount>, CommandError> {
    append_startup_trace(&app, "list_tags", "start");
    let vault = current_vault_layout(&state)?;
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
#[tauri::command]
pub fn add_tag(state: State<'_, AppState>, slug: String, tag: String) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    set_block_membership(&vs.conn, &vs.vault, &slug, &tag, true)
}

/// Remove a tag from a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn remove_tag(
    state: State<'_, AppState>,
    slug: String,
    tag: String,
) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    set_block_membership(&vs.conn, &vs.vault, &slug, &tag, false)
}

/// Connect the card `slug` to the collection `tag`, or disconnect it.
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
#[tauri::command(rename_all = "snake_case")]
pub fn rename_tag(
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<(), CommandError> {
    let vault_state = state
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

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    rewrite_collection_membership(&vs.conn, &vs.vault, &affected_blocks, |tags| {
        tags.retain(|t| t != &normalized_old);
        if !tags.contains(&normalized_new) {
            tags.push(normalized_new.clone());
        }
    })
}

/// Delete a tag from ALL blocks: find blocks with tag, remove it from
/// frontmatter, write back, re-index.
#[tauri::command]
pub fn delete_tag_from_all(state: State<'_, AppState>, tag: String) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized = normalize_collection_ref(&tag);
    if normalized.is_empty() {
        return Ok(());
    }
    validate_collection_ref(&normalized).map_err(CommandError::Internal)?;

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized)?;
    rewrite_collection_membership(&vs.conn, &vs.vault, &affected_blocks, |tags| {
        tags.retain(|t| t != &normalized);
    })
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
}
