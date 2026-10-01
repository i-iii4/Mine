//! The list of spaces, keyed by identity rather than by path
//! (SPEC_VAULT_LIFECYCLE.md, П25 to П27).
//!
//! A space is its `.mine/vault-id`; the path is only where it was last seen.
//! Records live in the app settings under [`SPACES_KEY`] and change only
//! through [`crate::app_config::AppConfig::update`], one record at a time, so
//! trouble with one space never touches another (П25).
//!
//! Readers older than the registry know only a list of paths and the current
//! path. The registry keeps those two keys (`known_vaults`, `vault_path`) as a
//! projection of itself; nothing reads them back as the source of truth.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SPACES_KEY: &str = "spaces";
/// Identities the person chose to forget: recovery never brings them back.
pub const FORGOTTEN_KEY: &str = "forgotten_spaces";
const KNOWN_VAULTS_KEY: &str = "known_vaults";
const VAULT_PATH_KEY: &str = "vault_path";

/// One space the app has opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceRecord {
    /// `None` only for a record carried over from the path list, until the
    /// folder is seen again.
    #[serde(default)]
    pub vault_id: Option<String>,
    pub path: String,
    #[serde(default)]
    pub last_opened_ms: Option<u64>,
}

/// A record and what stands at its path right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceStatus {
    pub record: SpaceRecord,
    pub available: bool,
}

const ID_FILES: [&str; 2] = [".mine/vault-id", ".arena/vault-id"];

/// The space identity stored in a folder, if it can be read. Reading an
/// identity file whose contents iCloud has moved off this Mac waits for the
/// download: only for work that must know the identity and may wait.
pub fn read_space_id(folder: &Path) -> Option<String> {
    ID_FILES.iter().find_map(|name| read_id_file(&folder.join(name)))
}

/// What a folder says about its identity, without waiting for iCloud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpaceIdentity {
    Known(String),
    /// The identity file is there, but its contents are only in iCloud.
    InCloud,
    Absent,
}

/// Read the identity only when its contents are on this Mac. A listing of
/// spaces must never wait for iCloud: a disk short on space leaves even this
/// 32-byte file in the cloud, and reading it would stall the caller.
pub fn space_identity(folder: &Path) -> SpaceIdentity {
    for name in ID_FILES {
        let path = folder.join(name);
        if !path.is_file() {
            continue;
        }
        if crate::storage::media_dimensions::is_content_offloaded(&path) {
            return SpaceIdentity::InCloud;
        }
        if let Some(id) = read_id_file(&path) {
            return SpaceIdentity::Known(id);
        }
    }
    SpaceIdentity::Absent
}

fn read_id_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let id = text.trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// How an identity file whose contents iCloud moved off this Mac is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudRead {
    /// Wait for the download: the app opening a space may wait for it.
    Wait,
    /// Never wait: the clipper's helper answers at once, saying the identity
    /// is in iCloud.
    NoWait,
}

/// Why the identity a folder carries cannot be known now. Never taken for a
/// folder without an identity: an identity nobody can read is never replaced
/// by a new one, nor guessed (`SPEC_AUDIT_FIXES.md`, Д2.1).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdentityUnreadable {
    /// The identity file is there, its contents only in iCloud.
    #[error("the space identity {} is still in iCloud", .path.display())]
    InCloud { path: PathBuf },
    /// The identity file is there but cannot be read.
    #[error("cannot read the space identity {}: {reason}", .path.display())]
    Unreadable { path: PathBuf, reason: String },
}

/// The identity `folder` carries: `None` only when it has no identity file
/// (or an empty one). The current `.mine` file decides before the legacy
/// `.arena` one.
///
/// # Errors
///
/// [`IdentityUnreadable`] when an identity file is there but its contents
/// are only in iCloud (with [`CloudRead::NoWait`]) or cannot be read.
pub fn read_identity(folder: &Path, read: CloudRead) -> Result<Option<String>, IdentityUnreadable> {
    for name in ID_FILES {
        if let Some(id) = read_identity_file(&folder.join(name), read)? {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// The identity one identity file holds: `None` only when the file is not
/// there or is empty.
///
/// # Errors
///
/// [`IdentityUnreadable`] when the file is there but its contents are only
/// in iCloud (with [`CloudRead::NoWait`]) or cannot be read.
pub fn read_identity_file(path: &Path, read: CloudRead) -> Result<Option<String>, IdentityUnreadable> {
    let unreadable = |error: std::io::Error| IdentityUnreadable::Unreadable {
        path: path.to_path_buf(),
        reason: error.to_string(),
    };
    match std::fs::metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unreadable(error)),
    }
    if read == CloudRead::NoWait && crate::storage::media_dimensions::is_content_offloaded(path) {
        return Err(IdentityUnreadable::InCloud { path: path.to_path_buf() });
    }
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let id = text.trim();
            Ok((!id.is_empty()).then(|| id.to_string()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(unreadable(error)),
    }
}

/// What a folder carrying `vault_id` is to the derived store of that
/// identity (П22): the space itself, the space moved, or a copy of it. One
/// rule for the app and the clipper's helper, so both choose one store for
/// one folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityClaim {
    /// The store last served this very folder, or has not served any yet.
    Owned,
    /// The space is no longer where the store last served it (no folder
    /// there, or one that is not this space): a move, not a copy.
    Adopted,
    /// The same space is alive where the store last served it: this folder
    /// is a copy and needs an identity and a store of its own.
    Copy { owner: PathBuf },
    /// A folder stands where the store last served the space, and its
    /// identity cannot be read now: copy or move cannot be told.
    Undecided {
        owner: PathBuf,
        cause: IdentityUnreadable,
    },
}

/// The file in a derived store naming the folder it last served (П22, П27).
#[must_use]
pub fn owner_path_file(derived_root: &Path) -> PathBuf {
    derived_root.join(OWNER_PATH_FILE)
}

const OWNER_PATH_FILE: &str = "owner-path.json";

/// Whether the folder `root`, which carries `vault_id`, is the space the
/// derived store `derived_root` serves, the same space moved, or a copy of it
/// (П22). Only the same space alive at the recorded path makes `root` a copy
/// (П26): a folder there without this identity (an empty one made after a
/// rename, another space) is not the original, and taking it for one would
/// give the moved space a new identity and orphan its store (Б2.1).
#[must_use]
pub fn identity_claim(root: &Path, derived_root: &Path, vault_id: &str, read: CloudRead) -> IdentityClaim {
    let Some((owner, _)) = owner_path(derived_root) else {
        return IdentityClaim::Owned;
    };
    let owner = PathBuf::from(owner);
    // Canonical comparison: symlinks and case quirks must not make a folder
    // look like a copy of itself.
    let same = match (owner.canonicalize(), root.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => owner == root,
    };
    if same {
        return IdentityClaim::Owned;
    }
    if !owner.is_dir() {
        return IdentityClaim::Adopted;
    }
    match read_identity(&owner, read) {
        Ok(Some(found)) if found == vault_id => IdentityClaim::Copy { owner },
        Ok(_) => IdentityClaim::Adopted,
        Err(cause) => IdentityClaim::Undecided { owner, cause },
    }
}

/// Record that the derived store `derived_root` now serves the folder `root`
/// (П22, П27). Best effort: failing to record the owner must not fail an
/// open, and the next open records it again.
pub fn record_owner_path(derived_root: &Path, root: &Path) {
    let payload = serde_json::json!({ "path": root.to_string_lossy() });
    if std::fs::create_dir_all(derived_root).is_ok() {
        if let Err(error) = crate::storage::files::write_atomically(
            &owner_path_file(derived_root),
            payload.to_string().as_bytes(),
        ) {
            log::warn!(
                "cannot record {} as the folder of {}: {error:#}",
                root.display(),
                derived_root.display()
            );
        }
    }
}

/// The identity when it can be known without waiting.
fn known_space_id(folder: &Path) -> Option<String> {
    match space_identity(folder) {
        SpaceIdentity::Known(id) => Some(id),
        SpaceIdentity::InCloud | SpaceIdentity::Absent => None,
    }
}

/// Whether `path` holds the space `record` stands for. An identity file
/// still in iCloud cannot disprove it: the folder is where the space was.
/// A record without an identity stands for the folder at its path.
pub fn is_available(record: &SpaceRecord) -> bool {
    is_available_in(record, None)
}

/// Whether `path` holds the space `record` stands for, with the derived
/// stores in `vaults_dir` to say which space a record without an identity
/// stands for: the one a store last saw at its path (П27). The folder there
/// must carry that identity, so an empty folder left where a space used to
/// be is not that space (`SPEC_AUDIT_FIXES.md`, В2.2). A record no store has
/// seen a space at is a folder listed but never opened on this Mac, and
/// stands for that folder.
#[must_use]
pub fn is_available_in(record: &SpaceRecord, vaults_dir: Option<&Path>) -> bool {
    let folder = Path::new(&record.path);
    if !folder.is_dir() {
        return false;
    }
    let identity = record
        .vault_id
        .clone()
        .or_else(|| last_seen_at(vaults_dir, &record.path));
    identity.is_none_or(|id| holds_identity(folder, &id))
}

/// Whether `folder` carries the identity `id`. An identity only in iCloud
/// cannot say otherwise.
fn holds_identity(folder: &Path, id: &str) -> bool {
    match space_identity(folder) {
        SpaceIdentity::Known(found) => found == id,
        SpaceIdentity::InCloud => true,
        SpaceIdentity::Absent => false,
    }
}

/// The space a derived store in `vaults_dir` last saw at `path`.
fn last_seen_at(vaults_dir: Option<&Path>, path: &str) -> Option<String> {
    vaults_dir.and_then(|dir| derived_owners(dir, path).into_iter().next())
}

/// The records, in the person's order. Settings from before the registry
/// yield path-only records: whatever folder stands at a listed path now is
/// no record of which space was there, so it lends the record no identity
/// (`SPEC_AUDIT_FIXES.md`, Ф8, Б2.2). [`locate_saved`] finds such a space from
/// its derived store instead.
pub fn records(cfg: &Map<String, Value>) -> Vec<SpaceRecord> {
    if let Some(value) = cfg.get(SPACES_KEY) {
        if let Ok(records) = serde_json::from_value::<Vec<SpaceRecord>>(value.clone()) {
            return records;
        }
    }
    let path_only = |path: &str| SpaceRecord {
        vault_id: None,
        path: path.to_string(),
        last_opened_ms: None,
    };
    let mut records: Vec<SpaceRecord> = cfg
        .get(KNOWN_VAULTS_KEY)
        .and_then(Value::as_array)
        .map(|paths| paths.iter().filter_map(Value::as_str).map(path_only).collect())
        .unwrap_or_default();
    if let Some(current) = current_path(cfg) {
        if !records.iter().any(|record| same_path(&record.path, &current)) {
            records.push(path_only(&current));
        }
    }
    records
}

/// Every record with its availability.
pub fn statuses(cfg: &Map<String, Value>) -> Vec<SpaceStatus> {
    statuses_in(cfg, None)
}

/// Every record with its availability, a record without an identity judged
/// by the space the derived stores in `vaults_dir` last saw at its path
/// ([`is_available_in`]).
#[must_use]
pub fn statuses_in(cfg: &Map<String, Value>, vaults_dir: Option<&Path>) -> Vec<SpaceStatus> {
    records(cfg)
        .into_iter()
        .map(|record| SpaceStatus {
            available: is_available_in(&record, vaults_dir),
            record,
        })
        .collect()
}

/// The space the app last had open.
pub fn current_path(cfg: &Map<String, Value>) -> Option<String> {
    cfg.get(VAULT_PATH_KEY)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The app opened `vault_id` at `path`: its record follows it there (П16,
/// П26). The same identity at another path means the space moved; the copy
/// rule (П22) has already given a live copy its own identity by now.
pub fn record_open(cfg: &mut Map<String, Value>, vault_id: &str, path: &str, now_ms: u64) {
    place_record(cfg, vault_id, None, path, now_ms);
    cfg.insert(VAULT_PATH_KEY.into(), Value::from(path));
}

/// The space `vault_id`, last recorded at `from`, was found at `to` (П30)
/// and is about to open there. The record that stood for it follows it,
/// including a record written before records carried identities, which only
/// its old path names: it gains the identity found at `to` instead of
/// staying behind beside a new record (`SPEC_AUDIT_FIXES.md`, В2.2). The
/// current binding follows the space only when it pointed at `from`; a
/// newer choice of another space stays current.
pub fn record_moved(cfg: &mut Map<String, Value>, vault_id: &str, from: &str, to: &str, now_ms: u64) {
    let followed = current_path(cfg).is_some_and(|current| same_path(&current, from));
    place_record(cfg, vault_id, Some(from), to, now_ms);
    if followed {
        cfg.insert(VAULT_PATH_KEY.into(), Value::from(to));
    }
}

/// Put `vault_id` at `path` in the list: its own record, else the record
/// without an identity at `from` (the path it was last seen at), else the
/// one without an identity at `path`, else a new record. A path, and the
/// old path of a move, then stand for this space only.
fn place_record(
    cfg: &mut Map<String, Value>,
    vault_id: &str,
    from: Option<&str>,
    path: &str,
    now_ms: u64,
) {
    let mut records = records(cfg);
    let unidentified_at = |records: &[SpaceRecord], at: &str| {
        records
            .iter()
            .position(|record| record.vault_id.is_none() && same_path(&record.path, at))
    };
    let position = records
        .iter()
        .position(|record| record.vault_id.as_deref() == Some(vault_id))
        .or_else(|| from.and_then(|from| unidentified_at(&records, from)))
        .or_else(|| unidentified_at(&records, path));
    let record = SpaceRecord {
        vault_id: Some(vault_id.to_string()),
        path: path.to_string(),
        last_opened_ms: Some(now_ms),
    };
    let kept = if let Some(index) = position {
        records[index] = record;
        index
    } else {
        records.push(record);
        records.len() - 1
    };
    let mut index = 0;
    records.retain(|entry| {
        let this = index;
        index += 1;
        if this == kept {
            return true;
        }
        // A path now belongs to one space only, the space to one record,
        // and a record without an identity at the old path stood for this
        // very space.
        let same_space = entry.vault_id.as_deref() == Some(vault_id);
        let left_behind =
            entry.vault_id.is_none() && from.is_some_and(|from| same_path(&entry.path, from));
        !(same_space || left_behind || same_path(&entry.path, path))
    });
    unforget(cfg, vault_id);
    write_records(cfg, &records);
}

/// A folder the app opened without an identity file (should not happen: the
/// app writes one on open) still gets a record, by path only.
pub fn record_path_only(cfg: &mut Map<String, Value>, path: &str) {
    let mut records = records(cfg);
    if !records.iter().any(|record| same_path(&record.path, path)) {
        records.push(SpaceRecord {
            vault_id: None,
            path: path.to_string(),
            last_opened_ms: None,
        });
    }
    write_records(cfg, &records);
    cfg.insert(VAULT_PATH_KEY.into(), Value::from(path));
}

/// The record listed at `path`, if any.
pub fn record_at(cfg: &Map<String, Value>, path: &str) -> Option<SpaceRecord> {
    records(cfg)
        .into_iter()
        .find(|record| same_path(&record.path, path))
}

/// A space gone from its recorded path, found beside it under a new name
/// (П30): the only folder next to the old path that carries the same
/// identity, while the old path holds no such space. Several candidates mean
/// copies, and a guess could open the wrong one: then nothing is returned.
pub fn find_moved(record: &SpaceRecord) -> Option<String> {
    let id = record.vault_id.as_deref()?;
    if is_available(record) {
        return None;
    }
    let old = Path::new(&record.path);
    let parent = old.parent()?;
    let mut found = None;
    for entry in std::fs::read_dir(parent).ok()?.flatten() {
        let path = entry.path();
        if path == old || !path.is_dir() {
            continue;
        }
        if known_space_id(&path).as_deref() == Some(id) {
            if found.is_some() {
                return None;
            }
            found = Some(path.to_string_lossy().into_owned());
        }
    }
    found
}

/// Where a space chosen earlier stands now (SPEC_CLIPPER.md, К1, К3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    /// The space is at the path that was asked about.
    Here { path: String },
    /// The space was renamed or moved; it is now at `path`.
    Moved { from: String, path: String },
    /// Nothing that is this space can be found. `reason` tells what stands
    /// at the last known path.
    Lost { path: String, reason: LostReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LostReason {
    /// No folder there: renamed, moved, deleted or on a disconnected drive.
    Missing,
    /// The folder is there but cannot be read.
    AccessDenied,
    /// The folder there is another space.
    Replaced,
}

/// Find the space `vault_id` names, starting at the path it was last seen at
/// (`hint`). The identity decides; the path is only where to look first.
/// Without an identity (a choice made before К1) the hint is taken as it is,
/// and a missing hint is looked up in the list by path.
pub fn locate(cfg: &Map<String, Value>, vault_id: Option<&str>, hint: &str) -> Located {
    let here = Path::new(hint);
    let hint_readable = std::fs::read_dir(here).is_ok();
    if hint_readable {
        match vault_id {
            None => return Located::Here { path: hint.to_string() },
            Some(id) => match space_identity(here) {
                SpaceIdentity::Known(found) if found == id => {
                    return Located::Here { path: hint.to_string() }
                }
                // The folder is where the space was; its identity is only
                // in iCloud and cannot say otherwise.
                SpaceIdentity::InCloud => return Located::Here { path: hint.to_string() },
                SpaceIdentity::Known(_) | SpaceIdentity::Absent => {}
            },
        }
    }
    let id = vault_id
        .map(str::to_string)
        .or_else(|| record_at(cfg, hint).and_then(|record| record.vault_id));
    if let Some(id) = id {
        let listed = records(cfg)
            .into_iter()
            .find(|record| record.vault_id.as_deref() == Some(id.as_str()));
        if let Some(record) = &listed {
            if !same_path(&record.path, hint) && is_available(record) {
                return Located::Moved { from: hint.to_string(), path: record.path.clone() };
            }
        }
        // Look beside the path asked about, then beside the listed one.
        let beside_hint = SpaceRecord {
            vault_id: Some(id.clone()),
            path: hint.to_string(),
            last_opened_ms: None,
        };
        let found = find_moved(&beside_hint)
            .or_else(|| listed.as_ref().and_then(find_moved));
        if let Some(path) = found {
            return Located::Moved { from: hint.to_string(), path };
        }
    }
    Located::Lost {
        path: hint.to_string(),
        reason: lost_reason(here, hint_readable),
    }
}

/// What stands at the path of a space that is not there.
fn lost_reason(here: &Path, readable: bool) -> LostReason {
    if readable {
        return LostReason::Replaced;
    }
    match std::fs::metadata(here) {
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            LostReason::AccessDenied
        }
        Ok(metadata) if metadata.is_dir() => LostReason::AccessDenied,
        _ => LostReason::Missing,
    }
}

/// Where the space the app last had open at `hint` stands now, for the app
/// reopening it without the person choosing (`SPEC_AUDIT_FIXES.md`, Ф8).
///
/// A record with an identity is found by it. A record without one (settings
/// from before the registry, or a folder listed before it was ever opened)
/// takes the identity of the space the derived stores in `vaults_dir` last
/// saw at this path, and that space is looked for by identity (П30) rather
/// than taking whatever folder stands at the path now. Only when no store
/// ever saw a space there does the folder's own identity count, and a folder
/// without one is never the saved space: opening it would lay out folders
/// and write an identity nobody chose.
#[must_use]
pub fn locate_saved(cfg: &Map<String, Value>, vaults_dir: Option<&Path>, hint: &str) -> Located {
    if let Some(id) = saved_identity(cfg, vaults_dir, hint) {
        return locate(cfg, Some(&id), hint);
    }
    let here = Path::new(hint);
    let readable = std::fs::read_dir(here).is_ok();
    if readable && space_identity(here) != SpaceIdentity::Absent {
        return Located::Here { path: hint.to_string() };
    }
    Located::Lost {
        path: hint.to_string(),
        reason: lost_reason(here, readable),
    }
}

/// The identity of the space the app knows at `path`: the one its record
/// carries, else the one a derived store in `vaults_dir` last saw there.
#[must_use]
pub fn saved_identity(cfg: &Map<String, Value>, vaults_dir: Option<&Path>, path: &str) -> Option<String> {
    record_at(cfg, path)
        .and_then(|record| record.vault_id)
        .or_else(|| last_seen_at(vaults_dir, path))
}

/// The spaces whose derived stores last saw them at `path`, the one opened
/// there most recently first (П27). Every open records its folder in
/// `vaults/<vault-id>/owner-path.json`.
#[must_use]
pub fn derived_owners(vaults_dir: &Path, path: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(vaults_dir) else {
        return Vec::new();
    };
    let mut owners: Vec<(u64, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_str().map(str::to_string)?;
            if !is_space_id(&id) {
                return None;
            }
            let (owner, seen) = owner_path(&entry.path())?;
            same_path(&owner, path).then_some((seen, id))
        })
        .collect();
    owners.sort_by_key(|(seen, _)| std::cmp::Reverse(*seen));
    owners.into_iter().map(|(_, id)| id).collect()
}

/// The folder a derived store last served and when, in milliseconds since
/// the epoch.
fn owner_path(store: &Path) -> Option<(String, u64)> {
    let file = owner_path_file(store);
    let path = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("path").and_then(Value::as_str).map(str::to_string))?;
    let seen = std::fs::metadata(&file)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default();
    Some((path, seen))
}

/// The person forgot the space at `path`: exactly that record goes, and
/// recovery will not bring it back (П13, П28).
pub fn forget(cfg: &mut Map<String, Value>, path: &str) {
    forget_record(cfg, path, true);
}

/// Forget the record at `path`; `clear_current` also drops the current
/// binding when it points there. The settings list keeps the binding of the
/// space the app is running on.
pub fn forget_record(cfg: &mut Map<String, Value>, path: &str, clear_current: bool) {
    let mut records = records(cfg);
    let mut forgotten_ids = Vec::new();
    records.retain(|record| {
        if same_path(&record.path, path) {
            if let Some(id) = &record.vault_id {
                forgotten_ids.push(id.clone());
            }
            false
        } else {
            true
        }
    });
    if forgotten_ids.is_empty() {
        if let Some(id) = known_space_id(Path::new(path)) {
            forgotten_ids.push(id);
        }
    }
    for id in forgotten_ids {
        remember_forgotten(cfg, &id);
    }
    write_records(cfg, &records);
    if clear_current && current_path(cfg).is_some_and(|current| same_path(&current, path)) {
        cfg.remove(VAULT_PATH_KEY);
    }
}

/// What listing a folder came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddedSpace {
    /// A new record stands for the folder.
    Listed,
    /// A record already stood for the folder.
    AlreadyListed,
    /// The space was listed at `from`, where it is no longer: its record now
    /// names the folder, and no second record is added (П16).
    Moved { from: String },
    /// The same space is alive at `original`: the folder is its copy. It is
    /// listed as a space of its own, with the identity `vault_id` minted for
    /// it (П22, П26). `None` when that identity could not be written: the
    /// copy is listed without one, and the copy rule gives it its own when it
    /// opens.
    Copied {
        original: String,
        vault_id: Option<String>,
    },
}

/// The folder at the path of `records[at]` now carries another identity, so
/// the path is no longer that record's space's (Д2.3). The record follows its
/// space to the folder beside the path it was renamed to (П30), along with
/// the current binding that named the path; a path stands for one space only,
/// so another record at the folder found goes. A space found nowhere leaves
/// the list: the list, Forget and Reorder all go by path, and a second record
/// at the path would show the space now there as unavailable. Its derived
/// store stays, and adding its folder again lists it with its index.
fn follow_displaced(cfg: &mut Map<String, Value>, records: &mut Vec<SpaceRecord>, at: usize) {
    let displaced = records.remove(at);
    let Some(found) = find_moved(&displaced) else {
        log::info!(
            "{} now holds another space; the space listed there was not found beside it",
            displaced.path
        );
        return;
    };
    if current_path(cfg).is_some_and(|current| same_path(&current, &displaced.path)) {
        cfg.insert(VAULT_PATH_KEY.into(), Value::from(found.clone()));
    }
    records.retain(|record| !same_path(&record.path, &found));
    let at = at.min(records.len());
    records.insert(at, SpaceRecord { path: found, ..displaced });
}

/// What stands at the path a record last saw its space at.
enum OldPlace {
    /// No folder, or a folder that is another space or none at all.
    Gone,
    /// The folder there carries the same identity.
    Alive,
    /// The identity there is only in iCloud: it cannot be told now.
    Unknown,
}

fn old_place(path: &str, id: &str) -> OldPlace {
    let folder = Path::new(path);
    if !folder.is_dir() {
        return OldPlace::Gone;
    }
    match space_identity(folder) {
        SpaceIdentity::Known(found) if found == id => OldPlace::Alive,
        SpaceIdentity::Known(_) | SpaceIdentity::Absent => OldPlace::Gone,
        SpaceIdentity::InCloud => OldPlace::Unknown,
    }
}

/// List a space without opening it (the settings window's Add, the
/// clipper's folder choice). A space the person forgot and adds again is no
/// longer forgotten.
///
/// The identity decides, the path is only an address (П26). A listed path
/// whose folder now carries another identity is that other space's: the
/// record that named the path follows its own space (Д2.3). A folder whose
/// identity a record already carries at another path is that space moved
/// there, when nothing at the old path is that space any more: the record
/// follows it, along with the current binding that pointed at the old path
/// (П16). When the space is alive at the old path, the folder is a copy and
/// becomes a space of its own, with its own identity and its own record
/// (П22). An identity that cannot be read now (iCloud) decides nothing: the
/// folder is listed without one, and opening it applies the same rules.
pub fn add_space(cfg: &mut Map<String, Value>, vault_id: Option<&str>, path: &str) -> AddedSpace {
    let mut records = records(cfg);
    if let Some(id) = vault_id {
        unforget(cfg, id);
    }
    let unidentified = |path: &str| SpaceRecord {
        vault_id: None,
        path: path.to_string(),
        last_opened_ms: None,
    };
    if records.iter().any(|record| same_path(&record.path, path)) {
        let Some(id) = vault_id else {
            write_records(cfg, &records);
            return AddedSpace::AlreadyListed;
        };
        let mut displaced = false;
        while let Some(at) = records.iter().position(|record| {
            same_path(&record.path, path) && record.vault_id.as_deref().is_some_and(|listed| listed != id)
        }) {
            follow_displaced(cfg, &mut records, at);
            displaced = true;
        }
        let listed_here = records
            .iter()
            .any(|record| same_path(&record.path, path) && record.vault_id.as_deref() == Some(id));
        if !displaced || listed_here {
            write_records(cfg, &records);
            return AddedSpace::AlreadyListed;
        }
        // A record without an identity at the path stood for the folder
        // there, which is the space added now: it gets that space's record.
        records.retain(|record| !same_path(&record.path, path));
    }
    let Some(id) = vault_id else {
        records.push(unidentified(path));
        write_records(cfg, &records);
        return AddedSpace::Listed;
    };
    let Some(index) = records
        .iter()
        .position(|record| record.vault_id.as_deref() == Some(id))
    else {
        records.push(SpaceRecord {
            vault_id: Some(id.to_string()),
            path: path.to_string(),
            last_opened_ms: None,
        });
        write_records(cfg, &records);
        return AddedSpace::Listed;
    };
    let from = records[index].path.clone();
    let outcome = match old_place(&from, id) {
        OldPlace::Gone => {
            records[index].path = path.to_string();
            if current_path(cfg).is_some_and(|current| same_path(&current, &from)) {
                cfg.insert(VAULT_PATH_KEY.into(), Value::from(path));
            }
            AddedSpace::Moved { from }
        }
        OldPlace::Alive => {
            let minted = match mint_copy_identity(Path::new(path)) {
                Ok(minted) => Some(minted),
                Err(error) => {
                    log::warn!(
                        "the copy at {path} keeps the identity of {from} until it opens: {error}"
                    );
                    None
                }
            };
            records.push(SpaceRecord {
                vault_id: minted.clone(),
                path: path.to_string(),
                last_opened_ms: None,
            });
            AddedSpace::Copied {
                original: from,
                vault_id: minted,
            }
        }
        OldPlace::Unknown => {
            records.push(unidentified(path));
            AddedSpace::Listed
        }
    };
    write_records(cfg, &records);
    outcome
}

/// Why a copy could not be given an identity of its own.
#[derive(Debug, thiserror::Error)]
pub enum MintIdentityError {
    #[error("no randomness for a new identity: {0}")]
    Random(getrandom::Error),
    #[error("cannot write {path}: {source:#}")]
    Write {
        path: PathBuf,
        source: anyhow::Error,
    },
}

/// Give the copy at `folder` an identity of its own (П22): what the app
/// does to a copy when it opens one, done when the copy is listed or when
/// the clipper's helper first reaches it.
///
/// # Errors
///
/// [`MintIdentityError`] when no new identity can be made or written.
pub fn mint_copy_identity(folder: &Path) -> Result<String, MintIdentityError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(MintIdentityError::Random)?;
    // A random (version 4) UUID, written as the 32 hex digits every space
    // identity is.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let id = bytes.iter().fold(String::with_capacity(32), |mut id, byte| {
        // Writing into a `String` cannot fail.
        let _ = write!(id, "{byte:02x}");
        id
    });
    let path = folder.join(ID_FILES[0]);
    // A copy of a space that still keeps its identity in the legacy
    // `.arena` folder has no `.mine` folder yet.
    let written = std::fs::create_dir_all(folder.join(".mine"))
        .map_err(anyhow::Error::from)
        .and_then(|()| {
            crate::storage::files::write_atomically(&path, format!("{id}\n").as_bytes())
        });
    written.map_err(|source| MintIdentityError::Write { path, source })?;
    Ok(id)
}

/// Put the records in the given path order; unknown paths are ignored and
/// records not named keep their relative order at the end.
pub fn reorder(cfg: &mut Map<String, Value>, order: &[String]) {
    let mut records = records(cfg);
    records.sort_by_key(|record| {
        order
            .iter()
            .position(|path| same_path(path, &record.path))
            .unwrap_or(usize::MAX)
    });
    write_records(cfg, &records);
}

/// Bring back spaces missing from the list from their derived stores
/// (П27). Every space opened once leaves `vaults/<vault-id>/owner-path.json`
/// with the path it was last opened at. Spaces the person forgot stay
/// forgotten. Returns how many records were added.
pub fn recover_from_derived_stores(cfg: &mut Map<String, Value>, vaults_dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(vaults_dir) else {
        return 0;
    };
    let mut records = records(cfg);
    let forgotten = forgotten(cfg);
    let mut found: Vec<(u64, SpaceRecord)> = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_space_id(&id) || forgotten.contains(&id) {
            continue;
        }
        if records
            .iter()
            .any(|record| record.vault_id.as_deref() == Some(id.as_str()))
        {
            continue;
        }
        let Some((path, seen)) = owner_path(&entry.path()) else {
            continue;
        };
        // A path already listed under another identity is that space's.
        if records.iter().any(|record| same_path(&record.path, &path)) {
            continue;
        }
        found.push((
            seen,
            SpaceRecord {
                vault_id: Some(id),
                path,
                last_opened_ms: Some(seen),
            },
        ));
    }
    if found.is_empty() {
        return 0;
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    // Settings that lost the list lost the open space with it: the space
    // opened last, of those that are here, opens again (SPEC_AUDIT_FIXES.md,
    // А6.6). A person who closed every space keeps none open: then nothing
    // was lost from the list and nothing is recovered.
    if current_path(cfg).is_none() {
        if let Some((_, latest)) = found.iter().find(|(_, record)| is_available(record)) {
            cfg.insert(VAULT_PATH_KEY.into(), Value::from(latest.path.clone()));
        }
    }
    let added = found.len();
    records.extend(found.into_iter().map(|(_, record)| record));
    write_records(cfg, &records);
    added
}

/// Write the records and the path-list projection older readers use.
fn write_records(cfg: &mut Map<String, Value>, records: &[SpaceRecord]) {
    cfg.insert(
        SPACES_KEY.into(),
        serde_json::to_value(records).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    cfg.insert(
        KNOWN_VAULTS_KEY.into(),
        Value::Array(
            records
                .iter()
                .map(|record| Value::from(record.path.clone()))
                .collect(),
        ),
    );
}

fn forgotten(cfg: &Map<String, Value>) -> Vec<String> {
    cfg.get(FORGOTTEN_KEY)
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn remember_forgotten(cfg: &mut Map<String, Value>, id: &str) {
    let mut ids = forgotten(cfg);
    if !ids.iter().any(|known| known == id) {
        ids.push(id.to_string());
    }
    cfg.insert(FORGOTTEN_KEY.into(), Value::from(ids));
}

fn unforget(cfg: &mut Map<String, Value>, id: &str) {
    let ids: Vec<String> = forgotten(cfg).into_iter().filter(|known| known != id).collect();
    if ids.is_empty() {
        cfg.remove(FORGOTTEN_KEY);
    } else {
        cfg.insert(FORGOTTEN_KEY.into(), Value::from(ids));
    }
}

/// Two spellings of one folder are one path; a folder that no longer
/// exists compares by its recorded spelling.
pub fn same_path(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Space identifiers are 32 lowercase hex digits.
pub fn is_space_id(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Where the derived stores live in an app data directory.
pub fn vaults_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("vaults")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MINE: &str = "cea575682e5a4018991c0097fbedff66";
    const NSFV: &str = "e7fc8f8bf1294aaa89f375ac9cfaf1b4";

    fn space(parent: &Path, name: &str, id: &str) -> String {
        let folder = parent.join(name);
        std::fs::create_dir_all(folder.join(".mine")).unwrap();
        std::fs::write(folder.join(".mine/vault-id"), id).unwrap();
        folder.to_string_lossy().into_owned()
    }

    fn derived(app_data: &Path, id: &str, path: &str) {
        let store = vaults_dir(app_data).join(id);
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("owner-path.json"), json!({ "path": path }).to_string()).unwrap();
    }

    /// A space whose identity file iCloud moved off this Mac: the name and
    /// size stay, no blocks are allocated.
    fn space_in_cloud(parent: &Path, name: &str) -> String {
        let folder = parent.join("Mobile Documents").join(name);
        std::fs::create_dir_all(folder.join(".mine")).unwrap();
        std::fs::File::create(folder.join(".mine/vault-id"))
            .unwrap()
            .set_len(32)
            .unwrap();
        folder.to_string_lossy().into_owned()
    }

    #[test]
    fn an_identity_only_in_icloud_is_never_waited_for() {
        let dir = tempfile::tempdir().unwrap();
        let nsfv = space_in_cloud(dir.path(), "NSFV");
        assert_eq!(space_identity(Path::new(&nsfv)), SpaceIdentity::InCloud);
        let record = SpaceRecord {
            vault_id: Some(NSFV.into()),
            path: nsfv.clone(),
            last_opened_ms: None,
        };
        // The folder is where the space was: listed as available, opened in
        // place, not searched for.
        assert!(is_available(&record));
        let mut cfg = Map::new();
        add_space(&mut cfg, Some(NSFV), &nsfv);
        assert_eq!(locate(&cfg, Some(NSFV), &nsfv), Located::Here { path: nsfv });
    }

    #[test]
    fn k1_locate_finds_a_space_by_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mine = space(dir.path(), "Mine", MINE);
        let nsfv = space(dir.path(), "NSFV", NSFV);
        let mut cfg = Map::new();
        record_open(&mut cfg, NSFV, &nsfv, 1);
        record_open(&mut cfg, MINE, &mine, 2);
        assert_eq!(locate(&cfg, Some(MINE), &mine), Located::Here { path: mine.clone() });

        // Renamed between two requests, before the app noticed.
        let renamed = dir.path().join("Mine!").to_string_lossy().into_owned();
        std::fs::rename(&mine, &renamed).unwrap();
        assert_eq!(
            locate(&cfg, Some(MINE), &mine),
            Located::Moved { from: mine.clone(), path: renamed.clone() }
        );
        // A choice made before К1 carries no identity: the list supplies it.
        assert_eq!(
            locate(&cfg, None, &mine),
            Located::Moved { from: mine.clone(), path: renamed.clone() }
        );
        // The other space is untouched by the rename.
        assert_eq!(locate(&cfg, Some(NSFV), &nsfv), Located::Here { path: nsfv });
    }

    #[test]
    fn k1_locate_follows_the_list_to_another_parent() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("a").join("Mine").to_string_lossy().into_owned();
        let moved = space(&dir.path().join("b"), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &moved, 1);
        assert_eq!(
            locate(&cfg, Some(MINE), &old),
            Located::Moved { from: old, path: moved }
        );
    }

    #[test]
    fn k1_locate_does_not_guess_between_copies() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Mine").to_string_lossy().into_owned();
        space(dir.path(), "Mine copy 1", MINE);
        space(dir.path(), "Mine copy 2", MINE);
        assert_eq!(
            locate(&Map::new(), Some(MINE), &old),
            Located::Lost { path: old, reason: LostReason::Missing }
        );
    }

    #[test]
    fn a_folder_without_identity_at_the_saved_path_is_not_the_saved_space() {
        // Ф8: an empty folder recreated at the saved path (a sync bringing
        // back the name, a new folder with the old name) must not be opened
        // as the space, and must not receive its identity.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Mine");
        std::fs::create_dir_all(&path).unwrap();
        let path = path.to_string_lossy().into_owned();
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &path, 1);
        assert_eq!(
            locate(&cfg, Some(MINE), &path),
            Located::Lost { path: path.clone(), reason: LostReason::Replaced }
        );
        assert!(!Path::new(&path).join(".mine").exists());
    }

    #[test]
    fn k1_locate_reports_a_missing_drive_and_a_replaced_folder() {
        let dir = tempfile::tempdir().unwrap();
        let gone = "/Volumes/Unplugged/Mine".to_string();
        assert_eq!(
            locate(&Map::new(), Some(MINE), &gone),
            Located::Lost { path: gone, reason: LostReason::Missing }
        );
        let other = space(dir.path(), "Mine", NSFV);
        assert_eq!(
            locate(&Map::new(), Some(MINE), &other),
            Located::Lost { path: other, reason: LostReason::Replaced }
        );
    }

    #[test]
    fn a_renamed_space_updates_its_record_instead_of_adding_one() {
        let dir = tempfile::tempdir().unwrap();
        let old = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &old, 1);
        let renamed = dir.path().join("Mine!");
        std::fs::rename(&old, &renamed).unwrap();
        record_open(&mut cfg, MINE, renamed.to_str().unwrap(), 2);
        let listed = records(&cfg);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, renamed.to_str().unwrap());
        assert_eq!(cfg["known_vaults"], json!([renamed.to_str().unwrap()]));
    }

    #[test]
    fn an_unavailable_space_stays_listed_and_marked() {
        let dir = tempfile::tempdir().unwrap();
        let mine = space(dir.path(), "Mine", MINE);
        let nsfv = space(dir.path(), "NSFV", NSFV);
        let mut cfg = Map::new();
        record_open(&mut cfg, NSFV, &nsfv, 1);
        record_open(&mut cfg, MINE, &mine, 2);
        std::fs::rename(&mine, dir.path().join("Mine!")).unwrap();
        let listed = statuses(&cfg);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|status| status.record.path == nsfv && status.available));
        assert!(listed.iter().any(|status| status.record.path == mine && !status.available));
    }

    #[test]
    fn forgetting_one_space_keeps_the_others_and_every_other_setting() {
        let dir = tempfile::tempdir().unwrap();
        let mine = space(dir.path(), "Mine", MINE);
        let nsfv = space(dir.path(), "NSFV", NSFV);
        let mut cfg = Map::new();
        cfg.insert("shortcut_overrides".into(), json!({"x": "y"}));
        record_open(&mut cfg, NSFV, &nsfv, 1);
        record_open(&mut cfg, MINE, &mine, 2);
        forget(&mut cfg, &mine);
        assert_eq!(records(&cfg).len(), 1);
        assert_eq!(records(&cfg)[0].path, nsfv);
        assert_eq!(cfg["shortcut_overrides"], json!({"x": "y"}));
        assert!(current_path(&cfg).is_none());
    }

    #[test]
    fn lost_spaces_come_back_from_their_derived_stores_but_forgotten_ones_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let mine = space(dir.path(), "Mine!", MINE);
        let nsfv = space(dir.path(), "NSFV", NSFV);
        derived(&app_data, MINE, &mine);
        derived(&app_data, NSFV, &nsfv);
        let gone_id = "8c936f27815f4af39fe6cb40aa8e983e";
        let gone_path = dir.path().join("untitled folder").to_string_lossy().into_owned();
        derived(&app_data, gone_id, &gone_path);
        let forgotten_id = "0123456789abcdef0123456789abcdef";
        derived(&app_data, forgotten_id, "/somewhere/forgotten");

        // The settings the incident left behind: only the renamed space.
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &mine, 5);
        remember_forgotten(&mut cfg, forgotten_id);

        let added = recover_from_derived_stores(&mut cfg, &vaults_dir(&app_data));
        assert_eq!(added, 2);
        let listed = statuses(&cfg);
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().any(|status| status.record.path == nsfv && status.available));
        assert!(listed.iter().any(|status| status.record.path == gone_path && !status.available));
        assert!(!listed.iter().any(|status| status.record.path == "/somewhere/forgotten"));
        // Running again adds nothing.
        assert_eq!(recover_from_derived_stores(&mut cfg, &vaults_dir(&app_data)), 0);
    }

    #[test]
    fn lost_settings_reopen_the_space_opened_last() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app-data");
        let mine = space(dir.path(), "Mine", MINE);
        let nsfv = space(dir.path(), "NSFV", NSFV);
        derived(&app_data, MINE, &mine);
        std::thread::sleep(std::time::Duration::from_millis(20));
        derived(&app_data, NSFV, &nsfv);

        // The settings were damaged and set aside: nothing is left.
        let mut cfg = Map::new();
        assert_eq!(recover_from_derived_stores(&mut cfg, &vaults_dir(&app_data)), 2);
        assert_eq!(current_path(&cfg), Some(nsfv));
    }

    #[test]
    fn opening_a_forgotten_space_again_lists_it_again() {
        let dir = tempfile::tempdir().unwrap();
        let mine = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &mine, 1);
        forget(&mut cfg, &mine);
        record_open(&mut cfg, MINE, &mine, 2);
        assert_eq!(records(&cfg).len(), 1);
        assert!(cfg.get(FORGOTTEN_KEY).is_none());
    }

    #[test]
    fn settings_from_before_the_registry_become_records() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let mine = space(dir.path(), "Mine", MINE);
        derived(&app_data, MINE, &mine);
        let mut cfg = Map::new();
        cfg.insert("known_vaults".into(), json!([mine.clone(), "/gone"]));
        cfg.insert("vault_path".into(), json!(mine.clone()));
        let listed = records(&cfg);
        assert_eq!(listed.len(), 2);
        // What stands at a listed path now does not say which space was
        // there: the records carry no identity of their own.
        assert_eq!(listed[0].vault_id, None);
        assert_eq!(listed[1].vault_id, None);
        // The derived store that saw the space there does.
        assert_eq!(
            locate_saved(&cfg, Some(&vaults_dir(&app_data)), &mine),
            Located::Here { path: mine }
        );
    }

    /// Settings written before the registry: a list of paths and the current
    /// one, no identities.
    fn settings_before_the_registry(path: &str) -> Map<String, Value> {
        let mut cfg = Map::new();
        cfg.insert("known_vaults".into(), json!([path]));
        cfg.insert("vault_path".into(), json!(path));
        cfg
    }

    #[test]
    fn an_old_listing_follows_its_space_away_from_an_empty_folder() {
        // Б2.2: the space X opened at A was renamed to B while Mine was
        // closed, and an empty folder now stands at A. The derived store
        // says A held X: X is found at B, and A is not taken for it.
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let old = dir.path().join("Mine").to_string_lossy().into_owned();
        derived(&app_data, MINE, &old);
        let moved = space(dir.path(), "Mine renamed", MINE);
        std::fs::create_dir(&old).unwrap();
        let cfg = settings_before_the_registry(&old);

        assert_eq!(
            locate_saved(&cfg, Some(&vaults_dir(&app_data)), &old),
            Located::Moved { from: old.clone(), path: moved }
        );
        assert_eq!(std::fs::read_dir(&old).unwrap().count(), 0);
    }

    #[test]
    fn an_old_listing_does_not_take_another_space_at_its_path_for_its_own() {
        // Б2.2: the folder at the listed path is another space now.
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let path = dir.path().join("Mine").to_string_lossy().into_owned();
        derived(&app_data, MINE, &path);
        space(dir.path(), "Mine", NSFV);
        let cfg = settings_before_the_registry(&path);

        assert_eq!(
            locate_saved(&cfg, Some(&vaults_dir(&app_data)), &path),
            Located::Lost { path: path.clone(), reason: LostReason::Replaced }
        );
        assert_eq!(read_space_id(Path::new(&path)).as_deref(), Some(NSFV));
    }

    #[test]
    fn a_listed_folder_no_store_has_seen_opens_only_with_an_identity() {
        // Б2.2: with no derived store naming the path, a folder carrying an
        // identity is the space; a folder without one is none at all.
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let mine = space(dir.path(), "Mine", MINE);
        assert_eq!(
            locate_saved(&settings_before_the_registry(&mine), Some(&vaults_dir(&app_data)), &mine),
            Located::Here { path: mine }
        );

        let empty = dir.path().join("Empty").to_string_lossy().into_owned();
        std::fs::create_dir(&empty).unwrap();
        let cfg = settings_before_the_registry(&empty);
        assert_eq!(
            locate_saved(&cfg, Some(&vaults_dir(&app_data)), &empty),
            Located::Lost { path: empty.clone(), reason: LostReason::Replaced }
        );
        // A record saved with no identity is the same case.
        let mut listed = Map::new();
        add_space(&mut listed, None, &empty);
        listed.insert("vault_path".into(), json!(empty.clone()));
        assert_eq!(
            locate_saved(&listed, Some(&vaults_dir(&app_data)), &empty),
            Located::Lost { path: empty, reason: LostReason::Replaced }
        );
    }

    /// В2.2: the space X was listed at A by settings from before the
    /// registry, was renamed to B while Mine was closed, and an empty folder
    /// now stands at A.
    fn legacy_listing_moved_beside_an_empty_folder(
        dir: &Path,
    ) -> (Map<String, Value>, PathBuf, String, String) {
        let app_data = dir.join("app");
        let old = dir.join("Mine").to_string_lossy().into_owned();
        derived(&app_data, MINE, &old);
        let moved = space(dir, "Mine renamed", MINE);
        std::fs::create_dir(&old).unwrap();
        (settings_before_the_registry(&old), vaults_dir(&app_data), old, moved)
    }

    #[test]
    fn a_legacy_record_follows_its_space_instead_of_staying_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (mut cfg, vaults, old, moved) = legacy_listing_moved_beside_an_empty_folder(dir.path());
        assert_eq!(
            locate_saved(&cfg, Some(&vaults), &old),
            Located::Moved { from: old.clone(), path: moved.clone() }
        );

        record_moved(&mut cfg, MINE, &old, &moved, 7);

        assert_eq!(
            records(&cfg),
            vec![SpaceRecord {
                vault_id: Some(MINE.into()),
                path: moved.clone(),
                last_opened_ms: Some(7),
            }]
        );
        assert_eq!(current_path(&cfg), Some(moved.clone()));
        assert_eq!(cfg["known_vaults"], json!([moved]));
    }

    #[test]
    fn a_move_leaves_the_current_space_alone_when_another_one_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let (mut cfg, _, old, moved) = legacy_listing_moved_beside_an_empty_folder(dir.path());
        let other = space(dir.path(), "NSFV", NSFV);
        record_open(&mut cfg, NSFV, &other, 5);

        record_moved(&mut cfg, MINE, &old, &moved, 7);

        assert_eq!(current_path(&cfg), Some(other.clone()));
        let paths: Vec<String> = records(&cfg).into_iter().map(|record| record.path).collect();
        assert_eq!(paths, vec![moved, other]);
    }

    #[test]
    fn an_empty_folder_left_at_a_legacy_path_is_not_an_available_space() {
        let dir = tempfile::tempdir().unwrap();
        let (cfg, vaults, old, _) = legacy_listing_moved_beside_an_empty_folder(dir.path());

        let listed = statuses_in(&cfg, Some(&vaults));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].record.path, old);
        assert!(!listed[0].available, "the empty folder at A is not the space X");
        assert_eq!(std::fs::read_dir(&old).unwrap().count(), 0);
    }

    #[test]
    fn a_legacy_record_is_available_where_its_space_still_is() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let mine = space(dir.path(), "Mine", MINE);
        derived(&app_data, MINE, &mine);
        // Another space now stands where a store saw a third one.
        let replaced = space(dir.path(), "Replaced", NSFV);
        derived(&app_data, "0123456789abcdef0123456789abcdef", &replaced);
        let vaults = vaults_dir(&app_data);

        let cfg = settings_before_the_registry(&mine);
        assert!(statuses_in(&cfg, Some(&vaults))[0].available);
        let cfg = settings_before_the_registry(&replaced);
        assert!(!statuses_in(&cfg, Some(&vaults))[0].available);
        // A folder listed but never opened as a space on this Mac stands
        // for itself: the person picks it from the list.
        let fresh = dir.path().join("Fresh").to_string_lossy().into_owned();
        std::fs::create_dir(&fresh).unwrap();
        let cfg = settings_before_the_registry(&fresh);
        assert!(statuses_in(&cfg, Some(&vaults))[0].available);
    }

    #[test]
    fn the_space_opened_last_at_a_path_is_the_one_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let path = dir.path().join("Mine").to_string_lossy().into_owned();
        derived(&app_data, NSFV, &path);
        std::thread::sleep(std::time::Duration::from_millis(20));
        derived(&app_data, MINE, &path);
        derived(&app_data, "0123456789abcdef0123456789abcdef", "/elsewhere");
        assert_eq!(derived_owners(&vaults_dir(&app_data), &path), vec![MINE, NSFV]);
    }

    #[test]
    fn a_renamed_space_is_found_beside_its_old_path() {
        let dir = tempfile::tempdir().unwrap();
        let old = space(dir.path(), "Mine", MINE);
        space(dir.path(), "NSFV", NSFV);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &old, 1);
        let renamed = dir.path().join("Mine!");
        std::fs::rename(&old, &renamed).unwrap();
        let record = record_at(&cfg, &old).unwrap();
        assert_eq!(find_moved(&record).as_deref(), renamed.to_str());
    }

    #[test]
    fn two_folders_with_the_same_identity_are_not_guessed_between() {
        let dir = tempfile::tempdir().unwrap();
        let old = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &old, 1);
        std::fs::rename(&old, dir.path().join("Mine!")).unwrap();
        space(dir.path(), "Mine copy", MINE);
        assert_eq!(find_moved(&record_at(&cfg, &old).unwrap()), None);
    }

    #[test]
    fn a_space_still_at_its_path_has_not_moved() {
        let dir = tempfile::tempdir().unwrap();
        let old = space(dir.path(), "Mine", MINE);
        space(dir.path(), "Mine copy", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &old, 1);
        assert_eq!(find_moved(&record_at(&cfg, &old).unwrap()), None);
    }

    #[test]
    fn reorder_follows_the_given_paths() {
        let dir = tempfile::tempdir().unwrap();
        let mine = space(dir.path(), "Mine", MINE);
        let nsfv = space(dir.path(), "NSFV", NSFV);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &mine, 1);
        record_open(&mut cfg, NSFV, &nsfv, 2);
        reorder(&mut cfg, &[nsfv.clone(), mine.clone()]);
        let paths: Vec<String> = records(&cfg).into_iter().map(|record| record.path).collect();
        assert_eq!(paths, vec![nsfv, mine]);
    }

    /// Г2.5, П16: the space X, listed at A, moved to B; nothing is at A. Adding
    /// B moves X's record there: one record, available, still the current
    /// space, and the other space untouched.
    #[test]
    fn adding_a_moved_space_moves_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let nsfv = space(dir.path(), "NSFV", NSFV);
        let old = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, NSFV, &nsfv, 1);
        record_open(&mut cfg, MINE, &old, 2);
        let moved = dir.path().join("Mine moved").to_string_lossy().into_owned();
        std::fs::rename(&old, &moved).unwrap();

        assert_eq!(
            add_space(&mut cfg, Some(MINE), &moved),
            AddedSpace::Moved { from: old.clone() }
        );

        assert_eq!(
            records(&cfg),
            vec![
                SpaceRecord { vault_id: Some(NSFV.into()), path: nsfv.clone(), last_opened_ms: Some(1) },
                SpaceRecord { vault_id: Some(MINE.into()), path: moved.clone(), last_opened_ms: Some(2) },
            ]
        );
        assert!(statuses(&cfg).iter().all(|status| status.available));
        assert_eq!(current_path(&cfg), Some(moved));
    }

    /// Г2.5, П16: a folder at the old path that is another space, or no
    /// space at all, is not where X lives: X's record still moves.
    #[test]
    fn adding_a_moved_space_moves_its_record_past_a_folder_that_took_its_old_path() {
        for occupant in [Some(NSFV), None] {
            let dir = tempfile::tempdir().unwrap();
            let old = space(dir.path(), "Mine", MINE);
            let mut cfg = Map::new();
            record_open(&mut cfg, MINE, &old, 1);
            let moved = dir.path().join("Mine moved").to_string_lossy().into_owned();
            std::fs::rename(&old, &moved).unwrap();
            match occupant {
                Some(id) => {
                    space(dir.path(), "Mine", id);
                }
                None => std::fs::create_dir(&old).unwrap(),
            }

            assert_eq!(
                add_space(&mut cfg, Some(MINE), &moved),
                AddedSpace::Moved { from: old.clone() }
            );

            let listed = records(&cfg);
            assert_eq!(listed.len(), 1, "{occupant:?}: {listed:?}");
            assert_eq!(listed[0].vault_id.as_deref(), Some(MINE));
            assert_eq!(listed[0].path, moved);
            assert_eq!(read_space_id(Path::new(&moved)).as_deref(), Some(MINE));
        }
    }

    /// Г2.5, П22, П26: a copy of X added while X is alive at A. The copy is a
    /// space of its own: its own identity and its own record; A keeps X.
    #[test]
    fn adding_a_copy_of_a_live_space_lists_it_as_a_space_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let original = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &original, 1);
        let copy = space(dir.path(), "Mine copy", MINE);

        let added = add_space(&mut cfg, Some(MINE), &copy);

        let listed = records(&cfg);
        assert_eq!(listed.len(), 2, "the copy was dropped: {listed:?}");
        assert_eq!(
            added,
            AddedSpace::Copied { original: original.clone(), vault_id: listed[1].vault_id.clone() }
        );
        assert_eq!(
            listed[0],
            SpaceRecord { vault_id: Some(MINE.into()), path: original.clone(), last_opened_ms: Some(1) }
        );
        assert_eq!(listed[1].path, copy);
        let own = listed[1].vault_id.clone().expect("the copy carries an identity");
        assert!(is_space_id(&own), "{own}");
        assert_ne!(own, MINE);
        assert_eq!(read_space_id(Path::new(&copy)), Some(own));
        assert_eq!(read_space_id(Path::new(&original)).as_deref(), Some(MINE));
        assert!(statuses(&cfg).iter().all(|status| status.available));
        assert_eq!(current_path(&cfg), Some(original));
    }

    /// Д2.1: a folder without an identity, one whose identity is in iCloud and
    /// one whose identity cannot be read are three different answers.
    #[test]
    fn an_identity_that_cannot_be_read_is_never_taken_for_none() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mine = space(dir.path(), "Mine", MINE);
        assert_eq!(read_identity(Path::new(&mine), CloudRead::NoWait), Ok(Some(MINE.into())));
        let plain = dir.path().join("Plain");
        std::fs::create_dir(&plain).unwrap();
        assert_eq!(read_identity(&plain, CloudRead::NoWait), Ok(None));

        let nsfv = space_in_cloud(dir.path(), "NSFV");
        let file = Path::new(&nsfv).join(".mine/vault-id");
        assert_eq!(
            read_identity(Path::new(&nsfv), CloudRead::NoWait),
            Err(IdentityUnreadable::InCloud { path: file.clone() })
        );

        let locked = Path::new(&mine).join(".mine/vault-id");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = read_identity(Path::new(&mine), CloudRead::Wait);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            matches!(&unreadable, Err(IdentityUnreadable::Unreadable { path, .. }) if *path == locked),
            "{unreadable:?}"
        );
    }

    /// П22: one rule for the app and the clipper's helper. A store that last
    /// served this folder owns it; the same space alive where the store last
    /// served it makes the folder a copy; a folder there whose identity
    /// cannot be read leaves it undecided (Д2.1), never a move.
    #[test]
    fn the_copy_rule_tells_the_space_its_move_and_its_copy_apart() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let store = vaults_dir(&app_data).join(MINE);
        let original = space(dir.path(), "Mine", MINE);
        let copy = space(dir.path(), "Mine copy", MINE);
        let claim = |folder: &str| identity_claim(Path::new(folder), &store, MINE, CloudRead::NoWait);

        assert_eq!(claim(&copy), IdentityClaim::Owned, "no folder recorded yet");
        record_owner_path(&store, Path::new(&original));
        assert_eq!(claim(&original), IdentityClaim::Owned);
        assert_eq!(claim(&copy), IdentityClaim::Copy { owner: PathBuf::from(&original) });

        std::fs::remove_dir_all(&original).unwrap();
        assert_eq!(claim(&copy), IdentityClaim::Adopted, "the original moved away");

        let in_cloud = space_in_cloud(dir.path(), "Mine");
        record_owner_path(&store, Path::new(&in_cloud));
        assert_eq!(
            claim(&copy),
            IdentityClaim::Undecided {
                owner: PathBuf::from(&in_cloud),
                cause: IdentityUnreadable::InCloud {
                    path: Path::new(&in_cloud).join(".mine/vault-id"),
                },
            }
        );
    }

    /// Д2.3, П16: the space X was listed at P and renamed beside it; P now
    /// holds the space Y. Adding P lists Y there, available, and X's record
    /// follows X, along with the current binding that named P.
    #[test]
    fn adding_another_space_at_a_listed_path_lists_it_and_the_old_space_follows_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let p = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &p, 1);
        let renamed = dir.path().join("Mine old").to_string_lossy().into_owned();
        std::fs::rename(&p, &renamed).unwrap();
        space(dir.path(), "Mine", NSFV);

        assert_eq!(add_space(&mut cfg, Some(NSFV), &p), AddedSpace::Listed);

        assert_eq!(
            records(&cfg),
            vec![
                SpaceRecord { vault_id: Some(MINE.into()), path: renamed.clone(), last_opened_ms: Some(1) },
                SpaceRecord { vault_id: Some(NSFV.into()), path: p.clone(), last_opened_ms: None },
            ]
        );
        assert!(statuses(&cfg).iter().all(|status| status.available));
        assert_eq!(current_path(&cfg), Some(renamed));
        assert_eq!(read_space_id(Path::new(&p)).as_deref(), Some(NSFV));
    }

    /// Д2.3: X is nowhere to be found. Its record no longer names P, which
    /// holds Y: a path stands for one space only, and every listing, Forget
    /// and Reorder go by path. Y's record moves from where Y was listed.
    #[test]
    fn adding_another_space_at_a_listed_path_takes_the_path_from_a_space_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let p = space(dir.path(), "Mine", MINE);
        let q = space(dir.path(), "NSFV", NSFV);
        let mut cfg = Map::new();
        record_open(&mut cfg, NSFV, &q, 1);
        record_open(&mut cfg, MINE, &p, 2);
        std::fs::remove_dir_all(&p).unwrap();
        std::fs::rename(&q, &p).unwrap();

        assert_eq!(add_space(&mut cfg, Some(NSFV), &p), AddedSpace::Moved { from: q });

        assert_eq!(
            records(&cfg),
            vec![SpaceRecord { vault_id: Some(NSFV.into()), path: p.clone(), last_opened_ms: Some(1) }]
        );
        let listed = statuses(&cfg);
        assert!(listed.iter().all(|status| status.available), "{listed:?}");
        assert!(!listed.iter().any(|status| status.record.vault_id.as_deref() == Some(MINE)));
        assert_eq!(cfg["known_vaults"], json!([p.clone()]));
        assert_eq!(locate(&cfg, Some(NSFV), &p), Located::Here { path: p });
    }

    /// Д2.3: the folder at a listed path is the listed space, or its identity
    /// cannot be read now: nothing changes.
    #[test]
    fn adding_a_listed_path_that_holds_its_space_keeps_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let p = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &p, 1);
        let before = records(&cfg);
        assert_eq!(add_space(&mut cfg, Some(MINE), &p), AddedSpace::AlreadyListed);
        assert_eq!(add_space(&mut cfg, None, &p), AddedSpace::AlreadyListed);
        assert_eq!(records(&cfg), before);
    }

    /// П22, П26: whether the folder is a copy cannot be told while the
    /// original's identity is only in iCloud. The folder is listed on its
    /// own, keeps what it carries, and opening it applies the copy rule.
    #[test]
    fn a_copy_beside_an_original_only_in_icloud_is_listed_undecided() {
        let dir = tempfile::tempdir().unwrap();
        let original = space_in_cloud(dir.path(), "Mine");
        let mut cfg = Map::new();
        record_open(&mut cfg, MINE, &original, 1);
        let copy = space(dir.path(), "Mine copy", MINE);

        assert_eq!(add_space(&mut cfg, Some(MINE), &copy), AddedSpace::Listed);

        let listed = records(&cfg);
        assert_eq!(listed.len(), 2, "{listed:?}");
        assert_eq!(listed[0].vault_id.as_deref(), Some(MINE));
        assert_eq!(listed[0].path, original);
        assert_eq!(listed[1], SpaceRecord { vault_id: None, path: copy.clone(), last_opened_ms: None });
        assert_eq!(read_space_id(Path::new(&copy)).as_deref(), Some(MINE));
    }
}
