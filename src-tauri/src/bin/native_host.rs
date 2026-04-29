// Native messaging host for the Mine web clipper browser extension.
//
// Communicates with the browser extension via stdin/stdout using the
// Chrome native messaging protocol: 4-byte little-endian length header + JSON.
//
// Reads vault path from the main app's config, then handles requests:
// - get_status: check if vault is configured
// - list_channels: return channels from SQLite index
// - save_block: create a new block in the vault
// - create_channel: create a new channel
//
// Contract: SPEC_CLIPPER.md

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mine_lib::domain::block::{Block, BlockType, DateTime, Frontmatter};
use mine_lib::domain::channel::Channel;
use mine_lib::domain::collection::normalize_collection_ref;
use mine_lib::domain::vault::{resolve_slug_conflict, VaultLayout};
use mine_lib::storage::{db, files, index, thumbnails};
use mine_lib::util::now_iso8601;
use percent_encoding::percent_decode_str;

const VERSION: &str = env!("CARGO_PKG_VERSION");

// ─── Message types ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct Request {
    action: String,
    vault_path: Option<String>,
    #[serde(flatten)]
    params: serde_json::Value,
}

#[derive(serde::Serialize)]
struct StatusResponse {
    ok: bool,
    vault_path: Option<String>,
    version: String,
    upload_port: Option<u16>,
    upload_token: Option<String>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
struct ChannelInfo {
    tag: String,
    title: String,
    block_count: usize,
}

#[derive(serde::Serialize)]
struct ChannelsResponse {
    ok: bool,
    channels: Vec<ChannelInfo>,
}

#[derive(serde::Serialize)]
struct SaveResponse {
    ok: bool,
    slug: String,
    block_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(serde::Serialize)]
struct CreateChannelResponse {
    ok: bool,
    tag: String,
}

#[derive(serde::Serialize)]
struct ErrorResponse {
    ok: bool,
    error: String,
}

#[derive(serde::Deserialize)]
struct SaveBlockParams {
    block_type: String,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    image_url: Option<String>,
    /// File already uploaded via HTTP /upload endpoint
    pre_uploaded_file: Option<String>,
    author: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(serde::Deserialize)]
struct CreateChannelParams {
    tag: String,
    title: Option<String>,
}

// ─── Native messaging I/O ───────────────────────────────────────────────────

/// Read a native message from stdin: 4-byte LE length + JSON bytes.
fn read_message() -> io::Result<Option<String>> {
    let mut len_buf = [0u8; 4];
    match io::stdin().read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > 10 * 1024 * 1024 {
        return Ok(None);
    }
    let mut buf = vec![0u8; len];
    io::stdin().read_exact(&mut buf)?;
    Ok(Some(String::from_utf8_lossy(&buf).to_string()))
}

/// Write a native message to stdout: 4-byte LE length + JSON bytes.
fn write_message(json: &str) -> io::Result<()> {
    let bytes = json.as_bytes();
    let len = (bytes.len() as u32).to_le_bytes();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    out.write_all(&len)?;
    out.write_all(bytes)?;
    out.flush()
}

fn send_response<T: serde::Serialize>(resp: &T) {
    let json = serde_json::to_string(resp)
        .unwrap_or_else(|_| r#"{"ok":false,"error":"serialization failed"}"#.to_string());
    let _ = write_message(&json);
}

fn send_error(msg: &str) {
    send_response(&ErrorResponse {
        ok: false,
        error: msg.to_string(),
    });
}

// ─── Vault path discovery ───────────────────────────────────────────────────

const DEFAULT_VAULT_DIR: &str = "Mine";

/// Read vault path from the main app's config file.
/// Location: ~/Library/Application Support/com.mine.app/config.json
///
/// Fallback: if config doesn't exist (standalone mode — no desktop app),
/// uses ~/LocalArena/ and creates the directory if needed.
fn load_vault_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;

    // Try config from desktop app first
    let config_path =
        PathBuf::from(&home).join("Library/Application Support/com.mine.app/config.json");
    if let Ok(data) = std::fs::read_to_string(&config_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(path) = json.get("vault_path").and_then(|v| v.as_str()) {
                return Some(path.to_string());
            }
        }
    }

    // Fallback: ~/LocalArena/ (standalone mode)
    let default_path = PathBuf::from(&home).join(DEFAULT_VAULT_DIR);
    let _ = std::fs::create_dir_all(&default_path);
    Some(default_path.to_string_lossy().to_string())
}

/// Load known vaults from config, filter to existing directories.
fn load_known_vaults() -> Vec<String> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let config_path =
        PathBuf::from(&home).join("Library/Application Support/com.mine.app/config.json");
    let data = match std::fs::read_to_string(&config_path) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let json: serde_json::Value = match serde_json::from_str(&data) {
        Ok(j) => j,
        Err(_) => return vec![],
    };
    match json.get("known_vaults").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|p| PathBuf::from(p).is_dir())
            .collect(),
        None => {
            // Fallback: use vault_path if no known_vaults
            json.get("vault_path")
                .and_then(|v| v.as_str())
                .filter(|p| PathBuf::from(p).is_dir())
                .map(|s| vec![s.to_string()])
                .unwrap_or_default()
        }
    }
}

fn resolve_native_vault_layout(root: PathBuf) -> Result<VaultLayout, String> {
    let base = VaultLayout::new(root.clone());
    std::fs::create_dir_all(base.arena_dir())
        .map_err(|e| format!("failed to create arena dir: {e}"))?;

    let vault_id = ensure_native_vault_id(&base)?;
    let derived_root = native_app_data_dir()?.join("vaults").join(vault_id);
    let layout = VaultLayout::with_derived_root(root, derived_root);

    bootstrap_native_index_from_legacy(&layout)?;
    Ok(layout)
}

fn native_app_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.mine.app"))
}

fn ensure_native_vault_id(vault: &VaultLayout) -> Result<String, String> {
    let path = vault.vault_id_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let new_id = generate_native_vault_id()?;
    std::fs::write(&path, format!("{new_id}\n"))
        .map_err(|e| format!("failed to write vault-id: {e}"))?;
    Ok(new_id)
}

fn generate_native_vault_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    match std::fs::File::open("/dev/urandom") {
        Ok(mut file) => file
            .read_exact(&mut bytes)
            .map_err(|e| format!("failed to read /dev/urandom: {e}"))?,
        Err(_) => {
            return Ok(format!(
                "{:016x}{:08x}{:08x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("system time before epoch: {e}"))?
                    .as_nanos(),
                std::process::id(),
                0x5A17_u32,
            ));
        }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15],
    ))
}

fn bootstrap_native_index_from_legacy(vault: &VaultLayout) -> Result<(), String> {
    let target = vault.index_db_path();
    if target.exists() {
        return Ok(());
    }

    let source = vault.legacy_index_db_path();
    if !source.exists() {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create local derived dir: {e}"))?;
    }
    std::fs::copy(&source, &target)
        .map_err(|e| format!("failed to bootstrap local index from legacy: {e}"))?;
    Ok(())
}

// ─── Action handlers ────────────────────────────────────────────────────────

fn handle_list_known_vaults() {
    #[derive(serde::Serialize)]
    struct KnownVaultsResponse {
        ok: bool,
        vaults: Vec<String>,
        current: Option<String>,
    }
    let vaults = load_known_vaults();
    let current = load_vault_path();
    send_response(&KnownVaultsResponse {
        ok: true,
        vaults,
        current,
    });
}

fn handle_get_status_with_upload(upload: &Option<UploadServer>) {
    let vault_path = load_vault_path();
    let ok = vault_path.is_some();
    send_response(&StatusResponse {
        ok,
        vault_path,
        version: VERSION.to_string(),
        upload_port: upload.as_ref().map(|u| u.port),
        upload_token: upload.as_ref().map(|u| u.token.clone()),
    });
}

fn handle_list_channels(vault: &VaultLayout) {
    let conn = match db::open_or_create(&vault.index_db_path()) {
        Ok(c) => c,
        Err(e) => return send_error(&format!("failed to open database: {e}")),
    };

    // Get all tags (every tag used by any block)
    let tags = match index::get_all_tags(&conn) {
        Ok(t) => t,
        Err(e) => return send_error(&format!("failed to list tags: {e}")),
    };

    // Get promoted channels. Empty promoted channels must still be visible
    // in the clipper: the user can create a channel in one tab and then
    // select it before any block has been saved into it.
    let channels = index::list_channels(&conn).unwrap_or_default();
    let channel_infos = merge_channels_and_tags(channels, tags);

    send_response(&ChannelsResponse {
        ok: true,
        channels: channel_infos,
    });
}

fn merge_channels_and_tags(channels: Vec<Channel>, tags: Vec<index::TagCount>) -> Vec<ChannelInfo> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for tag in &tags {
        let collection_ref = normalize_collection_ref(&tag.tag);
        if collection_ref.is_empty() {
            continue;
        }
        *counts.entry(collection_ref).or_insert(0) += tag.count;
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut infos = Vec::with_capacity(channels.len() + tags.len());

    for channel in channels {
        let tag = normalize_collection_ref(&channel.tag);
        if tag.is_empty() || seen.contains(&tag) {
            continue;
        }
        let block_count = counts.get(&tag).copied().unwrap_or(0);
        seen.insert(tag.clone());
        infos.push(ChannelInfo {
            tag,
            title: channel.title,
            block_count,
        });
    }

    for tag in tags {
        let collection_ref = normalize_collection_ref(&tag.tag);
        if collection_ref.is_empty() || seen.contains(&collection_ref) {
            continue;
        }
        let block_count = counts.get(&collection_ref).copied().unwrap_or(tag.count);
        infos.push(ChannelInfo {
            title: collection_ref_title(&collection_ref),
            tag: collection_ref.clone(),
            block_count,
        });
        seen.insert(collection_ref);
    }

    infos
}

fn collection_ref_title(collection_ref: &str) -> String {
    let label = collection_ref
        .split('/')
        .next_back()
        .unwrap_or(collection_ref)
        .trim();
    let mut chars = label.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let upper: String = first.to_uppercase().collect();
            upper + chars.as_str()
        }
    }
}

fn handle_save_block(vault: &VaultLayout, params: serde_json::Value) {
    let p: SaveBlockParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(&format!("invalid save_block params: {e}")),
    };

    let bt = match BlockType::from_str(&p.block_type) {
        Ok(bt) => bt,
        Err(e) => return send_error(&format!("invalid block type: {e}")),
    };

    let conn = match db::open_or_create(&vault.index_db_path()) {
        Ok(c) => c,
        Err(e) => return send_error(&format!("failed to open database: {e}")),
    };

    // Generate slug
    let raw_slug = mine_lib::domain::block::suggest_slug(p.title.as_deref(), p.url.as_deref());
    let existing: HashSet<String> = index::list_blocks(&conn)
        .unwrap_or_default()
        .iter()
        .map(|b| b.slug.clone())
        .collect();
    let slug = match resolve_slug_conflict(&raw_slug, &existing) {
        Ok(s) => s,
        Err(e) => return send_error(&format!("{e}")),
    };

    // Resolve media: pre-uploaded file, data URL, or HTTP download
    let mut media_file = None;
    let mut thumbnail_file = None;
    let mut warning = None;

    if let Some(ref uploaded) = p.pre_uploaded_file {
        // File already uploaded via HTTP /upload endpoint.
        // Phase 18.E: backend is authoritative for the final media filename.
        // The uploaded file may have arrived under any popup-chosen staging
        // name (e.g. `screenshot.jpg`, `upload.mp4`). We rename it to
        // `<slug>.<ext>` here so that the media file basename always matches
        // the resolved block slug — consistent with screenshot and HTTP
        // download paths below.
        match finalize_uploaded_filename(vault.root(), uploaded, &slug) {
            Ok(final_name) => {
                media_file = Some(final_name);
            }
            Err(e) => {
                warning = Some(e);
            }
        }
    } else if let Some(ref image_url) = p.image_url {
        if image_url.starts_with("data:") {
            // Data URL (screenshot) — decode base64 and write directly
            match decode_data_url(image_url) {
                Ok((bytes, ext)) => {
                    let dest_name = format!("{}.{}", slug, ext);
                    let dest_path = vault.root().join(&dest_name);
                    match std::fs::write(&dest_path, &bytes) {
                        Ok(()) => {
                            media_file = Some(dest_name);
                        }
                        Err(e) => warning = Some(format!("failed to write screenshot: {e}")),
                    }
                }
                Err(e) => warning = Some(format!("failed to decode data URL: {e}")),
            }
        } else {
            // HTTP URL — download file
            let ext = ext_from_url(image_url);
            let dest_name = format!("{}.{}", slug, ext);
            let dest_path = vault.root().join(&dest_name);

            let referer = p.url.as_deref().unwrap_or(image_url);
            match download_file(image_url, &dest_path, referer) {
                Ok(()) => {
                    if bt == BlockType::Video && thumbnails::is_image_ext(&ext) {
                        thumbnail_file = Some(dest_name);
                    } else {
                        media_file = Some(dest_name);
                    }
                }
                Err(e) => {
                    warning = Some(format!("failed to download media: {e}"));
                }
            }
        }
    }

    // Download inline images (and videos) for article bodies
    let body = {
        let mut raw = p.body.unwrap_or_default();

        // For Twitter: fetch video MP4 URLs via syndication API.
        // Insert after the first tweet's text (before first "---"), not at end.
        // Content script can't call syndication API (CORS), so backend handles it.
        if bt == BlockType::Article {
            if let Some(ref url) = p.url {
                if let Some(tweet_id) = extract_twitter_video_id(url) {
                    if let Ok(video_urls) = fetch_tweet_videos(&tweet_id) {
                        for video_url in &video_urls {
                            if raw.contains(video_url.as_str()) {
                                continue; // already present
                            }
                            // Insert after first tweet text, before first ---
                            let insert_pos = raw.find("\n\n---\n").unwrap_or(raw.len());
                            let markup = format!("\n\n![]({})", video_url);
                            raw.insert_str(insert_pos, &markup);
                        }
                    }
                }
            }
        }

        if bt == BlockType::Article && !raw.is_empty() {
            let page_url = p.url.as_deref().unwrap_or("");
            localize_body_images(&raw, vault, &slug, page_url)
        } else {
            raw
        }
    };

    let now = now_iso8601();
    let saved_at = match DateTime::new(&now) {
        Ok(dt) => dt,
        Err(e) => return send_error(&format!("failed to create timestamp: {e}")),
    };

    // Reject image blocks without a resolved media file. A prior clipper
    // bug let a user switch type-to-image after uploading a screenshot,
    // at which point the save path no longer forwarded pre_uploaded_file
    // or image_url — the native host silently wrote a frontmatter with
    // neither `file:` nor `thumbnail:`, producing an orphaned .md that
    // never rendered a card. Fail loudly here so the clipper can show
    // a retry prompt instead of persisting an inconsistent block.
    if matches!(bt, BlockType::Image) && media_file.is_none() && thumbnail_file.is_none() {
        return send_error(
            warning
                .as_deref()
                .unwrap_or("image block requires a media file or thumbnail"),
        );
    }

    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: bt,
            title: p.title,
            description: p.description,
            url: p.url,
            file: media_file,
            thumbnail: thumbnail_file,
            tags: p
                .tags
                .unwrap_or_default()
                .iter()
                .map(|t| normalize_collection_ref(t))
                .filter(|t| !t.is_empty())
                .collect(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at,
            source: Some("web-clipper".to_string()),
            width: p.width,
            height: p.height,
            author: p.author,
            position: None,
            color: None,
            icon: None,
        },
        body,
    };

    // Write .md file
    if let Err(e) = files::write_block_file(vault, &block) {
        return send_error(&format!("failed to write block file: {e}"));
    }

    // Thumbnail generation is delegated to the shared cascade in
    // storage::thumbnails::generate_for_block. Single source of truth —
    // watcher handler calls the same function at full_scan and on file
    // change. Covers: explicit media file, frontmatter thumbnail field,
    // first embedded image/video in article body, and text fallback.
    let _ = thumbnails::generate_for_block(&block, vault);

    // Do NOT upsert into the index here. The filesystem is the source
    // of truth; the watcher (when the main app is running) mirrors
    // file changes into SQLite, and full_scan covers the offline case.
    // Writing to the DB from both the native host and the watcher
    // caused write-lock contention — the user would see "failed to
    // upsert block" even though the file was written correctly.

    send_response(&SaveResponse {
        ok: true,
        slug,
        block_type: p.block_type,
        warning,
    });
}

fn handle_create_channel(vault: &VaultLayout, params: serde_json::Value) {
    let p: CreateChannelParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(&format!("invalid create_channel params: {e}")),
    };

    let conn = match db::open_or_create(&vault.index_db_path()) {
        Ok(c) => c,
        Err(e) => return send_error(&format!("failed to open database: {e}")),
    };

    let created_at = match DateTime::new(&now_iso8601()) {
        Ok(dt) => dt,
        Err(e) => return send_error(&format!("failed to create timestamp: {e}")),
    };
    let title = p.title.or_else(|| Some(title_from_raw_channel_tag(&p.tag)));

    let mut channel = match Channel::new(&p.tag, title.as_deref(), created_at) {
        Ok(channel) => channel,
        Err(e) => return send_error(&format!("invalid channel: {e}")),
    };
    channel.position = match index::next_channel_position(&conn) {
        Ok(position) => position,
        Err(e) => return send_error(&format!("failed to resolve channel position: {e}")),
    };

    let block = channel_to_block(&channel);
    if let Err(e) = files::write_block_file(vault, &block) {
        return send_error(&format!("failed to write channel file: {e}"));
    }

    if let Err(e) = index::upsert_channel(&conn, &channel) {
        return send_error(&format!("failed to create channel: {e}"));
    }

    send_response(&CreateChannelResponse {
        ok: true,
        tag: channel.tag,
    });
}

fn channel_to_block(channel: &Channel) -> Block {
    Block {
        slug: channel.tag.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Channel,
            title: Some(channel.title.clone()),
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

fn title_from_raw_channel_tag(tag: &str) -> String {
    collection_ref_title(&normalize_collection_ref(tag))
}

/// Finalize a pre-uploaded staging file by renaming it from whatever name
/// the popup used (`screenshot.jpg`, `upload.mp4`, ...) to `<final_stem>.<ext>`,
/// where `final_stem` is the resolved block slug.
///
/// Behavior:
/// - If the staging file does not exist, returns an error describing which
///   filename was missing.
/// - If `uploaded` already equals the target filename, no rename is performed.
/// - If the target filename already exists, returns an error — the caller's
///   slug-conflict resolution should have produced a unique stem, so a
///   collision here indicates an orphan media file on disk and we must not
///   overwrite it silently.
/// - Otherwise renames the file and returns the new basename.
///
/// Phase 18.E: backend is authoritative for the final media filename.
fn finalize_uploaded_filename(
    vault_root: &std::path::Path,
    uploaded: &str,
    final_stem: &str,
) -> Result<String, String> {
    let src = vault_root.join(uploaded);
    if !src.exists() {
        return Err(format!("pre-uploaded file not found: {uploaded}"));
    }

    let ext = std::path::Path::new(uploaded)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    // Deduplicate on collision. Two screenshots from the same page have
    // the same title → the same slug → the same would-be media filename.
    // Append the Obsidian-style ` (N)` suffix to the stem until the
    // target is free. Matches how `resolve_slug_conflict` treats `.md`
    // collisions in Phase 18.D so media and block filenames stay in
    // sync (e.g. the second clip becomes both `iPad mini (2).md` and
    // `iPad mini (2).jpg`). Caller is expected to pass the already
    // DB-resolved stem; this second check is for disk-only collisions
    // where the file lingered after the block row was removed.
    let build_name = |stem: &str| -> String {
        if ext.is_empty() {
            stem.to_string()
        } else {
            format!("{stem}.{ext}")
        }
    };

    let mut candidate_stem = final_stem.to_string();
    let mut candidate = build_name(&candidate_stem);
    let mut counter: u32 = 2;
    while uploaded != candidate && vault_root.join(&candidate).exists() {
        candidate_stem = format!("{final_stem} ({counter})");
        candidate = build_name(&candidate_stem);
        counter = counter
            .checked_add(1)
            .ok_or_else(|| "ran out of collision suffixes".to_string())?;
    }

    if uploaded == candidate {
        return Ok(candidate);
    }

    std::fs::rename(&src, vault_root.join(&candidate))
        .map_err(|e| format!("failed to rename staged upload to {candidate}: {e}"))?;

    Ok(candidate)
}

/// Extract file extension from URL, stripping query string and fragment.
/// Decode a data URL (e.g. `data:image/png;base64,...`) into bytes and file extension.
fn decode_data_url(data_url: &str) -> anyhow::Result<(Vec<u8>, String)> {
    use base64::Engine;
    // Format: data:image/png;base64,iVBOR...
    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| anyhow::anyhow!("not a data URL"))?;
    let (header, data) = rest
        .split_once(',')
        .ok_or_else(|| anyhow::anyhow!("malformed data URL: no comma"))?;
    // Extract MIME type → extension
    let mime = header.split(';').next().unwrap_or("image/png");
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| anyhow::anyhow!("base64 decode failed: {e}"))?;
    Ok((bytes, ext.to_string()))
}

fn ext_from_url(url: &str) -> &str {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);
    match path.rsplit('.').next() {
        Some(ext) if ext.len() <= 5 && !ext.contains('/') => ext,
        _ => "jpg",
    }
}

/// Validate that a URL is safe to fetch (http/https only, no private IPs).
fn validate_fetch_url(url: &str) -> anyhow::Result<()> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        anyhow::bail!("only http:// and https:// URLs are allowed, got: {}", url);
    }
    // Extract host: skip "http(s)://" and take until "/" or ":"
    let after_scheme = if url.starts_with("https://") {
        &url[8..]
    } else {
        &url[7..]
    };
    let host = after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let lower = host.to_lowercase();
    if lower == "localhost"
        || lower.starts_with("127.")
        || lower == "[::1]"
        || lower.starts_with("10.")
        || lower.starts_with("192.168.")
        || lower.starts_with("169.254.")
        || (lower.starts_with("172.")
            && lower
                .split('.')
                .nth(1)
                .and_then(|s| s.parse::<u8>().ok())
                .is_some_and(|n| (16..=31).contains(&n)))
    {
        anyhow::bail!("private/loopback addresses are not allowed: {}", host);
    }
    Ok(())
}

/// Per-request timeout for inline-media downloads. ureq 2.x default is
/// 30s — too long for one stuck CDN to monopolize a worker slot when
/// the parallel pool only has 3 workers serving 15+ images.
const INLINE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Download a file from URL to local path.
/// `referer` should be the page URL (not the image URL) — CDNs validate this.
/// Retries up to 3 times with backoff.
fn download_file(url: &str, dest: &std::path::Path, referer: &str) -> anyhow::Result<()> {
    validate_fetch_url(url)?;
    let mut last_err = None;
    for attempt in 0..3u64 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500 * attempt));
        }
        match ureq::get(url)
            .timeout(INLINE_REQUEST_TIMEOUT)
            .set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .set("Referer", referer)
            .set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .call()
        {
            Ok(resp) => {
                let mut reader = resp.into_reader();
                let mut file = std::fs::File::create(dest)?;
                std::io::copy(&mut reader, &mut file)?;
                return Ok(());
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap().into())
}

/// Build an Obsidian wikilink embed for a locally-downloaded media file.
///
/// Format: `![[name]]` or `![[name|alt]]` when alt text is non-empty.
///
/// Phase 18.H.1: wikilink syntax removes the body-vs-disk asymmetry that
/// the percent-encoded `![alt](url)` form introduced. `]]` is not a
/// valid filename character on any supported platform, so parsers can
/// find it unambiguously and the URL literally equals the filename.
///
/// Obsidian renders `![[file.jpg]]` as an embedded image natively, so
/// the raw markdown source stays readable when the user inspects the
/// `.md` file in Obsidian.
fn build_inline_wikilink(name: &str, alt: &str) -> String {
    // Defensive: if a filename ever contained `]]` it would confuse
    // the reader. Filesystem normally rejects this, but fall back to
    // the old encoded markdown form on the pathological case to keep
    // the output valid markdown no matter what.
    if name.contains("]]") {
        let encoded = encode_markdown_url_component(name);
        return format!("![{alt}]({encoded})");
    }

    if alt.is_empty() {
        format!("![[{name}]]")
    } else {
        // Obsidian pipe separates alt/caption from filename.
        // A literal `|` in a filename would break the split, so encode
        // it as an entity equivalent. Practically rare in filenames.
        let safe_alt = alt.replace('|', "&#124;").replace('\n', " ");
        format!("![[{name}|{safe_alt}]]")
    }
}

/// Percent-encode characters that would confuse a markdown parser's
/// inline image URL parser: space, parentheses, and the percent sign
/// itself (so it does not look like an encoding escape to humans).
///
/// Markdown readers require either balanced/escaped parens or an
/// angle-bracket-wrapped URL for paths with parens. We keep the file on
/// disk human-readable (`Title (image 1).jpg`) but write the encoded
/// form in the markdown body so `![alt](url)` parses correctly both in
/// Obsidian and in the in-app renderer.
///
/// Kept intentionally narrow: anything outside the problem set (letters,
/// digits, unicode codepoints, dots, hyphens, underscores, `/`) is not
/// encoded — encoding them would make wikilinks less readable for users
/// inspecting the markdown source directly.
fn encode_markdown_url_component(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '%' => out.push_str("%25"),
            c => out.push(c),
        }
    }
    out
}

/// Kind of inline media embedded in an article body, used to produce
/// human-readable filenames like `Название (image 1).jpg`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InlineMediaKind {
    Image,
    Video,
    File,
}

impl InlineMediaKind {
    fn label(self) -> &'static str {
        match self {
            InlineMediaKind::Image => "image",
            InlineMediaKind::Video => "video",
            InlineMediaKind::File => "file",
        }
    }
}

/// Classify an extension (lowercase, no leading dot) as image/video/other.
fn inline_media_kind_from_ext(ext: &str) -> InlineMediaKind {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "heic" | "heif" | "bmp" | "svg"
        | "tiff" | "tif" => InlineMediaKind::Image,
        "mp4" | "webm" | "m4v" | "mov" | "mkv" | "avi" => InlineMediaKind::Video,
        _ => InlineMediaKind::File,
    }
}

/// Build the local filename for a piece of inline article media.
///
/// Format: `<slug> (<kind> <1-based idx>).<ext>`
/// Example: `Hello World (image 1).jpg`, `Story (video 2).mp4`.
/// The `idx` is 1-based per-kind so a single article mixing 3 images and
/// 2 videos produces `(image 1/2/3)` and `(video 1/2)` independently.
fn build_inline_media_name(slug: &str, kind: InlineMediaKind, idx: u32, ext: &str) -> String {
    if ext.is_empty() {
        format!(
            "{slug} ({label} {idx})",
            slug = slug,
            label = kind.label(),
            idx = idx
        )
    } else {
        format!(
            "{slug} ({label} {idx}).{ext}",
            slug = slug,
            label = kind.label(),
            idx = idx,
            ext = ext
        )
    }
}

/// Download inline images from Markdown body, replacing external URLs with local filenames.
/// Images that fail to download keep their original URL.
const MAX_INLINE_IMAGES: u32 = 30;
const MAX_PARALLEL_DOWNLOADS: usize = 3;
const MAX_PER_DOMAIN: usize = 2;

/// One inline `![alt](url)` occurrence parsed from the body, with its
/// destination filename precomputed. Phase A produces a Vec<InlineTask>;
/// Phase B downloads in parallel; Phase C dedups + rewrites the body.
#[derive(Debug, Clone)]
struct InlineTask {
    img_start: usize, // offset of '!' in '![alt](url)'
    paren_end: usize, // offset of ')' (inclusive)
    alt: String,      // raw alt text between '[' and ']'
    url: String,
    host: String, // for per-domain throttling
    #[allow(dead_code)] // diagnostic only after Phase A
    kind: InlineMediaKind,
    dest_name: String, // e.g. "Title (image 1).jpg"
    dest_path: PathBuf,
}

/// Counting semaphore keyed by hostname. Used by the download pool to
/// avoid hitting one CDN with more than MAX_PER_DOMAIN concurrent
/// requests (Twitter/X 429s, Apple sometimes throttles).
struct DomainLimiter {
    state: Mutex<HashMap<String, usize>>,
    cv: Condvar,
    max_per_domain: usize,
}

impl DomainLimiter {
    fn new(max_per_domain: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(HashMap::new()),
            cv: Condvar::new(),
            max_per_domain,
        })
    }

    /// Block until a slot for this host is available, then increment and
    /// return a permit. Permit decrements on Drop.
    fn acquire(self: &Arc<Self>, host: String) -> DomainPermit {
        let mut state = self.state.lock().expect("DomainLimiter poisoned");
        loop {
            let count = state.entry(host.clone()).or_insert(0);
            if *count < self.max_per_domain {
                *count += 1;
                return DomainPermit {
                    limiter: Arc::clone(self),
                    host,
                };
            }
            state = self.cv.wait(state).expect("DomainLimiter wait poisoned");
        }
    }
}

struct DomainPermit {
    limiter: Arc<DomainLimiter>,
    host: String,
}

impl Drop for DomainPermit {
    fn drop(&mut self) {
        let mut state = self.limiter.state.lock().expect("DomainLimiter poisoned");
        if let Some(c) = state.get_mut(&self.host) {
            *c = c.saturating_sub(1);
        }
        drop(state);
        self.limiter.cv.notify_all();
    }
}

/// Extract the lowercase hostname from an `http(s)://host[:port]/...` URL.
/// Returns empty string if the URL is malformed (caller treats it as a
/// fresh per-task domain — equivalent to no throttling for that task).
fn host_from_url(url: &str) -> String {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or("");
    after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

/// Phase A: scan the body, build the list of inline-media tasks with
/// deterministic per-kind indices. Stops at MAX_INLINE_IMAGES successful
/// http(s) matches; non-http URLs and malformed `![alt](...)` patterns
/// are skipped without consuming the cap.
fn scan_inline_tasks(body: &str, vault: &VaultLayout, slug: &str) -> Vec<InlineTask> {
    let mut tasks = Vec::new();
    let mut image_idx: u32 = 0;
    let mut video_idx: u32 = 0;
    let mut file_idx: u32 = 0;
    let mut search_from = 0;

    while tasks.len() < MAX_INLINE_IMAGES as usize {
        let Some(offset) = body[search_from..].find("![") else {
            break;
        };
        let img_start = search_from + offset;
        let alt_start = img_start + 2;

        let Some(offset) = body[alt_start..].find("](") else {
            search_from = alt_start;
            continue;
        };
        let bracket_pos = alt_start + offset;

        let url_start = bracket_pos + 2;
        let Some(offset) = body[url_start..].find(')') else {
            search_from = url_start;
            continue;
        };
        let paren_end = url_start + offset;

        let url = &body[url_start..paren_end];
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            search_from = paren_end + 1;
            continue;
        }

        let ext = ext_from_url(url);
        let kind = inline_media_kind_from_ext(ext);
        let idx = match kind {
            InlineMediaKind::Image => {
                image_idx += 1;
                image_idx
            }
            InlineMediaKind::Video => {
                video_idx += 1;
                video_idx
            }
            InlineMediaKind::File => {
                file_idx += 1;
                file_idx
            }
        };
        let dest_name = build_inline_media_name(slug, kind, idx, ext);
        let dest_path = vault.root().join(&dest_name);
        let host = host_from_url(url);
        let alt = body[alt_start..bracket_pos].to_string();

        tasks.push(InlineTask {
            img_start,
            paren_end,
            alt,
            url: url.to_string(),
            host,
            kind,
            dest_name,
            dest_path,
        });
        search_from = paren_end + 1;
    }
    tasks
}

/// Phase B: spawn a fixed worker pool, drain a shared queue of task
/// indices, throttle per-domain via `DomainLimiter`. Returns one
/// `Result<(), String>` per task, indexed identically to `tasks`.
fn run_parallel_downloads(tasks: &[InlineTask], page_url: &str) -> Vec<Result<(), String>> {
    if tasks.is_empty() {
        return Vec::new();
    }

    let limiter = DomainLimiter::new(MAX_PER_DOMAIN);
    let queue: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new((0..tasks.len()).collect()));
    let tasks_shared: Arc<Vec<InlineTask>> = Arc::new(tasks.to_vec());
    let (result_tx, result_rx) = std::sync::mpsc::channel::<(usize, Result<(), String>)>();

    let worker_count = MAX_PARALLEL_DOWNLOADS.min(tasks.len());
    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let limiter = Arc::clone(&limiter);
        let tasks_shared = Arc::clone(&tasks_shared);
        let result_tx = result_tx.clone();
        let page_url = page_url.to_string();
        handles.push(std::thread::spawn(move || loop {
            let task_idx = {
                let mut q = queue.lock().expect("download queue poisoned");
                match q.pop_front() {
                    Some(i) => i,
                    None => break,
                }
            };
            let task = &tasks_shared[task_idx];
            let _permit = limiter.acquire(task.host.clone());
            let result =
                download_file(&task.url, &task.dest_path, &page_url).map_err(|e| e.to_string());
            let _ = result_tx.send((task_idx, result));
        }));
    }
    drop(result_tx);

    let mut results: Vec<Option<Result<(), String>>> = (0..tasks.len()).map(|_| None).collect();
    while let Ok((idx, res)) = result_rx.recv() {
        results[idx] = Some(res);
    }
    for h in handles {
        let _ = h.join();
    }

    results
        .into_iter()
        .map(|opt| opt.unwrap_or_else(|| Err("worker panicked or task lost".to_string())))
        .collect()
}

/// One body-rewrite to apply at the end of localize. Computed against
/// the ORIGINAL body so all ranges remain valid; applied in reverse
/// offset order to preserve earlier offsets.
struct RewriteSpec {
    range: std::ops::Range<usize>, // [start, end) bytes in original body
    replacement: String,
}

/// Phase C: dedup by byte comparison among successful downloads, build
/// rewrite specs, apply in reverse offset order, return new body.
fn apply_rewrites(body: &str, tasks: &[InlineTask], outcomes: &[Result<(), String>]) -> String {
    debug_assert_eq!(tasks.len(), outcomes.len());

    // Dedup: pair each successful task with the earliest other successful
    // task whose downloaded file is byte-identical. Removed duplicates
    // get their dest_file unlinked and trigger line-removal rewrites.
    let mut dedup_target: Vec<Option<usize>> = vec![None; tasks.len()];
    for j in 0..tasks.len() {
        if outcomes[j].is_err() {
            continue;
        }
        for i in 0..j {
            if outcomes[i].is_err() || dedup_target[i].is_some() {
                continue;
            }
            if files_identical(&tasks[i].dest_path, &tasks[j].dest_path) {
                dedup_target[j] = Some(i);
                let _ = std::fs::remove_file(&tasks[j].dest_path);
                log::info!(
                    "inline-media: dedup {} == {}",
                    tasks[j].dest_name,
                    tasks[i].dest_name
                );
                break;
            }
        }
    }

    // Build rewrite specs against the ORIGINAL body so offsets stay valid.
    let mut specs: Vec<RewriteSpec> = Vec::new();
    for (i, task) in tasks.iter().enumerate() {
        match (&outcomes[i], dedup_target[i]) {
            (Err(_), _) => {
                // Failed download: leave the remote URL in place. Renderer
                // will load it from network (CSP allows http(s) img-src).
            }
            (Ok(()), None) => {
                // Successful unique: replace `![alt](url)` with wikilink.
                let replacement = build_inline_wikilink(&task.dest_name, task.alt.trim());
                specs.push(RewriteSpec {
                    range: task.img_start..task.paren_end + 1,
                    replacement,
                });
            }
            (Ok(()), Some(_)) => {
                // Duplicate: remove the entire `![...](...)` plus
                // surrounding blank lines and matching caption line.
                let bytes = body.as_bytes();
                let remove_end = task.paren_end + 1;
                let mut line_start = task.img_start;
                while line_start > 0 && bytes.get(line_start - 1) == Some(&b'\n') {
                    line_start -= 1;
                }
                let mut line_end = remove_end;
                while line_end < body.len() && bytes.get(line_end) == Some(&b'\n') {
                    line_end += 1;
                }
                let alt_trim = task.alt.trim();
                if !alt_trim.is_empty() && line_end < body.len() {
                    let next_newline = body[line_end..]
                        .find('\n')
                        .map(|p| line_end + p)
                        .unwrap_or(body.len());
                    let next_line = body[line_end..next_newline].trim();
                    if next_line == alt_trim {
                        line_end = next_newline;
                        while line_end < body.len() && bytes.get(line_end) == Some(&b'\n') {
                            line_end += 1;
                        }
                    }
                }
                specs.push(RewriteSpec {
                    range: line_start..line_end,
                    replacement: String::new(),
                });
            }
        }
    }

    // Apply in reverse offset order so earlier ranges stay valid.
    specs.sort_by(|a, b| b.range.start.cmp(&a.range.start));
    let mut result = body.to_string();
    for spec in specs {
        // Defensive: ranges must lie within result. Skip pathological
        // overlaps with later (already-applied) specs.
        if spec.range.end > result.len() || spec.range.start > spec.range.end {
            continue;
        }
        result.replace_range(spec.range, &spec.replacement);
    }
    result
}

fn localize_body_images(body: &str, vault: &VaultLayout, slug: &str, page_url: &str) -> String {
    let tasks = scan_inline_tasks(body, vault, slug);
    if tasks.is_empty() {
        return body.to_string();
    }
    let started = std::time::Instant::now();
    log::info!(
        "inline-media: {} tasks, parallel downloads start (limit={}/{}per-domain)",
        tasks.len(),
        MAX_PARALLEL_DOWNLOADS,
        MAX_PER_DOMAIN,
    );
    let outcomes = run_parallel_downloads(&tasks, page_url);
    let ok = outcomes.iter().filter(|r| r.is_ok()).count();
    for (task, outcome) in tasks.iter().zip(outcomes.iter()) {
        if let Err(e) = outcome {
            log::warn!("inline-media: download failed url={} err={}", task.url, e);
        }
    }
    let result = apply_rewrites(body, &tasks, &outcomes);
    log::info!(
        "inline-media: done in {:?}, {}/{} ok",
        started.elapsed(),
        ok,
        tasks.len()
    );
    result
}

/// Compare two files byte-by-byte. Returns true if identical.
fn files_identical(a: &std::path::Path, b: &std::path::Path) -> bool {
    use std::io::Read;
    let (Ok(meta_a), Ok(meta_b)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if meta_a.len() != meta_b.len() {
        return false;
    }
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut buf_a = [0u8; 8192];
    let mut buf_b = [0u8; 8192];
    loop {
        let na = fa.read(&mut buf_a).unwrap_or(0);
        let nb = fb.read(&mut buf_b).unwrap_or(0);
        if na != nb || buf_a[..na] != buf_b[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

// ─── Twitter video discovery ────────────────────────────────────────────────

/// Extract tweet ID from Twitter/X status URL. Returns None for non-Twitter URLs.
fn extract_twitter_video_id(url: &str) -> Option<String> {
    let lc = url.to_lowercase();
    if !(lc.contains("twitter.com/") || lc.contains("x.com/")) || !lc.contains("/status/") {
        return None;
    }
    url.split("/status/")
        .nth(1)
        .and_then(|s| s.split(&['?', '/', '#'][..]).next())
        .filter(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty())
        .map(|s| s.to_string())
}

/// Fetch video/GIF MP4 URLs from Twitter syndication API.
/// Returns only video and animated_gif types (not photos — those are already in body from DOM).
fn fetch_tweet_videos(tweet_id: &str) -> anyhow::Result<Vec<String>> {
    let api_url = format!(
        "https://cdn.syndication.twimg.com/tweet-result?id={}&token=0",
        tweet_id
    );
    let resp = ureq::get(&api_url)
        .set("User-Agent", "Mozilla/5.0")
        .call()?;
    let data: serde_json::Value = resp.into_json()?;

    let mut urls = Vec::new();
    if let Some(media) = data.get("mediaDetails").and_then(|v| v.as_array()) {
        for item in media {
            let media_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if media_type != "video" && media_type != "animated_gif" {
                continue;
            }
            if let Some(variants) = item
                .pointer("/video_info/variants")
                .and_then(|v| v.as_array())
            {
                let best = variants
                    .iter()
                    .filter(|v| v.get("content_type").and_then(|c| c.as_str()) == Some("video/mp4"))
                    .max_by_key(|v| v.get("bitrate").and_then(|b| b.as_u64()).unwrap_or(0));
                if let Some(variant) = best {
                    if let Some(url) = variant.get("url").and_then(|u| u.as_str()) {
                        urls.push(url.to_string());
                    }
                }
            }
        }
    }
    Ok(urls)
}

// ─── Main loop ──────────────────────────────────────────────────────────────

// ─── Upload server ─────────────────────────────────────────────────────────

struct UploadServer {
    port: u16,
    token: String,
}

fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:032x}", seed ^ 0xdeadbeef_cafebabe_u128)
}

fn start_upload_server() -> Option<UploadServer> {
    let server = match tiny_http::Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(_) => return None,
    };
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    if port == 0 {
        return None;
    }
    let token = generate_token();
    let token_clone = token.clone();

    // Seed shared vault path used by the upload handler
    if let Ok(mut v) = UPLOAD_VAULT.lock() {
        *v = load_vault_path();
    }

    std::thread::Builder::new()
        .name("upload-server".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                handle_upload_request(request, &token_clone);
            }
        })
        .ok()?;

    Some(UploadServer { port, token })
}

static UPLOAD_VAULT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn form_url_decode(value: &str) -> String {
    let value = value.replace('+', " ");
    percent_decode_str(&value).decode_utf8_lossy().into_owned()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if form_url_decode(raw_key) == key {
            let value = form_url_decode(raw_value);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn upload_filename_from_url(url: &str) -> String {
    let raw = query_param(url, "filename").unwrap_or_else(|| "upload.jpg".to_string());
    let normalized = raw.replace('\\', "/");
    std::path::Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("upload.jpg")
        .to_string()
}

fn dedupe_upload_staging_filename(
    vault_root: &std::path::Path,
    requested: &str,
) -> Result<String, String> {
    if !vault_root.join(requested).exists() {
        return Ok(requested.to_string());
    }

    let path = std::path::Path::new(requested);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(requested);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let build = |counter: u32| -> String {
        if ext.is_empty() {
            format!("{stem} ({counter})")
        } else {
            format!("{stem} ({counter}).{ext}")
        }
    };

    let mut counter: u32 = 2;
    loop {
        let candidate = build(counter);
        if !vault_root.join(&candidate).exists() {
            return Ok(candidate);
        }
        counter = counter
            .checked_add(1)
            .ok_or_else(|| "ran out of upload staging suffixes".to_string())?;
    }
}

fn handle_upload_request(mut request: tiny_http::Request, token: &str) {
    // CORS preflight
    if *request.method() == "OPTIONS".parse::<tiny_http::Method>().unwrap() {
        let response = tiny_http::Response::empty(200)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            )
            .with_header(
                "Access-Control-Allow-Methods: POST, OPTIONS"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            )
            .with_header(
                "Access-Control-Allow-Headers: Authorization, Content-Type"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    // Auth check
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.as_str() == "Authorization" || h.field.as_str() == "authorization")
        .map(|h| h.value.as_str().to_string());
    let expected = format!("Bearer {token}");
    if auth.as_deref() != Some(&expected) {
        let response = tiny_http::Response::from_string("Unauthorized")
            .with_status_code(403)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    // Only POST /upload
    if *request.method() != tiny_http::Method::Post || !request.url().starts_with("/upload") {
        let response = tiny_http::Response::from_string("Not Found")
            .with_status_code(404)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    // Extract upload destination from query:
    // /upload?filename=screenshot.jpg&vault_path=/path/to/vault
    //
    // `vault_path` keeps the HTTP upload and the following save_block on
    // the same vault. The global fallback exists for older extension builds,
    // but it is intentionally no longer the primary routing mechanism.
    let filename = upload_filename_from_url(request.url());
    let vault_path = query_param(request.url(), "vault_path")
        .or_else(|| UPLOAD_VAULT.lock().ok().and_then(|v| v.clone()));

    // Read body
    let mut body = Vec::new();
    if let Err(e) = request.as_reader().read_to_end(&mut body) {
        let response = tiny_http::Response::from_string(format!("Read error: {e}"))
            .with_status_code(500)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    // Write to vault
    let Some(vp) = vault_path else {
        let response = tiny_http::Response::from_string("Vault not configured")
            .with_status_code(500)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    };

    let vault_root = PathBuf::from(&vp);
    let filename = match dedupe_upload_staging_filename(&vault_root, &filename) {
        Ok(filename) => filename,
        Err(e) => {
            let response = tiny_http::Response::from_string(e)
                .with_status_code(500)
                .with_header(
                    "Access-Control-Allow-Origin: *"
                        .parse::<tiny_http::Header>()
                        .unwrap(),
                );
            let _ = request.respond(response);
            return;
        }
    };
    let dest = vault_root.join(&filename);
    if let Err(e) = std::fs::write(&dest, &body) {
        let response = tiny_http::Response::from_string(format!("Write error: {e}"))
            .with_status_code(500)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    let json = format!(
        r#"{{"ok":true,"filename":"{}","size":{}}}"#,
        filename,
        body.len()
    );
    let response = tiny_http::Response::from_string(json)
        .with_header(
            "Content-Type: application/json"
                .parse::<tiny_http::Header>()
                .unwrap(),
        )
        .with_header(
            "Access-Control-Allow-Origin: *"
                .parse::<tiny_http::Header>()
                .unwrap(),
        );
    let _ = request.respond(response);
}

fn main() {
    // Start upload HTTP server
    let upload_server = start_upload_server();

    // Update vault path for upload server
    if let Some(vp) = load_vault_path() {
        if let Ok(mut v) = UPLOAD_VAULT.lock() {
            *v = Some(vp);
        }
    }

    // Process messages until stdin is closed
    loop {
        let msg = match read_message() {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(e) => {
                send_error(&format!("failed to read message: {e}"));
                break;
            }
        };

        let req: Request = match serde_json::from_str(&msg) {
            Ok(r) => r,
            Err(e) => {
                send_error(&format!("invalid JSON: {e}"));
                continue;
            }
        };

        // Load vault: prefer per-request vault_path, fallback to config
        let vault_path = req.vault_path.clone().or_else(|| load_vault_path());
        if let Some(ref vp) = vault_path {
            if let Ok(mut v) = UPLOAD_VAULT.lock() {
                *v = Some(vp.clone());
            }
        }

        match req.action.as_str() {
            "get_status" => handle_get_status_with_upload(&upload_server),
            "list_known_vaults" => handle_list_known_vaults(),

            "list_channels" | "save_block" | "create_channel" => {
                let Some(ref vp) = vault_path else {
                    send_error("Vault not configured and HOME is not set.");
                    continue;
                };
                let path = PathBuf::from(vp);
                // Ensure vault directory exists (standalone mode may have just created it)
                if !path.is_dir() {
                    if std::fs::create_dir_all(&path).is_err() {
                        send_error(&format!("Cannot create vault directory: {vp}"));
                        continue;
                    }
                }
                let vault = match resolve_native_vault_layout(path) {
                    Ok(vault) => vault,
                    Err(e) => {
                        send_error(&e);
                        continue;
                    }
                };

                match req.action.as_str() {
                    "list_channels" => handle_list_channels(&vault),
                    "save_block" => handle_save_block(&vault, req.params),
                    "create_channel" => handle_create_channel(&vault, req.params),
                    _ => unreachable!(),
                }
            }

            other => send_error(&format!("unknown action: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_staging(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn test_dt() -> DateTime {
        DateTime::new("2026-04-24T12:00:00Z").unwrap()
    }

    fn test_channel(tag: &str, title: &str) -> Channel {
        Channel::new(tag, Some(title), test_dt()).unwrap()
    }

    #[test]
    fn merge_channels_and_tags_includes_empty_promoted_channel() {
        let infos =
            merge_channels_and_tags(vec![test_channel("empty-channel", "Empty Channel")], vec![]);

        assert_eq!(
            infos,
            vec![ChannelInfo {
                tag: "empty-channel".to_string(),
                title: "Empty Channel".to_string(),
                block_count: 0,
            }]
        );
    }

    #[test]
    fn merge_channels_and_tags_uses_promoted_title_and_tag_count() {
        let infos = merge_channels_and_tags(
            vec![test_channel("design", "Design System")],
            vec![index::TagCount {
                tag: "design".to_string(),
                count: 3,
            }],
        );

        assert_eq!(
            infos,
            vec![ChannelInfo {
                tag: "design".to_string(),
                title: "Design System".to_string(),
                block_count: 3,
            }]
        );
    }

    #[test]
    fn merge_channels_and_tags_preserves_promoted_collection_ref() {
        let infos = merge_channels_and_tags(
            vec![test_channel("Красивый веб", "Красивый веб")],
            vec![index::TagCount {
                tag: "Красивый веб".to_string(),
                count: 4,
            }],
        );

        assert_eq!(
            infos,
            vec![ChannelInfo {
                tag: "Красивый веб".to_string(),
                title: "Красивый веб".to_string(),
                block_count: 4,
            }]
        );
    }

    #[test]
    fn merge_channels_and_tags_keeps_distinct_collection_refs() {
        let infos = merge_channels_and_tags(
            vec![
                test_channel("Красивый веб", "Красивый веб"),
                test_channel("красивый-веб", "Kebab"),
            ],
            vec![index::TagCount {
                tag: "красивый-веб".to_string(),
                count: 4,
            }],
        );

        assert_eq!(
            infos,
            vec![
                ChannelInfo {
                    tag: "Красивый веб".to_string(),
                    title: "Красивый веб".to_string(),
                    block_count: 0,
                },
                ChannelInfo {
                    tag: "красивый-веб".to_string(),
                    title: "Kebab".to_string(),
                    block_count: 4,
                },
            ]
        );
    }

    #[test]
    fn merge_channels_and_tags_keeps_unpromoted_used_tags() {
        let infos = merge_channels_and_tags(
            vec![test_channel("design", "Design")],
            vec![
                index::TagCount {
                    tag: "design".to_string(),
                    count: 1,
                },
                index::TagCount {
                    tag: "local-first".to_string(),
                    count: 2,
                },
            ],
        );

        assert_eq!(
            infos,
            vec![
                ChannelInfo {
                    tag: "design".to_string(),
                    title: "Design".to_string(),
                    block_count: 1,
                },
                ChannelInfo {
                    tag: "local-first".to_string(),
                    title: "Local-first".to_string(),
                    block_count: 2,
                },
            ]
        );
    }

    #[test]
    fn finalize_renames_staged_file_to_slug_and_returns_new_name() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"image-bytes");

        let result = finalize_uploaded_filename(tmp.path(), "upload.jpg", "Hello World");

        assert_eq!(result, Ok("Hello World.jpg".to_string()));
        assert!(!tmp.path().join("upload.jpg").exists());
        assert!(tmp.path().join("Hello World.jpg").exists());
    }

    #[test]
    fn finalize_preserves_extension_including_multi_char() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.webp", b"x");
        let result = finalize_uploaded_filename(tmp.path(), "upload.webp", "Photo");
        assert_eq!(result, Ok("Photo.webp".to_string()));
    }

    #[test]
    fn finalize_preserves_unicode_slug() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"x");
        let result = finalize_uploaded_filename(tmp.path(), "upload.jpg", "Закат в Токио");
        assert_eq!(result, Ok("Закат в Токио.jpg".to_string()));
        assert!(tmp.path().join("Закат в Токио.jpg").exists());
    }

    #[test]
    fn finalize_noop_when_names_already_match() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "Hello.jpg", b"x");
        let result = finalize_uploaded_filename(tmp.path(), "Hello.jpg", "Hello");
        assert_eq!(result, Ok("Hello.jpg".to_string()));
        // Source still exists, not renamed to anything else.
        assert!(tmp.path().join("Hello.jpg").exists());
    }

    #[test]
    fn finalize_errors_when_source_missing() {
        let tmp = TempDir::new().unwrap();
        let result = finalize_uploaded_filename(tmp.path(), "missing.jpg", "Slug");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn finalize_appends_counter_suffix_when_target_exists() {
        // Two screenshots from the same page land on the same would-be
        // media filename. Instead of failing the save, dedupe with the
        // Obsidian-style ` (N)` suffix so both clips survive, matching
        // how `resolve_slug_conflict` picks unique `.md` names.
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"new");
        make_staging(tmp.path(), "Hello.jpg", b"existing");
        let result = finalize_uploaded_filename(tmp.path(), "upload.jpg", "Hello");
        assert_eq!(result, Ok("Hello (2).jpg".to_string()));
        // Original is left intact.
        assert_eq!(
            std::fs::read(tmp.path().join("Hello.jpg")).unwrap(),
            b"existing"
        );
        // Staged upload moved onto the deduped name.
        assert_eq!(
            std::fs::read(tmp.path().join("Hello (2).jpg")).unwrap(),
            b"new"
        );
        assert!(!tmp.path().join("upload.jpg").exists());
    }

    #[test]
    fn finalize_walks_counter_past_multiple_collisions() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"new");
        make_staging(tmp.path(), "Hello.jpg", b"x");
        make_staging(tmp.path(), "Hello (2).jpg", b"x");
        make_staging(tmp.path(), "Hello (3).jpg", b"x");
        let result = finalize_uploaded_filename(tmp.path(), "upload.jpg", "Hello");
        assert_eq!(result, Ok("Hello (4).jpg".to_string()));
    }

    #[test]
    fn finalize_handles_file_without_extension() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload", b"x");
        let result = finalize_uploaded_filename(tmp.path(), "upload", "Plain");
        assert_eq!(result, Ok("Plain".to_string()));
        assert!(tmp.path().join("Plain").exists());
    }

    #[test]
    fn upload_query_decodes_filename_and_vault_path() {
        let url =
            "/upload?filename=Cindy-Te.jpg&vault_path=%2FUsers%2Fi_iii%2FMobile+Documents%2FMine";

        assert_eq!(upload_filename_from_url(url), "Cindy-Te.jpg");
        assert_eq!(
            query_param(url, "vault_path"),
            Some("/Users/i_iii/Mobile Documents/Mine".to_string())
        );
    }

    #[test]
    fn upload_filename_is_reduced_to_leaf_name() {
        assert_eq!(
            upload_filename_from_url("/upload?filename=..%2F..%2Fevil.jpg"),
            "evil.jpg"
        );
        assert_eq!(
            upload_filename_from_url("/upload?filename=folder%5Cevil.jpg"),
            "evil.jpg"
        );
    }

    #[test]
    fn upload_staging_filename_dedupes_existing_file_before_write() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "Cindy-Te.jpg", b"existing");

        let result = dedupe_upload_staging_filename(tmp.path(), "Cindy-Te.jpg");

        assert_eq!(result, Ok("Cindy-Te (2).jpg".to_string()));
        assert_eq!(
            std::fs::read(tmp.path().join("Cindy-Te.jpg")).unwrap(),
            b"existing"
        );
    }

    #[test]
    fn upload_staging_filename_walks_existing_suffixes() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "Cindy-Te.jpg", b"x");
        make_staging(tmp.path(), "Cindy-Te (2).jpg", b"x");

        let result = dedupe_upload_staging_filename(tmp.path(), "Cindy-Te.jpg");

        assert_eq!(result, Ok("Cindy-Te (3).jpg".to_string()));
    }

    // ── Inline media naming (18.F) ──────────────────────────────────────

    #[test]
    fn inline_kind_image_extensions_recognized() {
        for ext in ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"] {
            assert_eq!(
                inline_media_kind_from_ext(ext),
                InlineMediaKind::Image,
                "expected {} to be Image",
                ext
            );
        }
    }

    #[test]
    fn inline_kind_video_extensions_recognized() {
        for ext in ["mp4", "webm", "m4v", "mov"] {
            assert_eq!(
                inline_media_kind_from_ext(ext),
                InlineMediaKind::Video,
                "expected {} to be Video",
                ext
            );
        }
    }

    #[test]
    fn inline_kind_case_insensitive() {
        assert_eq!(inline_media_kind_from_ext("JPG"), InlineMediaKind::Image);
        assert_eq!(inline_media_kind_from_ext("MP4"), InlineMediaKind::Video);
    }

    #[test]
    fn inline_kind_unknown_ext_is_file() {
        assert_eq!(inline_media_kind_from_ext("pdf"), InlineMediaKind::File);
        assert_eq!(inline_media_kind_from_ext(""), InlineMediaKind::File);
    }

    #[test]
    fn inline_name_image() {
        assert_eq!(
            build_inline_media_name("Hello World", InlineMediaKind::Image, 1, "jpg"),
            "Hello World (image 1).jpg"
        );
    }

    #[test]
    fn inline_name_video_second() {
        assert_eq!(
            build_inline_media_name("Story", InlineMediaKind::Video, 2, "mp4"),
            "Story (video 2).mp4"
        );
    }

    #[test]
    fn inline_name_with_unicode_slug() {
        assert_eq!(
            build_inline_media_name("Закат", InlineMediaKind::Image, 3, "png"),
            "Закат (image 3).png"
        );
    }

    #[test]
    fn inline_name_file_fallback_for_unknown_kind() {
        assert_eq!(
            build_inline_media_name("Doc", InlineMediaKind::File, 1, "pdf"),
            "Doc (file 1).pdf"
        );
    }

    #[test]
    fn inline_name_without_extension() {
        assert_eq!(
            build_inline_media_name("Plain", InlineMediaKind::File, 1, ""),
            "Plain (file 1)"
        );
    }

    #[test]
    fn inline_name_preserves_slug_parentheses() {
        // Base slug that already contains parens from user-authored title.
        // Final name reads correctly: `Note (draft) (image 1).jpg`.
        assert_eq!(
            build_inline_media_name("Note (draft)", InlineMediaKind::Image, 1, "jpg"),
            "Note (draft) (image 1).jpg"
        );
    }

    // ── Markdown URL encoding ───────────────────────────────────────────

    #[test]
    fn encode_url_spaces_and_parens() {
        assert_eq!(
            encode_markdown_url_component("Hello World (image 1).jpg"),
            "Hello%20World%20%28image%201%29.jpg"
        );
    }

    #[test]
    fn encode_url_ascii_safe_passthrough() {
        assert_eq!(encode_markdown_url_component("photo.jpg"), "photo.jpg");
        assert_eq!(
            encode_markdown_url_component("sunset-tokyo.png"),
            "sunset-tokyo.png"
        );
    }

    #[test]
    fn encode_url_preserves_unicode_chars() {
        // Cyrillic passes through: modern markdown parsers accept Unicode
        // in URLs, and keeping it readable is a Mine value.
        assert_eq!(
            encode_markdown_url_component("Закат (image 1).jpg"),
            "Закат%20%28image%201%29.jpg"
        );
    }

    #[test]
    fn encode_url_escapes_bare_percent() {
        // Paranoid: if a future filename ever contains a literal %, it
        // must not look like a malformed escape to the markdown parser.
        assert_eq!(encode_markdown_url_component("50%.jpg"), "50%25.jpg");
    }

    #[test]
    fn encode_url_idempotent_on_no_special_chars() {
        let input = "simple-name.mp4";
        assert_eq!(encode_markdown_url_component(input), input);
    }

    // ── Wikilink builder (18.H.1) ───────────────────────────────────────

    #[test]
    fn wikilink_plain_name_without_alt() {
        assert_eq!(
            build_inline_wikilink("Title (image 1).jpg", ""),
            "![[Title (image 1).jpg]]"
        );
    }

    #[test]
    fn wikilink_with_alt_uses_pipe_separator() {
        assert_eq!(
            build_inline_wikilink("Photo.jpg", "sunset on the beach"),
            "![[Photo.jpg|sunset on the beach]]"
        );
    }

    #[test]
    fn wikilink_preserves_unicode_name() {
        assert_eq!(
            build_inline_wikilink("Закат (image 1).jpg", ""),
            "![[Закат (image 1).jpg]]"
        );
    }

    #[test]
    fn wikilink_escapes_pipe_in_alt() {
        // A literal `|` in alt text would split the wikilink early.
        assert_eq!(
            build_inline_wikilink("File.jpg", "before | after"),
            "![[File.jpg|before &#124; after]]"
        );
    }

    #[test]
    fn wikilink_collapses_newlines_in_alt() {
        // Alt text with a newline would split the wikilink across lines.
        assert_eq!(
            build_inline_wikilink("File.jpg", "line one\nline two"),
            "![[File.jpg|line one line two]]"
        );
    }

    #[test]
    fn wikilink_falls_back_to_markdown_when_name_contains_close_delim() {
        // `]]` inside the filename would corrupt the wikilink; fall
        // back to the encoded markdown form so output stays valid.
        let built = build_inline_wikilink("weird]]name.jpg", "");
        assert!(built.starts_with("!["));
        assert!(built.contains("](")); // markdown form
        assert!(!built.contains("![["));
    }

    #[test]
    fn wikilink_omits_alt_when_only_whitespace() {
        // An alt that is whitespace-only should behave like empty alt
        // (caller passes `alt.trim()` — this mirrors that).
        assert_eq!(build_inline_wikilink("f.jpg", ""), "![[f.jpg]]");
    }

    // ─── localize_body_images: scan + apply_rewrites ──────────────────

    fn vault_at(dir: &std::path::Path) -> VaultLayout {
        VaultLayout::new(dir.to_path_buf())
    }

    #[test]
    fn host_from_url_extracts_lowercase_host_only() {
        assert_eq!(host_from_url("https://Example.com/a/b"), "example.com");
        assert_eq!(
            host_from_url("http://pbs.twimg.com:443/x.jpg"),
            "pbs.twimg.com"
        );
        assert_eq!(host_from_url("ftp://nope"), "");
        assert_eq!(host_from_url("not-a-url"), "");
    }

    #[test]
    fn scan_skips_relative_and_data_urls() {
        let tmp = TempDir::new().unwrap();
        let body = "intro ![a](relative.jpg) and ![b](data:image/png;base64,xx) end";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "Slug");
        assert!(tasks.is_empty());
    }

    #[test]
    fn scan_assigns_per_kind_indices_in_source_order() {
        let tmp = TempDir::new().unwrap();
        let body = "![a](https://h.com/1.jpg)\n\
                    ![b](https://h.com/v.mp4)\n\
                    ![c](https://h.com/2.png)\n\
                    ![d](https://h.com/v2.webm)";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "Title");
        assert_eq!(tasks.len(), 4);
        assert_eq!(tasks[0].dest_name, "Title (image 1).jpg");
        assert_eq!(tasks[1].dest_name, "Title (video 1).mp4");
        assert_eq!(tasks[2].dest_name, "Title (image 2).png");
        assert_eq!(tasks[3].dest_name, "Title (video 2).webm");
        assert_eq!(tasks[0].host, "h.com");
    }

    #[test]
    fn scan_caps_at_max_inline_images() {
        let tmp = TempDir::new().unwrap();
        let mut body = String::new();
        for i in 0..50 {
            body.push_str(&format!("![x](https://h.com/{i}.jpg)\n"));
        }
        let tasks = scan_inline_tasks(&body, &vault_at(tmp.path()), "S");
        assert_eq!(tasks.len(), MAX_INLINE_IMAGES as usize);
    }

    #[test]
    fn scan_handles_malformed_image_brackets_without_panic() {
        let tmp = TempDir::new().unwrap();
        // Unclosed `](` — must not loop forever.
        let body = "![a](https://h.com/x.jpg) and ![broken( and ![c](https://h.com/y.jpg)";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        assert_eq!(tasks.len(), 2);
    }

    #[test]
    fn apply_rewrites_replaces_successful_with_wikilinks() {
        let tmp = TempDir::new().unwrap();
        let body = "intro\n![cap](https://h.com/a.jpg)\nmore";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "Slug");
        let outcomes = vec![Ok(())];
        let rewritten = apply_rewrites(body, &tasks, &outcomes);
        assert_eq!(rewritten, "intro\n![[Slug (image 1).jpg|cap]]\nmore");
    }

    #[test]
    fn apply_rewrites_leaves_failed_url_in_place() {
        let tmp = TempDir::new().unwrap();
        let body = "x ![a](https://h.com/x.jpg) y";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        let outcomes = vec![Err("404".to_string())];
        assert_eq!(apply_rewrites(body, &tasks, &outcomes), body);
    }

    #[test]
    fn apply_rewrites_in_reverse_keeps_offsets_valid() {
        let tmp = TempDir::new().unwrap();
        let body = "![a](https://h.com/1.jpg)\n\n![b](https://h.com/2.jpg)";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        let outcomes = vec![Ok(()), Ok(())];
        let rewritten = apply_rewrites(body, &tasks, &outcomes);
        assert_eq!(
            rewritten,
            "![[S (image 1).jpg|a]]\n\n![[S (image 2).jpg|b]]"
        );
    }

    #[test]
    fn apply_rewrites_dedup_removes_caption_line() {
        // Two tasks point at byte-identical files: the second is dropped
        // along with its caption-only follow-up line.
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("S (image 1).jpg"), b"PIXELS").unwrap();
        std::fs::write(tmp.path().join("S (image 2).jpg"), b"PIXELS").unwrap();
        let body = "intro\n![first](https://h.com/1.jpg)\nfirst\n\n\
                    ![second](https://h.com/2.jpg)\nsecond\n\nend";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        assert_eq!(tasks.len(), 2);
        let outcomes = vec![Ok(()), Ok(())];
        let rewritten = apply_rewrites(body, &tasks, &outcomes);
        // First image kept (with wikilink), second pair removed entirely.
        assert!(rewritten.contains("![[S (image 1).jpg|first]]"));
        assert!(!rewritten.contains("S (image 2).jpg"));
        assert!(!rewritten.contains("second"));
        // Dup file deleted from disk.
        assert!(!tmp.path().join("S (image 2).jpg").exists());
        assert!(tmp.path().join("S (image 1).jpg").exists());
    }

    #[test]
    fn apply_rewrites_zero_tasks_returns_body_unchanged() {
        let tmp = TempDir::new().unwrap();
        let body = "no images here";
        assert_eq!(apply_rewrites(body, &[], &[]), body);
        assert_eq!(
            localize_body_images(body, &vault_at(tmp.path()), "S", ""),
            body
        );
    }

    #[test]
    fn domain_limiter_blocks_above_cap_and_releases_on_drop() {
        let limiter = DomainLimiter::new(2);
        let _p1 = limiter.acquire("h.com".into());
        let _p2 = limiter.acquire("h.com".into());
        // Third acquire on same host must wait — verify by spawning and
        // observing that it doesn't return until we drop one permit.
        let limiter_clone = Arc::clone(&limiter);
        let acquired = Arc::new(Mutex::new(false));
        let acquired_clone = Arc::clone(&acquired);
        let handle = std::thread::spawn(move || {
            let _p3 = limiter_clone.acquire("h.com".into());
            *acquired_clone.lock().unwrap() = true;
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!*acquired.lock().unwrap(), "third should still be blocked");
        drop(_p1);
        handle.join().unwrap();
        assert!(*acquired.lock().unwrap());
    }

    #[test]
    fn domain_limiter_different_hosts_dont_block() {
        let limiter = DomainLimiter::new(1);
        let _p1 = limiter.acquire("a.com".into());
        let _p2 = limiter.acquire("b.com".into());
        // No deadlock — both acquired immediately.
    }
}
