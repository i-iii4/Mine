// Handler: orchestrates file changes into index updates.
//
// Provides full_scan (initial vault indexing), index_md_file (single file),
// and handle_event (dispatch vault events to appropriate storage ops).
//
// Contract: SPEC_INTEGRATION.md#watcher/handler

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::domain::block::{compute_body_hash, parse_block, Block, BlockType};
use crate::domain::vault::{normalize_filename_stem, VaultLayout};
use crate::storage::{article_audio, db, files, index, thumbnails};
use crate::watcher::events::VaultEvent;

// ─── Event payloads (Rust → Frontend) ───────────────────────────────────────

/// Emitted after `index_md_file` upserts a block into the index. Carries
/// just enough for `useChannelPreviewsEvents` to add a `PreviewCard` to
/// every affected channel without refetching anything.
#[derive(Debug, Clone, Serialize)]
struct BlockAddedPayload {
    slug: String,
    tags: Vec<String>,
    is_text: bool,
}

/// Emitted after `handle_event(BlockDeleted)` strips a block from the
/// index. Carries the tags the block HAD at delete time so the sidebar
/// can drop the preview card from each matching channel.
#[derive(Debug, Clone, Serialize)]
struct BlockRemovedPayload {
    slug: String,
    tags: Vec<String>,
}

/// Emitted after a Phase 1 thumbnail write (Rust cascade). Frontend
/// cache-busts `<img>` elements pointing at `<slug>.jpg`.
#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
    is_text: bool,
}

/// Emitted when Phase 1 produced a text placeholder for a block whose
/// embedded media could, in principle, be rendered by the WebView
/// decoder. Frontend worker picks it up and produces a real JPEG via
/// `createImageBitmap` / `<video>` → `save_thumb`.
#[derive(Debug, Clone, Serialize)]
struct ThumbUpgradeRequestedPayload {
    slug: String,
    #[serde(rename = "mediaPath")]
    media_path: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
struct ArticleAudioUpdatedPayload {
    slug: String,
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// Result of a full vault scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanResult {
    /// Number of blocks successfully indexed.
    pub indexed: usize,
    /// Number of files that failed to parse.
    pub errors: usize,
}

const ARTICLE_AUDIO_UPDATED_EVENT: &str = "article-audio-updated";

// ─── Public API ─────────────────────────────────────────────────────────────

/// Scan the entire vault: parse all .md files and index them.
///
/// Indexing happens synchronously (fast). Thumbnail generation runs in a
/// background thread to avoid blocking app startup. Returns immediately
/// after indexing completes.
///
/// `on_thumbs_done` is called from the background thread when all thumbnails
/// have been generated. Use this to notify the frontend to refresh previews.
pub fn full_scan(
    conn: &Connection,
    vault: &VaultLayout,
    on_thumbs_done: Option<Box<dyn FnOnce() + Send>>,
    app: Option<AppHandle>,
) -> Result<ScanResult> {
    let paths = files::scan_md_files(vault)?;
    let mut indexed = 0;
    let mut errors = 0;

    // Collect thumbnail work items during indexing.
    // Each job owns its parsed Block so the background thread can
    // delegate the full cascade to thumbnails::generate_for_block.
    let mut thumb_jobs: Vec<ThumbJob> = Vec::new();

    // Wrap all indexing in a single transaction for performance (one commit
    // instead of N commits). Individual upsert_block calls use savepoints.
    let tx = conn
        .unchecked_transaction()
        .context("failed to begin transaction for full_scan")?;

    for path in &paths {
        // Phase 18.G.3: iCloud conflict files go into vault_conflicts
        // and are not treated as independent blocks. Skip them here
        // before the indexer sees them.
        if let Some(stem) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(normalize_filename_stem)
        {
            if let Some(base_slug) = crate::domain::vault::detect_icloud_conflict(&stem) {
                let _ = index::record_vault_conflict(&tx, &base_slug, &stem);
                log::info!(
                    "iCloud conflict detected during scan: {} (base slug: {})",
                    stem,
                    base_slug
                );
                continue;
            }
        }

        match index_md_file_inner(&tx, vault, path) {
            Ok(outcome) => {
                indexed += 1;
                if let Some(j) = outcome.thumb_job {
                    thumb_jobs.push(j);
                }
                if outcome.audio_invalidated {
                    if let Some(ref app) = app {
                        emit_article_audio_updated(app, &outcome.slug);
                    }
                }
            }
            Err(e) => {
                log::warn!("failed to index {}: {:#}", path.display(), e);
                errors += 1;
            }
        }
    }

    // Remove orphan index entries whose .md file no longer exists on
    // disk. Covers renamed/deleted blocks that left stale DB rows.
    // iCloud conflict files are filtered out so their presence on disk
    // doesn't falsely keep an unrelated same-stemmed row alive, and
    // conflict stems themselves don't count as real blocks.
    let live_slugs: std::collections::HashSet<String> = paths
        .iter()
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(normalize_filename_stem))
        .filter(|stem| crate::domain::vault::detect_icloud_conflict(stem).is_none())
        .collect();
    let all_indexed = index::list_blocks_light(&tx).unwrap_or_default();
    let mut orphans_removed = 0;
    for block in &all_indexed {
        if block.slug.is_empty() || block.block_type == BlockType::Channel {
            continue;
        }
        if !live_slugs.contains(&block.slug) {
            let _ = index::remove_block(&tx, &block.slug);
            // Also remove orphan thumbnail
            let thumb = vault.thumb_path(&block.slug);
            if thumb.exists() {
                let _ = std::fs::remove_file(&thumb);
            }
            let _ = article_audio::delete_all_artifacts(vault, &block.slug);
            orphans_removed += 1;
        }
    }
    if orphans_removed > 0 {
        log::info!(
            "full_scan: removed {} orphan index entries",
            orphans_removed
        );
    }

    tx.commit()
        .context("failed to commit full_scan transaction")?;

    // Spawn background thread for thumbnail generation
    if !thumb_jobs.is_empty() {
        let vault_clone = vault.clone();
        let app_clone = app.clone();
        match std::thread::Builder::new()
            .name("thumb-gen".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let metadata_conn = db::open_or_create(&vault_clone.index_db_path())
                        .map_err(|e| {
                            log::error!("thumb-gen: open metadata db failed: {e:#}");
                            e
                        })
                        .ok();
                    let total = thumb_jobs.len();
                    let mut generated = 0;
                    let mut skipped = 0;
                    let mut metadata_updates = 0;
                    for job in &thumb_jobs {
                        let thumb_path = vault_clone.thumb_path(&job.block.slug);

                        // O1: skip if thumbnail is fresh (exists, newer than
                        // source, valid magic, and format matches what the
                        // current pipeline would produce for this block).
                        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path, &job.block, &vault_clone) {
                            skipped += 1;
                            if let Some(ref conn) = metadata_conn {
                                match index::sync_thumb_metadata(
                                    conn,
                                    &job.block.slug,
                                    &thumb_path,
                                    Some(vault_clone.root()),
                                ) {
                                    Ok(true) => metadata_updates += 1,
                                    Ok(false) => {}
                                    Err(e) => log::warn!(
                                        "thumb-gen: sync fresh metadata failed for {}: {e:#}",
                                        job.block.slug
                                    ),
                                }
                            }
                            continue;
                        }

                        let source = thumbnails::generate_for_block(&job.block, &vault_clone);
                        if let Some(ref conn) = metadata_conn {
                            match index::sync_thumb_metadata(
                                conn,
                                &job.block.slug,
                                &thumb_path,
                                Some(vault_clone.root()),
                            ) {
                                Ok(true) => metadata_updates += 1,
                                Ok(false) => {}
                                Err(e) => log::warn!(
                                    "thumb-gen: sync generated metadata failed for {}: {e:#}",
                                    job.block.slug
                                ),
                            }
                        }
                        if source != thumbnails::ThumbSource::None {
                            generated += 1;
                            // Notify frontend per-thumb so the sidebar
                            // updates URLs incrementally as legacy thumbs
                            // get migrated, rather than waiting for the
                            // whole batch to finish.
                            if let Some(ref app) = app_clone {
                                emit_thumb_events(app, &vault_clone, &job.block, source);
                            }
                        }
                    }
                    log::info!(
                        "thumbnails: {} generated, {} skipped (fresh), {} metadata updates, {} total",
                        generated, skipped, metadata_updates, total
                    );
                    generated + metadata_updates
                }));
                match result {
                    Ok(changed) => {
                        if changed > 0 {
                            if let Some(cb) = on_thumbs_done {
                                cb();
                            }
                        }
                    }
                    Err(_) => {
                        log::error!("thumb-gen thread panicked");
                    }
                }
            })
        {
            Ok(_handle) => { /* detached: thumbnail generation runs in background */ }
            Err(e) => log::error!("failed to spawn thumb-gen thread: {}", e),
        }
    }

    Ok(ScanResult { indexed, errors })
}

/// Scan only files whose source mtime is newer than the last indexed_at
/// marker stored in SQLite. New files (including channel docs) are always
/// parsed. Deleted files are removed from the index after the pass.
pub fn incremental_scan(
    conn: &Connection,
    vault: &VaultLayout,
    on_thumbs_done: Option<Box<dyn FnOnce() + Send>>,
    app: Option<AppHandle>,
) -> Result<ScanResult> {
    let paths = files::scan_md_files(vault)?;
    let indexed_at_map = index::get_block_indexed_at_map(conn)?;
    let mut indexed = 0;
    let mut errors = 0;
    let mut thumb_jobs: Vec<ThumbJob> = Vec::new();
    let mut live_slugs = std::collections::HashSet::<String>::new();

    let tx = conn
        .unchecked_transaction()
        .context("failed to begin transaction for incremental_scan")?;

    for path in &paths {
        if let Some(slug) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(normalize_filename_stem)
        {
            live_slugs.insert(slug.clone());
            if let Some(indexed_at) = indexed_at_map.get(&slug) {
                if file_mtime_secs(path).is_some_and(|mtime| mtime <= *indexed_at) {
                    continue;
                }
            }
        }

        match index_md_file_inner(&tx, vault, path) {
            Ok(outcome) => {
                indexed += 1;
                if let Some(j) = outcome.thumb_job {
                    thumb_jobs.push(j);
                }
                if outcome.audio_invalidated {
                    if let Some(ref app) = app {
                        emit_article_audio_updated(app, &outcome.slug);
                    }
                }
            }
            Err(e) => {
                log::warn!("failed to incrementally index {}: {:#}", path.display(), e);
                errors += 1;
            }
        }
    }

    let mut orphans_removed = 0usize;
    for slug in indexed_at_map.keys() {
        if !live_slugs.contains(slug) {
            let _ = index::remove_block(&tx, slug);
            let thumb = vault.thumb_path(slug);
            if thumb.exists() {
                let _ = std::fs::remove_file(&thumb);
            }
            let _ = article_audio::delete_all_artifacts(vault, slug);
            orphans_removed += 1;
        }
    }

    let channels = index::list_channels(&tx).unwrap_or_default();
    let mut channels_removed = 0usize;
    for channel in channels {
        if !live_slugs.contains(&channel.tag) {
            let _ = index::remove_channel(&tx, &channel.tag);
            channels_removed += 1;
        }
    }
    if orphans_removed > 0 || channels_removed > 0 {
        log::info!(
            "incremental_scan: removed {} orphan blocks and {} orphan channels",
            orphans_removed,
            channels_removed
        );
    }

    tx.commit()
        .context("failed to commit incremental_scan transaction")?;

    if !thumb_jobs.is_empty() {
        let vault_clone = vault.clone();
        let app_clone = app.clone();
        match std::thread::Builder::new()
            .name("thumb-gen".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let metadata_conn = db::open_or_create(&vault_clone.index_db_path())
                        .map_err(|e| {
                            log::error!("thumb-gen: open metadata db failed: {e:#}");
                            e
                        })
                        .ok();
                    let total = thumb_jobs.len();
                    let mut generated = 0;
                    let mut skipped = 0;
                    let mut metadata_updates = 0;
                    for job in &thumb_jobs {
                        let thumb_path = vault_clone.thumb_path(&job.block.slug);
                        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path, &job.block, &vault_clone) {
                            skipped += 1;
                            if let Some(ref conn) = metadata_conn {
                                match index::sync_thumb_metadata(
                                    conn,
                                    &job.block.slug,
                                    &thumb_path,
                                    Some(vault_clone.root()),
                                ) {
                                    Ok(true) => metadata_updates += 1,
                                    Ok(false) => {}
                                    Err(e) => log::warn!(
                                        "thumb-gen: sync fresh metadata failed for {}: {e:#}",
                                        job.block.slug
                                    ),
                                }
                            }
                            continue;
                        }

                        let source = thumbnails::generate_for_block(&job.block, &vault_clone);
                        if let Some(ref conn) = metadata_conn {
                            match index::sync_thumb_metadata(
                                conn,
                                &job.block.slug,
                                &thumb_path,
                                Some(vault_clone.root()),
                            ) {
                                Ok(true) => metadata_updates += 1,
                                Ok(false) => {}
                                Err(e) => log::warn!(
                                    "thumb-gen: sync generated metadata failed for {}: {e:#}",
                                    job.block.slug
                                ),
                            }
                        }
                        if source != thumbnails::ThumbSource::None {
                            generated += 1;
                            if let Some(ref app) = app_clone {
                                emit_thumb_events(app, &vault_clone, &job.block, source);
                            }
                        }
                    }
                    log::info!(
                        "incremental thumbnails: {} generated, {} skipped (fresh), {} metadata updates, {} total",
                        generated, skipped, metadata_updates, total
                    );
                    generated + metadata_updates
                }));
                match result {
                    Ok(changed) => {
                        if changed > 0 {
                            if let Some(cb) = on_thumbs_done {
                                cb();
                            }
                        }
                    }
                    Err(_) => {
                        log::error!("thumb-gen thread panicked");
                    }
                }
            })
        {
            Ok(_handle) => {}
            Err(e) => log::error!("failed to spawn thumb-gen thread: {}", e),
        }
    }

    Ok(ScanResult { indexed, errors })
}

/// Index a single .md file: read, parse, upsert, generate thumbnail.
///
/// Used by handle_event for individual file changes. Thumbnail is generated
/// in a background thread to avoid blocking the file watcher.
///
/// When `app` is `Some`, emits `block:added` immediately after upsert and
/// `thumb:updated` / `thumb:upgrade-requested` from the background thumb
/// thread. These events drive the event-driven sidebar (SPEC_THUMBNAILS.md
/// Phase 3). `None` is used by unit tests that don't need emit plumbing.
pub fn index_md_file(
    conn: &Connection,
    vault: &VaultLayout,
    path: &Path,
    app: Option<&AppHandle>,
) -> Result<bool> {
    // Divert iCloud sync-conflict files into the vault_conflicts surface
    // instead of indexing them as independent blocks. Phase 18.G.3: the
    // UI surfaces unresolved conflicts; the user picks a resolution
    // explicitly instead of silently ending up with two duplicate blocks.
    if let Some(stem) = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(crate::domain::vault::normalize_filename_stem)
    {
        if let Some(base_slug) = crate::domain::vault::detect_icloud_conflict(&stem) {
            if let Err(e) = index::record_vault_conflict(conn, &base_slug, &stem) {
                log::warn!(
                    "failed to record vault conflict for {}: {}",
                    stem,
                    e
                );
            } else {
                log::info!(
                    "iCloud conflict detected: {} (base slug: {})",
                    stem,
                    base_slug
                );
                if let Some(app) = app {
                    let _ = app.emit(
                        "vault-conflict-detected",
                        VaultConflictPayload {
                            base_slug,
                            conflict_slug: stem,
                        },
                    );
                }
            }
            return Ok(false);
        }
    }

    let outcome = index_md_file_inner(conn, vault, path)?;

    if outcome.audio_invalidated {
        if let Some(app) = app {
            emit_article_audio_updated(app, &outcome.slug);
        }
    }

    if let Some(job) = outcome.thumb_job {
        // Emit block:added synchronously — frontend wants this latency to
        // be as low as possible so newly-clipped blocks appear in the
        // sidebar before the background thumb thread even wakes up. The
        // text-ness classification mirrors list_channel_previews so
        // incremental updates and the initial bulk load agree.
        if let Some(app) = app {
            let is_text = job.block.frontmatter.block_type == BlockType::Article
                && job.block.frontmatter.file.is_none()
                && job.block.frontmatter.thumbnail.is_none()
                && thumbnails::find_first_local_media(&job.block.body, thumbnails::is_image_ext)
                    .is_none();
            let _ = app.emit(
                "block:added",
                BlockAddedPayload {
                    slug: job.block.slug.clone(),
                    tags: job.block.frontmatter.tags.clone(),
                    is_text,
                },
            );
        }

        let thumb_path = vault.thumb_path(&job.block.slug);

        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path, &job.block, vault) {
            let _ =
                index::sync_thumb_metadata(conn, &job.block.slug, &thumb_path, Some(vault.root()));
            return Ok(true);
        }

        // Generate thumbnail in background thread to avoid blocking file
        // watcher. After the cascade runs, inspect the result and fire
        // follow-up events (thumb:updated always, upgrade-requested if
        // the thumb is a text placeholder and the block has upgradable
        // media).
        let vault = vault.clone();
        let slug = job.block.slug.clone();
        let app_clone = app.cloned();
        std::thread::Builder::new()
            .name(format!("thumb-{}", &slug))
            .spawn(move || {
                let source = thumbnails::generate_for_block(&job.block, &vault);
                match db::open_or_create(&vault.index_db_path()) {
                    Ok(conn) => {
                        if let Err(e) = index::sync_thumb_metadata(
                            &conn,
                            &slug,
                            &thumb_path,
                            Some(vault.root()),
                        ) {
                            log::warn!("thumb thread: sync metadata failed for {}: {e:#}", slug);
                        }
                    }
                    Err(e) => {
                        log::warn!("thumb thread: open metadata db failed for {}: {e:#}", slug)
                    }
                }
                if let Some(app) = app_clone {
                    emit_thumb_events(&app, &vault, &job.block, source);
                }
            })
            .ok();
    }

    Ok(true)
}

/// Emit `thumb:updated` and (when applicable) `thumb:upgrade-requested`
/// after a Phase 1 cascade run. Lives as a free function so tests can
/// call `generate_for_block` directly without an AppHandle.
fn emit_thumb_events(
    app: &AppHandle,
    vault: &VaultLayout,
    block: &Block,
    source: thumbnails::ThumbSource,
) {
    // `None` means the cascade decided not to write any thumb (non-article
    // block with no resolvable media). Nothing for the sidebar to refresh.
    if source == thumbnails::ThumbSource::None {
        return;
    }
    let _ = app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug: block.slug.clone(),
            is_text: source == thumbnails::ThumbSource::Text,
        },
    );

    // Only text placeholders trigger upgrade requests. Real JPEG thumbs
    // from Rust decode are already the final result.
    if source != thumbnails::ThumbSource::Text {
        return;
    }
    if let Some((media_path, kind)) = resolve_upgrade_media_for_block(vault, block) {
        let _ = app.emit(
            "thumb:upgrade-requested",
            ThumbUpgradeRequestedPayload {
                slug: block.slug.clone(),
                media_path: media_path.to_string_lossy().into_owned(),
                kind: kind.into(),
            },
        );
    }
}

/// Mirror of `commands::thumbnails::resolve_upgrade_media` but working
/// off a full `Block` (the version we have after parse). Priority matches
/// `generate_for_block`'s cascade so the Phase 2 upgrade replaces the
/// placeholder with the same media Rust would have used.
fn resolve_upgrade_media_for_block(
    vault: &VaultLayout,
    block: &Block,
) -> Option<(PathBuf, &'static str)> {
    // 1. frontmatter.file — use filename from frontmatter directly
    if let Some(ref file_name) = block.frontmatter.file {
        let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
        let media_path = vault.root().join(file_name);
        if media_path.exists() {
            if thumbnails::is_image_ext(&ext) {
                return Some((media_path, "image"));
            }
            if thumbnails::is_video_ext(&ext) {
                return Some((media_path, "video"));
            }
        }
    }

    // 2. frontmatter.thumbnail
    if let Some(ref thumb_file) = block.frontmatter.thumbnail {
        let ext = thumb_file.rsplit('.').next().unwrap_or("").to_lowercase();
        if thumbnails::is_image_ext(&ext) {
            let media_path = vault.root().join(thumb_file);
            if media_path.exists() {
                return Some((media_path, "image"));
            }
        }
    }

    // 3. First body image / 4. first body video
    if let Some(first_image) =
        thumbnails::find_first_local_media(&block.body, thumbnails::is_image_ext)
    {
        let media_path = vault.root().join(&first_image);
        if media_path.exists() {
            return Some((media_path, "image"));
        }
    }
    if let Some(first_video) =
        thumbnails::find_first_local_media(&block.body, thumbnails::is_video_ext)
    {
        let media_path = vault.root().join(&first_video);
        if media_path.exists() {
            return Some((media_path, "video"));
        }
    }

    None
}

// ─── Internal ───────────────────────────────────────────────────────────────

/// Describes a pending thumbnail generation job. Owns the parsed Block —
/// background thread calls `thumbnails::generate_for_block(&block, vault)`
/// which contains the full cascade (media file → thumbnail field → first
/// body image → first body video → text fallback).
struct ThumbJob {
    block: Block,
    /// Path to the source file (.md) for mtime comparison in is_thumb_fresh.
    source_path: PathBuf,
}

struct IndexMdOutcome {
    slug: String,
    thumb_job: Option<ThumbJob>,
    audio_invalidated: bool,
}

/// Core indexing logic: parse + upsert. Returns a ThumbJob if a thumbnail
/// should be (re-)generated.
fn index_md_file_inner(
    conn: &Connection,
    vault: &VaultLayout,
    path: &Path,
) -> Result<IndexMdOutcome> {
    let (slug, content) =
        files::read_block_file(path).with_context(|| format!("reading {}", path.display()))?;

    let block =
        parse_block(&slug, &content).with_context(|| format!("parsing {}", path.display()))?;

    // Channel files → index as channel, no thumbnail
    if block.frontmatter.block_type == BlockType::Channel {
        index::upsert_channel_from_block(conn, &block)
            .with_context(|| format!("indexing channel {}", path.display()))?;
        let audio_invalidated = article_audio::delete_all_artifacts(vault, &block.slug)?;
        return Ok(IndexMdOutcome {
            slug: block.slug,
            thumb_job: None,
            audio_invalidated,
        });
    }

    index::upsert_block(conn, &block, Some(vault.root()))
        .with_context(|| format!("indexing {}", path.display()))?;
    let audio_invalidated = article_audio::invalidate_for_block(vault, &block)?;

    Ok(IndexMdOutcome {
        slug: block.slug.clone(),
        thumb_job: Some(ThumbJob {
            block,
            source_path: path.to_path_buf(),
        }),
        audio_invalidated,
    })
}

/// Handle a single vault event: dispatch to the appropriate storage operation.
///
/// When `app` is `Some`, emits Tauri events (`block:added`, `block:removed`,
/// `thumb:updated`, `thumb:upgrade-requested`) to drive the event-driven
/// sidebar in the frontend. Tests pass `None` to exercise the pure logic.
// ─── Rename-detection pending queue (Phase 18.G) ────────────────────────────
//
// Filesystem-level rename on macOS surfaces as a BlockDeleted followed by a
// BlockChanged. Without correlation, this class of events destroys block
// identity: thumb cache becomes an orphan, audio playback position is lost,
// wikilinks break. We defer BlockDeleted events briefly and correlate them
// with an incoming BlockChanged that shares the same content hash. When a
// match appears within the debounce window, we issue a rename_slug and
// migrate derived-store artifacts (thumb .jpg, audio .wav + sidecar) in
// place. Entries that time out without a match fall through to a real
// block removal as if they had been removed immediately.

/// Window during which a BlockDeleted event waits for a matching
/// BlockChanged before being committed as a real removal.
const RENAME_MATCH_WINDOW_MS: u64 = 500;

#[derive(Debug, Clone)]
struct PendingRemove {
    slug: String,
    body_hash: Option<String>,
    /// Tags captured before removal so the eventual `block:removed` event
    /// tells the frontend which channels to invalidate.
    tags: Vec<String>,
    deadline: Instant,
}

fn pending_queue() -> &'static Mutex<Vec<PendingRemove>> {
    static QUEUE: Mutex<Vec<PendingRemove>> = Mutex::new(Vec::new());
    &QUEUE
}

fn push_pending_remove(entry: PendingRemove) {
    if let Ok(mut q) = pending_queue().lock() {
        q.push(entry);
    }
}

/// Remove and return the first pending entry whose body hash matches.
fn take_pending_by_hash(hash: &str) -> Option<PendingRemove> {
    let mut q = pending_queue().lock().ok()?;
    let pos = q
        .iter()
        .position(|p| p.body_hash.as_deref() == Some(hash))?;
    Some(q.remove(pos))
}

/// Drain entries whose deadline has already passed. Caller commits each
/// as a real block removal.
fn drain_expired_pending() -> Vec<PendingRemove> {
    let now = Instant::now();
    let mut q = match pending_queue().lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let mut expired = Vec::new();
    q.retain(|p| {
        if p.deadline <= now {
            expired.push(p.clone());
            false
        } else {
            true
        }
    });
    expired
}

/// Test-only: drain the entire pending queue and commit every entry as a
/// removal, regardless of deadline. Lets unit tests assert post-removal
/// state without sleeping for the rename-match window.
#[cfg(test)]
fn flush_pending_for_test(conn: &Connection, vault: &VaultLayout, app: Option<&AppHandle>) {
    let pending: Vec<PendingRemove> = match pending_queue().lock() {
        Ok(mut g) => g.drain(..).collect(),
        Err(_) => return,
    };
    for p in pending {
        commit_deferred_removal(conn, vault, &p, app);
    }
}

/// Rename a block's derived-store artifacts in place so they continue to
/// serve the new slug after a rename_slug migration. Best-effort: missing
/// files are skipped silently (the regular generation paths will recreate
/// them on demand).
fn rename_derived_artifacts(vault: &VaultLayout, old_slug: &str, new_slug: &str) {
    if old_slug == new_slug {
        return;
    }
    // Thumbnail .jpg
    let old_thumb = vault.thumb_path(old_slug);
    let new_thumb = vault.thumb_path(new_slug);
    if old_thumb.exists() && !new_thumb.exists() {
        if let Err(e) = std::fs::rename(&old_thumb, &new_thumb) {
            log::warn!(
                "rename thumb {} -> {} failed: {}",
                old_thumb.display(),
                new_thumb.display(),
                e
            );
        }
    }
    // Article audio .wav + sidecar .json — articles only, but rename is
    // extension-agnostic so we iterate over the audio cache directory.
    for ext in ["wav", "json"] {
        let old_path = vault.article_audio_asset_path(old_slug, ext);
        let new_path = vault.article_audio_asset_path(new_slug, ext);
        if old_path.exists() && !new_path.exists() {
            if let Err(e) = std::fs::rename(&old_path, &new_path) {
                log::warn!(
                    "rename audio artifact {} -> {} failed: {}",
                    old_path.display(),
                    new_path.display(),
                    e
                );
            }
        }
    }
}

/// Commit a deferred block removal as if it had been processed immediately.
/// Used when the rename-match window expires without an incoming Create.
fn commit_deferred_removal(
    conn: &Connection,
    vault: &VaultLayout,
    pending: &PendingRemove,
    app: Option<&AppHandle>,
) {
    if let Err(e) = index::remove_block(conn, &pending.slug) {
        log::warn!(
            "deferred removal: index::remove_block for {} failed: {}",
            pending.slug,
            e
        );
    }
    let _ = article_audio::delete_all_artifacts(vault, &pending.slug);
    if let Some(app) = app {
        let _ = app.emit(
            "block:removed",
            BlockRemovedPayload {
                slug: pending.slug.clone(),
                tags: pending.tags.clone(),
            },
        );
        let _ = app.emit(
            "thumb:updated",
            ThumbUpdatedPayload {
                slug: pending.slug.clone(),
                is_text: false,
            },
        );
    }
}

#[derive(Debug, Clone, Serialize)]
struct BlockRenamedPayload {
    old_slug: String,
    new_slug: String,
}

#[derive(Debug, Clone, Serialize)]
struct VaultConflictPayload {
    base_slug: String,
    conflict_slug: String,
}

/// Read a .md file and compute its body hash for rename-match comparison.
/// Body is taken after frontmatter parsing so filename or metadata edits
/// do not break identity for unchanged content.
fn read_body_hash_from_md(path: &Path) -> Result<String> {
    let (slug, content) = files::read_block_file(path)?;
    // parse_block peels off frontmatter; if it fails we treat the whole
    // content as the body, since hashing the raw file still gives a
    // stable identity for the rename match.
    let body = match parse_block(&slug, &content) {
        Ok(block) => block.body,
        Err(_) => content,
    };
    Ok(compute_body_hash(&body))
}

/// Commit a rename-match: update DB slug, migrate derived artifacts, and
/// notify the frontend. Runs the regular index_md_file path afterwards
/// so any metadata changes in the renamed file (title, tags) also land.
fn perform_rename_match(
    conn: &Connection,
    vault: &VaultLayout,
    pending: &PendingRemove,
    new_slug: &str,
    new_path: &Path,
    app: Option<&AppHandle>,
) -> Result<bool> {
    log::info!(
        "watcher: rename detected {} -> {} (body hash match)",
        pending.slug,
        new_slug
    );

    match index::rename_slug(conn, &pending.slug, new_slug) {
        Ok(true) => {
            rename_derived_artifacts(vault, &pending.slug, new_slug);
            if let Some(app) = app {
                let _ = app.emit(
                    "block:renamed",
                    BlockRenamedPayload {
                        old_slug: pending.slug.clone(),
                        new_slug: new_slug.to_string(),
                    },
                );
            }
        }
        Ok(false) => {
            // Old slug was not in index (shouldn't happen — we captured
            // body_hash from it on remove). Fall through to index.
            log::warn!(
                "rename_slug: source slug {} not found; indexing {} as new",
                pending.slug,
                new_slug
            );
        }
        Err(e) => {
            log::warn!(
                "rename_slug {} -> {} failed: {}; treating as separate blocks",
                pending.slug,
                new_slug,
                e
            );
            // Commit the deferred removal and fall through to normal
            // indexing so both blocks end up in a consistent state.
            commit_deferred_removal(conn, vault, pending, app);
        }
    }

    // Re-index the new file so title/tags/preview changes (not just the
    // rename) are captured.
    index_md_file(conn, vault, new_path, app)
}

pub fn handle_event(
    conn: &Connection,
    vault: &VaultLayout,
    event: &VaultEvent,
    app: Option<&AppHandle>,
) -> Result<bool> {
    // Before any dispatch, commit removals whose rename-match window
    // expired. Keeps the pending queue bounded and ensures deferred
    // deletes are eventually visible to the frontend.
    for expired in drain_expired_pending() {
        commit_deferred_removal(conn, vault, &expired, app);
    }

    match event {
        VaultEvent::BlockChanged(path) => {
            // Rename detection: if this looks like a brand-new slug and its
            // body matches a recently-deferred removal, migrate identity
            // instead of creating a second row.
            if let Some(new_slug) = path_to_slug(path) {
                let already_indexed = index::get_block(conn, &new_slug)
                    .ok()
                    .flatten()
                    .is_some();
                if !already_indexed {
                    if let Ok(body_hash) = read_body_hash_from_md(path) {
                        if let Some(pending) = take_pending_by_hash(&body_hash) {
                            return perform_rename_match(
                                conn, vault, &pending, &new_slug, path, app,
                            );
                        }
                    }
                }
            }
            return index_md_file(conn, vault, path, app);
        }
        VaultEvent::BlockDeleted(path) => {
            if let Some(slug) = path_to_slug(path) {
                // Defer the removal into the rename-detection queue.
                // Capture body hash and tags now so either a matching Create
                // within the window can rename identity cleanly, or the
                // expired drain can emit block:removed with the right
                // channel list. The DB row itself is NOT removed yet —
                // rename_slug on match would fail if we pre-deleted.
                let body_hash = index::lookup_body_hash(conn, &slug)
                    .ok()
                    .flatten();
                let tags = index::get_block(conn, &slug)
                    .ok()
                    .flatten()
                    .map(|b| b.tags)
                    .unwrap_or_default();
                push_pending_remove(PendingRemove {
                    slug,
                    body_hash,
                    tags,
                    deadline: Instant::now() + Duration::from_millis(RENAME_MATCH_WINDOW_MS),
                });
                // Treat as "no-change for now". If no match arrives, the
                // next handle_event call will drain and commit it.
                return Ok(false);
            }
        }
        VaultEvent::MediaChanged(path) => {
            if let Some(slug) = path_to_slug(path) {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if thumbnails::is_image_ext(&ext) {
                    let thumb_path = vault.thumb_path(&slug);
                    let path_owned = path.to_path_buf();
                    std::thread::Builder::new()
                        .name(format!("thumb-media-{}", &slug))
                        .spawn(move || {
                            if let Err(e) = thumbnails::generate_thumbnail(
                                &path_owned,
                                &thumb_path,
                                thumbnails::DEFAULT_MAX_SIZE,
                            ) {
                                log::warn!("thumbnail failed for {}: {}", slug, e);
                            }
                        })
                        .ok();
                }
            }
            return Ok(false);
        }
        VaultEvent::MediaDeleted(path) => {
            if let Some(slug) = path_to_slug(path) {
                let thumb_path = vault.thumb_path(&slug);
                let had_thumb = thumb_path.exists();
                if thumb_path.exists() {
                    let _ = std::fs::remove_file(&thumb_path);
                }
                return Ok(had_thumb);
            }
        }
    }
    Ok(false)
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Extract slug from a file path (file stem without extension).
/// Normalizes to NFC so HFS+ (NFD) and APFS (NFC) representations of the
/// same logical filename resolve to one identity.
fn path_to_slug(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(normalize_filename_stem)
}

fn file_mtime_secs(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn emit_article_audio_updated(app: &AppHandle, slug: &str) {
    let _ = app.emit(
        ARTICLE_AUDIO_UPDATED_EVENT,
        ArticleAudioUpdatedPayload {
            slug: slug.to_string(),
        },
    );
}

// Extension predicates (is_image_ext, is_video_ext) live in
// storage::thumbnails as the single source of truth.

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, DateTime, Frontmatter};
    use crate::storage::db;

    fn test_conn() -> Connection {
        db::open_memory().unwrap()
    }

    fn write_md_file(vault: &VaultLayout, slug: &str, block_type: &str, tags: &[&str]) {
        write_md_file_with_body(vault, slug, block_type, tags, "");
    }

    fn write_md_file_with_body(
        vault: &VaultLayout,
        slug: &str,
        block_type: &str,
        tags: &[&str],
        body: &str,
    ) {
        let block = crate::domain::block::Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::from_str(block_type).unwrap(),
                title: Some(slug.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: tags.iter().map(|t| t.to_string()).collect(),
                saved_at: DateTime::new("2026-01-15T12:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: body.to_string(),
        };
        files::write_block_file(vault, &block).unwrap();
    }

    // ── full_scan ────────────────────────────────────────────────────────

    #[test]
    fn full_scan_empty_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(
            result,
            ScanResult {
                indexed: 0,
                errors: 0
            }
        );
    }

    #[test]
    fn full_scan_indexes_all_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "alpha", "image", &["photo"]);
        write_md_file(&vault, "beta", "link", &["web"]);
        write_md_file(&vault, "gamma", "article", &[]);

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(
            result,
            ScanResult {
                indexed: 3,
                errors: 0
            }
        );

        let blocks = index::list_blocks(&conn).unwrap();
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn full_scan_counts_errors() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "good", "image", &[]);
        // Write an invalid .md file (no frontmatter)
        std::fs::write(vault.block_path("bad"), "not a valid block").unwrap();

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(result.indexed, 1);
        assert_eq!(result.errors, 1);
    }

    // ── index_md_file ────────────────────────────────────────────────────

    #[test]
    fn index_single_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "note", "article", &["design"]);
        let path = vault.block_path("note");
        index_md_file(&conn, &vault, &path, None).unwrap();

        let block = index::get_block(&conn, "note").unwrap().unwrap();
        assert_eq!(block.block_type, BlockType::Article);
        assert_eq!(block.tags, vec!["design"]);
    }

    #[test]
    fn index_invalid_file_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        std::fs::write(vault.block_path("bad"), "garbage").unwrap();
        let path = vault.block_path("bad");
        assert!(index_md_file(&conn, &vault, &path, None).is_err());
    }

    // ── handle_event ─────────────────────────────────────────────────────

    #[test]
    fn handle_block_changed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "note", "link", &[]);
        let path = vault.block_path("note");
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path), None).unwrap();

        assert!(index::get_block(&conn, "note").unwrap().is_some());
    }

    #[test]
    fn handle_block_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        // First index a block
        write_md_file(&vault, "note", "link", &[]);
        let path = vault.block_path("note");
        index_md_file(&conn, &vault, &path, None).unwrap();

        // BlockDeleted now defers removal into the rename-match queue
        // (Phase 18.G). The row stays in the index for up to 500ms so a
        // matching BlockChanged can rename identity. Flush the queue
        // explicitly to observe the committed removal.
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        assert!(
            index::get_block(&conn, "note").unwrap().is_some(),
            "deferral preserves row until window expires or flush runs"
        );

        flush_pending_for_test(&conn, &vault, None);
        assert!(index::get_block(&conn, "note").unwrap().is_none());
    }

    #[test]
    fn handle_block_rename_preserves_identity() {
        // Remove + Create with identical body inside the match window
        // should update the slug in place, not delete + insert.
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        // Static pending queue is shared across parallel tests; clear it
        // before and after so no other test's remnants leak in.
        flush_pending_for_test(&conn, &vault, None);

        let unique_body = format!("rename-identity-body-{:?}", std::thread::current().id());
        write_md_file_with_body(&vault, "old-name", "article", &[], &unique_body);
        let old_path = vault.block_path("old-name");
        index_md_file(&conn, &vault, &old_path, None).unwrap();
        let original = index::get_block(&conn, "old-name").unwrap().unwrap();
        let original_id = original.id;

        // Simulate rename: delete old file, write new with same body
        std::fs::remove_file(&old_path).unwrap();
        handle_event(
            &conn,
            &vault,
            &VaultEvent::BlockDeleted(old_path.clone()),
            None,
        )
        .unwrap();

        write_md_file_with_body(&vault, "new-name", "article", &[], &unique_body);
        let new_path = vault.block_path("new-name");
        handle_event(
            &conn,
            &vault,
            &VaultEvent::BlockChanged(new_path.clone()),
            None,
        )
        .unwrap();

        // Old slug gone, new slug present with same id (identity preserved).
        assert!(index::get_block(&conn, "old-name").unwrap().is_none());
        let renamed = index::get_block(&conn, "new-name").unwrap().unwrap();
        assert_eq!(renamed.id, original_id);

        flush_pending_for_test(&conn, &vault, None);
    }

    #[test]
    fn handle_block_delete_without_matching_create_commits_removal() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file_with_body(&vault, "solo", "link", &[], "body");
        let path = vault.block_path("solo");
        index_md_file(&conn, &vault, &path, None).unwrap();

        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        // No matching create: forcing a flush commits the deferred removal.
        flush_pending_for_test(&conn, &vault, None);
        assert!(index::get_block(&conn, "solo").unwrap().is_none());
    }

    #[test]
    fn handle_block_create_without_pending_remove_is_regular_index() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file_with_body(&vault, "fresh", "link", &[], "body");
        let path = vault.block_path("fresh");
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path), None).unwrap();
        assert!(index::get_block(&conn, "fresh").unwrap().is_some());
    }

    #[test]
    fn icloud_conflict_file_not_indexed_as_block() {
        // A Finder/iCloud-style conflict file must not become a second
        // block — it lands in vault_conflicts and waits for user
        // resolution.
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        // Original block
        write_md_file_with_body(&vault, "Hello World", "link", &[], "body A");
        let original_path = vault.block_path("Hello World");
        index_md_file(&conn, &vault, &original_path, None).unwrap();
        assert!(index::get_block(&conn, "Hello World").unwrap().is_some());

        // Simulate iCloud creating a conflict copy alongside
        write_md_file_with_body(
            &vault,
            "Hello World (conflicted copy)",
            "link",
            &[],
            "body B",
        );
        let conflict_path = vault.block_path("Hello World (conflicted copy)");

        handle_event(&conn, &vault, &VaultEvent::BlockChanged(conflict_path), None)
            .unwrap();

        // Conflict file must NOT be indexed as a separate block
        assert!(
            index::get_block(&conn, "Hello World (conflicted copy)")
                .unwrap()
                .is_none()
        );
        // Original remains untouched
        assert!(index::get_block(&conn, "Hello World").unwrap().is_some());

        // And the conflict is recorded for the UI to surface
        let conflicts = index::list_vault_conflicts(&conn).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].base_slug, "Hello World");
        assert_eq!(conflicts[0].conflict_slug, "Hello World (conflicted copy)");
    }

    #[test]
    fn full_scan_diverts_icloud_conflict_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file_with_body(&vault, "Doc", "link", &[], "body");
        write_md_file_with_body(&vault, "Doc (conflicted copy)", "link", &[], "body");

        full_scan(&conn, &vault, None, None).unwrap();

        assert!(index::get_block(&conn, "Doc").unwrap().is_some());
        assert!(
            index::get_block(&conn, "Doc (conflicted copy)")
                .unwrap()
                .is_none()
        );
        assert_eq!(index::list_vault_conflicts(&conn).unwrap().len(), 1);
    }

    #[test]
    fn handle_media_deleted_removes_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        // Create a fake thumbnail
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let thumb = vault.thumb_path("photo");
        std::fs::write(&thumb, b"fake thumb").unwrap();
        assert!(thumb.exists());

        // Media deleted event should remove thumbnail
        let media_path = vault.media_path("photo", "jpg");
        handle_event(&conn, &vault, &VaultEvent::MediaDeleted(media_path), None).unwrap();
        assert!(!thumb.exists());
    }

    // ── helpers ──────────────────────────────────────────────────────────

    #[test]
    fn path_to_slug_extracts_stem() {
        assert_eq!(
            path_to_slug(Path::new("/vault/sunset-tokyo.md")),
            Some("sunset-tokyo".to_string())
        );
        assert_eq!(
            path_to_slug(Path::new("/vault/photo.jpg")),
            Some("photo".to_string())
        );
    }

    #[test]
    fn is_image_ext_recognized() {
        // NOTE: thumbnails::is_image_ext expects already-lowercased ext.
        assert!(thumbnails::is_image_ext("jpg"));
        assert!(thumbnails::is_image_ext("png"));
        assert!(thumbnails::is_image_ext("webp"));
        assert!(!thumbnails::is_image_ext("mp4"));
        assert!(!thumbnails::is_image_ext("md"));
    }
}
