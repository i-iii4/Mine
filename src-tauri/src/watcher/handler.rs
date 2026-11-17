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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;
use tauri::{AppHandle, Manager};

use crate::commands::state::{schedule_preview_reconcile, AppState};
#[cfg(test)]
use crate::domain::block::parse_block;
use crate::domain::block::{
    derive_card_kind, parse_markdown_document, Block, BlockType, CardKind, DateTime,
};
use crate::domain::vault::VaultLayout;
use crate::storage::preview_plan::{
    self, resolve_upgrade_media, resolve_upgrade_media_with, PreviewUpgradeInput,
};
use crate::storage::reconcile::{self, SeenPath};
use crate::storage::{article_audio, db, files, index, media_refs, thumbnails};
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
    path: String,
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
    #[serde(rename = "tilePosters")]
    tile_posters: Vec<TilePosterUpgradePayload>,
    /// The state of the media when asked (`commands::thumbnails::media_revision`, Е2.20).
    revision: String,
}

#[derive(Debug, Clone, Serialize)]
struct TilePosterUpgradePayload {
    #[serde(rename = "posterName")]
    poster_name: String,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
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
#[cfg(test)]
pub fn full_scan(
    conn: &Connection,
    vault: &VaultLayout,
    on_thumbs_done: Option<Box<dyn FnOnce() + Send>>,
    app: Option<AppHandle>,
) -> Result<ScanResult> {
    let _write = crate::storage::source_mutation::begin_write()?;
    reconcile_scan(conn, vault, on_thumbs_done, app, "full")
}

/// Scan only files whose source mtime is newer than the last indexed_at
/// marker stored in SQLite. New files (including channel docs) are always
/// parsed. Deleted files are removed from the index after the pass.
#[cfg(test)]
pub fn incremental_scan(
    conn: &Connection,
    vault: &VaultLayout,
    on_thumbs_done: Option<Box<dyn FnOnce() + Send>>,
    app: Option<AppHandle>,
) -> Result<ScanResult> {
    reconcile_scan(conn, vault, on_thumbs_done, app, "incremental")
}

#[cfg(test)]
fn reconcile_scan(
    conn: &Connection,
    vault: &VaultLayout,
    on_thumbs_done: Option<Box<dyn FnOnce() + Send>>,
    app: Option<AppHandle>,
    label: &'static str,
) -> Result<ScanResult> {
    let report = reconcile::reconcile_vault(conn, vault)
        .map_err(|error| anyhow::anyhow!("{label} reconciliation failed: {error:#}"))?;
    let mut thumb_jobs = Vec::with_capacity(report.upserted.len());
    for slug in &report.upserted {
        match index::get_block(conn, slug)? {
            Some(indexed) => match indexed.to_domain_block() {
                Ok(block) => thumb_jobs.push(ThumbJob {
                    block,
                    source_path: vault.block_path(slug),
                }),
                Err(error) => {
                    log::warn!("{label}: failed to project reconciled block {slug}: {error}")
                }
            },
            None => {
                if article_audio::delete_all_artifacts(vault, slug).unwrap_or(false) {
                    if let Some(ref app) = app {
                        emit_article_audio_updated(app, vault, slug);
                    }
                }
            }
        }
    }
    spawn_thumb_jobs_worker(thumb_jobs, vault.clone(), app, on_thumbs_done, label);
    Ok(ScanResult {
        indexed: report.upserted.len(),
        errors: report.errors.len(),
    })
}

/// Scan every indexed block in the vault and regenerate any thumbnail
/// whose on-disk dependencies (media file, inline media, preview tiles)
/// have drifted ahead of the cached thumb — regardless of whether the
/// `.md` file itself was touched.
///
/// This closes the gap where `incremental_scan` correctly short-circuits
/// on unchanged `.md` mtime, but external edits to the source image
/// (e.g. in Preview, Photoshop, an iCloud sync from another device) leave
/// the sidebar thumb stale. Split out as a standalone pass so the caller
/// can invoke it on startup, on window focus, and on `refresh_vault`
/// without paying for a full DB-side reindex.
///
/// Reads block state from the SQLite index instead of reparsing every
/// `.md` file — the DB is already consistent after `incremental_scan`
/// and projecting `IndexedBlock` into a `Block` is O(N) copies with no
/// YAML parsing. On a 5000-block vault this drops the sweep cost from
/// ~0.5–2.5 s (read + YAML) to ~50 ms of `stat` calls in `is_thumb_fresh`,
/// which matters most when the sweep runs on window focus.
///
/// Work is delegated to the shared background worker used by `full_scan`
/// and `incremental_scan`; `is_thumb_fresh` skips already-coherent blocks,
/// so only the drifted subset actually reaches `generate_for_block`.
pub fn thumb_sweep(
    conn: &Connection,
    vault: &VaultLayout,
    app: Option<AppHandle>,
    on_done: Option<Box<dyn FnOnce() + Send>>,
) -> Result<usize> {
    // A renamed or unmounted folder makes every card look deleted: never
    // sweep a space that is not provably there (SPEC_VAULT_LIFECYCLE.md, П29).
    crate::storage::root_guard::ensure_root_present(vault)?;
    let indexed = index::list_blocks(conn).context("thumb_sweep: failed to list blocks")?;

    let mut jobs: Vec<ThumbJob> = Vec::with_capacity(indexed.len());
    let mut orphans_removed = 0usize;
    for row in indexed {
        // A row with a slug that cannot form a valid block path (empty, path
        // traversal, separator) is unreachable from the UI and a stale
        // artifact — legacy import, partial migration, or a deleted `.md`
        // whose slug never validated. Remove it so it stops resurfacing every
        // sweep instead of just being skipped.
        if crate::domain::vault::validate_slug(&row.slug).is_err() {
            log::info!("thumb_sweep: removing invalid-slug block {:?}", row.slug);
            let _ = index::remove_block(conn, &row.slug);
            orphans_removed += 1;
            continue;
        }
        let source_path = vault.block_path(&row.slug);
        if !source_path.exists() {
            // The folder may be renamed mid-sweep: then nothing is an orphan.
            if !crate::storage::root_guard::root_still_there(vault) {
                return Err(crate::storage::root_guard::RootUnavailable {
                    root: vault.root().to_path_buf(),
                    state: crate::storage::root_guard::RootState::Missing,
                }
                .into());
            }
            // Orphan: the `.md` is gone (e.g. an iCloud delete event the notify
            // watcher never received). full_scan reconciles these on vault
            // open; do it here too so the sweep stops regenerating a thumb for
            // a block that no longer exists on disk.
            log::info!(
                "thumb_sweep: removing orphan block {:?} (no .md on disk)",
                row.slug
            );
            let _ = index::remove_block(conn, &row.slug);
            let _ = std::fs::remove_file(vault.thumb_path(&row.slug));
            orphans_removed += 1;
            continue;
        }
        match row.to_domain_block() {
            Ok(block) => jobs.push(ThumbJob { block, source_path }),
            Err(e) => log::warn!(
                "thumb_sweep: failed to project block {} from DB: {e}",
                row.slug
            ),
        }
    }
    if orphans_removed > 0 {
        log::info!("thumb_sweep: removed {orphans_removed} orphan/invalid block(s)");
    }

    let count = jobs.len();
    spawn_thumb_jobs_worker(jobs, vault.clone(), app, on_done, "sweep");
    Ok(count)
}

/// Spawn the shared background thumb-processing worker.
///
/// Used by `full_scan`, `incremental_scan`, and `thumb_sweep`. Behaviour
/// (freshness check, regeneration, event emission, callback on success)
/// is identical across callers — only the log label differs so we can
/// tell the three passes apart in stdout.
///
/// Empty `thumb_jobs` → returns immediately without firing `on_done`,
/// matching the original callers' `if !thumb_jobs.is_empty()` guard.
fn spawn_thumb_jobs_worker(
    thumb_jobs: Vec<ThumbJob>,
    vault: VaultLayout,
    app: Option<AppHandle>,
    on_done: Option<Box<dyn FnOnce() + Send>>,
    label: &'static str,
) {
    if thumb_jobs.is_empty() {
        return;
    }
    match std::thread::Builder::new()
        .name(format!("thumb-gen-{label}"))
        .spawn(move || {
            let Ok(_write)=crate::storage::source_mutation::begin_write() else {return;};
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let metadata_conn = db::open_or_create(&vault.index_db_path())
                    .map_err(|e| {
                        log::error!("thumb-gen({label}): open metadata db failed: {e:#}");
                        e
                    })
                    .ok();
                let total = thumb_jobs.len();
                let mut generated = 0;
                let mut skipped = 0;
                let mut metadata_updates = 0;
                let mut levels_made = 0;
                let mut cancelled = false;
                let is_active_vault = || {
                    app.as_ref().map_or(true, |handle| {
                        handle
                            .state::<AppState>()
                            .is_open_root(vault.root())
                    })
                };
                // One snapshot of the vault's file list for every job: a
                // sweep checks every card, and resolving per card walked the
                // whole vault for each. A media file that appears during the
                // run is a watcher event that rebuilds its owners' previews.
                let mut resolver = media_refs::MediaResolver::new(&vault);
                let epoch = thumbnails::GeneratorEpoch::read(&vault);
                for job in &thumb_jobs {
                    if !is_active_vault() {
                        cancelled = true;
                        break;
                    }
                    let thumb_path = vault.thumb_path(&job.block.slug);

                    let fresh = thumbnails::is_thumb_fresh_with_resolver(
                        &thumb_path,
                        &job.source_path,
                        &job.block,
                        &mut resolver,
                    );
                    // Fresh against its sources, but written by an earlier
                    // generator: rebuilt below, and kept until a finished
                    // successor replaces it (SPEC_THUMBNAILS.md, П8).
                    let outdated = fresh && !epoch.wrote(&thumb_path);
                    if fresh && !outdated {
                        skipped += 1;
                        // A fresh thumbnail with a level missing: the level is
                        // made from it, and the surfaces that read levels hear
                        // of it (SPEC_THUMBNAILS.md, «Уровни миниатюр»).
                        if thumbnails::ensure_thumb_levels(&vault, &job.block.slug) {
                            levels_made += 1;
                            if is_active_vault() {
                                if let Some(ref app) = app {
                                    emit_levels_made(app, &vault, &job.block.slug, &thumb_path);
                                }
                            }
                        }
                        if let Some(ref conn) = metadata_conn {
                            match index::sync_thumb_metadata(
                                conn,
                                &job.block.slug,
                                &thumb_path,
                                Some(vault.root()),
                            ) {
                                Ok(true) => metadata_updates += 1,
                                Ok(false) => {}
                                Err(e) => log::warn!(
                                    "thumb-gen({label}): sync fresh metadata failed for {}: {e:#}",
                                    job.block.slug
                                ),
                            }
                        }
                        // Only the text placeholder waits for the browser;
                        // a PNG may be a finished transparent picture (П7).
                        if is_active_vault()
                            && thumbnails::preview_origin(&thumb_path)
                                == Some(thumbnails::PreviewOrigin::TextPlaceholder)
                        {
                            if let Some(ref app) = app {
                                let upgrade = metadata_conn.as_ref().and_then(|conn| {
                                    index::get_pending_thumb_upgrade_block(
                                        conn,
                                        &job.block.slug,
                                    )
                                    .ok()
                                    .flatten()
                                });
                                emit_thumb_events(
                                    app,
                                    &vault,
                                    &job.block,
                                    upgrade.as_ref(),
                                    thumbnails::ThumbSource::Text,
                                );
                            }
                        }
                        continue;
                    }
                    // A sweep runs on every return of the window and never
                    // brings media down from iCloud: what the card shows stays,
                    // and the preview pass, which may wait for iCloud, makes
                    // what is missing (SPEC_CLOUD_STORAGE.md, «Отказ чтения»).
                    if preview_plan::first_preview_source_in_cloud(&job.block, &mut resolver)
                        .is_some()
                    {
                        skipped += 1;
                        continue;
                    }

                    let source = if outdated {
                        let upgrade = metadata_conn
                            .as_ref()
                            .and_then(|conn| {
                                index::get_pending_thumb_upgrade_block(conn, &job.block.slug)
                                    .ok()
                                    .flatten()
                            })
                            .and_then(|pending| {
                                resolve_upgrade_media_with(&mut resolver, pending.upgrade_input())
                            });
                        let source = thumbnails::rebuild_outdated_with_resolver(
                            &job.block,
                            &mut resolver,
                            upgrade.as_ref(),
                        );
                        if source == thumbnails::ThumbSource::None {
                            // Left for the browser queue, or the decode failed:
                            // the outdated thumb stays on screen.
                            skipped += 1;
                            continue;
                        }
                        source
                    } else {
                        log::info!(
                            "thumb-gen({label}): regenerating {} (type={:?})",
                            job.block.slug,
                            job.block.frontmatter.block_type
                        );
                        thumbnails::generate_for_block_with_resolver(&job.block, &mut resolver)
                    };
                    if let Some(ref conn) = metadata_conn {
                        match index::sync_thumb_metadata(
                            conn,
                            &job.block.slug,
                            &thumb_path,
                            Some(vault.root()),
                        ) {
                            Ok(true) => metadata_updates += 1,
                            Ok(false) => {}
                            Err(e) => log::warn!(
                                "thumb-gen({label}): sync generated metadata failed for {}: {e:#}",
                                job.block.slug
                            ),
                        }
                    }
                    if source != thumbnails::ThumbSource::None {
                        generated += 1;
                        if is_active_vault() {
                            if let Some(ref app) = app {
                                let upgrade = metadata_conn.as_ref().and_then(|conn| {
                                    index::get_pending_thumb_upgrade_block(
                                        conn,
                                        &job.block.slug,
                                    )
                                    .ok()
                                    .flatten()
                                });
                                emit_thumb_events(
                                    app,
                                    &vault,
                                    &job.block,
                                    upgrade.as_ref(),
                                    source,
                                );
                            }
                        }
                    }
                }
                log::info!(
                    "thumb-gen({label}): {} generated, {} skipped (fresh), {} levels made, {} metadata updates, {} total, cancelled={}",
                    generated, skipped, levels_made, metadata_updates, total, cancelled
                );
                (generated + levels_made + metadata_updates, cancelled)
            }));
            match result {
                Ok((changed, cancelled)) => {
                    if changed > 0 && !cancelled {
                        if let Some(cb) = on_done {
                            cb();
                        }
                    }
                }
                Err(_) => log::error!("thumb-gen({label}) thread panicked"),
            }
        }) {
        Ok(_handle) => {}
        Err(e) => log::error!("failed to spawn thumb-gen-{label} thread: {e}"),
    }
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
    // A file of any name is a note: an iCloud conflict is found by the
    // system's versions of the file, never by its name
    // (SPEC_ICLOUD_CONFLICTS.md, ВК1).
    let path = canonicalize_channel_file(vault, path)?;

    let outcome = index_md_file_inner(conn, vault, &path)?;

    if outcome.audio_invalidated {
        if let Some(app) = app {
            emit_article_audio_updated(app, vault, &outcome.slug);
        }
    }

    if let Some(app) = app {
        if let Err(error) =
            schedule_preview_reconcile(app, vault.clone(), [outcome.slug.clone()], false)
        {
            log::warn!(
                "failed to schedule derived preview for {}: {}",
                outcome.slug,
                error
            );
        }
    }

    if let Some(job) = outcome.thumb_job {
        // Emit block:added synchronously — frontend wants this latency to
        // be as low as possible so newly-clipped blocks appear in the
        // sidebar before the background thumb thread even wakes up. The
        // text-ness classification mirrors list_channel_previews so
        // incremental updates and the initial bulk load agree.
        if let Some(app) = app {
            let is_text = derive_card_kind(&job.block) == CardKind::Article
                && job.block.frontmatter.file.is_none()
                && job.block.frontmatter.thumbnail.is_none()
                && thumbnails::find_first_local_media(&job.block.body, thumbnails::is_image_ext)
                    .is_none();
            let _ = crate::commands::space_events::emit_to_vault(
                app,
                vault,
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
            // A level missing beside it is made now (SPEC_THUMBNAILS.md,
            // «Уровни миниатюр»).
            if thumbnails::ensure_thumb_levels(vault, &job.block.slug) {
                if let Some(app) = app {
                    emit_levels_made(app, vault, &job.block.slug, &thumb_path);
                }
            }
            let _ =
                index::sync_thumb_metadata(conn, &job.block.slug, &thumb_path, Some(vault.root()));
            // Only the text placeholder waits for the browser; a PNG may be a
            // finished transparent picture (SPEC_THUMBNAILS.md, П7).
            if thumbnails::preview_origin(&thumb_path)
                == Some(thumbnails::PreviewOrigin::TextPlaceholder)
            {
                if let Some(app) = app {
                    let upgrade = index::get_pending_thumb_upgrade_block(conn, &job.block.slug)
                        .ok()
                        .flatten();
                    emit_thumb_events(
                        app,
                        vault,
                        &job.block,
                        upgrade.as_ref(),
                        thumbnails::ThumbSource::Text,
                    );
                }
            }
            return Ok(true);
        }

        // The preview is made off the watcher, in the space's preview queue
        // (SPEC_DEEP_AUDIT.md, Е5.13). After the cascade runs, the result
        // fires its events (thumb:updated always, upgrade-requested if the
        // thumb is a text placeholder and the block has upgradable media).
        let stamp = preview_queue::stamp_of(&job.source_path);
        preview_queue::enqueue(
            app,
            vault,
            job.block.slug.clone(),
            preview_queue::Job::Card {
                block: Box::new(job.block),
                source_path: job.source_path,
                stamp,
            },
        );
    }

    Ok(true)
}

/// The watcher's previews of a space, one at a time (SPEC_DEEP_AUDIT.md,
/// Е5.13). Until 13.10.2026 every event made its preview on a thread of its
/// own, with no queue and no look at whether the card was still what the
/// event read: a slow preview of an earlier version finished last and put
/// the old picture back. Now each space has one worker that takes the jobs
/// in order; a newer job for a card replaces its waiting one, and a job whose
/// card or picture changed since it was queued is dropped, since the change
/// queued a job of its own.
mod preview_queue {
    use std::collections::{HashMap, VecDeque};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, PoisonError};
    use std::time::SystemTime;

    use tauri::AppHandle;

    use super::{emit_thumb_events, media_thumb_targets, ThumbUpdatedPayload};
    use crate::domain::block::Block;
    use crate::domain::vault::VaultLayout;
    use crate::storage::{db, index, thumbnails};

    /// What a file was when a job was queued: its size and its time.
    pub(super) type Stamp = Option<(u64, SystemTime)>;

    pub(super) fn stamp_of(path: &Path) -> Stamp {
        let metadata = std::fs::metadata(path).ok()?;
        Some((metadata.len(), metadata.modified().ok()?))
    }

    pub(super) enum Job {
        /// The preview of a card from the card as the event read it.
        Card {
            block: Box<Block>,
            source_path: PathBuf,
            stamp: Stamp,
        },
        /// The preview of a card made from the picture that is its media
        /// file, which just landed.
        Picture { picture: PathBuf, stamp: Stamp },
    }

    struct Queue {
        vault: VaultLayout,
        app: Option<AppHandle>,
        order: VecDeque<String>,
        jobs: HashMap<String, Job>,
    }

    static QUEUES: Mutex<Option<HashMap<PathBuf, Queue>>> = Mutex::new(None);

    /// Queue `job` for the card `slug` of `vault`, replacing the one it
    /// waits with, and start the space's worker when none runs.
    pub(super) fn enqueue(app: Option<&AppHandle>, vault: &VaultLayout, slug: String, job: Job) {
        let root = vault.root().to_path_buf();
        let start = {
            let mut queues = QUEUES.lock().unwrap_or_else(PoisonError::into_inner);
            let queues = queues.get_or_insert_with(HashMap::new);
            let start = !queues.contains_key(&root);
            let queue = queues.entry(root.clone()).or_insert_with(|| Queue {
                vault: vault.clone(),
                app: app.cloned(),
                order: VecDeque::new(),
                jobs: HashMap::new(),
            });
            if queue.jobs.insert(slug.clone(), job).is_none() {
                queue.order.push_back(slug);
            }
            start
        };
        if !start {
            return;
        }
        let worker_root = root.clone();
        let spawned = std::thread::Builder::new()
            .name("watcher-previews".to_string())
            .spawn(move || run(&worker_root));
        if let Err(error) = spawned {
            log::error!("cannot start the preview worker of {}: {error}", root.display());
            QUEUES
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_or_insert_with(HashMap::new)
                .remove(&root);
        }
    }

    /// Take the jobs of the space at `root` until none is left.
    fn run(root: &Path) {
        loop {
            let next = {
                let mut queues = QUEUES.lock().unwrap_or_else(PoisonError::into_inner);
                let queues = queues.get_or_insert_with(HashMap::new);
                let Some(queue) = queues.get_mut(root) else {
                    return;
                };
                match queue.order.pop_front() {
                    Some(slug) => queue
                        .jobs
                        .remove(&slug)
                        .map(|job| (slug, job, queue.vault.clone(), queue.app.clone())),
                    None => {
                        queues.remove(root);
                        return;
                    }
                }
            };
            if let Some((slug, job, vault, app)) = next {
                make(&vault, app.as_ref(), &slug, job);
            }
        }
    }

    fn make(vault: &VaultLayout, app: Option<&AppHandle>, slug: &str, job: Job) {
        #[cfg(test)]
        super::preview_hooks::run(super::preview_hooks::Moment::Before, vault.root(), slug);
        match job {
            Job::Card {
                block,
                source_path,
                stamp,
            } => {
                if stamp_of(&source_path) == stamp {
                    make_card_preview(vault, app, &block);
                }
            }
            Job::Picture { picture, stamp } => {
                if stamp_of(&picture) == stamp {
                    make_picture_preview(vault, app, slug, &picture);
                }
            }
        }
        #[cfg(test)]
        super::preview_hooks::run(super::preview_hooks::Moment::After, vault.root(), slug);
    }

    fn make_card_preview(vault: &VaultLayout, app: Option<&AppHandle>, block: &Block) {
        // The watcher's queue never waits for iCloud: a card whose media is
        // there keeps what it shows, and the preview pass queued with this
        // job brings the media down (SPEC_CLOUD_STORAGE.md, «Отказ чтения»).
        if crate::storage::preview_plan::first_preview_source_in_cloud(
            block,
            &mut crate::storage::media_refs::MediaResolver::new(vault),
        )
        .is_some()
        {
            return;
        }
        let Ok(_write) = crate::storage::source_mutation::begin_write() else {
            return;
        };
        let thumb_path = vault.thumb_path(&block.slug);
        let source = thumbnails::generate_for_block(block, vault);
        let upgrade = match db::open_or_create(&vault.index_db_path()) {
            Ok(conn) => {
                if let Err(error) =
                    index::sync_thumb_metadata(&conn, &block.slug, &thumb_path, Some(vault.root()))
                {
                    log::warn!("preview: sync metadata failed for {}: {error:#}", block.slug);
                }
                index::get_pending_thumb_upgrade_block(&conn, &block.slug)
                    .ok()
                    .flatten()
            }
            Err(error) => {
                log::warn!("preview: open metadata db failed for {}: {error:#}", block.slug);
                None
            }
        };
        if let Some(app) = app {
            emit_thumb_events(app, vault, block, upgrade.as_ref(), source);
        }
    }

    /// The card's preview from the picture, while the card still names the
    /// picture as its media file.
    fn make_picture_preview(vault: &VaultLayout, app: Option<&AppHandle>, slug: &str, picture: &Path) {
        let owns = db::open_or_create(&vault.index_db_path())
            .map(|conn| media_thumb_targets(&conn, vault, picture).iter().any(|owner| owner == slug))
            .unwrap_or(false);
        if !owns || crate::storage::cloud_files::is_content_offloaded(picture) {
            return;
        }
        if let Err(error) =
            thumbnails::generate_thumbnail(picture, &vault.thumb_path(slug), thumbnails::DEFAULT_MAX_SIZE)
        {
            log::warn!("thumbnail failed for {slug}: {error}");
            return;
        }
        // The levels describe the new picture too (SPEC_THUMBNAILS.md,
        // «Уровни миниатюр»).
        thumbnails::generate_thumb_levels(vault, slug);
        if let Some(app) = app {
            let event_path = vault.root().to_string_lossy().into_owned();
            crate::commands::space_events::emit_to_space_path(
                app,
                &event_path.clone(),
                "thumb:updated",
                ThumbUpdatedPayload {
                    path: event_path,
                    slug: slug.to_string(),
                    is_text: false,
                },
            );
        }
    }
}

/// Tell the space that the levels of the thumbnail of `slug` were made: the
/// sidebar and the graph read them, and ask for them again.
fn emit_levels_made(app: &AppHandle, vault: &VaultLayout, slug: &str, thumb_path: &Path) {
    let path = vault.root().to_string_lossy().into_owned();
    crate::commands::space_events::emit_to_space_path(
        app,
        &path.clone(),
        "thumb:updated",
        ThumbUpdatedPayload {
            path,
            slug: slug.to_string(),
            is_text: thumbnails::preview_origin(thumb_path)
                == Some(thumbnails::PreviewOrigin::TextPlaceholder),
        },
    );
}

/// Emit `thumb:updated` and (when applicable) `thumb:upgrade-requested`
/// after a Phase 1 cascade run. Lives as a free function so tests can
/// call `generate_for_block` directly without an AppHandle.
fn emit_thumb_events(
    app: &AppHandle,
    vault: &VaultLayout,
    block: &Block,
    upgrade_block: Option<&index::PendingThumbUpgradeBlock>,
    source: thumbnails::ThumbSource,
) {
    // `None` means the cascade decided not to write any thumb (non-article
    // block with no resolvable media). Nothing for the sidebar to refresh.
    if source == thumbnails::ThumbSource::None {
        return;
    }
    let _ = crate::commands::space_events::emit_to_vault(
        app,
        vault,
        "thumb:updated",
        ThumbUpdatedPayload {
            path: vault.root().to_string_lossy().into_owned(),
            slug: block.slug.clone(),
            is_text: source == thumbnails::ThumbSource::Text,
        },
    );

    // Block <slug>.jpg upgrade — only when Phase 1 wrote a text placeholder.
    // A real JPEG thumb from Rust decode is already the final result.
    let slug_upgrade = if source == thumbnails::ThumbSource::Text {
        upgrade_block.and_then(|indexed| {
            resolve_upgrade_media(
                vault,
                PreviewUpgradeInput {
                    slug: &indexed.slug,
                    media_file: indexed.media_file.as_deref(),
                    thumbnail: indexed.thumbnail.as_deref(),
                    media_urls: indexed.media_urls.as_deref(),
                    first_image: indexed.first_image.as_deref(),
                    preview_manifest: indexed.preview_manifest.as_deref(),
                },
            )
        })
    } else {
        None
    };

    // The browser reads the media through the asset protocol, and a file
    // whose contents are in iCloud is not one it can draw: the preview pass
    // brings it down, and the browser is asked once it is here
    // (SPEC_CLOUD_STORAGE.md, «Отказ чтения»).
    let slug_upgrade = slug_upgrade
        .filter(|media| !crate::storage::cloud_files::is_content_offloaded(&media.path));
    if slug_upgrade.is_none() {
        return;
    }

    let (media_path, kind, revision) = slug_upgrade
        .map(|media| {
            (
                media.path.to_string_lossy().into_owned(),
                media.kind.as_str().to_string(),
                crate::commands::thumbnails::media_revision(&media.path),
            )
        })
        .unwrap_or_default();
    crate::commands::space_events::emit_to_lead(
        app,
        vault.root(),
        "thumb:upgrade-requested",
        ThumbUpgradeRequestedPayload {
            slug: block.slug.clone(),
            media_path,
            kind,
            tile_posters: Vec::new(),
            revision,
        },
    );
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

fn canonicalize_channel_file(vault: &VaultLayout, path: &Path) -> Result<PathBuf> {
    let _ = vault;
    Ok(path.to_path_buf())
}

/// Core indexing logic: parse + upsert. Returns a ThumbJob if a thumbnail
/// should be (re-)generated.
fn index_md_file_inner(
    conn: &Connection,
    vault: &VaultLayout,
    path: &Path,
) -> Result<IndexMdOutcome> {
    let (slug, content) = files::read_block_file(vault, path)
        .with_context(|| format!("reading {}", path.display()))?;

    let parsed = parse_markdown_document(&slug, &content, file_saved_at(path))
        .with_context(|| format!("parsing {}", path.display()))?;
    let mut block = parsed.block;
    // The note's frontmatter and its index row resolve against one snapshot.
    let mut media_resolver = media_refs::MediaResolver::new(vault);
    files::normalize_block_media_refs_for_index(&mut media_resolver, &mut block);

    // Channel files → index as channel, no thumbnail
    if block.frontmatter.block_type == BlockType::Channel {
        index::upsert_channel_from_block_in_vault(conn, vault, &block)
            .with_context(|| format!("indexing channel {}", path.display()))?;
        let audio_invalidated = article_audio::delete_all_artifacts(vault, &block.slug)?;
        return Ok(IndexMdOutcome {
            slug: block.slug,
            thumb_job: None,
            audio_invalidated,
        });
    }

    // The row and the source stamp together, as a pass over the space
    // projects the note: with the stamp left behind, the preview pass queued
    // for the card saw no change and published the old tiles at their new
    // places, until the next pass over the space (SPEC_THUMBNAILS.md, «Свои
    // записи Mine»; решение пользователя 09.11.2026).
    let block = reconcile::project_source_path(conn, vault, path)
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

// Handle a single vault event by dispatching to the appropriate storage
// operation. With an app handle, the path emits block/thumbnail events for the
// frontend; tests pass `None` to exercise the pure storage behavior.
// ─── Rename-detection pending queue (Phase 18.G) ────────────────────────────
//
// Filesystem-level rename on macOS surfaces as a BlockDeleted followed by a
// BlockChanged. Without correlation, this class of events destroys block
// identity: thumb cache becomes an orphan, audio playback position is lost,
// wikilinks break. We defer BlockDeleted events briefly and correlate them
// with an incoming BlockChanged whose durable source locator confirms the
// move. On a match within the debounce window, we issue a rename_slug and
// migrate derived-store artifacts (thumb .jpg, audio .wav + sidecar) in
// place. Entries that time out without a match fall through to a real
// block removal as if they had been removed immediately.

/// Window during which a BlockDeleted event waits for a matching
/// BlockChanged before being committed as a real removal.
const RENAME_MATCH_WINDOW_MS: u64 = 500;

/// How many times a deferred removal the index refuses (a busy lock, a
/// failed write) is attempted before it is left to the next reconciliation
/// (`SPEC_AUDIT_FIXES.md`, В2.3).
const REMOVAL_ATTEMPTS: u32 = 5;

/// The wait before the first retry of a refused removal; each further retry
/// waits twice as long.
const REMOVAL_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
struct PendingRemove {
    vault_root: PathBuf,
    slug: String,
    /// Tags captured before removal so the eventual `block:removed` event
    /// tells the frontend which channels to invalidate.
    tags: Vec<String>,
    deadline: Instant,
    /// Attempts the index has already refused.
    failed_attempts: u32,
}

/// The deferred removals of every open watcher, and the signal their timers
/// wait on. Queuing a removal is itself the signal, and a timer re-reads the
/// earliest deadline under the lock after every wake-up: no timer can be
/// woken too early to see the removal it was woken for (Ф7;
/// `SPEC_AUDIT_FIXES.md`, Б2.3).
struct PendingRemovals {
    entries: Mutex<Vec<PendingRemove>>,
    changed: Condvar,
}

fn pending_removals() -> &'static PendingRemovals {
    static QUEUE: PendingRemovals = PendingRemovals {
        entries: Mutex::new(Vec::new()),
        changed: Condvar::new(),
    };
    &QUEUE
}

/// The queue for reading or changing it. A panic elsewhere while holding
/// the lock leaves a list of plain values, still valid to use.
fn pending_entries() -> MutexGuard<'static, Vec<PendingRemove>> {
    pending_removals()
        .entries
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn push_pending_remove(entry: PendingRemove) {
    let mut entries = pending_entries();
    entries.push(entry);
    pending_removals().changed.notify_all();
}

/// Remove a pending deletion only for a move proven by source metadata.
fn take_pending_by_slug(vault: &VaultLayout, slug: &str) -> Option<PendingRemove> {
    let mut q = pending_entries();
    let pos = q
        .iter()
        .position(|p| p.vault_root == vault.root() && p.slug == slug)?;
    Some(q.remove(pos))
}

/// Drain entries whose deadline has already passed. Caller commits each
/// as a real block removal.
fn drain_expired_pending(vault: &VaultLayout) -> Vec<PendingRemove> {
    drain_due(&mut pending_entries(), vault, Instant::now())
}

fn drain_due(
    entries: &mut Vec<PendingRemove>,
    vault: &VaultLayout,
    now: Instant,
) -> Vec<PendingRemove> {
    let mut expired = Vec::new();
    entries.retain(|p| {
        if p.vault_root == vault.root() && p.deadline <= now {
            expired.push(p.clone());
            false
        } else {
            true
        }
    });
    expired
}

fn earliest_deadline(entries: &[PendingRemove], vault: &VaultLayout) -> Option<Instant> {
    entries
        .iter()
        .filter(|pending| pending.vault_root == vault.root())
        .map(|pending| pending.deadline)
        .min()
}

/// When the earliest deferred removal of `vault` falls due.
#[cfg(test)]
fn next_pending_deadline(vault: &VaultLayout) -> Option<Instant> {
    earliest_deadline(&pending_entries(), vault)
}

/// Ends one watcher's removal timer. Stopping takes the queue lock, so a
/// timer between its check and its wait cannot miss it.
#[derive(Debug, Clone, Default)]
pub struct RemovalTimerStop(Arc<AtomicBool>);

impl RemovalTimerStop {
    pub fn stop(&self) {
        let _entries = pending_entries();
        self.0.store(true, Ordering::SeqCst);
        pending_removals().changed.notify_all();
    }

    fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Wait until a deferred removal of `vault` falls due and take every due
/// one off the queue; `None` once `stop` is set. The deadline is read again
/// after each wake-up, so a removal queued at any moment is waited for with
/// its own deadline.
fn wait_for_due_removals(
    vault: &VaultLayout,
    stop: &RemovalTimerStop,
) -> Option<Vec<PendingRemove>> {
    let queue = pending_removals();
    let mut entries = pending_entries();
    loop {
        if stop.is_stopped() {
            return None;
        }
        let now = Instant::now();
        entries = match earliest_deadline(&entries, vault) {
            Some(deadline) if deadline <= now => {
                return Some(drain_due(&mut entries, vault, now));
            }
            Some(deadline) => {
                queue
                    .changed
                    .wait_timeout(entries, deadline - now)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0
            }
            None => queue
                .changed
                .wait(entries)
                .unwrap_or_else(PoisonError::into_inner),
        };
    }
}

/// The watcher's removal timer (Ф7): commits every deferred removal of
/// `vault` when its rename window passes, without waiting for another file
/// event, until `stop`. `pass` hears the outcome of each pass: whether a
/// card left the index and whether the index fell behind the files, or why
/// the removals could not be committed at all.
pub fn run_removal_timer(
    conn: &Connection,
    vault: &VaultLayout,
    stop: &RemovalTimerStop,
    app: Option<&AppHandle>,
    mut pass: impl FnMut(Result<RemovalPass>),
) {
    while let Some(due) = wait_for_due_removals(vault, stop) {
        pass(commit_removals(conn, vault, &due, &mut |removed| {
            announce_removal(app, vault, removed);
        }));
    }
}

/// What one pass over due removals did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RemovalPass {
    /// A card left the index.
    pub removed: bool,
    /// The index refused a removal: it lists a card whose note is gone until
    /// a retry or the next reconciliation removes it (`SPEC_AUDIT_FIXES.md`,
    /// В2.3).
    pub stale: bool,
}

/// What became of one deferred removal.
#[derive(Debug)]
enum RemovalOutcome {
    /// The card left the index and was announced.
    Removed,
    /// Nothing to remove: the space is not there (П29) or the note is back.
    Kept,
    /// The index refused the removal; it is queued again.
    Retrying,
    /// The index refused every attempt; the next reconciliation removes it.
    GaveUp,
}

/// Commit removals already taken off the queue, announcing through
/// `announce` each card that left the index. When writes are closed (an
/// update preparing to quit) they are not committed here: the caller learns
/// it, and the next reconciliation removes cards whose notes are gone.
fn commit_removals(
    conn: &Connection,
    vault: &VaultLayout,
    due: &[PendingRemove],
    announce: &mut dyn FnMut(&PendingRemove),
) -> Result<RemovalPass> {
    let _write = crate::storage::source_mutation::begin_write()?;
    Ok(settle_removals(conn, vault, due.iter().cloned(), announce))
}

/// Settle each removal and sum up what the pass did.
fn settle_removals(
    conn: &Connection,
    vault: &VaultLayout,
    due: impl IntoIterator<Item = PendingRemove>,
    announce: &mut dyn FnMut(&PendingRemove),
) -> RemovalPass {
    let mut pass = RemovalPass::default();
    for pending in due {
        match settle_removal(conn, vault, pending, announce) {
            RemovalOutcome::Removed => pass.removed = true,
            RemovalOutcome::Kept => {}
            RemovalOutcome::Retrying | RemovalOutcome::GaveUp => pass.stale = true,
        }
    }
    pass
}

/// Commit one deferred removal. Only a card that actually left the index is
/// announced: announcing a refused removal made the card vanish from the
/// feed and come back on the next reload (`SPEC_AUDIT_FIXES.md`, В2.3). A
/// refused removal is queued again, with a growing wait, until it commits or
/// [`REMOVAL_ATTEMPTS`] run out.
fn settle_removal(
    conn: &Connection,
    vault: &VaultLayout,
    pending: PendingRemove,
    announce: &mut dyn FnMut(&PendingRemove),
) -> RemovalOutcome {
    match commit_deferred_removal(conn, vault, &pending) {
        Ok(true) => {
            announce(&pending);
            RemovalOutcome::Removed
        }
        Ok(false) => RemovalOutcome::Kept,
        Err(error) => {
            let failed_attempts = pending.failed_attempts + 1;
            if failed_attempts >= REMOVAL_ATTEMPTS {
                log::warn!(
                    "deferred removal of {} refused {failed_attempts} times, left to reconciliation: {error:#}",
                    pending.slug
                );
                return RemovalOutcome::GaveUp;
            }
            log::warn!("deferred removal of {} refused, retrying: {error:#}", pending.slug);
            push_pending_remove(PendingRemove {
                deadline: Instant::now() + removal_retry_delay(failed_attempts),
                failed_attempts,
                ..pending
            });
            RemovalOutcome::Retrying
        }
    }
}

/// The wait before the next attempt after `failed_attempts` refusals.
fn removal_retry_delay(failed_attempts: u32) -> Duration {
    REMOVAL_RETRY_DELAY * 2u32.pow(failed_attempts.saturating_sub(1))
}

/// Tell the frontend a card left the index.
fn announce_removal(app: Option<&AppHandle>, vault: &VaultLayout, pending: &PendingRemove) {
    let Some(app) = app else {
        return;
    };
    let _ = crate::commands::space_events::emit_to_vault(
        app,
        vault,
        "block:removed",
        BlockRemovedPayload {
            slug: pending.slug.clone(),
            tags: pending.tags.clone(),
        },
    );
    let _ = crate::commands::space_events::emit_to_vault(
        app,
        vault,
        "thumb:updated",
        ThumbUpdatedPayload {
            path: vault.root().to_string_lossy().into_owned(),
            slug: pending.slug.clone(),
            is_text: false,
        },
    );
}

/// Test-only: drain the entire pending queue and commit every entry as a
/// removal, regardless of deadline. Lets unit tests assert post-removal
/// state without sleeping for the rename-match window.
#[cfg(test)]
fn flush_pending_for_test(conn: &Connection, vault: &VaultLayout, app: Option<&AppHandle>) {
    let pending: Vec<PendingRemove> = {
        let mut entries = pending_entries();
        let mut matching = Vec::new();
        entries.retain(|p| {
            if p.vault_root == vault.root() {
                matching.push(p.clone());
                false
            } else {
                true
            }
        });
        matching
    };
    settle_removals(conn, vault, pending, &mut |removed| {
        announce_removal(app, vault, removed);
    });
}

/// Commit a deferred block removal as if it had been processed immediately.
/// Used when the rename-match window expires without an incoming Create.
/// Returns whether the card left the index; an error when the index refused
/// the removal and still lists the card.
fn commit_deferred_removal(
    conn: &Connection,
    vault: &VaultLayout,
    pending: &PendingRemove,
) -> Result<bool> {
    // A folder renamed or unmounted reports every file as deleted. The card
    // is only removed while the space itself is still there (П29).
    if let Err(unavailable) = crate::storage::root_guard::ensure_root_present(vault) {
        log::warn!("deferred removal of {} skipped: {unavailable}", pending.slug);
        return Ok(false);
    }
    // The note came back (restored from the Trash, an editor's save that
    // briefly removed it): the file on disk decides, not the old event (Ф7).
    if vault.block_path(&pending.slug).exists() {
        log::info!("deferred removal of {} dropped: the note is back", pending.slug);
        return Ok(false);
    }
    let is_card = index::get_block(conn, &pending.slug)
        .with_context(|| format!("deferred removal of {}: read its row", pending.slug))?
        .is_some();
    let tx = conn
        .unchecked_transaction()
        .with_context(|| format!("deferred removal of {}: begin", pending.slug))?;
    if is_card {
        index::remove_block(&tx, &pending.slug)
            .with_context(|| format!("deferred removal of {} from the index", pending.slug))?;
    } else {
        // A collection's document has no card row: what it projected is the
        // collection itself and its source state. Removing a card row that
        // was never there left a collection deleted outside Mine listed
        // until some later reconciliation (`SPEC_AUDIT_FIXES.md`, Ф7, Г2.4).
        reconcile::remove_source_projection(&tx, vault, &pending.slug)
            .with_context(|| format!("deferred removal of {} from the index", pending.slug))?;
    }
    tx.commit()
        .with_context(|| format!("deferred removal of {}: commit", pending.slug))?;
    let _ = article_audio::delete_all_artifacts(vault, &pending.slug);
    Ok(true)
}

#[derive(Debug, Clone, Serialize)]
struct BlockRenamedPayload {
    old_slug: String,
    new_slug: String,
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
        "watcher: rename detected {} -> {} (source identity match)",
        pending.slug,
        new_slug
    );

    match index::rename_slug(conn, &pending.slug, new_slug) {
        Ok(true) => {
            if let Err(e) = files::rename_derived_artifacts(vault, &pending.slug, new_slug) {
                log::warn!(
                    "rename derived artifacts {} -> {} failed: {e:#}",
                    pending.slug,
                    new_slug
                );
            }
            if let Some(app) = app {
                // The edit sessions of the note follow it (SPEC_EDITING.md,
                // Л4.8).
                let state = app.state::<AppState>();
                if let Some(space) = state.spaces.by_root(vault.root()) {
                    state.edit_sessions.rename(space.vault_id(), &pending.slug, new_slug);
                }
                let _ = crate::commands::space_events::emit_to_vault(
                    app,
                    vault,
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
            let pass = settle_removals(conn, vault, [pending.clone()], &mut |removed| {
                announce_removal(app, vault, removed);
            });
            mark_stale_index(app, vault, pass);
        }
    }

    // Re-index the new file so title/tags/preview changes (not just the
    // rename) are captured.
    index_md_file(conn, vault, new_path, app)
}

/// An index that refused a removal is behind the files: the next freshness
/// pass reconciles it even if every retry fails (`SPEC_AUDIT_FIXES.md`, В2.3).
fn mark_stale_index(app: Option<&AppHandle>, vault: &VaultLayout, pass: RemovalPass) {
    if let (true, Some(app)) = (pass.stale, app) {
        app.state::<AppState>()
            .freshness
            .mark_dirty(&vault.root().to_string_lossy());
    }
}

/// A watcher event with what the kept names of the space made of its path
/// when it came (`reconcile::follow_path`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenEvent {
    pub event: VaultEvent,
    pub path: SeenPath,
}

/// Take in an event of the watcher: the kept names of the space follow the
/// file it is about (SPEC_INTEGRATION.md, «Индекс имён файлов»). Every event
/// of a file a note can name passes here when it comes, the events the
/// watcher does not handle further included (Mine's own writes).
pub fn see_event(vault: &VaultLayout, event: VaultEvent) -> SeenEvent {
    let path = reconcile::follow_path(vault, event.path());
    SeenEvent { event, path }
}

/// What handling one batch of watcher events came to.
#[derive(Debug, Default)]
pub struct BatchOutcome {
    /// The index or a preview the feed reads moved: the feed reloads
    /// (`vault-changed`).
    pub changed: bool,
    /// The notes read again because a media file of the batch changed, by
    /// slug.
    pub reread: Vec<String>,
    /// What went wrong with single events; the rest of the batch was
    /// handled.
    pub errors: Vec<anyhow::Error>,
    /// Only a pass over the whole space settles what the batch saw, and the
    /// caller asks for one now: a folder appeared, moved or went; a media
    /// file went, which may be half of a rename the file identity pass
    /// repairs; a note to read again has its contents in iCloud.
    pub full_pass: bool,
}

/// Handle the events the watcher collected as one batch (SPEC_INTEGRATION.md,
/// «Пачки событий и точное перечитывание»).
///
/// Repeated events of one path count once, as its last one. The notes come
/// first, in the order their events came, with one file identity pass for
/// all of them; then every media file of the batch in one pass that reads
/// again only the notes that name them (`reconcile::reread_notes_naming`).
/// A note indexed in this batch is not read again for its media: it was read
/// with the file as it is. Until 16.11.2026 each media event ran a pass over
/// the whole space, and each note event a file identity pass of its own.
pub fn handle_batch(
    conn: &Connection,
    vault: &VaultLayout,
    events: &[SeenEvent],
    app: Option<&AppHandle>,
) -> BatchOutcome {
    let mut outcome = BatchOutcome::default();
    let _write = match crate::storage::source_mutation::begin_write() {
        Ok(write) => write,
        Err(error) => {
            outcome.errors.push(error);
            return outcome;
        }
    };
    // Before any dispatch, commit removals whose rename-match window
    // expired. Keeps the pending queue bounded and ensures deferred
    // deletes are eventually visible to the frontend.
    let pass = settle_removals(conn, vault, drain_expired_pending(vault), &mut |removed| {
        announce_removal(app, vault, removed);
    });
    mark_stale_index(app, vault, pass);

    // The last event of each path, in the order the last ones came.
    let mut paths = std::collections::HashSet::new();
    let mut last = events
        .iter()
        .rev()
        .filter(|seen| paths.insert(seen.event.path()))
        .collect::<Vec<_>>();
    last.reverse();

    let mut read_now = std::collections::BTreeSet::new();
    let notes_changed = last
        .iter()
        .any(|seen| matches!(seen.event, VaultEvent::BlockChanged(_)));
    let identity = if notes_changed {
        match crate::storage::file_identity::reconcile(vault) {
            Ok(identity) => Some(identity),
            Err(error) => {
                outcome.errors.push(error);
                None
            }
        }
    } else {
        None
    };
    for seen in &last {
        match &seen.event {
            // iCloud took the note's contents, which is an event too, or holds
            // a newer note whose contents have not arrived. Reading it here
            // would bring an evicted note straight back, or be refused
            // (`EDEADLK`). An evicted note unchanged by its metadata is no
            // news; a changed one is asked for, and the pass over the space
            // reads it once it is here (SPEC_CLOUD_STORAGE.md, «Отказ
            // чтения»). Until 17.11.2026 every eviction of a note was read
            // here and failed: about 30 notes a batch.
            VaultEvent::BlockChanged(path) if crate::storage::cloud_files::is_content_offloaded(path) => {
                if !reconcile::note_unchanged_since_indexed(conn, vault, path) {
                    crate::storage::icloud_downloads::request_downloads([path.as_path()]);
                    outcome.full_pass = true;
                }
            }
            VaultEvent::BlockChanged(path) => {
                // Without the file identity pass a move cannot be told from
                // a new note: the note waits for the next pass.
                let Some(identity) = &identity else {
                    continue;
                };
                match note_changed(conn, vault, path, identity, app) {
                    Ok(changed) => {
                        outcome.changed |= changed;
                        read_now.extend(path_to_slug(vault, path));
                    }
                    Err(error) => outcome.errors.push(error),
                }
            }
            VaultEvent::BlockDeleted(path) => note_deleted(conn, vault, path),
            VaultEvent::MediaChanged(_) | VaultEvent::MediaDeleted(_) => {}
        }
    }

    let mut media = Vec::new();
    for seen in &last {
        let (VaultEvent::MediaChanged(path) | VaultEvent::MediaDeleted(path)) = &seen.event else {
            continue;
        };
        // A media file whose contents iCloud took is the file it was: the
        // eviction keeps its name, size and time, and each card that shows it
        // keeps its pictures (SPEC_CLOUD_STORAGE.md, Х5). A file changed on
        // another Mac and not here yet is met by the pass over the space in
        // the source stamps of the notes that name it. Until 17.11.2026 the
        // eviction of a video or of a picture of an article discarded the
        // thumbnails of the cards showing it, and nothing could make them
        // again while the file stayed in iCloud.
        if matches!(seen.event, VaultEvent::MediaChanged(_))
            && crate::storage::cloud_files::is_content_offloaded(path)
        {
            continue;
        }
        match seen.path {
            // What happened under a folder only a walk tells.
            SeenPath::Folder => outcome.full_pass = true,
            SeenPath::File | SeenPath::GoneFile => {
                // A file that went may have been renamed: the file identity
                // pass of a full pass repairs the notes that named it.
                outcome.full_pass |= seen.path == SeenPath::GoneFile
                    || matches!(seen.event, VaultEvent::MediaDeleted(_));
                media.push(path.clone());
            }
        }
    }
    if !media.is_empty() {
        match reconcile::reread_notes_naming(conn, vault, &media, &read_now) {
            Ok(reread) => {
                for error in &reread.errors {
                    log::warn!(
                        "a note naming a changed file was not read again: {} ({})",
                        error.path,
                        error.message
                    );
                }
                outcome.full_pass |= reread.left_in_cloud;
                outcome.changed |= settle_media_previews(conn, vault, &media, &reread, app);
                outcome.reread = reread.reread;
            }
            Err(error) => {
                outcome.errors.push(error);
                // The index is behind the files until a pass over the space.
                outcome.full_pass = true;
            }
        }
    }
    outcome
}

/// Handle one event as a batch of its own, as the first event after quiet is
/// handled: the path of the tests of single events.
#[cfg(test)]
pub(crate) fn handle_event(
    conn: &Connection,
    vault: &VaultLayout,
    event: &VaultEvent,
    app: Option<&AppHandle>,
) -> Result<bool> {
    let mut outcome = handle_batch(conn, vault, &[see_event(vault, event.clone())], app);
    match outcome.errors.pop() {
        Some(error) => Err(error),
        None => Ok(outcome.changed),
    }
}

/// A note appeared or changed: index it, as a move when the file identity
/// pass of the batch confirmed one and its removal still waits.
fn note_changed(
    conn: &Connection,
    vault: &VaultLayout,
    path: &Path,
    identity: &crate::storage::file_identity::IdentityRefresh,
    app: Option<&AppHandle>,
) -> Result<bool> {
    if let Some(new_slug) = path_to_slug(vault, path) {
        let already_indexed = index::get_block(conn, &new_slug).ok().flatten().is_some();
        if !already_indexed {
            for (old_slug, moved_slug) in &identity.moved_markdown {
                if *moved_slug == new_slug {
                    if let Some(pending) = take_pending_by_slug(vault, old_slug) {
                        return perform_rename_match(conn, vault, &pending, &new_slug, path, app);
                    }
                }
            }
        }
        // The same note is back where it was: its earlier removal is
        // void (Ф7).
        take_pending_by_slug(vault, &new_slug);
    }
    index_md_file(conn, vault, path, app)
}

/// A note went: defer its removal into the rename-detection queue. Tags are
/// captured now so either a matching appearance within the window can
/// rename identity cleanly, or the expired drain can emit `block:removed`
/// with the right channel list. The row itself is not removed yet:
/// `rename_slug` on a match would fail if it were. If no match arrives, the
/// watcher's timer commits the removal when the window passes.
fn note_deleted(conn: &Connection, vault: &VaultLayout, path: &Path) {
    let Some(slug) = path_to_slug(vault, path) else {
        return;
    };
    let tags = index::get_block(conn, &slug)
        .ok()
        .flatten()
        .map(|b| b.tags)
        .unwrap_or_default();
    push_pending_remove(PendingRemove {
        vault_root: vault.root().to_path_buf(),
        slug,
        tags,
        deadline: Instant::now() + Duration::from_millis(RENAME_MATCH_WINDOW_MS),
        failed_attempts: 0,
    });
}

/// Bring the previews of the cards that show the media `files` of a batch
/// up to what the files are now, after the notes that name them were read
/// again. A picture is turned into its owners' thumbnails right here; any
/// other preview of a card that shows a file (a video's frame, an article
/// whose picture changed, a card whose file went) is discarded and made
/// again by the preview pass from what the file is now. A frame of a
/// replaced video is never kept (`SPEC_AUDIT_FIXES.md`, Ф7, Г2.3).
///
/// Returns whether the feed must reload: the index moved (a note was read
/// again: new dimensions, a new poster on the way), or a preview is gone.
fn settle_media_previews(
    conn: &Connection,
    vault: &VaultLayout,
    files: &[PathBuf],
    reread: &reconcile::RereadNotes,
    app: Option<&AppHandle>,
) -> bool {
    let rows = media_files_of(conn, reread.naming.keys());
    let mut resolver = match reconcile::kept_names_resolver(vault) {
        Ok(resolver) => resolver,
        Err(error) => {
            log::warn!("media owner lookup failed for {}: {error:#}", vault.root().display());
            return !reread.reread.is_empty();
        }
    };
    let mut discarded = false;
    let mut previews = reread
        .reread
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    for path in files {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        // The cards whose media file this is, and every card that names it.
        let targets = media_owners_among(vault, path, &rows, &mut resolver);
        let name = reconcile::file_name_key(path);
        let mut owners = targets.clone();
        for (slug, names) in &reread.naming {
            if name.as_ref().is_some_and(|name| names.contains(name)) && !owners.contains(slug) {
                owners.push(slug.clone());
            }
        }
        let direct = if thumbnails::is_image_ext(&ext) && path.exists() {
            targets
        } else {
            Vec::new()
        };
        for slug in owners.iter().filter(|slug| !direct.contains(slug)) {
            discarded |= discard_preview(vault, slug);
        }
        previews.extend(owners);
        for slug in direct {
            spawn_thumb_from_picture(vault, path, slug, app);
        }
    }
    if let (Some(app), false) = (app, previews.is_empty()) {
        if let Err(error) = schedule_preview_reconcile(app, vault.clone(), previews, false) {
            log::warn!("failed to schedule previews after a media change: {error}");
        }
    }
    discarded || !reread.reread.is_empty()
}

/// The media file each of the cards `slugs` has in the index.
fn media_files_of<'a>(
    conn: &Connection,
    slugs: impl Iterator<Item = &'a String>,
) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    for slug in slugs {
        let media_file = conn.query_row(
            "SELECT media_file FROM blocks
             WHERE slug = ?1 AND media_file IS NOT NULL AND media_file != ''",
            [slug],
            |row| row.get::<_, String>(0),
        );
        match media_file {
            Ok(media_file) => rows.push((slug.clone(), media_file)),
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(error) => log::warn!("media owner lookup failed for {slug}: {error:#}"),
        }
    }
    rows
}

/// Remove the preview standing for `slug` and its reduced levels, so no
/// surface shows what a media file used to be. Returns whether there was
/// one.
fn discard_preview(vault: &VaultLayout, slug: &str) -> bool {
    let preview = vault.thumb_path(slug);
    let discarded = match std::fs::remove_file(&preview) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            log::warn!("stale preview {} stays: {error}", preview.display());
            false
        }
    };
    thumbnails::remove_thumb_levels(vault, slug);
    discarded
}

/// Make the thumbnail of `slug` from the picture at `picture` in the space's
/// preview queue and tell the feed; a stale thumbnail otherwise stays on
/// screen until a full refresh.
fn spawn_thumb_from_picture(
    vault: &VaultLayout,
    picture: &Path,
    slug: String,
    app: Option<&AppHandle>,
) {
    let stamp = preview_queue::stamp_of(picture);
    preview_queue::enqueue(
        app,
        vault,
        slug,
        preview_queue::Job::Picture {
            picture: picture.to_path_buf(),
            stamp,
        },
    );
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// The cards whose media file is the file at `path`: the ones whose preview
/// a landed picture is made into right away (SPEC_DEEP_AUDIT.md, Е5.3).
///
/// The index holds a card's media file as its path from the space root when
/// the file was found, and as the card wrote it when it was not there yet.
/// A card owns the file when that path is the file's own, or when what it
/// wrote leads to the file now. Until 13.10.2026 the owner was looked up by
/// the bare file name, which a space laid out in folders never holds
/// (`Media/x.jpg`), and the file's own path was taken for a card's: in a
/// flat space a picture `x.jpg` became the preview of the card `x`, whatever
/// that card showed, and in folders `Media/x` named no card at all.
fn media_thumb_targets(conn: &Connection, vault: &VaultLayout, path: &Path) -> Vec<String> {
    let rows = match crate::storage::block_queries::list_media_files(conn) {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("media owner lookup failed for {}: {error:#}", path.display());
            return Vec::new();
        }
    };
    media_owners_among(vault, path, &rows, &mut media_refs::MediaResolver::new(vault))
}

/// [`media_thumb_targets`] among the cards of `rows`, each with its media
/// file as the index holds it.
fn media_owners_among(
    vault: &VaultLayout,
    path: &Path,
    rows: &[(String, String)],
    resolver: &mut media_refs::MediaResolver<'_>,
) -> Vec<String> {
    let (Some(relative), Some(name)) = (
        vault.root_relative_reference(path),
        path.file_name().and_then(|name| name.to_str()),
    ) else {
        return Vec::new();
    };
    let fold = |text: &str| -> String { text.nfc().collect::<String>().to_lowercase() };
    let relative = fold(&relative);
    let name = fold(name);
    let present = path.exists();
    let mut targets = Vec::new();
    for (slug, media_file) in rows {
        let written = fold(media_file);
        let decoded = fold(&percent_encoding::percent_decode_str(media_file).decode_utf8_lossy());
        if !written.contains(&name) && !decoded.contains(&name) {
            continue;
        }
        let owns = written == relative
            || (present
                && crate::domain::vault::validate_slug(slug).is_ok()
                && resolver
                    .resolve_indexed_media(slug, media_file)
                    .is_some_and(|resolved| files::names_same_entry(&resolved, path) || resolved == path));
        if owns && !targets.contains(slug) {
            targets.push(slug.clone());
        }
    }
    targets
}

/// Extract path-based slug from a vault file path.
fn path_to_slug(vault: &VaultLayout, path: &Path) -> Option<String> {
    vault.slug_for_path(path).ok()
}

fn file_saved_at(path: &Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    DateTime::new(&crate::util::system_time_to_iso8601(time))
        // infallible inner unwrap: parsing a hardcoded valid ISO-8601 literal.
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

fn emit_article_audio_updated(app: &AppHandle, vault: &VaultLayout, slug: &str) {
    let _ = crate::commands::space_events::emit_to_vault(
        app,
        vault,
        ARTICLE_AUDIO_UPDATED_EVENT,
        ArticleAudioUpdatedPayload {
            slug: slug.to_string(),
        },
    );
}

// Extension predicates (is_image_ext, is_video_ext) live in
// storage::thumbnails as the single source of truth.

/// Moments of a watcher preview a test holds or watches: before the preview
/// of a card is made and after it is written. A hook belongs to one space,
/// the space of its test: the previews of other tests' spaces, which run at
/// the same time, never reach it.
#[cfg(test)]
pub(crate) mod preview_hooks {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, LazyLock, Mutex, PoisonError};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Moment {
        Before,
        After,
    }

    type Hook = Arc<dyn Fn(Moment, &str) + Send + Sync>;

    static HOOKS: LazyLock<Mutex<HashMap<PathBuf, Hook>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Run `hook` at every moment of every watcher preview of the space at
    /// `root`, until `clear`.
    pub(crate) fn set(root: &Path, hook: impl Fn(Moment, &str) + Send + Sync + 'static) {
        HOOKS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(root.to_path_buf(), Arc::new(hook));
    }

    pub(crate) fn clear(root: &Path) {
        HOOKS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(root);
    }

    pub(crate) fn run(moment: Moment, root: &Path, slug: &str) {
        // The hook runs outside the lock: it may hold its preview while
        // another one runs.
        let hook = HOOKS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(root)
            .cloned();
        if let Some(hook) = hook {
            hook(moment, slug);
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, DateTime, Frontmatter};
    use crate::storage::db;

    /// Е5.13: the preview of a card made from an earlier version of it must
    /// never replace the preview of its latest version. Until 13.10.2026
    /// every watcher event made its preview on a thread of its own, with no
    /// queue and no check that the card was still what the event read: a
    /// slow first preview finished last and put back the old picture.
    #[test]
    fn a_late_preview_of_an_earlier_version_does_not_replace_the_latest() {
        use std::sync::mpsc;
        let dir = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(dir.path().to_path_buf(), derived.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        image::RgbImage::from_pixel(40, 40, image::Rgb([220, 20, 20]))
            .save(dir.path().join("red.png"))
            .unwrap();
        image::RgbImage::from_pixel(40, 40, image::Rgb([20, 20, 220]))
            .save(dir.path().join("blue.png"))
            .unwrap();
        let card = dir.path().join("Late preview.md");
        std::fs::write(&card, "---\nfile: \"[[red.png]]\"\nsaved_at: 2026-01-15T12:00:00Z\n---\n").unwrap();

        let (go_tx, go_rx) = mpsc::channel::<()>();
        let go_rx = Mutex::new(Some(go_rx));
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let started_tx = Mutex::new(started_tx);
        let (after_tx, after_rx) = mpsc::channel::<()>();
        let after_tx = Mutex::new(after_tx);
        preview_hooks::set(vault.root(), move |moment, _slug| {
            match moment {
                // The first preview of the card is slow: it says it started
                // and waits for `go`.
                preview_hooks::Moment::Before => {
                    // Taken out first: the lock is not held while it waits.
                    let first = go_rx.lock().unwrap().take();
                    if let Some(go) = first {
                        let _ = started_tx.lock().unwrap().send(());
                        let _ = go.recv();
                    }
                }
                preview_hooks::Moment::After => {
                    let _ = after_tx.lock().unwrap().send(());
                }
            }
        });

        index_md_file(&conn, &vault, &card, None).unwrap();
        started_rx.recv_timeout(Duration::from_secs(30)).expect("the first preview starts");
        std::fs::write(&card, "---\nfile: \"[[blue.png]]\"\nsaved_at: 2026-01-15T12:00:00Z\n---\n\n").unwrap();
        index_md_file(&conn, &vault, &card, None).unwrap();
        // A preview of the latest version may finish while the first waits;
        // a queue keeps it behind the first, and this wait only times out.
        let early = after_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        go_tx.send(()).unwrap();
        let expected = if early { 1 } else { 2 };
        for _ in 0..expected {
            after_rx.recv_timeout(Duration::from_secs(30)).expect("the previews finish");
        }
        preview_hooks::clear(vault.root());

        let preview = image::open(vault.thumb_path("Late preview")).unwrap().to_rgb8();
        let center = preview.get_pixel(preview.width() / 2, preview.height() / 2);
        assert!(center[2] > center[0], "the preview shows the earlier picture: {center:?}");
    }

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
                related_notes: Vec::new(),
                source_media: None,
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

    /// П29: the sweep on window focus erased every card and preview of a
    /// space whose folder had just been renamed. It now leaves them alone, and
    /// so does the watcher when the rename reports every file as deleted.
    #[test]
    fn a_renamed_space_survives_the_sweep_and_the_watcher() {
        const ID: &str = "cea575682e5a4018991c0097fbedff66";
        let parent = tempfile::tempdir().unwrap();
        let source = parent.path().join("Mine");
        std::fs::create_dir_all(source.join(".mine")).unwrap();
        std::fs::write(source.join(".mine/vault-id"), ID).unwrap();
        let derived_parent = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(source.clone(), derived_parent.path().join(ID));
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let conn = test_conn();
        write_md_file(&vault, "keep", "article", &[]);
        full_scan(&conn, &vault, None, None).unwrap();
        std::fs::write(vault.thumb_path("keep"), b"preview").unwrap();
        let path = vault.block_path("keep");

        std::fs::rename(&source, parent.path().join("Mine!")).unwrap();
        assert!(thumb_sweep(&conn, &vault, None, None).is_err());
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        flush_pending_for_test(&conn, &vault, None);

        assert!(index::get_block(&conn, "keep").unwrap().is_some());
        assert_eq!(std::fs::read(vault.thumb_path("keep")).unwrap(), b"preview");
    }

    #[test]
    fn thumb_sweep_removes_orphan_block_whose_md_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let conn = test_conn();

        write_md_file(&vault, "keep", "article", &[]);
        write_md_file(&vault, "gone", "article", &[]);
        full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(index::list_blocks(&conn).unwrap().len(), 2);

        // Delete one .md while it is still indexed (an iCloud delete event the
        // notify watcher never received leaves exactly this orphan row).
        std::fs::remove_file(vault.block_path("gone")).unwrap();

        thumb_sweep(&conn, &vault, None, None).unwrap();

        let slugs: Vec<String> = index::list_blocks(&conn)
            .unwrap()
            .into_iter()
            .map(|b| b.slug)
            .collect();
        assert!(slugs.contains(&"keep".to_string()));
        assert!(
            !slugs.contains(&"gone".to_string()),
            "orphan should be removed"
        );
    }

    /// SPEC_THUMBNAILS.md, «Уровни миниатюр» (09.11.2026): a level missing
    /// beside a fresh thumbnail is made again by the sweep, which says so to
    /// the space. The sweep took such a card for fresh and left the sidebar
    /// asking for a file that was not there.
    #[test]
    fn the_sweep_makes_a_missing_level_again() {
        use crate::domain::vault::ThumbLevel;
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let conn = test_conn();
        write_md_file(&vault, "Note", "article", &[]);
        full_scan(&conn, &vault, None, None).unwrap();
        let full = vault.thumb_path("Note");
        let micro = vault.thumb_level_path("Note", ThumbLevel::Micro);
        let made = std::time::Instant::now();
        while !(full.is_file() && micro.is_file()) {
            assert!(made.elapsed() < Duration::from_secs(10), "the scan made no thumbnail");
            std::thread::sleep(Duration::from_millis(20));
        }
        let full_before = std::fs::read(&full).unwrap();
        std::fs::remove_file(&micro).unwrap();

        let (done, heard) = std::sync::mpsc::channel();
        thumb_sweep(
            &conn,
            &vault,
            None,
            Some(Box::new(move || {
                let _ = done.send(());
            })),
        )
        .unwrap();

        heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the sweep reported no change");
        assert!(micro.is_file(), "the sweep left the micro level missing");
        assert_eq!(std::fs::read(&full).unwrap(), full_before, "the full thumbnail stays as it was");
    }

    #[test]
    fn full_scan_indexes_foreign_markdown_without_errors() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "good", "image", &[]);
        // No frontmatter is valid Obsidian/foreign Markdown.
        std::fs::write(vault.block_path("bad"), "not a valid block").unwrap();

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(result.indexed, 2);
        assert_eq!(result.errors, 0);
    }

    #[test]
    fn full_scan_preserves_human_channel_filename() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "Красивый веб", "channel", &[]);

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(result.indexed, 1);
        assert_eq!(result.errors, 0);
        assert!(vault.block_path("Красивый веб").exists());
        assert!(!vault.block_path("красивый-веб").exists());

        let channels = index::list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "Красивый веб");
    }

    #[test]
    fn full_scan_preserves_distinct_channel_pages() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "Красивый веб", "channel", &[]);
        write_md_file(&vault, "красивый-веб", "channel", &[]);

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(result.indexed, 2);
        assert_eq!(result.errors, 0);
        assert!(vault.block_path("Красивый веб").exists());
        assert!(vault.block_path("красивый-веб").exists());

        let channels = index::list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 2);
        assert!(channels.iter().any(|channel| channel.tag == "Красивый веб"));
        assert!(channels.iter().any(|channel| channel.tag == "красивый-веб"));
    }

    #[test]
    fn full_scan_does_not_canonicalize_human_named_articles() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "Красивый веб", "article", &[]);

        let result = full_scan(&conn, &vault, None, None).unwrap();
        assert_eq!(result.indexed, 1);
        assert_eq!(result.errors, 0);
        assert!(vault.block_path("Красивый веб").exists());
        assert!(!vault.block_path("красивый-веб").exists());
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
        // No page called "design" yet: the link is no collection
        // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К2).
        assert!(block.tags.is_empty());

        // The page arrives: the note is in the collection without being
        // indexed again (К3).
        write_md_file(&vault, "design", "channel", &[]);
        index_md_file(&conn, &vault, &vault.block_path("design"), None).unwrap();
        let block = index::get_block(&conn, "note").unwrap().unwrap();
        assert_eq!(block.tags, vec!["design"]);
    }

    #[test]
    fn index_single_file_preserves_human_channel_filename() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "Красивый веб", "channel", &[]);
        let path = vault.block_path("Красивый веб");
        index_md_file(&conn, &vault, &path, None).unwrap();

        assert!(vault.block_path("Красивый веб").exists());
        assert!(!vault.block_path("красивый-веб").exists());

        let channels = index::list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "Красивый веб");
    }

    #[test]
    fn index_foreign_markdown_file_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        std::fs::write(vault.block_path("bad"), "garbage").unwrap();
        let path = vault.block_path("bad");
        assert!(index_md_file(&conn, &vault, &path, None).unwrap());
        let block = index::get_block(&conn, "bad").unwrap().unwrap();
        assert_eq!(block.block_type, BlockType::Article);
    }

    // ── handle_event ─────────────────────────────────────────────────────

    #[test]
    fn handle_block_changed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file_with_body(&vault, "note", "link", &[], "unique-delete-body");
        let path = vault.block_path("note");
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path), None).unwrap();

        assert!(index::get_block(&conn, "note").unwrap().is_some());
    }

    /// One pass of the watcher's timer: wait for the earliest deadline, then
    /// commit what has expired. No other file event is involved (Ф7).
    /// Returns the pass and the cards it announced as removed.
    fn run_removal_timer_pass(conn: &Connection, vault: &VaultLayout) -> (RemovalPass, Vec<String>) {
        assert!(next_pending_deadline(vault).is_some(), "a removal is pending");
        let due = wait_for_due_removals(vault, &RemovalTimerStop::default())
            .expect("a running timer takes the due removals");
        let mut announced = Vec::new();
        let pass = commit_removals(conn, vault, &due, &mut |removed| {
            announced.push(removed.slug.clone());
        })
        .unwrap();
        (pass, announced)
    }

    fn run_removal_timer_once(conn: &Connection, vault: &VaultLayout) -> bool {
        run_removal_timer_pass(conn, vault).0.removed
    }

    #[test]
    fn a_deletion_queued_after_the_timer_woke_is_committed_by_the_timer() {
        // Б2.3: the watcher used to wake its timer before the handler queued
        // the deletion (after a database read); the timer found nothing and
        // slept with no deadline. The deletion must leave the index when its
        // window passes, with no further file event.
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        write_md_file_with_body(&vault, "gone", "link", &[], "timer-ordering-body");
        let path = vault.block_path("gone");
        index_md_file(&conn, &vault, &path, None).unwrap();

        let stop = RemovalTimerStop::default();
        let (removed_tx, removed_rx) = std::sync::mpsc::channel();
        let timer = {
            let vault = vault.clone();
            let stop = stop.clone();
            let timer_conn = db::open_or_create(&vault.index_db_path()).unwrap();
            std::thread::spawn(move || {
                run_removal_timer(&timer_conn, &vault, &stop, None, |pass| {
                    if pass.expect("the removal commits").removed {
                        let _ = removed_tx.send(Instant::now());
                    }
                });
            })
        };
        // The timer waits with nothing queued; a wake-up reaches it first,
        // the deletion is queued 5 ms later.
        std::thread::sleep(Duration::from_millis(20));
        pending_removals().changed.notify_all();
        std::thread::sleep(Duration::from_millis(5));
        std::fs::remove_file(&path).unwrap();
        let queued = Instant::now();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();

        let committed = removed_rx
            .recv_timeout(Duration::from_millis(RENAME_MATCH_WINDOW_MS + 1_000))
            .expect("the timer commits the deletion without another event");
        assert!(committed.duration_since(queued) >= Duration::from_millis(RENAME_MATCH_WINDOW_MS));
        assert!(index::get_block(&conn, "gone").unwrap().is_none());
        stop.stop();
        timer.join().unwrap();
    }

    /// A card indexed in `vault`'s own index file, its note then deleted and
    /// the deletion queued, and a second connection holding the index's
    /// write lock: the removal is refused the way a busy index refuses it.
    fn a_deletion_behind_a_locked_index(
        slug: &str,
    ) -> (tempfile::TempDir, VaultLayout, Connection, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        conn.busy_timeout(Duration::from_millis(20)).unwrap();
        write_md_file_with_body(&vault, slug, "link", &[], "busy-index-body");
        let path = vault.block_path(slug);
        index_md_file(&conn, &vault, &path, None).unwrap();
        std::fs::remove_file(&path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        let writer = db::open_or_create(&vault.index_db_path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        (dir, vault, conn, writer)
    }

    #[test]
    fn a_refused_removal_is_not_announced_and_commits_once_the_index_frees() {
        // В2.3: the index refused the deletion, yet `block:removed` went out
        // and the pass counted a removal; the card vanished from the feed and
        // came back on the next reload, until some unrelated reconciliation.
        let (_dir, vault, conn, writer) = a_deletion_behind_a_locked_index("busy");

        let (pass, announced) = run_removal_timer_pass(&conn, &vault);
        assert_eq!(pass, RemovalPass { removed: false, stale: true });
        assert!(announced.is_empty(), "a card still in the index is announced as removed");
        assert!(index::get_block(&conn, "busy").unwrap().is_some());
        let retry = next_pending_deadline(&vault).expect("the refused removal is queued again");

        // The lock clears; the timer's retry converges with no file event.
        writer.execute_batch("COMMIT").unwrap();
        let (pass, announced) = run_removal_timer_pass(&conn, &vault);
        assert!(Instant::now() >= retry);
        assert_eq!(pass, RemovalPass { removed: true, stale: false });
        assert_eq!(announced, vec!["busy".to_string()]);
        assert!(index::get_block(&conn, "busy").unwrap().is_none());
        assert_eq!(next_pending_deadline(&vault), None);
    }

    #[test]
    fn a_removal_refused_on_every_attempt_is_left_to_reconciliation() {
        let (_dir, vault, conn, _writer) = a_deletion_behind_a_locked_index("stuck");
        let mut last = drain_due(&mut pending_entries(), &vault, Instant::now() + Duration::from_secs(60));
        assert_eq!(last.len(), 1);
        last[0].failed_attempts = REMOVAL_ATTEMPTS - 1;

        let mut announced = Vec::new();
        let pass = settle_removals(&conn, &vault, last, &mut |removed| {
            announced.push(removed.slug.clone());
        });

        assert_eq!(pass, RemovalPass { removed: false, stale: true });
        assert!(announced.is_empty());
        assert!(index::get_block(&conn, "stuck").unwrap().is_some());
        assert_eq!(next_pending_deadline(&vault), None, "the attempts are bounded");
        assert_eq!(removal_retry_delay(1), REMOVAL_RETRY_DELAY);
        assert_eq!(removal_retry_delay(REMOVAL_ATTEMPTS - 1), REMOVAL_RETRY_DELAY * 8);
    }

    #[test]
    fn handle_block_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "note", "link", &[]);
        let path = vault.block_path("note");
        index_md_file(&conn, &vault, &path, None).unwrap();

        // BlockDeleted defers removal into the rename-match queue: the row
        // stays so a matching BlockChanged can keep the card's identity.
        std::fs::remove_file(&path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        assert!(
            index::get_block(&conn, "note").unwrap().is_some(),
            "deferral preserves row until the window expires"
        );

        // The timer commits it once the window passes, without another event.
        assert!(run_removal_timer_once(&conn, &vault));
        assert!(index::get_block(&conn, "note").unwrap().is_none());
        assert_eq!(next_pending_deadline(&vault), None);
    }

    #[test]
    fn a_restored_note_survives_its_earlier_deletion_event() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        write_md_file_with_body(&vault, "back", "article", &[], "body");
        let path = vault.block_path("back");
        index_md_file(&conn, &vault, &path, None).unwrap();

        // Restored without any event reaching the watcher.
        let saved = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path.clone()), None).unwrap();
        std::fs::write(&path, &saved).unwrap();
        assert!(!run_removal_timer_once(&conn, &vault));
        assert!(index::get_block(&conn, "back").unwrap().is_some());

        // Restored with its event: the pending removal is void at once.
        std::fs::remove_file(&path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path.clone()), None).unwrap();
        std::fs::write(&path, &saved).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path), None).unwrap();
        assert_eq!(next_pending_deadline(&vault), None);
        assert!(index::get_block(&conn, "back").unwrap().is_some());
    }

    #[test]
    fn handle_block_rename_preserves_identity() {
        // A filesystem move retains its physical locator and index identity.
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
        crate::storage::file_identity::reconcile(&vault).unwrap();
        let original = index::get_block(&conn, "old-name").unwrap().unwrap();
        let original_id = original.id;

        let new_path = vault.block_path("new-name");
        std::fs::rename(&old_path, &new_path).unwrap();
        handle_event(
            &conn,
            &vault,
            &VaultEvent::BlockDeleted(old_path.clone()),
            None,
        )
        .unwrap();

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
    fn external_rename_rewrites_established_markdown_links() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        flush_pending_for_test(&conn, &vault, None);

        let unique_body = format!("external-rename-body-{:?}", std::thread::current().id());
        write_md_file_with_body(&vault, "old-name", "article", &[], &unique_body);
        write_md_file_with_body(
            &vault,
            "reference",
            "article",
            &[],
            "See [[old-name]] and ![[old-name]].",
        );

        let old_path = vault.block_path("old-name");
        let reference_path = vault.block_path("reference");
        index_md_file(&conn, &vault, &old_path, None).unwrap();
        index_md_file(&conn, &vault, &reference_path, None).unwrap();
        crate::storage::file_identity::reconcile(&vault).unwrap();

        let new_path = vault.block_path("new-name");
        std::fs::rename(&old_path, &new_path).unwrap();
        handle_event(
            &conn,
            &vault,
            &VaultEvent::BlockDeleted(old_path.clone()),
            None,
        )
        .unwrap();

        handle_event(&conn, &vault, &VaultEvent::BlockChanged(new_path), None).unwrap();

        let (_, reference_content) = files::read_block_file(&vault, &reference_path).unwrap();
        let reference_block = parse_block("reference", &reference_content).unwrap();
        assert!(reference_block.body.contains("[[new-name]]"));
        assert!(reference_block.body.contains("![[new-name]]"));
        assert!(!reference_block.body.contains("[[old-name]]"));

        flush_pending_for_test(&conn, &vault, None);
    }

    /// SPEC_INTEGRATION.md, «Переименование медиа снаружи»: a media file
    /// renamed outside Mine reaches the watcher as the old path gone and the
    /// new one there. The batch reads again the notes that named the file
    /// and asks for a pass over the space at once; that pass, with its file
    /// identity pass, repairs the reference. Until 16.11.2026 every media
    /// event ran such a pass itself.
    #[test]
    fn a_media_move_outside_is_repaired_by_the_pass_its_batch_asks_for() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        std::fs::create_dir_all(dir.path().join("Media")).unwrap();
        let original = dir.path().join("Media/original.jpg");
        std::fs::write(&original, b"original").unwrap();
        std::fs::write(
            dir.path().join("Card.md"),
            "---\ntype: image\nfile: \"[[Media/original.jpg]]\"\n---\n",
        )
        .unwrap();
        crate::storage::reconcile::reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {})
            .unwrap();

        std::fs::create_dir_all(dir.path().join("Other")).unwrap();
        std::fs::write(dir.path().join("Other/original.jpg"), b"different").unwrap();
        let moved = dir.path().join("Media/moved.jpg");
        std::fs::rename(&original, &moved).unwrap();
        let outcome = handle_batch(
            &conn,
            &vault,
            &[
                see_event(&vault, VaultEvent::MediaDeleted(original)),
                see_event(&vault, VaultEvent::MediaChanged(moved.clone())),
            ],
            None,
        );

        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.reread, ["Card"], "the note that named the file is read at once");
        assert!(outcome.full_pass, "a media file that went asks for a pass over the space");
        // The pass the watcher asks the freshness coordinator for.
        crate::storage::reconcile::reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {})
            .unwrap();
        let card = index::get_block(&conn, "Card").unwrap().unwrap();
        let reference = card.media_file.as_deref().unwrap();
        assert_eq!(
            crate::storage::media_refs::resolve_indexed_media(&vault, "Card", reference),
            Some(moved)
        );
    }

    /// A space in three folders with `cards` picture cards, each naming a
    /// picture of its own in `Media/`, indexed by a pass over the space.
    fn space_of_picture_cards(cards: usize) -> (tempfile::TempDir, VaultLayout, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        for folder in ["Cards", "Media"] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
        }
        for card in 0..cards {
            std::fs::write(dir.path().join(format!("Media/picture-{card}.jpg")), b"picture").unwrap();
            std::fs::write(
                dir.path().join(format!("Cards/Card {card}.md")),
                format!("---\ntype: image\nfile: \"[[picture-{card}.jpg]]\"\nsaved_at: 2026-07-10T00:00:00Z\n---\n"),
            )
            .unwrap();
        }
        let report = reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(report.upserted.len(), cards);
        (dir, vault, conn)
    }

    /// SPEC_INTEGRATION.md, «Точное перечитывание» (AUDIT_PERFORMANCE.md,
    /// Б1): the media files of one batch are one pass, which walks no
    /// space and reads again exactly the notes that name them. Until
    /// 16.11.2026 a hundred files were a hundred passes over the whole
    /// space.
    #[test]
    fn a_hundred_media_events_of_one_batch_make_one_pass() {
        let (dir, vault, conn) = space_of_picture_cards(120);
        let mut events = Vec::new();
        for card in 0..100 {
            let picture = dir.path().join(format!("Media/picture-{card}.jpg"));
            std::fs::write(&picture, b"another picture, longer").unwrap();
            // A file often reports more than once.
            events.push(see_event(&vault, VaultEvent::MediaChanged(picture.clone())));
            events.push(see_event(&vault, VaultEvent::MediaChanged(picture)));
        }
        let passes = reconcile::reread_passes();
        let walks = (reconcile::inventory_walks(), media_refs::link_index_builds());

        let outcome = handle_batch(&conn, &vault, &events, None);

        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(reconcile::reread_passes() - passes, 1, "one pass for the batch");
        assert_eq!(
            (reconcile::inventory_walks(), media_refs::link_index_builds()),
            walks,
            "the batch walked the space"
        );
        let mut expected = (0..100).map(|card| format!("Cards/Card {card}")).collect::<Vec<_>>();
        expected.sort();
        assert_eq!(outcome.reread, expected);
        assert!(outcome.changed);
        assert!(!outcome.full_pass, "files that changed ask for no pass over the space");
        // The index holds the files as they are: a pass finds nothing.
        let pass = reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert_eq!((pass.unchanged, pass.content_reads), (120, 0), "{pass:?}");
    }

    /// Поправка пользователя 15.11.2026: a file that lands in `Media/` after
    /// the note that names it finds the note by its name. The note recorded
    /// the missing file at a path beside itself (`Cards/late.jpg`), which
    /// the file never takes; the event is enough, with no pass over the
    /// space and no file identity pass.
    #[test]
    fn a_file_that_lands_in_media_after_its_note_finds_the_note_by_name() {
        let (dir, vault, conn) = space_of_picture_cards(2);
        std::fs::write(
            dir.path().join("Cards/Late.md"),
            "---\ntype: image\nfile: \"[[late.jpg]]\"\nsaved_at: 2026-07-10T00:00:00Z\n---\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("Cards/Article.md"),
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\nText.\n\n![](../Media/Late.JPG)\n",
        )
        .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        let card = index::get_block(&conn, "Cards/Late").unwrap().unwrap();
        assert_ne!(card.media_file.as_deref(), Some("Media/late.jpg"), "the file is not there yet");
        let walks = reconcile::inventory_walks();

        let landed = dir.path().join("Media/late.jpg");
        std::fs::write(&landed, b"the picture").unwrap();
        let outcome = handle_batch(
            &conn,
            &vault,
            &[see_event(&vault, VaultEvent::MediaChanged(landed.clone()))],
            None,
        );

        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.reread, ["Cards/Article", "Cards/Late"]);
        assert!(outcome.changed && !outcome.full_pass);
        assert_eq!(reconcile::inventory_walks(), walks, "the event walked the space");
        let card = index::get_block(&conn, "Cards/Late").unwrap().unwrap();
        assert_eq!(card.media_file.as_deref(), Some("Media/late.jpg"));
        assert_eq!(
            crate::storage::media_refs::resolve_indexed_media(&vault, "Cards/Late", "Media/late.jpg"),
            Some(landed)
        );
        // The stamps hold the file where it is: a pass finds nothing to read.
        let pass = reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(pass.content_reads, 0, "{pass:?}");
    }

    /// The notes of a batch are handled before its media, whatever order
    /// their events came in: the note is read once, with the file there,
    /// and is not read again for the file.
    #[test]
    fn notes_of_a_batch_are_handled_before_its_media() {
        let (dir, vault, conn) = space_of_picture_cards(1);
        let note = dir.path().join("Cards/Late.md");
        let source = |text: &str| {
            format!("---\ntype: image\nfile: \"[[late.jpg]]\"\nsaved_at: 2026-07-10T00:00:00Z\n---\n{text}")
        };
        std::fs::write(&note, source("")).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        let landed = dir.path().join("Media/late.jpg");
        std::fs::write(&landed, b"the picture").unwrap();
        std::fs::write(&note, source("Edited as the picture came.\n")).unwrap();
        let outcome = handle_batch(
            &conn,
            &vault,
            &[
                see_event(&vault, VaultEvent::MediaChanged(landed)),
                see_event(&vault, VaultEvent::BlockChanged(note)),
            ],
            None,
        );

        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert!(outcome.reread.is_empty(), "the note was read a second time: {:?}", outcome.reread);
        let card = index::get_block(&conn, "Cards/Late").unwrap().unwrap();
        assert_eq!(card.media_file.as_deref(), Some("Media/late.jpg"));
        assert!(card.body.contains("Edited as the picture came."));
    }

    /// A folder that appears, moves or goes is no file a note names: only a
    /// walk tells what happened under it. The batch asks for a pass over
    /// the space, and the names kept for the space are dropped, to be
    /// listed again.
    #[test]
    fn a_folder_event_asks_for_a_full_pass_and_drops_the_kept_names() {
        let (dir, vault, conn) = space_of_picture_cards(2);
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/picture-0.jpg"), Some(true));

        let moved = dir.path().join("Pictures");
        std::fs::rename(dir.path().join("Media"), &moved).unwrap();
        let events = [
            see_event(&vault, VaultEvent::MediaDeleted(dir.path().join("Media"))),
            see_event(&vault, VaultEvent::MediaChanged(moved)),
        ];

        assert_eq!(events[0].path, SeenPath::Folder);
        assert_eq!(events[1].path, SeenPath::Folder);
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/picture-0.jpg"), None);
        let outcome = handle_batch(&conn, &vault, &events, None);
        assert!(outcome.full_pass);
        assert!(outcome.reread.is_empty());
        // The pass the batch asks for lists the space again.
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Pictures/picture-0.jpg"), Some(true));
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/picture-0.jpg"), Some(false));
    }

    /// The names kept for a space cannot stay apart from the disk: a file
    /// whose event the watcher lost is in them after the next pass over the
    /// space, and a file whose removal it lost is out of them.
    #[test]
    fn a_full_pass_replaces_names_the_watcher_lost() {
        let (dir, vault, conn) = space_of_picture_cards(2);
        let followed = dir.path().join("Media/followed.jpg");
        std::fs::write(&followed, b"seen").unwrap();
        assert_eq!(
            see_event(&vault, VaultEvent::MediaChanged(followed)).path,
            SeenPath::File
        );
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/followed.jpg"), Some(true));

        std::fs::write(dir.path().join("Media/unseen.jpg"), b"no event came").unwrap();
        std::fs::remove_file(dir.path().join("Media/picture-1.jpg")).unwrap();
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/unseen.jpg"), Some(false));
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/picture-1.jpg"), Some(true));

        reconcile::reconcile_vault_for_action(&conn, &vault).unwrap();

        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/unseen.jpg"), Some(true));
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/picture-1.jpg"), Some(false));
        assert_eq!(reconcile::kept_names_hold(vault.root(), "Media/followed.jpg"), Some(true));
    }

    /// Media events timed in each space; the limit holds for their median.
    const TIMED_MEDIA_EVENTS: usize = 21;
    /// Б1: one media event, whatever the size of the space.
    const MEDIA_EVENT_LIMIT: Duration = Duration::from_millis(20);
    /// The larger space the same limit is asserted on: three times the notes
    /// of the timed space.
    const LARGER_SPACE_NOTES: usize = 30_000;

    /// The median and the slowest of `TIMED_MEDIA_EVENTS` media events in a
    /// space of `notes` notes of the timed make-up, each a picture replaced:
    /// the one note that names it is found and read again, and the space is
    /// not walked.
    fn timed_media_events(notes: usize) -> (Duration, Duration) {
        use crate::storage::reconcile::timed_space;
        let (directory, derived) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let vault = VaultLayout::with_derived_root(
            directory.path().to_path_buf(),
            derived.path().to_path_buf(),
        );
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        timed_space::write_notes(vault.root(), notes);
        assert_eq!(
            reconcile::reconcile_vault(&conn, &vault).unwrap().upserted.len(),
            notes + timed_space::COLLECTIONS
        );
        let walks = reconcile::inventory_walks();

        let mut times = Vec::with_capacity(TIMED_MEDIA_EVENTS);
        for event in 0..TIMED_MEDIA_EVENTS {
            let note = event * (notes / TIMED_MEDIA_EVENTS / 4) * 4;
            let media = timed_space::media_of(note).expect("every fourth note shows a picture");
            let path = vault.root().join(media);
            std::fs::write(&path, format!("the picture replaced, {event}")).unwrap();
            let started = Instant::now();
            let seen = see_event(&vault, VaultEvent::MediaChanged(path));
            let outcome = handle_batch(&conn, &vault, &[seen], None);
            times.push(started.elapsed());
            assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
            assert_eq!(outcome.reread, [format!("Cards/Note {note:05}")]);
            assert!(outcome.changed && !outcome.full_pass);
        }
        assert_eq!(reconcile::inventory_walks(), walks, "a media event walked the space");
        times.sort();
        (times[TIMED_MEDIA_EVENTS / 2], times[TIMED_MEDIA_EVENTS - 1])
    }

    /// AUDIT_PERFORMANCE.md, Б1 (SPEC_INTEGRATION.md, «Точное
    /// перечитывание»): a media file that changes is handled within
    /// `MEDIA_EVENT_LIMIT` in a space of 10 000 notes and, within the same
    /// limit, in one of 30 000: what an event costs does not grow with the
    /// space. Until 16.11.2026 each such event ran a pass over the whole
    /// space. The limit is an optimised build's: a speed test, run by
    /// `test:rust-speed` alone (ARCHITECTURE.md, «Тесты скорости Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_media_event_in_a_space_of_10_000_notes_answers_within_its_limit() {
        let timed = crate::storage::reconcile::timed_space::NOTES;
        let (median, slowest) = timed_media_events(timed);
        let (larger_median, larger_slowest) = timed_media_events(LARGER_SPACE_NOTES);
        eprintln!(
            "media event: in a space of {timed} notes median {median:?}, slowest {slowest:?}; in a space of {LARGER_SPACE_NOTES} notes median {larger_median:?}, slowest {larger_slowest:?}; {TIMED_MEDIA_EVENTS} events each, limit {MEDIA_EVENT_LIMIT:?}, asserted for both",
        );
        assert!(
            median <= MEDIA_EVENT_LIMIT,
            "a media event in {timed} notes {median:?} over {MEDIA_EVENT_LIMIT:?} (slowest {slowest:?})"
        );
        assert!(
            larger_median <= MEDIA_EVENT_LIMIT,
            "a media event in {LARGER_SPACE_NOTES} notes {larger_median:?} over {MEDIA_EVENT_LIMIT:?} (slowest {larger_slowest:?})"
        );
    }

    #[test]
    fn identical_new_note_is_not_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        write_md_file_with_body(&vault, "old", "article", &[], "identical body");
        let old_path = vault.block_path("old");
        index_md_file(&conn, &vault, &old_path, None).unwrap();
        crate::storage::file_identity::reconcile(&vault).unwrap();
        let old_id = index::get_block(&conn, "old").unwrap().unwrap().id;
        std::fs::remove_file(&old_path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(old_path), None).unwrap();
        write_md_file_with_body(&vault, "new", "article", &[], "identical body");
        handle_event(
            &conn,
            &vault,
            &VaultEvent::BlockChanged(vault.block_path("new")),
            None,
        )
        .unwrap();
        let new_id = index::get_block(&conn, "new").unwrap().unwrap().id;
        assert_ne!(new_id, old_id);
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

        std::fs::remove_file(&path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        // No matching create: the timer commits the deferred removal.
        assert!(run_removal_timer_once(&conn, &vault));
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

    /// ВК1: a name never makes a conflict. `Note 2.md`, the name iCloud
    /// gives a second new file, and `(conflicted copy)`, the name other
    /// services give, are notes like any other, from an event and from both
    /// scans, and leave no conflict rows.
    #[test]
    fn conflict_like_names_are_ordinary_notes() {
        let names = ["Note 2", "Note (conflicted copy)", "Doc (MacBook Pro conflicted copy)"];
        let event_dir = tempfile::tempdir().unwrap();
        let event_vault = VaultLayout::new(event_dir.path().to_path_buf());
        let event_conn = test_conn();
        for name in names {
            write_md_file_with_body(&event_vault, name, "link", &[], "body");
            let path = event_vault.block_path(name);
            handle_event(&event_conn, &event_vault, &VaultEvent::BlockChanged(path), None).unwrap();
            assert!(index::get_block(&event_conn, name).unwrap().is_some(), "{name}");
        }
        assert!(crate::storage::vault_conflicts::list_conflict_paths(&event_conn)
            .unwrap()
            .is_empty());

        for scan in [full_scan, incremental_scan] {
            let dir = tempfile::tempdir().unwrap();
            let vault = VaultLayout::new(dir.path().to_path_buf());
            let conn = test_conn();
            write_md_file_with_body(&vault, "Note", "link", &[], "body");
            for name in names {
                write_md_file_with_body(&vault, name, "link", &[], "body");
            }
            scan(&conn, &vault, None, None).unwrap();
            for name in ["Note"].into_iter().chain(names) {
                assert!(index::get_block(&conn, name).unwrap().is_some(), "{name}");
            }
            assert!(crate::storage::vault_conflicts::list_conflict_paths(&conn)
                .unwrap()
                .is_empty());
        }
    }

    /// Е5.3: in a space laid out in folders the index holds the card's media
    /// as the path from the root (`Media/shot.png`), so a lookup by the bare
    /// file name never found the card the landing picture belongs to.
    #[test]
    fn a_picture_landing_in_the_media_folder_refreshes_the_card_that_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        std::fs::create_dir_all(dir.path().join("Media")).unwrap();
        let media_path = dir.path().join("Media/shot.png");
        std::fs::write(&media_path, b"picture").unwrap();
        std::fs::write(
            dir.path().join("Cards/shot.md"),
            "---\nfile: \"[[Media/shot.png]]\"\nsaved_at: 2026-01-15T12:00:00Z\n---\n",
        )
        .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(media_thumb_targets(&conn, &vault, &media_path), ["Cards/shot"]);
    }

    /// Е5.3: in a flat space a picture that only shares a card's name is not
    /// that card's picture: `x.jpg` landing must not become the preview of
    /// the card `x`, whose media is another file.
    #[test]
    fn a_picture_named_like_a_card_is_not_its_preview() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        std::fs::write(dir.path().join("other.jpg"), b"picture").unwrap();
        std::fs::write(
            dir.path().join("x.md"),
            "---\nfile: \"[[other.jpg]]\"\nsaved_at: 2026-01-15T12:00:00Z\n---\n",
        )
        .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        let landed = dir.path().join("x.jpg");
        std::fs::write(&landed, b"another picture").unwrap();

        assert!(media_thumb_targets(&conn, &vault, &landed).is_empty());
    }

    #[test]
    fn handle_media_deleted_removes_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let media_path = vault.media_path("photo", "jpg");
        std::fs::write(&media_path, b"picture").unwrap();
        std::fs::write(
            vault.block_path("photo"),
            "---\nfile: \"[[photo.jpg]]\"\nsaved_at: 2026-01-15T12:00:00Z\n---\n",
        )
        .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();

        // The card's preview stands for its picture.
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let thumb = vault.thumb_path("photo");
        std::fs::write(&thumb, b"fake thumb").unwrap();
        assert!(thumb.exists());

        // The picture deleted: the card's preview goes with it.
        std::fs::remove_file(&media_path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::MediaDeleted(media_path), None).unwrap();
        assert!(!thumb.exists());
    }

    /// A space in three folders: the card in `Cards/`, its media in
    /// `Media/`, indexed, with a preview standing for the card.
    fn card_with_media_in_folders(
        card: &str,
        frontmatter: &str,
        body: &str,
        media: &str,
        bytes: &[u8],
    ) -> (tempfile::TempDir, VaultLayout, Connection, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        std::fs::create_dir_all(dir.path().join("Media")).unwrap();
        let media_path = dir.path().join("Media").join(media);
        std::fs::write(&media_path, bytes).unwrap();
        std::fs::write(
            dir.path().join("Cards").join(format!("{card}.md")),
            format!("---\n{frontmatter}saved_at: 2026-07-10T00:00:00Z\n---\n{body}"),
        )
        .unwrap();
        reconcile::reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();
        let preview = vault.thumb_path(&format!("Cards/{card}"));
        std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
        std::fs::write(&preview, b"preview of the first media").unwrap();
        (dir, vault, conn, media_path, preview)
    }

    /// Г2.3: the video a card embeds is replaced outside Mine. The card's
    /// preview is the old video's frame: it goes, so the poster is made
    /// again from the new video, and the feed is told.
    #[test]
    fn a_replaced_video_invalidates_the_owning_cards_preview_and_notifies_the_feed() {
        let (_dir, vault, conn, video, preview) = card_with_media_in_folders(
            "Film",
            "type: article\n",
            "# Film\n\n![[clip.mp4]]\n",
            "clip.mp4",
            b"first video",
        );

        std::fs::write(&video, b"another, longer video").unwrap();
        let changed = handle_event(&conn, &vault, &VaultEvent::MediaChanged(video), None).unwrap();

        assert!(changed, "the feed is not told about the replaced video");
        assert!(
            !preview.exists(),
            "the old video's frame still stands for the card"
        );

        // The preview pass the change queues makes the card's preview again,
        // from the new video (here a stand-in the browser has to decode).
        crate::storage::derived_preview::reconcile_preview_for_slug(&conn, &vault, "Cards/Film")
            .unwrap()
            .expect("the card has a preview to reconcile");
        let remade = std::fs::read(&preview).expect("the preview is made again");
        assert_ne!(remade, b"preview of the first media");
    }

    /// «Отказ чтения» (SPEC_CLOUD_STORAGE.md): iCloud takes away the video a
    /// card embeds, and this Mac may not read it back (`EDEADLK`). The
    /// eviction reaches the watcher as an event on the file, but the file is
    /// the one the card's preview was made from: the preview stays (Х5).
    /// The preview pass over the card does not trade it for the card's text
    /// either, and says the card waits for iCloud. Until 17.11.2026 the
    /// event discarded the preview, and nothing could make it again while the
    /// video stayed in iCloud: an empty tile in the sidebar, in the window on
    /// hover and in the open card.
    #[test]
    fn an_evicted_video_keeps_the_preview_of_the_card_that_shows_it() {
        use crate::storage::cloud_files::test_seam;
        let (_dir, vault, conn, video, preview) = card_with_media_in_folders(
            "Film",
            "type: article\n",
            "# Film\n\n![[clip.mp4]]\n",
            "clip.mp4",
            b"the video",
        );
        test_seam::refuse_reads_of(&video);

        let changed = handle_event(&conn, &vault, &VaultEvent::MediaChanged(video.clone()), None).unwrap();

        assert!(!changed, "an eviction is no news for the feed");
        assert_eq!(std::fs::read(&preview).unwrap(), b"preview of the first media");

        let outcome = crate::storage::derived_preview::reconcile_preview_for_slug(&conn, &vault, "Cards/Film")
            .unwrap()
            .expect("the card has a preview to reconcile");
        assert_eq!(
            outcome.failure.map(|failure| failure.error_kind),
            Some(crate::storage::derived_preview::PreviewErrorKind::ContentInCloud)
        );
        assert_eq!(std::fs::read(&preview).unwrap(), b"preview of the first media");
        assert!(test_seam::reads_of(&video) > 0, "the pass did not try the video");
    }

    /// When the watcher's own preview of an edited card lands, relative to
    /// the preview pass the same event queues for the card. The watcher's
    /// preview is the card's thumbnail, with the thumbnail's size stamped
    /// into the manifest (`preview_queue`, `index::sync_thumb_metadata`); the
    /// pass makes the same thumbnail and the tiles, then publishes
    /// (`schedule_preview_reconcile`). In the application the two run on two
    /// threads, in any of these orders.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum WatcherPreview {
        BeforeThePass,
        /// After the pass read the card's plan and made its pictures, before
        /// it publishes: the order of an edited card with tiles, whose pass
        /// has more pictures to make than the watcher.
        WhileThePassPublishes,
        AfterThePass,
    }

    /// SPEC_THUMBNAILS.md, «Свои записи Mine» (решение пользователя
    /// 09.11.2026): an edit made outside Mine that drops a picture reaches
    /// the feed at once too. The watcher indexes the note with its source
    /// stamp, so the preview pass it queues sees the change and draws the
    /// card from the pictures it still shows. Before, the row moved without
    /// the stamp, the pass saw nothing new and published the old tiles at
    /// their new places.
    ///
    /// SPEC_STORAGE.md, «Публикация сверяет план, а не байты манифеста»: the
    /// card is ready with the sizes of its files whenever the watcher's own
    /// preview lands. Until 15.11.2026 the size it stamped while the pass
    /// made the tiles refused the publish of the pass («preview inputs
    /// changed while publishing»), and the card stayed `stale`.
    fn assert_an_outside_edit_that_drops_a_picture_redraws_the_card(order: WatcherPreview) {
        use crate::storage::derived_preview::fixtures::{
            drawn_tiles, picture, preview_state, Colour,
        };
        use crate::storage::derived_preview::{publish_hooks, reconcile_preview_for_slug};
        use std::sync::mpsc;
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(root.path().to_path_buf(), derived.path().to_path_buf());
        let conn = crate::storage::db::open_or_create(&vault.index_db_path()).unwrap();
        picture(&vault.root().join("red.jpg"), Colour::Red);
        picture(&vault.root().join("green.jpg"), Colour::Green);
        picture(&vault.root().join("blue.jpg"), Colour::Blue);
        let path = vault.block_path("Gallery");
        let front = "---\nsaved_at: 2026-04-22T00:00:00Z\n---\nText.\n\n";
        std::fs::write(&path, format!("{front}![[red.jpg]]\n\n![[green.jpg]]\n\n![[blue.jpg]]\n")).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        crate::storage::derived_preview::reconcile_all_previews(&conn, &vault).unwrap();

        // The watcher's preview waits for `go` and says when it is written.
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let go_rx = Mutex::new(go_rx);
        let (written_tx, written_rx) = mpsc::channel::<()>();
        let written_tx = Mutex::new(written_tx);
        preview_hooks::set(vault.root(), move |moment, _slug| match moment {
            preview_hooks::Moment::Before => {
                let _ = go_rx.lock().unwrap().recv();
            }
            preview_hooks::Moment::After => {
                let _ = written_tx.lock().unwrap().send(());
            }
        });
        let primary_size = {
            let index_path = vault.index_db_path();
            move || -> (Option<u32>, Option<u32>) {
                let raw: String = crate::storage::db::open_or_create(&index_path)
                    .unwrap()
                    .query_row(
                        "SELECT preview_manifest FROM blocks WHERE slug = 'Gallery'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let manifest: index::FeedPreviewManifest = serde_json::from_str(&raw).unwrap();
                (manifest.preview_width, manifest.preview_height)
            }
        };
        let make_the_watchers_preview = move || {
            go_tx.send(()).unwrap();
            written_rx
                .recv_timeout(Duration::from_secs(30))
                .expect("the watcher's preview of the edited card is written");
        };

        std::fs::write(&path, format!("{front}![[green.jpg]]\n\n![[blue.jpg]]\n")).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path), None).unwrap();
        assert_eq!(primary_size(), (None, None), "{order:?}: the edit gave the card a new plan");
        // The pass the watcher queues for the card (`schedule_preview_reconcile`).
        let pass = || reconcile_preview_for_slug(&conn, &vault, "Gallery");
        let published = match order {
            WatcherPreview::BeforeThePass => {
                make_the_watchers_preview();
                pass()
            }
            WatcherPreview::WhileThePassPublishes => {
                let primary_size = primary_size.clone();
                publish_hooks::before_next_publish(move |_slug| {
                    make_the_watchers_preview();
                    assert_ne!(
                        primary_size(),
                        (None, None),
                        "the watcher stamped its thumbnail's size before the pass published"
                    );
                });
                pass()
            }
            WatcherPreview::AfterThePass => {
                let published = pass();
                make_the_watchers_preview();
                published
            }
        };
        preview_hooks::clear(vault.root());

        let outcome = published
            .unwrap_or_else(|error| panic!("{order:?}: the pass refused to publish: {error:#}"))
            .expect("the card has a preview to reconcile");
        assert_eq!(
            outcome.state,
            crate::storage::derived_preview::DerivedPreviewState::Ready,
            "{order:?}"
        );
        assert_eq!(
            drawn_tiles(&conn, &vault, "Gallery"),
            [
                ("green.jpg".to_string(), Colour::Green),
                ("blue.jpg".to_string(), Colour::Blue),
            ],
            "{order:?}"
        );
        assert_eq!(preview_state(&conn, "Gallery"), "ready", "{order:?}");
        // The size the manifest holds for every picture is the size of its
        // file: the feed shapes the card from it.
        let raw: String = conn
            .query_row(
                "SELECT preview_manifest FROM blocks WHERE slug = 'Gallery'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let manifest: index::FeedPreviewManifest = serde_json::from_str(&raw).unwrap();
        let on_disk = |relative: &str| {
            let (width, height) =
                image::image_dimensions(vault.thumbs_dir().join(relative)).unwrap();
            (Some(width), Some(height))
        };
        let primary = manifest.primary_preview_path.as_deref().unwrap();
        assert_eq!(
            (manifest.preview_width, manifest.preview_height),
            on_disk(primary),
            "{order:?}: {primary}"
        );
        for tile in &manifest.tiles {
            let preview = tile.preview_path.as_deref().unwrap();
            assert_eq!(
                (tile.preview_width, tile.preview_height),
                on_disk(preview),
                "{order:?}: {preview}"
            );
        }
        let pass = crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert!(
            pass.upserted.is_empty() && pass.dependency_changed.is_empty(),
            "{order:?}: the index and the source stamp already hold the edited note: {pass:?}",
        );
    }

    #[test]
    fn an_outside_edit_that_drops_a_picture_redraws_the_card_at_once() {
        assert_an_outside_edit_that_drops_a_picture_redraws_the_card(
            WatcherPreview::WhileThePassPublishes,
        );
    }

    #[test]
    fn an_outside_edit_redraws_the_card_when_the_watchers_preview_lands_before_the_pass() {
        assert_an_outside_edit_that_drops_a_picture_redraws_the_card(WatcherPreview::BeforeThePass);
    }

    #[test]
    fn an_outside_edit_redraws_the_card_when_the_watchers_preview_lands_after_the_pass() {
        assert_an_outside_edit_that_drops_a_picture_redraws_the_card(WatcherPreview::AfterThePass);
    }

    /// Г2.3: media deleted from `Media/`: the preview of the card that showed
    /// it goes, though the media's own slug is `Media/shot`, not the card's.
    #[test]
    fn deleted_media_in_its_own_folder_removes_the_owning_cards_preview() {
        let (_dir, vault, conn, media, preview) = card_with_media_in_folders(
            "shot",
            "type: image\nfile: \"[[shot.png]]\"\n",
            "",
            "shot.png",
            b"not really a png",
        );

        std::fs::remove_file(&media).unwrap();
        let changed = handle_event(&conn, &vault, &VaultEvent::MediaDeleted(media), None).unwrap();

        assert!(changed, "the feed is not told the card lost its media");
        assert!(
            !preview.exists(),
            "the deleted media still stands for the card"
        );
    }

    /// Г2.4: a collection's document deleted outside Mine. No card row
    /// stands for it; the collection itself leaves the index once the
    /// removal timer commits the deletion, with no other event.
    #[test]
    fn a_collection_deleted_outside_leaves_the_index_when_the_timer_commits() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        let path = dir.path().join("Collections/Research.md");
        std::fs::write(
            &path,
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 0\n---\n",
        )
        .unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        let listed = |conn: &Connection| {
            index::list_channels(conn)
                .unwrap()
                .into_iter()
                .map(|channel| channel.tag)
                .collect::<Vec<_>>()
        };
        assert_eq!(listed(&conn), vec!["Research".to_string()]);

        std::fs::remove_file(&path).unwrap();
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
        assert!(run_removal_timer_once(&conn, &vault));

        assert!(
            listed(&conn).is_empty(),
            "the deleted collection is still listed"
        );
        let source_state: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_index_state WHERE slug = ?1",
                ["Collections/Research"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_state, 0);
    }

    #[test]
    fn shared_upgrade_planner_reads_indexed_wikilink_image() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());

        let image_name = "Title (image 1).jpg";
        std::fs::write(vault.root().join(image_name), b"fake image bytes").unwrap();
        write_md_file_with_body(
            &vault,
            "Human Readable Title",
            "article",
            &[],
            "![[Title (image 1).jpg]]",
        );

        let path = vault.block_path("Human Readable Title");
        let (slug, content) = files::read_block_file(&vault, &path).unwrap();
        let block = parse_block(&slug, &content).unwrap();

        let media_urls = serde_json::to_string(&vec![image_name]).unwrap();
        let media = resolve_upgrade_media(
            &vault,
            PreviewUpgradeInput {
                slug: &block.slug,
                media_file: block.frontmatter.file.as_deref(),
                thumbnail: block.frontmatter.thumbnail.as_deref(),
                media_urls: Some(&media_urls),
                first_image: Some(image_name),
                preview_manifest: None,
            },
        )
        .unwrap();
        assert_eq!(media.kind.as_str(), "image");
        assert_eq!(media.path, vault.root().join(image_name));
    }

    #[test]
    fn shared_upgrade_planner_preserves_video_first_index_order() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());

        std::fs::write(vault.root().join("clip.mp4"), b"fake mp4").unwrap();
        std::fs::write(vault.root().join("later.jpg"), b"fake image bytes").unwrap();
        write_md_file_with_body(
            &vault,
            "Video First",
            "article",
            &[],
            "![[clip.mp4]]\n\n![[later.jpg]]",
        );

        let path = vault.block_path("Video First");
        let (slug, content) = files::read_block_file(&vault, &path).unwrap();
        let block = parse_block(&slug, &content).unwrap();

        let media_urls = serde_json::to_string(&vec!["clip.mp4", "later.jpg"]).unwrap();
        let media = resolve_upgrade_media(
            &vault,
            PreviewUpgradeInput {
                slug: &block.slug,
                media_file: block.frontmatter.file.as_deref(),
                thumbnail: block.frontmatter.thumbnail.as_deref(),
                media_urls: Some(&media_urls),
                first_image: Some("later.jpg"),
                preview_manifest: None,
            },
        )
        .unwrap();
        assert_eq!(media.kind.as_str(), "video");
        assert_eq!(media.path, vault.root().join("clip.mp4"));
    }

    // ── helpers ──────────────────────────────────────────────────────────

    #[test]
    fn path_to_slug_extracts_stem() {
        let vault = VaultLayout::new(PathBuf::from("/vault"));
        assert_eq!(
            path_to_slug(&vault, Path::new("/vault/sunset-tokyo.md")),
            Some("sunset-tokyo".to_string())
        );
        assert_eq!(
            path_to_slug(&vault, Path::new("/vault/photo.jpg")),
            Some("photo".to_string())
        );
        assert_eq!(
            path_to_slug(&vault, Path::new("/vault/folder/note.md")),
            Some("folder/note".to_string())
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
