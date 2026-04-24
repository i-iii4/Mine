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

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::path::PathBuf;

use mine_lib::domain::block::{Block, BlockType, DateTime, Frontmatter};
use mine_lib::domain::vault::{resolve_slug_conflict, VaultLayout};
use mine_lib::storage::{db, files, index, thumbnails};
use mine_lib::util::now_iso8601;

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

#[derive(serde::Serialize)]
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

    // Get promoted channels for title overrides
    let channels = index::list_channels(&conn).unwrap_or_default();
    let channel_titles: std::collections::HashMap<&str, &str> = channels
        .iter()
        .map(|c| (c.tag.as_str(), c.title.as_str()))
        .collect();

    // Merge: every tag becomes a channel entry, promoted channels get their title
    let channel_infos: Vec<ChannelInfo> = tags
        .into_iter()
        .map(|t| {
            let title = channel_titles
                .get(t.tag.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| capitalize_tag(&t.tag));
            ChannelInfo {
                tag: t.tag,
                title,
                block_count: t.count,
            }
        })
        .collect();

    send_response(&ChannelsResponse {
        ok: true,
        channels: channel_infos,
    });
}

/// Generate a human-readable title from a kebab-case tag.
fn capitalize_tag(tag: &str) -> String {
    let with_spaces = tag.replace('-', " ");
    let mut chars = with_spaces.chars();
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
                .map(|t| mine_lib::domain::tag::normalize_tag(t))
                .filter(|t| !t.is_empty())
                .collect(),
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

    let title = p.title.unwrap_or_else(|| {
        p.tag
            .replace('-', " ")
            .split_whitespace()
            .map(capitalize_first)
            .collect::<Vec<_>>()
            .join(" ")
    });

    let channel = mine_lib::domain::channel::Channel {
        tag: p.tag.clone(),
        title,
        description: None,
        color: None,
        icon: None,
        position: 0,
        created_at: match mine_lib::domain::block::DateTime::new(&now_iso8601()) {
            Ok(dt) => dt,
            Err(e) => return send_error(&format!("failed to create timestamp: {e}")),
        },
    };

    // Write channel .md file (source of truth)
    let block = mine_lib::domain::block::Block {
        slug: channel.tag.clone(),
        frontmatter: mine_lib::domain::block::Frontmatter {
            block_type: mine_lib::domain::block::BlockType::Channel,
            title: Some(channel.title.clone()),
            description: None,
            url: None,
            file: None,
            thumbnail: None,
            tags: Vec::new(),
            saved_at: channel.created_at.clone(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: Some(channel.position),
            color: None,
            icon: None,
        },
        body: String::new(),
    };
    if let Err(e) = files::write_block_file(vault, &block) {
        return send_error(&format!("failed to write channel file: {e}"));
    }

    if let Err(e) = index::upsert_channel(&conn, &channel) {
        return send_error(&format!("failed to create channel: {e}"));
    }

    send_response(&CreateChannelResponse {
        ok: true,
        tag: p.tag,
    });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
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
        format!("{slug} ({label} {idx})", slug = slug, label = kind.label(), idx = idx)
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

fn localize_body_images(body: &str, vault: &VaultLayout, slug: &str, page_url: &str) -> String {
    let mut result = body.to_string();
    let mut total_count: u32 = 0;
    let mut image_idx: u32 = 0;
    let mut video_idx: u32 = 0;
    let mut file_idx: u32 = 0;
    let mut search_from = 0;
    // Track downloaded files for deduplication
    let mut downloaded: Vec<(PathBuf, String)> = Vec::new();

    loop {
        if total_count >= MAX_INLINE_IMAGES {
            break;
        }

        // Find next ![
        let Some(offset) = result[search_from..].find("![") else {
            break;
        };
        let img_start = search_from + offset;
        let alt_start = img_start + 2;

        // Find ]( after ![
        let Some(offset) = result[alt_start..].find("](") else {
            search_from = alt_start;
            continue;
        };
        let bracket_pos = alt_start + offset;

        // Find closing )
        let url_start = bracket_pos + 2;
        let Some(offset) = result[url_start..].find(')') else {
            search_from = url_start;
            continue;
        };
        let paren_end = url_start + offset;

        let url = result[url_start..paren_end].to_string();

        if url.starts_with("http://") || url.starts_with("https://") {
            let ext = ext_from_url(&url);
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

            let img_name = build_inline_media_name(slug, kind, idx, ext);
            let dest = vault.root().join(&img_name);

            if download_file(&url, &dest, page_url).is_ok() {
                // Check for duplicate by byte comparison
                let dup = downloaded.iter().find(|(p, _)| files_identical(p, &dest));
                if let Some((_, existing_name)) = dup {
                    let existing_name = existing_name.clone();
                    // Duplicate — remove this image line, delete the file
                    let _ = std::fs::remove_file(&dest);
                    // Remove the entire ![...](...) and surrounding whitespace
                    let remove_end = paren_end + 1;
                    let mut line_start = img_start;
                    while line_start > 0 && result.as_bytes().get(line_start - 1) == Some(&b'\n') {
                        line_start -= 1;
                    }
                    let mut line_end = remove_end;
                    while line_end < result.len() && result.as_bytes().get(line_end) == Some(&b'\n')
                    {
                        line_end += 1;
                    }
                    // Also remove caption line if it matches alt text
                    let alt = result[alt_start..bracket_pos].trim().to_string();
                    if !alt.is_empty() && line_end < result.len() {
                        let next_newline = result[line_end..]
                            .find('\n')
                            .map(|p| line_end + p)
                            .unwrap_or(result.len());
                        let next_line = result[line_end..next_newline].trim();
                        if next_line == alt {
                            line_end = next_newline;
                            while line_end < result.len()
                                && result.as_bytes().get(line_end) == Some(&b'\n')
                            {
                                line_end += 1;
                            }
                        }
                    }
                    result = result[..line_start].to_string() + &result[line_end..];
                    search_from = line_start;
                    // Roll back per-kind counter: this index was reserved but
                    // consumed by a duplicate that was removed. The next
                    // unique inline of the same kind should reuse it so the
                    // user-visible numbering stays tight (1, 2, 3, ...).
                    match kind {
                        InlineMediaKind::Image => image_idx -= 1,
                        InlineMediaKind::Video => video_idx -= 1,
                        InlineMediaKind::File => file_idx -= 1,
                    }
                    log::info!(
                        "deduplicated image: {} is identical to {}",
                        img_name,
                        existing_name
                    );
                    continue;
                }

                downloaded.push((dest, img_name.clone()));
                let alt = result[alt_start..bracket_pos].to_string();
                // Phase 18.H.1: write downloaded local media as Obsidian
                // wikilink `![[name|alt]]`. The `]]` delimiter does not
                // collide with filename characters, so no encoding is
                // required. URL in body now equals filename on disk,
                // restoring the invariant the whole codebase assumes.
                //
                // Alt text preserved via `|` separator when present so
                // accessibility/captions survive the rewrite.
                let new_markup = build_inline_wikilink(&img_name, alt.trim());
                let new_len = new_markup.len();
                result = result[..img_start].to_string() + &new_markup + &result[paren_end + 1..];
                total_count += 1;
                // Delay between downloads to avoid CDN rate-limiting
                if total_count < MAX_INLINE_IMAGES {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
                search_from = img_start + new_len;
                continue;
            } else {
                // Download failed: roll back the per-kind counter so the next
                // successful inline of the same kind reuses the skipped index.
                match kind {
                    InlineMediaKind::Image => image_idx -= 1,
                    InlineMediaKind::Video => video_idx -= 1,
                    InlineMediaKind::File => file_idx -= 1,
                }
            }
        }

        search_from = paren_end + 1;
    }

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

    // Extract filename from query: /upload?filename=screenshot.jpg
    let filename = request
        .url()
        .split('?')
        .nth(1)
        .and_then(|q| q.split('&').find(|p| p.starts_with("filename=")))
        .map(|p| {
            p.strip_prefix("filename=")
                .unwrap_or("upload.jpg")
                .to_string()
        })
        .unwrap_or_else(|| "upload.jpg".to_string());

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
    let vault_path = UPLOAD_VAULT.lock().ok().and_then(|v| v.clone());
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

    let dest = PathBuf::from(&vp).join(&filename);
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
                let vault = VaultLayout::new(path);

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
        let result =
            finalize_uploaded_filename(tmp.path(), "upload.jpg", "Закат в Токио");
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
        assert_eq!(std::fs::read(tmp.path().join("Hello.jpg")).unwrap(), b"existing");
        // Staged upload moved onto the deduped name.
        assert_eq!(std::fs::read(tmp.path().join("Hello (2).jpg")).unwrap(), b"new");
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
        assert_eq!(
            build_inline_wikilink("f.jpg", ""),
            "![[f.jpg]]"
        );
    }
}
