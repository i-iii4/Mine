//! Source-owned file identities and reference bindings for within-vault moves.
//!
//! The manifest lives in `.mine`, alongside the vault ID. SQLite may be
//! discarded without losing the identity or the target of an established link.

use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
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

fn manifest_path(vault: &VaultLayout) -> PathBuf {
    vault.mine_dir().join(MANIFEST_NAME)
}

fn read_manifest(vault: &VaultLayout) -> Result<Manifest> {
    let path = manifest_path(vault);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Manifest::default())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let manifest: Manifest =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    anyhow::ensure!(
        manifest.version == MANIFEST_VERSION,
        "unsupported file identity version"
    );
    Ok(manifest)
}

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
    let path = manifest_path(vault);
    files::validate_vault_write_target(vault, &path)?;
    std::fs::create_dir_all(vault.mine_dir())?;
    files::write_atomically(&path, &serde_json::to_vec_pretty(manifest)?)
}

#[cfg(unix)]
fn key_for(path: &Path) -> Result<FileKey> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path)?;
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
fn key_for(_path: &Path) -> Result<FileKey> {
    anyhow::bail!("native filesystem identity is unavailable on this platform")
}

fn inventory(dir: &Path, root: &Path, output: &mut Vec<FileEntry>) -> Result<()> {
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
            inventory(&path, root, output)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            let metadata = std::fs::metadata(&path)?;
            let mtime_ns = metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos();
            output.push(FileEntry {
                id: String::new(),
                path: relative,
                key: key_for(&path)?,
                size: metadata.len(),
                mtime_ns,
            });
        }
    }
    Ok(())
}

fn new_id() -> Result<String> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Reconcile the source manifest, then update established Markdown links whose
/// targets moved. An ambiguous first observation remains unbound.
pub fn reconcile(vault: &VaultLayout) -> Result<IdentityRefresh> {
    let lock_path = vault.mine_dir().join("file-identity.lock");
    files::validate_vault_write_target(vault, &lock_path)?;
    std::fs::create_dir_all(vault.mine_dir())?;
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
pub fn enroll_capture(vault: &VaultLayout, required_markdown: &Path) -> Result<()> {
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

fn reconcile_locked(vault: &VaultLayout) -> Result<IdentityRefresh> {
    let mut manifest = read_manifest(vault)?;
    let original = manifest.clone();
    let mut observed = Vec::new();
    inventory(vault.root(), vault.root(), &mut observed)?;
    observed.sort_by(|a, b| a.path.cmp(&b.path));

    let old_files = manifest.files.clone();
    let mut by_key = BTreeMap::<(u64, u64, u128), Vec<&FileEntry>>::new();
    let mut by_path = BTreeMap::<&str, &FileEntry>::new();
    for entry in &old_files {
        by_key
            .entry((entry.key.device, entry.key.inode, entry.key.created_ns))
            .or_default()
            .push(entry);
        by_path.insert(&entry.path, entry);
    }
    let mut claimed = BTreeSet::new();
    let observed_keys = observed
        .iter()
        .map(|entry| (entry.key.device, entry.key.inode, entry.key.created_ns))
        .collect::<BTreeSet<_>>();
    let mut next = Vec::with_capacity(observed.len());
    let mut moves = IdentityRefresh::default();
    for mut current in observed {
        let path = current.path.clone();
        let key = current.key.clone();
        let exact = by_key.get(&(key.device, key.inode, key.created_ns));
        let previous = match exact.map(Vec::as_slice) {
            Some([entry]) => Some(*entry),
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
    manifest.files = next;
    let old_by_id = old_files
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let current_files = manifest.files.clone();
    let current_by_id = current_files
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let moved_ids = manifest
        .files
        .iter()
        .filter(|entry| {
            old_by_id
                .get(entry.id.as_str())
                .is_some_and(|old| old.path != entry.path)
        })
        .map(|entry| entry.id.clone())
        .collect::<BTreeSet<_>>();
    let new_ids = manifest
        .files
        .iter()
        .filter(|entry| !old_by_id.contains_key(entry.id.as_str()))
        .map(|entry| entry.id.as_str())
        .collect::<BTreeSet<_>>();
    let new_names = manifest
        .files
        .iter()
        .filter(|entry| new_ids.contains(entry.id.as_str()))
        .filter_map(|entry| {
            Path::new(&entry.path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .collect::<BTreeSet<_>>();
    let reference_may_match_new_name = |source_id: &str, raw: &str, syntax: ReferenceSyntax| {
        if new_names.iter().any(|name| {
            let raw = raw.split(['|', '#', '?']).next().unwrap_or("");
            !raw.contains('/') && (raw == name || format!("{raw}.md") == *name)
        }) {
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
        resolve_first_observation(&manifest.files, &source.path, &reference)
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
        .collect::<BTreeSet<_>>();
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

    // Publish paths before changing documents. A crash leaves bindings that
    // can be replayed against the current source bytes on the next pass.
    for source in manifest
        .files
        .iter()
        .filter(|entry| entry.path.ends_with(".md"))
    {
        let unchanged = old_by_id.get(source.id.as_str()).is_some_and(|old| {
            old.size == source.size && old.mtime_ns == source.mtime_ns && old.path == source.path
        });
        if (!unchanged || affected_sources.contains(source.id.as_str()))
            && !manifest.pending_source_ids.contains(&source.id)
        {
            manifest.pending_source_ids.push(source.id.clone());
        }
    }
    moves.affected_markdown = manifest
        .files
        .iter()
        .filter(|entry| {
            manifest.pending_source_ids.contains(&entry.id) && entry.path.ends_with(".md")
        })
        .map(|entry| entry.path.trim_end_matches(".md").to_string())
        .collect();
    for source in manifest
        .files
        .clone()
        .into_iter()
        .filter(|entry| entry.path.ends_with(".md"))
    {
        if !manifest.pending_source_ids.contains(&source.id) {
            continue;
        }
        let path = vault.root().join(&source.path);
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) => {
                moves.read_errors.push((path, error.to_string()));
                continue;
            }
        };
        let references = references_in(&content);
        let mut edits = Vec::new();
        for reference in references {
            let bound = manifest
                .bindings
                .iter()
                .find(|binding| {
                    binding.source_id == source.id
                        && binding.reference == reference.raw
                        && binding.syntax == reference.syntax
                })
                .cloned();
            let target = bound
                .as_ref()
                .and_then(|binding| {
                    manifest
                        .files
                        .iter()
                        .find(|entry| entry.id == binding.target_id)
                })
                .or_else(|| {
                    if bound.is_some() {
                        None
                    } else {
                        resolve_first_observation(&manifest.files, &source.path, &reference)
                    }
                });
            let Some(target) = target else {
                let unresolved = Unresolved {
                    source_id: source.id.clone(),
                    reference: reference.raw.clone(),
                    syntax: reference.syntax,
                };
                if bound.is_none() && !manifest.unresolved.contains(&unresolved) {
                    manifest.unresolved.push(unresolved);
                }
                continue;
            };
            manifest.unresolved.retain(|entry| {
                !(entry.source_id == source.id
                    && entry.reference == reference.raw
                    && entry.syntax == reference.syntax)
            });
            if bound.is_none() {
                manifest.bindings.push(Binding {
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
                && current_by_id
                    .values()
                    .filter(|entry| {
                        Path::new(&entry.path).file_name() == Path::new(&target.path).file_name()
                    })
                    .count()
                    > 1;
            let stale_reference = bound.is_some()
                && !reference_points_to(&manifest.files, &source.path, &reference, &target.path);
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
                        display_target(&manifest.files, &target.path, !old_target.ends_with(".md"))
                    }
                    ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink => {
                        relative_from_source(&source.path, &target.path)
                    }
                }
            } else {
                old_target.to_string()
            };
            if old_target != new_target {
                let replacement = replacement_for(&reference, &new_target);
                edits.push((reference.start, reference.end, replacement.clone()));
                if let Some(binding) = manifest.bindings.iter_mut().find(|binding| {
                    binding.source_id == source.id
                        && binding.reference == reference.raw
                        && binding.syntax == reference.syntax
                }) {
                    let new_binding = Binding {
                        source_id: binding.source_id.clone(),
                        reference: replacement,
                        syntax: binding.syntax,
                        target_id: binding.target_id.clone(),
                    };
                    if !manifest.bindings.contains(&new_binding) {
                        manifest.bindings.push(new_binding);
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
            anyhow::ensure!(
                std::fs::read_to_string(&path)? == content,
                "source changed during identity rewrite: {}",
                path.display()
            );
            manifest.pending_revisions.insert(
                source.id.clone(),
                crate::storage::save_operations::sha256_bytes(revised.as_bytes()),
            );
            // Persist both old and new bindings before source publication.
            write_manifest(vault, &manifest)?;
            files::write_atomically(&path, revised.as_bytes())?;
            if let Some(entry) = manifest
                .files
                .iter_mut()
                .find(|entry| entry.id == source.id)
            {
                entry.key = key_for(&path)?;
                let metadata = std::fs::metadata(&path)?;
                entry.size = metadata.len();
                entry.mtime_ns = metadata
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos();
            }
        }
        let live_references = references_in(&revised)
            .into_iter()
            .map(|reference| (reference.syntax, reference.raw))
            .collect::<Vec<_>>();
        manifest.bindings.retain(|binding| {
            binding.source_id != source.id
                || live_references
                    .iter()
                    .any(|(syntax, raw)| *syntax == binding.syntax && *raw == binding.reference)
        });
        manifest.unresolved.retain(|unresolved| {
            unresolved.source_id != source.id
                || live_references.iter().any(|(syntax, raw)| {
                    *syntax == unresolved.syntax && *raw == unresolved.reference
                })
        });
        manifest.pending_revisions.remove(&source.id);
        manifest.pending_source_ids.retain(|id| id != &source.id);
        if revised != content {
            write_manifest(vault, &manifest)?;
        }
    }
    if manifest != original {
        write_manifest(vault, &manifest)?;
    }
    Ok(moves)
}

fn resolve_first_observation<'a>(
    files: &'a [FileEntry],
    source: &str,
    reference: &Reference,
) -> Option<&'a FileEntry> {
    let (name, _) = split_reference(reference);
    if name.starts_with("http:")
        || name.starts_with("https:")
        || name.starts_with('/')
        || name.contains('\0')
    {
        return None;
    }
    let decoded = if matches!(
        reference.syntax,
        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
    ) {
        percent_encoding::percent_decode_str(name)
            .decode_utf8()
            .ok()?
            .into_owned()
    } else {
        name.to_string()
    };
    let source_parent = Path::new(source).parent().unwrap_or(Path::new(""));
    let candidate = normalize_relative(source_parent, &decoded)?;
    let explicit = decoded.contains('/');
    let is_note = Path::new(&decoded).extension().is_none();
    let wanted = if is_note {
        format!("{decoded}.md")
    } else {
        decoded.clone()
    };
    if !explicit
        && !matches!(
            reference.syntax,
            ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
        )
    {
        let basename_count = files
            .iter()
            .filter(|entry| {
                Path::new(&entry.path)
                    .file_name()
                    .and_then(|file| file.to_str())
                    == Some(wanted.as_str())
            })
            .count();
        if basename_count > 1 {
            return None;
        }
    }
    let relative_wanted = if is_note {
        format!("{candidate}.md")
    } else {
        candidate
    };
    let path_matches = files
        .iter()
        .filter(|entry| entry.path == relative_wanted || (explicit && entry.path == wanted))
        .collect::<Vec<_>>();
    if path_matches.len() == 1 {
        return Some(path_matches[0]);
    }
    if explicit
        || matches!(
            reference.syntax,
            ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
        )
    {
        return None;
    }
    let matches = files
        .iter()
        .filter(|entry| {
            Path::new(&entry.path)
                .file_name()
                .and_then(|file| file.to_str())
                == Some(wanted.as_str())
        })
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    }
}

fn display_target(files: &[FileEntry], path: &str, omit_markdown_extension: bool) -> String {
    let basename = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path);
    let duplicate = files
        .iter()
        .filter(|entry| {
            Path::new(&entry.path)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(basename)
        })
        .count()
        > 1;
    let value = if duplicate { path } else { basename };
    if omit_markdown_extension {
        value.strip_suffix(".md").unwrap_or(value).to_string()
    } else {
        value.to_string()
    }
}

fn relative_from_source(source: &str, target: &str) -> String {
    let source_parts = Path::new(source)
        .parent()
        .unwrap_or(Path::new(""))
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let target_parts = Path::new(target)
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let common = source_parts
        .iter()
        .zip(&target_parts)
        .take_while(|(a, b)| a == b)
        .count();
    std::iter::repeat_n("..".to_string(), source_parts.len() - common)
        .chain(target_parts.into_iter().skip(common))
        .collect::<Vec<_>>()
        .join("/")
}

fn reference_points_to(
    files: &[FileEntry],
    source: &str,
    reference: &Reference,
    target: &str,
) -> bool {
    let (raw, _) = split_reference(reference);
    let decoded = if matches!(
        reference.syntax,
        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
    ) {
        match percent_encoding::percent_decode_str(raw).decode_utf8() {
            Ok(value) => value.into_owned(),
            Err(_) => return false,
        }
    } else {
        raw.to_string()
    };
    let wanted = if Path::new(&decoded).extension().is_none() {
        format!("{decoded}.md")
    } else {
        decoded.clone()
    };
    if matches!(
        reference.syntax,
        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
    ) {
        let parent = Path::new(source).parent().unwrap_or(Path::new(""));
        return normalize_relative(parent, &wanted).as_deref() == Some(target);
    }
    if decoded.contains('/') {
        return wanted == target
            || normalize_relative(Path::new(source).parent().unwrap_or(Path::new("")), &wanted)
                .as_deref()
                == Some(target);
    }
    let same_name = files
        .iter()
        .filter(|entry| {
            Path::new(&entry.path)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(wanted.as_str())
        })
        .collect::<Vec<_>>();
    same_name.len() == 1 && same_name[0].path == target
}

fn normalize_relative(base: &Path, relative: &str) -> Option<String> {
    let mut parts = base
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    for component in Path::new(relative).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            std::path::Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Resolve an established source link by durable target identity. `Some(None)`
/// means a binding exists but its target is absent; callers must not fall back
/// to another file at the old path.
pub fn bound_target(
    vault: &VaultLayout,
    source_slug: &str,
    reference: &str,
) -> Result<Option<Option<PathBuf>>> {
    bound_target_kind(vault, source_slug, reference, ReferenceSyntax::Wikilink)
}

/// Resolve a source frontmatter media field by its established binding.
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
    fn same_spelling_keeps_frontmatter_and_wikilink_targets_separate() {
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
            Some(a)
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
            Some(b)
        );
        assert_eq!(
            crate::storage::media_refs::resolve_indexed_media(&vault, "A/Card", "photo.jpg"),
            None
        );
    }
}
