//! Auxiliary native file history for repairing external renames.
//!
//! The history keys every file by its device, inode and creation time: what
//! only this Mac knows of the file. It lives in this Mac's derived store of
//! the space (`vaults/<vault-id>/file-identity.json`), never in the space:
//! kept in `.mine` until 13.10.2026, it synced to another Mac, whose every
//! file then looked new, and each pass there reread and reindexed the notes
//! and wrote its own keys back, for this Mac to do the same in turn
//! (SPEC_DEEP_AUDIT.md, Е5.7; SPEC_IDENTITY_ROBUSTNESS.md, «Источники и
//! производные данные»: the history only proves a move on the Mac that saw
//! it). A history an earlier Mine left in the space is taken over by path
//! once. SQLite may be discarded without changing how a current source link
//! resolves.

use anyhow::{Context, Result};
use fs2::FileExt;
use mine_core::links::{LinkIndex, LinkResolution, LinkSyntax};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{Arc, Mutex, OnceLock};

use crate::domain::vault::VaultLayout;
use crate::storage::files;
use crate::storage::reference_spans::{
    references_in, replacement_for, split_reference, Reference, ReferenceSyntax,
};

const MANIFEST_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "file-identity.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct FileKey {
    device: u64,
    inode: u64,
    created_ns: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct FileEntry {
    id: String,
    path: String,
    key: FileKey,
    size: u64,
    mtime_ns: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Binding {
    source_id: String,
    reference: String,
    syntax: ReferenceSyntax,
    target_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Unresolved {
    source_id: String,
    reference: String,
    syntax: ReferenceSyntax,
}

/// File moves confirmed by a stable filesystem locator during this pass.
#[derive(Default)]
pub struct IdentityRefresh {
    pub moved_markdown: Vec<(String, String)>,
    pub affected_markdown: Vec<String>,
    pub read_errors: Vec<(PathBuf, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    files: Vec<FileEntry>,
    bindings: Vec<Binding>,
    #[serde(default)]
    unresolved: Vec<Unresolved>,
    #[serde(default)]
    pending_source_ids: Vec<String>,
    #[serde(default)]
    pending_revisions: BTreeMap<String, String>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            files: Vec::new(),
            bindings: Vec::new(),
            unresolved: Vec::new(),
            pending_source_ids: Vec::new(),
            pending_revisions: BTreeMap::new(),
        }
    }
}

/// This Mac's history of the space, in its derived store.
fn manifest_path(vault: &VaultLayout) -> PathBuf {
    vault.derived_root().join(MANIFEST_NAME)
}

/// Where an earlier Mine kept the history: in the space, synced to every Mac.
fn space_manifest_path(vault: &VaultLayout) -> PathBuf {
    vault.mine_dir().join(MANIFEST_NAME)
}

/// This Mac's history as it is now, for tests.
#[cfg(test)]
fn read_manifest(vault: &VaultLayout) -> Result<Manifest> {
    read_manifest_at(&manifest_path(vault)).map(Option::unwrap_or_default)
}

/// The history at `path`; `None` when there is none.
fn read_manifest_at(path: &Path) -> Result<Option<Manifest>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    match serde_json::from_slice::<Manifest>(&bytes) {
        Ok(manifest) if manifest.version == MANIFEST_VERSION => Ok(Some(manifest)),
        Ok(manifest) => anyhow::bail!(
            "unsupported file identity history version {} at {}; preserved",
            manifest.version,
            path.display()
        ),
        Err(error) => Err(error).with_context(|| {
            format!(
                "invalid file identity history at {}; preserved",
                path.display()
            )
        }),
    }
}

#[cfg(test)]
fn cached_manifest(vault: &VaultLayout) -> Result<Arc<Manifest>> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    type Cached = BTreeMap<PathBuf, ((u64, u128, u64), Arc<Manifest>)>;
    static CACHE: OnceLock<Mutex<Cached>> = OnceLock::new();
    let path = manifest_path(vault);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Arc::new(Manifest::default()))
        }
        Err(error) => return Err(error.into()),
    };
    #[cfg(unix)]
    let inode = metadata.ino();
    #[cfg(not(unix))]
    let inode = 0;
    let stamp = (
        metadata.len(),
        metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        inode,
    );
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((cached_stamp, manifest)) = guard.get(&path) {
            if *cached_stamp == stamp {
                return Ok(Arc::clone(manifest));
            }
        }
    }
    let manifest = Arc::new(read_manifest(vault)?);
    let mut guard = cache
        .lock()
        .map_err(|_| anyhow::anyhow!("file identity cache lock poisoned"))?;
    guard.insert(path, (stamp, Arc::clone(&manifest)));
    Ok(manifest)
}

fn write_manifest(vault: &VaultLayout, manifest: &Manifest) -> Result<()> {
    std::fs::create_dir_all(vault.derived_root())?;
    files::write_atomically(&manifest_path(vault), &serde_json::to_vec_pretty(manifest)?)
}

/// This Mac's history, or, when it has none yet, the one an earlier Mine
/// left in the space, taken over by path: its keys may be another Mac's, so
/// every file still where it says gets this Mac's key, size and time as they
/// are now, and the rest of it goes. Nothing is new afterwards and nothing is
/// reread. The space's copy stays where it is and is never written again.
fn read_or_adopt_manifest(vault: &VaultLayout) -> Result<Manifest> {
    if let Some(manifest) = read_manifest_at(&manifest_path(vault))? {
        return Ok(manifest);
    }
    let space_path = space_manifest_path(vault);
    if space_path == manifest_path(vault) {
        return Ok(Manifest::default());
    }
    let Some(mut adopted) = read_manifest_at(&space_path)? else {
        return Ok(Manifest::default());
    };
    let mut kept = BTreeSet::new();
    adopted.files.retain_mut(|entry| {
        let path = vault.root().join(&entry.path);
        let (Ok(key), Ok(metadata)) = (key_for(&path), std::fs::metadata(&path)) else {
            return false;
        };
        let Ok(mtime_ns) = metadata
            .modified()
            .map_err(anyhow::Error::from)
            .and_then(|modified| Ok(modified.duration_since(std::time::UNIX_EPOCH)?.as_nanos()))
        else {
            return false;
        };
        entry.key = key;
        entry.size = metadata.len();
        entry.mtime_ns = mtime_ns;
        kept.insert(entry.id.clone());
        true
    });
    adopted
        .bindings
        .retain(|binding| kept.contains(&binding.source_id) && kept.contains(&binding.target_id));
    adopted.unresolved.retain(|reference| kept.contains(&reference.source_id));
    adopted.pending_source_ids.retain(|id| kept.contains(id));
    adopted.pending_revisions.retain(|id, _| kept.contains(id));
    write_manifest(vault, &adopted)?;
    log::info!(
        "took over the file identity history {} by path for {}",
        space_path.display(),
        vault.root().display()
    );
    Ok(adopted)
}

fn key_for(path: &Path) -> Result<FileKey> {
    key_of(&std::fs::symlink_metadata(path)?)
}

/// The key of the file whose own attributes, not those of a link's target,
/// `metadata` is.
#[cfg(unix)]
fn key_of(metadata: &std::fs::Metadata) -> Result<FileKey> {
    use std::os::unix::fs::MetadataExt;
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "not a regular file"
    );
    let created_ns = metadata
        .created()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    Ok(FileKey {
        device: metadata.dev(),
        inode: metadata.ino(),
        created_ns,
    })
}

#[cfg(not(unix))]
fn key_of(_metadata: &std::fs::Metadata) -> Result<FileKey> {
    anyhow::bail!("native filesystem identity is unavailable on this platform")
}

/// Folders of the space listed at once. A pass over a space is mostly reads
/// of file attributes, and the layout of three folders splits them between
/// `Cards` and `Media`; the rest of the reads share the remaining lists.
const INVENTORY_LISTS: usize = 4;

/// Every file of the space under `root`, in no order. The folders of the
/// root are listed side by side, each with everything under it.
fn inventory_space(root: &Path) -> Result<Vec<FileEntry>> {
    let mut found = Vec::new();
    let folders = list_folder(root, root, &mut found)?;
    if folders.len() < 2 {
        for folder in &folders {
            inventory(folder, root, &mut found)?;
        }
        return Ok(found);
    }
    let lists = std::thread::scope(|scope| {
        let listing = (0..INVENTORY_LISTS.min(folders.len()))
            .map(|list| {
                let folders = &folders;
                scope.spawn(move || {
                    let mut found = Vec::new();
                    for folder in folders.iter().skip(list).step_by(INVENTORY_LISTS) {
                        inventory(folder, root, &mut found)?;
                    }
                    Ok(found)
                })
            })
            .collect::<Vec<_>>();
        listing
            .into_iter()
            .map(|list| {
                list.join()
                    .map_err(|_| anyhow::anyhow!("listing the files of the space panicked"))?
            })
            .collect::<Result<Vec<Vec<FileEntry>>>>()
    })?;
    found.extend(lists.into_iter().flatten());
    Ok(found)
}

/// The files of `dir` and of every folder under it.
fn inventory(dir: &Path, root: &Path, output: &mut Vec<FileEntry>) -> Result<()> {
    for folder in list_folder(dir, root, output)? {
        inventory(&folder, root, output)?;
    }
    Ok(())
}

/// The files of `dir` itself into `output`; returns the folders in it that
/// belong to the space.
fn list_folder(dir: &Path, root: &Path, output: &mut Vec<FileEntry>) -> Result<Vec<PathBuf>> {
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if files::is_ignored_vault_dir(&path) {
                continue;
            }
            folders.push(path);
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            // One read of the file's own attributes gives its key, size and
            // time: a pass over a space is mostly these reads.
            let metadata = entry.metadata()?;
            let mtime_ns = metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos();
            output.push(FileEntry {
                id: String::new(),
                path: relative,
                key: key_of(&metadata)?,
                size: metadata.len(),
                mtime_ns,
            });
        }
    }
    Ok(folders)
}

fn new_id() -> Result<String> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Reconcile the source manifest, then update established Markdown links whose
/// targets moved. An ambiguous first observation remains unbound.
/// A history that cannot be read or written is said in the log, with its
/// cause (SPEC_DEEP_AUDIT.md, Н11, Е5.8): reading the notes goes on without
/// it, and only a move it would have proved is not seen.
pub fn reconcile(vault: &VaultLayout) -> Result<IdentityRefresh> {
    reconcile_auxiliary(vault).or_else(|error| {
        log::warn!(
            "file identity history unavailable for {}: {error:#}",
            vault.root().display()
        );
        Ok(IdentityRefresh::default())
    })
}

fn reconcile_auxiliary(vault: &VaultLayout) -> Result<IdentityRefresh> {
    let _write = crate::storage::source_mutation::begin_write()?;
    let lock_path = vault.derived_root().join("file-identity.lock");
    std::fs::create_dir_all(vault.derived_root())?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .open(lock_path)?;
    lock.lock_exclusive()?;
    let result = reconcile_locked(vault);
    let unlock = lock.unlock();
    unlock?;
    result
}

/// Enrollment gate for a newly published capture. The same operation may
/// retry this after a failure without publishing source files again.
#[cfg(test)]
fn enroll_capture(vault: &VaultLayout, required_markdown: &Path) -> Result<()> {
    let relative = required_markdown
        .strip_prefix(vault.root())
        .with_context(|| {
            format!(
                "capture document escapes vault: {}",
                required_markdown.display()
            )
        })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    let report = reconcile(vault)?;
    if let Some((_, error)) = report
        .read_errors
        .iter()
        .find(|(path, _)| path == required_markdown)
    {
        anyhow::bail!(
            "capture identity enrollment read failed for {}: {error}",
            required_markdown.display()
        );
    }
    let manifest = read_manifest(vault)?;
    let entry = manifest
        .files
        .iter()
        .find(|entry| entry.path == relative)
        .with_context(|| format!("capture document missing from identity manifest: {relative}"))?;
    anyhow::ensure!(
        !manifest.pending_source_ids.contains(&entry.id),
        "capture identity enrollment is pending for {relative}"
    );
    Ok(())
}

/// Rows of one list of the history, kept in the order of that list and found
/// through their group (the source note of a reference, or a pending id
/// itself) without a pass over the whole list. Until 15.11.2026 every lookup
/// and every `Vec::retain` walked all the rows for every reference of every
/// note: the first reconcile of a large space grew with the square of its
/// size (AUDIT_PERFORMANCE.md, Б4). The rows and their order are what
/// `Vec::retain` and `Vec::push` on the list give. A row taken out stays in
/// its place, marked: the list as it was given is still there to tell
/// whether the pass changed it, with no copy of the history kept for that.
struct Grouped<T> {
    rows: Vec<Row<T>>,
    /// How many rows the list was given with: the first of `rows`.
    given: usize,
    places: HashMap<String, Vec<usize>>,
    group_of: fn(&T) -> &str,
}

struct Row<T> {
    value: T,
    /// Whether the row is in the list as it stands.
    kept: bool,
}

impl<T: Clone + PartialEq> Grouped<T> {
    fn new(list: Vec<T>, group_of: fn(&T) -> &str) -> Self {
        let mut places = HashMap::<String, Vec<usize>>::new();
        for (place, row) in list.iter().enumerate() {
            let group = group_of(row);
            match places.get_mut(group) {
                Some(of_group) => of_group.push(place),
                None => {
                    places.insert(group.to_string(), vec![place]);
                }
            }
        }
        Self {
            given: list.len(),
            rows: list
                .into_iter()
                .map(|value| Row { value, kept: true })
                .collect(),
            places,
            group_of,
        }
    }

    /// The rows of `group`, in the order of the list.
    fn of<'a>(&'a self, group: &str) -> impl Iterator<Item = &'a T> + 'a {
        self.places
            .get(group)
            .into_iter()
            .flatten()
            .map(|place| &self.rows[*place].value)
    }

    fn contains(&self, row: &T) -> bool {
        self.of((self.group_of)(row)).any(|other| other == row)
    }

    fn push(&mut self, row: T) {
        self.places
            .entry((self.group_of)(&row).to_string())
            .or_default()
            .push(self.rows.len());
        self.rows.push(Row {
            value: row,
            kept: true,
        });
    }

    /// `Vec::retain` for the rows of `group`; the rows of other groups stay.
    fn retain_in(&mut self, group: &str, mut keep: impl FnMut(&T) -> bool) {
        let Some(places) = self.places.get_mut(group) else {
            return;
        };
        let rows = &mut self.rows;
        places.retain(|place| {
            let row = &mut rows[*place];
            row.kept = keep(&row.value);
            row.kept
        });
    }

    /// The list as it stands.
    fn list(&self) -> impl Iterator<Item = &T> {
        self.rows.iter().filter(|row| row.kept).map(|row| &row.value)
    }

    /// Whether the list stands as it was given: the same rows in the same
    /// order.
    fn unchanged(&self) -> bool {
        self.list()
            .eq(self.rows[..self.given].iter().map(|row| &row.value))
    }

    fn to_vec(&self) -> Vec<T> {
        self.list().cloned().collect()
    }

    fn into_vec(self) -> Vec<T> {
        self.rows
            .into_iter()
            .filter(|row| row.kept)
            .map(|row| row.value)
            .collect()
    }
}

fn source_of_binding(binding: &Binding) -> &str {
    &binding.source_id
}

fn source_of_unresolved(reference: &Unresolved) -> &str {
    &reference.source_id
}

/// The key, the size and the time a note has after the pass rewrote it, and
/// its place in the list of files.
type Rewritten = (usize, FileKey, u64, u128);

fn apply_rewritten(files: &mut [FileEntry], rewritten: &[Rewritten]) {
    for (place, key, size, mtime_ns) in rewritten {
        let entry = &mut files[*place];
        entry.key = key.clone();
        entry.size = *size;
        entry.mtime_ns = *mtime_ns;
    }
}

/// The history as a pass has it so far, to publish it before the pass ends:
/// `manifest` carries its version and its revisions, the rest is what the
/// pass keeps beside it.
fn history_so_far(
    manifest: &Manifest,
    files: &[FileEntry],
    rewritten: &[Rewritten],
    bindings: &Grouped<Binding>,
    unresolved: &Grouped<Unresolved>,
    pending: &Grouped<String>,
) -> Manifest {
    let mut files = files.to_vec();
    apply_rewritten(&mut files, rewritten);
    Manifest {
        version: manifest.version,
        files,
        bindings: bindings.to_vec(),
        unresolved: unresolved.to_vec(),
        pending_source_ids: pending.to_vec(),
        pending_revisions: manifest.pending_revisions.clone(),
    }
}

fn reconcile_locked(vault: &VaultLayout) -> Result<IdentityRefresh> {
    // The files of the space are listed while the history is read: neither
    // needs the other, and together they are half of a pass that finds
    // nothing changed.
    let (history, observed) = std::thread::scope(|scope| {
        let listing = scope.spawn(|| inventory_space(vault.root()));
        (read_or_adopt_manifest(vault), listing.join())
    });
    let (mut manifest, persist_history) = match history {
        Ok(manifest) => (manifest, true),
        Err(error) if error.downcast_ref::<serde_json::Error>().is_some() => {
            // A malformed history cannot establish identity. Current unique
            // source targets can still be repaired, without replacing evidence.
            log::warn!("file identity history preserved; using current targets only: {error:#}");
            (Manifest::default(), false)
        }
        Err(error) => return Err(error),
    };
    let replay_pending = manifest
        .pending_source_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    // The files and the revisions of the history as it was read, to tell at
    // the end whether the pass changed it; its lists keep theirs
    // ([`Grouped::unchanged`]).
    let old_files = std::mem::take(&mut manifest.files);
    let old_revisions = manifest.pending_revisions.clone();
    let mut observed = observed
        .map_err(|_| anyhow::anyhow!("listing the files of the space panicked"))??;
    observed.sort_by(|a, b| a.path.cmp(&b.path));

    // Every map and set of this pass is asked, never walked: nothing the
    // pass writes takes its order from one of them.
    //
    // A key, one of the files of the history that carry it, and how many do.
    let mut by_key = HashMap::<(u64, u64, u128), (&FileEntry, usize)>::new();
    let mut by_path = HashMap::<&str, &FileEntry>::new();
    for entry in &old_files {
        by_key
            .entry((entry.key.device, entry.key.inode, entry.key.created_ns))
            .or_insert((entry, 0))
            .1 += 1;
        by_path.insert(&entry.path, entry);
    }
    let mut claimed = HashSet::new();
    let observed_keys = observed
        .iter()
        .map(|entry| (entry.key.device, entry.key.inode, entry.key.created_ns))
        .collect::<HashSet<_>>();
    let mut next = Vec::with_capacity(observed.len());
    let mut moves = IdentityRefresh::default();
    for mut current in observed {
        let path = current.path.clone();
        let key = current.key.clone();
        let exact = by_key.get(&(key.device, key.inode, key.created_ns));
        let previous = match exact {
            Some((entry, 1)) => Some(*entry),
            Some(_) => None,
            None => by_path.get(path.as_str()).copied().filter(|entry| {
                if !path.ends_with(".md")
                    || observed_keys.contains(&(
                        entry.key.device,
                        entry.key.inode,
                        entry.key.created_ns,
                    ))
                {
                    return false;
                }
                match manifest.pending_revisions.get(&entry.id) {
                    Some(expected) => {
                        std::fs::read(vault.root().join(&path))
                            .ok()
                            .is_some_and(|bytes| {
                                crate::storage::save_operations::sha256_bytes(&bytes) == *expected
                            })
                    }
                    None => true,
                }
            }),
        };
        let id = match previous {
            Some(entry) if claimed.insert(entry.id.clone()) => entry.id.clone(),
            _ => new_id()?,
        };
        if let Some(entry) = previous {
            if entry.id == id
                && entry.path != path
                && entry.path.ends_with(".md")
                && path.ends_with(".md")
            {
                moves.moved_markdown.push((
                    entry.path.trim_end_matches(".md").to_string(),
                    path.trim_end_matches(".md").to_string(),
                ));
            }
        }
        current.id = id;
        next.push(current);
    }
    // The files of the history after this pass. A note the pass rewrites
    // gets its new key, size and time when the pass ends (`rewritten`): the
    // pass itself reads every file as the inventory found it.
    let mut current_files = next;
    let mut rewritten = Vec::<Rewritten>::new();
    let old_by_id = old_files
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let current_links = LinkIndex::new(current_files.iter().map(|entry| entry.path.as_str()));
    let current_by_id = current_files
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    // The files of this pass by path and by name. A path names one file: the
    // inventory lists every file of the space once.
    let current_by_path = current_files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let mut files_named = HashMap::<Option<&std::ffi::OsStr>, usize>::new();
    for entry in &current_files {
        *files_named
            .entry(Path::new(&entry.path).file_name())
            .or_default() += 1;
    }
    let moved_ids = current_files
        .iter()
        .filter(|entry| {
            old_by_id
                .get(entry.id.as_str())
                .is_some_and(|old| old.path != entry.path)
        })
        .map(|entry| entry.id.clone())
        .collect::<HashSet<_>>();
    let new_ids = current_files
        .iter()
        .filter(|entry| !old_by_id.contains_key(entry.id.as_str()))
        .map(|entry| entry.id.as_str())
        .collect::<HashSet<_>>();
    let new_names = current_files
        .iter()
        .filter(|entry| new_ids.contains(entry.id.as_str()))
        .filter_map(|entry| {
            Path::new(&entry.path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();
    let reference_may_match_new_name = |source_id: &str, raw: &str, syntax: ReferenceSyntax| {
        // No new file: no name and no target to match.
        if new_ids.is_empty() {
            return false;
        }
        let name = raw.split(['|', '#', '?']).next().unwrap_or("");
        if !name.contains('/')
            && (new_names.contains(name) || new_names.contains(&format!("{name}.md")))
        {
            return true;
        }
        let Some(source) = current_by_id.get(source_id) else {
            return false;
        };
        let reference = Reference {
            raw: raw.to_string(),
            syntax,
            start: 0,
            end: 0,
        };
        resolve_first_observation(&current_by_path, &current_links, &source.path, &reference)
            .is_some_and(|target| new_ids.contains(target.id.as_str()))
    };
    let mut affected_sources = manifest
        .bindings
        .iter()
        .filter(|binding| {
            moved_ids.contains(binding.target_id.as_str())
                || reference_may_match_new_name(
                    &binding.source_id,
                    &binding.reference,
                    binding.syntax,
                )
        })
        .map(|binding| binding.source_id.clone())
        .collect::<HashSet<_>>();
    let legacy_binding_sources = manifest
        .bindings
        .iter()
        .filter(|binding| {
            let Some(source) = current_by_id.get(binding.source_id.as_str()) else {
                return false;
            };
            if !current_by_id.contains_key(binding.target_id.as_str()) {
                return false;
            }
            let source_unchanged = old_by_id
                .get(binding.source_id.as_str())
                .is_some_and(|old| {
                    old.key == source.key
                        && old.size == source.size
                        && old.mtime_ns == source.mtime_ns
                });
            if !source_unchanged {
                return false;
            }
            let syntax = match binding.syntax {
                ReferenceSyntax::Wikilink | ReferenceSyntax::FrontmatterMedia => {
                    LinkSyntax::Obsidian
                }
                ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink => {
                    LinkSyntax::Markdown
                }
            };
            !matches!(
                current_links.resolve_strict(&source.path, &binding.reference, syntax),
                LinkResolution::Resolved(_)
            )
        })
        .map(|binding| binding.source_id.clone())
        .collect::<HashSet<_>>();
    affected_sources.extend(legacy_binding_sources.iter().cloned());
    affected_sources.extend(
        manifest
            .unresolved
            .iter()
            .filter(|reference| {
                reference_may_match_new_name(
                    &reference.source_id,
                    &reference.reference,
                    reference.syntax,
                )
            })
            .map(|reference| reference.source_id.clone()),
    );

    let mut pending = Grouped::new(
        std::mem::take(&mut manifest.pending_source_ids),
        String::as_str,
    );

    // Publish paths before changing documents. A crash leaves bindings that
    // can be replayed against the current source bytes on the next pass.
    for source in current_files
        .iter()
        .filter(|entry| entry.path.ends_with(".md"))
    {
        let unchanged = old_by_id.get(source.id.as_str()).is_some_and(|old| {
            old.size == source.size && old.mtime_ns == source.mtime_ns && old.path == source.path
        });
        if (!unchanged || affected_sources.contains(source.id.as_str()))
            && !pending.contains(&source.id)
        {
            pending.push(source.id.clone());
        }
    }
    moves.affected_markdown = current_files
        .iter()
        .filter(|entry| entry.path.ends_with(".md") && pending.contains(&entry.id))
        .map(|entry| entry.path.trim_end_matches(".md").to_string())
        .collect();
    // The references are regrouped only for a pass that has notes to read: a
    // pass over an unchanged space leaves them as they were read.
    let mut references_changed = false;
    if pending.list().next().is_some() {
        let mut bindings =
            Grouped::new(std::mem::take(&mut manifest.bindings), source_of_binding);
        let mut unresolved =
            Grouped::new(std::mem::take(&mut manifest.unresolved), source_of_unresolved);
        for (place, source) in current_files
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.path.ends_with(".md"))
        {
            if !pending.contains(&source.id) {
                continue;
            }
            let path = vault.root().join(&source.path);
            // A note iCloud keeps off this Mac is brought down by this read:
            // tests count it (`cloud_files::test_seam`).
            let content = match crate::storage::cloud_files::read_to_string(&path) {
                Ok(content) => content,
                // Its contents are in iCloud and the read may not bring them
                // down: not a note that cannot be read. It stays pending and
                // the pass that finds it here reads it (SPEC_CLOUD_STORAGE.md,
                // «Отказ чтения»).
                Err(error) if crate::storage::cloud_files::is_refusal(&error) => continue,
                Err(error) => {
                    moves.read_errors.push((path, error.to_string()));
                    continue;
                }
            };
            let source_bytes_unchanged = old_by_id.get(source.id.as_str()).is_some_and(|old| {
                old.size == source.size && old.mtime_ns == source.mtime_ns && old.key == source.key
            });
            let replay_source_unchanged =
                replay_pending.contains(source.id.as_str()) && source_bytes_unchanged;
            let references = references_in(&content);
            let mut edits = Vec::new();
            for reference in references {
                let names_reference = |raw: &str, syntax: ReferenceSyntax| {
                    raw == reference.raw && syntax == reference.syntax
                };
                let bound = bindings
                    .of(&source.id)
                    .find(|binding| names_reference(&binding.reference, binding.syntax))
                    .cloned();
                // A link that currently resolves is authoritative even when an
                // older binding says otherwise. History only repairs a missing
                // destination after a confirmed native move.
                let syntax = match reference.syntax {
                    ReferenceSyntax::Wikilink | ReferenceSyntax::FrontmatterMedia => {
                        LinkSyntax::Obsidian
                    }
                    ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink => {
                        LinkSyntax::Markdown
                    }
                };
                let current_resolution = current_links.resolve(&source.path, &reference.raw, syntax);
                let strict_resolution =
                    current_links.resolve_strict(&source.path, &reference.raw, syntax);
                let current_target = match &current_resolution {
                    LinkResolution::Resolved(path) => current_by_path.get(path.as_str()).copied(),
                    LinkResolution::Missing | LinkResolution::Ambiguous(_) => None,
                };
                let historic_moved = bound
                    .as_ref()
                    .and_then(|binding| current_by_id.get(binding.target_id.as_str()).copied())
                    .filter(|entry| {
                        moved_ids.contains(entry.id.as_str())
                            || replay_source_unchanged
                            || (legacy_binding_sources.contains(source.id.as_str())
                                && source_bytes_unchanged
                                && !matches!(&strict_resolution, LinkResolution::Resolved(_)))
                    });
                let current_exact = match &strict_resolution {
                    LinkResolution::Resolved(path) => current_by_path.get(path.as_str()).copied(),
                    LinkResolution::Missing | LinkResolution::Ambiguous(_) => None,
                };
                let target = current_exact.or(historic_moved).or(current_target);
                let Some(target) = target else {
                    let missing = Unresolved {
                        source_id: source.id.clone(),
                        reference: reference.raw.clone(),
                        syntax: reference.syntax,
                    };
                    if bound.is_none() && !unresolved.contains(&missing) {
                        unresolved.push(missing);
                    }
                    continue;
                };
                unresolved.retain_in(&source.id, |entry| {
                    !names_reference(&entry.reference, entry.syntax)
                });
                if bound
                    .as_ref()
                    .is_none_or(|binding| binding.target_id != target.id)
                {
                    bindings.retain_in(&source.id, |binding| {
                        !names_reference(&binding.reference, binding.syntax)
                    });
                    bindings.push(Binding {
                        source_id: source.id.clone(),
                        reference: reference.raw.clone(),
                        syntax: reference.syntax,
                        target_id: target.id.clone(),
                    });
                }
                let (old_target, _) = split_reference(&reference);
                let target_moved = moved_ids.contains(target.id.as_str());
                let source_moved = moved_ids.contains(source.id.as_str());
                let basename_ambiguous = !old_target.contains('/')
                    && files_named
                        .get(&Path::new(&target.path).file_name())
                        .is_some_and(|files| *files > 1);
                let stale_reference = !matches!(
                    &strict_resolution,
                    LinkResolution::Resolved(path) if path == &target.path
                );
                let relative_link = matches!(
                    reference.syntax,
                    ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
                );
                let new_target = if target_moved
                    || basename_ambiguous
                    || stale_reference
                    || (source_moved && relative_link)
                {
                    match reference.syntax {
                        ReferenceSyntax::Wikilink | ReferenceSyntax::FrontmatterMedia => {
                            display_target(&current_links, &target.path, !old_target.ends_with(".md"))
                        }
                        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink => {
                            let path = relative_from_source(&source.path, &target.path);
                            // `[text](Foo)` keeps naming its note without the extension.
                            match path.strip_suffix(".md") {
                                Some(stem) if !old_target.to_ascii_lowercase().ends_with(".md") => {
                                    stem.to_string()
                                }
                                _ => path,
                            }
                        }
                    }
                } else {
                    old_target.to_string()
                };
                if old_target != new_target {
                    let replacement = replacement_for(&reference, &new_target);
                    edits.push((reference.start, reference.end, replacement.clone()));
                    let rebound = bindings
                        .of(&source.id)
                        .find(|binding| names_reference(&binding.reference, binding.syntax))
                        .map(|binding| Binding {
                            source_id: binding.source_id.clone(),
                            reference: replacement,
                            syntax: binding.syntax,
                            target_id: binding.target_id.clone(),
                        });
                    if let Some(rebound) = rebound {
                        if !bindings.contains(&rebound) {
                            bindings.push(rebound);
                        }
                    }
                }
            }
            let mut revised = content.clone();
            edits.sort_by(|a, b| b.0.cmp(&a.0));
            for (start, end, replacement) in edits {
                revised.replace_range(start..end, &replacement);
            }
            if revised != content {
                files::validate_vault_write_target(vault, &path)?;
                manifest.pending_revisions.insert(
                    source.id.clone(),
                    crate::storage::save_operations::sha256_bytes(revised.as_bytes()),
                );
                // Persist both old and new bindings before source publication.
                if persist_history {
                    write_manifest(
                        vault,
                        &history_so_far(
                            &manifest,
                            &current_files,
                            &rewritten,
                            &bindings,
                            &unresolved,
                            &pending,
                        ),
                    )?;
                }
                files::write_atomically_if_unchanged(
                    &path,
                    content.as_bytes(),
                    revised.as_bytes(),
                    &vault.mine_dir().join("link-repair-conflicts"),
                )?;
                let key = key_for(&path)?;
                let metadata = std::fs::metadata(&path)?;
                let mtime_ns = metadata
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos();
                rewritten.push((place, key, metadata.len(), mtime_ns));
            }
            let live_references = references_in(&revised)
                .into_iter()
                .map(|reference| (reference.syntax, reference.raw))
                .collect::<Vec<_>>();
            bindings.retain_in(&source.id, |binding| {
                live_references
                    .iter()
                    .any(|(syntax, raw)| *syntax == binding.syntax && *raw == binding.reference)
            });
            unresolved.retain_in(&source.id, |entry| {
                live_references
                    .iter()
                    .any(|(syntax, raw)| *syntax == entry.syntax && *raw == entry.reference)
            });
            manifest.pending_revisions.remove(&source.id);
            pending.retain_in(&source.id, |_| false);
            if revised != content && persist_history {
                write_manifest(
                    vault,
                    &history_so_far(
                        &manifest,
                        &current_files,
                        &rewritten,
                        &bindings,
                        &unresolved,
                        &pending,
                    ),
                )?;
            }
        }
        references_changed = !bindings.unchanged() || !unresolved.unchanged();
        manifest.bindings = bindings.into_vec();
        manifest.unresolved = unresolved.into_vec();
    }
    apply_rewritten(&mut current_files, &rewritten);
    let changed = current_files != old_files
        || manifest.pending_revisions != old_revisions
        || references_changed
        || !pending.unchanged();
    if changed && persist_history {
        manifest.files = current_files;
        manifest.pending_source_ids = pending.into_vec();
        write_manifest(vault, &manifest)?;
    }
    Ok(moves)
}

fn resolve_first_observation<'a>(
    files_by_path: &HashMap<&str, &'a FileEntry>,
    index: &LinkIndex,
    source: &str,
    reference: &Reference,
) -> Option<&'a FileEntry> {
    let syntax = match reference.syntax {
        ReferenceSyntax::Wikilink | ReferenceSyntax::FrontmatterMedia => LinkSyntax::Obsidian,
        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink => LinkSyntax::Markdown,
    };
    match index.resolve(source, &reference.raw, syntax) {
        LinkResolution::Resolved(path) => files_by_path.get(path.as_str()).copied(),
        LinkResolution::Missing | LinkResolution::Ambiguous(_) => None,
    }
}

fn display_target(index: &LinkIndex, path: &str, omit_markdown_extension: bool) -> String {
    index
        .shortest_link(path, omit_markdown_extension)
        .unwrap_or_else(|| path.to_string())
}

fn relative_from_source(source: &str, target: &str) -> String {
    mine_core::links::relative_markdown_path(source, target)
}

/// Resolve an established source link by durable target identity. `Some(None)`
/// means a binding exists but its target is absent; callers must not fall back
/// to another file at the old path.
#[cfg(test)]
pub fn bound_target(
    vault: &VaultLayout,
    source_slug: &str,
    reference: &str,
) -> Result<Option<Option<PathBuf>>> {
    bound_target_kind(vault, source_slug, reference, ReferenceSyntax::Wikilink)
}

/// Resolve a source frontmatter media field by its established binding.
#[cfg(test)]
pub fn bound_frontmatter_target(
    vault: &VaultLayout,
    source_slug: &str,
    reference: &str,
) -> Result<Option<Option<PathBuf>>> {
    bound_target_kind(
        vault,
        source_slug,
        reference,
        ReferenceSyntax::FrontmatterMedia,
    )
}

/// Indexed fields can aggregate several source syntaxes. A conflicting raw
/// spelling has no safe single target until the caller supplies its context.
#[cfg(test)]
pub fn bound_any_target(
    vault: &VaultLayout,
    source_slug: &str,
    reference: &str,
) -> Result<Option<Option<PathBuf>>> {
    let manifest = cached_manifest(vault)?;
    let source_path = format!("{source_slug}.md");
    let Some(source) = manifest
        .files
        .iter()
        .find(|entry| entry.path == source_path)
    else {
        return Ok(None);
    };
    let targets = manifest
        .bindings
        .iter()
        .filter(|binding| {
            binding.source_id == source.id
                && (binding.reference == reference
                    || binding.reference.split(['|', '#', '?']).next() == Some(reference))
        })
        .map(|binding| binding.target_id.as_str())
        .collect::<BTreeSet<_>>();
    if targets.is_empty() {
        return Ok(None);
    }
    if targets.len() > 1 {
        return Ok(Some(None));
    }
    let Some(target_id) = targets.iter().next() else {
        return Ok(None);
    };
    Ok(Some(
        manifest
            .files
            .iter()
            .find(|entry| entry.id == *target_id)
            .map(|entry| vault.root().join(&entry.path)),
    ))
}

/// Resolve a bound relative Markdown image independently of a wikilink with
/// the same text in the same source note.
#[cfg(test)]
pub fn bound_markdown_target(
    vault: &VaultLayout,
    source_slug: &str,
    reference: &str,
) -> Result<Option<Option<PathBuf>>> {
    bound_target_kind(
        vault,
        source_slug,
        reference,
        ReferenceSyntax::MarkdownImage,
    )
}

#[cfg(test)]
fn bound_target_kind(
    vault: &VaultLayout,
    source_slug: &str,
    reference: &str,
    syntax: ReferenceSyntax,
) -> Result<Option<Option<PathBuf>>> {
    let manifest = cached_manifest(vault)?;
    let source_path = format!("{source_slug}.md");
    let Some(source) = manifest
        .files
        .iter()
        .find(|entry| entry.path == source_path)
    else {
        return Ok(None);
    };
    let Some(binding) = manifest.bindings.iter().find(|binding| {
        binding.source_id == source.id
            && binding.syntax == syntax
            && (binding.reference == reference
                || binding.reference.split(['|', '#', '?']).next() == Some(reference))
    }) else {
        return Ok(None);
    };
    Ok(Some(
        manifest
            .files
            .iter()
            .find(|entry| entry.id == binding.target_id)
            .map(|entry| vault.root().join(&entry.path)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_pass_does_not_republish_source_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        for number in 0..12 {
            std::fs::write(
                directory.path().join(format!("Note {number}.md")),
                "A note.",
            )
            .unwrap();
        }
        reconcile(&vault).unwrap();
        let path = manifest_path(&vault);
        let before = std::fs::metadata(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
    }

    #[test]
    fn two_identical_media_files_keep_distinct_identities_after_moves() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::create_dir_all(directory.path().join("A")).unwrap();
        std::fs::create_dir_all(directory.path().join("B")).unwrap();
        std::fs::write(directory.path().join("A/same.jpg"), b"same bytes").unwrap();
        std::fs::write(directory.path().join("B/same.jpg"), b"same bytes").unwrap();
        std::fs::write(
            directory.path().join("A/Card.md"),
            "---\nfile: \"[[A/same.jpg]]\"\n---\n",
        )
        .unwrap();
        reconcile(&vault).unwrap();
        std::fs::create_dir_all(directory.path().join("Moved")).unwrap();
        std::fs::rename(
            directory.path().join("A/same.jpg"),
            directory.path().join("Moved/original.jpg"),
        )
        .unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(
            bound_frontmatter_target(&vault, "A/Card", "original.jpg").unwrap(),
            Some(Some(directory.path().join("Moved/original.jpg")))
        );
    }

    #[test]
    fn delayed_media_is_enrolled_without_reopening_unchanged_note() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::write(
            directory.path().join("Card.md"),
            "---\nfile: \"[[later.jpg]]\"\n---\n",
        )
        .unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(read_manifest(&vault).unwrap().unresolved.len(), 1);
        std::fs::write(directory.path().join("later.jpg"), b"original").unwrap();
        reconcile(&vault).unwrap();
        std::fs::create_dir_all(directory.path().join("Moved")).unwrap();
        let moved = directory.path().join("Moved/renamed.jpg");
        std::fs::rename(directory.path().join("later.jpg"), &moved).unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(
            bound_frontmatter_target(&vault, "Card", "renamed.jpg").unwrap(),
            Some(Some(moved))
        );
    }

    #[test]
    fn replays_after_manifest_publication_before_source_rewrite() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::write(
            directory.path().join("Card.md"),
            "---\nfile: \"[[photo.jpg]]\"\n---\n",
        )
        .unwrap();
        std::fs::write(directory.path().join("photo.jpg"), b"original").unwrap();
        reconcile(&vault).unwrap();
        std::fs::create_dir_all(directory.path().join("Moved")).unwrap();
        let moved = directory.path().join("Moved/renamed.jpg");
        std::fs::rename(directory.path().join("photo.jpg"), &moved).unwrap();
        let mut manifest = read_manifest(&vault).unwrap();
        let source_id = manifest
            .files
            .iter()
            .find(|entry| entry.path == "Card.md")
            .unwrap()
            .id
            .clone();
        let media = manifest
            .files
            .iter_mut()
            .find(|entry| entry.path == "photo.jpg")
            .unwrap();
        media.path = "Moved/renamed.jpg".into();
        media.key = key_for(&moved).unwrap();
        manifest.pending_source_ids.push(source_id);
        write_manifest(&vault, &manifest).unwrap();

        reconcile(&vault).unwrap();
        assert!(std::fs::read_to_string(directory.path().join("Card.md"))
            .unwrap()
            .contains("[[renamed.jpg]]"));
        assert_eq!(
            bound_frontmatter_target(&vault, "Card", "renamed.jpg").unwrap(),
            Some(Some(moved))
        );
    }

    #[test]
    fn replays_after_source_rewrite_before_manifest_key_update() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        let source = directory.path().join("Card.md");
        std::fs::write(&source, "---\nfile: \"[[photo.jpg]]\"\n---\n").unwrap();
        std::fs::write(directory.path().join("photo.jpg"), b"original").unwrap();
        reconcile(&vault).unwrap();
        std::fs::create_dir_all(directory.path().join("Moved")).unwrap();
        let moved = directory.path().join("Moved/renamed.jpg");
        std::fs::rename(directory.path().join("photo.jpg"), &moved).unwrap();
        let mut manifest = read_manifest(&vault).unwrap();
        let source_id = manifest
            .files
            .iter()
            .find(|entry| entry.path == "Card.md")
            .unwrap()
            .id
            .clone();
        let media = manifest
            .files
            .iter_mut()
            .find(|entry| entry.path == "photo.jpg")
            .unwrap();
        media.path = "Moved/renamed.jpg".into();
        media.key = key_for(&moved).unwrap();
        let revised = "---\nfile: \"[[renamed.jpg]]\"\n---\n";
        manifest.pending_source_ids.push(source_id.clone());
        manifest.pending_revisions.insert(
            source_id.clone(),
            crate::storage::save_operations::sha256_bytes(revised.as_bytes()),
        );
        let target_id = manifest.bindings[0].target_id.clone();
        manifest.bindings.push(Binding {
            source_id: source_id.clone(),
            reference: "renamed.jpg".into(),
            syntax: ReferenceSyntax::FrontmatterMedia,
            target_id,
        });
        write_manifest(&vault, &manifest).unwrap();
        files::write_atomically(&source, revised.as_bytes()).unwrap();

        reconcile(&vault).unwrap();
        let recovered = read_manifest(&vault).unwrap();
        assert_eq!(
            recovered
                .files
                .iter()
                .find(|entry| entry.path == "Card.md")
                .unwrap()
                .id,
            source_id
        );
        assert!(recovered.pending_revisions.is_empty());
        assert_eq!(
            bound_frontmatter_target(&vault, "Card", "renamed.jpg").unwrap(),
            Some(Some(moved))
        );
    }

    #[test]
    fn enrollment_rejects_unreadable_required_markdown() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        let source = directory.path().join("Card.md");
        std::fs::write(&source, [0xff, 0xfe]).unwrap();
        assert!(enroll_capture(&vault, &source).is_err());
    }

    #[test]
    fn parent_relative_markdown_attachment_survives_independent_moves() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::create_dir_all(directory.path().join("Cards")).unwrap();
        std::fs::create_dir_all(directory.path().join("Media")).unwrap();
        std::fs::write(
            directory.path().join("Cards/Note.md"),
            "![photo](../Media/photo.jpg)",
        )
        .unwrap();
        std::fs::write(directory.path().join("Media/photo.jpg"), b"original").unwrap();
        reconcile(&vault).unwrap();
        std::fs::create_dir_all(directory.path().join("Archive")).unwrap();
        std::fs::create_dir_all(directory.path().join("Moved")).unwrap();
        std::fs::rename(
            directory.path().join("Cards/Note.md"),
            directory.path().join("Archive/Note.md"),
        )
        .unwrap();
        let moved = directory.path().join("Moved/renamed.jpg");
        std::fs::rename(directory.path().join("Media/photo.jpg"), &moved).unwrap();
        reconcile(&vault).unwrap();
        let source = std::fs::read_to_string(directory.path().join("Archive/Note.md")).unwrap();
        assert_eq!(source, "![photo](../Moved/renamed.jpg)");
        assert_eq!(
            bound_markdown_target(&vault, "Archive/Note", "../Moved/renamed.jpg").unwrap(),
            Some(Some(moved))
        );
    }

    #[test]
    fn delayed_parent_relative_attachment_is_bound_when_it_arrives() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::create_dir_all(directory.path().join("Cards")).unwrap();
        std::fs::create_dir_all(directory.path().join("Media")).unwrap();
        std::fs::write(
            directory.path().join("Cards/Note.md"),
            "![photo](../Media/later%20photo.jpg)",
        )
        .unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(read_manifest(&vault).unwrap().unresolved.len(), 1);
        std::fs::write(directory.path().join("Media/later photo.jpg"), b"original").unwrap();
        reconcile(&vault).unwrap();
        let moved = directory.path().join("Media/renamed.jpg");
        std::fs::rename(directory.path().join("Media/later photo.jpg"), &moved).unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(
            bound_markdown_target(&vault, "Cards/Note", "../Media/renamed.jpg").unwrap(),
            Some(Some(moved))
        );
    }

    #[test]
    fn stale_history_cannot_disambiguate_a_current_bare_link() {
        use crate::domain::block::{InlineMediaReference, InlineMediaSyntax};
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::create_dir_all(directory.path().join("A")).unwrap();
        std::fs::create_dir_all(directory.path().join("B")).unwrap();
        let source = directory.path().join("A/Card.md");
        let a = directory.path().join("A/photo.jpg");
        let b = directory.path().join("B/photo.jpg");
        std::fs::write(&source, "---\nfile: \"[[photo.jpg]]\"\n---\n![[photo.jpg]]").unwrap();
        std::fs::write(&a, b"frontmatter").unwrap();
        std::fs::write(&b, b"body").unwrap();
        reconcile(&vault).unwrap();
        let mut manifest = read_manifest(&vault).unwrap();
        let source_id = manifest
            .files
            .iter()
            .find(|entry| entry.path == "A/Card.md")
            .unwrap()
            .id
            .clone();
        let a_id = manifest
            .files
            .iter()
            .find(|entry| entry.path == "A/photo.jpg")
            .unwrap()
            .id
            .clone();
        let b_id = manifest
            .files
            .iter()
            .find(|entry| entry.path == "B/photo.jpg")
            .unwrap()
            .id
            .clone();
        manifest.bindings.push(Binding {
            source_id: source_id.clone(),
            reference: "photo.jpg".into(),
            syntax: ReferenceSyntax::FrontmatterMedia,
            target_id: a_id,
        });
        manifest.bindings.push(Binding {
            source_id,
            reference: "photo.jpg".into(),
            syntax: ReferenceSyntax::Wikilink,
            target_id: b_id,
        });
        write_manifest(&vault, &manifest).unwrap();
        assert_eq!(
            crate::storage::media_refs::resolve_frontmatter_media(&vault, "A/Card", "photo.jpg"),
            None
        );
        assert_eq!(
            crate::storage::media_refs::resolve_inline_media(
                &vault,
                "A/Card",
                &InlineMediaReference {
                    source: "photo.jpg".into(),
                    syntax: InlineMediaSyntax::ObsidianEmbed,
                }
            ),
            None
        );
        assert_eq!(
            crate::storage::media_refs::resolve_indexed_media(&vault, "A/Card", "photo.jpg"),
            None
        );
        assert_eq!(
            crate::storage::media_refs::resolve_frontmatter_media(&vault, "A/Card", "A/photo.jpg"),
            Some(a)
        );
        assert_eq!(
            crate::storage::media_refs::resolve_frontmatter_media(&vault, "A/Card", "B/photo.jpg"),
            Some(b)
        );
        reconcile(&vault).unwrap();
        let rewritten = std::fs::read_to_string(&source).unwrap();
        assert!(rewritten.contains("file: \"[[A/photo.jpg]]\""));
        assert!(rewritten.contains("![[B/photo.jpg]]"));
    }

    /// The history `vault` uses now, as JSON with every file key of another
    /// Mac: the device and inode of the same files there differ.
    fn history_of_another_mac(vault: &VaultLayout) -> Vec<u8> {
        let mut theirs = read_manifest(vault).unwrap();
        assert!(!theirs.files.is_empty());
        for entry in &mut theirs.files {
            entry.key.device = entry.key.device.wrapping_add(7);
            entry.key.inode = entry.key.inode.wrapping_add(1_000_003);
        }
        serde_json::to_vec_pretty(&theirs).unwrap()
    }

    fn space_with_a_picture() -> (tempfile::TempDir, tempfile::TempDir, VaultLayout) {
        let directory = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(
            directory.path().to_path_buf(),
            derived.path().to_path_buf(),
        );
        std::fs::write(directory.path().join("Card.md"), "---\nfile: \"[[photo.jpg]]\"\n---\n![[photo.jpg]]").unwrap();
        std::fs::write(directory.path().join("photo.jpg"), b"picture").unwrap();
        std::fs::write(directory.path().join("Plain.md"), "Nothing linked.").unwrap();
        (directory, derived, vault)
    }

    /// Е5.7: the history keys files by device and inode, which only this
    /// Mac knows. Kept in the space, it synced to another Mac, whose every
    /// file then looked new: each pass there reread and reindexed the notes
    /// and wrote its own keys back, and this Mac did the same in turn.
    #[test]
    fn a_history_another_mac_wrote_into_the_space_changes_nothing_here() {
        let (_directory, _derived, vault) = space_with_a_picture();
        reconcile(&vault).unwrap();
        let theirs = history_of_another_mac(&vault);
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        std::fs::write(vault.mine_dir().join(MANIFEST_NAME), &theirs).unwrap();

        let refresh = reconcile(&vault).unwrap();

        assert!(refresh.affected_markdown.is_empty(), "{:?}", refresh.affected_markdown);
        assert!(refresh.moved_markdown.is_empty());
        assert_eq!(std::fs::read(vault.mine_dir().join(MANIFEST_NAME)).unwrap(), theirs);
    }

    /// Е5.7: a history an earlier Mine left in the space, with the keys of
    /// whichever Mac wrote it, is taken over by path once: the files are
    /// where it says, so nothing is new and nothing is reread.
    #[test]
    fn a_history_left_in_the_space_is_taken_over_by_path() {
        let (directory, _derived, vault) = space_with_a_picture();
        let in_space = VaultLayout::new(directory.path().to_path_buf());
        reconcile(&in_space).unwrap();
        let theirs = history_of_another_mac(&in_space);
        std::fs::write(in_space.mine_dir().join(MANIFEST_NAME), &theirs).unwrap();

        let refresh = reconcile(&vault).unwrap();

        assert!(refresh.affected_markdown.is_empty(), "{:?}", refresh.affected_markdown);
        let ids = |manifest: &Manifest| -> Vec<(String, String)> {
            let mut ids: Vec<_> = manifest
                .files
                .iter()
                .map(|entry| (entry.path.clone(), entry.id.clone()))
                .collect();
            ids.sort();
            ids
        };
        let adopted: Manifest = serde_json::from_slice(&theirs).unwrap();
        assert_eq!(ids(&read_manifest(&vault).unwrap()), ids(&adopted));
    }

    /// Е5.8: a history that cannot be read is said in the log, with its
    /// cause, not only on standard error.
    #[test]
    fn a_history_that_cannot_be_read_is_logged() {
        let capture = crate::test_log::capture();
        let (directory, derived, vault) = space_with_a_picture();
        // A folder where the history goes, wherever it is kept.
        std::fs::create_dir_all(directory.path().join(".mine").join(MANIFEST_NAME)).unwrap();
        std::fs::create_dir_all(derived.path().join(MANIFEST_NAME)).unwrap();

        let refresh = reconcile(&vault).unwrap();

        assert!(refresh.moved_markdown.is_empty());
        let warnings = capture.warnings();
        assert!(
            warnings.iter().any(|line| line.contains("file identity history")),
            "{warnings:?}"
        );
    }

    #[test]
    fn root_exact_note_link_outvotes_a_moved_stale_binding() {
        let directory = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(directory.path().to_path_buf());
        std::fs::create_dir_all(directory.path().join("Nested")).unwrap();
        std::fs::write(directory.path().join("Design.md"), "---\ntype: article\n---\nroot").unwrap();
        std::fs::write(directory.path().join("Nested/Design.md"), "---\ntype: article\n---\nnested").unwrap();
        let source = directory.path().join("Card.md");
        std::fs::write(&source, "---\ntype: article\n---\n[[Design]]").unwrap();
        reconcile(&vault).unwrap();
        let mut manifest = read_manifest(&vault).unwrap();
        let source_id = manifest.files.iter().find(|entry| entry.path == "Card.md").unwrap().id.clone();
        let nested_id = manifest.files.iter().find(|entry| entry.path == "Nested/Design.md").unwrap().id.clone();
        manifest.bindings.retain(|binding| !(binding.source_id == source_id && binding.reference == "Design"));
        manifest.bindings.push(Binding { source_id, reference: "Design".into(), syntax: ReferenceSyntax::Wikilink, target_id: nested_id });
        write_manifest(&vault, &manifest).unwrap();
        std::fs::rename(directory.path().join("Nested/Design.md"), directory.path().join("Nested/Renamed.md")).unwrap();
        reconcile(&vault).unwrap();
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "---\ntype: article\n---\n[[Design]]");
    }

    /// The folders of the root are listed side by side, more of them than
    /// lists: every file of the space is found once, by its path from the
    /// root, and what does not belong to the space is left out.
    #[test]
    fn the_files_of_many_folders_are_all_listed_once() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut expected = vec!["Root note.md".to_string()];
        std::fs::write(root.join("Root note.md"), "A note.").unwrap();
        for folder in 0..INVENTORY_LISTS * 2 + 1 {
            std::fs::create_dir_all(root.join(format!("Folder {folder}/Deeper"))).unwrap();
            for file in 0..3 {
                for path in [
                    format!("Folder {folder}/Note {file}.md"),
                    format!("Folder {folder}/Deeper/Picture {file}.jpg"),
                ] {
                    std::fs::write(root.join(&path), "bytes").unwrap();
                    expected.push(path);
                }
            }
        }
        std::fs::create_dir_all(root.join(".mine")).unwrap();
        std::fs::write(root.join(".mine/layout.json"), "{}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("Root note.md"), root.join("Folder 0/Link.md")).unwrap();
        expected.sort();

        let mut listed = inventory_space(root).unwrap();
        listed.sort_by(|a, b| a.path.cmp(&b.path));

        assert_eq!(
            listed.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
            expected
        );
        for entry in &listed {
            let path = root.join(&entry.path);
            assert_eq!(entry.key, key_for(&path).unwrap(), "{}", entry.path);
            assert_eq!(entry.size, std::fs::metadata(&path).unwrap().len(), "{}", entry.path);
        }
    }

    /// The set of the reconcile's limits (AUDIT_PERFORMANCE.md, Б4): 10 000
    /// notes of about 3 KB of prose, 30 MB in all, in the layout of three
    /// folders. Half are picture cards with a file of their own, a quarter
    /// links with a thumbnail, the rest articles, every third of them with a
    /// picture in its text; a note is in up to three of 100 collections.
    const TIMED_NOTES: usize = 10_000;
    const TIMED_COLLECTIONS: usize = 100;
    const TIMED_NOTE_PROSE_BYTES: usize = 3_000;
    /// Reconciles of the unchanged space timed; the limit holds for their
    /// median. A reconcile lists the folders of the space on threads of its
    /// own, and on a machine busy with other work one of five may wait for a
    /// core: the slowest of them times the machine, the median the reconcile.
    const TIMED_REPEATS: usize = 5;
    const FIRST_RECONCILE_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);
    const REPEATED_RECONCILE_LIMIT: std::time::Duration = std::time::Duration::from_millis(100);

    /// Writes the timed set under `root`; returns its files and its
    /// references.
    fn write_timed_space(root: &Path) -> (usize, usize) {
        for folder in ["Collections", "Cards", "Media"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        for collection in 0..TIMED_COLLECTIONS {
            std::fs::write(
                root.join(format!("Collections/Collection {collection:03}.md")),
                "---\ntype: channel\n---\n",
            )
            .unwrap();
        }
        let sentence = "Город стоит на реке, и дома вдоль набережной смотрят в воду. A plain sentence of prose follows it. ";
        let prose = sentence.repeat(TIMED_NOTE_PROSE_BYTES / sentence.len());
        let (mut files, mut references) = (TIMED_COLLECTIONS, 0);
        for note in 0..TIMED_NOTES {
            let mut front = String::from("---\n");
            let mut body = format!("# Note {note:05}\n\n");
            match note % 4 {
                0 | 1 => {
                    std::fs::write(root.join(format!("Media/picture-{note:05}.jpg")), b"picture").unwrap();
                    front.push_str(&format!("type: image\nfile: \"[[picture-{note:05}.jpg]]\"\n"));
                    files += 1;
                    references += 1;
                }
                2 => {
                    std::fs::write(root.join(format!("Media/thumbnail-{note:05}.png")), b"thumbnail").unwrap();
                    front.push_str(&format!("type: link\nthumbnail: \"[[thumbnail-{note:05}.png]]\"\n"));
                    files += 1;
                    references += 1;
                }
                _ => {
                    front.push_str("type: article\n");
                    if note % 3 == 0 {
                        std::fs::write(root.join(format!("Media/inline-{note:05}.jpg")), b"inline").unwrap();
                        body.push_str(&format!("![[inline-{note:05}.jpg]]\n\n"));
                        files += 1;
                        references += 1;
                    }
                }
            }
            let collections = note % 4;
            if collections > 0 {
                front.push_str("Mine Collections:\n");
                for offset in 0..collections {
                    front.push_str(&format!(
                        "  - \"[[Collection {:03}]]\"\n",
                        (note * 7 + offset * 31) % TIMED_COLLECTIONS
                    ));
                }
                references += collections;
            }
            front.push_str("---\n");
            std::fs::write(
                root.join(format!("Cards/Note {note:05}.md")),
                format!("{front}{body}{prose}\n"),
            )
            .unwrap();
            files += 1;
        }
        (files, references)
    }

    /// Б4: the first reconcile of a large space, which reads every note and
    /// binds every reference, answers within `FIRST_RECONCILE_LIMIT`, and a
    /// reconcile of the unchanged space within `REPEATED_RECONCILE_LIMIT`.
    /// The limits are an optimised build's: a speed test, run by
    /// `test:rust-speed` alone (ARCHITECTURE.md, «Тесты скорости Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_reconcile_of_10_000_notes_answers_within_its_limit() {
        let (directory, derived) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let vault = VaultLayout::with_derived_root(
            directory.path().to_path_buf(),
            derived.path().to_path_buf(),
        );
        let (files, references) = write_timed_space(directory.path());

        let started = std::time::Instant::now();
        let refresh = reconcile_locked(&vault).unwrap();
        let first = started.elapsed();
        assert!(refresh.read_errors.is_empty());
        assert_eq!(refresh.affected_markdown.len(), TIMED_NOTES + TIMED_COLLECTIONS);
        let history = std::fs::read(manifest_path(&vault)).unwrap();
        let manifest = read_manifest(&vault).unwrap();
        assert_eq!(manifest.files.len(), files);
        assert_eq!(manifest.bindings.len(), references);
        assert!(manifest.unresolved.is_empty() && manifest.pending_source_ids.is_empty());

        let mut repeats = Vec::with_capacity(TIMED_REPEATS);
        for _ in 0..TIMED_REPEATS {
            let started = std::time::Instant::now();
            let refresh = reconcile_locked(&vault).unwrap();
            repeats.push(started.elapsed());
            assert!(refresh.affected_markdown.is_empty() && refresh.moved_markdown.is_empty());
        }
        assert_eq!(std::fs::read(manifest_path(&vault)).unwrap(), history);
        repeats.sort();
        let (median, slowest) = (repeats[TIMED_REPEATS / 2], repeats[TIMED_REPEATS - 1]);
        eprintln!(
            "file identity reconcile, {TIMED_NOTES} notes, {files} files, {references} references, history {} B: first {first:?}, limit {FIRST_RECONCILE_LIMIT:?}; repeated: median {median:?}, slowest {slowest:?}, limit {REPEATED_RECONCILE_LIMIT:?}, asserted",
            history.len(),
        );
        assert!(first <= FIRST_RECONCILE_LIMIT, "first reconcile {first:?} over {FIRST_RECONCILE_LIMIT:?}");
        assert!(
            median <= REPEATED_RECONCILE_LIMIT,
            "repeated reconcile {median:?} over {REPEATED_RECONCILE_LIMIT:?} (slowest {slowest:?})"
        );
    }
}
