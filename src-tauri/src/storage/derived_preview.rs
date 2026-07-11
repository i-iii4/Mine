//! Existence-backed derived preview reconciliation.
//!
//! `preview_manifest` is a plan. Grid may consume it only while
//! `preview_state = ready`, the recorded source stamp matches, and every
//! referenced derived JPEG exists. Source media is never a feed fallback.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use crate::domain::block::{parse_markdown_document, Block, BlockType, CardKind, DateTime};
use crate::domain::vault::VaultLayout;
use crate::storage::index::{self, FeedPreviewKind, FeedPreviewManifest};
use crate::storage::preview_plan::{is_image_media, is_video_media};
use crate::storage::{files, media_refs, thumbnails};

pub const PREVIEW_RECONCILE_BATCH_SIZE: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivedPreviewState {
    Missing,
    Stale,
    Ready,
    Failed,
}

impl DerivedPreviewState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Stale => "stale",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewErrorKind {
    MissingSourceStamp,
    MissingSource,
    InvalidManifest,
    UnsafePreviewPath,
    BrowserDecodeRequired,
    Generation,
}

impl PreviewErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::MissingSourceStamp => "missing_source_stamp",
            Self::MissingSource => "missing_source",
            Self::InvalidManifest => "invalid_manifest",
            Self::UnsafePreviewPath => "unsafe_preview_path",
            Self::BrowserDecodeRequired => "browser_decode_required",
            Self::Generation => "generation",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewFailure {
    pub slug: String,
    pub error_kind: PreviewErrorKind,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PreviewReconcileReport {
    pub checked: usize,
    pub ready: usize,
    pub regenerated: usize,
    pub changed_slugs: Vec<String>,
    pub failed: Vec<PreviewFailure>,
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
pub struct PreviewReconcileOutcome {
    pub slug: String,
    pub state: DerivedPreviewState,
    pub regenerated: bool,
    pub state_changed: bool,
    pub failure: Option<PreviewFailure>,
}

#[derive(Debug)]
struct PreviewRecord {
    manifest: Option<String>,
    state: String,
    source_stamp: Option<String>,
    block_type: BlockType,
    card_kind: CardKind,
    media_file: Option<String>,
    schema_version: i64,
}

pub fn reconcile_all_previews(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<PreviewReconcileReport> {
    reconcile_all_previews_while(conn, vault, &mut || true)
}

/// Reconcile the active vault while `should_continue` remains true. The
/// callback is checked between blocks so switching vaults cancels obsolete
/// decode work without exposing partial files or stale UI events.
pub fn reconcile_all_previews_while(
    conn: &Connection,
    vault: &VaultLayout,
    should_continue: &mut dyn FnMut() -> bool,
) -> Result<PreviewReconcileReport> {
    reconcile_all_previews_with_progress(conn, vault, should_continue, &mut |_| {})
}

pub fn reconcile_all_previews_with_progress(
    conn: &Connection,
    vault: &VaultLayout,
    should_continue: &mut dyn FnMut() -> bool,
    on_batch: &mut dyn FnMut(&PreviewReconcileReport),
) -> Result<PreviewReconcileReport> {
    index::backfill_missing_preview_manifest(conn)?;
    let mut stmt = conn.prepare(
        "SELECT slug
         FROM blocks
         WHERE card_kind != 'channel'
         ORDER BY saved_at DESC",
    )?;
    let slugs = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut report = PreviewReconcileReport::default();
    for batch in slugs.chunks(PREVIEW_RECONCILE_BATCH_SIZE) {
        let batch_report = reconcile_preview_slugs_while(
            conn,
            vault,
            batch.iter().map(String::as_str),
            should_continue,
        )?;
        on_batch(&batch_report);
        merge_report(&mut report, batch_report);
        if report.cancelled {
            break;
        }
        std::thread::yield_now();
    }
    if !report.cancelled {
        cleanup_orphan_tile_previews(conn, vault)?;
    }
    Ok(report)
}

pub fn reconcile_preview_slugs<'a>(
    conn: &Connection,
    vault: &VaultLayout,
    slugs: impl IntoIterator<Item = &'a str>,
) -> Result<PreviewReconcileReport> {
    reconcile_preview_slugs_while(conn, vault, slugs, &mut || true)
}

pub fn reconcile_preview_slugs_while<'a>(
    conn: &Connection,
    vault: &VaultLayout,
    slugs: impl IntoIterator<Item = &'a str>,
    should_continue: &mut dyn FnMut() -> bool,
) -> Result<PreviewReconcileReport> {
    let mut report = PreviewReconcileReport::default();
    for slug in slugs {
        if !should_continue() {
            report.cancelled = true;
            break;
        }
        let outcome = match reconcile_preview_for_slug(conn, vault, slug) {
            Ok(Some(outcome)) => outcome,
            Ok(None) => continue,
            Err(error) => {
                report.checked += 1;
                report.failed.push(PreviewFailure {
                    slug: slug.to_string(),
                    error_kind: PreviewErrorKind::Generation,
                    retryable: true,
                    message: error.to_string(),
                });
                continue;
            }
        };
        report.checked += 1;
        if outcome.state == DerivedPreviewState::Ready {
            report.ready += 1;
        }
        if outcome.regenerated {
            report.regenerated += 1;
        }
        if outcome.state_changed || outcome.regenerated {
            report.changed_slugs.push(outcome.slug.clone());
        }
        if let Some(failure) = outcome.failure {
            report.failed.push(failure);
        }
    }
    Ok(report)
}

pub fn reconcile_preview_for_slug(
    conn: &Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<Option<PreviewReconcileOutcome>> {
    let Some(record) = load_preview_record(conn, slug)? else {
        return Ok(None);
    };
    let source_stamp = conn
        .query_row(
            "SELECT source_stamp FROM source_index_state WHERE slug = ?1",
            [slug],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(source_stamp) = source_stamp else {
        return mark_non_ready(
            conn,
            slug,
            &record,
            DerivedPreviewState::Stale,
            None,
            PreviewErrorKind::MissingSourceStamp,
            true,
            "source stamp is not indexed yet",
        )
        .map(Some);
    };
    if record.schema_version != index::PREVIEW_SCHEMA_VERSION {
        return mark_non_ready(
            conn,
            slug,
            &record,
            DerivedPreviewState::Stale,
            Some(&source_stamp),
            PreviewErrorKind::InvalidManifest,
            true,
            format!(
                "preview schema {} is stale; expected {}",
                record.schema_version,
                index::PREVIEW_SCHEMA_VERSION
            ),
        )
        .map(Some);
    }
    let Some(raw_manifest) = record.manifest.as_deref() else {
        return mark_non_ready(
            conn,
            slug,
            &record,
            DerivedPreviewState::Missing,
            Some(&source_stamp),
            PreviewErrorKind::InvalidManifest,
            true,
            "preview manifest is missing",
        )
        .map(Some);
    };
    let manifest = match serde_json::from_str::<FeedPreviewManifest>(raw_manifest) {
        Ok(manifest) => manifest,
        Err(error) => {
            return mark_non_ready(
                conn,
                slug,
                &record,
                DerivedPreviewState::Failed,
                Some(&source_stamp),
                PreviewErrorKind::InvalidManifest,
                false,
                format!("invalid preview manifest: {error}"),
            )
            .map(Some);
        }
    };
    if !manifest_matches_card_kind(
        record.block_type,
        record.card_kind,
        record.media_file.as_deref(),
        manifest.kind,
    ) {
        return mark_non_ready(
            conn,
            slug,
            &record,
            DerivedPreviewState::Failed,
            Some(&source_stamp),
            PreviewErrorKind::InvalidManifest,
            false,
            format!(
                "preview kind '{}' is incompatible with card kind '{}'",
                manifest.kind.as_str(),
                record.card_kind.as_str()
            ),
        )
        .map(Some);
    }
    let expected = match expected_preview_paths(vault, &manifest) {
        Ok(expected) => expected,
        Err(error) => {
            return mark_non_ready(
                conn,
                slug,
                &record,
                DerivedPreviewState::Failed,
                Some(&source_stamp),
                PreviewErrorKind::UnsafePreviewPath,
                false,
                error.to_string(),
            )
            .map(Some);
        }
    };
    // A missing preview_source_stamp is a legacy baseline, not evidence that
    // source content changed. Existing valid derived files may be adopted and
    // stamped without decoding the entire vault again. Once a stamp exists, a
    // mismatch is a real dependency change and every affected artifact must be
    // regenerated.
    let source_changed = record
        .source_stamp
        .as_deref()
        .is_some_and(|stamp| stamp != source_stamp);
    if !source_changed && expected.iter().all(|path| is_ready_preview(path)) {
        let changed = update_preview_state(
            conn,
            slug,
            DerivedPreviewState::Ready,
            Some(&source_stamp),
            None,
            record.manifest.as_deref(),
        )?;
        return Ok(Some(PreviewReconcileOutcome {
            slug: slug.to_string(),
            state: DerivedPreviewState::Ready,
            regenerated: false,
            state_changed: changed,
            failure: None,
        }));
    }

    if expected.is_empty() {
        let changed = update_preview_state(
            conn,
            slug,
            DerivedPreviewState::Ready,
            Some(&source_stamp),
            None,
            record.manifest.as_deref(),
        )?;
        return Ok(Some(PreviewReconcileOutcome {
            slug: slug.to_string(),
            state: DerivedPreviewState::Ready,
            regenerated: false,
            state_changed: changed,
            failure: None,
        }));
    }

    let block = match read_source_block(vault, slug) {
        Ok(block) => block,
        Err(error) => {
            return mark_non_ready(
                conn,
                slug,
                &record,
                DerivedPreviewState::Failed,
                Some(&source_stamp),
                PreviewErrorKind::MissingSource,
                true,
                error.to_string(),
            )
            .map(Some);
        }
    };

    let mut regenerated = false;
    let mut generation_failure = None;
    let primary_disk_path = manifest
        .primary_preview_path
        .as_deref()
        .map(|path| preview_disk_path(vault, path))
        .transpose()?;
    if let Some(primary_path) = manifest.primary_preview_path.as_deref() {
        let primary = preview_disk_path(vault, primary_path)?;
        if source_changed || !is_ready_preview(&primary) {
            let source = thumbnails::generate_for_block(&block, vault);
            regenerated |= matches!(
                source,
                thumbnails::ThumbSource::Image | thumbnails::ThumbSource::Video
            );
            if !is_ready_preview(&primary) {
                generation_failure = Some((
                    PreviewErrorKind::BrowserDecodeRequired,
                    "primary preview requires browser decoding".to_string(),
                ));
            }
        }
    }

    for (tile_index, tile) in manifest.tiles.iter().enumerate() {
        let Some(preview_path) = tile.preview_path.as_deref() else {
            generation_failure.get_or_insert((
                PreviewErrorKind::InvalidManifest,
                format!("tile '{}' has no derived preview path", tile.source_path),
            ));
            continue;
        };
        let destination = preview_disk_path(vault, preview_path)?;
        if !source_changed && is_ready_preview(&destination) {
            continue;
        }
        let can_copy_primary = tile_index == 0
            && !source_changed
            && manifest.kind != FeedPreviewKind::Composite
            && generation_failure.is_none()
            && primary_disk_path.as_deref().is_some_and(is_ready_preview);
        if can_copy_primary {
            let primary = primary_disk_path
                .as_deref()
                .expect("ready primary path was checked above");
            match std::fs::read(primary)
                .with_context(|| format!("failed to read primary preview: {}", primary.display()))
                .and_then(|bytes| files::write_atomically(&destination, &bytes))
            {
                Ok(()) => {
                    regenerated = true;
                    continue;
                }
                Err(error) => {
                    log::warn!(
                        "failed to materialize first preview tile for {slug}, falling back to source decode: {error:#}"
                    );
                }
            }
        }
        let Some(source) = media_refs::resolve_indexed_media(vault, slug, &tile.source_path) else {
            generation_failure.get_or_insert((
                PreviewErrorKind::MissingSource,
                format!("preview source is missing: {}", tile.source_path),
            ));
            continue;
        };
        let generated = if is_video_media(&tile.source_path) {
            thumbnails::generate_video_thumbnail(
                &source,
                &destination,
                thumbnails::DEFAULT_MAX_SIZE,
            )
        } else if is_image_media(&tile.source_path) && thumbnails::is_rust_decodable(&source) {
            thumbnails::generate_thumbnail(&source, &destination, thumbnails::DEFAULT_MAX_SIZE)
        } else {
            generation_failure.get_or_insert((
                PreviewErrorKind::BrowserDecodeRequired,
                format!(
                    "preview source requires browser decoding: {}",
                    tile.source_path
                ),
            ));
            continue;
        };
        match generated {
            Ok(_) => regenerated = true,
            Err(error) => {
                generation_failure.get_or_insert((
                    PreviewErrorKind::Generation,
                    format!("failed to generate '{}': {error:#}", tile.source_path),
                ));
            }
        }
    }

    let all_ready = expected.iter().all(|path| is_ready_preview(path));
    if all_ready && (!source_changed || generation_failure.is_none()) {
        let changed = update_preview_state(
            conn,
            slug,
            DerivedPreviewState::Ready,
            Some(&source_stamp),
            None,
            record.manifest.as_deref(),
        )?;
        return Ok(Some(PreviewReconcileOutcome {
            slug: slug.to_string(),
            state: DerivedPreviewState::Ready,
            regenerated,
            state_changed: changed,
            failure: None,
        }));
    }

    let (kind, message) = generation_failure.unwrap_or((
        PreviewErrorKind::Generation,
        "one or more derived previews are missing".to_string(),
    ));
    mark_non_ready(
        conn,
        slug,
        &record,
        DerivedPreviewState::Failed,
        Some(&source_stamp),
        kind,
        true,
        message,
    )
    .map(|mut outcome| {
        outcome.regenerated = regenerated;
        Some(outcome)
    })
}

fn load_preview_record(conn: &Connection, slug: &str) -> Result<Option<PreviewRecord>> {
    conn.query_row(
        "SELECT preview_manifest, preview_state, preview_source_stamp, block_type, card_kind, media_file, preview_schema_version
         FROM blocks WHERE slug = ?1",
        [slug],
        |row| {
            Ok(PreviewRecord {
                manifest: row.get(0)?,
                state: row.get(1)?,
                source_stamp: row.get(2)?,
                block_type: index::parse_block_type_row(row, 3)?,
                card_kind: index::parse_card_kind_row(row, 4)?,
                media_file: row.get(5)?,
                schema_version: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn manifest_matches_card_kind(
    block_type: BlockType,
    card_kind: CardKind,
    media_file: Option<&str>,
    preview_kind: FeedPreviewKind,
) -> bool {
    match card_kind {
        CardKind::Media => {
            let visual_media = matches!(block_type, BlockType::Image | BlockType::Video)
                || media_file
                    .is_some_and(|source| is_image_media(source) || is_video_media(source));
            preview_kind != FeedPreviewKind::Text || !visual_media
        }
        CardKind::Article => true,
        CardKind::Link => matches!(preview_kind, FeedPreviewKind::Text | FeedPreviewKind::Image),
        CardKind::Channel => preview_kind == FeedPreviewKind::Text,
    }
}

#[allow(clippy::too_many_arguments)]
fn mark_non_ready(
    conn: &Connection,
    slug: &str,
    record: &PreviewRecord,
    state: DerivedPreviewState,
    source_stamp: Option<&str>,
    error_kind: PreviewErrorKind,
    retryable: bool,
    message: impl Into<String>,
) -> Result<PreviewReconcileOutcome> {
    let message = message.into();
    let changed = update_preview_state(
        conn,
        slug,
        state,
        source_stamp,
        Some(error_kind.as_str()),
        record.manifest.as_deref(),
    )?;
    Ok(PreviewReconcileOutcome {
        slug: slug.to_string(),
        state,
        regenerated: false,
        state_changed: changed || record.state != state.as_str(),
        failure: Some(PreviewFailure {
            slug: slug.to_string(),
            error_kind,
            retryable,
            message,
        }),
    })
}

fn update_preview_state(
    conn: &Connection,
    slug: &str,
    state: DerivedPreviewState,
    source_stamp: Option<&str>,
    error_kind: Option<&str>,
    expected_manifest: Option<&str>,
) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE blocks
         SET preview_state = ?2,
             preview_source_stamp = ?3,
             preview_error_kind = ?4
         WHERE slug = ?1
           AND preview_manifest IS ?5
           AND (?3 IS NULL OR EXISTS (
             SELECT 1 FROM source_index_state source
             WHERE source.slug = blocks.slug AND source.source_stamp = ?3
           ))
           AND (preview_state IS NOT ?2
             OR preview_source_stamp IS NOT ?3
             OR preview_error_kind IS NOT ?4)",
        params![
            slug,
            state.as_str(),
            source_stamp,
            error_kind,
            expected_manifest
        ],
    )?;
    if changed > 0 {
        return Ok(true);
    }

    let current = conn
        .query_row(
            "SELECT b.preview_state, b.preview_source_stamp, b.preview_error_kind,
                    b.preview_manifest, source.source_stamp
             FROM blocks b
             LEFT JOIN source_index_state source ON source.slug = b.slug
             WHERE b.slug = ?1",
            [slug],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((current_state, current_preview_stamp, current_error, manifest, indexed_stamp)) =
        current
    else {
        anyhow::bail!("preview owner disappeared while publishing: {slug}");
    };
    if current_state == state.as_str()
        && current_preview_stamp.as_deref() == source_stamp
        && current_error.as_deref() == error_kind
        && manifest.as_deref() == expected_manifest
        && (source_stamp.is_none() || indexed_stamp.as_deref() == source_stamp)
    {
        return Ok(false);
    }
    anyhow::bail!("preview inputs changed while publishing: {slug}")
}

fn expected_preview_paths(
    vault: &VaultLayout,
    manifest: &FeedPreviewManifest,
) -> Result<Vec<PathBuf>> {
    let mut paths = BTreeSet::new();
    if let Some(path) = manifest.primary_preview_path.as_deref() {
        paths.insert(preview_disk_path(vault, path)?);
    }
    for tile in &manifest.tiles {
        let path = tile
            .preview_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("tile '{}' has no preview_path", tile.source_path))?;
        paths.insert(preview_disk_path(vault, path)?);
    }
    Ok(paths.into_iter().collect())
}

fn preview_disk_path(vault: &VaultLayout, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    anyhow::ensure!(
        !path.is_absolute(),
        "preview path must be relative: {relative}"
    );
    anyhow::ensure!(
        path.components()
            .all(|component| matches!(component, Component::Normal(_))),
        "preview path contains unsafe components: {relative}"
    );
    Ok(vault.thumbs_dir().join(path))
}

fn is_ready_preview(path: &Path) -> bool {
    matches!(
        thumbnails::thumb_disk_state(path),
        thumbnails::ThumbDiskState::Jpeg
    )
}

fn read_source_block(vault: &VaultLayout, slug: &str) -> Result<Block> {
    let path = vault.block_path(slug);
    let (read_slug, content) = files::read_block_file(vault, &path)
        .with_context(|| format!("failed to read preview source: {}", path.display()))?;
    parse_markdown_document(&read_slug, &content, file_saved_at(&path))
        .map(|parsed| parsed.block)
        .map_err(|error| anyhow::anyhow!("failed to parse preview source: {error}"))
}

fn file_saved_at(path: &Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    DateTime::new(&crate::util::system_time_to_iso8601(time))
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

fn cleanup_orphan_tile_previews(conn: &Connection, vault: &VaultLayout) -> Result<()> {
    let mut expected = BTreeSet::new();
    let mut stmt =
        conn.prepare("SELECT preview_manifest FROM blocks WHERE preview_manifest IS NOT NULL")?;
    for raw in stmt.query_map([], |row| row.get::<_, String>(0))? {
        let Ok(manifest) = serde_json::from_str::<FeedPreviewManifest>(&raw?) else {
            continue;
        };
        for tile in manifest.tiles {
            if let Some(path) = tile.preview_path {
                if let Ok(path) = preview_disk_path(vault, &path) {
                    expected.insert(path);
                }
            }
        }
    }
    drop(stmt);
    remove_orphan_tiles_in_dir(&vault.thumbs_dir(), &expected)?;
    Ok(())
}

fn remove_orphan_tiles_in_dir(dir: &Path, expected: &BTreeSet<PathBuf>) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries {
        let path = entry?.path();
        if path.is_dir() {
            remove_orphan_tiles_in_dir(&path, expected)?;
            continue;
        }
        let is_tile = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(".preview-") && name.ends_with(".jpg"));
        if is_tile && !expected.contains(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

fn merge_report(target: &mut PreviewReconcileReport, source: PreviewReconcileReport) {
    target.checked += source.checked;
    target.ready += source.ready;
    target.regenerated += source.regenerated;
    target.changed_slugs.extend(source.changed_slugs);
    target.failed.extend(source.failed);
    target.cancelled |= source.cancelled;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, Frontmatter};
    use crate::storage::index::FeedPreviewKind;
    use crate::storage::{db, index, reconcile};

    fn setup() -> (tempfile::TempDir, VaultLayout, Connection) {
        let source = tempfile::tempdir().unwrap();
        let derived = source.path().join(".local-derived");
        let vault = VaultLayout::with_derived_root(source.path().to_path_buf(), derived);
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        (source, vault, conn)
    }

    fn image_block(slug: &str, file: &str) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Image,
                title: None,
                description: None,
                url: None,
                file: Some(file.to_string()),
                thumbnail: None,
                tags: Vec::new(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-07-10T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: String::new(),
        }
    }

    fn text_block(slug: &str) -> Block {
        let mut block = image_block(slug, "unused.txt");
        block.frontmatter.block_type = BlockType::Article;
        block.frontmatter.file = None;
        block.body = format!("# {slug}\n\nPreview body");
        block
    }

    fn link_block(slug: &str) -> Block {
        let mut block = image_block(slug, "unused.txt");
        block.frontmatter.block_type = BlockType::Link;
        block.frontmatter.file = None;
        block.frontmatter.url = Some("https://example.com".to_string());
        block.body.clear();
        block
    }

    #[test]
    fn full_reconcile_publishes_bounded_progress_batches() {
        let (_source, vault, conn) = setup();
        for index in 0..30 {
            files::write_block_file(&vault, &text_block(&format!("Note {index:02}"))).unwrap();
        }
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let mut batch_sizes = Vec::new();
        let report =
            reconcile_all_previews_with_progress(&conn, &vault, &mut || true, &mut |batch| {
                batch_sizes.push(batch.checked)
            })
            .unwrap();

        assert_eq!(batch_sizes, vec![PREVIEW_RECONCILE_BATCH_SIZE, 6]);
        assert_eq!(report.checked, 30);
        assert_eq!(report.ready, 30);
        assert!(!report.cancelled);
    }

    #[test]
    fn missing_cache_is_regenerated_and_marked_ready() {
        let (_source, vault, conn) = setup();
        let block = image_block("Photo", "photo.png");
        let image = image::RgbImage::from_pixel(32, 24, image::Rgb([10, 20, 30]));
        image.save(vault.root().join("photo.png")).unwrap();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Photo")
            .unwrap()
            .unwrap();

        assert_eq!(outcome.state, DerivedPreviewState::Ready);
        assert!(vault.thumb_path("Photo").exists());
        assert!(vault.thumbs_dir().join("Photo.preview-1.jpg").exists());
        let state: String = conn
            .query_row(
                "SELECT preview_state FROM blocks WHERE slug = 'Photo'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn metadata_only_link_is_ready_without_bitmap_artifact() {
        let (_source, vault, conn) = setup();
        let block = link_block("AI 2027");
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "AI 2027")
            .unwrap()
            .unwrap();
        assert_eq!(outcome.state, DerivedPreviewState::Ready);
        assert!(!vault.thumb_path("AI 2027").exists());

        let (card_kind, manifest): (String, String) = conn
            .query_row(
                "SELECT card_kind, preview_manifest FROM blocks WHERE slug = 'AI 2027'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(card_kind, "link");
        assert_eq!(
            serde_json::from_str::<FeedPreviewManifest>(&manifest)
                .unwrap()
                .kind,
            FeedPreviewKind::Text
        );
    }

    #[test]
    fn media_row_rejects_text_manifest_even_when_placeholder_exists() {
        let (_source, vault, conn) = setup();
        let block = image_block("Broken media", "missing.png");
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        let text_manifest = serde_json::to_string(&FeedPreviewManifest {
            kind: FeedPreviewKind::Text,
            primary_preview_path: None,
            width: None,
            height: None,
            tiles: Vec::new(),
            overflow_count: 0,
        })
        .unwrap();
        conn.execute(
            "UPDATE blocks
             SET preview_manifest = ?1,
                 preview_state = 'ready',
                 preview_schema_version = ?2
             WHERE slug = 'Broken media'",
            params![text_manifest, index::PREVIEW_SCHEMA_VERSION],
        )
        .unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Broken media")
            .unwrap()
            .unwrap();
        assert_eq!(outcome.state, DerivedPreviewState::Failed);
        assert_eq!(
            outcome.failure.unwrap().error_kind,
            PreviewErrorKind::InvalidManifest
        );
    }

    #[test]
    fn nonvisual_file_accepts_text_manifest_without_bitmap_artifact() {
        let (_source, vault, conn) = setup();
        let mut block = image_block("Document", "document.pdf");
        block.frontmatter.block_type = BlockType::File;
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Document")
            .unwrap()
            .unwrap();
        assert_eq!(outcome.state, DerivedPreviewState::Ready);
        assert!(outcome.failure.is_none());
        assert!(!vault.thumb_path("Document").exists());
    }

    #[test]
    fn changed_dependency_stamp_replaces_ready_preview() {
        let (_source, vault, conn) = setup();
        let block = image_block("Photo", "photo.png");
        let first = image::RgbImage::from_pixel(32, 24, image::Rgb([10, 20, 30]));
        first.save(vault.root().join("photo.png")).unwrap();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        reconcile_preview_for_slug(&conn, &vault, "Photo").unwrap();
        let before = std::fs::read(vault.thumbs_dir().join("Photo.preview-1.jpg")).unwrap();

        let second = image::RgbImage::from_pixel(48, 24, image::Rgb([220, 40, 10]));
        second.save(vault.root().join("photo.png")).unwrap();
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(vault.root().join("photo.png"))
            .unwrap()
            .write_all(b"source-stamp-size-change")
            .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        reconcile_preview_for_slug(&conn, &vault, "Photo").unwrap();
        let after = std::fs::read(vault.thumbs_dir().join("Photo.preview-1.jpg")).unwrap();

        assert_ne!(before, after);
    }

    #[test]
    fn unsupported_image_stays_failed_until_browser_writes_every_asset() {
        let (_source, vault, conn) = setup();
        let block = image_block("Modern", "modern.avif");
        std::fs::write(
            vault.root().join("modern.avif"),
            b"\x00\x00\x00\x1cftypavif-not-decodable",
        )
        .unwrap();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Modern")
            .unwrap()
            .unwrap();

        assert_eq!(outcome.state, DerivedPreviewState::Failed);
        assert_eq!(
            outcome.failure.unwrap().error_kind,
            PreviewErrorKind::BrowserDecodeRequired
        );

        let decoded = image::RgbImage::from_pixel(32, 24, image::Rgb([90, 120, 180]));
        decoded.save(vault.thumb_path("Modern")).unwrap();
        decoded
            .save(vault.thumbs_dir().join("Modern.preview-1.jpg"))
            .unwrap();

        let ready = reconcile_preview_for_slug(&conn, &vault, "Modern")
            .unwrap()
            .unwrap();
        assert_eq!(ready.state, DerivedPreviewState::Ready);
        assert!(ready.failure.is_none());
    }

    #[test]
    fn legacy_primary_preview_materializes_single_tile_without_source_decode() {
        let (_source, vault, conn) = setup();
        let block = image_block("Modern", "modern.avif");
        std::fs::write(
            vault.root().join("modern.avif"),
            b"\x00\x00\x00\x1cftypavif-not-decodable",
        )
        .unwrap();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let decoded = image::RgbImage::from_pixel(32, 24, image::Rgb([90, 120, 180]));
        decoded.save(vault.thumb_path("Modern")).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Modern")
            .unwrap()
            .unwrap();

        assert_eq!(outcome.state, DerivedPreviewState::Ready);
        assert!(outcome.failure.is_none());
        let tile = vault.thumbs_dir().join("Modern.preview-1.jpg");
        assert!(tile.exists());
        assert_eq!(
            std::fs::read(vault.thumb_path("Modern")).unwrap(),
            std::fs::read(tile).unwrap()
        );
    }

    #[test]
    fn text_manifest_is_ready_without_cache_files() {
        let (_source, vault, conn) = setup();
        let mut block = image_block("Text", "unused.txt");
        block.frontmatter.block_type = BlockType::Article;
        block.frontmatter.file = None;
        block.body = "Plain text note".to_string();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Text")
            .unwrap()
            .unwrap();

        assert_eq!(outcome.state, DerivedPreviewState::Ready);
        assert!(!vault.thumb_path("Text").exists());
    }

    #[test]
    fn active_vault_cancellation_stops_before_the_next_block() {
        let (_source, vault, conn) = setup();
        for slug in ["First", "Second"] {
            let mut block = image_block(slug, "unused.txt");
            block.frontmatter.block_type = BlockType::Article;
            block.frontmatter.file = None;
            block.body = format!("Plain text note {slug}");
            files::write_block_file(&vault, &block).unwrap();
        }
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let mut checks = 0;
        let report = reconcile_preview_slugs_while(&conn, &vault, ["First", "Second"], &mut || {
            checks += 1;
            checks == 1
        })
        .unwrap();

        assert!(report.cancelled);
        assert_eq!(report.checked, 1);
        let first: String = conn
            .query_row(
                "SELECT preview_state FROM blocks WHERE slug = 'First'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let second: String = conn
            .query_row(
                "SELECT preview_state FROM blocks WHERE slug = 'Second'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first, "ready");
        assert_eq!(second, "stale");
    }

    #[test]
    fn ready_manifest_becomes_failed_when_derived_tile_is_deleted() {
        let (_source, vault, conn) = setup();
        let block = image_block("Photo", "photo.png");
        let image = image::RgbImage::from_pixel(32, 24, image::Rgb([10, 20, 30]));
        image.save(vault.root().join("photo.png")).unwrap();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        reconcile_preview_for_slug(&conn, &vault, "Photo").unwrap();
        std::fs::remove_file(vault.thumbs_dir().join("Photo.preview-1.jpg")).unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Photo")
            .unwrap()
            .unwrap();

        assert_eq!(outcome.state, DerivedPreviewState::Ready);
        assert!(outcome.regenerated);
    }

    #[test]
    fn manifest_paths_cannot_escape_derived_cache() {
        let (_source, vault, conn) = setup();
        let block = image_block("Photo", "photo.png");
        std::fs::write(vault.root().join("photo.png"), b"not-used").unwrap();
        files::write_block_file(&vault, &block).unwrap();
        index::upsert_block(&conn, &block, Some(vault.root())).unwrap();
        conn.execute(
            "UPDATE blocks SET preview_manifest = ?2 WHERE slug = ?1",
            params![
                "Photo",
                r#"{"kind":"image","primary_preview_path":"../escape.jpg","width":1,"height":1,"tiles":[],"overflow_count":0}"#
            ],
        )
        .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        conn.execute(
            "UPDATE blocks SET preview_manifest = ?2 WHERE slug = ?1",
            params![
                "Photo",
                r#"{"kind":"image","primary_preview_path":"../escape.jpg","width":1,"height":1,"tiles":[],"overflow_count":0}"#
            ],
        )
        .unwrap();

        let outcome = reconcile_preview_for_slug(&conn, &vault, "Photo")
            .unwrap()
            .unwrap();

        assert_eq!(outcome.state, DerivedPreviewState::Failed);
        assert!(!vault.derived_root().join("escape.jpg").exists());
    }

    #[test]
    fn stale_worker_cannot_publish_ready_after_manifest_changes() {
        let (_source, vault, conn) = setup();
        let block = image_block("Photo", "photo.png");
        let image = image::RgbImage::from_pixel(16, 16, image::Rgb([10, 20, 30]));
        image.save(vault.root().join("photo.png")).unwrap();
        files::write_block_file(&vault, &block).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let old_manifest: String = conn
            .query_row(
                "SELECT preview_manifest FROM blocks WHERE slug = 'Photo'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source_stamp: String = conn
            .query_row(
                "SELECT source_stamp FROM source_index_state WHERE slug = 'Photo'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE blocks
             SET preview_manifest = replace(preview_manifest, 'Photo.preview-1.jpg', 'Photo.preview-2.jpg'),
                 preview_state = 'stale'
             WHERE slug = 'Photo'",
            [],
        )
        .unwrap();

        let publish = update_preview_state(
            &conn,
            "Photo",
            DerivedPreviewState::Ready,
            Some(&source_stamp),
            None,
            Some(&old_manifest),
        );
        assert!(publish.is_err());
        let state: String = conn
            .query_row(
                "SELECT preview_state FROM blocks WHERE slug = 'Photo'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "stale");
    }

    #[test]
    fn planned_manifest_uses_derived_paths_for_every_tile() {
        let (_source, vault, conn) = setup();
        let mut block = image_block("Gallery", "unused.txt");
        block.frontmatter.block_type = BlockType::Article;
        block.frontmatter.file = None;
        block.body = "![[a.jpg]]\n\n![[b.jpg]]".to_string();
        std::fs::write(vault.root().join("a.jpg"), b"a").unwrap();
        std::fs::write(vault.root().join("b.jpg"), b"b").unwrap();
        index::upsert_block(&conn, &block, Some(vault.root())).unwrap();
        let raw: String = conn
            .query_row(
                "SELECT preview_manifest FROM blocks WHERE slug = 'Gallery'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let manifest: FeedPreviewManifest = serde_json::from_str(&raw).unwrap();

        assert_eq!(manifest.kind, FeedPreviewKind::Composite);
        assert_eq!(
            manifest
                .tiles
                .iter()
                .filter_map(|tile| tile.preview_path.as_deref())
                .collect::<Vec<_>>(),
            vec!["Gallery.preview-1.jpg", "Gallery.preview-2.jpg"]
        );
    }
}
