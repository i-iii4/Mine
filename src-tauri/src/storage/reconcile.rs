//! Filesystem-first reconciliation for the source vault and local SQLite index.
//!
//! Contract: SPEC_STORAGE.md#storagereconcile--filesystem-first-visibility

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

use crate::domain::block::{
    iter_inline_media_references, parse_markdown_document, Block, BlockType, DateTime,
    InlineMediaSyntax,
};
use crate::domain::vault::{detect_icloud_conflict, VaultLayout};
use crate::storage::{article_audio, files, index, media_refs};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ns: u128,
}

impl FileStamp {
    fn read(path: &Path) -> std::io::Result<Self> {
        let metadata = std::fs::metadata(path)?;
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let mtime_ns = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Ok(Self {
            size: metadata.len(),
            mtime_ns,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DependencyStamp {
    pub vault_relative_path: String,
    pub file: Option<FileStamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceStamp {
    pub markdown: FileStamp,
    pub dependencies: Vec<DependencyStamp>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Block,
    Channel,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Channel => "channel",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "block" => Some(Self::Block),
            "channel" => Some(Self::Channel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileFileErrorKind {
    Metadata,
    Read,
    Parse,
    Index,
    DependencyOutsideVault,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReconcileFileError {
    pub path: String,
    pub kind: ReconcileFileErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReconcileReport {
    pub inventory_markdown: usize,
    pub unchanged: usize,
    pub upserted: Vec<String>,
    pub removed: Vec<String>,
    pub dependency_changed: Vec<String>,
    pub errors: Vec<ReconcileFileError>,
    pub content_reads: usize,
    pub database_writes: usize,
    pub elapsed_ms: u64,
}

impl ReconcileReport {
    pub fn is_fresh(&self) -> bool {
        self.errors.is_empty()
    }
}

#[derive(Debug, Error)]
pub enum ReconcileError {
    #[error("failed to inventory vault {path}: {source}")]
    Inventory {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    #[error("failed to read reconciliation state: {0}")]
    State(#[source] anyhow::Error),
    #[error("failed to commit reconciliation: {0}")]
    Commit(#[source] anyhow::Error),
}

#[derive(Debug)]
struct StoredSourceState {
    kind: SourceKind,
    stamp: SourceStamp,
}

#[derive(Debug)]
struct PreparedSource {
    path: String,
    slug: String,
    kind: SourceKind,
    block: Block,
    origin: String,
    index_warning: Option<String>,
    stamp: SourceStamp,
    dependency_changed: bool,
}

/// Reconcile source Markdown inventory with the rebuildable SQLite projection.
///
/// Unchanged files are compared using metadata only. Content is read and parsed
/// only for new/changed sources or when a persisted media dependency changed.
pub fn reconcile_vault(
    conn: &Connection,
    vault: &VaultLayout,
) -> std::result::Result<ReconcileReport, ReconcileError> {
    let started = Instant::now();
    let paths = files::scan_md_files(vault).map_err(|source| ReconcileError::Inventory {
        path: vault.root().to_path_buf(),
        source,
    })?;
    let stored = load_source_states(conn).map_err(ReconcileError::State)?;
    let indexed_kinds = load_indexed_kinds(conn).map_err(ReconcileError::State)?;

    let mut live_slugs = BTreeSet::new();
    let mut prepared = Vec::new();
    let mut unchanged = 0usize;
    let mut errors = Vec::new();
    let mut content_reads = 0usize;
    let mut conflicts = Vec::new();

    for path in &paths {
        let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
            errors.push(file_error(
                path,
                ReconcileFileErrorKind::Metadata,
                "Markdown filename is not valid UTF-8",
            ));
            continue;
        };
        if detect_icloud_conflict(file_stem).is_some() {
            if let Some(base_slug) = detect_icloud_conflict(file_stem) {
                conflicts.push((base_slug, file_stem.to_string()));
            }
            continue;
        }
        let slug = match vault.slug_for_path(path) {
            Ok(slug) => slug,
            Err(error) => {
                errors.push(file_error(
                    path,
                    ReconcileFileErrorKind::Metadata,
                    error.to_string(),
                ));
                continue;
            }
        };
        live_slugs.insert(slug.clone());

        let markdown_stamp = match FileStamp::read(path) {
            Ok(stamp) => stamp,
            Err(error) => {
                errors.push(file_error(
                    path,
                    ReconcileFileErrorKind::Metadata,
                    error.to_string(),
                ));
                continue;
            }
        };

        let previous = stored.get(&slug);
        let dependency_changed = previous
            .filter(|state| state.stamp.markdown == markdown_stamp)
            .is_some_and(|state| dependencies_changed(vault, &state.stamp.dependencies));
        let projection_stale =
            previous.is_some_and(|state| indexed_kinds.get(&slug) != Some(&state.kind));
        let source_changed = previous.map_or(true, |state| state.stamp.markdown != markdown_stamp)
            || dependency_changed
            || projection_stale;
        if !source_changed {
            unchanged += 1;
            continue;
        }

        content_reads += 1;
        match prepare_source(vault, path, markdown_stamp, dependency_changed) {
            Ok(source) => prepared.push(source),
            Err(error) => errors.push(error),
        }
    }

    let removed = indexed_kinds
        .keys()
        .chain(stored.keys())
        .filter(|slug| !live_slugs.contains(*slug))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let tx = conn
        .unchecked_transaction()
        .map_err(|error| ReconcileError::Commit(error.into()))?;
    let mut upserted = Vec::with_capacity(prepared.len());
    let mut dependency_changed_slugs = Vec::new();
    let mut database_writes = 0usize;
    let mut committed_sources = Vec::new();

    for (base_slug, conflict_slug) in conflicts {
        index::record_vault_conflict(&tx, &base_slug, &conflict_slug)
            .with_context(|| format!("record vault conflict {conflict_slug}"))
            .map_err(ReconcileError::Commit)?;
        database_writes += 1;
    }

    for source in prepared {
        match apply_prepared_source(&tx, vault, &source) {
            Ok(()) => {
                if source.dependency_changed {
                    dependency_changed_slugs.push(source.slug.clone());
                }
                committed_sources.push((source.kind, source.block.clone()));
                upserted.push(source.slug);
                database_writes += 1;
            }
            Err(error) => errors.push(ReconcileFileError {
                path: source.path,
                kind: ReconcileFileErrorKind::Index,
                message: format!("{error:#}"),
            }),
        }
    }

    for slug in &removed {
        index::remove_block(&tx, slug)
            .with_context(|| format!("remove stale block {slug}"))
            .map_err(ReconcileError::Commit)?;
        index::remove_channel(&tx, slug)
            .with_context(|| format!("remove stale channel {slug}"))
            .map_err(ReconcileError::Commit)?;
        tx.execute("DELETE FROM source_index_state WHERE slug = ?1", [slug])
            .with_context(|| format!("remove stale source state {slug}"))
            .map_err(ReconcileError::Commit)?;
        database_writes += 1;
    }

    tx.commit()
        .context("commit VaultReconciler transaction")
        .map_err(ReconcileError::Commit)?;

    for (kind, block) in committed_sources {
        match kind {
            SourceKind::Block => {
                let _ = article_audio::invalidate_for_block(vault, &block);
            }
            SourceKind::Channel => {
                let _ = article_audio::delete_all_artifacts(vault, &block.slug);
            }
        }
    }
    for slug in &removed {
        let _ = std::fs::remove_file(vault.thumb_path(slug));
        let _ = article_audio::delete_all_artifacts(vault, slug);
    }

    Ok(ReconcileReport {
        inventory_markdown: live_slugs.len(),
        unchanged,
        upserted,
        removed,
        dependency_changed: dependency_changed_slugs,
        errors,
        content_reads,
        database_writes,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    })
}

fn prepare_source(
    vault: &VaultLayout,
    path: &Path,
    markdown_stamp: FileStamp,
    dependency_changed: bool,
) -> std::result::Result<PreparedSource, ReconcileFileError> {
    let (slug, content) = files::read_block_file(vault, path)
        .map_err(|error| file_error(path, ReconcileFileErrorKind::Read, error.to_string()))?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(path))
        .map_err(|error| file_error(path, ReconcileFileErrorKind::Parse, error.to_string()))?;
    let dependency_paths = collect_dependency_paths(vault, &parsed.block).map_err(|message| {
        file_error(
            path,
            ReconcileFileErrorKind::DependencyOutsideVault,
            message,
        )
    })?;
    let stamp = SourceStamp {
        markdown: markdown_stamp,
        dependencies: dependency_paths
            .into_iter()
            .map(|(relative, absolute)| DependencyStamp {
                vault_relative_path: relative,
                file: FileStamp::read(&absolute).ok(),
            })
            .collect(),
    };
    let mut block = parsed.block;
    files::normalize_block_media_refs_for_index(vault, &mut block);
    let kind = if block.frontmatter.block_type == BlockType::Channel {
        SourceKind::Channel
    } else {
        SourceKind::Block
    };
    Ok(PreparedSource {
        path: path.to_string_lossy().into_owned(),
        slug,
        kind,
        block,
        origin: parsed.origin,
        index_warning: parsed.index_warning,
        stamp,
        dependency_changed,
    })
}

fn apply_prepared_source(
    conn: &Connection,
    vault: &VaultLayout,
    source: &PreparedSource,
) -> Result<()> {
    conn.execute_batch("SAVEPOINT reconcile_source")
        .context("begin source reconciliation savepoint")?;
    let result = (|| -> Result<()> {
        match source.kind {
            SourceKind::Block => {
                index::remove_channel(conn, &source.slug).with_context(|| {
                    format!("remove stale channel projection for {}", source.slug)
                })?;
                index::upsert_block_with_diagnostics(
                    conn,
                    &source.block,
                    Some(vault.root()),
                    Some(&source.origin),
                    source.index_warning.as_deref(),
                )
                .with_context(|| format!("upsert block {}", source.slug))?;
            }
            SourceKind::Channel => {
                index::remove_block(conn, &source.slug).with_context(|| {
                    format!("remove stale block projection for {}", source.slug)
                })?;
                index::upsert_channel_from_block(conn, &source.block)
                    .with_context(|| format!("upsert channel {}", source.slug))?;
            }
        }
        write_source_state(conn, &source.slug, source.kind, &source.stamp)
            .with_context(|| format!("write source state for {}", source.slug))?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("RELEASE SAVEPOINT reconcile_source")
            .context("release source reconciliation savepoint"),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT reconcile_source");
            let _ = conn.execute_batch("RELEASE SAVEPOINT reconcile_source");
            Err(error)
        }
    }
}

fn collect_dependency_paths(
    vault: &VaultLayout,
    block: &Block,
) -> std::result::Result<Vec<(String, PathBuf)>, String> {
    let mut paths = BTreeMap::<String, PathBuf>::new();
    for reference in [
        block.frontmatter.file.as_deref(),
        block.frontmatter.thumbnail.as_deref(),
        block.frontmatter.source_media.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(path) = dependency_candidate(vault, &block.slug, reference, None) {
            insert_dependency(vault, &mut paths, path)?;
        }
    }
    for reference in iter_inline_media_references(&block.body) {
        if reference.source.starts_with("http://") || reference.source.starts_with("https://") {
            continue;
        }
        let resolved = media_refs::resolve_inline_media(vault, &block.slug, &reference);
        let fallback = match reference.syntax {
            InlineMediaSyntax::MarkdownImage | InlineMediaSyntax::ObsidianEmbed => {
                vault.resolve_local_reference(&block.slug, &reference.source)
            }
        };
        if let Some(path) = resolved.or(fallback) {
            insert_dependency(vault, &mut paths, path)?;
        }
    }
    Ok(paths.into_iter().collect())
}

fn dependency_candidate(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
    resolved: Option<PathBuf>,
) -> Option<PathBuf> {
    if reference.starts_with("http://") || reference.starts_with("https://") {
        return None;
    }
    resolved.or_else(|| vault.resolve_local_reference(block_slug, reference))
}

fn insert_dependency(
    vault: &VaultLayout,
    paths: &mut BTreeMap<String, PathBuf>,
    path: PathBuf,
) -> std::result::Result<(), String> {
    let relative = vault
        .root_relative_reference(&path)
        .ok_or_else(|| format!("dependency escapes vault: {}", path.display()))?;
    paths.insert(relative, path);
    Ok(())
}

fn dependencies_changed(vault: &VaultLayout, dependencies: &[DependencyStamp]) -> bool {
    dependencies.iter().any(|dependency| {
        let current = FileStamp::read(&vault.root().join(&dependency.vault_relative_path)).ok();
        current != dependency.file
    })
}

fn load_source_states(conn: &Connection) -> Result<BTreeMap<String, StoredSourceState>> {
    let mut stmt = conn
        .prepare("SELECT slug, source_kind, source_stamp FROM source_index_state ORDER BY slug")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut states = BTreeMap::new();
    for row in rows {
        let (slug, kind_raw, stamp_raw) = row?;
        let kind = SourceKind::from_str(&kind_raw)
            .with_context(|| format!("unknown source kind '{kind_raw}' for {slug}"))?;
        let stamp = serde_json::from_str(&stamp_raw)
            .with_context(|| format!("invalid source stamp for {slug}"))?;
        states.insert(slug, StoredSourceState { kind, stamp });
    }
    Ok(states)
}

fn load_indexed_kinds(conn: &Connection) -> Result<BTreeMap<String, SourceKind>> {
    let mut kinds = BTreeMap::new();
    let mut block_stmt = conn.prepare("SELECT slug FROM blocks")?;
    for slug in block_stmt.query_map([], |row| row.get::<_, String>(0))? {
        kinds.insert(slug?, SourceKind::Block);
    }
    let mut channel_stmt = conn.prepare("SELECT tag FROM channels")?;
    for slug in channel_stmt.query_map([], |row| row.get::<_, String>(0))? {
        kinds.insert(slug?, SourceKind::Channel);
    }
    Ok(kinds)
}

fn write_source_state(
    conn: &Connection,
    slug: &str,
    kind: SourceKind,
    stamp: &SourceStamp,
) -> Result<()> {
    let stamp = serde_json::to_string(stamp)?;
    conn.execute(
        "INSERT INTO source_index_state (slug, source_kind, source_stamp)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(slug) DO UPDATE SET
            source_kind = excluded.source_kind,
            source_stamp = excluded.source_stamp,
            updated_at = datetime('now')",
        params![slug, kind.as_str(), stamp],
    )?;
    Ok(())
}

fn file_saved_at(path: &Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(SystemTime::now);
    let serialized = crate::util::system_time_to_iso8601(time);
    DateTime::new(&serialized)
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").expect("valid epoch"))
}

fn file_error(
    path: &Path,
    kind: ReconcileFileErrorKind,
    message: impl Into<String>,
) -> ReconcileFileError {
    ReconcileFileError {
        path: path.to_string_lossy().into_owned(),
        kind,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::search::parse_search_query;
    use crate::storage::db;
    use crate::storage::graph;
    use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn setup() -> (TempDir, VaultLayout, Connection) {
        let dir = TempDir::new().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        (dir, vault, conn)
    }

    fn write_note(vault: &VaultLayout, slug: &str, body: &str) {
        std::fs::write(
            vault.block_path(slug),
            format!("---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn direct_file_create_is_visible_and_second_pass_reads_no_content() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Disk Note", "first body");

        let first = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(first.upserted, vec!["Disk Note"]);
        assert_eq!(first.content_reads, 1);
        assert!(index::get_block(&conn, "Disk Note").unwrap().is_some());

        let second = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(second.unchanged, 1);
        assert_eq!(second.content_reads, 0);
        assert_eq!(second.database_writes, 0);
    }

    #[test]
    fn direct_file_edit_refreshes_indexed_body() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Edited", "old body");
        reconcile_vault(&conn, &vault).unwrap();

        write_note(&vault, "Edited", "new body with a different size");
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted, vec!["Edited"]);
        let indexed = index::get_block(&conn, "Edited").unwrap().unwrap();
        assert_eq!(indexed.body.trim(), "new body with a different size");
    }

    #[test]
    fn direct_file_delete_removes_stale_index_row() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Deleted", "body");
        reconcile_vault(&conn, &vault).unwrap();

        std::fs::remove_file(vault.block_path("Deleted")).unwrap();
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.removed, vec!["Deleted"]);
        assert!(index::get_block(&conn, "Deleted").unwrap().is_none());
    }

    #[test]
    fn unchanged_source_repairs_a_missing_projection() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Repair", "body");
        reconcile_vault(&conn, &vault).unwrap();
        index::remove_block(&conn, "Repair").unwrap();

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted, vec!["Repair"]);
        assert_eq!(report.content_reads, 1);
        assert!(index::get_block(&conn, "Repair").unwrap().is_some());
    }

    #[test]
    fn media_dependency_change_reindexes_without_markdown_change() {
        let (_dir, vault, conn) = setup();
        std::fs::write(vault.root().join("photo.jpg"), b"first").unwrap();
        std::fs::write(
            vault.block_path("Media Note"),
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\nwidth: 100\nheight: 100\n---\n![[photo.jpg]]",
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();

        std::fs::write(vault.root().join("photo.jpg"), b"changed dependency").unwrap();
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.dependency_changed, vec!["Media Note"]);
        assert_eq!(report.content_reads, 1);
    }

    #[test]
    fn missing_media_dependency_is_detected_when_it_appears() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Future Media"),
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\n![[future.jpg]]",
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();

        std::fs::write(vault.root().join("future.jpg"), b"now present").unwrap();
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.dependency_changed, vec!["Future Media"]);
        assert_eq!(report.content_reads, 1);
    }

    #[test]
    fn disk_only_markdown_reaches_every_route_projection_after_catch_up() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Research"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 0\n---",
        )
        .unwrap();
        std::fs::write(
            vault.block_path("Disk Route Note"),
            "---\ntype: article\nsaved_at: 2026-07-10T01:00:00Z\nMine Collections:\n  - \"[[Research]]\"\n---\n# Catch-up title\nfilesystem-needle",
        )
        .unwrap();
        assert!(index::get_block(&conn, "Disk Route Note")
            .unwrap()
            .is_none());

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted.len(), 2);
        assert!(index::get_block(&conn, "Disk Route Note")
            .unwrap()
            .is_some());
        assert!(index::list_grid_blocks(&conn, None, 0, 20)
            .unwrap()
            .0
            .iter()
            .any(|block| block.slug == "Disk Route Note"));
        assert!(
            index::search_blocks(&conn, &parse_search_query("filesystem-needle"))
                .unwrap()
                .iter()
                .any(|block| block.slug == "Disk Route Note")
        );
        assert!(index::get_all_tags(&conn)
            .unwrap()
            .iter()
            .any(|tag| tag.tag == "Research" && tag.count == 1));
        assert!(index::list_channels(&conn)
            .unwrap()
            .iter()
            .any(|channel| channel.tag == "Research"));
        let snapshot = graph::graph_snapshot(
            &conn,
            &graph::GraphScope::default(),
            &graph::GraphOptions::default(),
        )
        .unwrap();
        assert!(snapshot
            .nodes
            .iter()
            .any(|node| node.id == "card:Disk Route Note"));
        assert!(snapshot.links.iter().any(|link| {
            link.id == "collection_membership|collection:Research|card:Disk Route Note"
        }));
    }

    #[test]
    fn one_index_failure_keeps_valid_sources_and_reports_degraded() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Good", "valid body");
        write_note(&vault, "Rejected", "valid source but rejected projection");
        conn.execute_batch(
            "CREATE TRIGGER reject_test_source
             BEFORE INSERT ON blocks
             WHEN new.slug = 'Rejected'
             BEGIN
                 SELECT RAISE(ABORT, 'injected index failure');
             END;",
        )
        .unwrap();

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert!(!report.is_fresh());
        assert_eq!(report.upserted, vec!["Good"]);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].kind, ReconcileFileErrorKind::Index);
        assert!(index::get_block(&conn, "Good").unwrap().is_some());
        assert!(index::get_block(&conn, "Rejected").unwrap().is_none());
    }

    #[test]
    fn channel_pages_share_the_same_source_state_contract() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Research"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 2\n---",
        )
        .unwrap();

        let first = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(first.upserted, vec!["Research"]);
        assert!(index::list_channels(&conn)
            .unwrap()
            .iter()
            .any(|channel| channel.tag == "Research"));

        let second = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(second.content_reads, 0);
        assert_eq!(second.unchanged, 1);
    }

    #[test]
    fn command_source_commit_and_reconciler_complete_without_deadlock() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Concurrent", "old body");
        reconcile_vault(&conn, &vault).unwrap();
        drop(conn);

        let updated =
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\nnew concurrent body";
        let parsed = crate::domain::block::parse_block("Concurrent", updated).unwrap();
        let (write_locked_tx, write_locked_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let writer_vault = vault.clone();
        let writer_done = done_tx.clone();
        let writer = thread::spawn(move || {
            let writer_conn = db::open_or_create(&writer_vault.index_db_path()).unwrap();
            let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
                writer_vault.block_path("Concurrent"),
                updated.as_bytes().to_vec(),
            )])
            .unwrap();
            staged
                .commit_with_index(&writer_conn, "concurrent_test_write", |index_conn| {
                    write_locked_tx.send(()).unwrap();
                    thread::sleep(Duration::from_millis(150));
                    index::upsert_block(index_conn, &parsed, Some(writer_vault.root())).map(|_| ())
                })
                .unwrap();
            writer_done.send("writer").unwrap();
        });

        let reconcile_vault_layout = vault.clone();
        let reconcile_done = done_tx.clone();
        let reconciler = thread::spawn(move || {
            write_locked_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            let reconcile_conn =
                db::open_or_create(&reconcile_vault_layout.index_db_path()).unwrap();
            reconcile_vault(&reconcile_conn, &reconcile_vault_layout).unwrap();
            reconcile_done.send("reconciler").unwrap();
        });
        drop(done_tx);

        let first = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(first, second);
        writer.join().unwrap();
        reconciler.join().unwrap();

        let final_conn = db::open_or_create(&vault.index_db_path()).unwrap();
        reconcile_vault(&final_conn, &vault).unwrap();
        let indexed = index::get_block(&final_conn, "Concurrent")
            .unwrap()
            .unwrap();
        assert_eq!(indexed.body.trim(), "new concurrent body");
    }
}
