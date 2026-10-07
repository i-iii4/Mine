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
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mine_lib::domain::block::{Block, BlockType, DateTime, Frontmatter};
use mine_lib::domain::channel::Channel;
use mine_lib::domain::collection::{normalize_collection_ref, validate_collection_ref};
use mine_lib::domain::vault::VaultLayout;
use mine_lib::markdown_images::{
    build_inline_wikilink, media_extension_for_content_type, replaceable_body_images,
};
use mine_lib::net;
use mine_lib::space_registry::{CloudRead, IdentityUnreadable};
use mine_lib::storage::{clipper_uploads, db, file_identity, files, index, save_operations, thumbnails};
use mine_lib::tool_process::{RunningTools, ToolFailure};
use mine_lib::util::now_saved_at;
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
    /// The identity of the space at `vault_path` (SPEC_CLIPPER.md, К1).
    vault_id: Option<String>,
    /// The path the popup asked about, when the space has moved from it.
    moved_from: Option<String>,
    /// Whether the binding the popup holds names this space (К2). A path
    /// binding from before К2 counts when it is this space's.
    binding_accepted: bool,
    /// Bumped by the app on every settings change (К5, П28).
    config_generation: u64,
    /// The build of the extension installed on disk. The running extension
    /// compares it with its own and reloads itself when it is older (К4).
    extension_build_id: Option<String>,
    version: String,
    host_api_version: u32,
    build_id: String,
    commit: String,
    save_protocols: Vec<u32>,
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
    /// The body is text the person selected: saved as shown, with nothing
    /// added (SPEC_AUDIT_FIXES.md, Ф5).
    #[serde(default)]
    selection: bool,
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

std::thread_local! {
    /// Correlation id of the request this thread is handling. The main loop
    /// sets it before dispatch, and a request handled off the loop
    /// (`spawn_off_loop`) carries its own into its thread, so every response
    /// echoes the `_messageId` of the request that produced it and
    /// background.js matches responses by id, in whatever order they come
    /// (SPEC_CLIPPER.md, 3d, В1).
    static CURRENT_MESSAGE_ID: std::cell::Cell<i64> = const { std::cell::Cell::new(NO_MESSAGE_ID) };
}

fn set_current_message_id(id: i64) {
    CURRENT_MESSAGE_ID.with(|current| current.set(id));
}

fn current_message_id() -> i64 {
    CURRENT_MESSAGE_ID.with(std::cell::Cell::get)
}

/// Serialize a response, injecting the current `_messageId` when one is set so
/// the extension can correlate it. Falls back to id-less JSON when no id is
/// active or the response is not a JSON object.
fn serialize_response<T: serde::Serialize>(resp: &T) -> String {
    let fallback = || r#"{"ok":false,"error":"serialization failed"}"#.to_string();
    let id = current_message_id();
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
    mine_lib::space_registry::current_path(&read_app_settings())
}

/// The shared app settings, read through their one owner
/// (SPEC_VAULT_LIFECYCLE.md, П28). Unreadable settings read as empty: this
/// value is never written back.
fn read_app_settings() -> serde_json::Map<String, serde_json::Value> {
    let Ok(dir) = native_app_data_dir() else {
        return serde_json::Map::new();
    };
    match mine_lib::app_config::AppConfig::in_dir(&dir).read() {
        Ok(settings) => settings,
        Err(error) => {
            host_log(&format!("app settings unreadable: {error}"));
            serde_json::Map::new()
        }
    }
}

fn canonical_native_space_path(path: &str) -> Result<String, String> {
    std::fs::canonicalize(path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("cannot access space {path}: {error}"))
}

fn same_native_space(left: &str, right: &str) -> bool {
    mine_lib::space_registry::same_path(left, right)
}

/// The space a request is about, found by identity rather than by the path
/// the popup remembered (SPEC_CLIPPER.md, К1 to К3).
#[derive(Debug, Clone, PartialEq, Eq)]
struct RequestSpace {
    /// Where the space is now, when it was found.
    path: Option<String>,
    /// `ready`, `moved`, `missing`, `access_denied`, `unavailable`,
    /// `unknown_space`, `unconfigured`, or one of the identity states: which
    /// space the folder is cannot be told now, because an identity is still
    /// in iCloud (`identity_in_cloud`) or cannot be read
    /// (`identity_unreadable`), or the folder is a copy that cannot be given
    /// an identity of its own (`identity_unwritable`).
    state: &'static str,
    moved_from: Option<String>,
    /// The request's path binding from before К2, proven to be this space's:
    /// its receipts move to the identity binding.
    accepted_legacy: Option<String>,
    binding_accepted: bool,
    /// The space's identity, known without waiting for iCloud: read from the
    /// folder, or the one the request named when the folder's identity file
    /// is only in the cloud.
    identity: Option<String>,
}

impl RequestSpace {
    /// What the popup shows instead of an OS error text (К3).
    fn message(&self) -> Option<String> {
        let name = |path: &str| {
            Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string())
        };
        let last = self.moved_from.as_deref().or(self.path.as_deref());
        match (self.state, last) {
            ("missing", Some(path)) => Some(format!(
                "“{}” was renamed, moved or is on a disconnected drive. Choose a space.",
                name(path)
            )),
            ("access_denied", Some(path)) => Some(format!(
                "Mine cannot read “{}”. Allow access to the folder or choose another space.",
                name(path)
            )),
            ("unavailable", Some(path)) => Some(format!(
                "The folder “{}” now holds another space. Choose a space.",
                name(path)
            )),
            ("unknown_space", Some(path)) => Some(format!(
                "“{}” is not one of your Mine spaces.",
                name(path)
            )),
            (IDENTITY_IN_CLOUD, Some(path)) => Some(format!(
                "Mine cannot tell yet which space “{}” is: its identity is still downloading from iCloud. Try again in a moment, or open Mine.",
                name(path)
            )),
            (IDENTITY_UNREADABLE, Some(path)) => Some(format!(
                "Mine cannot read which space “{}” is. Allow access to the folder or choose another space.",
                name(path)
            )),
            (IDENTITY_UNWRITABLE, Some(path)) => Some(format!(
                "“{}” is a copy of another space, and Mine cannot give it an identity of its own. Allow access to the folder or choose another space.",
                name(path)
            )),
            _ => None,
        }
    }

    /// The request cannot use the folder at `folder`: which space it is
    /// cannot be told now (Д2.1). An identity in iCloud starts downloading,
    /// so a later request can tell.
    fn refused_identity(cause: &IdentityRefusal, folder: String) -> Self {
        let state = match cause {
            IdentityRefusal::Unreadable(IdentityUnreadable::InCloud { path }) => {
                download_in_background(path);
                IDENTITY_IN_CLOUD
            }
            IdentityRefusal::Unreadable(IdentityUnreadable::Unreadable { .. }) => IDENTITY_UNREADABLE,
            IdentityRefusal::CopyIdentity { .. } => IDENTITY_UNWRITABLE,
        };
        Self {
            path: None,
            state,
            moved_from: Some(folder),
            accepted_legacy: None,
            binding_accepted: false,
            identity: None,
        }
    }
}

const IDENTITY_IN_CLOUD: &str = "identity_in_cloud";
const IDENTITY_UNREADABLE: &str = "identity_unreadable";
const IDENTITY_UNWRITABLE: &str = "identity_unwritable";

/// Why which space a folder is cannot be settled now. The request is refused
/// with a state saying so, never answered with a guess (Д2.1, П22).
#[derive(Debug, thiserror::Error)]
enum IdentityRefusal {
    /// An identity that decides it is in iCloud or cannot be read.
    #[error(transparent)]
    Unreadable(#[from] IdentityUnreadable),
    /// The folder is a copy of a space alive elsewhere (П22), and its own
    /// identity could not be written.
    #[error("cannot give the copy {} an identity of its own: {source}", .folder.display())]
    CopyIdentity {
        folder: PathBuf,
        source: mine_lib::space_registry::MintIdentityError,
    },
}

/// Why the helper does not open a folder as a space.
#[derive(Debug, thiserror::Error)]
enum OpenSpaceError {
    #[error(transparent)]
    Identity(#[from] IdentityRefusal),
    #[error("{0}")]
    Failed(String),
}

impl From<IdentityUnreadable> for OpenSpaceError {
    fn from(cause: IdentityUnreadable) -> Self {
        Self::Identity(cause.into())
    }
}

/// Start downloading a file iCloud keeps off this Mac, without waiting for
/// it: reading it brings its contents here, and the next request finds it.
/// One download per file at a time.
fn download_in_background(path: &Path) {
    static DOWNLOADING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let Ok(mut downloading) = DOWNLOADING.lock() else {
        return;
    };
    if downloading.iter().any(|known| known == path) {
        return;
    }
    downloading.push(path.to_path_buf());
    drop(downloading);
    let finish = |file: &Path| {
        if let Ok(mut downloading) = DOWNLOADING.lock() {
            downloading.retain(|known| known != file);
        }
    };
    let file = path.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("icloud-download".into())
        .spawn(move || {
            // A file gone meanwhile has nothing left to download.
            match std::fs::read(&file) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    host_log(&format!("cannot download {} from iCloud: {error}", file.display()));
                }
                _ => {}
            }
            finish(&file);
        });
    if spawned.is_err() {
        finish(path);
    }
}

fn resolve_request_space(requested: Option<String>, binding: Option<&str>) -> RequestSpace {
    resolve_request_space_in(
        &read_app_settings(),
        native_vaults_dir().as_deref(),
        requested,
        binding,
    )
}

/// Where the app keeps its derived stores, whose `owner-path.json` files say
/// which space each last saw at which path.
fn native_vaults_dir() -> Option<PathBuf> {
    native_app_data_dir()
        .ok()
        .map(|dir| mine_lib::space_registry::vaults_dir(&dir))
}

/// The folder a request looks at first: the path the popup sent, else the
/// path listed for the identity it names, else the current space.
fn request_hint(
    cfg: &serde_json::Map<String, serde_json::Value>,
    requested: Option<String>,
    identity: Option<&str>,
) -> Option<String> {
    use mine_lib::space_registry;
    requested
        .or_else(|| {
            let id = identity?;
            space_registry::records(cfg)
                .into_iter()
                .find(|record| record.vault_id.as_deref() == Some(id))
                .map(|record| record.path)
        })
        .or_else(|| space_registry::current_path(cfg))
}

/// A request with no space chosen yet.
fn unconfigured_space() -> RequestSpace {
    RequestSpace {
        path: None,
        state: "unconfigured",
        moved_from: None,
        accepted_legacy: None,
        binding_accepted: true,
        identity: None,
    }
}

/// Where the space a request names stands now, starting at `hint`: the
/// folder and the path it moved from, or the answer for a space that cannot
/// be reached. Writes nothing.
///
/// A request that names its space is found by that identity. One that does
/// not (a popup from before К2) is found exactly as the app reopens its
/// saved space: by the identity the registry or a derived store recorded for
/// the path, and a folder without an identity of its own is never taken for
/// the space (Ф8, Б2.2). The helper then writes only where the app would
/// open.
fn locate_request_space_in(
    cfg: &serde_json::Map<String, serde_json::Value>,
    vaults_dir: Option<&Path>,
    hint: &str,
    identity: Option<&str>,
) -> Result<(String, Option<String>), RequestSpace> {
    use mine_lib::space_registry::{self, Located, LostReason};
    let located = match identity {
        Some(id) => space_registry::locate(cfg, Some(id), hint),
        None => space_registry::locate_saved(cfg, vaults_dir, hint),
    };
    match located {
        Located::Here { path } => Ok((path, None)),
        Located::Moved { from, path } => Ok((path, Some(from))),
        Located::Lost { path, reason } => Err(RequestSpace {
            path: None,
            state: match reason {
                LostReason::Missing => "missing",
                LostReason::AccessDenied => "access_denied",
                LostReason::Replaced => "unavailable",
            },
            moved_from: Some(path),
            accepted_legacy: None,
            binding_accepted: false,
            identity: None,
        }),
    }
}

/// The identity of the space at `folder`, settled by the app's copy rule
/// (П22) against the derived stores in `vaults_dir` without waiting for
/// iCloud: `None` for a folder without one. A copy of a space alive where
/// its store last served it gets an identity and a store of its own now, as
/// the app gives it when it opens a copy, so the copy never reads or writes
/// the original's index (Д2.1). When the rule cannot tell, nothing is
/// written and the request is refused.
fn settled_identity(folder: &Path, vaults_dir: Option<&Path>) -> Result<Option<String>, IdentityRefusal> {
    let Some(id) = mine_lib::space_registry::read_identity(folder, CloudRead::NoWait)? else {
        return Ok(None);
    };
    match vaults_dir {
        Some(vaults) => claim_space_identity(folder, vaults, id).map(Some),
        None => Ok(Some(id)),
    }
}

/// Apply the copy rule (П22) to the folder `folder`, which carries `id`:
/// the identity whose derived store in `vaults_dir` serves it.
fn claim_space_identity(folder: &Path, vaults_dir: &Path, id: String) -> Result<String, IdentityRefusal> {
    use mine_lib::space_registry::{self, IdentityClaim};
    match space_registry::identity_claim(folder, &vaults_dir.join(&id), &id, CloudRead::NoWait) {
        IdentityClaim::Owned | IdentityClaim::Adopted => Ok(id),
        IdentityClaim::Undecided { cause, .. } => Err(cause.into()),
        IdentityClaim::Copy { owner } => {
            let own = space_registry::mint_copy_identity(folder).map_err(|source| {
                IdentityRefusal::CopyIdentity {
                    folder: folder.to_path_buf(),
                    source,
                }
            })?;
            host_log(&format!(
                "{} is a copy of the space at {}: it has an identity of its own now, {own}",
                folder.display(),
                owner.display()
            ));
            space_registry::record_owner_path(&vaults_dir.join(&own), folder);
            Ok(own)
        }
    }
}

fn resolve_request_space_in(
    cfg: &serde_json::Map<String, serde_json::Value>,
    vaults_dir: Option<&Path>,
    requested: Option<String>,
    binding: Option<&str>,
) -> RequestSpace {
    let identity = binding.filter(|value| !save_operations::is_legacy_binding(value));
    let Some(hint) = request_hint(cfg, requested, identity) else {
        return unconfigured_space();
    };
    // The folder asked about is looked at first: one whose identity cannot
    // be read now is refused, not passed over for another folder that
    // carries the identity named (Д2.1).
    if std::fs::read_dir(&hint).is_ok() {
        if let Err(cause) = mine_lib::space_registry::read_identity(Path::new(&hint), CloudRead::NoWait) {
            return RequestSpace::refused_identity(&cause.into(), hint);
        }
    }
    let (path, moved_from) = match locate_request_space_in(cfg, vaults_dir, &hint, identity) {
        Ok(found) => found,
        Err(lost) => return lost,
    };
    let identity = match settled_identity(Path::new(&path), vaults_dir) {
        Ok(identity) => identity,
        Err(cause) => return RequestSpace::refused_identity(&cause, path),
    };
    let (binding_accepted, accepted_legacy) = match binding {
        None => (true, None),
        Some(value) if save_operations::is_legacy_binding(value) => {
            let canonical = std::fs::canonicalize(&path)
                .ok()
                .and_then(|path| path.to_str().map(str::to_string));
            let proven = [Some(hint.as_str()), canonical.as_deref()]
                .into_iter()
                .flatten()
                .any(|spelling| save_operations::legacy_binding_of_path(spelling) == value);
            (proven, proven.then(|| value.to_string()))
        }
        Some(value) => (identity.as_deref() == Some(value), None),
    };
    RequestSpace {
        state: if moved_from.is_some() { "moved" } else { "ready" },
        path: Some(path),
        moved_from,
        accepted_legacy,
        binding_accepted,
        identity,
    }
}

/// Why a request cannot use its space.
enum SpaceRefusal {
    /// The space is not where the request can reach it; its state answers.
    Space(RequestSpace),
    Failed(String),
}

/// Open the space a request was resolved to. Only the located folder is
/// touched: an unavailable one is never replaced by a new space at the same
/// display path, and a folder whose space cannot be told now is refused
/// with its state (Д2.1). `writes` lays out a brand-new empty space first.
fn open_request_vault(
    space: &RequestSpace,
    writes: bool,
    app_state: PathBuf,
) -> Result<VaultLayout, SpaceRefusal> {
    let Some(located) = &space.path else {
        return Err(SpaceRefusal::Space(space.clone()));
    };
    let path = PathBuf::from(located);
    if !path.is_dir() {
        return Err(SpaceRefusal::Space(RequestSpace {
            path: None,
            state: "missing",
            moved_from: Some(located.clone()),
            ..space.clone()
        }));
    }
    if writes {
        initialize_native_new_space_layout(&VaultLayout::new(path.clone()))
            .map_err(SpaceRefusal::Failed)?;
    }
    resolve_native_vault_layout_at(path, app_state).map_err(|error| match error {
        OpenSpaceError::Identity(cause) => {
            SpaceRefusal::Space(RequestSpace::refused_identity(&cause, located.clone()))
        }
        OpenSpaceError::Failed(error) => SpaceRefusal::Failed(error),
    })
}

/// A request about a space that cannot be found answers with its state and
/// a readable message, never the OS error (К3).
fn send_space_error(space: &RequestSpace) {
    send_response(&serde_json::json!({
        "ok": false,
        "code": "space_unavailable",
        "folder_state": space.state,
        "error": space
            .message()
            .unwrap_or_else(|| "Choose a space before saving.".to_string()),
    }));
}

/// Receipts made under a path binding follow the space to its identity
/// binding (К2): the folder's own path binding and a path binding the
/// request proved to be this space's. A request carrying such a binding is
/// rewritten to the identity so its checks match.
fn adopt_space_journal(vault: &VaultLayout, space: &RequestSpace, params: &mut serde_json::Value) {
    let Ok(binding) = save_operations::binding_id(vault) else {
        return;
    };
    if save_operations::is_legacy_binding(&binding) {
        return;
    }
    let Ok(store) = operation_store(vault) else {
        return;
    };
    let mut legacies = Vec::new();
    if let Ok(own) = save_operations::legacy_binding_id(vault) {
        legacies.push(own);
    }
    if let Some(proven) = &space.accepted_legacy {
        if !legacies.contains(proven) {
            legacies.push(proven.clone());
        }
    }
    for legacy in &legacies {
        if let Err(error) = store.adopt_legacy(legacy, &binding) {
            host_log(&format!("cannot move save receipts to the space identity: {error:#}"));
        }
    }
    let carries_legacy = params
        .get("binding_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| legacies.iter().any(|legacy| legacy == value));
    if carries_legacy {
        params["binding_id"] = serde_json::Value::from(binding);
    }
}

fn config_generation(cfg: &serde_json::Map<String, serde_json::Value>) -> u64 {
    cfg.get(mine_lib::app_config::GENERATION_KEY)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

/// The spaces that can be opened right now, canonical and without repeats.
fn load_known_vaults() -> Vec<String> {
    load_known_vaults_in(&read_app_settings(), native_vaults_dir().as_deref())
}

/// As [`load_known_vaults`], judging a record without an identity by the
/// derived stores in `vaults_dir`, as the app does: an empty folder left
/// where a space used to be is not that space (В2.2). A record whose space
/// moved away is listed where the space is now, the folder a save to it goes
/// to (Б2.2).
fn load_known_vaults_in(
    cfg: &serde_json::Map<String, serde_json::Value>,
    vaults_dir: Option<&Path>,
) -> Vec<String> {
    use mine_lib::space_registry::{self, Located};
    let paths: Vec<String> = space_registry::statuses_in(cfg, vaults_dir)
        .into_iter()
        .filter_map(|status| {
            if status.available {
                return Some(status.record.path);
            }
            match space_registry::locate_saved(cfg, vaults_dir, &status.record.path) {
                Located::Moved { path, .. } => Some(path),
                Located::Here { .. } | Located::Lost { .. } => None,
            }
        })
        .collect();
    let mut unique: Vec<String> = Vec::new();
    for path in paths {
        if let Ok(canonical) = canonical_native_space_path(&path) {
            if !unique.contains(&canonical) {
                unique.push(canonical);
            }
        }
    }
    unique
}

fn resolve_native_vault_layout(root: PathBuf) -> Result<VaultLayout, String> {
    resolve_native_vault_layout_at(root, native_app_data_dir()?).map_err(|error| error.to_string())
}

/// The space at `root` with its derived store under `app_state`, chosen by
/// the same identity and copy rule as the app's (П22): a copy of a space
/// alive elsewhere never shares its store (Д2.1).
fn resolve_native_vault_layout_at(
    root: PathBuf,
    app_state: PathBuf,
) -> Result<VaultLayout, OpenSpaceError> {
    let base = VaultLayout::new(root.clone());
    let vault_id = ensure_space_identity(&base)?;
    let vaults = mine_lib::space_registry::vaults_dir(&app_state);
    let vault_id = claim_space_identity(&root, &vaults, vault_id)?;
    let derived_root = vaults.join(vault_id);
    mine_lib::space_registry::record_owner_path(&derived_root, &root);
    let write_layout = files::load_vault_write_layout(&base)
        .map_err(|error| OpenSpaceError::Failed(error.to_string()))?;
    let layout = VaultLayout::with_derived_root(root, derived_root).with_write_layout(write_layout);

    db::resolve_vault_index(layout)
        .map_err(|error| OpenSpaceError::Failed(format!("index selection failed: {error:#}")))
}

fn initialize_native_new_space_layout(vault: &VaultLayout) -> Result<(), String> {
    if vault.vault_id_path().exists()
        || vault.legacy_vault_id_path().exists()
        || vault.write_layout_path().exists()
    {
        return Ok(());
    }
    let entries = std::fs::read_dir(vault.root())
        .map_err(|error| format!("failed to inspect selected space: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with('.') {
            return Ok(());
        }
    }
    let standard = mine_lib::domain::vault::VaultWriteLayout::standard();
    files::ensure_vault_write_layout(vault, &standard).map_err(|error| error.to_string())?;
    for folder in [&standard.cards, &standard.media, &standard.collections] {
        let path = vault.root().join(folder);
        files::validate_vault_write_target(vault, &path).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("failed to create initial folder {folder}: {error}"))?;
    }
    Ok(())
}

/// The build of the installed extension, from the identity file the
/// extension build writes next to its bundle. The copy browsers load first
/// (`clipper/extension`), then the managed one.
fn installed_extension_build(app_data: &Path) -> Option<String> {
    let clipper = app_data.join("clipper");
    [
        clipper.join("extension"),
        clipper
            .join(mine_lib::runtime_installation::MANAGED_RUNTIME_DIRECTORY)
            .join("extension"),
    ]
    .iter()
    .find_map(|extension| {
        let bytes = std::fs::read(extension.join("dist/runtime-identity.json")).ok()?;
        let identity: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        identity
            .get("buildId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    })
}

fn native_app_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/com.mine.app"))
}

/// The space's identity, written first when the folder has none. Called only
/// for a folder the person chose or a space located by identity.
fn ensure_space_identity(base: &VaultLayout) -> Result<String, OpenSpaceError> {
    files::validate_vault_write_target(base, &base.mine_dir())
        .map_err(|e| OpenSpaceError::Failed(e.to_string()))?;
    ensure_native_vault_id(base)
}

/// The identity the folder carries, moved from the legacy `.arena` file when
/// only that one has it, else a new one. Never waits for iCloud, and never
/// takes an identity it cannot read for none: a new identity written over it
/// would split one space into two (Д2.1).
fn ensure_native_vault_id(vault: &VaultLayout) -> Result<String, OpenSpaceError> {
    use mine_lib::space_registry::read_identity_file;
    let failed = OpenSpaceError::Failed;
    let path = vault.vault_id_path();
    files::validate_vault_write_target(vault, &path).map_err(|e| failed(e.to_string()))?;
    if let Some(existing) = read_identity_file(&path, CloudRead::NoWait)? {
        save_operations::validate_id(&existing).map_err(|e| failed(e.to_string()))?;
        return Ok(existing);
    }
    let (id, written) = match read_identity_file(&vault.legacy_vault_id_path(), CloudRead::NoWait)? {
        Some(legacy) => {
            save_operations::validate_id(&legacy).map_err(|e| failed(e.to_string()))?;
            (legacy, "failed to migrate vault-id to .mine")
        }
        None => (generate_native_vault_id().map_err(failed)?, "failed to write vault-id"),
    };
    std::fs::create_dir_all(vault.mine_dir())
        .map_err(|e| failed(format!("failed to create Mine metadata dir: {e}")))?;
    files::write_atomically(&path, format!("{id}\n").as_bytes())
        .map_err(|e| failed(format!("{written}: {e:#}")))?;
    Ok(id)
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

/// Lists a space in the shared app settings through their one owner: under
/// the lock the app uses too, changing only the space list, never over a file
/// it cannot read (SPEC_VAULT_LIFECYCLE.md, П28). Returns the updated list.
fn add_known_vault(path: &str) -> Result<Vec<String>, String> {
    add_known_vault_in(&native_app_data_dir()?, path)
}

/// [`add_known_vault`] with the settings of the app data folder `app_data`.
fn add_known_vault_in(app_data: &Path, path: &str) -> Result<Vec<String>, String> {
    let path = canonical_native_space_path(path)?;
    // Never wait for iCloud: an identity still in the cloud is learned later.
    let id = match mine_lib::space_registry::space_identity(std::path::Path::new(&path)) {
        mine_lib::space_registry::SpaceIdentity::Known(id) => Some(id),
        _ => None,
    };
    let settings = mine_lib::app_config::AppConfig::in_dir(app_data);
    settings
        .update(|cfg| {
            mine_lib::space_registry::add_space(cfg, id.as_deref(), &path);
            mine_lib::space_registry::records(cfg)
                .into_iter()
                .map(|record| record.path)
                .collect()
        })
        .map_err(|error| error.to_string())
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
    let picked = match canonical_native_space_path(&picked) {
        Ok(path) => path,
        Err(error) => return send_error(&error),
    };
    let chosen = VaultLayout::new(PathBuf::from(&picked));
    if let Err(error) = initialize_native_new_space_layout(&chosen) {
        return send_error(&error);
    }
    // The person chose this folder: it becomes a space with its identity now,
    // as a folder chosen in the app does. Requests then find it by identity;
    // a folder without one is never taken for a space (Ф8). An identity
    // still in iCloud is the folder's own: the folder is listed now, and
    // requests can use it once the identity is here (Д2.1).
    match ensure_space_identity(&chosen) {
        Ok(_)
        | Err(OpenSpaceError::Identity(IdentityRefusal::Unreadable(
            IdentityUnreadable::InCloud { .. },
        ))) => {}
        Err(error) => return send_error(&error.to_string()),
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
/// Explicit destinations are limited to known spaces; opening without one
/// preserves the setup screen's existing launch-only behaviour.
/// The installed Mine. Opening by bundle identifier lets macOS pick any
/// registered copy, a build output or an old bundle among them; the copy in
/// an Applications folder is the one the person runs.
fn installed_app() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    installed_app_in(&[
        Some(PathBuf::from("/Applications")),
        home.map(|home| home.join("Applications")),
    ])
}

fn installed_app_in(folders: &[Option<PathBuf>]) -> Option<PathBuf> {
    folders
        .iter()
        .flatten()
        .map(|folder| folder.join("Mine.app"))
        .find(|app| app.join("Contents/Info.plist").is_file())
}

fn handle_open_app(params: serde_json::Value) {
    #[derive(serde::Serialize)]
    struct OpenAppResponse {
        ok: bool,
    }
    let mut command = std::process::Command::new("open");
    match installed_app() {
        Some(app) => command.arg("-a").arg(app),
        None => command.args(["-b", "com.mine.app"]),
    };
    if let Some(path) = params.get("path") {
        let Some(path) = path.as_str() else { return send_error("invalid space path"); };
        if !load_known_vaults().iter().any(|known| same_native_space(known, path))
            || !std::path::Path::new(path).is_dir()
        {
            return send_error("space is not available or not registered");
        }
        command.arg("--").arg(path);
    }
    let status = command.status();
    match status {
        Ok(code) if code.success() => send_response(&OpenAppResponse { ok: true }),
        Ok(code) => send_error(&format!("open exited with {code}")),
        Err(error) => send_error(&format!("failed to launch the app: {error}")),
    }
}

/// Reveal in Finder opens where the space is now, found by identity, and
/// always answers (SPEC_CLIPPER.md, К6).
fn handle_reveal_vault(params: serde_json::Value) {
    match reveal_target(&params) {
        Ok(path) => match std::process::Command::new("open").arg("-R").arg(&path).status() {
            Ok(status) if status.success() => {
                send_response(&serde_json::json!({ "ok": true, "path": path }));
            }
            Ok(status) => {
                host_log(&format!("open -R {path} exited with {status}"));
                send_error("Finder could not show this space.");
            }
            Err(error) => {
                host_log(&format!("cannot run open: {error}"));
                send_error("Finder could not show this space.");
            }
        },
        Err(space) => send_space_error(&space),
    }
}

/// The folder Reveal opens: the space the popup names, wherever it is now,
/// and only a space Mine knows.
fn reveal_target(params: &serde_json::Value) -> Result<String, RequestSpace> {
    reveal_target_in(&read_app_settings(), native_vaults_dir().as_deref(), params)
}

fn reveal_target_in(
    cfg: &serde_json::Map<String, serde_json::Value>,
    vaults_dir: Option<&Path>,
    params: &serde_json::Value,
) -> Result<String, RequestSpace> {
    // Popups before К6 nested the fields under `params`.
    let fields = params
        .get("params")
        .filter(|value| value.is_object())
        .unwrap_or(params);
    let path = fields
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let binding = fields
        .get("binding_id")
        .or_else(|| params.get("binding_id"))
        .and_then(serde_json::Value::as_str);
    // Showing a folder needs only where it is: no identity is settled, and
    // nothing is written.
    let identity = binding.filter(|value| !save_operations::is_legacy_binding(value));
    let Some(hint) = request_hint(cfg, path, identity) else {
        return Err(unconfigured_space());
    };
    let (target, _) = locate_request_space_in(cfg, vaults_dir, &hint, identity)?;
    let mut allowed = load_known_vaults_in(cfg, vaults_dir);
    allowed.extend(mine_lib::space_registry::current_path(cfg));
    if !allowed.iter().any(|vault| same_native_space(vault, &target)) {
        return Err(RequestSpace {
            path: None,
            state: "unknown_space",
            moved_from: Some(target),
            accepted_legacy: None,
            binding_accepted: false,
            identity: None,
        });
    }
    Ok(target)
}

fn handle_get_status_with_upload(
    upload: &Option<UploadServer>,
    space: &RequestSpace,
    config_generation: u64,
) {
    let (binding_id, folder_state, error) = match &space.path {
        None => (None, space.state, space.message()),
        // The identity is the binding (К2); reading it again could wait for
        // iCloud.
        Some(_) if space.identity.is_some() => (space.identity.clone(), space.state, None),
        Some(path) => match save_operations::binding_id(&VaultLayout::new(PathBuf::from(path))) {
            Ok(id) => (Some(id), space.state, None),
            Err(error) => {
                host_log(&format!("cannot bind space {path}: {error:#}"));
                (
                    None,
                    "unavailable",
                    Some("Mine cannot use this folder right now. Choose another space.".to_string()),
                )
            }
        },
    };
    let vault_id = space.identity.clone();
    send_response(&StatusResponse {
        ok: true,
        connected: true,
        vault_configured: binding_id.is_some(),
        binding_id,
        executor_id: "native".into(),
        folder_state: folder_state.into(),
        error,
        vault_path: space.path.clone(),
        vault_id,
        moved_from: space.moved_from.clone(),
        binding_accepted: space.binding_accepted,
        config_generation,
        extension_build_id: native_app_data_dir()
            .ok()
            .and_then(|dir| installed_extension_build(&dir)),
        version: VERSION.to_string(),
        host_api_version: HOST_API_VERSION,
        build_id: option_env!("MINE_BUILD_ID").unwrap_or("unidentified-build").into(),
        commit: option_env!("MINE_BUILD_COMMIT").unwrap_or("unknown").into(),
        save_protocols: vec![mine_lib::runtime_protocol::BASE_SAVE_PROTOCOL],
        features: vec![
            "pending_uploads_v1".into(),
            "save_operation_v1".into(),
            "operation_lookup_v1".into(),
            "open_app_v1".into(),
            "connection_check_v1".into(),
            // `saved_at` as the local wall clock without a zone (К4).
            "local_saved_at_v1".into(),
            // Spaces are found by identity and the status reports moves (К1).
            "space_identity_v1".into(),
        ],
        upload_port: upload.as_ref().map(|u| u.port),
        upload_token: upload.as_ref().map(|u| u.token.clone()),
    });
}

fn handle_list_channels(vault: &VaultLayout) {
    let response = list_channels_response(vault);
    if response["indexing"] == true {
        index_in_background(vault);
    }
    send_response(&response);
}

/// The popup needs collection names and card counts, and the index has both
/// (SPEC_CLIPPER.md, К3). The answer never waits for the space: no source
/// pass, no reading of card files, which on an iCloud space would wait for
/// every card to download. Without a finished index the names come from the
/// collections folder listing, counts are unknown and `indexing` is set.
fn list_channels_response(vault: &VaultLayout) -> serde_json::Value {
    match read_indexed_channels(vault) {
        Ok(Some(channels)) => serde_json::json!({ "ok": true, "channels": channels }),
        Ok(None) => serde_json::json!({
            "ok": true,
            "indexing": true,
            "channels": folder_collections(vault)
                .into_iter()
                .map(|tag| serde_json::json!({ "tag": tag, "block_count": null }))
                .collect::<Vec<_>>(),
        }),
        Err(error) => {
            host_log(&format!("cannot read collections from the index: {error:#}"));
            serde_json::json!({
                "ok": false,
                "code": "collections_unavailable",
                "error": "Mine could not read the collections of this space.",
            })
        }
    }
}

/// Collections from a finished index, read-only; `None` while there is none.
fn read_indexed_channels(vault: &VaultLayout) -> anyhow::Result<Option<Vec<ChannelInfo>>> {
    let Some(selected) = db::existing_selected_index(vault)? else {
        return Ok(None);
    };
    let conn = db::open_read_only(&selected.index_db_path())?;
    if !db::index_is_ready(&conn)? {
        return Ok(None);
    }
    Ok(Some(merge_channels_and_tags(
        index::list_channels(&conn)?,
        index::get_all_tags(&conn)?,
    )))
}

/// Collection names from the collections folder: a directory listing, no
/// file is read. A flat space keeps collections among its cards, where names
/// alone cannot tell them apart; it gets no names until the index is ready.
fn folder_collections(vault: &VaultLayout) -> Vec<String> {
    let layout = vault.write_layout();
    if layout.collections.is_empty() || layout.collections == layout.cards {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(vault.collections_dir()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|ext| ext.to_str()) == Some("md"))
                .then(|| path.file_stem()?.to_str().map(str::to_string))
                .flatten()
        })
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names
}

/// Build the index of a space the app has not indexed yet, off the request
/// path: the popup asks again and gets the counts once it is ready. One
/// build per process at a time.
fn index_in_background(vault: &VaultLayout) {
    static BUILDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let vault = vault.clone();
    let spawned = std::thread::Builder::new()
        .name("index-build".into())
        .spawn(move || {
            let result = (|| -> anyhow::Result<()> {
                let (vault, conn, _) = db::open_vault_index(vault)?;
                if !db::index_is_ready(&conn)? {
                    mine_lib::storage::reconcile::reconcile_vault(&conn, &vault)?;
                }
                index::backfill_collection_index(&conn, &vault)?;
                Ok(())
            })();
            if let Err(error) = result {
                host_log(&format!("background index build failed: {error:#}"));
            }
            BUILDING.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        BUILDING.store(false, Ordering::SeqCst);
    }
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

#[cfg(test)]
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

fn incompatible_save_response(params: &serde_json::Value, error: impl ToString) -> serde_json::Value {
    let id = params.get("operation_id").and_then(serde_json::Value::as_str).unwrap_or("");
    let mut response = operation_failure(id, "not_committed", "incompatible_protocol", error);
    // Compatibility is checked before layout, journal and source effects. This
    // exact request is terminally rejected; its draft remains available.
    response["terminal_rejected"] = serde_json::json!(true);
    response
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
    if let Err(error) = mine_lib::runtime_protocol::validate_save_request(&params) {
        send_response(&incompatible_save_response(&params, error));
        return;
    }
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
    if let Err(error) = mine_lib::runtime_protocol::validate_save_request(&params) {
        return incompatible_save_response(&params, error);
    }
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
            let same_request = record.fingerprint == fingerprint
                || record
                    .adopted_from
                    .as_deref()
                    .is_some_and(|legacy| fingerprint_capture(&p, legacy) == record.fingerprint);
            if !same_request {
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

fn dedupe_prepared_media_ref(
    source_vault: &VaultLayout,
    staging: &VaultLayout,
    reference: &mut Option<String>,
) -> anyhow::Result<()> {
    let Some(current) = reference.as_ref() else { return Ok(()); };
    let filename = current.rsplit('/').next().unwrap_or(current);
    let (stem, extension) = filename.rsplit_once('.')
        .ok_or_else(|| anyhow::anyhow!("prepared media has no extension"))?;
    let mut occupied = files::scan_vault_file_paths(source_vault)?;
    occupied.extend(files::scan_vault_file_paths(staging)?.into_iter().filter(|path| path != current));
    let unique = mine_core::save::select_unique_file_stem(stem, extension, &occupied)?;
    if unique != stem {
        let filename = format!("{unique}.{extension}");
        let destination = staging.new_media_path(&filename);
        files::validate_vault_write_target(staging, &destination)?;
        std::fs::rename(staging.root().join(current), &destination)?;
        *reference = Some(staging.new_media_stem(&filename));
    }
    Ok(())
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
    let existing = files::scan_vault_file_paths(vault)?;
    let name = mine_core::save::select_name(
        vault.write_layout(),
        p.title.as_deref(),
        p.url.as_deref(),
        &existing,
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

    // Localize the media the body already embeds. The body is the preview the
    // person saw: post video is resolved while the preview is prepared
    // (`resolve_twitter_media`), never added here (Ф5).
    let raw = p.body.unwrap_or_default();
    let (body, inline_files, unresolved_videos) = if raw.trim().is_empty() {
        (raw, Vec::new(), Vec::new())
    } else {
        let page_url = p.url.as_deref().unwrap_or("");
        localize_body_images(&raw, vault, &name, page_url, source_vault)
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
            let mut occupied = files::scan_vault_file_paths(source_vault)?;
            occupied.extend(files::scan_vault_file_paths(vault)?);
            let poster_name = mine_core::save::select_unique_file_stem(
                &format!("{name} (poster)"),
                &ext,
                &occupied,
            )?;
            let dest_name = format!("{poster_name}.{ext}");
            let dest_path = vault.new_media_path(&dest_name);
            files::validate_vault_write_target(vault, &dest_path)?;
            let referer = p.url.as_deref().unwrap_or(&poster_url);
            match download_file(&poster_url, &dest_path, referer) {
                Ok(()) => thumbnail_file = Some(vault.new_media_stem(&dest_name)),
                Err(e) => log::warn!("inline-media: poster download failed err={e}"),
            }
        }
    }

    dedupe_prepared_media_ref(source_vault, vault, &mut media_file)?;
    dedupe_prepared_media_ref(source_vault, vault, &mut thumbnail_file)?;
    let mut link_paths = files::scan_vault_file_paths(source_vault)?;
    link_paths.extend(inline_files.iter().filter_map(|path| vault.root_relative_reference(path)));
    link_paths.extend(media_file.iter().chain(thumbnail_file.iter()).cloned());
    let link_index = mine_core::links::LinkIndex::new(link_paths);
    let file_link = media_file.as_deref().and_then(|path| link_index.shortest_link(path, false));
    let thumbnail_link = thumbnail_file.as_deref().and_then(|path| link_index.shortest_link(path, false));
    let block = mine_core::save::build_capture(&mine_core::save::CaptureRequest {
        intent: mine_core::save::CaptureIntent::WebClip,
        slug: slug.clone(),
        block_type: p.block_type.clone(),
        title: p.title,
        description: p.description,
        url: p.url,
        body,
        file: file_link,
        thumbnail: thumbnail_link,
        tags: p.tags.unwrap_or_default(),
        saved_at: p.saved_at.unwrap_or_else(now_saved_at),
        width: p.width,
        height: p.height,
        author: p.author,
        selection: p.selection,
    })?;
    let mut artifacts = inline_files
        .iter()
        .map(|path| save_operations::PlannedArtifact::inspect(vault, path))
        .collect::<anyhow::Result<Vec<_>>>()?;
    for filename in [media_file.as_deref(), thumbnail_file.as_deref()]
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

    let created_at = match DateTime::new(&now_saved_at()) {
        Ok(dt) => dt,
        Err(e) => return send_error(&format!("failed to create timestamp: {e}")),
    };
    let tag = match validate_collection_ref(&p.tag) {
        Ok(tag) => tag,
        Err(error) => return send_error(&format!("invalid collection ref: {error}")),
    };
    match index::list_channels(&conn) {
        Ok(channels) if channels.iter().any(|channel| channel.tag == tag) => {
            return send_error(&format!("channel already exists: {tag}"));
        }
        Ok(_) => {}
        Err(error) => return send_error(&format!("failed to inspect collections: {error}")),
    }

    let existing = match files::scan_vault_file_paths(vault) {
        Ok(existing) => existing,
        Err(e) => return send_error(&format!("failed to inspect existing vault files: {e}")),
    };
    let tag = match mine_core::save::select_unique_file_stem(&tag, "md", &existing) {
        Ok(tag) => tag,
        Err(e) => return send_error(&format!("failed to select collection name: {e}")),
    };
    let mut channel = match Channel::new(&tag, created_at) {
        Ok(channel) => channel,
        Err(e) => return send_error(&format!("invalid channel: {e}")),
    };
    channel.position = match index::next_channel_position(&conn) {
        Ok(position) => position,
        Err(e) => return send_error(&format!("failed to resolve channel position: {e}")),
    };

    let block = channel_to_block(vault, &channel);
    if let Err(e) = files::write_new_block_file(vault, &block) {
        return send_error(&format!("failed to write channel file: {e}"));
    }
    if let Err(error) = file_identity::reconcile(vault) {
        log::warn!("channel file created; identity enrollment deferred: {error:#}");
    }

    if let Err(e) = index::upsert_channel(&conn, &channel) {
        return send_error(&format!("failed to create channel: {e}"));
    }

    send_response(&CreateChannelResponse {
        ok: true,
        tag: channel.tag,
    });
}

fn channel_to_block(vault: &VaultLayout, channel: &Channel) -> Block {
    Block {
        slug: vault.new_collection_slug(&channel.tag),
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

/// Ask a server what it is about to serve, for URLs that do not say.
///
/// A failure here is not an error: the caller falls back to its own assumption,
/// so a server that refuses HEAD costs nothing beyond one request.
fn probe_ext_over_network(url: &str) -> Option<&'static str> {
    let resp = mine_lib::net::fetch_validated_head(url, INLINE_REQUEST_TIMEOUT, &[]).ok()?;
    media_extension_for_content_type(resp.header("Content-Type")?)
}

/// Whole-request timeout for the HEAD probe of inline media. ureq 2.x default
/// is 30s: too long for one stuck CDN to monopolize a worker slot when the
/// parallel pool only has 3 workers serving 15+ images.
const INLINE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How long an inline-media download may stall: connecting, or waiting for the
/// next bytes. It is not a deadline for the whole file. A 25 MB clip needs
/// longer than 15 seconds on an ordinary link, and a whole-request deadline
/// threw it away at 22 MB, then again on every retry.
const INLINE_DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Per-request timeout for the Twitter syndication API. Without it a hung
/// `cdn.syndication.twimg.com` would block `resolve_twitter_media` on the
/// serial host until the OS socket timeout.
const TWITTER_API_TIMEOUT: Duration = Duration::from_secs(10);

/// Download a file from URL to local path.
/// `referer` should be the page URL (not the image URL) — CDNs validate this.
/// Retries, resuming from the bytes already received, SSRF validation of every
/// redirect hop and the body-size cap live in
/// `mine_lib::net::download_validated_to_file`.
fn download_file(url: &str, dest: &std::path::Path, referer: &str) -> anyhow::Result<()> {
    let headers = [
        ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
        ("Referer", referer),
        ("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"),
    ];
    net::download_validated_to_file(url, dest, INLINE_DOWNLOAD_IDLE_TIMEOUT, &headers)
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
    range: std::ops::Range<usize>, // source bytes of the whole `![alt](url)`
    alt: String,                   // caption as written, line breaks as spaces
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
/// deterministic per-kind indices. Stops at `MAX_INLINE_IMAGES` http(s)
/// images; images with other destinations, and images the local form cannot
/// replace (see [`replaceable_body_images`]), are skipped without consuming
/// the cap.
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

    for image in replaceable_body_images(body) {
        if tasks.len() >= MAX_INLINE_IMAGES as usize {
            break;
        }
        let url = image.url.as_str();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
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

        tasks.push(InlineTask {
            range: image.range,
            alt: image.caption,
            url: image.url,
            host,
            kind,
            dest_name,
            dest_path,
        });
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
#[cfg(test)]
fn apply_rewrites(
    body: &str,
    tasks: &[InlineTask],
    outcomes: &[Result<(), String>],
) -> (String, Vec<std::path::PathBuf>) {
    apply_rewrites_with_links(body, tasks, outcomes, &mine_core::links::LinkIndex::new(
        tasks.iter().map(|task| task.dest_name.as_str())
    ))
}

fn apply_rewrites_with_links(
    body: &str,
    tasks: &[InlineTask],
    outcomes: &[Result<(), String>],
    links: &mine_core::links::LinkIndex,
) -> (String, Vec<std::path::PathBuf>) {
    debug_assert_eq!(tasks.len(), outcomes.len());

    // Dedup: pair each successful task with the earliest other successful
    // task whose downloaded file is byte-identical. The duplicate file goes;
    // its place in the text stays and points at the kept file. An author who
    // shows one picture twice, each time with its own caption, gets both
    // back (SPEC_AUDIT_FIXES.md, Ф5).
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
                let target = links.shortest_link(&task.dest_name, false)
                    .unwrap_or_else(|| task.dest_name.clone());
                let replacement = build_inline_wikilink(&target, task.alt.trim());
                specs.push(RewriteSpec {
                    range: task.range.clone(),
                    replacement,
                });
            }
            (Ok(()), Some(kept)) => {
                // Byte-identical to an earlier file: the same embed, reused.
                let kept = &tasks[kept].dest_name;
                let target = links.shortest_link(kept, false)
                    .unwrap_or_else(|| kept.clone());
                specs.push(RewriteSpec {
                    range: task.range.clone(),
                    replacement: build_inline_wikilink(&target, task.alt.trim()),
                });
            }
        }
    }

    // Apply in reverse offset order so earlier ranges stay valid.
    specs.sort_by_key(|spec| std::cmp::Reverse(spec.range.start));
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
    source_vault: &VaultLayout,
) -> (String, Vec<std::path::PathBuf>, Vec<String>) {
    let mut tasks = scan_inline_tasks_with(body, vault, slug, &probe_ext_over_network);
    let mut paths = match files::scan_vault_file_paths(source_vault) {
        Ok(paths) => paths,
        Err(error) => {
            log::warn!("inline media names unavailable: {error:#}");
            return (body.to_string(), Vec::new(), Vec::new());
        }
    };
    for task in &mut tasks {
        let filename = task.dest_name.rsplit('/').next().unwrap_or(&task.dest_name);
        let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename, ""));
        let Ok(name) = mine_core::save::select_unique_file_stem(stem, ext, &paths) else {
            log::warn!("inline media name exhausted");
            return (body.to_string(), Vec::new(), Vec::new());
        };
        let filename = if ext.is_empty() { name } else { format!("{name}.{ext}") };
        task.dest_path = vault.new_media_path(&filename);
        task.dest_name = vault.new_media_stem(&filename);
        paths.push(task.dest_name.clone());
    }
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
    let links = mine_core::links::LinkIndex::new(paths);
    let (result, inline_files) = apply_rewrites_with_links(body, &tasks, &outcomes, &links);
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

#[cfg(test)]
std::thread_local! {
    // Syndication requests made on this thread. Thread-local, like the
    // response capture, so parallel tests observe only their own requests.
    static SYNDICATION_REQUESTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Photos, videos and GIFs the public syndication API reports for one post.
/// Asked only while the popup prepares its preview (`resolve_twitter_media`);
/// Save writes the body it receives and never asks (Ф5).
fn fetch_tweet_media_previews(tweet_id: &str) -> anyhow::Result<Vec<TwitterMediaPreview>> {
    #[cfg(test)]
    SYNDICATION_REQUESTS.with(|requests| requests.set(requests.get() + 1));
    let api_url = format!("https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&token=0");
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
    // The copy that ships with the app, the vendor's unpacked build installed
    // next to this host, so a person who never opened a terminal still gets
    // restricted video. A one-file build beside the host is never looked for:
    // it unpacks its Python at every start, and that copy is what Gatekeeper
    // refused under Dia (SPEC_ONBOARDING.md, О8, О8.1).
    if let Some(beside) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(mine_lib::tool_process::ytdlp_in))
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

/// How long `yt-dlp` may take to resolve one post's video, and its
/// self-check: under the 30 s the extension waits for an answer, so the
/// clipper hears why rather than "Mine helper did not respond in time"
/// (SPEC_CLIPPER.md, 3d, В2). Room for a first start of a fresh copy, which
/// took 14 s on 07.10.2026 (Mine pays it at installation, О8.1, but a copy
/// installed by an older Mine has not had it).
const YTDLP_RESOLVE_DEADLINE: Duration = Duration::from_secs(25);
const YTDLP_PROBE_DEADLINE: Duration = Duration::from_secs(25);

/// Tools this helper started and that still run; killed when the helper
/// ends, so a tool stuck behind a system dialog does not outlive it (3d, В2).
static RUNNING_TOOLS: std::sync::LazyLock<RunningTools> = std::sync::LazyLock::new(RunningTools::new);

/// Handle a request on a thread of its own, so the loop keeps answering the
/// others while it waits on an external tool (SPEC_CLIPPER.md, 3d, В1). The
/// request's correlation id goes with it: its response names its own request.
fn spawn_off_loop(handle: impl FnOnce() + Send + 'static) {
    let id = current_message_id();
    let spawned = std::thread::Builder::new()
        .name("mine-host-request".into())
        .spawn(move || {
            set_current_message_id(id);
            handle();
        });
    if let Err(error) = spawned {
        send_error(&format!("could not start the request: {error}"));
    }
}

/// The protocol's answer to a failed tool (SPEC_CLIPPER.md, 3d, В3).
#[derive(serde::Serialize)]
struct VideoToolFailedResponse {
    ok: bool,
    code: &'static str,
    reason: &'static str,
    error: String,
}

impl VideoToolFailedResponse {
    fn of(failure: &ToolFailure) -> Self {
        Self {
            ok: false,
            code: "video_tool_failed",
            reason: failure.reason(),
            error: failure.to_string(),
        }
    }
}

/// What the self-check found about `yt-dlp` under this browser (3d, В5).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum VideoToolState {
    Ready { version: String },
    Unavailable { reason: &'static str, error: String },
}

fn probe_video_tool() -> VideoToolState {
    let Some(ytdlp) = locate_ytdlp() else {
        let failure = ToolFailure::Missing("yt-dlp not found".into());
        return VideoToolState::Unavailable { reason: failure.reason(), error: failure.to_string() };
    };
    match mine_lib::tool_process::run_with_deadline(
        std::process::Command::new(&ytdlp).arg("--version"),
        YTDLP_PROBE_DEADLINE,
        &RUNNING_TOOLS,
    ) {
        Ok(output) => VideoToolState::Ready { version: output.stdout.trim().to_string() },
        Err(failure) => VideoToolState::Unavailable { reason: failure.reason(), error: failure.to_string() },
    }
}

/// Run the self-check and remember a settled answer for the life of this
/// helper process: the tool and the browser that started it do not change
/// while it lives. A check past its deadline is not remembered, because a
/// first start of a fresh copy is slow once and fast after (О8.1): the next
/// request checks again.
fn handle_video_tool_status() {
    #[derive(serde::Serialize)]
    struct VideoToolStatusResponse<'a> {
        ok: bool,
        video_tool: &'a VideoToolState,
    }
    static SETTLED: std::sync::OnceLock<VideoToolState> = std::sync::OnceLock::new();
    if let Some(state) = SETTLED.get() {
        return send_response(&VideoToolStatusResponse { ok: true, video_tool: state });
    }
    let state = probe_video_tool();
    host_log(&format!("video_tool_status: {state:?}"));
    let state = if settles(&state) { SETTLED.get_or_init(|| state.clone()) } else { &state };
    send_response(&VideoToolStatusResponse { ok: true, video_tool: state });
}

/// Whether a self-check answer holds for the life of the helper: every one
/// but a check past its deadline.
fn settles(state: &VideoToolState) -> bool {
    !matches!(state, VideoToolState::Unavailable { reason: "timeout", .. })
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
) -> Result<Vec<(String, Option<String>)>, ToolFailure> {
    if cookies.is_empty() {
        return Err(ToolFailure::Failed("no browser cookies supplied".into()));
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
    let written = std::fs::write(&jar_path, jar);
    let _jar_guard = TempFileGuard(jar_path.clone());
    written.map_err(|error| ToolFailure::Failed(format!("cookie file: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&jar_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| ToolFailure::Failed(format!("cookie file: {error}")))?;
    }

    let ytdlp = locate_ytdlp().ok_or_else(|| {
        ToolFailure::Missing(
            "yt-dlp not found. Install it (brew install yt-dlp) so age-restricted \
             posts can be resolved."
                .into(),
        )
    })?;

    let output = mine_lib::tool_process::run_with_deadline(
        std::process::Command::new(&ytdlp)
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
            .arg(tweet_url),
        YTDLP_RESOLVE_DEADLINE,
        &RUNNING_TOOLS,
    )?;

    let urls: Vec<(String, Option<String>)> = output
        .stdout
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
        return Err(ToolFailure::Failed("no progressive mp4 available for this post".into()));
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
                Err(failure) => {
                    host_log(&format!("resolve_twitter_media: yt-dlp failed: {failure}"));
                    return send_response(&VideoToolFailedResponse::of(&failure));
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
    // Only a located space receives the upload: a path the app would not
    // open (another space or a folder without an identity) gets nothing, not
    // even an identity file.
    let vault_path = query_param(request.url(), "vault_path")
        .or_else(|| UPLOAD_VAULT.lock().ok().and_then(|v| v.clone()))
        .and_then(|path| resolve_request_space(Some(path), None).path);

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
        let response = tiny_http::Response::from_string("Space not configured or not available")
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

/// The identity of an executable file: a new build installed at the same
/// path is a different file (SPEC_CLIPPER.md, К4).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecutableStamp {
    device: u64,
    inode: u64,
    len: u64,
    modified: Option<std::time::SystemTime>,
}

impl ExecutableStamp {
    fn of(path: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

/// The helper file this process was started from, as it was at start.
struct StartedFrom {
    path: PathBuf,
    stamp: ExecutableStamp,
    /// A browser registration named this file at start. Only such a helper
    /// can be superseded by a new registration; one started by hand (tests,
    /// smoke checks) is not the browser's helper.
    registered: bool,
}

static STARTED_FROM: std::sync::OnceLock<Option<StartedFrom>> = std::sync::OnceLock::new();

/// Whether a newer helper has replaced this process. The browser keeps one
/// connection per session, so without this an old process would go on
/// answering after an update (К4). Two ways to be replaced: a new file at
/// this path, or registrations that now name another installed package. A
/// missing file is not a replacement: nothing newer is there.
fn replaced_by_newer_helper() -> bool {
    let Some(Some(started)) = STARTED_FROM.get() else {
        return false;
    };
    if ExecutableStamp::of(&started.path).is_some_and(|now| now != started.stamp) {
        return true;
    }
    started.registered
        && mine_lib::clipper_registration::library_dir().is_some_and(|library| {
            mine_lib::clipper_registration::superseded(&library, &started.path)
        })
}

fn main() {
    STARTED_FROM.get_or_init(|| {
        let path = std::env::current_exe().ok()?;
        let stamp = ExecutableStamp::of(&path)?;
        let registered = mine_lib::clipper_registration::library_dir()
            .is_some_and(|library| mine_lib::clipper_registration::is_registered(&library, &path));
        Some(StartedFrom { path, stamp, registered })
    });
    if std::env::args().nth(1).as_deref() == Some("--runtime-probe") {
        let probe = mine_lib::runtime_protocol::RuntimeProbe {
            schema_version: 1, version: VERSION.into(),
            build_id: option_env!("MINE_BUILD_ID").unwrap_or("unidentified-build").into(),
            commit: option_env!("MINE_BUILD_COMMIT").unwrap_or("unknown").into(),
            save_protocols: vec![mine_lib::runtime_protocol::BASE_SAVE_PROTOCOL],
        };
        match serde_json::to_string(&probe) {
            Ok(json) => println!("{json}"),
            Err(error) => { eprintln!("runtime probe encoding failed: {error}"); std::process::exit(1); }
        }
        return;
    }
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
        set_current_message_id(NO_MESSAGE_ID);
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
            set_current_message_id(id);
        }

        // A newer helper was installed: this process does nothing with the
        // request and ends; the extension reconnects to the new helper and
        // sends the request again (К4).
        if replaced_by_newer_helper() {
            send_response(&serde_json::json!({
                "ok": false,
                "code": "host_replaced",
                "outcome": "not_committed",
                "error": "The Mine helper was updated. Reconnecting.",
            }));
            break;
        }

        // Diagnostic ACK has no vault input or capture side effects.
        if req.action == "confirm_connection_check" {
            handle_confirm_connection_check(launch_origin.as_deref(), req.params);
            continue;
        }

        if req.action == "save_block" {
            if let Err(error) = mine_lib::runtime_protocol::validate_save_request(&req.params) {
                send_response(&incompatible_save_response(&req.params, error));
                continue;
            }
        }

        // The space is found by identity; the path the popup sent is where
        // to look first (SPEC_CLIPPER.md, К1).
        let binding_hint = req
            .params
            .get("binding_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let request_space = || {
            let space = resolve_request_space(req.vault_path.clone(), binding_hint.as_deref());
            if let Some(ref vp) = space.path {
                if let Ok(mut v) = UPLOAD_VAULT.lock() {
                    *v = Some(vp.clone());
                }
            }
            space
        };

        match req.action.as_str() {
            "get_status" => {
                let space = request_space();
                handle_get_status_with_upload(
                    &upload_server,
                    &space,
                    config_generation(&read_app_settings()),
                );
            }
            "list_known_vaults" => handle_list_known_vaults(),
            "pick_vault_folder" => handle_pick_vault_folder(),
            "reveal_vault" => handle_reveal_vault(req.params),
            "open_app" => handle_open_app(req.params),
            // External tools run off the loop (SPEC_CLIPPER.md, 3d, В1).
            "resolve_twitter_media" => {
                let params = req.params;
                spawn_off_loop(move || handle_resolve_twitter_media(params));
            }
            "video_tool_status" => spawn_off_loop(handle_video_tool_status),

            "list_channels" | "save_block" | "create_channel" | "get_save_operation" => {
                let space = request_space();
                let writes = matches!(req.action.as_str(), "save_block" | "create_channel");
                let opened = native_app_data_dir()
                    .map_err(SpaceRefusal::Failed)
                    .and_then(|state| open_request_vault(&space, writes, state));
                let vault = match opened {
                    Ok(vault) => vault,
                    Err(SpaceRefusal::Space(space)) => {
                        send_space_error(&space);
                        continue;
                    }
                    Err(SpaceRefusal::Failed(error)) => {
                        send_error(&error);
                        continue;
                    }
                };

                let mut params = req.params;
                if matches!(req.action.as_str(), "save_block" | "get_save_operation") {
                    adopt_space_journal(&vault, &space, &mut params);
                }
                match req.action.as_str() {
                    "list_channels" => handle_list_channels(&vault),
                    "save_block" => handle_save_block(&vault, params),
                    "get_save_operation" => handle_get_save_operation(&vault, params),
                    "create_channel" => handle_create_channel(&vault, params),
                    _ => unreachable!(),
                }
            }

            other => send_error(&format!("unknown action: {other}")),
        }
    }
    // The browser closed the connection or a newer helper took over: a tool
    // still running for a request nobody waits for any more ends with this
    // process (SPEC_CLIPPER.md, 3d, В2).
    RUNNING_TOOLS.kill_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn native_first_space_creates_defaults_once() {
        let root = TempDir::new().unwrap();
        let vault = VaultLayout::new(root.path().to_path_buf());
        initialize_native_new_space_layout(&vault).unwrap();
        assert_eq!(files::load_vault_write_layout(&vault).unwrap(), mine_lib::domain::vault::VaultWriteLayout::standard());
        for folder in ["Cards", "Media", "Collections"] {
            assert!(root.path().join(folder).is_dir());
        }
        std::fs::remove_dir(root.path().join("Media")).unwrap();
        initialize_native_new_space_layout(&vault).unwrap();
        assert!(!root.path().join("Media").exists());
    }

    #[test]
    fn native_existing_space_without_layout_writes_to_root() {
        let root = TempDir::new().unwrap();
        let vault = VaultLayout::new(root.path().to_path_buf());
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        std::fs::write(vault.vault_id_path(), b"existing-space").unwrap();
        initialize_native_new_space_layout(&vault).unwrap();
        assert_eq!(files::load_vault_write_layout(&vault).unwrap(), mine_lib::domain::vault::VaultWriteLayout::flat());
        assert!(!root.path().join("Cards").exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_space_aliases_share_one_identity() {
        let root = TempDir::new().unwrap();
        let links = TempDir::new().unwrap();
        let alias = links.path().join("alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        assert!(same_native_space(alias.to_str().unwrap(), root.path().to_str().unwrap()));
        assert_eq!(canonical_native_space_path(alias.to_str().unwrap()).unwrap(), root.path().canonicalize().unwrap().to_string_lossy());
    }

    fn make_staging(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn test_dt() -> DateTime {
        DateTime::new("2026-04-24T12:00:00Z").unwrap()
    }

    #[test]
    fn native_collection_document_follows_saved_layout() {
        let vault = VaultLayout::new(std::path::PathBuf::from("/unused"))
            .with_write_layout(mine_lib::domain::vault::VaultWriteLayout {
                cards: "Notes".into(), media: "Assets".into(), collections: "Groups/Sets".into(),
            });
        let channel = Channel::new("Reading", test_dt()).unwrap();
        assert_eq!(channel_to_block(&vault, &channel).slug, "Groups/Sets/Reading");
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
    fn incompatible_save_protocol_is_rejected_before_source_or_journal_writes() {
        let (tmp, vault) = sc2_temp_vault();
        std::fs::write(vault.root().join("existing.md"), "# Existing source\n").unwrap();
        let before = std::fs::read(vault.root().join("existing.md")).unwrap();
        let response = sc0_save_response(&vault, serde_json::json!({
            "block_type": "link", "title": "Rejected", "url": "https://example.com",
            "save_protocol": 2, "operation_id": "incompatible-operation"
        }));
        assert_eq!(response["code"], "incompatible_protocol");
        assert_eq!(response["outcome"], "not_committed");
        assert_eq!(response["terminal_rejected"], true);
        assert_eq!(response["operation_id"], "incompatible-operation");
        assert_eq!(std::fs::read(vault.root().join("existing.md")).unwrap(), before);
        assert_eq!(files::scan_md_files(&vault).unwrap().len(), 1);
        assert!(!tmp.path().join("derived").exists());
        assert!(!vault.root().join(".mine").exists());
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
            Some("Canonical.jpg")
        );
        assert!(markdown.contains("[[Canonical.jpg]]"));
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
    fn a_selection_is_saved_as_shown_without_page_title_or_post_video() {
        let (_tmp, vault) = sc2_temp_vault();
        let request = serde_json::json!({"operation_id":"selection","block_type":"article",
            "title":"Long article title","url":"https://example.com/article",
            "body":"Selected words","tags":[],"selection":true});
        let response = sc0_save_response(&vault, request);
        assert_eq!(response["outcome"], "committed");
        let path = vault.block_path(response["slug"].as_str().unwrap());
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.ends_with("---\nSelected words"), "{content}");
    }

    #[test]
    fn saving_an_x_post_writes_the_shown_body_without_asking_for_post_video() {
        // Ф5, Б4.3: Save writes exactly what the preview showed. Neither a
        // whole post nor a selection gets a video the preview did not carry,
        // and the helper does not even ask the syndication API for one.
        let (_tmp, vault) = sc2_temp_vault();
        let body = "First part of the thread\n\n---\n\nSecond part, no video here";
        for (index, selection) in [false, true].into_iter().enumerate() {
            SYNDICATION_REQUESTS.with(|requests| requests.set(0));
            let response = sc0_save_response(&vault, serde_json::json!({
                "operation_id": format!("x-post-{index}"), "block_type": "article",
                "title": format!("Post {index}"),
                "url": "https://x.com/author/status/1234567890123456789",
                "body": body, "tags": [], "selection": selection
            }));
            assert_eq!(response["outcome"], "committed", "{response}");
            assert_eq!(SYNDICATION_REQUESTS.with(std::cell::Cell::get), 0);
            let path = vault.block_path(response["slug"].as_str().unwrap());
            let content = std::fs::read_to_string(path).unwrap();
            assert!(content.ends_with(&format!("---\n{body}")), "{content}");
        }
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
                assert!(markdown.contains("[[Prepared capture.png]]"));
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
    fn reliability_native_generation_preserves_legacy_db_wal_and_history() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let base = VaultLayout::new(root.clone());
        std::fs::create_dir_all(base.legacy_arena_dir()).unwrap();
        std::fs::write(base.legacy_vault_id_path(), b"legacy-native-id").unwrap();
        std::fs::write(base.legacy_index_db_path(), b"foreign database").unwrap();
        let wal = PathBuf::from(format!("{}-wal", base.legacy_index_db_path().display()));
        std::fs::write(&wal, b"foreign wal").unwrap();
        let history = base.legacy_arena_dir().join("unknown-history.json");
        std::fs::write(&history, b"history is not a cache").unwrap();
        let vault = resolve_native_vault_layout_at(root, temp.path().join("state")).unwrap();
        assert_ne!(vault.index_db_path(), base.legacy_index_db_path());
        assert_eq!(std::fs::read(base.legacy_index_db_path()).unwrap(), b"foreign database");
        assert_eq!(std::fs::read(wal).unwrap(), b"foreign wal");
        assert_eq!(std::fs::read(history).unwrap(), b"history is not a cache");
        assert_eq!(std::fs::read(base.legacy_vault_id_path()).unwrap(), b"legacy-native-id");
    }

    #[test]
    fn sc2_two_distinct_captures_keep_standard_layout_after_fresh_native_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let state = temp.path().join("app-state");
        std::fs::create_dir(&root).unwrap();
        initialize_native_new_space_layout(&VaultLayout::new(root.clone())).unwrap();
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
        assert!(root.join("Cards").is_dir());
        assert!(root.join("Media").is_dir());
        assert!(root.join("Collections").is_dir());
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
        let (tmp, vault) = sc2_temp_vault();
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        std::fs::write(vault.vault_id_path(), K_SPACE_ID).unwrap();
        // A folder without an identity of its own is not a space (Ф8).
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        for (path, expected) in [
            (None, "unconfigured"),
            (
                Some(vault.root().join("missing").to_string_lossy().into_owned()),
                "missing",
            ),
            (Some(plain.to_string_lossy().into_owned()), "unavailable"),
            (Some(vault.root().to_string_lossy().into_owned()), "ready"),
        ] {
            SC0_RESPONSE_CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
            let space = resolve_request_space_in(&serde_json::Map::new(), None, path, None);
            handle_get_status_with_upload(&None, &space, 7);
            let responses =
                SC0_RESPONSE_CAPTURE.with(|capture| capture.borrow_mut().take().unwrap());
            let response: serde_json::Value = serde_json::from_str(&responses[0]).unwrap();
            assert_eq!(response["ok"], true);
            assert_eq!(response["connected"], true);
            assert_eq!(response["folder_state"], expected);
            assert_eq!(response["vaultConfigured"], expected == "ready");
            assert_eq!(response["config_generation"], 7);
            // A missing folder is described, never reported with the OS text.
            if expected == "missing" {
                let error = response["error"].as_str().unwrap();
                assert!(error.contains("renamed, moved"), "{error}");
                assert!(!error.contains("os error"), "{error}");
            }
            if expected == "ready" {
                assert_eq!(
                    response["binding_id"],
                    save_operations::binding_id(&vault).unwrap()
                );
            }
        }
        assert_eq!(std::fs::read_dir(&plain).unwrap().count(), 0);
    }

    const K_SPACE_ID: &str = "0123456789abcdef0123456789abcdef";

    fn k_space(parent: &Path, name: &str) -> String {
        let folder = parent.join(name);
        std::fs::create_dir_all(folder.join(".mine")).unwrap();
        std::fs::write(folder.join(".mine/vault-id"), K_SPACE_ID).unwrap();
        std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn k1_a_space_renamed_between_two_requests_is_found_by_identity() {
        let tmp = TempDir::new().unwrap();
        let old = k_space(tmp.path(), "Mine");
        let cfg = serde_json::Map::new();
        let first = resolve_request_space_in(&cfg, None, Some(old.clone()), Some(K_SPACE_ID));
        assert_eq!(first.state, "ready");
        assert!(first.binding_accepted);

        let renamed = Path::new(&old).with_file_name("Mine!");
        std::fs::rename(&old, &renamed).unwrap();
        let second = resolve_request_space_in(&cfg, None, Some(old.clone()), Some(K_SPACE_ID));
        assert_eq!(second.state, "moved");
        assert_eq!(second.path.as_deref(), renamed.to_str());
        assert_eq!(second.moved_from.as_deref(), Some(old.as_str()));
        assert!(second.binding_accepted);
    }

    #[test]
    fn k3_a_lost_space_is_described_and_blocks_nothing_else() {
        let tmp = TempDir::new().unwrap();
        let gone = tmp.path().join("Mine").to_string_lossy().into_owned();
        let space =
            resolve_request_space_in(&serde_json::Map::new(), None, Some(gone), Some(K_SPACE_ID));
        assert_eq!(space.state, "missing");
        assert!(space.path.is_none());
        assert!(space.message().unwrap().starts_with("“Mine” was renamed"));
    }

    #[test]
    fn k6_reveal_opens_where_the_space_is_now_and_explains_otherwise() {
        let tmp = TempDir::new().unwrap();
        let old = k_space(tmp.path(), "Mine");
        let mut cfg = serde_json::Map::new();
        mine_lib::space_registry::record_open(&mut cfg, K_SPACE_ID, &old, 1);
        let renamed = Path::new(&old).with_file_name("Mine!");
        std::fs::rename(&old, &renamed).unwrap();
        mine_lib::space_registry::record_open(&mut cfg, K_SPACE_ID, renamed.to_str().unwrap(), 2);
        // The popup before К6 nested its fields; the current one does not.
        for params in [
            serde_json::json!({ "params": { "path": renamed.to_string_lossy() } }),
            serde_json::json!({ "path": old, "binding_id": K_SPACE_ID }),
        ] {
            assert_eq!(reveal_target_in(&cfg, None, &params).unwrap(), renamed.to_str().unwrap());
        }
        // Another person's space, and a folder that is no space at all.
        let stranger = tmp.path().join("Stranger");
        std::fs::create_dir_all(stranger.join(".mine")).unwrap();
        std::fs::write(stranger.join(".mine/vault-id"), "abcdefabcdefabcdefabcdefabcdefab").unwrap();
        let refused = reveal_target_in(
            &cfg,
            None,
            &serde_json::json!({ "path": stranger.to_string_lossy() }),
        )
        .unwrap_err();
        assert_eq!(refused.message().unwrap(), "“Stranger” is not one of your Mine spaces.");
        let plain = tmp.path().join("Plain");
        std::fs::create_dir_all(&plain).unwrap();
        let refused = reveal_target_in(
            &cfg,
            None,
            &serde_json::json!({ "path": plain.to_string_lossy() }),
        )
        .unwrap_err();
        assert!(refused.path.is_none());
        let gone = reveal_target_in(
            &serde_json::Map::new(),
            None,
            &serde_json::json!({ "path": tmp.path().join("Gone").to_string_lossy(), "binding_id": "fedcba9876543210fedcba9876543210" }),
        )
        .unwrap_err();
        assert_eq!(gone.state, "missing");
    }

    #[test]
    fn k4_a_file_installed_over_the_helper_is_a_different_helper() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("native-host");
        std::fs::write(&path, b"old build").unwrap();
        let started = ExecutableStamp::of(&path).unwrap();
        assert_eq!(ExecutableStamp::of(&path), Some(started.clone()));
        // Installers put the new file next to the old one and rename it over.
        let next = tmp.path().join("native-host.new");
        std::fs::write(&next, b"new build!").unwrap();
        std::fs::rename(&next, &path).unwrap();
        assert_ne!(ExecutableStamp::of(&path).unwrap(), started);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(ExecutableStamp::of(&path), None);
    }

    fn k3_space_with_collection() -> (TempDir, VaultLayout) {
        let tmp = TempDir::new().unwrap();
        let vault = VaultLayout::with_derived_root(tmp.path().join("space"), tmp.path().join("derived"))
            .with_write_layout(mine_lib::domain::vault::VaultWriteLayout::standard());
        for folder in ["Cards", "Collections"] {
            std::fs::create_dir_all(vault.root().join(folder)).unwrap();
        }
        std::fs::write(vault.root().join("Collections/Art.md"), "---\ntype: channel\n---\n").unwrap();
        std::fs::write(
            vault.root().join("Cards/Card.md"),
            "---\nsaved_at: 2026-09-29T10:00:00\nMine Collections:\n  - \"[[Art]]\"\n---\n# Card\n",
        )
        .unwrap();
        (tmp, vault)
    }

    #[test]
    fn k3_collections_without_an_index_come_from_the_folder_at_once() {
        let (_tmp, vault) = k3_space_with_collection();
        let response = list_channels_response(&vault);
        assert_eq!(response["ok"], true);
        assert_eq!(response["indexing"], true);
        assert_eq!(response["channels"], serde_json::json!([{ "tag": "Art", "block_count": null }]));
        // Answering created no index: building one is background work.
        assert!(db::existing_selected_index(&vault).unwrap().is_none());
    }

    #[test]
    fn k3_collections_come_from_a_ready_index_without_reading_cards() {
        let (_tmp, vault) = k3_space_with_collection();
        {
            let (vault, conn, _) = db::open_vault_index(vault.clone()).unwrap();
            mine_lib::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
            index::backfill_collection_index(&conn, &vault).unwrap();
        }
        // A card changed on disk after indexing is not read to answer.
        std::fs::write(vault.root().join("Cards/Card.md"), "unreadable \u{0}").unwrap();
        let response = list_channels_response(&vault);
        assert_eq!(response["ok"], true);
        assert!(response.get("indexing").is_none());
        assert_eq!(response["channels"], serde_json::json!([{ "tag": "Art", "block_count": 1 }]));
    }

    #[test]
    fn k3_a_flat_space_offers_no_names_before_its_index() {
        let (_tmp, vault) = k3_space_with_collection();
        let flat = vault.with_write_layout(mine_lib::domain::vault::VaultWriteLayout::flat());
        assert!(folder_collections(&flat).is_empty());
    }

    #[test]
    fn k4_status_names_the_installed_extension_build() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(installed_extension_build(tmp.path()), None);
        let managed = tmp.path().join("clipper/managed-v1/extension/dist");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join("runtime-identity.json"), r#"{"buildId":"managed","commit":"c"}"#).unwrap();
        assert_eq!(installed_extension_build(tmp.path()).as_deref(), Some("managed"));
        let loaded = tmp.path().join("clipper/extension/dist");
        std::fs::create_dir_all(&loaded).unwrap();
        std::fs::write(loaded.join("runtime-identity.json"), r#"{"buildId":"loaded","commit":"c"}"#).unwrap();
        assert_eq!(installed_extension_build(tmp.path()).as_deref(), Some("loaded"));
    }

    #[test]
    fn open_mine_prefers_the_copy_in_applications() {
        let tmp = TempDir::new().unwrap();
        let system = tmp.path().join("Applications");
        let user = tmp.path().join("home/Applications");
        std::fs::create_dir_all(user.join("Mine.app/Contents")).unwrap();
        std::fs::write(user.join("Mine.app/Contents/Info.plist"), "plist").unwrap();
        let folders = [Some(system.clone()), Some(user.clone())];
        assert_eq!(installed_app_in(&folders), Some(user.join("Mine.app")));
        std::fs::create_dir_all(system.join("Mine.app/Contents")).unwrap();
        std::fs::write(system.join("Mine.app/Contents/Info.plist"), "plist").unwrap();
        assert_eq!(installed_app_in(&folders), Some(system.join("Mine.app")));
        assert_eq!(installed_app_in(&[None]), None);
    }

    #[test]
    fn k2_a_path_binding_is_accepted_only_for_its_own_space() {
        let tmp = TempDir::new().unwrap();
        let path = k_space(tmp.path(), "Mine");
        let cfg = serde_json::Map::new();
        let own = save_operations::legacy_binding_of_path(&path);
        let space = resolve_request_space_in(&cfg, None, Some(path.clone()), Some(&own));
        assert!(space.binding_accepted);
        assert_eq!(space.accepted_legacy.as_deref(), Some(own.as_str()));

        let foreign = save_operations::legacy_binding_of_path("/elsewhere/Other");
        let space = resolve_request_space_in(&cfg, None, Some(path), Some(&foreign));
        assert!(!space.binding_accepted);
        assert!(space.accepted_legacy.is_none());
    }

    #[test]
    fn k2_a_pending_save_continues_after_the_space_is_renamed() {
        let (tmp, vault) = sc2_temp_vault();
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        std::fs::write(vault.vault_id_path(), K_SPACE_ID).unwrap();
        let binding = save_operations::binding_id(&vault).unwrap();
        assert_eq!(binding, K_SPACE_ID);
        let mut request = sc0_image_request("Before rename", "k2-rename");
        request["operation_id"] = serde_json::json!("k2-rename");
        request["binding_id"] = serde_json::json!(binding);
        request["executor_id"] = serde_json::json!("native");
        // The receipt exists, the publication did not happen yet.
        {
            let store = operation_store(&vault).unwrap();
            let locked = store.lock(&binding).unwrap();
            let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
            locked
                .begin("k2-rename", fingerprint_capture(&p, &binding), &request)
                .unwrap();
        }
        let renamed = tmp.path().join("renamed-space");
        std::fs::rename(vault.root(), &renamed).unwrap();
        let space = resolve_request_space_in(
            &serde_json::Map::new(),
            None,
            Some(vault.root().to_string_lossy().into_owned()),
            Some(&binding),
        );
        assert_eq!(space.state, "moved");
        let moved = VaultLayout::with_derived_root(renamed, vault.derived_root().to_path_buf());
        let mut params = request.clone();
        adopt_space_journal(&moved, &space, &mut params);
        assert_eq!(params["binding_id"], K_SPACE_ID);
        let store = operation_store(&moved).unwrap();
        let locked = store.lock(K_SPACE_ID).unwrap();
        assert!(locked.load("k2-rename").unwrap().is_some());
    }

    #[test]
    fn k2_receipts_under_the_old_path_binding_follow_the_space() {
        let (_tmp, vault) = sc2_temp_vault();
        let legacy = save_operations::legacy_binding_id(&vault).unwrap();
        let mut request = sc0_image_request("Legacy", "k2-legacy");
        request["operation_id"] = serde_json::json!("k2-legacy");
        request["binding_id"] = serde_json::json!(legacy);
        request["executor_id"] = serde_json::json!("native");
        let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
        {
            let store = operation_store(&vault).unwrap();
            let locked = store.lock(&legacy).unwrap();
            locked
                .begin("k2-legacy", fingerprint_capture(&p, &legacy), &request)
                .unwrap();
        }
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        std::fs::write(vault.vault_id_path(), K_SPACE_ID).unwrap();
        let space = resolve_request_space_in(
            &serde_json::Map::new(),
            None,
            Some(vault.root().to_string_lossy().into_owned()),
            Some(&legacy),
        );
        assert!(space.binding_accepted);
        let mut params = request.clone();
        adopt_space_journal(&vault, &space, &mut params);
        assert_eq!(params["binding_id"], K_SPACE_ID);
        let store = operation_store(&vault).unwrap();
        let locked = store.lock(K_SPACE_ID).unwrap();
        let record = locked.load("k2-legacy").unwrap().unwrap();
        assert_eq!(record.adopted_from.as_deref(), Some(legacy.as_str()));
        assert_eq!(record.fingerprint, fingerprint_capture(&p, &legacy));
    }

    /// Settings from before the registry: a path list and the current path.
    fn legacy_settings(path: &str) -> serde_json::Map<String, serde_json::Value> {
        serde_json::json!({ "vault_path": path, "known_vaults": [path] })
            .as_object()
            .unwrap()
            .clone()
    }

    /// The app's derived store for `id` last served the folder at `path`.
    fn derived_owner(state: &Path, id: &str, path: &str) {
        let store = mine_lib::space_registry::vaults_dir(state).join(id);
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(
            store.join("owner-path.json"),
            serde_json::json!({ "path": path }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn a_moved_legacy_space_is_found_through_its_derived_store_and_the_old_folder_gets_nothing() {
        // Б2.2 in the helper: the settings list only path A, the derived store
        // of space X last saw it at A. Now A is an empty folder and X lives
        // in B. The clip goes to B, as the app would open B.
        let tmp = TempDir::new().unwrap();
        let spaces = tmp.path().join("Spaces");
        std::fs::create_dir_all(spaces.join("Mine")).unwrap();
        let a = std::fs::canonicalize(spaces.join("Mine"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let b = k_space(&spaces, "Mine moved");
        let state = tmp.path().join("state");
        derived_owner(&state, K_SPACE_ID, &a);
        let cfg = legacy_settings(&a);
        let vaults = mine_lib::space_registry::vaults_dir(&state);

        // A popup that remembers A, and one that sends no path at all.
        for requested in [Some(a.clone()), None] {
            let space = resolve_request_space_in(&cfg, Some(&vaults), requested, None);
            assert_eq!(space.state, "moved");
            assert_eq!(space.path.as_deref(), Some(b.as_str()));
            assert_eq!(space.identity.as_deref(), Some(K_SPACE_ID));
        }

        let space = resolve_request_space_in(&cfg, Some(&vaults), Some(a.clone()), None);
        let Ok(vault) = open_request_vault(&space, true, state.clone()) else {
            panic!("the located space opens");
        };
        let response = sc0_save_response(&vault, sc2_link_request("legacy-moved"));
        assert_eq!(response["outcome"], "committed", "{response}");
        let card = vault.block_path("Local link");
        assert!(card.starts_with(&b) && card.is_file(), "{}", card.display());
        assert_eq!(std::fs::read_dir(&a).unwrap().count(), 0, "A must stay untouched");
    }

    #[test]
    fn a_moved_legacy_space_is_listed_where_it_is_and_the_empty_folder_is_not() {
        // В2.2 in the helper: the settings list only path A, the derived
        // store of space X last saw it at A, A is now an empty folder and X
        // lives in B. The popup's space list and Reveal follow X to B.
        let tmp = TempDir::new().unwrap();
        let spaces = tmp.path().join("Spaces");
        std::fs::create_dir_all(spaces.join("Mine")).unwrap();
        let a = std::fs::canonicalize(spaces.join("Mine"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let b = k_space(&spaces, "Mine moved");
        let state = tmp.path().join("state");
        derived_owner(&state, K_SPACE_ID, &a);
        let vaults = mine_lib::space_registry::vaults_dir(&state);

        // Settings from before the registry, and ones that already list B too.
        let mut listing_both = legacy_settings(&a);
        listing_both["known_vaults"] = serde_json::json!([a, b]);
        for cfg in [legacy_settings(&a), listing_both] {
            assert_eq!(load_known_vaults_in(&cfg, Some(&vaults)), [b.clone()]);
            assert_eq!(
                reveal_target_in(&cfg, Some(&vaults), &serde_json::json!({ "path": a })).unwrap(),
                b
            );
        }
        assert_eq!(std::fs::read_dir(&a).unwrap().count(), 0, "A must stay untouched");
    }

    #[test]
    fn a_legacy_path_holding_another_space_or_no_space_receives_nothing() {
        let tmp = TempDir::new().unwrap();
        let state = tmp.path().join("state");
        let vaults = mine_lib::space_registry::vaults_dir(&state);

        // The derived store saw space X at A; A now holds another space.
        let foreign = tmp.path().join("Foreign");
        std::fs::create_dir_all(foreign.join(".mine")).unwrap();
        std::fs::write(foreign.join(".mine/vault-id"), "fedcba9876543210fedcba9876543210").unwrap();
        let foreign = foreign.to_string_lossy().into_owned();
        derived_owner(&state, K_SPACE_ID, &foreign);
        // No store ever saw a space at P, and P has no identity of its own.
        let plain = tmp.path().join("Plain");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("note.md"), "# Someone's notes\n").unwrap();
        let plain = plain.to_string_lossy().into_owned();

        for path in [&foreign, &plain] {
            let before = files_under(Path::new(path));
            let space = resolve_request_space_in(&legacy_settings(path), Some(&vaults), None, None);
            assert_eq!(space.state, "unavailable", "{path}");
            assert!(space.path.is_none());
            assert!(matches!(
                open_request_vault(&space, true, state.clone()),
                Err(SpaceRefusal::Space(_))
            ));
            assert_eq!(files_under(Path::new(path)), before, "{path}");
        }
    }

    /// Д2.1: the space X, opened by the app at A and indexed there with the
    /// collection `Art`, and a copy B of it carrying X too, listed while its
    /// identity could not be read (П22).
    struct CopiedSpace {
        _tmp: TempDir,
        state: PathBuf,
        vaults: PathBuf,
        original: String,
        copy: String,
        cfg: serde_json::Map<String, serde_json::Value>,
    }

    impl CopiedSpace {
        /// `in_cloud` puts the folders under an iCloud container, so an
        /// identity file without data counts as one only in iCloud.
        fn new(in_cloud: bool) -> Self {
            let tmp = TempDir::new().unwrap();
            let parent = if in_cloud {
                tmp.path().join("Mobile Documents")
            } else {
                tmp.path().join("Spaces")
            };
            let original = k_space(&parent, "Mine");
            for folder in ["Cards", "Collections"] {
                std::fs::create_dir_all(Path::new(&original).join(folder)).unwrap();
            }
            std::fs::write(
                Path::new(&original).join(".mine/layout.json"),
                r#"{"cards":"Cards","media":"Media","collections":"Collections"}"#,
            )
            .unwrap();
            std::fs::write(Path::new(&original).join("Collections/Art.md"), "---\ntype: channel\n---\n")
                .unwrap();
            let state = tmp.path().join("state");
            let vaults = mine_lib::space_registry::vaults_dir(&state);
            derived_owner(&state, K_SPACE_ID, &original);
            {
                let layout = VaultLayout::with_derived_root(
                    PathBuf::from(&original),
                    vaults.join(K_SPACE_ID),
                )
                .with_write_layout(mine_lib::domain::vault::VaultWriteLayout::standard());
                let (layout, conn, _) = db::open_vault_index(layout).unwrap();
                mine_lib::storage::reconcile::reconcile_vault(&conn, &layout).unwrap();
                index::backfill_collection_index(&conn, &layout).unwrap();
            }
            // The copy was made before `Art`, and carries the same identity.
            let copy = k_space(&parent, "Mine copy");
            let mut cfg = serde_json::Map::new();
            mine_lib::space_registry::record_open(&mut cfg, K_SPACE_ID, &original, 1);
            mine_lib::space_registry::add_space(&mut cfg, None, &copy);
            Self { _tmp: tmp, state, vaults, original, copy, cfg }
        }

        /// The cards the original's index lists.
        fn original_rows(&self) -> Vec<String> {
            let layout = VaultLayout::with_derived_root(
                PathBuf::from(&self.original),
                self.vaults.join(K_SPACE_ID),
            );
            let selected = db::existing_selected_index(&layout).unwrap().unwrap();
            let conn = db::open_read_only(&selected.index_db_path()).unwrap();
            let mut slugs: Vec<String> =
                index::list_blocks(&conn).unwrap().into_iter().map(|block| block.slug).collect();
            slugs.sort();
            slugs
        }

        /// Leave only the data an identity file iCloud moved off this Mac
        /// keeps: its name and size, no blocks.
        fn evict_identity(folder: &str) {
            let id = Path::new(folder).join(".mine/vault-id");
            std::fs::remove_file(&id).unwrap();
            std::fs::File::create(&id).unwrap().set_len(32).unwrap();
        }
    }

    fn collection_names(response: &serde_json::Value) -> Vec<String> {
        response["channels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|channel| channel["tag"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_copy_chosen_in_the_clipper_never_reads_or_writes_the_original_index() {
        let space = CopiedSpace::new(false);
        let rows_before = space.original_rows();

        let request =
            resolve_request_space_in(&space.cfg, Some(&space.vaults), Some(space.copy.clone()), None);
        assert_eq!(request.path.as_deref(), Some(space.copy.as_str()), "{request:?}");
        let own = request.identity.clone().expect("the copy answers with an identity");
        assert_ne!(own, K_SPACE_ID, "the copy took the original's identity");

        let Ok(listed) = open_request_vault(&request, false, space.state.clone()) else {
            panic!("the copy opens as a space of its own");
        };
        assert_ne!(listed.derived_root(), space.vaults.join(K_SPACE_ID));
        let collections = list_channels_response(&listed);
        assert!(
            !collection_names(&collections).contains(&"Art".to_string()),
            "the copy lists the original's collections: {collections}"
        );

        let Ok(vault) = open_request_vault(&request, true, space.state.clone()) else {
            panic!("the copy opens for a save");
        };
        let mut save = sc2_link_request("copy-save");
        save["binding_id"] = serde_json::json!(own);
        let response = sc0_save_response(&vault, save);
        assert_eq!(response["outcome"], "committed", "{response}");
        assert!(vault.block_path("Local link").starts_with(&space.copy));
        assert_eq!(space.original_rows(), rows_before, "the copy wrote into the original's index");
        assert_eq!(
            mine_lib::space_registry::read_space_id(Path::new(&space.original)).as_deref(),
            Some(K_SPACE_ID)
        );
        assert_eq!(
            mine_lib::space_registry::read_space_id(Path::new(&space.copy)).as_deref(),
            Some(own.as_str())
        );
    }

    /// Д2.1: whatever the helper is asked, a folder whose identity, or the
    /// identity of the space it may copy, cannot be read now is refused with a
    /// state saying so; nothing is written to the folder or to any index.
    fn assert_refused_without_writes(space: &CopiedSpace, state: &str) {
        let rows_before = space.original_rows();
        let copy_files = files_under(Path::new(&space.copy));
        let stores = files_under(&space.vaults);

        for binding in [None, Some(K_SPACE_ID)] {
            let request = resolve_request_space_in(
                &space.cfg,
                Some(&space.vaults),
                Some(space.copy.clone()),
                binding,
            );
            assert_eq!(request.state, state, "{binding:?}: {request:?}");
            assert!(request.path.is_none(), "{binding:?}: {request:?}");
            assert!(request.message().is_some());
        }
        // A request resolved before the identity went unreadable.
        let resolved_earlier = RequestSpace {
            path: Some(space.copy.clone()),
            state: "ready",
            moved_from: None,
            accepted_legacy: None,
            binding_accepted: true,
            identity: Some(K_SPACE_ID.into()),
        };
        for writes in [false, true] {
            match open_request_vault(&resolved_earlier, writes, space.state.clone()) {
                Err(SpaceRefusal::Space(refused)) => assert_eq!(refused.state, state),
                Err(SpaceRefusal::Failed(error)) => panic!("untyped refusal: {error}"),
                Ok(vault) => panic!("opened {}", vault.derived_root().display()),
            }
        }
        assert_eq!(files_under(Path::new(&space.copy)), copy_files, "the copy was written");
        assert_eq!(files_under(&space.vaults), stores, "a derived store was written");
        assert_eq!(space.original_rows(), rows_before);
    }

    #[test]
    fn a_copy_whose_identity_is_in_icloud_is_refused_until_it_arrives() {
        let space = CopiedSpace::new(true);
        CopiedSpace::evict_identity(&space.copy);
        assert_refused_without_writes(&space, "identity_in_cloud");
    }

    #[test]
    fn a_copy_of_a_space_whose_identity_is_in_icloud_is_refused_until_it_arrives() {
        let space = CopiedSpace::new(true);
        CopiedSpace::evict_identity(&space.original);
        assert_refused_without_writes(&space, "identity_in_cloud");
    }

    #[test]
    fn an_unreadable_identity_is_refused_and_never_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let space = CopiedSpace::new(false);
        let id = Path::new(&space.copy).join(".mine/vault-id");
        std::fs::set_permissions(&id, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(std::fs::read(&id).is_err(), "the identity must be unreadable for this test");

        assert_refused_without_writes(&space, "identity_unreadable");

        std::fs::set_permissions(&id, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(std::fs::read_to_string(&id).unwrap(), K_SPACE_ID);
    }

    /// Д2.3 through the clipper's folder choice: the space X was listed at P,
    /// and P now holds the space Y. Choosing P lists Y there, available; X's
    /// record follows X to the folder beside P it was renamed to.
    #[test]
    fn choosing_a_listed_path_that_now_holds_another_space_lists_that_space() {
        const OTHER_ID: &str = "fedcba9876543210fedcba9876543210";
        let tmp = TempDir::new().unwrap();
        let app = tmp.path().join("app");
        let spaces = tmp.path().join("Spaces");
        let p = k_space(&spaces, "Mine");
        let settings = mine_lib::app_config::AppConfig::in_dir(&app);
        settings
            .update(|cfg| mine_lib::space_registry::record_open(cfg, K_SPACE_ID, &p, 1))
            .unwrap();
        let renamed = Path::new(&p).with_file_name("Mine old").to_string_lossy().into_owned();
        std::fs::rename(&p, &renamed).unwrap();
        std::fs::create_dir_all(Path::new(&p).join(".mine")).unwrap();
        std::fs::write(Path::new(&p).join(".mine/vault-id"), OTHER_ID).unwrap();

        let listed = add_known_vault_in(&app, &p).unwrap();

        assert_eq!(listed, vec![renamed.clone(), p.clone()]);
        let cfg = settings.read().unwrap();
        let records = mine_lib::space_registry::records(&cfg);
        assert_eq!(records.len(), 2, "{records:?}");
        assert_eq!(records[0].vault_id.as_deref(), Some(K_SPACE_ID));
        assert_eq!(records[0].path, renamed);
        assert_eq!(records[1].vault_id.as_deref(), Some(OTHER_ID));
        assert_eq!(records[1].path, p);
        assert!(mine_lib::space_registry::statuses(&cfg).iter().all(|status| status.available));
        assert_eq!(load_known_vaults_in(&cfg, None), vec![renamed, p]);
    }

    /// Every file under `root` with its bytes; `None` for a file that cannot
    /// be read. The index database's `-wal` and `-shm` files are left out:
    /// reading an index may create them, and its rows are compared instead.
    fn files_under(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
        let mut found = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(folder) = pending.pop() {
            for entry in std::fs::read_dir(&folder).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    pending.push(path);
                } else if !name.ends_with("-wal") && !name.ends_with("-shm") {
                    found.push((path.clone(), std::fs::read(&path).ok()));
                }
            }
        }
        found.sort();
        found
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

    /// SPEC_CLIPPER.md, 3d, В5; SPEC_ONBOARDING.md, О8.1: a first start of a
    /// fresh copy is slow once, so a check past its deadline is asked again.
    #[test]
    fn a_self_check_past_its_deadline_is_not_remembered() {
        assert!(settles(&VideoToolState::Ready { version: "2026.08.19".into() }));
        for reason in ["missing", "blocked", "failed"] {
            assert!(settles(&VideoToolState::Unavailable { reason, error: String::new() }), "{reason}");
        }
        assert!(!settles(&VideoToolState::Unavailable { reason: "timeout", error: String::new() }));
    }

    #[test]
    fn serialize_response_message_id_echo() {
        // CRIT-7: the host must echo _messageId so background.js can match each
        // response to its originating request instead of falling back to FIFO
        // order. Before this fix the host never echoed the id and this would
        // fail. The id is the thread's own, so the test is self-contained.
        set_current_message_id(42);
        let with_id = serialize_response(&ErrorResponse {
            ok: false,
            error: "boom".to_string(),
        });
        assert!(with_id.contains("\"_messageId\":42"), "got: {with_id}");
        assert!(with_id.contains("\"error\":\"boom\""));

        set_current_message_id(NO_MESSAGE_ID);
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
    fn scan_passes_over_image_examples_in_code() {
        // Б4.4: an embed written inside code is an example of the syntax,
        // not media of the page.
        let tmp = TempDir::new().unwrap();
        for body in [
            "```markdown\n![example](https://h.com/fenced.jpg)\n```",
            "~~~\n![example](https://h.com/tilde.jpg)\n~~~",
            "  ```\n![example](https://h.com/indented-fence.jpg)\n   ```",
            "````\n```\n![example](https://h.com/nested.jpg)\n```\n````",
            "```\n![example](https://h.com/unclosed-fence.jpg)\n\nstill code",
            "Write `![example](https://h.com/inline.jpg)` to embed.",
            "Write ``![a](https://h.com/double.jpg) with ` inside`` here.",
            "A span over\n`two ![example](https://h.com/two-lines.jpg)\nlines` ends.",
            "![a `b](https://h.com/span-wins.jpg)` is text.",
            "Text\n\n    ![example](https://h.com/indented.jpg)\n",
            "Text\n\n\t![example](https://h.com/tab-indented.jpg)",
            "> ```\n> ![example](https://h.com/quoted-fence.jpg)\n> ```",
            "> Quote\n>\n>     ![example](https://h.com/quoted-indented.jpg)",
            "- item\n\n  ```\n  ![example](https://h.com/list-fence.jpg)\n  ```",
            "- ```\n  ![example](https://h.com/list-fence-first.jpg)\n  ```",
            "- item\n\n      ![example](https://h.com/list-indented.jpg)",
            "1. item\n\n       ![example](https://h.com/ordered-indented.jpg)",
            "> - item\n>\n>   ~~~\n>   ![example](https://h.com/quoted-list-fence.jpg)\n>   ~~~",
        ] {
            let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
            assert!(tasks.is_empty(), "{body:?} -> {:?}", tasks.iter().map(|t| &t.url).collect::<Vec<_>>());
        }
    }

    #[test]
    fn scan_still_finds_images_next_to_code_and_unmatched_backticks() {
        let tmp = TempDir::new().unwrap();
        let body = "Costs 5` today\n\n![one](https://h.com/1.jpg)\n\nand ` again\n\n\
                    \\`![two](https://h.com/2.jpg)\\`\n\n\
                    ```js\nconst a = 1;\n```\n![three](https://h.com/3.jpg)\n\n\
                    ```not`a fence ![four](https://h.com/4.jpg)\n\n\
                    ![alt with `code` in it](https://h.com/5.jpg)";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        assert_eq!(
            tasks.iter().map(|task| task.url.as_str()).collect::<Vec<_>>(),
            [
                "https://h.com/1.jpg",
                "https://h.com/2.jpg",
                "https://h.com/3.jpg",
                "https://h.com/4.jpg",
                "https://h.com/5.jpg"
            ]
        );
        assert_eq!(tasks[4].alt, "alt with `code` in it");
    }

    #[test]
    fn scan_finds_images_in_quotes_lists_and_lines_continuing_a_paragraph() {
        // Indentation that continues a paragraph is text, not a code block;
        // quote and list prefixes do not hide a real embed.
        let tmp = TempDir::new().unwrap();
        let body = "Text\n    ![lazy](https://h.com/lazy.jpg)\n\n\
                    > ![quoted](https://h.com/quoted.jpg)\n\n\
                    - ![listed](https://h.com/listed.jpg)\n\n\
                    > - ![quoted item](https://h.com/quoted-item.jpg)";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        assert_eq!(
            tasks.iter().map(|task| task.url.as_str()).collect::<Vec<_>>(),
            [
                "https://h.com/lazy.jpg",
                "https://h.com/quoted.jpg",
                "https://h.com/listed.jpg",
                "https://h.com/quoted-item.jpg"
            ]
        );
    }

    #[test]
    fn localizing_keeps_code_examples_byte_identical() {
        // Б4.4 end to end over scan and rewrite: every scanned embed is
        // downloaded, yet only the real images become local wikilinks.
        let tmp = TempDir::new().unwrap();
        let vault = vault_at(tmp.path());
        let body = "Intro ![real](https://h.com/real.jpg)\n\n\
                    ```markdown\n![example](https://h.com/fenced.jpg)\n```\n\n\
                    ~~~\n![example](https://h.com/tilde.jpg)\n~~~\n\n\
                    Inline `![example](https://h.com/inline.jpg)` stays.\n\n\
                    > ![quoted](https://h.com/quoted.jpg)\n\n\
                    > ```\n> ![example](https://h.com/quoted-fence.jpg)\n> ```\n\n\
                    - item\n\n      ![example](https://h.com/list-indented.jpg)\n\n\
                    Text\n\n    ![example](https://h.com/indented.jpg)\n";
        let tasks = scan_inline_tasks(body, &vault, "S");
        for task in &tasks {
            std::fs::write(&task.dest_path, task.url.as_bytes()).unwrap();
        }
        let outcomes = vec![Ok(()); tasks.len()];
        let (rewritten, surviving) = apply_rewrites(body, &tasks, &outcomes);
        assert_eq!(
            rewritten,
            body.replacen("![real](https://h.com/real.jpg)", "![[S (image 1).jpg|real]]", 1)
                .replacen("![quoted](https://h.com/quoted.jpg)", "![[S (image 2).jpg|quoted]]", 1)
        );
        assert_eq!(
            surviving,
            vec![tmp.path().join("S (image 1).jpg"), tmp.path().join("S (image 2).jpg")]
        );
    }

    /// The body a save writes when every scanned embed downloads, and the
    /// URLs it fetched. Each file gets its own bytes, so none is deduplicated.
    fn saved_body(body: &str) -> (String, Vec<String>) {
        let tmp = TempDir::new().unwrap();
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        for task in &tasks {
            std::fs::write(&task.dest_path, task.url.as_bytes()).unwrap();
        }
        let outcomes = vec![Ok(()); tasks.len()];
        let fetched = tasks.iter().map(|task| task.url.clone()).collect();
        (apply_rewrites(body, &tasks, &outcomes).0, fetched)
    }

    #[test]
    fn escaped_image_syntax_stays_text() {
        // В4.1: `\![` is a literal `!` before a link, not an embed.
        let body = "Write \\![not an image](https://h.com/x.jpg) literally.\n\n\
                    \\\\![real](https://h.com/r.jpg)";
        let (saved, fetched) = saved_body(body);
        assert_eq!(fetched, ["https://h.com/r.jpg"]);
        let real = "![real](https://h.com/r.jpg)";
        assert_eq!(saved, body.replacen(real, "![[S (image 1).jpg|real]]", 1));
    }

    #[test]
    fn unclosed_image_leaves_paragraphs_and_code_byte_identical() {
        // В4.1: an unclosed `![` does not borrow the brackets of a real image
        // further down; only that image changes.
        let body = "Look ![ at this\n\nA paragraph that follows.\n\n\
                    ```\nlet a = [1](2);\n```\n\n\
                    ![real](https://h.com/real.jpg)\n\nEnd.";
        let (saved, fetched) = saved_body(body);
        assert_eq!(fetched, ["https://h.com/real.jpg"]);
        let real = "![real](https://h.com/real.jpg)";
        assert_eq!(saved, body.replacen(real, "![[S (image 1).jpg|real]]", 1));
    }

    #[test]
    fn unclosed_image_before_a_link_downloads_nothing() {
        // В4.1: the target of an ordinary link is not media.
        let body = "![ unclosed [t](https://example.com/a.png) text";
        let (saved, fetched) = saved_body(body);
        assert!(fetched.is_empty(), "{fetched:?}");
        assert_eq!(saved, body);
    }

    #[test]
    fn images_in_quotes_lists_tables_and_footnotes_are_localized_in_place() {
        // A caption wrapped inside a quote keeps its words, not the `>` of
        // the next line.
        let body = "> Quote ![quoted\n> caption](https://h.com/q.jpg) end\n\n\
                    - item ![listed](https://h.com/l.jpg)\n- next\n\n\
                    | h |\n|---|\n| ![cell](https://h.com/c.jpg) |\n\n\
                    Text[^1]\n\n[^1]: ![note](https://h.com/n.jpg)\n";
        let (saved, fetched) = saved_body(body);
        assert_eq!(
            fetched,
            [
                "https://h.com/q.jpg",
                "https://h.com/l.jpg",
                "https://h.com/c.jpg",
                "https://h.com/n.jpg"
            ]
        );
        assert_eq!(
            saved,
            "> Quote ![[S (image 1).jpg|quoted caption]] end\n\n\
             - item ![[S (image 2).jpg|listed]]\n- next\n\n\
             | h |\n|---|\n| ![[S (image 3).jpg|cell]] |\n\n\
             Text[^1]\n\n[^1]: ![[S (image 4).jpg|note]]\n"
        );
    }

    #[test]
    fn titled_and_reference_images_stay_as_written() {
        // `![[name|alt]]` holds a file and a caption. A title would be lost,
        // and a file named only by a reference definition is not seen as used
        // by Mine, so both keep their remote form byte for byte.
        let body = "![t](https://h.com/t.jpg \"Hover text\")\n\n\
                    ![r][ref] and ![ref][] and ![ref]\n\n\
                    [ref]: https://h.com/r.jpg\n\n\
                    ![plain](https://h.com/p.jpg)";
        let (saved, fetched) = saved_body(body);
        assert_eq!(fetched, ["https://h.com/p.jpg"]);
        let plain = "![plain](https://h.com/p.jpg)";
        assert_eq!(saved, body.replacen(plain, "![[S (image 1).jpg|plain]]", 1));
    }

    #[test]
    fn an_image_the_wikilink_cannot_replace_keeps_the_remote_form() {
        // `]]` inside the caption, or `]` at its end, would close the
        // wikilink early and spill the rest into the text. A wikilink in the
        // label is read first, so that label is text and not an image. An
        // image inside a wikilink would put a wikilink into a wikilink.
        for body in [
            "![Figure [1]](https://h.com/f.jpg)",
            "![a `]]` b](https://h.com/c.jpg)",
            "![a [[b]] c](https://h.com/g.jpg)",
            "[[Note|![a](https://h.com/w.jpg)]]",
        ] {
            let (saved, fetched) = saved_body(body);
            assert!(fetched.is_empty(), "{body:?} -> {fetched:?}");
            assert_eq!(saved, body);
        }
    }

    #[test]
    fn only_the_shown_image_of_a_nested_embed_is_localized() {
        // An image inside a link is shown; an image inside another image's
        // caption is only caption text.
        let body = "[![linked](https://h.com/l.jpg)](https://page.example)\n\n\
                    ![outer ![inner](https://h.com/i.jpg) text](https://h.com/o.jpg)";
        let (saved, fetched) = saved_body(body);
        assert_eq!(fetched, ["https://h.com/l.jpg", "https://h.com/o.jpg"]);
        assert_eq!(
            saved,
            "[![[S (image 1).jpg|linked]]](https://page.example)\n\n\
             ![[S (image 2).jpg|outer ![inner](https://h.com/i.jpg) text]]"
        );
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
    fn apply_rewrites_reuses_one_file_for_an_authors_repeat() {
        // Ф5: the author shows one picture twice, each with its own caption.
        // Both places stay in the text; the identical file is stored once.
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("S (image 1).jpg"), b"PIXELS").unwrap();
        std::fs::write(tmp.path().join("S (image 2).jpg"), b"PIXELS").unwrap();
        let body = "intro\n![first](https://h.com/1.jpg)\nfirst\n\n\
                    ![second](https://h.com/2.jpg)\nsecond\n\nend";
        let tasks = scan_inline_tasks(body, &vault_at(tmp.path()), "S");
        assert_eq!(tasks.len(), 2);
        let outcomes = vec![Ok(()), Ok(())];
        let (rewritten, surviving) = apply_rewrites(body, &tasks, &outcomes);
        assert_eq!(
            rewritten,
            "intro\n![[S (image 1).jpg|first]]\nfirst\n\n![[S (image 1).jpg|second]]\nsecond\n\nend"
        );
        assert!(!tmp.path().join("S (image 2).jpg").exists());
        assert!(tmp.path().join("S (image 1).jpg").exists());
        assert_eq!(surviving, vec![tmp.path().join("S (image 1).jpg")]);
    }

    #[test]
    fn apply_rewrites_zero_tasks_returns_body_unchanged() {
        let tmp = TempDir::new().unwrap();
        let body = "no images here";
        assert_eq!(apply_rewrites(body, &[], &[]).0, body);
        assert_eq!(
            localize_body_images(body, &vault_at(tmp.path()), "S", "", &vault_at(tmp.path())).0,
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
