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
#[cfg(not(test))]
use std::io::Write;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mine_lib::domain::block::{Block, BlockType, DateTime, Frontmatter};
use mine_lib::domain::channel::Channel;
use mine_lib::domain::collection::{normalize_collection_ref, validate_collection_ref};
use mine_lib::domain::vault::VaultLayout;
use mine_lib::net;
use mine_lib::storage::{clipper_uploads, db, files, index, save_operations, thumbnails};
use mine_lib::util::now_iso8601;
use percent_encoding::percent_decode_str;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HOST_API_VERSION: u32 = 2;

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
    connected: bool,
    #[serde(rename = "vaultConfigured")]
    vault_configured: bool,
    binding_id: Option<String>,
    executor_id: String,
    folder_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    vault_path: Option<String>,
    version: String,
    host_api_version: u32,
    features: Vec<String>,
    upload_port: Option<u16>,
    upload_token: Option<String>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
struct ChannelInfo {
    tag: String,
    block_count: usize,
}

#[derive(serde::Serialize)]
struct ChannelsResponse {
    ok: bool,
    channels: Vec<ChannelInfo>,
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

#[derive(serde::Deserialize, serde::Serialize)]
struct SaveBlockParams {
    block_type: String,
    saved_at: Option<String>,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    image_url: Option<String>,
    /// Pending upload id returned by HTTP /upload endpoint.
    pre_uploaded_id: Option<String>,
    /// File already uploaded via HTTP /upload endpoint
    pre_uploaded_file: Option<String>,
    author: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    /// Posters for the videos referenced in `body`, so a video that cannot be
    /// stored locally still leaves the block with a real preview.
    video_posters: Option<Vec<VideoPosterRef>>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct VideoPosterRef {
    video_url: String,
    poster_url: String,
}

#[derive(serde::Deserialize)]
struct CreateChannelParams {
    tag: String,
    #[serde(rename = "title")]
    _title: Option<String>,
}

#[derive(serde::Deserialize)]
struct ResolveTwitterMediaParams {
    url: Option<String>,
    tweet_id: Option<String>,
    /// Cookies from the browser that is showing the tweet, as `name=value`
    /// pairs. Present only when the page-side extraction found a video the
    /// public API refuses to describe — age-restricted posts return a tombstone
    /// to anonymous callers, and their video lives behind a `blob:` URL in the
    /// DOM, so neither existing path can reach it.
    cookies: Option<Vec<TwitterCookie>>,
}

#[derive(serde::Deserialize, Clone)]
struct TwitterCookie {
    name: String,
    value: String,
}

#[derive(serde::Serialize, Clone)]
struct TwitterMediaPreview {
    kind: String,
    src: String,
    poster: Option<String>,
    media_type: String,
}

#[derive(serde::Serialize)]
struct ResolveTwitterMediaResponse {
    ok: bool,
    media: Vec<TwitterMediaPreview>,
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
#[cfg(not(test))]
fn write_message(json: &str) -> io::Result<()> {
    let bytes = json.as_bytes();
    let len = (bytes.len() as u32).to_le_bytes();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    out.write_all(&len)?;
    out.write_all(bytes)?;
    out.flush()
}

/// Sentinel for "no correlation id on the current request".
const NO_MESSAGE_ID: i64 = -1;

/// Correlation id of the request currently being handled. The serial main loop
/// sets this before dispatch so every response can echo `_messageId` back,
/// letting background.js match each response to its originating request instead
/// of falling back to FIFO ordering. Sound only because the host handles
/// exactly one message at a time — see the loop in `main`.
static CURRENT_MESSAGE_ID: AtomicI64 = AtomicI64::new(NO_MESSAGE_ID);

/// Serialize a response, injecting the current `_messageId` when one is set so
/// the extension can correlate it. Falls back to id-less JSON when no id is
/// active or the response is not a JSON object.
fn serialize_response<T: serde::Serialize>(resp: &T) -> String {
    let fallback = || r#"{"ok":false,"error":"serialization failed"}"#.to_string();
    let id = CURRENT_MESSAGE_ID.load(Ordering::Relaxed);
    if id < 0 {
        return serde_json::to_string(resp).unwrap_or_else(|_| fallback());
    }
    match serde_json::to_value(resp) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert("_messageId".to_string(), serde_json::Value::from(id));
            serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_else(|_| fallback())
        }
        Ok(other) => serde_json::to_string(&other).unwrap_or_else(|_| fallback()),
        Err(_) => fallback(),
    }
}

#[cfg(not(test))]
fn send_response<T: serde::Serialize>(resp: &T) {
    let _ = write_message(&serialize_response(resp));
}

#[cfg(test)]
std::thread_local! {
    // Opt-in, thread-local observations keep parallel tests isolated and do
    // not change the production response writer or its error handling.
    static SC0_RESPONSE_CAPTURE: std::cell::RefCell<Option<Vec<String>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn send_response<T: serde::Serialize>(resp: &T) {
    // Exercise serialization (and _messageId injection) without touching stdout.
    let serialized = serialize_response(resp);
    SC0_RESPONSE_CAPTURE.with(|capture| {
        if let Some(responses) = capture.borrow_mut().as_mut() {
            responses.push(serialized);
        }
    });
}

fn send_error(msg: &str) {
    send_response(&ErrorResponse {
        ok: false,
        error: msg.to_string(),
    });
}

// ─── Vault path discovery ───────────────────────────────────────────────────

/// Read vault path from the main app's config file.
/// Location: ~/Library/Application Support/com.mine.app/config.json
///
/// No implicit fallback: folder selection is an explicit user action.
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

    None
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
    resolve_native_vault_layout_at(root, native_app_data_dir()?)
}

fn resolve_native_vault_layout_at(
    root: PathBuf,
    app_state: PathBuf,
) -> Result<VaultLayout, String> {
    let base = VaultLayout::new(root.clone());
    files::validate_vault_write_target(&base, &base.mine_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(base.mine_dir())
        .map_err(|e| format!("failed to create Mine metadata dir: {e}"))?;

    let vault_id = ensure_native_vault_id(&base)?;
    let derived_root = app_state.join("vaults").join(vault_id);
    let write_layout = files::load_vault_write_layout(&base).map_err(|error| error.to_string())?;
    let layout = VaultLayout::with_derived_root(root, derived_root).with_write_layout(write_layout);

    if let Err(error) = bootstrap_native_index_from_legacy(&layout) {
        log::warn!("legacy index bootstrap deferred: {error}");
    } else if let Err(error) = cleanup_native_legacy_vault_artifacts(&layout) {
        log::warn!("legacy derived cleanup deferred: {error}");
    }
    Ok(layout)
}

fn native_app_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.mine.app"))
}

fn ensure_native_vault_id(vault: &VaultLayout) -> Result<String, String> {
    let path = vault.vault_id_path();
    files::validate_vault_write_target(vault, &path).map_err(|e| e.to_string())?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            save_operations::validate_id(trimmed).map_err(|e| e.to_string())?;
            return Ok(trimmed.to_string());
        }
    }

    if let Ok(existing) = std::fs::read_to_string(vault.legacy_vault_id_path()) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            save_operations::validate_id(trimmed).map_err(|e| e.to_string())?;
            files::write_atomically(&path, format!("{trimmed}\n").as_bytes())
                .map_err(|e| format!("failed to migrate vault-id to .mine: {e:#}"))?;
            return Ok(trimmed.to_string());
        }
    }

    let new_id = generate_native_vault_id()?;
    files::write_atomically(&path, format!("{new_id}\n").as_bytes())
        .map_err(|e| format!("failed to write vault-id: {e:#}"))?;
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

fn cleanup_native_legacy_vault_artifacts(vault: &VaultLayout) -> Result<(), String> {
    remove_native_file_if_exists(&vault.legacy_vault_id_path(), "legacy vault-id")?;
    remove_native_file_if_exists(&vault.legacy_index_db_path(), "legacy index db")?;
    for suffix in ["-wal", "-shm"] {
        remove_native_file_if_exists(
            &PathBuf::from(format!(
                "{}{}",
                vault.legacy_index_db_path().display(),
                suffix
            )),
            "legacy sqlite sidecar",
        )?;
    }
    remove_native_file_if_exists(
        &vault.legacy_arena_dir().join(".DS_Store"),
        "legacy metadata .DS_Store",
    )?;
    remove_native_dir_all_if_exists(&vault.legacy_arena_dir().join("cache"), "legacy cache")?;
    remove_native_empty_dir_if_exists(&vault.legacy_arena_dir(), "legacy metadata dir")?;
    Ok(())
}

fn remove_native_file_if_exists(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove {label} {}: {error}",
            path.display()
        )),
    }
}

fn remove_native_dir_all_if_exists(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove {label} {}: {error}",
            path.display()
        )),
    }
}

fn remove_native_empty_dir_if_exists(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(format!(
            "failed to remove empty {label} {}: {error}",
            path.display()
        )),
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

/// Adds a vault path to the shared desktop config's `known_vaults`, keeping
/// the write atomic (tmp + rename) so a concurrently reading desktop app never
/// sees a torn file. Returns the updated list.
fn add_known_vault(path: &str) -> Result<Vec<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let config_dir = PathBuf::from(&home).join("Library/Application Support/com.mine.app");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("cannot create config directory: {e}"))?;
    let config_path = config_dir.join("config.json");
    let mut json: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let mut vaults: Vec<String> = json
        .get("known_vaults")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if !vaults.iter().any(|existing| existing == path) {
        vaults.push(path.to_string());
    }
    json["known_vaults"] = serde_json::json!(vaults);

    let serialized =
        serde_json::to_string_pretty(&json).map_err(|e| format!("cannot serialize config: {e}"))?;
    let tmp_path = config_dir.join("config.json.tmp");
    std::fs::write(&tmp_path, serialized).map_err(|e| format!("cannot write config: {e}"))?;
    std::fs::rename(&tmp_path, &config_path).map_err(|e| format!("cannot commit config: {e}"))?;
    Ok(vaults)
}

/// Shows the native macOS folder chooser and registers the picked folder as a
/// known vault. The clipper cannot open a file dialog itself — extensions have
/// no filesystem UI — so the host, an ordinary local process, asks the system
/// on its behalf via osascript. Cancelling the dialog is a normal outcome, not
/// an error.
fn handle_pick_vault_folder() {
    #[derive(serde::Serialize)]
    struct PickVaultResponse {
        ok: bool,
        cancelled: bool,
        path: Option<String>,
        vaults: Vec<String>,
    }

    let script = concat!(
        "tell application \"System Events\" to activate\n",
        "POSIX path of (choose folder with prompt \"Choose a folder for the Mine space\")",
    );
    let output = match std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
    {
        Ok(output) => output,
        Err(e) => return send_error(&format!("cannot run osascript: {e}")),
    };
    if !output.status.success() {
        // The only non-zero path a plain `choose folder` produces is the user
        // pressing Cancel (-128).
        send_response(&PickVaultResponse {
            ok: true,
            cancelled: true,
            path: None,
            vaults: load_known_vaults(),
        });
        return;
    }
    let picked = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let picked = picked.trim_end_matches('/').to_string();
    if picked.is_empty() || !PathBuf::from(&picked).is_dir() {
        return send_error("folder chooser returned no usable path");
    }
    match add_known_vault(&picked) {
        Ok(vaults) => send_response(&PickVaultResponse {
            ok: true,
            cancelled: false,
            path: Some(picked),
            vaults,
        }),
        Err(e) => send_error(&e),
    }
}

/// Reveals a known vault in Finder. Restricted to paths the config already
/// lists so a compromised page cannot use the clipper bridge to probe or open
/// arbitrary directories.
/// Bring the app to the front, launching it if needed (О3, `Open app`).
///
/// The host answering at all proves the app is installed, and macOS resolves
/// the bundle by identifier, so this works regardless of where the app lives.
/// No space is passed: the app opens on whatever its own binding remembers,
/// and that binding is the authority.
fn handle_open_app() {
    #[derive(serde::Serialize)]
    struct OpenAppResponse {
        ok: bool,
    }
    let status = std::process::Command::new("open")
        .args(["-b", "com.mine.app"])
        .status();
    match status {
        Ok(code) if code.success() => send_response(&OpenAppResponse { ok: true }),
        Ok(code) => send_error(&format!("open exited with {code}")),
        Err(error) => send_error(&format!("failed to launch the app: {error}")),
    }
}

fn handle_reveal_vault(params: serde_json::Value) {
    #[derive(serde::Deserialize)]
    struct RevealVaultParams {
        path: String,
    }
    #[derive(serde::Serialize)]
    struct RevealVaultResponse {
        ok: bool,
    }
    let p: RevealVaultParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(&format!("invalid reveal_vault params: {e}")),
    };
    let mut allowed = load_known_vaults();
    if let Some(current) = load_vault_path() {
        allowed.push(current);
    }
    if !allowed.iter().any(|vault| vault == &p.path) {
        return send_error("path is not a known vault");
    }
    match std::process::Command::new("open")
        .arg("-R")
        .arg(&p.path)
        .status()
    {
        Ok(status) if status.success() => send_response(&RevealVaultResponse { ok: true }),
        Ok(status) => send_error(&format!("open -R exited with {status}")),
        Err(e) => return send_error(&format!("cannot run open: {e}")),
    }
}

fn handle_get_status_with_upload(upload: &Option<UploadServer>, vault_path: Option<String>) {
    let (binding_id, folder_state, error) = match &vault_path {
        None => (None, "unconfigured", None),
        Some(path) => match std::fs::read_dir(path) {
            Ok(_) => match save_operations::binding_id(&VaultLayout::new(PathBuf::from(path))) {
                Ok(id) => (Some(id), "ready", None),
                Err(error) => (None, "unavailable", Some(error.to_string())),
            },
            Err(error) => {
                let state = match error.kind() {
                    std::io::ErrorKind::NotFound => "missing",
                    std::io::ErrorKind::PermissionDenied => "access_denied",
                    _ => "unavailable",
                };
                (None, state, Some(error.to_string()))
            }
        },
    };
    send_response(&StatusResponse {
        ok: true,
        connected: true,
        vault_configured: binding_id.is_some(),
        binding_id,
        executor_id: "native".into(),
        folder_state: folder_state.into(),
        error,
        vault_path,
        version: VERSION.to_string(),
        host_api_version: HOST_API_VERSION,
        features: vec![
            "pending_uploads_v1".into(),
            "save_operation_v1".into(),
            "operation_lookup_v1".into(),
            "open_app_v1".into(),
            "connection_check_v1".into(),
        ],
        upload_port: upload.as_ref().map(|u| u.port),
        upload_token: upload.as_ref().map(|u| u.token.clone()),
    });
}

fn handle_list_channels(vault: &VaultLayout) {
    let conn = match db::open_or_create(&vault.index_db_path()) {
        Ok(c) => c,
        Err(e) => return send_error(&format!("failed to open database: {e}")),
    };

    if let Err(e) = index::backfill_collection_index(&conn, vault) {
        return send_error(&format!("failed to update collection index: {e}"));
    }

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
        infos.push(ChannelInfo { tag, block_count });
    }

    for tag in tags {
        let collection_ref = normalize_collection_ref(&tag.tag);
        if collection_ref.is_empty() || seen.contains(&collection_ref) {
            continue;
        }
        let block_count = counts.get(&collection_ref).copied().unwrap_or(tag.count);
        infos.push(ChannelInfo {
            tag: collection_ref.clone(),
            block_count,
        });
        seen.insert(collection_ref);
    }

    infos
}

fn existing_vault_stems(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
) -> Result<HashSet<String>, String> {
    let mut existing: HashSet<String> = index::list_blocks(conn)
        .map_err(|e| e.to_string())?
        .iter()
        .map(|b| b.slug.clone())
        .collect();
    existing.extend(files::scan_vault_file_stems(vault).map_err(|error| error.to_string())?);
    Ok(existing)
}

fn operation_store(vault: &VaultLayout) -> anyhow::Result<save_operations::SaveOperationStore> {
    let parent = vault
        .derived_root()
        .parent()
        .ok_or_else(|| anyhow::anyhow!("derived state has no parent"))?;
    Ok(save_operations::SaveOperationStore::new(
        parent.join("operations").join("v1"),
    ))
}

fn operation_failure(
    id: &str,
    outcome: &str,
    code: &str,
    error: impl ToString,
) -> serde_json::Value {
    serde_json::json!({ "ok": false, "outcome": outcome, "operation_id": id,
        "code": code, "error": error.to_string() })
}

fn pending_id(p: &SaveBlockParams) -> Option<String> {
    p.pre_uploaded_id.clone().or_else(|| {
        p.pre_uploaded_file
            .as_deref()
            .and_then(clipper_uploads::upload_id_from_legacy_filename)
            .map(str::to_string)
    })
}

fn fingerprint_capture(p: &SaveBlockParams, binding: &str) -> String {
    mine_core::save::request_fingerprint(&serde_json::json!({
        "capture": p, "binding_id": binding, "executor_id": "native"
    }))
}

fn check_binding(params: &serde_json::Value, binding: &str) -> anyhow::Result<()> {
    if params
        .get("binding_id")
        .and_then(|v| v.as_str())
        .is_some_and(|id| id != binding)
    {
        anyhow::bail!("selected folder differs from the operation binding");
    }
    if params
        .get("executor_id")
        .and_then(|v| v.as_str())
        .is_some_and(|id| id != "native")
    {
        anyhow::bail!("operation belongs to another executor");
    }
    Ok(())
}

fn handle_save_block(vault: &VaultLayout, params: serde_json::Value) {
    let response = match operation_store(vault) {
        Ok(store) => save_block_with_store(vault, params, &store),
        Err(error) => operation_failure("", "unknown", "operation_unknown", error),
    };
    send_response(&response);
}

fn save_block_with_store(
    vault: &VaultLayout,
    params: serde_json::Value,
    store: &save_operations::SaveOperationStore,
) -> serde_json::Value {
    let mut p: SaveBlockParams = match serde_json::from_value(params.clone()) {
        Ok(value) => value,
        Err(error) => return operation_failure("", "not_committed", "invalid_request", error),
    };
    if params
        .get("operation_id")
        .is_some_and(|value| !value.is_string())
    {
        return operation_failure(
            "",
            "not_committed",
            "invalid_request",
            "operation_id must be a string",
        );
    }
    let id = params
        .get("operation_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| pending_id(&p))
        .unwrap_or_else(|| generate_native_vault_id().unwrap_or_default());
    if let Err(error) = save_operations::validate_id(&id) {
        return operation_failure(&id, "not_committed", "invalid_request", error);
    }
    let binding = match save_operations::binding_id(vault) {
        Ok(value) => value,
        Err(error) => return operation_failure(&id, "unknown", "binding_unavailable", error),
    };
    if let Err(error) = check_binding(&params, &binding) {
        return operation_failure(&id, "not_committed", "binding_mismatch", error);
    }
    let mode = match params.get("operation_mode") {
        None => "start",
        Some(value) => value.as_str().unwrap_or("invalid"),
    };
    if mode != "start" && mode != "resume" {
        return operation_failure(
            &id,
            "not_committed",
            "invalid_request",
            "invalid operation mode",
        );
    }
    let collection_error =
        match mine_core::save::normalize_collections(p.tags.as_deref().unwrap_or_default()) {
            Ok(tags) => {
                p.tags = Some(tags);
                None
            }
            Err(error) => Some(error),
        };
    let fingerprint = fingerprint_capture(&p, &binding);
    let locked = match store.lock(&binding) {
        Ok(value) => value,
        Err(error) => return operation_failure(&id, "unknown", "operation_unknown", error),
    };
    match locked.load(&id) {
        Ok(Some(mut record)) => {
            if record.fingerprint != fingerprint {
                return operation_failure(
                    &id,
                    "not_committed",
                    "operation_conflict",
                    "operation ID was already used with different content",
                );
            }
            let recovery = if locked.can_resume(&record, vault) {
                locked.publish_plan(&mut record, vault).map(Some)
            } else {
                locked.recovered_response(&mut record, vault)
            };
            return match recovery {
                Ok(Some(response)) => {
                    if response["ok"] == true && response["durability_warning"].is_null() {
                        if let Some(upload) = pending_id(&p) {
                            let _ = clipper_uploads::mark_pending_upload_committed(vault, &upload);
                        }
                    }
                    response
                }
                Ok(None) => operation_failure(
                    &id,
                    "unknown",
                    "operation_unknown",
                    "prior publication cannot be confirmed; original material has been retained",
                ),
                Err(error) => operation_failure(&id, "unknown", "operation_unknown", error),
            };
        }
        Ok(None) if mode == "resume" => {
            return operation_failure(
                &id,
                "unknown",
                "operation_unknown",
                "operation receipt is unavailable",
            )
        }
        Err(error) => return operation_failure(&id, "unknown", "operation_unknown", error),
        Ok(None) => {}
    }
    let mut record = match locked.begin(&id, fingerprint, &serde_json::to_value(&p).unwrap()) {
        Ok(record) => record,
        Err(error) => return operation_failure(&id, "unknown", "operation_unknown", error),
    };
    // Validate semantics before acquiring resources or publishing media. Only
    // this known no-effects boundary produces a durable terminal rejection.
    let validation = collection_error
        .map_or_else(
            || {
                mine_core::save::validate_capture_input(
                    mine_core::save::CaptureIntent::WebClip,
                    &p.block_type,
                    p.body.as_deref().unwrap_or_default(),
                    pending_id(&p).is_some()
                        || p.pre_uploaded_file.is_some()
                        || p.image_url.is_some(),
                )
            },
            Err,
        )
        .map_err(|error| error.to_string())
        .and_then(|_| {
            p.saved_at.as_deref().map_or(Ok(()), |value| {
                DateTime::new(value)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
        });
    if let Err(error) = validation {
        let mut response = operation_failure(&id, "not_committed", "invalid_request", error);
        response["terminal_rejected"] = serde_json::json!(true);
        return match locked.reject(&mut record, response.clone()) {
            Ok(()) => response,
            Err(error) => operation_failure(&id, "unknown", "operation_unknown", error),
        };
    }
    match perform_save_block(vault, p, &locked, &mut record) {
        Ok(response) => response,
        Err(error) if matches!(record.phase, save_operations::OperationPhase::StagingV2) => {
            let mut response = operation_failure(&id, "not_committed", "preparation_failed", error);
            response["terminal_rejected"] = serde_json::json!(true);
            match locked.reject_preparation(&mut record, response.clone()) {
                Ok(()) => response,
                Err(error) => operation_failure(&id, "unknown", "operation_unknown", error),
            }
        }
        // Publication intent is not evidence of absence. No automatic rollback
        // can delete an already published source artifact.
        Err(error) => operation_failure(&id, "unknown", "operation_unknown", error),
    }
}

fn handle_get_save_operation(vault: &VaultLayout, params: serde_json::Value) {
    let id = params
        .get("operation_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let result = (|| -> anyhow::Result<Option<serde_json::Value>> {
        save_operations::validate_id(id)?;
        let binding = save_operations::binding_id(vault)?;
        check_binding(&params, &binding)?;
        let store = operation_store(vault)?;
        let locked = store.lock(&binding)?;
        let Some(mut record) = locked.load(id)? else {
            return Ok(None);
        };
        let response = locked.recovered_response(&mut record, vault)?;
        if response.is_none() && locked.can_resume(&record, vault) {
            return Ok(Some(serde_json::json!({
                "ok": false, "operation_id": id, "outcome": "not_committed",
                "resumable": true,
            })));
        }
        if response
            .as_ref()
            .is_some_and(|value| value["ok"] == true && value["durability_warning"].is_null())
        {
            if let Some(upload) = &record.pending_upload_id {
                if let Err(error) = clipper_uploads::mark_pending_upload_committed(vault, upload) {
                    log::warn!("operation confirmed; staging cleanup deferred: {error:#}");
                }
            }
        }
        Ok(response)
    })();
    send_response(&match result {
        Ok(Some(response)) => response,
        Ok(None) => operation_failure(
            id,
            "unknown",
            "operation_unknown",
            "operation receipt is unavailable",
        ),
        Err(error) => operation_failure(id, "unknown", "operation_unknown", error),
    });
}

fn perform_save_block(
    vault: &VaultLayout,
    p: SaveBlockParams,
    locked: &save_operations::LockedSaveOperations,
    record: &mut save_operations::SaveOperationRecord,
) -> anyhow::Result<serde_json::Value> {
    perform_save_block_with_publisher(vault, p, locked, record, files::copy_new_atomically)
}

fn perform_save_block_with_publisher(
    vault: &VaultLayout,
    p: SaveBlockParams,
    locked: &save_operations::LockedSaveOperations,
    record: &mut save_operations::SaveOperationRecord,
    publish: impl FnMut(&std::path::Path, &std::path::Path) -> anyhow::Result<()>,
) -> anyhow::Result<serde_json::Value> {
    let bt = BlockType::from_str(&p.block_type).map_err(anyhow::Error::msg)?;
    let pending_upload_id = pending_id(&p);
    let existing = files::scan_vault_file_stems(vault)?;
    let name = mine_core::save::select_name(
        vault.write_layout(),
        p.title.as_deref(),
        p.url.as_deref(),
        &existing.into_iter().collect::<Vec<_>>(),
    )?;
    let slug = vault.new_card_slug(&name);
    files::validate_vault_write_target(vault, &vault.block_path(&slug))?;
    record.reserved_name = Some(name.clone());
    record.pending_upload_id = pending_upload_id.clone();
    locked.store(record)?;
    // Acquisition is isolated from source. The same layout yields exact final
    // relative references, but neither downloads nor inline localization can
    // mutate the user's vault before the complete plan is durable.
    let source_vault = vault;
    let staging = VaultLayout::new(locked.create_staging(&record.operation_id)?)
        .with_write_layout(source_vault.write_layout().clone());
    let vault = &staging;
    // Resolve media: pre-uploaded file, data URL, or HTTP download
    let mut media_file = None;
    let mut thumbnail_file = None;
    let mut warning = None;

    if let Some(ref upload_id) = pending_upload_id {
        match clipper_uploads::prepare_pending_upload(source_vault, vault, upload_id, &name) {
            Ok(finalized) => {
                media_file = Some(vault.new_media_stem(&finalized.filename));
            }
            Err(e) => {
                warning = Some(format!("failed to finalize pending upload: {e:#}"));
            }
        }
    } else if let Some(ref uploaded) = p.pre_uploaded_file {
        // Compatibility input only. Its bare filename does not prove staging
        // ownership, so publish a new copy but never remove the original.
        match prepare_legacy_upload(source_vault, vault, uploaded, &name) {
            Ok(final_name) => {
                media_file = Some(vault.new_media_stem(&final_name));
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
                    let dest_name = format!("{}.{}", name, ext);
                    let dest_path = vault.new_media_path(&dest_name);
                    files::validate_vault_write_target(vault, &dest_path)?;
                    match write_new_bytes(&dest_path, &bytes) {
                        Ok(()) => {
                            media_file = Some(vault.new_media_stem(&dest_name));
                        }
                        Err(e) => warning = Some(format!("failed to write screenshot: {e}")),
                    }
                }
                Err(e) => warning = Some(format!("failed to decode data URL: {e}")),
            }
        } else {
            // HTTP URL — download file
            let ext = ext_from_url(image_url);
            let dest_name = format!("{}.{}", name, ext);
            let dest_path = vault.new_media_path(&dest_name);
            files::validate_vault_write_target(vault, &dest_path)?;

            let referer = p.url.as_deref().unwrap_or(image_url);
            match download_file(image_url, &dest_path, referer) {
                Ok(()) => {
                    if bt == BlockType::Video && thumbnails::is_image_ext(&ext) {
                        thumbnail_file = Some(vault.new_media_stem(&dest_name));
                    } else {
                        media_file = Some(vault.new_media_stem(&dest_name));
                    }
                }
                Err(e) => {
                    warning = Some(format!("failed to download media: {e}"));
                }
            }
        }
    }

    // Download inline images (and videos) for article bodies
    let (body, inline_files, unresolved_videos) = {
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

        if !raw.trim().is_empty() {
            let page_url = p.url.as_deref().unwrap_or("");
            localize_body_images(&raw, vault, &name, page_url)
        } else {
            (raw, Vec::new(), Vec::new())
        }
    };

    // A video too large to store leaves the note pointing at someone else's
    // server. Nothing can be done about the video itself here, but its poster
    // is small and always fits, so the feed still gets a real card instead of
    // a text-only one.
    if thumbnail_file.is_none() && !unresolved_videos.is_empty() {
        if let Some(poster_url) = p.video_posters.as_ref().and_then(|posters| {
            posters
                .iter()
                .find(|entry| unresolved_videos.iter().any(|url| url == &entry.video_url))
                .map(|entry| entry.poster_url.clone())
        }) {
            let ext = ext_from_url(&poster_url);
            let dest_name = format!("{name} (poster).{ext}");
            let dest_path = vault.new_media_path(&dest_name);
            files::validate_vault_write_target(vault, &dest_path)?;
            let referer = p.url.as_deref().unwrap_or(&poster_url);
            match download_file(&poster_url, &dest_path, referer) {
                Ok(()) => thumbnail_file = Some(vault.new_media_stem(&dest_name)),
                Err(e) => log::warn!("inline-media: poster download failed err={e}"),
            }
        }
    }

    let block = mine_core::save::build_capture(&mine_core::save::CaptureRequest {
        intent: mine_core::save::CaptureIntent::WebClip,
        slug: slug.clone(),
        block_type: p.block_type.clone(),
        title: p.title,
        description: p.description,
        url: p.url,
        body,
        file: media_file,
        thumbnail: thumbnail_file,
        tags: p.tags.unwrap_or_default(),
        saved_at: p.saved_at.unwrap_or_else(now_iso8601),
        source: Some("web-clipper".into()),
        width: p.width,
        height: p.height,
        author: p.author,
    })?;
    let mut artifacts = inline_files
        .iter()
        .map(|path| save_operations::PlannedArtifact::inspect(vault, path))
        .collect::<anyhow::Result<Vec<_>>>()?;
    for filename in [
        block.frontmatter.file.as_deref(),
        block.frontmatter.thumbnail.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let path = vault.root().join(filename);
        if !artifacts
            .iter()
            .any(|artifact| artifact.source.relative_path == filename)
        {
            artifacts.push(save_operations::PlannedArtifact::inspect(vault, &path)?);
        }
    }
    let response = serde_json::json!({
        "ok": true, "outcome": "committed", "operation_id": record.operation_id,
        "slug": slug, "block_type": p.block_type, "warning": warning,
    });
    let markdown_path = files::write_new_block_file(vault, &block)?;
    locked.prepare_plan(
        record,
        save_operations::StagedSavePlan {
            write_layout: Some(vault.write_layout().clone()),
            markdown: save_operations::PlannedArtifact::inspect(vault, &markdown_path)?,
            media: artifacts,
            response: response.clone(),
        },
    )?;
    let vault = source_vault;
    let committed = locked.publish_plan_with(record, vault, publish)?;
    if committed["ok"] != true {
        // A terminal pre-effect name conflict is a valid protocol response,
        // but is not authority for upload cleanup or disposable-index writes.
        return Ok(committed);
    }
    if let Some(upload) = pending_upload_id.filter(|_| committed["durability_warning"].is_null()) {
        if let Err(error) = clipper_uploads::mark_pending_upload_committed(vault, &upload) {
            log::warn!("capture committed; staging cleanup deferred: {error:#}");
        }
    }
    // The source receipt precedes every disposable-index/preview side effect.
    // Index failures do not change the already confirmed save response.
    match db::open_or_create(&vault.index_db_path()) {
        Ok(conn) => {
            if let Err(error) = index::upsert_block_with_diagnostics(
                &conn,
                &block,
                Some(vault.root()),
                Some("clipper"),
                None,
            ) {
                log::warn!("capture committed; index catch-up deferred: {error:#}");
            }
            let thumb_source = thumbnails::generate_for_block(&block, vault);
            if thumb_source != thumbnails::ThumbSource::None {
                let _ = index::sync_thumb_metadata(
                    &conn,
                    &block.slug,
                    &vault.thumb_path(&block.slug),
                    Some(vault.root()),
                );
            }
        }
        Err(error) => log::warn!("capture committed; index unavailable: {error:#}"),
    }
    Ok(committed)
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
    let tag = match validate_collection_ref(&p.tag) {
        Ok(tag) => tag,
        Err(error) => return send_error(&format!("invalid collection ref: {error}")),
    };

    let mut channel = match Channel::new(&tag, created_at) {
        Ok(channel) => channel,
        Err(e) => return send_error(&format!("invalid channel: {e}")),
    };
    channel.position = match index::next_channel_position(&conn) {
        Ok(position) => position,
        Err(e) => return send_error(&format!("failed to resolve channel position: {e}")),
    };

    let existing = match existing_vault_stems(&conn, vault) {
        Ok(existing) => existing,
        Err(e) => return send_error(&format!("failed to inspect existing vault files: {e}")),
    };
    if existing.contains(&channel.tag) {
        return send_error(&format!("channel file already exists: {}", channel.tag));
    }

    let block = channel_to_block(&channel);
    if let Err(e) = files::write_new_block_file(vault, &block) {
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
            title: None,
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

#[cfg(test)]
fn finalize_uploaded_filename(
    vault: &VaultLayout,
    uploaded: &str,
    final_stem: &str,
) -> Result<String, String> {
    prepare_legacy_upload(vault, vault, uploaded, final_stem)
}

/// Copy a legacy bare-name input into operation-owned staging. It has no
/// ownership token and must remain untouched even after a successful save.
fn prepare_legacy_upload(
    vault: &VaultLayout,
    staging: &VaultLayout,
    uploaded: &str,
    final_stem: &str,
) -> Result<String, String> {
    let vault_root = vault.root();
    if uploaded.is_empty() || uploaded.contains(['/', '\\']) || uploaded == "." || uploaded == ".."
    {
        return Err("legacy upload must be a bare filename".into());
    }
    mine_core::domain::vault::validate_slug(final_stem).map_err(|e| e.to_string())?;
    let src = vault_root.join(uploaded);
    files::validate_vault_write_target(vault, &src).map_err(|e| e.to_string())?;
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
    while !(vault.root() == staging.root() && src == vault.new_media_path(&candidate))
        && (vault.new_media_path(&candidate).exists()
            || mine_lib::storage::media_refs::resolve_basename_under(vault.root(), &candidate)
                .is_some())
    {
        candidate_stem = format!("{final_stem} ({counter})");
        candidate = build_name(&candidate_stem);
        counter = counter
            .checked_add(1)
            .ok_or_else(|| "ran out of collision suffixes".to_string())?;
    }

    if vault.root() == staging.root()
        && uploaded == candidate
        && src == vault.new_media_path(&candidate)
    {
        return Ok(candidate);
    }

    // Legacy input has no staging ownership token. Publish without replacement
    // and preserve its source; arbitrary vault files are not disposable uploads.
    let dest = staging.new_media_path(&candidate);
    files::validate_vault_write_target(staging, &dest).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create media directory: {e}"))?;
    }
    files::copy_new_atomically(&src, &dest)
        .map_err(|e| format!("failed to publish legacy upload to {candidate}: {e}"))?;

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

fn write_new_bytes(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    files::write_new_atomically(path, bytes)
}

fn ext_from_url(url: &str) -> &str {
    ext_from_url_opt(url).unwrap_or("jpg")
}

/// The extension a URL states outright, or `None` when it states none.
///
/// Kept separate from [`ext_from_url`] so callers who can find out what a file
/// actually is — by asking the server — can tell "the URL says jpg" apart from
/// "the URL says nothing and jpg is a guess". API-style URLs such as
/// `.../xrpc/com.atproto.sync.getBlob` are the case that matters: their last
/// dotted segment is a method name, not a file type.
fn ext_from_url_opt(url: &str) -> Option<&str> {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);
    let (_, ext) = path.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || ext.contains('/') {
        return None;
    }
    Some(ext)
}

/// Map a `Content-Type` value to the extension Mine stores media under.
///
/// Only the types the rest of the pipeline can display are mapped; anything
/// else returns `None` so the caller keeps whatever it already assumed.
fn ext_from_content_type(content_type: &str) -> Option<&'static str> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    Some(match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => return None,
    })
}

/// Ask a server what it is about to serve, for URLs that do not say.
///
/// A failure here is not an error: the caller falls back to its own assumption,
/// so a server that refuses HEAD costs nothing beyond one request.
fn probe_ext_over_network(url: &str) -> Option<&'static str> {
    let resp = mine_lib::net::fetch_validated_head(url, INLINE_REQUEST_TIMEOUT, &[]).ok()?;
    ext_from_content_type(resp.header("Content-Type")?)
}

/// Per-request timeout for inline-media downloads. ureq 2.x default is
/// 30s — too long for one stuck CDN to monopolize a worker slot when
/// the parallel pool only has 3 workers serving 15+ images.
const INLINE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Per-request timeout for the Twitter syndication API. Without it a hung
/// `cdn.syndication.twimg.com` would block `save_block` on the serial host
/// until the OS socket timeout.
const TWITTER_API_TIMEOUT: Duration = Duration::from_secs(10);

/// Download a file from URL to local path.
/// `referer` should be the page URL (not the image URL) — CDNs validate this.
/// Retries up to 3 times with backoff. SSRF validation of every redirect hop
/// and the body-size cap live in `mine_lib::net::download_validated_to_file`.
fn download_file(url: &str, dest: &std::path::Path, referer: &str) -> anyhow::Result<()> {
    let headers = [
        ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
        ("Referer", referer),
        ("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"),
    ];
    let mut last_err = None;
    for attempt in 0..3u64 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500 * attempt));
        }
        match net::download_validated_to_file(url, dest, INLINE_REQUEST_TIMEOUT, &headers) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    // The loop runs at least once and only reaches here after recording an
    // error; the fallback message is defensive, not an expected path.
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("download failed with no recorded error")))
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
#[cfg(test)]
fn scan_inline_tasks(body: &str, vault: &VaultLayout, slug: &str) -> Vec<InlineTask> {
    scan_inline_tasks_with(body, vault, slug, &|_| None)
}

/// As [`scan_inline_tasks`], but consulting `probe` for URLs that carry no
/// extension of their own.
///
/// The probe is a parameter so the scan stays a pure function over the body:
/// tests pass one that answers nothing, and only the save path pays for the
/// network round-trip — and only for the rare URL that needs it.
fn scan_inline_tasks_with(
    body: &str,
    vault: &VaultLayout,
    slug: &str,
    probe: &dyn Fn(&str) -> Option<&'static str>,
) -> Vec<InlineTask> {
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

        // A URL that names its own type is trusted; one that does not is asked
        // about, so an API endpoint serving a video is not filed as a JPEG.
        let ext = match ext_from_url_opt(url) {
            Some(ext) => ext,
            None => probe(url).unwrap_or("jpg"),
        };
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
        let basename = build_inline_media_name(slug, kind, idx, ext);
        let dest_path = vault.new_media_path(&basename);
        let dest_name = vault.new_media_stem(&basename);
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
fn apply_rewrites(
    body: &str,
    tasks: &[InlineTask],
    outcomes: &[Result<(), String>],
) -> (String, Vec<std::path::PathBuf>) {
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

    // These artifacts are included in publication evidence. They are never
    // rolled back merely because the Markdown acknowledgement was lost.
    let surviving: Vec<std::path::PathBuf> = tasks
        .iter()
        .enumerate()
        .filter(|(i, _)| outcomes[*i].is_ok() && dedup_target[*i].is_none())
        .map(|(_, task)| task.dest_path.clone())
        .collect();

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
    (result, surviving)
}

/// Localize inline body media. Returns the rewritten body and the paths of the
/// inline files that physically remain on disk for publication verification.
fn localize_body_images(
    body: &str,
    vault: &VaultLayout,
    slug: &str,
    page_url: &str,
) -> (String, Vec<std::path::PathBuf>, Vec<String>) {
    let tasks = scan_inline_tasks_with(body, vault, slug, &probe_ext_over_network);
    if tasks
        .iter()
        .any(|task| files::validate_vault_write_target(vault, &task.dest_path).is_err())
    {
        log::warn!("inline media targets are unsafe; retaining remote references");
        return (body.to_string(), Vec::new(), Vec::new());
    }
    if tasks.is_empty() {
        return (body.to_string(), Vec::new(), Vec::new());
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
    // Video that stayed remote is reported separately: the note now depends on
    // someone else's server for it, and the caller can at least keep a local
    // poster so the feed has something to show.
    let mut unresolved_videos = Vec::new();
    for (task, outcome) in tasks.iter().zip(outcomes.iter()) {
        if let Err(e) = outcome {
            log::warn!("inline-media: download failed url={} err={}", task.url, e);
            if task.kind == InlineMediaKind::Video {
                unresolved_videos.push(task.url.clone());
            }
        }
    }
    let (result, inline_files) = apply_rewrites(body, &tasks, &outcomes);
    log::info!(
        "inline-media: done in {:?}, {}/{} ok",
        started.elapsed(),
        ok,
        tasks.len()
    );
    (result, inline_files, unresolved_videos)
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
    Ok(fetch_tweet_media_previews(tweet_id)?
        .into_iter()
        .filter(|m| m.kind == "video")
        .map(|m| m.src)
        .collect())
}

fn fetch_tweet_media_previews(tweet_id: &str) -> anyhow::Result<Vec<TwitterMediaPreview>> {
    let api_url = format!(
        "https://cdn.syndication.twimg.com/tweet-result?id={}&token=0",
        tweet_id
    );
    let resp = net::fetch_validated_get(
        &api_url,
        TWITTER_API_TIMEOUT,
        &[("User-Agent", "Mozilla/5.0")],
    )?;
    let data: serde_json::Value = resp.into_json()?;

    let mut media_previews = Vec::new();
    if let Some(media) = data.get("mediaDetails").and_then(|v| v.as_array()) {
        for item in media {
            let media_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if media_type == "photo" {
                if let Some(src) = item.get("media_url_https").and_then(|v| v.as_str()) {
                    media_previews.push(TwitterMediaPreview {
                        kind: "image".to_string(),
                        src: format!("{src}?name=large"),
                        poster: Some(src.to_string()),
                        media_type: media_type.to_string(),
                    });
                }
            } else if media_type == "video" || media_type == "animated_gif" {
                if let Some(variants) = item
                    .pointer("/video_info/variants")
                    .and_then(|v| v.as_array())
                {
                    let best = variants
                        .iter()
                        .filter(|v| {
                            v.get("content_type").and_then(|c| c.as_str()) == Some("video/mp4")
                        })
                        .max_by_key(|v| v.get("bitrate").and_then(|b| b.as_u64()).unwrap_or(0));
                    if let Some(variant) = best {
                        if let Some(src) = variant.get("url").and_then(|u| u.as_str()) {
                            media_previews.push(TwitterMediaPreview {
                                kind: "video".to_string(),
                                src: src.to_string(),
                                poster: item
                                    .get("media_url_https")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string()),
                                media_type: media_type.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(media_previews)
}

/// Locate the `yt-dlp` binary.
///
/// The host is launched by the browser, not a shell, so it inherits a minimal
/// PATH — `/usr/bin:/bin:/usr/sbin:/sbin` on macOS. Package managers install
/// outside all of it, so a bare command name resolves to nothing and the whole
/// path fails with "No such file or directory" even on a machine where the tool
/// works fine in a terminal.
fn locate_ytdlp() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec![];
    // The copy that ships with the app, installed next to this host. Checked
    // first so a person who never opened a terminal still gets restricted
    // video. See SPEC_ONBOARDING.md О8.
    if let Some(beside) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("yt-dlp")))
    {
        candidates.push(beside);
    }
    candidates.extend::<Vec<std::path::PathBuf>>(vec![
        "/opt/homebrew/bin/yt-dlp".into(), // Homebrew, Apple silicon
        "/usr/local/bin/yt-dlp".into(),    // Homebrew, Intel; manual installs
        "/opt/local/bin/yt-dlp".into(),    // MacPorts
    ]);
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(&home).join(".local/bin/yt-dlp"));
        candidates.push(std::path::PathBuf::from(&home).join("bin/yt-dlp"));
    }
    // A PATH entry still wins if the caller has one — a deliberate install
    // should override our guesses.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.insert(0, dir.join("yt-dlp"));
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Removes its path on drop, so a live session never outlives the call — including
/// on the error paths below.
struct TempFileGuard(std::path::PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Resolve a tweet's video through `yt-dlp`, using the caller's browser session.
///
/// The public syndication API returns a tombstone for age-restricted posts, and
/// the page keeps such videos behind a `blob:` URL, so neither of the existing
/// paths can reach them. `yt-dlp` can, given the cookies of a session that is
/// allowed to see the post.
///
/// The work is deliberately delegated rather than reimplemented: X's video
/// delivery is a private, undocumented interface that changes on their
/// schedule. `yt-dlp` tracks those changes as its whole purpose, so a break is
/// fixed by updating it instead of by editing Mine.
fn resolve_tweet_video_via_ytdlp(
    tweet_url: &str,
    cookies: &[TwitterCookie],
) -> anyhow::Result<Vec<(String, Option<String>)>> {
    if cookies.is_empty() {
        anyhow::bail!("no browser cookies supplied");
    }

    // Netscape cookie jar — the only format yt-dlp accepts from a file.
    let mut jar = String::from("# Netscape HTTP Cookie File\n");
    for cookie in cookies {
        if cookie.name.contains(['\t', '\n']) || cookie.value.contains(['\t', '\n']) {
            continue;
        }
        jar.push_str(&format!(
            ".x.com\tTRUE\t/\tTRUE\t0\t{}\t{}\n",
            cookie.name, cookie.value
        ));
    }

    // The jar carries a live session, so it is written with owner-only
    // permissions and removed as soon as yt-dlp returns, whatever the outcome.
    let jar_path = std::env::temp_dir().join(format!("mine-x-{}.txt", generate_token()));
    std::fs::write(&jar_path, jar)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&jar_path, std::fs::Permissions::from_mode(0o600))?;
    }
    let _jar_guard = TempFileGuard(jar_path.clone());

    let ytdlp = locate_ytdlp().ok_or_else(|| {
        anyhow::anyhow!(
            "yt-dlp not found. Install it (brew install yt-dlp) so age-restricted \
             posts can be resolved."
        )
    })?;

    let output = std::process::Command::new(&ytdlp)
        .arg("--cookies")
        .arg(&jar_path)
        .arg("--no-warnings")
        .arg("--quiet")
        // Ask for the poster alongside the URL. Without it the preview falls
        // back to the page's og:image, which on a restricted post is X's own
        // "see what's happening" promo card rather than anything from the video.
        .arg("--print")
        .arg("%(url)s\t%(thumbnail)s")
        .arg("-f")
        // Prefer a progressive mp4: the rest of the pipeline downloads a single
        // file by URL and cannot mux separate streams.
        .arg("best[ext=mp4][protocol^=http]/best[ext=mp4]/best")
        .arg(tweet_url)
        .output()
        .map_err(|e| anyhow::anyhow!("yt-dlp is not available: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("yt-dlp failed: {}", err.trim());
    }

    let urls: Vec<(String, Option<String>)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("http"))
        .map(|line| {
            let mut parts = line.splitn(2, '\t');
            let url = parts.next().unwrap_or_default().to_string();
            let poster = parts
                .next()
                .map(str::trim)
                .filter(|value| value.starts_with("http"))
                .map(str::to_string);
            (url, poster)
        })
        .collect();

    if urls.is_empty() {
        anyhow::bail!("no progressive mp4 available for this post");
    }
    Ok(urls)
}

/// Append a line to the host's own log.
///
/// The host talks over stdin/stdout, so anything printed there corrupts the
/// protocol, and stderr disappears into the browser. Without a file there is no
/// way to see what the extension actually asked for.
fn host_log(line: &str) {
    use std::io::Write as _;
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let mut path = std::path::PathBuf::from(home);
    path.push("Library/Logs/com.mine.app");
    let _ = std::fs::create_dir_all(&path);
    path.push("native-host.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn handle_resolve_twitter_media(params: serde_json::Value) {
    let p: ResolveTwitterMediaParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(&format!("invalid resolve_twitter_media params: {e}")),
    };

    let tweet_id = p
        .tweet_id
        .filter(|s| !s.is_empty())
        .or_else(|| p.url.as_deref().and_then(extract_twitter_video_id));

    let Some(tweet_id) = tweet_id else {
        return send_error("Twitter status id is required");
    };

    host_log(&format!(
        "resolve_twitter_media: tweet={} cookies={}",
        tweet_id,
        p.cookies.as_ref().map(|c| c.len()).unwrap_or(0)
    ));

    let previews = fetch_tweet_media_previews(&tweet_id);
    let has_video = previews
        .as_ref()
        .map(|media| media.iter().any(|m| m.kind == "video"))
        .unwrap_or(false);

    // The public API covers everything it is allowed to see. Only when it comes
    // back without video do we spend a subprocess on the authenticated path.
    if !has_video {
        if let Some(cookies) = p.cookies.as_ref().filter(|c| !c.is_empty()) {
            let tweet_url = p
                .url
                .clone()
                .unwrap_or_else(|| format!("https://x.com/i/status/{tweet_id}"));
            match resolve_tweet_video_via_ytdlp(&tweet_url, cookies) {
                Ok(urls) => {
                    host_log(&format!(
                        "resolve_twitter_media: yt-dlp resolved {} url(s)",
                        urls.len()
                    ));
                    let mut media = previews.unwrap_or_default();
                    for (src, poster) in urls {
                        media.push(TwitterMediaPreview {
                            kind: "video".to_string(),
                            src,
                            poster,
                            media_type: "video".to_string(),
                        });
                    }
                    return send_response(&ResolveTwitterMediaResponse { ok: true, media });
                }
                Err(e) => {
                    host_log(&format!("resolve_twitter_media: yt-dlp failed: {e}"));
                    return send_error(&format!("failed to resolve Twitter video: {e}"));
                }
            }
        }
    }

    match previews {
        Ok(media) => send_response(&ResolveTwitterMediaResponse { ok: true, media }),
        Err(e) => send_error(&format!("failed to resolve Twitter media: {e}")),
    }
}

// ─── Main loop ──────────────────────────────────────────────────────────────

// ─── Upload server ─────────────────────────────────────────────────────────

struct UploadServer {
    port: u16,
    token: String,
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return String::new();
    }
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
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
    if token.is_empty() {
        return None;
    }
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
const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

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

#[cfg(test)]
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
    if let Err(e) = request
        .as_reader()
        .take(MAX_UPLOAD_BYTES + 1)
        .read_to_end(&mut body)
    {
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
    if body.len() as u64 > MAX_UPLOAD_BYTES {
        let response = tiny_http::Response::from_string("Upload too large")
            .with_status_code(413)
            .with_header(
                "Access-Control-Allow-Origin: *"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    // Write to local derived pending storage. The source vault is touched only
    // when save_block commits the matching markdown file.
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

    let vault = match resolve_native_vault_layout(PathBuf::from(&vp)) {
        Ok(vault) => vault,
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

    let content_type = request
        .headers()
        .iter()
        .find(|h| h.field.as_str() == "Content-Type" || h.field.as_str() == "content-type")
        .map(|h| h.value.as_str().to_string());
    let manifest =
        match clipper_uploads::write_pending_upload(&vault, &filename, content_type, &body) {
            Ok(manifest) => manifest,
            Err(e) => {
                let response = tiny_http::Response::from_string(format!("Write error: {e:#}"))
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

    let json = serde_json::json!({
        "ok": true,
        "filename": format!("pending:{}", manifest.upload_id),
        "upload_id": manifest.upload_id,
        "size": manifest.size,
    })
    .to_string();
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

fn handle_confirm_connection_check(launch_origin: Option<&str>, params: serde_json::Value) {
    let result = (|| -> anyhow::Result<_> {
        let check_id = params
            .get("check_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("connection-check ID is required"))?;
        let root = native_app_data_dir().map_err(anyhow::Error::msg)?;
        mine_lib::storage::clipper_connection::confirm_connection_check(
            &root,
            launch_origin.unwrap_or_default(),
            check_id,
            VERSION,
            HOST_API_VERSION,
        )
    })();
    match result {
        Ok(record) => send_response(&serde_json::json!({"ok": true, "check_id": record.check_id})),
        Err(error) => send_response(&serde_json::json!({
            "ok": false, "code": "connection_check_failed", "error": error.to_string(),
        })),
    }
}

fn main() {
    // Chromium supplies the caller origin. Request fields cannot impersonate it.
    let launch_origin = std::env::args().nth(1);
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
        // Reset the correlation id; it is set again once the request parses.
        CURRENT_MESSAGE_ID.store(NO_MESSAGE_ID, Ordering::Relaxed);
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

        // Echo this request's correlation id back on every response it produces.
        if let Some(id) = req.params.get("_messageId").and_then(|v| v.as_i64()) {
            CURRENT_MESSAGE_ID.store(id, Ordering::Relaxed);
        }

        // Diagnostic ACK has no vault input or capture side effects.
        if req.action == "confirm_connection_check" {
            handle_confirm_connection_check(launch_origin.as_deref(), req.params);
            continue;
        }

        // Load vault: prefer per-request vault_path, fallback to config
        let vault_path = req.vault_path.clone().or_else(|| load_vault_path());
        if let Some(ref vp) = vault_path {
            if let Ok(mut v) = UPLOAD_VAULT.lock() {
                *v = Some(vp.clone());
            }
        }

        match req.action.as_str() {
            "get_status" => handle_get_status_with_upload(&upload_server, vault_path),
            "list_known_vaults" => handle_list_known_vaults(),
            "pick_vault_folder" => handle_pick_vault_folder(),
            "reveal_vault" => handle_reveal_vault(req.params),
            "open_app" => handle_open_app(),
            "resolve_twitter_media" => handle_resolve_twitter_media(req.params),

            "list_channels" | "save_block" | "create_channel" | "get_save_operation" => {
                let Some(ref vp) = vault_path else {
                    send_error("Choose a vault folder before saving.");
                    continue;
                };
                let path = PathBuf::from(vp);
                // An unavailable selected folder is not permission to create
                // a replacement vault at the same display path.
                if !path.is_dir() {
                    send_error(&format!("Selected vault is unavailable: {vp}"));
                    continue;
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
                    "get_save_operation" => handle_get_save_operation(&vault, req.params),
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

    fn sc0_save_response(vault: &VaultLayout, params: serde_json::Value) -> serde_json::Value {
        SC0_RESPONSE_CAPTURE.with(|capture| {
            assert!(capture.borrow().is_none(), "SC0 captures must not nest");
            *capture.borrow_mut() = Some(Vec::new());
        });
        handle_save_block(vault, params);
        let responses = SC0_RESPONSE_CAPTURE.with(|capture| {
            capture
                .borrow_mut()
                .take()
                .expect("SC0 capture was enabled")
        });
        assert_eq!(responses.len(), 1, "save emits exactly one response");
        serde_json::from_str(&responses[0]).expect("host serializes a valid response")
    }

    fn sc0_image_request(title: &str, upload_id: &str) -> serde_json::Value {
        serde_json::json!({
            "block_type": "image",
            "title": title,
            "pre_uploaded_id": upload_id,
            "body": "",
            "tags": []
        })
    }

    fn sc2_temp_vault() -> (TempDir, VaultLayout) {
        let tmp = TempDir::new().unwrap();
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        (tmp, vault)
    }

    #[test]
    fn sc2_native_capture_keeps_prepared_time_and_canonical_media_reference() {
        let (_tmp, vault) = sc2_temp_vault();
        let vault = vault.with_write_layout(mine_lib::domain::vault::VaultWriteLayout::standard());
        let upload =
            clipper_uploads::write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        let mut request = sc0_image_request("Canonical", &upload.upload_id);
        request["saved_at"] = serde_json::json!("2026-08-31T12:34:56Z");
        assert_eq!(sc0_save_response(&vault, request)["ok"], true);
        let markdown = std::fs::read_to_string(vault.block_path("Cards/Canonical")).unwrap();
        let block = mine_lib::domain::block::parse_block("Cards/Canonical", &markdown).unwrap();
        assert_eq!(
            block.frontmatter.file.as_deref(),
            Some("Media/Canonical.jpg")
        );
        assert!(markdown.contains("[[Media/Canonical.jpg]]"));
        assert!(markdown.contains("2026-08-31T12:34:56Z"));
        let tasks = scan_inline_tasks("![](https://example.com/image.jpg)", &vault, "Inline");
        assert_eq!(tasks[0].dest_name, "Media/Inline (image 1).jpg");
        assert_eq!(
            tasks[0].dest_path,
            vault.new_media_path("Inline (image 1).jpg")
        );
    }

    #[test]
    fn sc2_no_effects_rejection_is_terminal_durable_and_replayable() {
        let (_tmp, vault) = sc2_temp_vault();
        let request = serde_json::json!({"operation_id":"invalid-article", "block_type":"article", "body":"", "tags":[]});
        let first = sc0_save_response(&vault, request.clone());
        assert_eq!(first["terminal_rejected"], true);
        assert_eq!(first["outcome"], "not_committed");
        let mut resume = request;
        resume["operation_mode"] = serde_json::json!("resume");
        assert_eq!(sc0_save_response(&vault, resume)["terminal_rejected"], true);
        assert!(files::scan_md_files(&vault).unwrap().is_empty());
        let store = operation_store(&vault).unwrap();
        let locked = store
            .lock(&save_operations::binding_id(&vault).unwrap())
            .unwrap();
        assert!(matches!(
            locked.load("invalid-article").unwrap().unwrap().phase,
            save_operations::OperationPhase::Rejected { .. }
        ));
    }

    fn sc2_link_request(id: &str) -> serde_json::Value {
        serde_json::json!({"operation_id":id,"block_type":"link","title":"Local link",
            "url":"https://example.com","body":"","tags":[]})
    }

    #[test]
    fn sc2_capture_commits_with_unavailable_sqlite_and_replays_without_index() {
        let (_tmp, vault) = sc2_temp_vault();
        std::fs::write(vault.derived_root(), b"not a directory").unwrap();
        let request = sc2_link_request("index-independent");
        let first = sc0_save_response(&vault, request.clone());
        assert_eq!(first["outcome"], "committed");
        assert!(vault.block_path("Local link").exists());
        let repeated = sc0_save_response(&vault, request);
        assert_eq!(repeated["slug"], first["slug"]);
        assert_eq!(repeated["operation_id"], first["operation_id"]);
        assert_eq!(files::scan_md_files(&vault).unwrap().len(), 1);
    }

    #[test]
    fn sc2_operation_conflict_binding_mismatch_and_absent_resume_do_not_save() {
        let (_tmp, vault) = sc2_temp_vault();
        let request = sc2_link_request("stable-id");
        let first = sc0_save_response(&vault, request.clone());
        assert_eq!(first["ok"], true);
        let original = std::fs::read(vault.block_path("Local link")).unwrap();
        let mut changed = request.clone();
        changed["body"] = serde_json::json!("different semantic content");
        assert_eq!(
            sc0_save_response(&vault, changed)["code"],
            "operation_conflict"
        );
        let mut wrong_binding = request;
        wrong_binding["binding_id"] = serde_json::json!("another-binding");
        assert_eq!(
            sc0_save_response(&vault, wrong_binding)["code"],
            "binding_mismatch"
        );
        let mut resume = sc2_link_request("absent");
        resume["operation_mode"] = serde_json::json!("resume");
        assert_eq!(sc0_save_response(&vault, resume)["outcome"], "unknown");
        assert_eq!(
            std::fs::read(vault.block_path("Local link")).unwrap(),
            original
        );
        assert_eq!(files::scan_md_files(&vault).unwrap().len(), 1);
    }

    #[test]
    fn sc2_publication_then_fsync_error_commits_with_warning_and_keeps_recovery_material() {
        let (_tmp, vault) = sc2_temp_vault();
        let upload =
            clipper_uploads::write_pending_upload(&vault, "shot.jpg", None, b"source media")
                .unwrap();
        let request = sc0_image_request("Uncertain sync", &upload.upload_id);
        let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
        let binding = save_operations::binding_id(&vault).unwrap();
        {
            let store = operation_store(&vault).unwrap();
            let locked = store.lock(&binding).unwrap();
            let mut record = locked
                .begin(
                    &upload.upload_id,
                    fingerprint_capture(&p, &binding),
                    &request,
                )
                .unwrap();
            let response = perform_save_block_with_publisher(
                &vault,
                p,
                &locked,
                &mut record,
                |staged, path| {
                    files::copy_new_atomically(staged, path)?;
                    if path.extension().is_none_or(|ext| ext != "md") {
                        return Ok(());
                    }
                    Err(files::PublicationUncertain {
                        path: path.to_path_buf(),
                        source: anyhow::anyhow!("injected directory fsync failure"),
                    }
                    .into())
                },
            )
            .unwrap();
            assert_eq!(response["outcome"], "committed");
            assert!(response["durability_warning"]
                .as_str()
                .unwrap()
                .contains("fsync"));
            assert!(locked.staging_root(&upload.upload_id).unwrap().exists());
            assert!(matches!(
                locked.load(&upload.upload_id).unwrap().unwrap().phase,
                save_operations::OperationPhase::Committed { .. }
            ));
        }
        assert_eq!(
            std::fs::read(vault.new_media_path("Uncertain sync.jpg")).unwrap(),
            b"source media"
        );
        assert!(
            clipper_uploads::pending_upload_dir(&vault, &upload.upload_id)
                .unwrap()
                .join("shot.jpg")
                .exists()
        );
        SC0_RESPONSE_CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
        handle_get_save_operation(&vault, serde_json::json!({"operation_id":upload.upload_id}));
        let responses = SC0_RESPONSE_CAPTURE.with(|capture| capture.borrow_mut().take().unwrap());
        let looked_up: serde_json::Value = serde_json::from_str(&responses[0]).unwrap();
        assert_eq!(looked_up["outcome"], "committed");
        assert!(
            clipper_uploads::pending_upload_dir(&vault, &upload.upload_id)
                .unwrap()
                .join("shot.jpg")
                .exists()
        );
        let recovered = sc0_save_response(&vault, request);
        assert_eq!(recovered["outcome"], "committed");
        assert_eq!(recovered["slug"], "Uncertain sync");
        assert_eq!(files::scan_md_files(&vault).unwrap().len(), 1);
        assert_eq!(
            std::fs::read(vault.new_media_path("Uncertain sync.jpg")).unwrap(),
            b"source media"
        );
    }

    #[test]
    fn sc2_preparing_retry_retains_unknown_material_without_another_write() {
        let (_tmp, vault) = sc2_temp_vault();
        let request = sc2_link_request("interrupted-preparation");
        let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
        let binding = save_operations::binding_id(&vault).unwrap();
        {
            let store = operation_store(&vault).unwrap();
            let locked = store.lock(&binding).unwrap();
            let mut record = locked
                .begin(
                    "interrupted-preparation",
                    fingerprint_capture(&p, &binding),
                    &request,
                )
                .unwrap();
            // Persist an actual legacy phase, whose old acquisition could
            // already have written source. New staging_v2 has different facts.
            record.phase = save_operations::OperationPhase::Preparing;
            locked.store(&record).unwrap();
        }
        let orphan = vault.root().join("Unconfirmed media.jpg");
        std::fs::write(&orphan, b"unconfirmed").unwrap();
        let retry = sc0_save_response(&vault, request);
        assert_eq!(retry["outcome"], "unknown");
        assert_eq!(std::fs::read(&orphan).unwrap(), b"unconfirmed");
        assert!(files::scan_md_files(&vault).unwrap().is_empty());
    }

    #[test]
    fn sc2_staging_v2_interruption_is_terminal_without_source_effects_or_material_loss() {
        let (_tmp, vault) = sc2_temp_vault();
        let request = sc2_link_request("staging-interrupted");
        let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
        let binding = save_operations::binding_id(&vault).unwrap();
        let staging;
        {
            let store = operation_store(&vault).unwrap();
            let locked = store.lock(&binding).unwrap();
            locked
                .begin(
                    "staging-interrupted",
                    fingerprint_capture(&p, &binding),
                    &request,
                )
                .unwrap();
            staging = locked.create_staging("staging-interrupted").unwrap();
            files::write_new_atomically(&staging.join("partial.jpg"), b"acquired bytes").unwrap();
        }
        let response = sc0_save_response(&vault, request.clone());
        assert_eq!(response["outcome"], "not_committed");
        assert_eq!(response["terminal_rejected"], true);
        assert_eq!(response, sc0_save_response(&vault, request.clone()));
        assert_eq!(
            std::fs::read(staging.join("partial.jpg")).unwrap(),
            b"acquired bytes"
        );
        let stored: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                staging
                    .parent()
                    .unwrap()
                    .join("staging-interrupted.request.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(stored, request);
        assert_eq!(std::fs::read_dir(vault.root()).unwrap().count(), 0);
    }

    #[test]
    fn sc2_prepared_name_conflict_releases_pin_and_lookup_replays_terminal_response() {
        for lookup_first in [false, true] {
            let (_tmp, vault) = sc2_temp_vault();
            let request = sc2_link_request("prepared-conflict");
            let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
            let binding = save_operations::binding_id(&vault).unwrap();
            let staging_root;
            {
                let store = operation_store(&vault).unwrap();
                let locked = store.lock(&binding).unwrap();
                let mut record = locked
                    .begin(
                        "prepared-conflict",
                        fingerprint_capture(&p, &binding),
                        &request,
                    )
                    .unwrap();
                staging_root = locked.create_staging("prepared-conflict").unwrap();
                let staging = VaultLayout::new(staging_root.clone());
                let path = staging.root().join("Local link.md");
                files::write_new_atomically(&path, b"prepared capture").unwrap();
                locked.prepare_plan(&mut record, save_operations::StagedSavePlan {
                    write_layout: Some(vault.write_layout().clone()),
                    markdown: save_operations::PlannedArtifact::inspect(&staging, &path).unwrap(),
                    media: vec![], response: serde_json::json!({"ok":true,"outcome":"committed","slug":"Local link"}),
                }).unwrap();
            }
            files::write_new_atomically(&vault.block_path("Local link"), b"foreign Markdown")
                .unwrap();
            let lookup = || {
                SC0_RESPONSE_CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
                handle_get_save_operation(
                    &vault,
                    serde_json::json!({"operation_id":"prepared-conflict"}),
                );
                let captured =
                    SC0_RESPONSE_CAPTURE.with(|capture| capture.borrow_mut().take().unwrap());
                serde_json::from_str::<serde_json::Value>(&captured[0]).unwrap()
            };
            let response = if lookup_first {
                lookup()
            } else {
                sc0_save_response(&vault, request.clone())
            };
            assert_eq!(response["ok"], false);
            assert_eq!(response["outcome"], "not_committed");
            assert_eq!(response["terminal_rejected"], true);
            assert_eq!(response["code"], "name_conflict");
            assert_eq!(lookup(), response);
            assert_eq!(sc0_save_response(&vault, request), response);
            assert_eq!(
                std::fs::read(vault.block_path("Local link")).unwrap(),
                b"foreign Markdown"
            );
            assert!(staging_root.join("Local link.md").exists());
            assert!(staging_root
                .parent()
                .unwrap()
                .join("prepared-conflict.request.json")
                .exists());
            assert!(!vault.index_db_path().exists());
            // The terminal flag permits an explicit new Save, not silent
            // re-publication of the old operation with a different filename.
            let next = sc0_save_response(&vault, sc2_link_request("explicit-new-save"));
            assert_eq!(next["outcome"], "committed");
            assert_eq!(next["slug"], "Local link (2)");
            assert_eq!(
                std::fs::read(vault.block_path("Local link")).unwrap(),
                b"foreign Markdown"
            );
        }
    }

    #[test]
    fn sc2_failed_resource_preparation_preserves_request_and_never_publishes() {
        let (_tmp, vault) = sc2_temp_vault();
        let request = serde_json::json!({
            "operation_id":"decode-failed", "block_type":"image", "title":"Broken data",
            "image_url":"data:image/png;base64,NOT-BASE64", "body":"captured original body",
        });
        let response = sc0_save_response(&vault, request.clone());
        assert_eq!(response["outcome"], "not_committed");
        assert_eq!(response["terminal_rejected"], true);
        let store = operation_store(&vault).unwrap();
        let locked = store
            .lock(&save_operations::binding_id(&vault).unwrap())
            .unwrap();
        let staging = locked.staging_root("decode-failed").unwrap();
        let stored: serde_json::Value = serde_json::from_slice(
            &std::fs::read(staging.parent().unwrap().join("decode-failed.request.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored["body"], request["body"]);
        assert!(staging.is_dir());
        assert_eq!(std::fs::read_dir(vault.root()).unwrap().count(), 0);
    }

    #[test]
    fn sc2_host_stages_pending_bytes_and_prepared_time_before_first_source_effect() {
        let (_tmp, vault) = sc2_temp_vault();
        let vault = vault.with_write_layout(mine_lib::domain::vault::VaultWriteLayout::standard());
        let upload =
            clipper_uploads::write_pending_upload(&vault, "input.png", None, b"pending bytes")
                .unwrap();
        let mut request = sc0_image_request("Prepared capture", &upload.upload_id);
        request["saved_at"] = serde_json::json!("2026-08-31T12:34:56Z");
        let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
        let binding = save_operations::binding_id(&vault).unwrap();
        let store = operation_store(&vault).unwrap();
        let locked = store.lock(&binding).unwrap();
        let mut record = locked
            .begin(
                &upload.upload_id,
                fingerprint_capture(&p, &binding),
                &request,
            )
            .unwrap();
        let mut observed = false;
        assert!(
            perform_save_block_with_publisher(&vault, p, &locked, &mut record, |_, _| {
                let disk = locked.load(&upload.upload_id)?.unwrap();
                let save_operations::OperationPhase::PlannedV2 { step, plan } = &disk.phase else {
                    panic!("plan absent")
                };
                assert_eq!(*step, mine_core::save::SavePhase::MediaPublishing);
                assert_eq!(
                    plan.markdown.source.relative_path,
                    "Cards/Prepared capture.md"
                );
                assert_eq!(
                    plan.media[0].source.relative_path,
                    "Media/Prepared capture.png"
                );
                let staging = locked.staging_root(&upload.upload_id)?;
                let markdown =
                    std::fs::read_to_string(staging.join(&plan.markdown.staged_resource))?;
                assert!(markdown.contains("2026-08-31T12:34:56Z"));
                assert!(markdown.contains("Media/Prepared capture.png"));
                assert_eq!(
                    std::fs::read(staging.join(&plan.media[0].staged_resource))?,
                    b"pending bytes"
                );
                assert_eq!(std::fs::read_dir(vault.root())?.count(), 1);
                assert!(vault.write_layout_path().is_file());
                observed = true;
                anyhow::bail!("injected first source effect boundary")
            })
            .is_err()
        );
        assert!(observed);
        assert!(
            clipper_uploads::pending_upload_dir(&vault, &upload.upload_id)
                .unwrap()
                .join("input.png")
                .exists()
        );
        assert_eq!(std::fs::read_dir(vault.root()).unwrap().count(), 1);
        assert!(vault.write_layout_path().is_file());
    }

    #[test]
    fn sc2_two_distinct_captures_keep_standard_layout_after_fresh_native_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let state = temp.path().join("app-state");
        std::fs::create_dir(&root).unwrap();
        for title in ["A", "B"] {
            let vault = resolve_native_vault_layout_at(root.clone(), state.clone()).unwrap();
            assert_eq!(
                vault.write_layout(),
                &mine_lib::domain::vault::VaultWriteLayout::standard()
            );
            let mut request = sc2_link_request(&format!("capture-{title}"));
            request["title"] = serde_json::json!(title);
            let response = sc0_save_response(&vault, request);
            assert_eq!(response["outcome"], "committed");
            assert_eq!(response["slug"], format!("Cards/{title}"));
            assert!(root.join(format!("Cards/{title}.md")).is_file());
            assert!(!root.join(format!("{title}.md")).exists());
        }
        assert!(root.join(".mine/layout.json").is_file());
        // No requirement to create unused role directories just to influence
        // a heuristic: the saved layout is the authority on the next launch.
        assert!(!root.join("Collections").exists());
    }

    #[test]
    fn sc2_concurrent_same_id_capture_returns_one_receipt_and_one_card() {
        let (_tmp, vault) = sc2_temp_vault();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let vault = vault.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let store = operation_store(&vault).unwrap();
                    barrier.wait();
                    save_block_with_store(&vault, sc2_link_request("concurrent"), &store)
                })
            })
            .collect();
        let responses: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(responses[0]["outcome"], "committed");
        assert_eq!(responses[0], responses[1]);
        assert_eq!(files::scan_md_files(&vault).unwrap().len(), 1);
    }

    #[test]
    fn sc2_status_distinguishes_connection_from_folder_and_uses_selected_binding() {
        let (_tmp, vault) = sc2_temp_vault();
        for (path, expected) in [
            (None, "unconfigured"),
            (
                Some(vault.root().join("missing").to_string_lossy().into_owned()),
                "missing",
            ),
            (Some(vault.root().to_string_lossy().into_owned()), "ready"),
        ] {
            SC0_RESPONSE_CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
            handle_get_status_with_upload(&None, path);
            let responses =
                SC0_RESPONSE_CAPTURE.with(|capture| capture.borrow_mut().take().unwrap());
            let response: serde_json::Value = serde_json::from_str(&responses[0]).unwrap();
            assert_eq!(response["ok"], true);
            assert_eq!(response["connected"], true);
            assert_eq!(response["folder_state"], expected);
            assert_eq!(response["vaultConfigured"], expected == "ready");
            if expected == "ready" {
                assert_eq!(
                    response["binding_id"],
                    save_operations::binding_id(&vault).unwrap()
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn sc2_legacy_symlink_and_traversal_inputs_are_rejected() {
        let (tmp, vault) = sc2_temp_vault();
        let sentinel = tmp.path().join("outside.jpg");
        std::fs::write(&sentinel, b"outside").unwrap();
        std::os::unix::fs::symlink(&sentinel, vault.root().join("upload.jpg")).unwrap();
        assert!(finalize_uploaded_filename(&vault, "upload.jpg", "Card").is_err());
        assert!(finalize_uploaded_filename(&vault, "../outside.jpg", "Card").is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"outside");
        assert!(!vault.new_media_path("Card.jpg").exists());
    }

    #[test]
    fn sc0_n3_lost_response_replays_receipt_after_payload_cleanup() {
        // Capture/discard simulates client acknowledgement loss, not a real
        // stdout/pipe fault. The retry exercises the durable native receipt.
        let tmp = TempDir::new().expect("create disposable SC0 directory");
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).expect("create disposable vault");
        let bytes = b"SC0 screenshot payload";
        let upload = clipper_uploads::write_pending_upload(&vault, "shot.jpg", None, bytes)
            .expect("stage disposable upload");
        let request = sc0_image_request("SC0 receipt", &upload.upload_id);

        let lost_response = sc0_save_response(&vault, request.clone());
        assert_eq!(lost_response["ok"], true);
        assert_eq!(lost_response["slug"], "SC0 receipt");
        let original_markdown =
            std::fs::read(vault.block_path("SC0 receipt")).expect("first save published Markdown");
        let staged = clipper_uploads::pending_upload_dir(&vault, &upload.upload_id).unwrap();
        assert!(staged.join("manifest.json").exists());
        assert!(!staged.join("shot.jpg").exists());

        let retry = sc0_save_response(&vault, request);
        assert_eq!(retry["ok"], true);
        assert_eq!(retry["slug"], lost_response["slug"]);
        assert_eq!(retry["operation_id"], lost_response["operation_id"]);
        assert_eq!(files::scan_md_files(&vault).expect("count cards").len(), 1);
        assert_eq!(
            std::fs::read(vault.block_path("SC0 receipt")).expect("reread first card"),
            original_markdown
        );
        assert_eq!(
            std::fs::read(vault.new_media_path("SC0 receipt.jpg")).expect("read first media"),
            bytes
        );

        let fresh_upload = clipper_uploads::write_pending_upload(&vault, "shot.jpg", None, bytes)
            .expect("stage same material under a fresh ID");
        let fresh_response = sc0_save_response(
            &vault,
            sc0_image_request("SC0 receipt", &fresh_upload.upload_id),
        );
        assert_eq!(fresh_response["ok"], true);
        assert_eq!(fresh_response["slug"], "SC0 receipt (2)");
        assert_eq!(files::scan_md_files(&vault).expect("count cards").len(), 2);
        eprintln!(
            "SC0 N3 regression: lost response replays same receipt after payload cleanup; only a distinct operation creates another card"
        );
    }

    #[test]
    fn sc0_n4_reconstructed_post_markdown_state_recovers_same_receipt() {
        // State reconstruction, NOT a kill or power-loss test. A journaled
        // publishing intent plus matching source bytes recovers one receipt.
        let tmp = TempDir::new().expect("create disposable SC0 directory");
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).expect("create disposable vault");
        let bytes = b"SC0 reconstructed payload";
        let upload = clipper_uploads::write_pending_upload(&vault, "shot.jpg", None, bytes)
            .expect("stage disposable upload");
        let finalized =
            clipper_uploads::finalize_pending_upload(&vault, &upload.upload_id, "SC0 crash")
                .expect("publish original media");
        assert_eq!(finalized.filename, "SC0 crash.jpg");
        let block = mine_lib::domain::block::parse_block(
            "SC0 crash",
            "---\nfile: \"[[SC0 crash.jpg]]\"\nsaved_at: 2026-08-31T12:00:00Z\nsource: web-clipper\n---\n",
        )
        .expect("parse reconstructed committed card");
        files::write_new_block_file(&vault, &block).expect("publish original Markdown");
        let original_markdown =
            std::fs::read(vault.block_path("SC0 crash")).expect("read original Markdown");
        assert!(
            clipper_uploads::pending_upload_dir(&vault, &upload.upload_id)
                .expect("locate retained staging")
                .exists()
        );

        let request = sc0_image_request("SC0 crash", &upload.upload_id);
        let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
        let binding = save_operations::binding_id(&vault).unwrap();
        let expected = serde_json::json!({"ok": true, "outcome": "committed",
            "operation_id": upload.upload_id, "slug": "SC0 crash", "block_type": "image", "warning": null});
        {
            let store = operation_store(&vault).unwrap();
            let locked = store.lock(&binding).unwrap();
            let mut record = locked
                .begin(
                    &upload.upload_id,
                    fingerprint_capture(&p, &binding),
                    &request,
                )
                .unwrap();
            record.phase = save_operations::OperationPhase::Publishing {
                markdown: save_operations::SourceArtifact::inspect(
                    &vault,
                    &vault.block_path("SC0 crash"),
                )
                .unwrap(),
                media: vec![save_operations::SourceArtifact::inspect(
                    &vault,
                    &vault.new_media_path("SC0 crash.jpg"),
                )
                .unwrap()],
                response: expected.clone(),
            };
            locked.store(&record).unwrap();
        }

        let retry = sc0_save_response(&vault, request);

        assert_eq!(retry["ok"], true);
        assert_eq!(retry["slug"], "SC0 crash");
        assert_eq!(files::scan_md_files(&vault).expect("count cards").len(), 1);
        assert_eq!(
            std::fs::read(vault.block_path("SC0 crash")).expect("reread original Markdown"),
            original_markdown
        );
        for filename in ["SC0 crash.jpg"] {
            assert_eq!(
                std::fs::read(vault.new_media_path(filename)).expect("read media"),
                bytes
            );
        }
        eprintln!(
            "SC0 N4 regression simulation: publishing intent plus matching Markdown/media recovers SC0 crash without a duplicate"
        );
    }

    #[test]
    fn sc0_n5_legacy_upload_preserves_occupied_configured_media_folder() {
        let tmp = TempDir::new().expect("create disposable SC0 directory");
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"))
                .with_write_layout(mine_lib::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.media_dir()).expect("create disposable media folder");
        let destination = vault.new_media_path("Door.jpg");
        std::fs::write(&destination, b"existing media sentinel").expect("seed occupied target");
        let upload = vault.root().join("upload.jpg");
        std::fs::write(&upload, b"new upload sentinel").expect("seed legacy upload");

        let filename = finalize_uploaded_filename(&vault, "upload.jpg", "Door")
            .expect("observe current legacy rename");

        assert_eq!(filename, "Door (2).jpg");
        assert_eq!(
            std::fs::read(&destination).expect("read occupied target"),
            b"existing media sentinel"
        );
        assert_eq!(
            std::fs::read(vault.new_media_path(&filename)).unwrap(),
            b"new upload sentinel"
        );
        assert!(
            upload.exists(),
            "legacy input has no disposable staging ownership token"
        );
        eprintln!(
            "SC0 N5 regression: existing Media/Door.jpg preserved; new bytes published as Door (2).jpg; unowned legacy input retained"
        );
    }

    #[test]
    fn serialize_response_message_id_echo() {
        // CRIT-7: the host must echo _messageId so background.js can match each
        // response to its originating request instead of falling back to FIFO
        // order. Before this fix the host never echoed the id and this would
        // fail. Only this test mutates CURRENT_MESSAGE_ID, so it is self-contained.
        CURRENT_MESSAGE_ID.store(42, Ordering::Relaxed);
        let with_id = serialize_response(&ErrorResponse {
            ok: false,
            error: "boom".to_string(),
        });
        assert!(with_id.contains("\"_messageId\":42"), "got: {with_id}");
        assert!(with_id.contains("\"error\":\"boom\""));

        CURRENT_MESSAGE_ID.store(NO_MESSAGE_ID, Ordering::Relaxed);
        let without_id = serialize_response(&ErrorResponse {
            ok: false,
            error: "x".to_string(),
        });
        assert!(!without_id.contains("_messageId"), "got: {without_id}");
    }

    fn test_channel(tag: &str) -> Channel {
        Channel::new(tag, test_dt()).unwrap()
    }

    #[test]
    fn merge_channels_and_tags_includes_empty_promoted_channel() {
        let infos = merge_channels_and_tags(vec![test_channel("empty-channel")], vec![]);

        assert_eq!(
            infos,
            vec![ChannelInfo {
                tag: "empty-channel".to_string(),
                block_count: 0,
            }]
        );
    }

    #[test]
    fn merge_channels_and_tags_uses_promoted_tag_count() {
        let infos = merge_channels_and_tags(
            vec![test_channel("design")],
            vec![index::TagCount {
                tag: "design".to_string(),
                count: 3,
            }],
        );

        assert_eq!(
            infos,
            vec![ChannelInfo {
                tag: "design".to_string(),
                block_count: 3,
            }]
        );
    }

    #[test]
    fn merge_channels_and_tags_preserves_promoted_collection_ref() {
        let infos = merge_channels_and_tags(
            vec![test_channel("Красивый веб")],
            vec![index::TagCount {
                tag: "Красивый веб".to_string(),
                count: 4,
            }],
        );

        assert_eq!(
            infos,
            vec![ChannelInfo {
                tag: "Красивый веб".to_string(),
                block_count: 4,
            }]
        );
    }

    #[test]
    fn merge_channels_and_tags_keeps_distinct_collection_refs() {
        let infos = merge_channels_and_tags(
            vec![test_channel("Красивый веб"), test_channel("красивый-веб")],
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
                    block_count: 0,
                },
                ChannelInfo {
                    tag: "красивый-веб".to_string(),
                    block_count: 4,
                },
            ]
        );
    }

    #[test]
    fn merge_channels_and_tags_keeps_unpromoted_used_tags() {
        let infos = merge_channels_and_tags(
            vec![test_channel("design")],
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
                    block_count: 1,
                },
                ChannelInfo {
                    tag: "local-first".to_string(),
                    block_count: 2,
                },
            ]
        );
    }

    #[test]
    fn finalize_copies_legacy_input_to_slug_without_deleting_unowned_source() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"image-bytes");

        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "upload.jpg",
            "Hello World",
        );

        assert_eq!(result, Ok("Hello World.jpg".to_string()));
        assert!(tmp.path().join("upload.jpg").exists());
        assert!(tmp.path().join("Hello World.jpg").exists());
    }

    #[test]
    fn finalize_preserves_extension_including_multi_char() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.webp", b"x");
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "upload.webp",
            "Photo",
        );
        assert_eq!(result, Ok("Photo.webp".to_string()));
    }

    #[test]
    fn finalize_preserves_unicode_slug() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"x");
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "upload.jpg",
            "Закат в Токио",
        );
        assert_eq!(result, Ok("Закат в Токио.jpg".to_string()));
        assert!(tmp.path().join("Закат в Токио.jpg").exists());
    }

    #[test]
    fn finalize_noop_when_names_already_match() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "Hello.jpg", b"x");
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "Hello.jpg",
            "Hello",
        );
        assert_eq!(result, Ok("Hello.jpg".to_string()));
        // Source still exists, not renamed to anything else.
        assert!(tmp.path().join("Hello.jpg").exists());
    }

    #[test]
    fn finalize_errors_when_source_missing() {
        let tmp = TempDir::new().unwrap();
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "missing.jpg",
            "Slug",
        );
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
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "upload.jpg",
            "Hello",
        );
        assert_eq!(result, Ok("Hello (2).jpg".to_string()));
        // Original is left intact.
        assert_eq!(
            std::fs::read(tmp.path().join("Hello.jpg")).unwrap(),
            b"existing"
        );
        // Legacy input copied onto the deduped name.
        assert_eq!(
            std::fs::read(tmp.path().join("Hello (2).jpg")).unwrap(),
            b"new"
        );
        assert!(tmp.path().join("upload.jpg").exists());
    }

    #[test]
    fn finalize_walks_counter_past_multiple_collisions() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload.jpg", b"new");
        make_staging(tmp.path(), "Hello.jpg", b"x");
        make_staging(tmp.path(), "Hello (2).jpg", b"x");
        make_staging(tmp.path(), "Hello (3).jpg", b"x");
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "upload.jpg",
            "Hello",
        );
        assert_eq!(result, Ok("Hello (4).jpg".to_string()));
    }

    #[test]
    fn finalize_handles_file_without_extension() {
        let tmp = TempDir::new().unwrap();
        make_staging(tmp.path(), "upload", b"x");
        let result = finalize_uploaded_filename(
            &VaultLayout::new(tmp.path().to_path_buf()),
            "upload",
            "Plain",
        );
        assert_eq!(result, Ok("Plain".to_string()));
        assert!(tmp.path().join("Plain").exists());
    }

    #[test]
    fn ytdlp_is_found_outside_the_browser_launch_path() {
        // The browser hands the host a minimal PATH, so a bare command name
        // resolves to nothing even where the tool is installed. Locating it by
        // known install prefixes is what makes the feature work at all.
        let original = std::env::var("PATH").ok();
        // SAFETY: single-threaded test; PATH is restored before returning.
        unsafe { std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin") };

        let located = locate_ytdlp();

        match original {
            Some(path) => unsafe { std::env::set_var("PATH", path) },
            None => unsafe { std::env::remove_var("PATH") },
        }

        if let Some(found) = located {
            assert!(
                found.is_file(),
                "located path must exist: {}",
                found.display()
            );
        }
        // Absence is a valid outcome on a machine without yt-dlp; the contract
        // under test is that a stripped PATH alone does not hide it.
    }

    #[test]
    fn ytdlp_video_resolution_requires_browser_cookies() {
        // Without a session there is nothing yt-dlp could do that the public
        // API has not already tried, so the call is refused before spawning a
        // process.
        let err = resolve_tweet_video_via_ytdlp("https://x.com/i/status/1", &[])
            .expect_err("empty cookie jar must be refused");
        assert!(err.to_string().contains("no browser cookies"));
    }

    #[test]
    fn ytdlp_cookie_jar_never_outlives_the_call() {
        // The jar holds a live session. Whatever happens to the subprocess, the
        // file must be gone when the call returns.
        let before: Vec<_> = std::fs::read_dir(std::env::temp_dir())
            .expect("temp dir readable")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("mine-x-"))
            .collect();

        let cookies = vec![TwitterCookie {
            name: "auth_token".to_string(),
            value: "test".to_string(),
        }];
        // Resolution itself is expected to fail here — there is no such tweet
        // and yt-dlp may be absent; the guarantee under test is the cleanup.
        let _ = resolve_tweet_video_via_ytdlp("https://x.com/i/status/1", &cookies);

        let after: Vec<_> = std::fs::read_dir(std::env::temp_dir())
            .expect("temp dir readable")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("mine-x-"))
            .collect();
        assert_eq!(before.len(), after.len(), "cookie jar left behind");
    }

    #[test]
    fn existing_vault_stems_includes_disk_only_markdown_and_media() {
        let tmp = TempDir::new().unwrap();
        let vault = VaultLayout::new(tmp.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();

        std::fs::write(vault.block_path("Disk Only"), "---\n---").unwrap();
        std::fs::write(vault.media_path("Orphan Media", "jpg"), b"image").unwrap();

        let existing = existing_vault_stems(&conn, &vault).unwrap();

        assert!(existing.contains("Disk Only"));
        assert!(existing.contains("Orphan Media"));
    }

    #[test]
    fn save_block_with_pending_upload_indexes_block_immediately() {
        let tmp = TempDir::new().unwrap();
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();

        let upload = clipper_uploads::write_pending_upload(
            &vault,
            "shot.jpg",
            Some("image/jpeg".into()),
            b"jpg",
        )
        .unwrap();

        handle_save_block(
            &vault,
            serde_json::json!({
                "block_type": "image",
                "title": "Door Link",
                "url": "https://door.link",
                "pre_uploaded_id": upload.upload_id,
                "body": "",
                "tags": []
            }),
        );

        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let media_file: String = conn
            .query_row(
                "SELECT media_file FROM blocks WHERE slug = ?1",
                ["Door Link"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(media_file, "Door Link.jpg");
        assert!(vault.block_path("Door Link").exists());
        assert!(vault.root().join("Door Link.jpg").exists());
    }

    #[test]
    fn clipping_the_same_page_twice_into_a_cards_folder_makes_a_second_card() {
        // The reported failure, end to end: the first clip creates
        // `Cards/Inspora`, and the second used to keep the name `Inspora`,
        // resolve it to the same taken path and die on "failed to create block
        // file". Both clips must land.
        let tmp = TempDir::new().unwrap();
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"))
                .with_write_layout(mine_lib::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.cards_dir()).unwrap();
        std::fs::create_dir_all(vault.media_dir()).unwrap();

        for _ in 0..2 {
            let upload = clipper_uploads::write_pending_upload(
                &vault,
                "inspora.jpg",
                Some("image/jpeg".into()),
                b"jpg",
            )
            .unwrap();
            handle_save_block(
                &vault,
                serde_json::json!({
                    "block_type": "image",
                    "title": "Inspora",
                    "url": "https://www.inspora.design/posts/4-3",
                    "pre_uploaded_id": upload.upload_id,
                    "body": "",
                    "tags": []
                }),
            );
        }

        assert!(
            vault.block_path("Cards/Inspora").exists(),
            "first clip missing"
        );
        assert!(
            vault.block_path("Cards/Inspora (2)").exists(),
            "second clip did not get its own card",
        );

        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM blocks WHERE slug LIKE 'Cards/Inspora%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2, "both clips must be indexed");
    }

    #[test]
    fn save_block_with_avif_upload_writes_placeholder_thumb_metadata() {
        let tmp = TempDir::new().unwrap();
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();

        let upload = clipper_uploads::write_pending_upload(
            &vault,
            "opal.avif",
            Some("image/avif".into()),
            b"\x00\x00\x00\x1cftypavif\x00\x00",
        )
        .unwrap();

        handle_save_block(
            &vault,
            serde_json::json!({
                "block_type": "image",
                "title": "Opal Camera",
                "url": "https://example.com/opal",
                "pre_uploaded_id": upload.upload_id,
                "body": "",
                "tags": []
            }),
        );

        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let (media_file, thumb_format, thumb_mtime): (String, String, i64) = conn
            .query_row(
                "SELECT media_file, thumb_format, thumb_mtime FROM blocks WHERE slug = ?1",
                ["Opal Camera"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(media_file, "Opal Camera.avif");
        assert_eq!(thumb_format, "png");
        assert!(thumb_mtime > 0);
        assert!(vault.thumb_path("Opal Camera").exists());
    }

    #[test]
    fn save_block_rejects_empty_article_body() {
        let tmp = TempDir::new().unwrap();
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();

        handle_save_block(
            &vault,
            serde_json::json!({
                "block_type": "article",
                "title": "Empty Article",
                "url": "https://example.com/article",
                "body": "   ",
                "tags": []
            }),
        );

        assert!(!vault.block_path("Empty Article").exists());
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
    fn url_without_extension_states_nothing() {
        // The AT Protocol blob endpoint: its last dotted segment is a method
        // name, and reading it as a file type is what filed videos as JPEGs.
        assert_eq!(
            ext_from_url_opt("https://pds.example/xrpc/com.atproto.sync.getBlob?did=d&cid=c"),
            None
        );
        assert_eq!(ext_from_url_opt("https://h.example/media"), None);
        assert_eq!(ext_from_url_opt("https://h.example/a.jpg"), Some("jpg"));
        assert_eq!(ext_from_url_opt("https://h.example/a.mp4?v=2"), Some("mp4"));
        // The guessing wrapper keeps its old answer for both cases.
        assert_eq!(ext_from_url("https://h.example/media"), "jpg");
        assert_eq!(ext_from_url("https://h.example/a.mp4"), "mp4");
    }

    #[test]
    fn content_type_maps_to_storable_extension() {
        assert_eq!(ext_from_content_type("video/mp4"), Some("mp4"));
        assert_eq!(ext_from_content_type("Video/MP4; codecs=avc1"), Some("mp4"));
        assert_eq!(ext_from_content_type("image/png"), Some("png"));
        assert_eq!(ext_from_content_type("application/octet-stream"), None);
        assert_eq!(ext_from_content_type(""), None);
    }

    #[test]
    fn probe_classifies_extensionless_url_as_video() {
        let tmp = tempfile::tempdir().unwrap();
        let body = "![a](https://pds.example/xrpc/com.atproto.sync.getBlob?did=d&cid=c)";
        let tasks = scan_inline_tasks_with(body, &vault_at(tmp.path()), "Post", &|_| Some("mp4"));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].kind, InlineMediaKind::Video);
        assert_eq!(tasks[0].dest_name, "Post (video 1).mp4");
    }

    #[test]
    fn silent_probe_leaves_previous_behaviour_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let body = "![a](https://pds.example/xrpc/com.atproto.sync.getBlob?did=d&cid=c)";
        let tasks = scan_inline_tasks_with(body, &vault_at(tmp.path()), "Post", &|_| None);
        assert_eq!(tasks[0].kind, InlineMediaKind::Image);
        assert_eq!(tasks[0].dest_name, "Post (image 1).jpg");
    }

    #[test]
    fn url_extension_wins_over_probe() {
        let tmp = tempfile::tempdir().unwrap();
        let body = "![a](https://h.example/clip.mp4)";
        let tasks = scan_inline_tasks_with(body, &vault_at(tmp.path()), "Post", &|_| {
            panic!("probe must not run for a URL that states its extension")
        });
        assert_eq!(tasks[0].dest_name, "Post (video 1).mp4");
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
        let (rewritten, _) = apply_rewrites(body, &tasks, &outcomes);
        assert_eq!(rewritten, "intro\n![[Slug (image 1).jpg|cap]]\nmore");
    }

    #[test]
    fn apply_rewrites_leaves_failed_url_in_place() {
        let tmp = TempDir::new().unwrap();
        let body = "x ![a](https://h.com/x.jpg) y";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        let outcomes = vec![Err("404".to_string())];
        assert_eq!(apply_rewrites(body, &tasks, &outcomes).0, body);
    }

    #[test]
    fn apply_rewrites_in_reverse_keeps_offsets_valid() {
        let tmp = TempDir::new().unwrap();
        let body = "![a](https://h.com/1.jpg)\n\n![b](https://h.com/2.jpg)";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        let outcomes = vec![Ok(()), Ok(())];
        let (rewritten, _) = apply_rewrites(body, &tasks, &outcomes);
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
        let (rewritten, _) = apply_rewrites(body, &tasks, &outcomes);
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
        assert_eq!(apply_rewrites(body, &[], &[]).0, body);
        assert_eq!(
            localize_body_images(body, &vault_at(tmp.path()), "S", "").0,
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
