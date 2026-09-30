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

/// The identity when it can be known without waiting.
fn known_space_id(folder: &Path) -> Option<String> {
    match space_identity(folder) {
        SpaceIdentity::Known(id) => Some(id),
        SpaceIdentity::InCloud | SpaceIdentity::Absent => None,
    }
}

/// Whether `path` holds the space `record` stands for. An identity file
/// still in iCloud cannot disprove it: the folder is where the space was.
pub fn is_available(record: &SpaceRecord) -> bool {
    let folder = Path::new(&record.path);
    if !folder.is_dir() {
        return false;
    }
    match &record.vault_id {
        Some(id) => match space_identity(folder) {
            SpaceIdentity::Known(found) => &found == id,
            SpaceIdentity::InCloud => true,
            SpaceIdentity::Absent => false,
        },
        None => true,
    }
}

/// The records, in the person's order. Settings from before the registry
/// yield path-only records.
pub fn records(cfg: &Map<String, Value>) -> Vec<SpaceRecord> {
    if let Some(value) = cfg.get(SPACES_KEY) {
        if let Ok(records) = serde_json::from_value::<Vec<SpaceRecord>>(value.clone()) {
            return records;
        }
    }
    let mut records: Vec<SpaceRecord> = cfg
        .get(KNOWN_VAULTS_KEY)
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(|path| SpaceRecord {
                    vault_id: known_space_id(Path::new(path)),
                    path: path.to_string(),
                    last_opened_ms: None,
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(current) = current_path(cfg) {
        if !records.iter().any(|record| same_path(&record.path, &current)) {
            records.push(SpaceRecord {
                vault_id: known_space_id(Path::new(&current)),
                path: current,
                last_opened_ms: None,
            });
        }
    }
    records
}

/// Every record with its availability.
pub fn statuses(cfg: &Map<String, Value>) -> Vec<SpaceStatus> {
    records(cfg)
        .into_iter()
        .map(|record| SpaceStatus {
            available: is_available(&record),
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
    let mut records = records(cfg);
    let position = records
        .iter()
        .position(|record| record.vault_id.as_deref() == Some(vault_id))
        .or_else(|| {
            records
                .iter()
                .position(|record| record.vault_id.is_none() && same_path(&record.path, path))
        });
    let record = SpaceRecord {
        vault_id: Some(vault_id.to_string()),
        path: path.to_string(),
        last_opened_ms: Some(now_ms),
    };
    match position {
        Some(index) => records[index] = record,
        None => records.push(record),
    }
    // A path now belongs to one space only.
    let mut seen_path = false;
    records.retain(|entry| {
        if !same_path(&entry.path, path) {
            return true;
        }
        if entry.vault_id.as_deref() == Some(vault_id) && !seen_path {
            seen_path = true;
            return true;
        }
        false
    });
    unforget(cfg, vault_id);
    write_records(cfg, &records);
    cfg.insert(VAULT_PATH_KEY.into(), Value::from(path));
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
    let reason = if hint_readable {
        LostReason::Replaced
    } else {
        match std::fs::metadata(here) {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                LostReason::AccessDenied
            }
            Ok(metadata) if metadata.is_dir() => LostReason::AccessDenied,
            _ => LostReason::Missing,
        }
    };
    Located::Lost { path: hint.to_string(), reason }
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

/// List a space without opening it (the settings window's Add). A space the
/// person forgot and adds again is no longer forgotten.
pub fn add_space(cfg: &mut Map<String, Value>, vault_id: Option<&str>, path: &str) {
    let mut records = records(cfg);
    let known = records.iter().any(|record| {
        same_path(&record.path, path)
            || (vault_id.is_some() && record.vault_id.as_deref() == vault_id)
    });
    if !known {
        records.push(SpaceRecord {
            vault_id: vault_id.map(str::to_string),
            path: path.to_string(),
            last_opened_ms: None,
        });
    }
    if let Some(id) = vault_id {
        unforget(cfg, id);
    }
    write_records(cfg, &records);
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
        let owner = entry.path().join("owner-path.json");
        let Some(path) = std::fs::read_to_string(&owner)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("path").and_then(Value::as_str).map(str::to_string))
        else {
            continue;
        };
        // A path already listed under another identity is that space's.
        if records.iter().any(|record| same_path(&record.path, &path)) {
            continue;
        }
        let seen = std::fs::metadata(&owner)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
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
        let mine = space(dir.path(), "Mine", MINE);
        let mut cfg = Map::new();
        cfg.insert("known_vaults".into(), json!([mine.clone(), "/gone"]));
        cfg.insert("vault_path".into(), json!(mine.clone()));
        let listed = records(&cfg);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].vault_id.as_deref(), Some(MINE));
        assert_eq!(listed[1].vault_id, None);
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
}
