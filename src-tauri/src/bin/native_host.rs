// Native messaging host for the Local Arena web clipper browser extension.
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

use local_arena_lib::domain::block::{Block, BlockType, DateTime, Frontmatter};
use local_arena_lib::domain::vault::{resolve_slug_conflict, VaultLayout};
use local_arena_lib::storage::{db, files, index, thumbnails};
use local_arena_lib::util::now_iso8601;

const THUMB_MAX_SIZE: u32 = 240;
const VERSION: &str = env!("CARGO_PKG_VERSION");

// ─── Message types ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct Request {
    action: String,
    #[serde(flatten)]
    params: serde_json::Value,
}

#[derive(serde::Serialize)]
struct StatusResponse {
    ok: bool,
    vault_path: Option<String>,
    version: String,
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
    let json = serde_json::to_string(resp).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"serialization failed"}"#.to_string()
    });
    let _ = write_message(&json);
}

fn send_error(msg: &str) {
    send_response(&ErrorResponse {
        ok: false,
        error: msg.to_string(),
    });
}

// ─── Vault path discovery ───────────────────────────────────────────────────

/// Read vault path from the main app's config file.
/// Location: ~/Library/Application Support/com.localarena.app/config.json
fn load_vault_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let config_path = PathBuf::from(home)
        .join("Library/Application Support/com.localarena.app/config.json");
    let data = std::fs::read_to_string(&config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&data).ok()?;
    json.get("vault_path")?.as_str().map(|s| s.to_string())
}

// ─── Action handlers ────────────────────────────────────────────────────────

fn handle_get_status() {
    let vault_path = load_vault_path();
    let ok = vault_path.is_some();
    send_response(&StatusResponse {
        ok,
        vault_path,
        version: VERSION.to_string(),
    });
}

fn handle_list_channels(vault: &VaultLayout) {
    let conn = match db::open_or_create(&vault.index_db_path()) {
        Ok(c) => c,
        Err(e) => return send_error(&format!("failed to open database: {e}")),
    };

    let channels = match index::list_channels(&conn) {
        Ok(ch) => ch,
        Err(e) => return send_error(&format!("failed to list channels: {e}")),
    };

    // Get tag counts to populate block_count
    let tags = index::get_all_tags(&conn).unwrap_or_default();
    let tag_counts: std::collections::HashMap<&str, usize> = tags
        .iter()
        .map(|t| (t.tag.as_str(), t.count))
        .collect();

    let channel_infos: Vec<ChannelInfo> = channels
        .into_iter()
        .map(|c| {
            let count = tag_counts.get(c.tag.as_str()).copied().unwrap_or(0);
            ChannelInfo {
                tag: c.tag,
                title: c.title,
                block_count: count,
            }
        })
        .collect();

    send_response(&ChannelsResponse {
        ok: true,
        channels: channel_infos,
    });
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
    let raw_slug = local_arena_lib::domain::block::suggest_slug(
        p.title.as_deref(),
        p.url.as_deref(),
    );
    let existing: HashSet<String> = index::list_blocks(&conn)
        .unwrap_or_default()
        .iter()
        .map(|b| b.slug.clone())
        .collect();
    let slug = resolve_slug_conflict(&raw_slug, &existing);

    // Download media if image_url is provided
    let mut media_file = None;
    let mut warning = None;
    let mut downloaded_path: Option<PathBuf> = None;

    if let Some(ref image_url) = p.image_url {
        let ext = ext_from_url(image_url);
        let dest_name = format!("{}.{}", slug, ext);
        let dest_path = vault.root().join(&dest_name);

        match download_file(image_url, &dest_path) {
            Ok(()) => {
                media_file = Some(dest_name);
                downloaded_path = Some(dest_path);
            }
            Err(e) => {
                warning = Some(format!("failed to download media: {e}"));
            }
        }
    }

    // Determine thumbnail name
    let thumbnail = if downloaded_path.is_some() {
        Some(format!("{}.jpg", slug))
    } else {
        None
    };

    let now = now_iso8601();
    let saved_at = match DateTime::new(&now) {
        Ok(dt) => dt,
        Err(e) => return send_error(&format!("failed to create timestamp: {e}")),
    };

    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: bt,
            title: p.title,
            description: p.description,
            url: p.url,
            file: media_file,
            thumbnail,
            tags: p.tags.unwrap_or_default(),
            saved_at,
            source: Some("web-clipper".to_string()),
            width: p.width,
            height: p.height,
            author: p.author,
        },
        body: p.body.unwrap_or_default(),
    };

    // Write .md file
    if let Err(e) = files::write_block_file(vault, &block) {
        return send_error(&format!("failed to write block file: {e}"));
    }

    // Generate thumbnail if we downloaded an image
    if let Some(ref src_path) = downloaded_path {
        let thumb_path = vault.thumb_path(&slug);
        let _ = thumbnails::generate_thumbnail(src_path, &thumb_path, THUMB_MAX_SIZE);
    }

    // Index the block
    if let Err(e) = index::upsert_block(&conn, &block) {
        return send_error(&format!("failed to index block: {e}"));
    }

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

    let channel = local_arena_lib::domain::channel::Channel {
        tag: p.tag.clone(),
        title,
        description: None,
        color: None,
        icon: None,
        position: 0,
        created_at: local_arena_lib::domain::block::DateTime::new(&now_iso8601()).unwrap(),
    };

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

/// Extract file extension from URL, stripping query string and fragment.
fn ext_from_url(url: &str) -> &str {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);
    match path.rsplit('.').next() {
        Some(ext) if ext.len() <= 5 && !ext.contains('/') => ext,
        _ => "jpg",
    }
}

/// Download a file from URL to local path.
fn download_file(url: &str, dest: &std::path::Path) -> anyhow::Result<()> {
    let resp = ureq::get(url).call()?;
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest)?;
    std::io::copy(&mut reader, &mut file)?;
    Ok(())
}

// ─── Main loop ──────────────────────────────────────────────────────────────

fn main() {
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

        // Load vault for actions that need it
        let vault_path = load_vault_path();

        match req.action.as_str() {
            "get_status" => handle_get_status(),

            "list_channels" | "save_block" | "create_channel" => {
                let Some(ref vp) = vault_path else {
                    send_error("Vault not configured. Open Local Arena to select a vault.");
                    continue;
                };
                let path = PathBuf::from(vp);
                if !path.is_dir() {
                    send_error(&format!("Vault directory does not exist: {vp}"));
                    continue;
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
