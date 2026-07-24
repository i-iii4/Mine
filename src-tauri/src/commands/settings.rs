//! Settings window commands: window lifecycle, known-spaces list management
//! and orphan-media maintenance (SPEC_SETTINGS_WINDOW.md).
//!
//! Orphan = a top-level vault file with a media extension that no block
//! references through any media-accounting path (frontmatter file/thumbnail
//! or inline body links) — the same `MediaResolver` walk the delete plan uses.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use unicode_normalization::UnicodeNormalization;

use crate::commands::blocks::{collect_delete_media_for_block, resolve_unique_block_slug};
use crate::commands::state::{AppState, CommandError, VaultState};
use crate::commands::vault::{derived_store_root, load_config, write_config};
use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
use crate::domain::vault::VaultLayout;
use crate::storage::{files, index, media_refs, preview_plan, thumbnails};

const SETTINGS_WINDOW_LABEL: &str = "settings";

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), CommandError> {
    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        &app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("settings.html".into()),
    )
    .title("Settings")
    .inner_size(760.0, 560.0)
    .min_inner_size(640.0, 460.0)
    .resizable(true);

    // Chrome is consistent with the main window: overlay title bar, hidden
    // native title, our own h-8 drag bar drawn by the settings frontend.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    builder
        .build()
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    Ok(())
}

// ─── Spaces ─────────────────────────────────────────────────────────────────

fn known_vaults_from_config(cfg: &serde_json::Value) -> Vec<String> {
    cfg.get("known_vaults")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Add a space to the known list without switching the active one.
#[tauri::command]
pub fn add_known_vault(app: AppHandle, path: String) -> Result<Vec<String>, CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CommandError::Internal("space path is empty".into()));
    }
    if !Path::new(trimmed).is_dir() {
        return Err(CommandError::Internal(format!(
            "not a directory: {trimmed}"
        )));
    }

    let mut cfg = load_config(&app);
    let mut known = known_vaults_from_config(&cfg);
    if !known.iter().any(|existing| existing == trimmed) {
        known.push(trimmed.to_string());
        cfg["known_vaults"] = serde_json::json!(known);
        write_config(&app, &cfg);
    }
    Ok(known_vaults_from_config(&load_config(&app)))
}

/// Forget a space from the known list; data on disk is never touched (detach
/// semantics). While other spaces exist the active one cannot be forgotten —
/// the UI switches to the next space first, so config never points outside
/// the known list. The sole remaining space may be forgotten: the app keeps
/// running on it, only the list entry disappears.
#[tauri::command]
pub fn forget_known_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, CommandError> {
    let active = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        vault_state
            .as_ref()
            .map(|vs| vs.vault.root().to_string_lossy().to_string())
    };
    let mut cfg = load_config(&app);
    let current = known_vaults_from_config(&cfg);
    if active.as_deref() == Some(path.as_str()) && current.iter().any(|existing| existing != &path)
    {
        return Err(CommandError::Internal(
            "cannot forget the active space while others exist — switch space first".into(),
        ));
    }

    let known: Vec<String> = current
        .into_iter()
        .filter(|existing| existing != &path)
        .collect();
    cfg["known_vaults"] = serde_json::json!(known);
    write_config(&app, &cfg);
    Ok(known)
}

/// Pure reorder rule: the new order must be exactly the same set of paths the
/// config already knows — nothing added, nothing lost, no duplicates.
fn reordered_known_vaults(
    current: &[String],
    proposed: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    let current_set: BTreeSet<&str> = current.iter().map(String::as_str).collect();
    let proposed_set: BTreeSet<&str> = proposed.iter().map(String::as_str).collect();
    if proposed.len() != current.len() || current_set != proposed_set {
        return Err(CommandError::Internal(
            "reorder must contain exactly the known spaces".into(),
        ));
    }
    Ok(proposed)
}

/// Persist a new order of the known spaces. The config array order is the
/// canonical order everywhere (settings list, main-window switcher).
#[tauri::command]
pub fn reorder_known_vaults(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    let mut cfg = load_config(&app);
    let known = reordered_known_vaults(&known_vaults_from_config(&cfg), paths)?;
    cfg["known_vaults"] = serde_json::json!(known);
    write_config(&app, &cfg);
    Ok(known)
}

// ─── Space stats ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SpaceStats {
    pub file_count: u64,
    pub markdown_count: u64,
    pub media_count: u64,
    pub total_bytes: u64,
    /// From the space's local derived index; `None` when the space has never
    /// been opened (no vault-id / no index) or the index predates `card_kind`.
    pub element_count: Option<u64>,
}

/// Stat-only top-level scan: counts and sizes come from directory metadata,
/// file contents are never read — an iCloud vault with dataless files must
/// not be forced to download anything (SPEC_SETTINGS_WINDOW.md Р-3/Р-8).
pub(crate) fn scan_space_files(root: &Path) -> Result<SpaceStats, CommandError> {
    let mut stats = SpaceStats {
        file_count: 0,
        markdown_count: 0,
        media_count: 0,
        total_bytes: 0,
        element_count: None,
    };
    let entries = std::fs::read_dir(root).map_err(|e| CommandError::Internal(e.to_string()))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        stats.file_count += 1;
        if ext == "md" {
            stats.markdown_count += 1;
        } else if is_media_ext(&ext) {
            stats.media_count += 1;
        }
        stats.total_bytes += entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
    }
    Ok(stats)
}

/// Element count from a space's local index, opened read-only. Channels are
/// excluded (`card_kind != 'channel'` — the same predicate the grid uses).
/// Any failure (missing file, legacy schema) degrades to `None`.
pub(crate) fn read_indexed_element_count(index_db: &Path) -> Option<u64> {
    if !index_db.is_file() {
        return None;
    }
    let conn =
        rusqlite::Connection::open_with_flags(index_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    conn.query_row(
        "SELECT count(*) FROM blocks WHERE card_kind != 'channel'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .map(|n| u64::try_from(n).unwrap_or(0))
}

/// A path is a valid stats target only when the config already knows it —
/// the webview must not be able to scan arbitrary directories over IPC.
fn is_known_space(cfg: &serde_json::Value, path: &str) -> bool {
    known_vaults_from_config(cfg)
        .iter()
        .any(|known| known == path)
        || cfg.get("vault_path").and_then(|v| v.as_str()) == Some(path)
}

/// Read the space's vault-id without creating one (stats must not mutate a
/// space that was never opened).
fn existing_vault_id(root: &Path) -> Option<String> {
    for metadata_dir in [".mine", ".arena"] {
        let Ok(raw) = std::fs::read_to_string(root.join(metadata_dir).join("vault-id")) else {
            continue;
        };
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[tauri::command]
pub fn space_stats(app: AppHandle, path: String) -> Result<SpaceStats, CommandError> {
    let cfg = load_config(&app);
    if !is_known_space(&cfg, &path) {
        return Err(CommandError::Internal(format!("not a known space: {path}")));
    }

    let root = Path::new(&path);
    let mut stats = scan_space_files(root)?;
    stats.element_count = existing_vault_id(root)
        .and_then(|vault_id| derived_store_root(&app, &vault_id).ok())
        .map(|derived| VaultLayout::with_derived_root(root.to_path_buf(), derived).index_db_path())
        .and_then(|index_db| read_indexed_element_count(&index_db));
    Ok(stats)
}

// ─── Orphan media ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct OrphanMedia {
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_secs: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PromoteOrphanResult {
    pub created: Vec<index::IndexedBlock>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DeleteOrphanResult {
    pub deleted: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct OrphanMediaBatchRequest {
    pub file_names: Vec<String>,
}

fn nfc(value: &str) -> String {
    value.nfc().collect()
}

/// One pass over every indexed block: the set of media file names any block
/// references (frontmatter file/thumbnail + inline body links).
fn referenced_media_file_names(vs: &VaultState) -> Result<BTreeSet<String>, CommandError> {
    let mut resolver = media_refs::MediaResolver::new(&vs.vault);
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    let blocks = index::list_blocks(&vs.conn).map_err(|e| CommandError::Internal(e.to_string()))?;
    for block in blocks {
        for media in collect_delete_media_for_block(&vs.vault, &block, &mut resolver).values() {
            referenced.insert(nfc(&media.file_name));
        }
    }
    Ok(referenced)
}

fn is_media_ext(ext: &str) -> bool {
    preview_plan::is_image_ext(ext) || preview_plan::is_video_ext(ext)
}

fn scan_orphans(vs: &VaultState) -> Result<Vec<OrphanMedia>, CommandError> {
    let referenced = referenced_media_file_names(vs)?;

    let mut orphans = Vec::new();
    let entries =
        std::fs::read_dir(vs.vault.root()).map_err(|e| CommandError::Internal(e.to_string()))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !is_media_ext(&ext) {
            continue;
        }
        if referenced.contains(&nfc(&file_name)) {
            continue;
        }
        let metadata = entry.metadata().ok();
        orphans.push(OrphanMedia {
            size_bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_secs: metadata
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            file_name,
        });
    }
    orphans.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(orphans)
}

#[tauri::command]
pub fn list_orphan_media(state: State<'_, AppState>) -> Result<Vec<OrphanMedia>, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    scan_orphans(vs)
}

/// A safe orphan operand: a plain top-level file name, currently an orphan.
fn validate_orphan_operand(
    file_name: &str,
    referenced: &BTreeSet<String>,
    vault_root: &Path,
) -> bool {
    if file_name.is_empty()
        || file_name.starts_with('.')
        || file_name.contains('/')
        || file_name.contains('\\')
    {
        return false;
    }
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_media_ext(&ext) {
        return false;
    }
    if referenced.contains(&nfc(file_name)) {
        return false;
    }
    vault_root.join(file_name).is_file()
}

fn block_type_for_ext(ext: &str) -> BlockType {
    if preview_plan::is_image_ext(ext) {
        BlockType::Image
    } else if preview_plan::is_video_ext(ext) {
        BlockType::Video
    } else {
        BlockType::File
    }
}

pub(crate) fn promote_orphan_media_inner(
    vs: &VaultState,
    file_names: Vec<String>,
) -> Result<PromoteOrphanResult, CommandError> {
    let referenced = referenced_media_file_names(vs)?;
    let mut created = Vec::new();
    let mut skipped = Vec::new();

    for file_name in file_names {
        if !validate_orphan_operand(&file_name, &referenced, vs.vault.root()) {
            skipped.push(file_name);
            continue;
        }

        let ext = Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let stem = Path::new(&file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file_name)
            .trim()
            .to_string();

        // The media file already lives in the vault: the markdown is created
        // next to it without copying anything. Only the .md slug needs the
        // identity collision rules.
        let slug = match resolve_unique_block_slug(&vs.conn, &vs.vault, &stem, None) {
            Ok(slug) => slug,
            Err(error) => {
                log::warn!("promote_orphan_media: slug for '{file_name}' failed: {error}");
                skipped.push(file_name);
                continue;
            }
        };

        let now = crate::commands::state::now_iso8601();
        let saved_at = match DateTime::new(&now) {
            Ok(dt) => dt,
            Err(error) => return Err(CommandError::Internal(error.to_string())),
        };
        let block = Block {
            slug: slug.clone(),
            frontmatter: Frontmatter {
                block_type: block_type_for_ext(&ext),
                title: None,
                description: None,
                url: None,
                file: Some(file_name.clone()),
                thumbnail: None,
                tags: Vec::new(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at,
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: String::new(),
        };

        match files::persist_new_block(&vs.conn, &vs.vault, &block, None) {
            Ok(indexed) => {
                // Best-effort sidebar thumb for images; video posters are
                // produced by the regular thumbnail sweep.
                if preview_plan::is_image_ext(&ext) {
                    let media_path = vs.vault.root().join(&file_name);
                    let thumb_path = vs.vault.thumb_path(&slug);
                    let _ = thumbnails::generate_thumbnail(
                        &media_path,
                        &thumb_path,
                        thumbnails::DEFAULT_MAX_SIZE,
                    );
                    let _ = index::sync_thumb_metadata(
                        &vs.conn,
                        &slug,
                        &thumb_path,
                        Some(vs.vault.root()),
                    );
                }
                created.push(indexed);
            }
            Err(error) => {
                log::warn!("promote_orphan_media: persist '{file_name}' failed: {error}");
                skipped.push(file_name);
            }
        }
    }

    Ok(PromoteOrphanResult { created, skipped })
}

#[tauri::command]
pub fn promote_orphan_media(
    state: State<'_, AppState>,
    request: OrphanMediaBatchRequest,
) -> Result<PromoteOrphanResult, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    promote_orphan_media_inner(vs, request.file_names)
}

pub(crate) fn delete_orphan_media_inner(
    vs: &VaultState,
    file_names: Vec<String>,
) -> Result<DeleteOrphanResult, CommandError> {
    let referenced = referenced_media_file_names(vs)?;
    let mut deleted = Vec::new();
    let mut skipped = Vec::new();

    for file_name in file_names {
        if !validate_orphan_operand(&file_name, &referenced, vs.vault.root()) {
            skipped.push(file_name);
            continue;
        }
        let path = vs.vault.root().join(&file_name);
        match files::delete_user_file(&path) {
            Ok(()) => deleted.push(file_name),
            Err(error) => {
                log::warn!("delete_orphan_media: '{file_name}' failed: {error}");
                skipped.push(file_name);
            }
        }
    }

    Ok(DeleteOrphanResult { deleted, skipped })
}

#[tauri::command]
pub fn delete_orphan_media(
    state: State<'_, AppState>,
    request: OrphanMediaBatchRequest,
) -> Result<DeleteOrphanResult, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    delete_orphan_media_inner(vs, request.file_names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::parse_block;
    use crate::storage::db;

    fn make_vault() -> (tempfile::TempDir, tempfile::TempDir, VaultState) {
        let root = tempfile::tempdir().expect("tempdir");
        let derived = tempfile::tempdir().expect("derived tempdir");
        let vault =
            VaultLayout::with_derived_root(root.path().to_path_buf(), derived.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).expect("open db");
        (root, derived, VaultState { vault, conn })
    }

    fn write_media(vs: &VaultState, name: &str) {
        std::fs::write(vs.vault.root().join(name), b"fake-bytes").expect("write media");
    }

    fn index_markdown(vs: &VaultState, slug: &str, md: &str) {
        std::fs::write(vs.vault.block_path(slug), md).expect("write block");
        let block = parse_block(slug, md).expect("parse block");
        index::upsert_block(&vs.conn, &block, Some(vs.vault.root())).expect("index block");
    }

    fn write_block_with_media(vs: &VaultState, slug: &str, media: &str) {
        let md = format!("---\ntype: image\nfile: {media}\nsaved_at: 2026-01-01T00:00:00Z\n---\n",);
        index_markdown(vs, slug, &md);
    }

    #[test]
    fn orphan_scan_finds_unreferenced_media_only() {
        let (_root, _derived, vs) = make_vault();
        write_media(&vs, "lonely.jpg");
        write_media(&vs, "used.jpg");
        write_media(&vs, "note.txt");
        write_block_with_media(&vs, "owner", "used.jpg");

        let orphans = scan_orphans(&vs).expect("scan");
        let names: Vec<_> = orphans.iter().map(|o| o.file_name.as_str()).collect();
        assert_eq!(names, vec!["lonely.jpg"]);
    }

    #[test]
    fn inline_wikilink_reference_is_not_an_orphan() {
        let (_root, _derived, vs) = make_vault();
        write_media(&vs, "inline.png");
        let md =
            "---\ntype: article\nsaved_at: 2026-01-01T00:00:00Z\n---\nText ![[inline.png]] more";
        index_markdown(&vs, "note", md);

        let orphans = scan_orphans(&vs).expect("scan");
        assert!(
            orphans.is_empty(),
            "inline-referenced media must not be orphan"
        );
    }

    #[test]
    fn promote_creates_markdown_next_to_media_without_copying() {
        let (_root, _derived, vs) = make_vault();
        write_media(&vs, "photo.jpg");

        let result = promote_orphan_media_inner(&vs, vec!["photo.jpg".into()]).expect("promote");
        assert_eq!(result.created.len(), 1);
        assert!(result.skipped.is_empty());
        let created = &result.created[0];
        assert_eq!(created.slug, "photo");
        assert_eq!(created.media_file.as_deref(), Some("photo.jpg"));
        assert!(vs.vault.block_path("photo").exists());
        // The media file stayed in place, no duplicate appeared.
        assert!(vs.vault.root().join("photo.jpg").exists());
        let media_like: Vec<_> = std::fs::read_dir(vs.vault.root())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".jpg")
            })
            .collect();
        assert_eq!(media_like.len(), 1);

        // Re-promoting the same file: no longer an orphan → skipped.
        let again =
            promote_orphan_media_inner(&vs, vec!["photo.jpg".into()]).expect("promote again");
        assert!(again.created.is_empty());
        assert_eq!(again.skipped, vec!["photo.jpg".to_string()]);
    }

    #[test]
    fn promote_resolves_md_slug_collision_with_suffix() {
        let (_root, _derived, vs) = make_vault();
        write_media(&vs, "clip.mp4");
        // Occupy the natural slug with an unrelated note.
        std::fs::write(
            vs.vault.block_path("clip"),
            "---\ntype: article\nsaved_at: 2026-01-01T00:00:00Z\n---\nbody",
        )
        .expect("write");

        let result = promote_orphan_media_inner(&vs, vec!["clip.mp4".into()]).expect("promote");
        assert_eq!(result.created.len(), 1);
        let created = &result.created[0];
        assert_ne!(created.slug, "clip");
        assert!(created.slug.starts_with("clip"));
        assert_eq!(created.media_file.as_deref(), Some("clip.mp4"));
        assert_eq!(created.block_type, BlockType::Video);
    }

    #[test]
    fn delete_orphan_skips_referenced_and_path_traversal() {
        let (_root, _derived, vs) = make_vault();
        write_media(&vs, "keep.jpg");
        write_media(&vs, "gone.jpg");
        write_block_with_media(&vs, "owner", "keep.jpg");

        let result = delete_orphan_media_inner(
            &vs,
            vec!["keep.jpg".into(), "gone.jpg".into(), "../escape.jpg".into()],
        )
        .expect("delete");

        assert_eq!(result.deleted, vec!["gone.jpg".to_string()]);
        assert_eq!(
            result.skipped,
            vec!["keep.jpg".to_string(), "../escape.jpg".to_string()]
        );
        assert!(vs.vault.root().join("keep.jpg").exists());
        assert!(!vs.vault.root().join("gone.jpg").exists());
    }

    #[test]
    fn space_scan_counts_top_level_files_by_kind() {
        let (root, _derived, _vs) = make_vault();
        std::fs::write(root.path().join("note.md"), b"12345").unwrap();
        std::fs::write(root.path().join("photo.jpg"), b"123").unwrap();
        std::fs::write(root.path().join("clip.mp4"), b"1234").unwrap();
        std::fs::write(root.path().join("misc.txt"), b"12").unwrap();
        std::fs::write(root.path().join(".DS_Store"), b"x").unwrap();
        std::fs::create_dir(root.path().join("subdir")).unwrap();
        std::fs::write(root.path().join("subdir").join("inner.md"), b"y").unwrap();

        let stats = scan_space_files(root.path()).expect("scan");
        // Hidden files, directories and their contents are not counted.
        assert_eq!(stats.file_count, 4);
        assert_eq!(stats.markdown_count, 1);
        assert_eq!(stats.media_count, 2);
        assert_eq!(stats.total_bytes, 5 + 3 + 4 + 2);
        assert_eq!(stats.element_count, None);
    }

    #[test]
    fn indexed_element_count_excludes_channels_and_degrades_to_none() {
        let (_root, derived, vs) = make_vault();
        index_markdown(
            &vs,
            "first",
            "---\ntype: article\nsaved_at: 2026-01-01T00:00:00Z\n---\nBody",
        );
        index_markdown(
            &vs,
            "second",
            "---\ntype: article\nsaved_at: 2026-01-02T00:00:00Z\n---\nBody",
        );
        index_markdown(
            &vs,
            "collection",
            "---\ntype: channel\nsaved_at: 2026-01-03T00:00:00Z\n---\n",
        );

        let index_db = vs.vault.index_db_path();
        assert_eq!(read_indexed_element_count(&index_db), Some(2));

        // Missing index → None, not an error.
        let missing = derived.path().join("nope").join("index.db");
        assert_eq!(read_indexed_element_count(&missing), None);

        // A non-SQLite file degrades to None as well.
        let garbage = derived.path().join("garbage.db");
        std::fs::write(&garbage, b"not a database").unwrap();
        assert_eq!(read_indexed_element_count(&garbage), None);
    }

    #[test]
    fn reorder_accepts_only_a_permutation_of_known_spaces() {
        let current = vec!["/a".to_string(), "/b".to_string(), "/c".to_string()];

        let ok = reordered_known_vaults(&current, vec!["/c".into(), "/a".into(), "/b".into()])
            .expect("permutation accepted");
        assert_eq!(ok, vec!["/c", "/a", "/b"]);

        // Dropping, adding, or duplicating paths is rejected.
        assert!(reordered_known_vaults(&current, vec!["/a".into(), "/b".into()]).is_err());
        assert!(reordered_known_vaults(
            &current,
            vec!["/a".into(), "/b".into(), "/c".into(), "/d".into()],
        )
        .is_err());
        assert!(
            reordered_known_vaults(&current, vec!["/a".into(), "/a".into(), "/c".into()],).is_err()
        );
    }

    #[test]
    fn space_stats_path_must_be_known_to_config() {
        let cfg = serde_json::json!({
            "vault_path": "/spaces/active",
            "known_vaults": ["/spaces/active", "/spaces/archive"],
        });
        assert!(is_known_space(&cfg, "/spaces/active"));
        assert!(is_known_space(&cfg, "/spaces/archive"));
        assert!(!is_known_space(&cfg, "/spaces/unknown"));
        assert!(!is_known_space(&cfg, "/etc"));

        // Legacy config without known_vaults still allows the active path.
        let legacy = serde_json::json!({ "vault_path": "/spaces/active" });
        assert!(is_known_space(&legacy, "/spaces/active"));
        assert!(!is_known_space(&legacy, "/spaces/other"));
    }
}
