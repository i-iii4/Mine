//! Filesystem-first reconciliation for the source vault and local SQLite index.
//!
//! Contract: SPEC_STORAGE.md#storagereconcile--filesystem-first-visibility

use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

use crate::domain::block::{
    iter_inline_media_references, parse_markdown_document, Block, BlockType, DateTime,
};
use crate::domain::vault::VaultLayout;
use crate::storage::{article_audio, db, file_identity, files, index, media_refs};
use mine_core::links::LinkIndex;

/// The reference cards use for a collection page. `links` is the space's
/// path index, built once per pass: building it walks every file, and doing
/// that for each collection made a pass over a large space quadratic
/// (SPEC_AUDIT_FIXES.md, А8.3).
fn channel_ref_for_slug(links: &LinkIndex, slug: &str) -> Result<String> {
    links
        .shortest_link(&format!("{slug}.md"), true)
        .ok_or_else(|| anyhow::anyhow!("collection document has no unambiguous link: {slug}"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ns: u128,
}

impl FileStamp {
    fn read(path: &Path) -> std::io::Result<Self> {
        let metadata = std::fs::metadata(path)?;
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let mtime_ns = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Ok(Self {
            size: metadata.len(),
            mtime_ns,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DependencyStamp {
    pub vault_relative_path: String,
    pub file: Option<FileStamp>,
    /// The file's contents were in iCloud when the note was read, so what
    /// the index derives from them (its size) is missing. Their arrival
    /// makes the note stale; their eviction does not (SPEC_CLOUD_STORAGE.md,
    /// Х25).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offloaded: bool,
}

impl DependencyStamp {
    fn read(vault_relative_path: String, absolute: &Path) -> Self {
        Self {
            vault_relative_path,
            file: FileStamp::read(absolute).ok(),
            offloaded: crate::storage::cloud_files::is_content_offloaded(absolute),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceStamp {
    pub markdown: FileStamp,
    pub dependencies: Vec<DependencyStamp>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Block,
    Channel,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Channel => "channel",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "block" => Some(Self::Block),
            "channel" => Some(Self::Channel),
            _ => None,
        }
    }
}

/// What went wrong with one note of a pass.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileFileErrorKind {
    Metadata,
    Read,
    Parse,
    Index,
    DependencyOutsideVault,
}

/// A note a pass could not read or project, and why: the index is ready
/// without it (SPEC_DEEP_AUDIT.md, Н6), and the interface names it (Е6.17).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct ReconcileFileError {
    pub path: String,
    pub kind: ReconcileFileErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReconcileReport {
    pub inventory_markdown: usize,
    pub unchanged: usize,
    pub upserted: Vec<String>,
    pub removed: Vec<String>,
    pub dependency_changed: Vec<String>,
    pub errors: Vec<ReconcileFileError>,
    pub content_reads: usize,
    pub database_writes: usize,
    pub elapsed_ms: u64,
}

impl ReconcileReport {
    /// Whether every file of the space was read and projected. A pass with
    /// errors in some files still finishes the index (`ready`) and names
    /// those files (SPEC_DEEP_AUDIT.md, Н6).
    pub fn is_fresh(&self) -> bool {
        self.errors.is_empty()
    }
}

#[derive(Debug, Error)]
pub enum ReconcileError {
    #[error("failed to inventory vault {path}: {source}")]
    Inventory {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    #[error("failed to read reconciliation state: {0}")]
    State(#[source] anyhow::Error),
    #[error("failed to commit reconciliation: {0}")]
    Commit(#[source] anyhow::Error),
    #[error("sources kept changing while building index for {path}; retry is required")]
    SourcesChanging { path: PathBuf },
    /// The space's folder is gone or is another space: nothing is removed
    /// (SPEC_VAULT_LIFECYCLE.md, П29).
    #[error(transparent)]
    RootUnavailable(#[from] crate::storage::root_guard::RootUnavailable),
}

#[derive(Debug)]
struct StoredSourceState {
    kind: SourceKind,
    stamp: SourceStamp,
}

#[derive(Debug)]
struct PreparedSource {
    path: String,
    slug: String,
    kind: SourceKind,
    block: Block,
    origin: String,
    index_warning: Option<String>,
    stamp: SourceStamp,
    dependency_changed: bool,
}

/// What a pass does with a note it must read whose contents iCloud keeps
/// off this Mac (SPEC_CLOUD_STORAGE.md, Х12, Х24).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvictedNotes {
    /// Read it, waiting for the download, but never while holding the
    /// index: the pass finds such notes, lets the index go, brings them down
    /// ([`bring_down`]) and starts again as [`EvictedNotes::ReadHere`]. Every
    /// pass but an action's.
    BringDownFirst,
    /// Read it where it is met, holding the index: the first build of an
    /// index, which reads every note under its progress
    /// (SPEC_ONBOARDING.md, О13) and which no action waits on yet, and a
    /// pass that has already brought its notes down.
    ReadHere,
    /// Leave it as the index holds it, for the next pass of the first kind:
    /// an action never waits for a note it does not own.
    Defer,
}

/// What the pass before an action did ([`reconcile_vault_for_action`]).
#[derive(Debug, Clone)]
pub struct ActionReconcile {
    pub report: ReconcileReport,
    /// The notes the pass had to read and left as the index holds them,
    /// their contents being in iCloud. iCloud has been asked for them.
    pub deferred: Vec<PathBuf>,
}

/// Reconcile source Markdown inventory with the rebuildable SQLite projection.
///
/// Unchanged files are compared using metadata only. Content is read and parsed
/// only for new/changed sources or when a persisted media dependency changed.
pub fn reconcile_vault(
    conn: &Connection,
    vault: &VaultLayout,
) -> std::result::Result<ReconcileReport, ReconcileError> {
    reconcile_vault_with_progress(conn, vault, &|_, _| {})
}

/// Bring the index up to the files before an action takes from it the notes
/// it acts on (SPEC_DEEP_AUDIT.md, Н5), never waiting for iCloud
/// (SPEC_CLOUD_STORAGE.md, Х12). A note whose contents are in iCloud and
/// which the pass would read (new to the index, or changed on another Mac
/// since the last pass) is left as the index holds it: the next background
/// pass reads it, and iCloud is asked for it meanwhile. A note unchanged by
/// its metadata is unchanged and read by no pass. The live case of
/// 13.10.2026: `mine card delete … --delete-unused-media` on «Тест» waited
/// minutes reading `Oct 15th! ⌨️.md`, a note the clipper saved while no pass
/// read it, whose contents macOS had taken away.
pub fn reconcile_vault_for_action(
    conn: &Connection,
    vault: &VaultLayout,
) -> std::result::Result<ActionReconcile, ReconcileError> {
    let (report, deferred) = reconcile_projection(
        conn,
        vault,
        &|_, _| {},
        &file_identity::IdentityRefresh::default(),
        EvictedNotes::Defer,
    )?;
    if !deferred.is_empty() {
        log::info!(
            "left {} notes whose contents are in iCloud to the background pass of {}",
            deferred.len(),
            vault.root().display()
        );
    }
    Ok(ActionReconcile { report, deferred })
}

/// Reconcile with a progress callback: `(processed, total)` over the markdown
/// inventory. The first index of a large space is minutes of silence without
/// this — and silence reads as "hung", not "working". See SPEC_ONBOARDING.md
/// О13. The callback is called once per file; throttling is the caller's
/// business, because only the caller knows what a UI update costs.
pub fn reconcile_vault_with_progress(
    conn: &Connection,
    vault: &VaultLayout,
    on_progress: &(dyn Fn(usize, usize) + Sync),
) -> std::result::Result<ReconcileReport, ReconcileError> {
    reconcile_projection(
        conn,
        vault,
        on_progress,
        &file_identity::IdentityRefresh::default(),
        EvictedNotes::BringDownFirst,
    )
    .map(|(report, _)| report)
}

/// Runtime source maintenance repairs confirmed offline renames before indexing.
/// This source operation is deliberately absent from rebuild/read-only APIs.
pub fn reconcile_runtime_vault_with_progress(
    conn: &Connection,
    vault: &VaultLayout,
    on_progress: &(dyn Fn(usize, usize) + Sync),
) -> std::result::Result<ReconcileReport, ReconcileError> {
    files::scan_md_files(vault).map_err(|source| ReconcileError::Inventory {
        path: vault.root().to_path_buf(),
        source,
    })?;
    let identity = file_identity::reconcile(vault).map_err(ReconcileError::State)?;
    reconcile_projection(conn, vault, on_progress, &identity, EvictedNotes::BringDownFirst)
        .map(|(report, _)| report)
}

/// The pass, and the notes it left unread ([`EvictedNotes::Defer`]).
fn reconcile_projection(
    conn: &Connection,
    vault: &VaultLayout,
    on_progress: &(dyn Fn(usize, usize) + Sync),
    identity: &file_identity::IdentityRefresh,
    evicted: EvictedNotes,
) -> std::result::Result<(ReconcileReport, Vec<PathBuf>), ReconcileError> {
    match reconcile_holding_the_index(conn, vault, on_progress, identity, evicted)? {
        Held::Finished(report, deferred) => Ok((report, deferred)),
        Held::NotesInCloud(notes) => {
            // The index is free while the notes come down: an action that
            // comes meanwhile does not wait behind the download (Х12).
            bring_down(vault, &notes);
            match reconcile_holding_the_index(
                conn,
                vault,
                on_progress,
                identity,
                EvictedNotes::ReadHere,
            )? {
                Held::Finished(report, deferred) => Ok((report, deferred)),
                Held::NotesInCloud(_) => Err(ReconcileError::State(anyhow::anyhow!(
                    "a pass that reads notes where it meets them asked to bring notes down"
                ))),
            }
        }
    }
}

/// What a run of passes holding the index (`build.lock`) came to.
enum Held {
    /// The index is brought up to the files: the report, and the notes left
    /// unread ([`EvictedNotes::Defer`]).
    Finished(ReconcileReport, Vec<PathBuf>),
    /// Nothing was read or written: these notes must be read and their
    /// contents are in iCloud ([`EvictedNotes::BringDownFirst`]).
    NotesInCloud(Vec<PathBuf>),
}

/// The index's readiness flag over one run of passes (SPEC_STORAGE.md,
/// «Готовность пересборки», «Проход без изменений»). The flag is written
/// only when it has to change: a pass that finds nothing to write leaves it
/// alone. Until 15.11.2026 every pass wrote it twice.
struct Readiness<'a> {
    conn: &'a Connection,
    /// The flag before the run.
    was_ready: bool,
    /// The flag as the index holds it now.
    stored: bool,
}

impl<'a> Readiness<'a> {
    fn read(conn: &'a Connection) -> Result<Self> {
        let was_ready = db::index_is_ready(conn)?;
        Ok(Self {
            conn,
            was_ready,
            stored: was_ready,
        })
    }

    /// Before the first write of a pass into the index: it is not ready
    /// again until the check after the pass confirms it.
    fn lower(&mut self) -> Result<()> {
        self.publish(false)
    }

    fn publish(&mut self, ready: bool) -> Result<()> {
        if self.stored != ready {
            db::set_index_ready(self.conn, ready)?;
            self.stored = ready;
        }
        Ok(())
    }

    /// The index is exactly as ready as before the run.
    fn restore(&mut self) -> Result<()> {
        self.publish(self.was_ready)
    }
}

/// Take the index for this process (`build.lock`) and run passes until one
/// ends on the files as they are.
fn reconcile_holding_the_index(
    conn: &Connection,
    vault: &VaultLayout,
    on_progress: &(dyn Fn(usize, usize) + Sync),
    identity: &file_identity::IdentityRefresh,
    evicted: EvictedNotes,
) -> std::result::Result<Held, ReconcileError> {
    const MAX_SOURCE_PASSES: usize = 3;
    let _write = crate::storage::source_mutation::begin_write().map_err(ReconcileError::State)?;
    let directory = vault.index_generation_dir();
    std::fs::create_dir_all(&directory).map_err(|error| ReconcileError::State(error.into()))?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("build.lock"))
        .map_err(|error| ReconcileError::State(error.into()))?;
    lock.lock_exclusive()
        .map_err(|error| ReconcileError::State(error.into()))?;
    let mut readiness = Readiness::read(conn).map_err(ReconcileError::State)?;
    let was_ready = readiness.was_ready;
    // Only an index already built lets go of the index to bring notes down.
    let evicted = match evicted {
        EvictedNotes::BringDownFirst if !was_ready => EvictedNotes::ReadHere,
        other => other,
    };
    let mut aggregate: Option<ReconcileReport> = None;
    // Readiness does not hang on one note (SPEC_DEEP_AUDIT.md, Н6, Е5.1): a
    // pass that read every other file publishes the index ready and names the
    // files it could not read or project. Until 13.10.2026 one unreadable note
    // kept `ready=false` for good, since every pass met it again, and the CLI
    // and the clipper helper saw an index never built.
    for _ in 0..MAX_SOURCE_PASSES {
        let pass = match reconcile_source_pass(
            conn,
            vault,
            on_progress,
            identity,
            evicted,
            &mut readiness,
        ) {
            Ok(pass) => pass,
            // The folder is gone and the pass rolled back without touching the
            // index: it is exactly as ready as before, and a space reopened
            // under its new name shows it at once (П31).
            Err(ReconcileError::RootUnavailable(unavailable)) => {
                readiness.restore().map_err(ReconcileError::State)?;
                return Err(ReconcileError::RootUnavailable(unavailable));
            }
            Err(error) => return Err(error),
        };
        let SourcePass {
            report,
            deferred,
            in_cloud,
            wrote,
        } = pass;
        if !in_cloud.is_empty() {
            return Ok(Held::NotesInCloud(in_cloud));
        }
        // The notes left unread are as the index held them, like those with
        // an error: the check after the pass does not wait for them.
        let mut skipped = failed_slugs(vault, &report.errors);
        skipped.extend(deferred.iter().filter_map(|path| vault.slug_for_path(path).ok()));
        match &mut aggregate {
            Some(total) => {
                total.inventory_markdown = report.inventory_markdown;
                total.unchanged = report.unchanged;
                total.upserted.extend(report.upserted);
                total.removed.extend(report.removed);
                total.dependency_changed.extend(report.dependency_changed);
                total.errors = report.errors;
                total.content_reads += report.content_reads;
                total.database_writes += report.database_writes;
                total.elapsed_ms += report.elapsed_ms;
            }
            None => aggregate = Some(report),
        }
        // A pass that wrote nothing has itself compared every note with what
        // the index holds: checking the same files again answers the same
        // question (SPEC_STORAGE.md, «Проход без изменений»).
        if !wrote || source_inventory_matches(conn, vault, &skipped).map_err(ReconcileError::State)? {
            // An action that left notes unread never makes an index that was
            // not ready look complete (SPEC_CLOUD_STORAGE.md, Х12).
            readiness
                .publish(was_ready || deferred.is_empty())
                .map_err(ReconcileError::Commit)?;
            return aggregate
                .map(|report| Held::Finished(report, deferred))
                .ok_or_else(|| {
                    ReconcileError::State(anyhow::anyhow!("source pass produced no report"))
                });
        }
    }
    // The files kept changing: the index is exactly as ready as before the
    // pass (Н6), and the next pass reads them again.
    readiness.restore().map_err(ReconcileError::Commit)?;
    Err(ReconcileError::SourcesChanging {
        path: vault.root().to_path_buf(),
    })
}

/// What one pass over the notes of the space did.
struct SourcePass {
    report: ReconcileReport,
    /// The notes left unread as the index holds them ([`EvictedNotes::Defer`]).
    deferred: Vec<PathBuf>,
    /// The notes to bring down before the pass can read them
    /// ([`EvictedNotes::BringDownFirst`]). When there are any, the pass wrote
    /// nothing and its report says nothing.
    in_cloud: Vec<PathBuf>,
    /// Whether the pass changed the index. Only then the files are checked
    /// against it again.
    wrote: bool,
}

/// The notes of `errors`, by slug: their stored state is not what is on disk,
/// and the next pass reads them again.
fn failed_slugs(vault: &VaultLayout, errors: &[ReconcileFileError]) -> BTreeSet<String> {
    errors
        .iter()
        .filter_map(|error| vault.slug_for_path(Path::new(&error.path)).ok())
        .collect()
}

/// Whether the stored state of every note but `failed` is what is on disk.
fn source_inventory_matches(
    conn: &Connection,
    vault: &VaultLayout,
    failed: &BTreeSet<String>,
) -> Result<bool> {
    let mut stored = load_source_states(conn)?;
    stored.retain(|slug, _| !failed.contains(slug));
    let paths = files::scan_md_files(vault)?;
    let mut live = BTreeSet::new();
    for path in paths {
        let Ok(slug) = vault.slug_for_path(&path) else {
            continue;
        };
        if failed.contains(&slug) {
            continue;
        }
        live.insert(slug.clone());
        let Some(state) = stored.get(&slug) else {
            return Ok(false);
        };
        if FileStamp::read(&path)? != state.stamp.markdown
            || dependencies_changed(vault, &state.stamp.dependencies)
        {
            return Ok(false);
        }
    }
    Ok(live.len() == stored.len())
}

/// What one walk of a space found (SPEC_STORAGE.md, «Проход без
/// изменений»): its notes, and every file a note can name.
struct Inventory {
    /// The notes, as [`files::scan_md_files`] lists them: sorted.
    notes: Vec<PathBuf>,
    /// Every file by its path from the root, as [`media_refs::list_files`]
    /// lists them.
    files: Vec<String>,
}

/// Walk the space once for both lists a pass needs. Until 15.11.2026 a pass
/// walked the space for its notes and again for the names of all its files.
/// The two walks skipped the same folders (hidden ones, `node_modules`,
/// `target`, `__pycache__`); this one fails where the walk for notes failed:
/// a folder that cannot be listed must not read as notes deleted.
fn inventory(vault: &VaultLayout) -> Result<Inventory> {
    #[cfg(test)]
    INVENTORY_WALKS.with(|walks| walks.set(walks.get() + 1));
    fn walk(dir: &Path, root: &Path, found: &mut Inventory) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                if !files::is_ignored_vault_dir(&path) {
                    walk(&path, root, found)?;
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) {
                found.files.push(relative.to_string());
            }
            if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
                found.notes.push(path);
            }
        }
        Ok(())
    }
    let root = vault.root();
    let mut found = Inventory {
        notes: Vec::new(),
        files: Vec::new(),
    };
    walk(root, root, &mut found)
        .with_context(|| format!("failed to read vault directory: {}", root.display()))?;
    found.notes.sort();
    Ok(found)
}

#[cfg(test)]
thread_local! {
    static INVENTORY_WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many walks of a space passes have made on this thread: tests take the
/// difference across a pass.
#[cfg(test)]
pub(crate) fn inventory_walks() -> usize {
    INVENTORY_WALKS.with(std::cell::Cell::get)
}

/// Every file of a space by name, as the last walk of a pass listed them,
/// kept between passes of this process (SPEC_STORAGE.md, «Проход без
/// изменений»). Building the index of names from the list costs about as
/// much as the walk itself, and from one pass to the next the list is
/// almost always the same.
struct KeptFiles {
    /// The files the index holds: each path as the index spells it, by its
    /// Unicode-composed form ([`file_key`]).
    files: HashMap<String, String>,
    index: Arc<LinkIndex>,
}

/// The key the kept names know a file's path by: Unicode composed. A
/// listing of a folder and an event of the watcher may spell one file in
/// two Unicode forms; kept as two paths they would make every link to the
/// file ambiguous.
fn file_key(path: &str) -> std::borrow::Cow<'_, str> {
    if path.is_ascii() {
        std::borrow::Cow::Borrowed(path)
    } else {
        std::borrow::Cow::Owned(path.nfc().collect())
    }
}

static KEPT_FILES: LazyLock<Mutex<HashMap<PathBuf, KeptFiles>>> = LazyLock::new(Default::default);

/// The index of names of the files a pass has just listed in the space at
/// `root`. The kept index is used only when it was built of exactly these
/// files; otherwise one is built of them and takes its place. Either way the
/// index the pass resolves with, and the one kept after it, is the index of
/// what the pass's own walk found: a kept index never outlives a pass that
/// lists other files.
fn keep_files(root: &Path, files: Vec<String>) -> Arc<LinkIndex> {
    let mut kept = KEPT_FILES.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(known) = kept.get(root) {
        if known.files.len() == files.len()
            && files
                .iter()
                .all(|file| known.files.contains_key(file_key(file).as_ref()))
        {
            return Arc::clone(&known.index);
        }
    }
    let index = Arc::new(LinkIndex::new(&files));
    kept.insert(
        root.to_path_buf(),
        KeptFiles {
            files: files
                .into_iter()
                .map(|file| (file_key(&file).into_owned(), file))
                .collect(),
            index: Arc::clone(&index),
        },
    );
    index
}

/// The kept index of names of the space at `vault`, for reading single
/// notes again between passes (SPEC_INTEGRATION.md, «Пачки событий и точное
/// перечитывание»): the one the last pass left and the watcher has followed
/// since, or, when no pass of this process has listed the space yet, one
/// built of a walk made here.
fn kept_link_index(vault: &VaultLayout) -> Result<Arc<LinkIndex>> {
    if let Some(known) = KEPT_FILES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(vault.root())
    {
        return Ok(Arc::clone(&known.index));
    }
    Ok(keep_files(vault.root(), inventory(vault)?.files))
}

/// Whether the names kept for the space at `root` hold the file at
/// `relative`; `None` when no names are kept for it.
#[cfg(test)]
pub(crate) fn kept_names_hold(root: &Path, relative: &str) -> Option<bool> {
    KEPT_FILES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(root)
        .map(|known| {
            known.files.contains_key(file_key(relative).as_ref())
                && known.index.shortest_link(relative, false).is_some()
        })
}

/// A resolver over the kept names of the space at `vault`
/// ([`kept_link_index`]), for the lookups of one batch of watcher events.
pub(crate) fn kept_names_resolver(vault: &VaultLayout) -> Result<media_refs::MediaResolver<'_>> {
    Ok(media_refs::MediaResolver::with_link_index(
        vault,
        kept_link_index(vault)?,
    ))
}

/// Drop the kept names of the space at `root`: what the watcher was told no
/// longer says which files are there (a folder moved, events were lost, the
/// space is closed). The next pass, or the next reading of a note, lists the
/// space again.
pub fn forget_kept_files(root: &Path) {
    KEPT_FILES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(root);
}

/// What the kept names of a space made of a path its watcher reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeenPath {
    /// A file that is there: the kept names hold it now.
    File,
    /// A path with nothing at it that was a file, or was nothing the kept
    /// names knew (a file that came and went): the kept names do not hold it.
    GoneFile,
    /// A folder, or a path with nothing at it under which the kept names
    /// held files, or any path with nothing at it while no names are kept:
    /// only a walk of the space tells what happened under it. The kept names
    /// are dropped.
    Folder,
}

/// Make the kept names of the space at `vault` follow the path a watcher
/// reported, as the disk shows it now (SPEC_INTEGRATION.md, «Индекс имён
/// файлов»). The watcher calls this for every event of a file a note can
/// name, the events of Mine's own writes included: the kept names are then
/// what a walk of the space would list, until events are lost, and every
/// pass over the space checks them against its own walk (`keep_files`).
pub fn follow_path(vault: &VaultLayout, path: &Path) -> SeenPath {
    let root = vault.root();
    let Some(relative) = vault.root_relative_reference(path) else {
        return SeenPath::GoneFile;
    };
    let mut kept = KEPT_FILES.lock().unwrap_or_else(PoisonError::into_inner);
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            kept.remove(root);
            SeenPath::Folder
        }
        Ok(metadata) => {
            if metadata.is_file() {
                if let Some(known) = kept.get_mut(root) {
                    let key = file_key(&relative).into_owned();
                    if !known.files.contains_key(&key) {
                        Arc::make_mut(&mut known.index).insert(&relative);
                        known.files.insert(key, relative);
                    }
                }
            }
            SeenPath::File
        }
        Err(_) => {
            let Some(known) = kept.get_mut(root) else {
                return SeenPath::Folder;
            };
            if let Some(listed) = known.files.remove(file_key(&relative).as_ref()) {
                Arc::make_mut(&mut known.index).remove(&listed);
                return SeenPath::GoneFile;
            }
            let inside = format!("{}/", file_key(&relative));
            if known.files.keys().any(|file| file.starts_with(&inside)) {
                kept.remove(root);
                return SeenPath::Folder;
            }
            SeenPath::GoneFile
        }
    }
}

/// A file name as notes are matched to it: Unicode composed, lower case.
fn name_key(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

/// The key notes are matched by to the file at `path`: its name
/// ([`name_key`]). `None` for a path without a name in UTF-8.
pub fn file_name_key(path: &Path) -> Option<String> {
    path.file_name().and_then(|name| name.to_str()).map(name_key)
}

/// The names a note is found by when a file changes: the last part of each
/// of its recorded dependencies ([`name_key`]), and the same part decoded
/// when it is percent-encoded (`![](my%20photo.jpg)` names `my photo.jpg`).
/// These are the rows of `source_dependency_names` for the note.
fn dependency_names(stamp: &SourceStamp) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for dependency in &stamp.dependencies {
        let path = dependency.vault_relative_path.as_str();
        let last = path.rsplit('/').next().unwrap_or(path);
        if last.contains('%') {
            names.insert(name_key(
                &percent_encoding::percent_decode_str(last).decode_utf8_lossy(),
            ));
        }
        names.insert(name_key(last));
    }
    names
}

/// The notes that name a file called as one of `names` ([`name_key`]), each
/// with the names it names (SPEC_INTEGRATION.md, «Точное перечитывание»).
///
/// A note names a file when the last part of a dependency recorded for it
/// is the file's name, whatever its letter case and Unicode form, written
/// plainly or percent-encoded ([`dependency_names`]). The recorded path
/// itself is not compared: a file that was not there when the note was read
/// is recorded at a path beside the note (`collect_dependency_paths`), and
/// lands in another folder. A note that names another file of the same name
/// is found too, and is read again for nothing; no note that names the file
/// is missed.
///
/// This is the one place that finds notes by file name. It asks
/// `source_dependency_names` for each name by its key, so what it costs does
/// not grow with the notes of the space (SPEC_STORAGE.md, schema 9). Until
/// schema 9 it read every row of `source_index_state`, about 0,9 ms a
/// thousand notes.
fn notes_naming_files(
    conn: &Connection,
    names: &HashSet<String>,
) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let mut notes = BTreeMap::<String, BTreeSet<String>>::new();
    let mut stmt = conn.prepare("SELECT slug FROM source_dependency_names WHERE name = ?1")?;
    for name in names {
        let mut rows = stmt.query([name])?;
        while let Some(row) = rows.next()? {
            notes.entry(row.get(0)?).or_default().insert(name.clone());
        }
    }
    Ok(notes)
}

/// What reading again the notes that name changed files did
/// ([`reread_notes_naming`]).
#[derive(Debug, Default)]
pub struct RereadNotes {
    /// The notes that name one of the files, each with the names it names
    /// ([`file_name_key`]): the ones read again here and the ones the caller
    /// had read already.
    pub naming: BTreeMap<String, BTreeSet<String>>,
    /// The notes read and projected again, by slug.
    pub reread: Vec<String>,
    /// The notes that could not be read or projected.
    pub errors: Vec<ReconcileFileError>,
    /// A note that names one of the files was left as the index holds it,
    /// its contents being in iCloud: a background pass brings it down and
    /// reads it (SPEC_CLOUD_STORAGE.md, Х12, Х24).
    pub left_in_cloud: bool,
}

#[cfg(test)]
thread_local! {
    static REREAD_PASSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times notes were read again for changed files on this thread:
/// tests take the difference across a batch of watcher events.
#[cfg(test)]
pub(crate) fn reread_passes() -> usize {
    REREAD_PASSES.with(std::cell::Cell::get)
}

/// Read and project again the notes that name the files at `files`, which
/// changed, appeared or went: one pass for all of them, which neither walks
/// the space nor reads a note that names none of them (SPEC_INTEGRATION.md,
/// «Точное перечитывание»). Until 16.11.2026 every such file ran a pass
/// over the whole space.
///
/// The notes of `already_read` were projected a moment ago with the files as
/// they are (the notes of the same batch of watcher events) and are not read
/// again. Each note read is projected as a pass over the space projects it:
/// its row, its source stamp and its dependencies, all of them in one
/// transaction. References are resolved by the kept names of the space
/// ([`follow_path`]).
///
/// # Errors
///
/// When the index cannot be read or the transaction cannot be committed. A
/// note that cannot be read or projected is named in the outcome instead.
pub fn reread_notes_naming(
    conn: &Connection,
    vault: &VaultLayout,
    files: &[PathBuf],
    already_read: &BTreeSet<String>,
) -> Result<RereadNotes> {
    #[cfg(test)]
    REREAD_PASSES.with(|passes| passes.set(passes.get() + 1));
    let names = files
        .iter()
        .filter_map(|path| file_name_key(path))
        .collect::<HashSet<_>>();
    let mut outcome = RereadNotes {
        naming: notes_naming_files(conn, &names)?,
        ..RereadNotes::default()
    };
    let to_read = outcome
        .naming
        .keys()
        .filter(|slug| !already_read.contains(*slug))
        .filter(|slug| crate::domain::vault::validate_slug(slug).is_ok())
        .cloned()
        .collect::<Vec<_>>();
    if to_read.is_empty() {
        return Ok(outcome);
    }
    let mut media_resolver =
        media_refs::MediaResolver::with_link_index(vault, kept_link_index(vault)?);
    let mut prepared = Vec::with_capacity(to_read.len());
    for slug in to_read {
        let path = vault.block_path(&slug);
        let markdown_stamp = match FileStamp::read(&path) {
            Ok(stamp) => stamp,
            // The note is gone: its own event removes it from the index.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                outcome.errors.push(file_error(
                    &path,
                    ReconcileFileErrorKind::Metadata,
                    error.to_string(),
                ));
                continue;
            }
        };
        if crate::storage::cloud_files::is_content_offloaded(&path) {
            crate::storage::icloud_downloads::request_downloads([path.as_path()]);
            outcome.left_in_cloud = true;
            continue;
        }
        match prepare_source(vault, &path, markdown_stamp, true, &mut media_resolver) {
            Ok(source) => prepared.push(source),
            Err(error) => outcome.errors.push(error),
        }
    }
    if prepared.is_empty() {
        return Ok(outcome);
    }

    let tx = conn.unchecked_transaction()?;
    let mut committed_sources = Vec::with_capacity(prepared.len());
    for source in prepared {
        match apply_prepared_source(&tx, &source, &mut media_resolver) {
            Ok(()) => {
                outcome.reread.push(source.slug);
                committed_sources.push((source.kind, source.block));
            }
            Err(error) => outcome.errors.push(ReconcileFileError {
                path: source.path,
                kind: ReconcileFileErrorKind::Index,
                message: format!("{error:#}"),
            }),
        }
    }
    tx.commit().context("commit the notes read again")?;
    for (kind, block) in committed_sources {
        match kind {
            SourceKind::Block => {
                let _ = article_audio::invalidate_for_block(vault, &block);
            }
            SourceKind::Channel => {
                let _ = article_audio::delete_all_artifacts(vault, &block.slug);
            }
        }
    }
    Ok(outcome)
}

fn reconcile_source_pass(
    conn: &Connection,
    vault: &VaultLayout,
    on_progress: &(dyn Fn(usize, usize) + Sync),
    identity: &file_identity::IdentityRefresh,
    evicted: EvictedNotes,
    readiness: &mut Readiness<'_>,
) -> std::result::Result<SourcePass, ReconcileError> {
    let started = Instant::now();
    crate::storage::root_guard::ensure_root_present(vault)?;
    let identity_affected = identity.affected_markdown.iter().collect::<BTreeSet<_>>();
    let Inventory {
        notes: paths,
        files: listed,
    } = inventory(vault).map_err(|source| ReconcileError::Inventory {
        path: vault.root().to_path_buf(),
        source,
    })?;
    let total_paths = paths.len();
    // The slug of every note, once for the whole pass.
    let slugs = paths
        .iter()
        .map(|path| vault.slug_for_path(path))
        .collect::<Vec<_>>();
    let stored = load_source_states(conn).map_err(ReconcileError::State)?;
    let indexed_kinds = load_indexed_kinds(conn).map_err(ReconcileError::State)?;
    // Notes new to the index whose contents are in iCloud: ask for all of them
    // at once, so iCloud brings them side by side and the reads below wait for
    // each far less than one by one (SPEC_CLOUD_STORAGE.md, Х24). A note the
    // index already knows is not brought back this way: iCloud took it to
    // free space, and nothing here needs it unless it changed.
    let cloud_notes = paths
        .iter()
        .zip(&slugs)
        .filter(|(_, slug)| slug.as_ref().is_ok_and(|slug| !stored.contains_key(slug)))
        .map(|(path, _)| path)
        .filter(|path| crate::storage::cloud_files::is_content_offloaded(path))
        .collect::<Vec<_>>();
    if !cloud_notes.is_empty() {
        let accepted = crate::storage::icloud_downloads::request_downloads(
            cloud_notes.iter().map(|path| path.as_path()),
        );
        log::info!(
            "requested {accepted} of {} new notes from iCloud for {}",
            cloud_notes.len(),
            vault.root().display()
        );
    }

    let mut live_slugs = BTreeSet::new();
    // Collection names backed by a channel document this pass saw on disk —
    // the ground truth the phantom-channel sweep below compares the table to.
    let mut live_channel_refs = BTreeSet::new();
    let mut prepared = Vec::new();
    // One snapshot of the vault's file list serves every lookup of this pass:
    // frontmatter and body media, the index row of each note, collection
    // references. Walking the vault per reference made indexing quadratic.
    // The snapshot is the inventory above, the same walk that listed the
    // notes, so every note this pass reads is in it. A note that appears
    // later fails the inventory check after the pass and gets another pass; a
    // media file that appears later raises a watcher event, and the pass
    // that event runs lists the files again.
    let mut media_resolver =
        media_refs::MediaResolver::with_link_index(vault, keep_files(vault.root(), listed));
    let mut unchanged = 0usize;
    let mut errors = Vec::new();
    for (path, message) in &identity.read_errors {
        errors.push(file_error(
            path,
            ReconcileFileErrorKind::Read,
            message.clone(),
        ));
    }
    let mut content_reads = 0usize;
    let mut deferred = Vec::new();
    let mut in_cloud = Vec::new();

    for (path_index, (path, slug)) in paths.iter().zip(&slugs).enumerate() {
        on_progress(path_index + 1, total_paths);
        if path.file_stem().and_then(|value| value.to_str()).is_none() {
            errors.push(file_error(
                path,
                ReconcileFileErrorKind::Metadata,
                "Markdown filename is not valid UTF-8",
            ));
            continue;
        }
        let slug = match slug {
            Ok(slug) => slug,
            Err(error) => {
                errors.push(file_error(
                    path,
                    ReconcileFileErrorKind::Metadata,
                    error.to_string(),
                ));
                continue;
            }
        };
        live_slugs.insert(slug.clone());

        let markdown_stamp = match FileStamp::read(path) {
            Ok(stamp) => stamp,
            Err(error) => {
                errors.push(file_error(
                    path,
                    ReconcileFileErrorKind::Metadata,
                    error.to_string(),
                ));
                continue;
            }
        };

        let previous = stored.get(slug);
        let dependency_changed = previous
            .filter(|state| state.stamp.markdown == markdown_stamp)
            .is_some_and(|state| dependencies_changed(vault, &state.stamp.dependencies));
        let projection_stale =
            previous.is_some_and(|state| indexed_kinds.get(slug) != Some(&state.kind));
        let source_changed = previous.map_or(true, |state| state.stamp.markdown != markdown_stamp)
            || dependency_changed
            || projection_stale
            || identity_affected.contains(slug);
        if !source_changed {
            unchanged += 1;
            continue;
        }
        // A note iCloud took away is not read holding the index. An action
        // does not wait for it at all: it stays as the index holds it, for
        // the background pass (Х12). A background pass brings it down with
        // the index let go, then starts again (Х24).
        if evicted != EvictedNotes::ReadHere
            && crate::storage::cloud_files::is_content_offloaded(path)
        {
            match evicted {
                EvictedNotes::Defer => deferred.push(path.clone()),
                EvictedNotes::BringDownFirst | EvictedNotes::ReadHere => {
                    in_cloud.push(path.clone());
                }
            }
            continue;
        }
        if !in_cloud.is_empty() {
            // The pass starts again once these come down: nothing it reads
            // now is kept.
            continue;
        }

        content_reads += 1;
        match prepare_source(
            vault,
            path,
            markdown_stamp,
            dependency_changed,
            &mut media_resolver,
        ) {
            Ok(source) => prepared.push(source),
            // The read could not bring the contents down: iCloud refused it
            // (`EDEADLK`) or has not delivered them. The note is not one that
            // cannot be read; it waits as the index holds it, like a note an
            // action leaves, and a later pass reads it once it is here
            // (SPEC_CLOUD_STORAGE.md, «Отказ чтения»). Until 17.11.2026 such a
            // note, asked for a moment before, was named in «Could not read 1
            // note».
            Err(error)
                if error.kind == ReconcileFileErrorKind::Read
                    && crate::storage::cloud_files::is_content_offloaded(path) =>
            {
                deferred.push(path.clone());
            }
            Err(error) => errors.push(error),
        }
    }
    if !in_cloud.is_empty() {
        return Ok(SourcePass {
            report: ReconcileReport {
                inventory_markdown: live_slugs.len(),
                unchanged,
                upserted: Vec::new(),
                removed: Vec::new(),
                dependency_changed: Vec::new(),
                errors,
                content_reads,
                database_writes: 0,
                elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            },
            deferred,
            in_cloud,
            wrote: false,
        });
    }
    // The background pass will read the changed notes left here: iCloud
    // brings them meanwhile. The new ones were asked for above.
    let changed_in_cloud = deferred
        .iter()
        .filter(|path| {
            vault
                .slug_for_path(path)
                .is_ok_and(|slug| stored.contains_key(&slug))
        })
        .map(PathBuf::as_path)
        .collect::<Vec<_>>();
    if !changed_in_cloud.is_empty() {
        crate::storage::icloud_downloads::request_downloads(changed_in_cloud);
    }

    let prepared_slugs = prepared
        .iter()
        .map(|source| source.slug.as_str())
        .collect::<BTreeSet<_>>();
    let mut channel_slugs = stored
        .iter()
        .filter(|(slug, state)| {
            live_slugs.contains(*slug)
                && state.kind == SourceKind::Channel
                && !prepared_slugs.contains(slug.as_str())
        })
        .map(|(slug, _)| slug.clone())
        .collect::<BTreeSet<_>>();
    channel_slugs.extend(
        prepared
            .iter()
            .filter(|source| source.kind == SourceKind::Channel)
            .map(|source| source.slug.clone()),
    );
    let removed = indexed_kinds
        .keys()
        .chain(stored.keys())
        .filter(|slug| !live_slugs.contains(*slug))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let moved = &identity.moved_markdown;

    for slug in &channel_slugs {
        live_channel_refs.insert(
            channel_ref_for_slug(media_resolver.link_index(), slug)
                .map_err(ReconcileError::State)?,
        );
    }
    // A channel row no live document backs is a phantom, swept below. Whether
    // there is one is read first: a pass with nothing to write opens no
    // transaction and leaves the readiness flag alone (SPEC_STORAGE.md,
    // «Проход без изменений»).
    let phantom_channels = channel_rows_without_documents(conn, &live_channel_refs)
        .map_err(ReconcileError::State)?;
    if prepared.is_empty() && removed.is_empty() && moved.is_empty() && !phantom_channels {
        return Ok(SourcePass {
            report: ReconcileReport {
                inventory_markdown: live_slugs.len(),
                unchanged,
                upserted: Vec::new(),
                removed,
                dependency_changed: Vec::new(),
                errors,
                content_reads,
                database_writes: 0,
                elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            },
            deferred,
            in_cloud,
            wrote: false,
        });
    }

    // The index is not ready from its first write until the check after the
    // pass (SPEC_STORAGE.md, «Готовность пересборки»).
    readiness.lower().map_err(ReconcileError::State)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| ReconcileError::Commit(error.into()))?;
    let mut upserted = Vec::with_capacity(prepared.len());
    let mut dependency_changed_slugs = Vec::new();
    let mut database_writes = 0usize;
    let mut renamed = 0usize;
    let mut committed_sources = Vec::new();

    for (old_slug, new_slug) in moved {
        if indexed_kinds.get(old_slug) == Some(&SourceKind::Block)
            && indexed_kinds.get(new_slug).is_none()
        {
            index::rename_slug(&tx, old_slug, new_slug)
                .with_context(|| format!("preserve moved source identity {old_slug} -> {new_slug}"))
                .map_err(ReconcileError::Commit)?;
            renamed += 1;
        }
    }

    for source in prepared {
        match apply_prepared_source(&tx, &source, &mut media_resolver) {
            Ok(()) => {
                if source.dependency_changed {
                    dependency_changed_slugs.push(source.slug.clone());
                }
                committed_sources.push((source.kind, source.block.clone()));
                upserted.push(source.slug);
                database_writes += 1;
            }
            Err(error) => errors.push(ReconcileFileError {
                path: source.path,
                kind: ReconcileFileErrorKind::Index,
                message: format!("{error:#}"),
            }),
        }
    }

    for (old_slug, new_slug) in moved {
        if let Err(error) = files::rename_derived_artifacts(vault, old_slug, new_slug) {
            log::warn!("failed to carry derived artifacts {old_slug} -> {new_slug}: {error:#}");
        }
    }

    // The folder may have been renamed while the inventory ran: an empty or
    // partial listing then reads as mass deletion. Removing anything needs the
    // space to still be there, or the whole pass rolls back (П29).
    if !removed.is_empty() {
        crate::storage::root_guard::ensure_root_present(vault)?;
    }
    for slug in &removed {
        index::remove_block(&tx, slug)
            .with_context(|| format!("remove stale block {slug}"))
            .map_err(ReconcileError::Commit)?;
        remove_channel_if_orphaned(&tx, &mut media_resolver, slug)
            .with_context(|| format!("remove stale channel {slug}"))
            .map_err(ReconcileError::Commit)?;
        tx.execute("DELETE FROM source_index_state WHERE slug = ?1", [slug])
            .with_context(|| format!("remove stale source state {slug}"))
            .map_err(ReconcileError::Commit)?;
        database_writes += 1;
    }

    // A channel row no live document backs is a phantom. The per-file cleanup
    // above only fires when a file vanishes, so a row keyed by a
    // folder-qualified slug from before collections were identified by name —
    // which never matched any file — outlives every such cleanup. Phantoms are
    // not cosmetic: a phantom's tag resolves to the real collection's document,
    // a reorder then plans two writes to one path, and the whole reorder is
    // refused — the sidebar shows a duplicate collection that also blocks
    // repositioning everything else.
    let swept = index::sweep_channels_without_documents(&tx, &live_channel_refs)
        .context("sweep phantom channels")
        .map_err(ReconcileError::Commit)?;
    database_writes += swept.len();

    tx.commit()
        .context("commit VaultReconciler transaction")
        .map_err(ReconcileError::Commit)?;

    for (kind, block) in committed_sources {
        match kind {
            SourceKind::Block => {
                let _ = article_audio::invalidate_for_block(vault, &block);
            }
            SourceKind::Channel => {
                let _ = article_audio::delete_all_artifacts(vault, &block.slug);
            }
        }
    }
    for slug in &removed {
        // A row whose slug names no file of the space (a damaged index) has
        // no derived files either: its preview path cannot even be formed.
        if crate::domain::vault::validate_slug(slug).is_err() {
            continue;
        }
        let _ = std::fs::remove_file(vault.thumb_path(slug));
        let _ = article_audio::delete_all_artifacts(vault, slug);
    }

    let report = ReconcileReport {
        inventory_markdown: live_slugs.len(),
        unchanged,
        upserted,
        removed,
        dependency_changed: dependency_changed_slugs,
        errors,
        content_reads,
        database_writes,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    };
    let wrote = report.database_writes > 0 || renamed > 0;
    Ok(SourcePass {
        report,
        deferred,
        in_cloud,
        wrote,
    })
}

/// Whether the table of collections holds a row whose name is none of
/// `live_refs`, the names of the collection pages a pass saw on disk: what
/// `index::sweep_channels_without_documents` removes.
fn channel_rows_without_documents(conn: &Connection, live_refs: &BTreeSet<String>) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT tag FROM channels")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if !live_refs.contains(&row.get::<_, String>(0)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Bring down the notes a pass found it must read whose contents are in
/// iCloud: new to the index or changed since the last pass
/// (SPEC_CLOUD_STORAGE.md, Х12, Х24). The pass has let the index go
/// (`build.lock`): iCloud is asked for all of them at once, and each is read
/// once it arrives, with no lock held. The pass then starts again and reads
/// them from this Mac, and an action that comes meanwhile does not wait
/// behind the download. Until 13.10.2026 the pass read them holding the
/// lock, and every action of the space, the CLI's too, waited for the
/// download; until 15.11.2026 a walk of its own looked for them before every
/// pass, whether there were any or not. A note that cannot be read here is
/// left to the pass, which reports it; a note whose read iCloud refuses
/// (`EDEADLK`) or which has not arrived is left to wait: the pass that
/// follows meets it still in iCloud and leaves it as the index holds it.
fn bring_down(vault: &VaultLayout, notes: &[PathBuf]) {
    let accepted =
        crate::storage::icloud_downloads::request_downloads(notes.iter().map(PathBuf::as_path));
    log::info!(
        "bringing down {} notes from iCloud ({accepted} requests accepted) before the pass of {}",
        notes.len(),
        vault.root().display()
    );
    for path in notes {
        if let Err(error) = files::read_block_file(vault, path) {
            log::debug!("{} did not come down before the pass: {error:#}", path.display());
        }
    }
}

/// Whether the note at `path` is, by its metadata (size, time), the note the
/// index last read: a pass would not read it. iCloud keeps both when it takes
/// a note's contents away, so the watcher's event about an evicted note that
/// is unchanged is no news (SPEC_CLOUD_STORAGE.md, «Отказ чтения»). A note
/// the index has no state for, or that cannot be stat'ed, is not unchanged.
pub fn note_unchanged_since_indexed(conn: &Connection, vault: &VaultLayout, path: &Path) -> bool {
    let Ok(slug) = vault.slug_for_path(path) else {
        return false;
    };
    let Ok(stamp) = FileStamp::read(path) else {
        return false;
    };
    let stored = conn
        .query_row(
            "SELECT source_stamp FROM source_index_state WHERE slug = ?1",
            [&slug],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str::<SourceStamp>(&raw).ok());
    stored.is_some_and(|stored| stored.markdown == stamp)
}

/// Project one already-committed Markdown source and its dependency stamp.
///
/// In-app source mutations use this helper inside their SQLite transaction so
/// route visibility does not wait for a later watcher or full-vault catch-up.
pub fn project_source_path(conn: &Connection, vault: &VaultLayout, path: &Path) -> Result<Block> {
    let markdown_stamp = FileStamp::read(path)
        .with_context(|| format!("read source metadata for {}", path.display()))?;
    let mut media_resolver = media_refs::MediaResolver::new(vault);
    let source = prepare_source(vault, path, markdown_stamp, false, &mut media_resolver)
        .map_err(|error| anyhow::anyhow!("prepare source {}: {}", path.display(), error.message))?;
    apply_prepared_source(conn, &source, &mut media_resolver)?;
    Ok(source.block)
}

/// Record, in the source stamp of an indexed card, the dependencies the
/// current parse of its indexed text names, after a migration derived the
/// card again from that text (`index::backfill_media_index`;
/// `SPEC_AUDIT_FIXES.md`, Д1.5).
///
/// A pass reads a note again only when its Markdown or a recorded dependency
/// changes, so dependencies an older parse recorded would hide every edit to
/// a file only the new parse reads. The Markdown stamp stays: the note was
/// not read again. A file the new parse names is recorded as it is now, as
/// the migration has just measured it; a dependency already recorded keeps
/// its recorded state, so a change made before still reads as one; and the
/// dependencies only the older parse named stay too: the index does not hold
/// the front matter's `source_media`, and a dependency too many costs at most
/// one more reading of the note. A card without a stamp is left to the next
/// pass, which reads it anyway. A dependency outside the space drops the
/// stamp, so the next pass reads the note and reports it as an index of the
/// note from scratch would.
pub(crate) fn rederive_source_dependencies(
    conn: &Connection,
    vault: &VaultLayout,
    block: &Block,
    media_resolver: &mut media_refs::MediaResolver<'_>,
) -> Result<()> {
    let stored: Option<(String, String)> = conn
        .query_row(
            "SELECT source_kind, source_stamp FROM source_index_state WHERE slug = ?1",
            [&block.slug],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((kind_raw, stamp_raw)) = stored else {
        return Ok(());
    };
    let kind = SourceKind::from_str(&kind_raw)
        .with_context(|| format!("unknown source kind '{kind_raw}' for {}", block.slug))?;
    let mut stamp: SourceStamp = serde_json::from_str(&stamp_raw)
        .with_context(|| format!("invalid source stamp for {}", block.slug))?;
    let Ok(current) = collect_dependency_paths(vault, block, media_resolver) else {
        conn.execute("DELETE FROM source_index_state WHERE slug = ?1", [&block.slug])
            .with_context(|| format!("drop the source state of {}", block.slug))?;
        return Ok(());
    };
    let mut dependencies = stamp
        .dependencies
        .drain(..)
        .map(|dependency| (dependency.vault_relative_path.clone(), dependency))
        .collect::<BTreeMap<_, _>>();
    for (relative, absolute) in current {
        dependencies
            .entry(relative.clone())
            .or_insert_with(|| DependencyStamp::read(relative, &absolute));
    }
    stamp.dependencies = dependencies.into_values().collect();
    write_source_state(conn, &block.slug, kind, &stamp)
}

/// Drop a channel row only when no document answers to that name any more.
///
/// A collection is keyed by name while its document is keyed by path, so a
/// document that moves disappears under its old slug and reappears under a new
/// one. When the old slug happens to equal the collection's name — which is
/// exactly what sorting a flat vault into folders produces — the cleanup for
/// the vanished path would delete the collection that the moved document had
/// just registered.
fn remove_channel_if_orphaned(
    conn: &Connection,
    media_resolver: &mut media_refs::MediaResolver<'_>,
    slug: &str,
) -> Result<()> {
    let mut stmt = conn.prepare("SELECT tag FROM channels WHERE source_slug = ?1")?;
    let tags = stmt
        .query_map([slug], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let had_exact = !tags.is_empty();
    for tag in tags {
        index::remove_channel(conn, &tag)?;
    }
    if had_exact {
        return Ok(());
    }
    let collection_ref = crate::domain::collection::collection_ref_from_slug(slug);
    if media_resolver
        .resolve_collection_document(&collection_ref)
        .is_some()
    {
        return Ok(());
    }
    index::remove_channel(conn, &collection_ref)?;
    Ok(())
}

/// Remove every projection row owned by a deleted Markdown source.
///
/// This is nestable inside a larger source mutation transaction.
pub fn remove_source_projection(conn: &Connection, vault: &VaultLayout, slug: &str) -> Result<()> {
    index::remove_block(conn, slug).with_context(|| format!("remove stale block {slug}"))?;
    remove_channel_if_orphaned(conn, &mut media_refs::MediaResolver::new(vault), slug)
        .with_context(|| format!("remove stale channel {slug}"))?;
    conn.execute("DELETE FROM source_index_state WHERE slug = ?1", [slug])
        .with_context(|| format!("remove stale source state {slug}"))?;
    Ok(())
}

fn prepare_source(
    vault: &VaultLayout,
    path: &Path,
    markdown_stamp: FileStamp,
    dependency_changed: bool,
    media_resolver: &mut media_refs::MediaResolver<'_>,
) -> std::result::Result<PreparedSource, ReconcileFileError> {
    let (slug, content) = files::read_block_file(vault, path)
        .map_err(|error| file_error(path, ReconcileFileErrorKind::Read, error.to_string()))?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(path))
        .map_err(|error| file_error(path, ReconcileFileErrorKind::Parse, error.to_string()))?;
    let dependency_paths =
        collect_dependency_paths(vault, &parsed.block, media_resolver).map_err(|message| {
            file_error(
                path,
                ReconcileFileErrorKind::DependencyOutsideVault,
                message,
            )
        })?;
    let stamp = SourceStamp {
        markdown: markdown_stamp,
        dependencies: dependency_paths
            .into_iter()
            .map(|(relative, absolute)| DependencyStamp::read(relative, &absolute))
            .collect(),
    };
    let mut block = parsed.block;
    files::normalize_block_media_refs_for_index(media_resolver, &mut block);
    let kind = if block.frontmatter.block_type == BlockType::Channel {
        SourceKind::Channel
    } else {
        SourceKind::Block
    };
    Ok(PreparedSource {
        path: path.to_string_lossy().into_owned(),
        slug,
        kind,
        block,
        origin: parsed.origin,
        index_warning: parsed.index_warning,
        stamp,
        dependency_changed,
    })
}

/// Pair vanished slugs with newly appeared ones that carry the same content.
///
/// Only unambiguous pairs count: one gone, one arrived, same body hash. Two
/// identical files moving at once, or a copy left behind, leave everything to
/// the ordinary delete-and-create path rather than guessing.
fn apply_prepared_source(
    conn: &Connection,
    source: &PreparedSource,
    media_resolver: &mut media_refs::MediaResolver<'_>,
) -> Result<()> {
    conn.execute_batch("SAVEPOINT reconcile_source")
        .context("begin source reconciliation savepoint")?;
    let result = (|| -> Result<()> {
        match source.kind {
            SourceKind::Block => {
                index::remove_channel(conn, &source.slug).with_context(|| {
                    format!("remove stale channel projection for {}", source.slug)
                })?;
                index::upsert_block_with_resolver(
                    conn,
                    &source.block,
                    media_resolver,
                    Some(&source.origin),
                    source.index_warning.as_deref(),
                )
                .with_context(|| format!("upsert block {}", source.slug))?;
            }
            SourceKind::Channel => {
                index::remove_block(conn, &source.slug).with_context(|| {
                    format!("remove stale block projection for {}", source.slug)
                })?;
                let collection_ref =
                    channel_ref_for_slug(media_resolver.link_index(), &source.slug)?;
                index::upsert_channel_from_block_with_ref(conn, &source.block, &collection_ref)
                    .with_context(|| format!("upsert channel {}", source.slug))?;
            }
        }
        write_source_state(conn, &source.slug, source.kind, &source.stamp)
            .with_context(|| format!("write source state for {}", source.slug))?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("RELEASE SAVEPOINT reconcile_source")
            .context("release source reconciliation savepoint"),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT reconcile_source");
            let _ = conn.execute_batch("RELEASE SAVEPOINT reconcile_source");
            Err(error)
        }
    }
}

fn collect_dependency_paths(
    vault: &VaultLayout,
    block: &Block,
    media_resolver: &mut media_refs::MediaResolver<'_>,
) -> std::result::Result<Vec<(String, PathBuf)>, String> {
    let mut paths = BTreeMap::<String, PathBuf>::new();
    for reference in [
        block.frontmatter.file.as_deref(),
        block.frontmatter.thumbnail.as_deref(),
        block.frontmatter.source_media.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(path) = media_resolver
            .resolve_frontmatter_media(&block.slug, reference)
            .or_else(|| vault.resolve_local_reference(&block.slug, reference))
        {
            insert_dependency(vault, &mut paths, path)?;
        }
    }
    for reference in iter_inline_media_references(&block.body) {
        if reference.source.starts_with("http://") || reference.source.starts_with("https://") {
            continue;
        }
        if let Some(path) = media_resolver
            .resolve_inline_media(&block.slug, &reference)
            .or_else(|| vault.resolve_local_reference(&block.slug, &reference.source))
        {
            insert_dependency(vault, &mut paths, path)?;
        }
    }
    Ok(paths.into_iter().collect())
}

fn insert_dependency(
    vault: &VaultLayout,
    paths: &mut BTreeMap<String, PathBuf>,
    path: PathBuf,
) -> std::result::Result<(), String> {
    let relative = vault
        .root_relative_reference(&path)
        .ok_or_else(|| format!("dependency escapes vault: {}", path.display()))?;
    paths.insert(relative, path);
    Ok(())
}

fn dependencies_changed(vault: &VaultLayout, dependencies: &[DependencyStamp]) -> bool {
    dependencies.iter().any(|dependency| {
        let path = vault.root().join(&dependency.vault_relative_path);
        let current = FileStamp::read(&path).ok();
        current != dependency.file
            || (dependency.offloaded
                && current.is_some()
                && !crate::storage::cloud_files::is_content_offloaded(&path))
    })
}

fn load_source_states(conn: &Connection) -> Result<BTreeMap<String, StoredSourceState>> {
    let mut stmt = conn
        .prepare("SELECT slug, source_kind, source_stamp FROM source_index_state ORDER BY slug")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut states = BTreeMap::new();
    for row in rows {
        let (slug, kind_raw, stamp_raw) = row?;
        let kind = SourceKind::from_str(&kind_raw)
            .with_context(|| format!("unknown source kind '{kind_raw}' for {slug}"))?;
        let stamp = serde_json::from_str(&stamp_raw)
            .with_context(|| format!("invalid source stamp for {slug}"))?;
        states.insert(slug, StoredSourceState { kind, stamp });
    }
    Ok(states)
}

fn load_indexed_kinds(conn: &Connection) -> Result<BTreeMap<String, SourceKind>> {
    let mut kinds = BTreeMap::new();
    let mut block_stmt = conn.prepare("SELECT slug FROM blocks")?;
    for slug in block_stmt.query_map([], |row| row.get::<_, String>(0))? {
        kinds.insert(slug?, SourceKind::Block);
    }
    let mut channel_stmt = conn.prepare("SELECT COALESCE(source_slug, tag) FROM channels")?;
    for slug in channel_stmt.query_map([], |row| row.get::<_, String>(0))? {
        kinds.insert(slug?, SourceKind::Channel);
    }
    Ok(kinds)
}

fn write_source_state(
    conn: &Connection,
    slug: &str,
    kind: SourceKind,
    stamp: &SourceStamp,
) -> Result<()> {
    let names = dependency_names(stamp);
    let stamp = serde_json::to_string(stamp)?;
    conn.execute(
        "INSERT INTO source_index_state (slug, source_kind, source_stamp)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(slug) DO UPDATE SET
            source_kind = excluded.source_kind,
            source_stamp = excluded.source_stamp,
            updated_at = datetime('now')",
        params![slug, kind.as_str(), stamp],
    )?;
    // The names the note is found by go with its stamp, in the caller's
    // transaction. Changing the stamp row took the note's earlier names out
    // (trigger `source_dependency_names_au`), so these are all of them.
    let mut insert = conn.prepare_cached(
        "INSERT OR IGNORE INTO source_dependency_names (name, slug) VALUES (?1, ?2)",
    )?;
    for name in names {
        insert.execute(params![name, slug])?;
    }
    Ok(())
}

/// The date a note without `saved_at` is read under: when its file was
/// created, else last modified. A command that writes a note reads it back
/// under the same date, so its index row is the one reconciliation makes.
pub(crate) fn file_saved_at(path: &Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(SystemTime::now);
    let serialized = crate::util::system_time_to_iso8601(time);
    DateTime::new(&serialized)
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").expect("valid epoch"))
}

fn file_error(
    path: &Path,
    kind: ReconcileFileErrorKind,
    message: impl Into<String>,
) -> ReconcileFileError {
    ReconcileFileError {
        path: path.to_string_lossy().into_owned(),
        kind,
        message: message.into(),
    }
}

/// The space the limits of a pass are timed on (AUDIT_PERFORMANCE.md, раздел
/// 6): 10 000 notes of about 3 KB of prose, 30 MB in all, in the layout of
/// three folders. Half are picture cards with a file of their own, a quarter
/// links with a thumbnail, the rest articles, every third of them with a
/// picture in its text; a note is in up to three of 100 collections. The same
/// make-up as the set of the file identity limits (`file_identity.rs`).
#[cfg(test)]
pub(crate) mod timed_space {
    use std::path::Path;

    pub(crate) const NOTES: usize = 10_000;
    pub(crate) const COLLECTIONS: usize = 100;
    const NOTE_PROSE_BYTES: usize = 3_000;

    /// The media file of the note `note`, relative to the space, when the
    /// note shows one.
    pub(crate) fn media_of(note: usize) -> Option<String> {
        match note % 4 {
            0 | 1 => Some(format!("Media/picture-{note:05}.jpg")),
            2 => Some(format!("Media/thumbnail-{note:05}.png")),
            _ if note % 3 == 0 => Some(format!("Media/inline-{note:05}.jpg")),
            _ => None,
        }
    }

    /// Write the timed space under `root`; returns how many media files it
    /// holds.
    pub(crate) fn write(root: &Path) -> usize {
        write_notes(root, NOTES)
    }

    /// Write a space of the same make-up with `notes` notes under `root`:
    /// what a limit that must not grow with the space is timed on beside
    /// the timed space itself. Returns how many media files it holds.
    pub(crate) fn write_notes(root: &Path, notes: usize) -> usize {
        for folder in ["Collections", "Cards", "Media"] {
            std::fs::create_dir_all(root.join(folder)).expect("a folder of the timed space");
        }
        for collection in 0..COLLECTIONS {
            std::fs::write(
                root.join(format!("Collections/Collection {collection:03}.md")),
                "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\n---\n",
            )
            .expect("a collection of the timed space");
        }
        let sentence = "Город стоит на реке, и дома вдоль набережной смотрят в воду. A plain sentence of prose follows it. ";
        let prose = sentence.repeat(NOTE_PROSE_BYTES / sentence.len());
        let mut media = 0;
        for note in 0..notes {
            let mut front = String::from("---\nsaved_at: 2026-07-10T00:00:00Z\n");
            let mut body = format!("# Note {note:05}\n\n");
            if let Some(file) = media_of(note) {
                std::fs::write(root.join(&file), b"media").expect("a media file of the timed space");
                media += 1;
                let name = file.trim_start_matches("Media/");
                match note % 4 {
                    0 | 1 => front.push_str(&format!("type: image\nfile: \"[[{name}]]\"\n")),
                    2 => front.push_str(&format!("type: link\nthumbnail: \"[[{name}]]\"\n")),
                    _ => {
                        front.push_str("type: article\n");
                        body.push_str(&format!("![[{name}]]\n\n"));
                    }
                }
            } else {
                front.push_str("type: article\n");
            }
            let collections = note % 4;
            if collections > 0 {
                front.push_str("Mine Collections:\n");
                for offset in 0..collections {
                    front.push_str(&format!(
                        "  - \"[[Collection {:03}]]\"\n",
                        (note * 7 + offset * 31) % COLLECTIONS
                    ));
                }
            }
            front.push_str("---\n");
            std::fs::write(
                root.join(format!("Cards/Note {note:05}.md")),
                format!("{front}{body}{prose}\n"),
            )
            .expect("a note of the timed space");
        }
        media
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::channel::Channel;
    use crate::domain::search::parse_search_query;
    use crate::storage::db;
    use crate::storage::graph;
    use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn setup() -> (TempDir, VaultLayout, Connection) {
        let dir = TempDir::new().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        (dir, vault, conn)
    }

    /// SPEC_CLOUD_STORAGE.md, Х12: an action's pass reads no note iCloud
    /// took away. A note new to the index or changed since the last pass
    /// stays as the index holds it, for the background pass, which reads it.
    /// An index never built is not called ready by an action that left notes
    /// unread; a built one stays ready.
    #[test]
    fn an_actions_pass_leaves_evicted_notes_to_the_background_pass() {
        use crate::storage::cloud_files::test_seam;
        let (_dir, vault, conn) = setup();
        std::fs::write(vault.root().join("Here.md"), "# Here\n\nLocal text.\n").unwrap();
        let away = vault.root().join("Away.md");
        std::fs::write(&away, "# Away\n\nFirst text.\n").unwrap();
        test_seam::mark_offloaded(&away);

        let pass = reconcile_vault_for_action(&conn, &vault).unwrap();
        assert_eq!(pass.deferred, [away.clone()]);
        assert!(!db::index_is_ready(&conn).unwrap());
        assert!(index::get_block(&conn, "Here").unwrap().is_some());
        assert!(index::get_block(&conn, "Away").unwrap().is_none());
        assert_eq!(test_seam::reads_of(&away), 0);

        reconcile_vault(&conn, &vault).unwrap();
        assert!(db::index_is_ready(&conn).unwrap());
        assert!(index::get_block(&conn, "Away").unwrap().is_some());

        std::fs::write(&away, "# Away\n\nChanged on another Mac.\n").unwrap();
        test_seam::mark_offloaded(&away);
        let pass = reconcile_vault_for_action(&conn, &vault).unwrap();
        assert_eq!(pass.deferred, [away.clone()]);
        assert!(db::index_is_ready(&conn).unwrap());
        assert!(index::get_block(&conn, "Away").unwrap().unwrap().body.contains("First text"));
        assert_eq!(test_seam::reads_of(&away), 1, "only the background pass read it");

        reconcile_vault(&conn, &vault).unwrap();
        assert!(index::get_block(&conn, "Away").unwrap().unwrap().body.contains("another Mac"));
    }

    /// П29: a space renamed in Finder reads as every card deleted. Nothing is
    /// removed; the index and the previews wait for the folder to be found.
    #[test]
    fn a_renamed_space_keeps_its_index_and_previews() {
        const ID: &str = "cea575682e5a4018991c0097fbedff66";
        let parent = TempDir::new().unwrap();
        let source = parent.path().join("Mine");
        std::fs::create_dir_all(source.join(".mine")).unwrap();
        std::fs::write(source.join(".mine/vault-id"), ID).unwrap();
        let derived_parent = TempDir::new().unwrap();
        let vault = VaultLayout::with_derived_root(source.clone(), derived_parent.path().join(ID));
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        write_note(&vault, "Note", "body");
        reconcile_vault(&conn, &vault).unwrap();
        std::fs::write(vault.thumb_path("Note"), b"preview").unwrap();

        std::fs::rename(&source, parent.path().join("Mine!")).unwrap();
        assert!(matches!(
            reconcile_vault(&conn, &vault),
            Err(ReconcileError::RootUnavailable(_))
        ));
        assert!(index::get_block(&conn, "Note").unwrap().is_some());
        // Still ready: reopening under the new name shows it at once (П31).
        assert!(db::index_is_ready(&conn).unwrap());
        assert_eq!(std::fs::read(vault.thumb_path("Note")).unwrap(), b"preview");
    }

    /// Х25: a picture whose contents are in iCloud gives the index no size,
    /// and indexing it is not what brings it down. Once its contents arrive,
    /// the next pass reads the size, though the file's size and date are
    /// what they were. The picture stands for an evicted one with its real
    /// contents on disk: any read of it would give the index its size.
    #[test]
    fn a_picture_in_icloud_gets_its_size_once_its_contents_arrive() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("Space");
        std::fs::create_dir_all(&root).unwrap();
        let vault = VaultLayout::with_derived_root(root.clone(), tmp.path().join("derived"));
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let picture = root.join("cloud.png");
        image::RgbImage::new(3, 2).save(&picture).unwrap();
        crate::storage::cloud_files::test_seam::mark_offloaded(&picture);
        std::fs::write(
            root.join("Cloud.md"),
            "---\ntype: image\nfile: \"[[cloud.png]]\"\n---\n",
        )
        .unwrap();
        let size = |conn: &Connection| -> (Option<i64>, Option<i64>, Option<String>) {
            conn.query_row(
                "SELECT width, height, media_dimensions FROM blocks WHERE slug = 'Cloud'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        };

        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(size(&conn), (None, None, None), "indexing read the picture");

        // The contents arrive: the same file, its size and date unchanged.
        crate::storage::cloud_files::test_seam::mark_downloaded(&picture);

        reconcile_vault(&conn, &vault).unwrap();
        let (width, height, media) = size(&conn);
        assert_eq!((width, height), (Some(3), Some(2)));
        assert!(media.is_some_and(|json| json.contains("[3,2]")));
    }

    /// The first index of a large space must speak in numbers (О13): the
    /// callback walks every file, ends exactly on the total, and never runs
    /// backwards.
    #[test]
    fn reconcile_reports_monotonic_progress_over_the_inventory() {
        let (_dir, vault, conn) = setup();
        for index in 0..7 {
            write_note(&vault, &format!("note-{index}"), "body");
        }

        let seen = std::sync::Mutex::new(Vec::new());
        reconcile_vault_with_progress(&conn, &vault, &|processed, total| {
            seen.lock().unwrap().push((processed, total));
        })
        .unwrap();

        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), 7, "one report per file");
        assert!(seen.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(seen.iter().all(|(_, total)| *total == 7));
        assert_eq!(seen.last(), Some(&(7, 7)));
    }

    /// Resolving a note's media needs the list of every file in the space,
    /// and building that list walks the whole tree. Built per reference, a
    /// space of 673 notes and 1229 media files in iCloud Drive took minutes
    /// to index. A pass builds it once, whatever it reads or removes: since
    /// 15.11.2026 from the walk that lists its notes, with no walk of its
    /// own.
    #[test]
    fn a_pass_walks_the_space_once_however_many_notes_it_indexes() {
        const NOTES: usize = 6;
        let (_dir, vault, conn) = setup();
        for folder in ["Cards", "Media", "Collections"] {
            std::fs::create_dir_all(vault.root().join(folder)).unwrap();
        }
        std::fs::write(
            vault.root().join("Collections/Каталоги.md"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 1\n---\n",
        )
        .unwrap();
        let note = |index: usize| {
            format!(
                "---\ntype: image\nfile: \"[[photo-{index}.jpg]]\"\n\
                 thumbnail: cover-{index}.jpg\nsaved_at: 2026-07-10T00:00:00Z\n\
                 Mine Collections:\n  - \"[[Каталоги]]\"\n---\n\
                 ![[inline-{index}.png]] and ![](../Media/photo-{index}.jpg)\n"
            )
        };
        for index in 0..NOTES {
            for name in [
                format!("photo-{index}.jpg"),
                format!("cover-{index}.jpg"),
                format!("inline-{index}.png"),
            ] {
                std::fs::write(vault.root().join("Media").join(name), b"media").unwrap();
            }
            std::fs::write(vault.root().join(format!("Cards/Note {index}.md")), note(index))
                .unwrap();
        }

        let walked = || (inventory_walks(), media_refs::link_index_builds());
        let before = walked();
        let report = reconcile_vault(&conn, &vault).unwrap();
        let walks = (walked().0 - before.0, walked().1 - before.1);

        assert!(report.is_fresh(), "{report:?}");
        assert_eq!(report.upserted.len(), NOTES + 1, "every note and the collection");
        assert_eq!(walks, (1, 0), "one walk for the pass, none for a reference");
        // The shared snapshot resolves what a walk per reference resolved.
        let indexed = index::get_block(&conn, "Cards/Note 3").unwrap().unwrap();
        assert_eq!(indexed.media_file.as_deref(), Some("Media/photo-3.jpg"));
        assert_eq!(indexed.thumbnail.as_deref(), Some("Media/cover-3.jpg"));
        assert_eq!(
            indexed.media_urls.as_deref(),
            Some(r#"["Media/inline-3.png","Media/photo-3.jpg"]"#)
        );
        assert_eq!(index::list_channels(&conn).unwrap()[0].tag, "Каталоги");

        // A later pass that reads one note and removes another walks once too.
        std::fs::remove_file(vault.root().join("Cards/Note 0.md")).unwrap();
        std::fs::write(
            vault.root().join("Cards/Note 1.md"),
            format!("{}\nEdited.\n", note(1)),
        )
        .unwrap();
        let before = walked();
        let report = reconcile_vault(&conn, &vault).unwrap();
        let walks = (walked().0 - before.0, walked().1 - before.1);

        assert_eq!(report.upserted, vec!["Cards/Note 1".to_string()]);
        assert_eq!(report.removed, vec!["Cards/Note 0".to_string()]);
        assert_eq!(walks, (1, 0));
    }

    fn write_note(vault: &VaultLayout, slug: &str, body: &str) {
        std::fs::write(
            vault.block_path(slug),
            format!("---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn moving_a_card_between_folders_carries_its_preview_across() {
        let (_dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        write_note(&vault, "Note", "the very same words");
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();

        // Stand in for whatever the derived store keyed by this slug.
        std::fs::write(vault.thumb_path("Note"), b"preview").unwrap();

        std::fs::rename(vault.block_path("Note"), vault.block_path("Cards/Note")).unwrap();
        let report = reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();

        assert_eq!(report.upserted, vec!["Cards/Note"]);
        assert_eq!(report.removed, vec!["Note"]);
        // One card that moved, so its preview moved with it instead of being
        // thrown away and regenerated.
        assert!(!vault.thumb_path("Note").exists());
        assert_eq!(
            std::fs::read(vault.thumb_path("Cards/Note")).unwrap(),
            b"preview"
        );
    }

    #[test]
    fn two_identical_bodies_moving_at_once_keep_separate_source_identities() {
        let (_dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        write_note(&vault, "First", "identical");
        write_note(&vault, "Second", "identical");
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();
        std::fs::write(vault.thumb_path("First"), b"first").unwrap();

        std::fs::rename(vault.block_path("First"), vault.block_path("Cards/First")).unwrap();
        std::fs::rename(vault.block_path("Second"), vault.block_path("Cards/Second")).unwrap();
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();

        // Native file locators distinguish both notes despite identical bodies.
        assert_eq!(
            std::fs::read(vault.thumb_path("Cards/First")).unwrap(),
            b"first"
        );
        assert!(!vault.thumb_path("Cards/Second").exists());
    }

    #[test]
    fn an_edited_card_is_not_mistaken_for_a_move() {
        let (_dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        write_note(&vault, "Note", "original body");
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();
        std::fs::write(vault.thumb_path("Note"), b"preview").unwrap();

        std::fs::remove_file(vault.block_path("Note")).unwrap();
        write_note(&vault, "Cards/Note", "different body entirely");
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();

        // Same name, different content: a new card, and inheriting the old
        // preview would show the wrong picture.
        assert!(!vault.thumb_path("Cards/Note").exists());
    }

    #[test]
    fn reliability_pure_rebuild_preserves_history_and_runtime_repairs_offline_rename() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Target", "target content");
        write_note(&vault, "Source", "See [[Target]]");
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();
        std::fs::rename(vault.block_path("Target"), vault.block_path("Renamed")).unwrap();
        let before_source = std::fs::read(vault.block_path("Source")).unwrap();
        let before_target = std::fs::read(vault.block_path("Renamed")).unwrap();
        let history_path = vault.mine_dir().join("file-identity.json");
        let before_history = std::fs::read(&history_path).unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(
            std::fs::read(vault.block_path("Source")).unwrap(),
            before_source
        );
        assert_eq!(
            std::fs::read(vault.block_path("Renamed")).unwrap(),
            before_target
        );
        assert_eq!(std::fs::read(&history_path).unwrap(), before_history);
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();
        assert!(std::fs::read_to_string(vault.block_path("Source"))
            .unwrap()
            .contains("[[Renamed]]"));
        assert_eq!(
            std::fs::read(vault.block_path("Renamed")).unwrap(),
            before_target
        );
        let source = index::get_block(&conn, "Source").unwrap().unwrap();
        assert!(source.body.contains("[[Renamed]]"));
    }

    #[test]
    fn reliability_unknown_history_survives_runtime_and_index_recovery() {
        let (_dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        let history = vault.mine_dir().join("file-identity.json");
        std::fs::write(
            &history,
            br#"{"version":999,"files":[],"bindings":[],"future":"retain"}"#,
        )
        .unwrap();
        let before = std::fs::read(&history).unwrap();
        write_note(&vault, "Source", "# Still available");
        reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {}).unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(std::fs::read(history).unwrap(), before);
        assert!(index::get_block(&conn, "Source").unwrap().is_some());
    }

    #[test]
    fn moving_a_collection_document_into_a_folder_keeps_the_collection() {
        // Sorting a flat vault produces exactly this: the document vanishes from
        // `Каталоги` and reappears at `Collections/Каталоги`. The collection is
        // keyed by name, so the cleanup for the vanished slug was deleting the
        // very row the moved document had just registered — every collection
        // disappeared from the sidebar after the migration.
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Каталоги"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 1\n---\n",
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(index::list_channels(&conn).unwrap().len(), 1);

        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::rename(
            vault.block_path("Каталоги"),
            vault.root().join("Collections/Каталоги.md"),
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();

        let channels = index::list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1, "the collection must survive the move");
        assert_eq!(channels[0].tag, "Каталоги", "and keep the name cards use");
    }

    #[test]
    fn sweeps_a_phantom_channel_row_no_document_backs() {
        // The NSFV space after the layout migration: the real collection's
        // document lives at Collections/Видео.md, while the channels table
        // still holds a second row keyed by the folder-qualified slug from
        // before collections were identified by name. That row made the
        // sidebar show two collections named «Видео» and made every reorder
        // fail — its tag resolves to the real document, so the reorder planned
        // two writes to one path and the staged mutation refused it.
        let (_dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::write(
            vault.root().join("Collections/Видео.md"),
            "---\ntype: channel\nsaved_at: 2026-08-05T00:00:00Z\nposition: 0\n---\n",
        )
        .unwrap();
        let phantom = Channel::new(
            "Collections/Видео",
            DateTime::new("2026-08-05T00:00:00Z").unwrap(),
        )
        .unwrap();
        index::upsert_channel(&conn, &phantom).unwrap();

        reconcile_vault(&conn, &vault).unwrap();

        let channels = index::list_channels(&conn).unwrap();
        assert_eq!(
            channels
                .iter()
                .map(|ch| ch.tag.as_str())
                .collect::<Vec<_>>(),
            vec!["Видео"],
            "the phantom row goes, the real collection stays",
        );
    }

    #[test]
    fn sweeps_a_channel_row_whose_name_no_document_answers() {
        let (_dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::write(
            vault.root().join("Collections/Анимация.md"),
            "---\ntype: channel\nsaved_at: 2026-08-05T00:00:00Z\nposition: 1\n---\n",
        )
        .unwrap();
        let stale = Channel::new("Старый", DateTime::new("2026-08-05T00:00:00Z").unwrap()).unwrap();
        index::upsert_channel(&conn, &stale).unwrap();

        reconcile_vault(&conn, &vault).unwrap();

        let channels = index::list_channels(&conn).unwrap();
        assert_eq!(
            channels
                .iter()
                .map(|ch| ch.tag.as_str())
                .collect::<Vec<_>>(),
            vec!["Анимация"],
        );
    }

    #[test]
    fn deleting_a_collection_document_still_removes_the_collection() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Каталоги"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 1\n---\n",
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(index::list_channels(&conn).unwrap().len(), 1);

        std::fs::remove_file(vault.block_path("Каталоги")).unwrap();
        reconcile_vault(&conn, &vault).unwrap();

        assert!(index::list_channels(&conn).unwrap().is_empty());
    }

    #[test]
    fn direct_file_create_is_visible_and_second_pass_reads_no_content() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Disk Note", "first body");

        let first = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(first.upserted, vec!["Disk Note"]);
        assert_eq!(first.content_reads, 1);
        assert!(index::get_block(&conn, "Disk Note").unwrap().is_some());

        let second = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(second.unchanged, 1);
        assert_eq!(second.content_reads, 0);
        assert_eq!(second.database_writes, 0);
    }

    #[test]
    fn direct_file_edit_refreshes_indexed_body() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Edited", "old body");
        reconcile_vault(&conn, &vault).unwrap();

        write_note(&vault, "Edited", "new body with a different size");
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted, vec!["Edited"]);
        let indexed = index::get_block(&conn, "Edited").unwrap().unwrap();
        assert_eq!(indexed.body.trim(), "new body with a different size");
    }

    #[test]
    fn direct_file_delete_removes_stale_index_row() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Deleted", "body");
        reconcile_vault(&conn, &vault).unwrap();

        std::fs::remove_file(vault.block_path("Deleted")).unwrap();
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.removed, vec!["Deleted"]);
        assert!(index::get_block(&conn, "Deleted").unwrap().is_none());
    }

    #[test]
    fn unchanged_source_repairs_a_missing_projection() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Repair", "body");
        reconcile_vault(&conn, &vault).unwrap();
        index::remove_block(&conn, "Repair").unwrap();

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted, vec!["Repair"]);
        assert_eq!(report.content_reads, 1);
        assert!(index::get_block(&conn, "Repair").unwrap().is_some());
    }

    #[test]
    fn media_dependency_change_reindexes_without_markdown_change() {
        let (_dir, vault, conn) = setup();
        std::fs::write(vault.root().join("photo.jpg"), b"first").unwrap();
        std::fs::write(
            vault.block_path("Media Note"),
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\nwidth: 100\nheight: 100\n---\n![[photo.jpg]]",
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();

        std::fs::write(vault.root().join("photo.jpg"), b"changed dependency").unwrap();
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.dependency_changed, vec!["Media Note"]);
        assert_eq!(report.content_reads, 1);
    }

    #[test]
    fn missing_media_dependency_is_detected_when_it_appears() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Future Media"),
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\n![[future.jpg]]",
        )
        .unwrap();
        reconcile_vault(&conn, &vault).unwrap();

        std::fs::write(vault.root().join("future.jpg"), b"now present").unwrap();
        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.dependency_changed, vec!["Future Media"]);
        assert_eq!(report.content_reads, 1);
    }

    #[test]
    fn disk_only_markdown_reaches_every_route_projection_after_catch_up() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Research"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 0\n---",
        )
        .unwrap();
        std::fs::write(
            vault.block_path("Disk Route Note"),
            "---\ntype: article\nsaved_at: 2026-07-10T01:00:00Z\nMine Collections:\n  - \"[[Research]]\"\n---\n# Catch-up title\nfilesystem-needle",
        )
        .unwrap();
        assert!(index::get_block(&conn, "Disk Route Note")
            .unwrap()
            .is_none());

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted.len(), 2);
        assert!(index::get_block(&conn, "Disk Route Note")
            .unwrap()
            .is_some());
        assert!(index::list_grid_blocks(&conn, None, 0, 20)
            .unwrap()
            .0
            .iter()
            .any(|block| block.slug == "Disk Route Note"));
        assert!(
            index::search_blocks(&conn, &parse_search_query("filesystem-needle"))
                .unwrap()
                .iter()
                .any(|block| block.slug == "Disk Route Note")
        );
        assert!(index::get_all_tags(&conn)
            .unwrap()
            .iter()
            .any(|tag| tag.tag == "Research" && tag.count == 1));
        assert!(index::list_channels(&conn)
            .unwrap()
            .iter()
            .any(|channel| channel.tag == "Research"));
        let snapshot = graph::graph_snapshot(
            &conn,
            &graph::GraphScope::default(),
            &graph::GraphOptions::default(),
        )
        .unwrap();
        assert!(snapshot
            .nodes
            .iter()
            .any(|node| node.id == "card:Disk Route Note"));
        assert!(snapshot.links.iter().any(|link| {
            link.id == "collection_membership|collection:Research|card:Disk Route Note"
        }));
    }

    #[test]
    fn cold_metadata_only_link_has_stable_link_projection() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("ai-2027-3"),
            "---\ntype: link\ntitle: AI 2027\nurl: https://ai-2027.com/race\nsaved_at: 2026-03-12T19:19:25Z\nsource: web-clipper\n---",
        )
        .unwrap();

        let first = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(first.upserted, vec!["ai-2027-3"]);
        assert_eq!(first.content_reads, 1);

        let first_projection = index::get_block(&conn, "ai-2027-3").unwrap().unwrap();
        assert_eq!(
            first_projection.block_type,
            crate::domain::block::BlockType::Link
        );
        assert_eq!(
            first_projection.card_kind,
            crate::domain::block::CardKind::Link
        );
        let first_manifest: index::FeedPreviewManifest =
            serde_json::from_str(first_projection.preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(first_manifest.kind, index::FeedPreviewKind::Text);
        assert!(first_manifest.primary_preview_path.is_none());
        assert!(first_manifest.tiles.is_empty());

        let grid = index::list_grid_blocks(&conn, None, 0, 20).unwrap().0;
        assert_eq!(grid.len(), 1);
        assert_eq!(grid[0].card_kind, crate::domain::block::CardKind::Link);

        let second = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(second.unchanged, 1);
        assert_eq!(second.content_reads, 0);
        assert_eq!(second.database_writes, 0);
        let second_projection = index::get_block(&conn, "ai-2027-3").unwrap().unwrap();
        assert_eq!(second_projection.card_kind, first_projection.card_kind);
        assert_eq!(
            second_projection.preview_manifest,
            first_projection.preview_manifest
        );
    }

    #[test]
    fn one_index_failure_keeps_valid_sources_and_reports_degraded() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Good", "valid body");
        write_note(&vault, "Rejected", "valid source but rejected projection");
        conn.execute_batch(
            "CREATE TRIGGER reject_test_source
             BEFORE INSERT ON blocks
             WHEN new.slug = 'Rejected'
             BEGIN
                 SELECT RAISE(ABORT, 'injected index failure');
             END;",
        )
        .unwrap();

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert!(!report.is_fresh());
        assert_eq!(report.upserted, vec!["Good"]);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].kind, ReconcileFileErrorKind::Index);
        assert!(index::get_block(&conn, "Good").unwrap().is_some());
        assert!(index::get_block(&conn, "Rejected").unwrap().is_none());
    }

    /// Н6, Е5.1: a pass finished with an error in one note publishes the
    /// index ready and names that note. Before 13.10.2026 one unreadable
    /// note kept `ready=false` for good: every later pass met the same error,
    /// and the CLI and the clipper helper saw an index never built.
    #[test]
    fn a_pass_with_one_bad_note_publishes_the_index_ready_and_names_the_note() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Good", "valid body");
        write_note(&vault, "Locked", "unreadable body");
        let locked = vault.block_path("Locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let first = reconcile_vault(&conn, &vault);
        let first_ready = db::index_is_ready(&conn).unwrap();
        let second = reconcile_vault(&conn, &vault);
        let second_ready = db::index_is_ready(&conn).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();

        let first = first.unwrap();
        assert_eq!(first.errors.len(), 1, "{:?}", first.errors);
        assert!(first.errors[0].path.ends_with("Locked.md"), "{:?}", first.errors);
        assert_eq!(first.errors[0].kind, ReconcileFileErrorKind::Read);
        assert!(first_ready, "one bad note kept the index from being ready");
        assert_eq!(second.unwrap().errors.len(), 1);
        assert!(second_ready);
        assert!(index::get_block(&conn, "Good").unwrap().is_some());
    }

    /// Н6, Е5.1: notes that keep changing during the pass leave the index as
    /// ready as it was before it, not unready.
    #[test]
    fn sources_that_keep_changing_leave_readiness_as_it_was() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "A busy", "first");
        write_note(&vault, "B quiet", "first");
        reconcile_vault(&conn, &vault).unwrap();
        assert!(db::index_is_ready(&conn).unwrap());
        let edits = std::sync::atomic::AtomicUsize::new(0);
        // The first pass has a note to write, so the files are checked
        // against the index after it: a pass that writes nothing is its own
        // check (SPEC_STORAGE.md, «Проход без изменений»).
        write_note(&vault, "A busy", "edited before the pass");

        // Each pass reads `A busy` first; it changes again while the pass
        // reaches `B quiet`, so no pass ends on the files as they are.
        let outcome = reconcile_vault_with_progress(&conn, &vault, &|processed, total| {
            if processed == total {
                let edit = edits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                write_note(&vault, "A busy", &format!("edit {edit} {}", "x".repeat(edit + 1)));
            }
        });

        assert!(matches!(outcome, Err(ReconcileError::SourcesChanging { .. })), "{outcome:?}");
        assert!(db::index_is_ready(&conn).unwrap());
    }

    #[test]
    fn channel_pages_share_the_same_source_state_contract() {
        let (_dir, vault, conn) = setup();
        std::fs::write(
            vault.block_path("Research"),
            "---\ntype: channel\nsaved_at: 2026-07-10T00:00:00Z\nposition: 2\n---",
        )
        .unwrap();

        let first = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(first.upserted, vec!["Research"]);
        assert!(index::list_channels(&conn)
            .unwrap()
            .iter()
            .any(|channel| channel.tag == "Research"));

        let second = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(second.content_reads, 0);
        assert_eq!(second.unchanged, 1);
    }

    #[test]
    fn command_source_commit_and_reconciler_complete_without_deadlock() {
        let (_dir, vault, conn) = setup();
        write_note(&vault, "Concurrent", "old body");
        reconcile_vault(&conn, &vault).unwrap();
        drop(conn);

        let updated =
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\nnew concurrent body";
        let parsed = crate::domain::block::parse_block("Concurrent", updated).unwrap();
        let (write_locked_tx, write_locked_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let writer_vault = vault.clone();
        let writer_done = done_tx.clone();
        let writer = thread::spawn(move || {
            let writer_conn = db::open_or_create(&writer_vault.index_db_path()).unwrap();
            let path = writer_vault.block_path("Concurrent");
            let expected = std::fs::read(&path).unwrap();
            let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
                path,
                expected,
                updated.as_bytes().to_vec(),
            )])
            .unwrap();
            staged
                .commit_with_index(&writer_conn, "concurrent_test_write", |index_conn| {
                    write_locked_tx.send(()).unwrap();
                    thread::sleep(Duration::from_millis(150));
                    index::upsert_block(index_conn, &parsed, Some(writer_vault.root())).map(|_| ())
                })
                .unwrap();
            writer_done.send("writer").unwrap();
        });

        let reconcile_vault_layout = vault.clone();
        let reconcile_done = done_tx.clone();
        let reconciler = thread::spawn(move || {
            write_locked_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            let reconcile_conn =
                db::open_or_create(&reconcile_vault_layout.index_db_path()).unwrap();
            reconcile_vault(&reconcile_conn, &reconcile_vault_layout).unwrap();
            reconcile_done.send("reconciler").unwrap();
        });
        drop(done_tx);

        let first = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(first, second);
        writer.join().unwrap();
        reconciler.join().unwrap();

        let final_conn = db::open_or_create(&vault.index_db_path()).unwrap();
        reconcile_vault(&final_conn, &vault).unwrap();
        let indexed = index::get_block(&final_conn, "Concurrent")
            .unwrap()
            .unwrap();
        assert_eq!(indexed.body.trim(), "new concurrent body");
    }

    /// A space of three notes, one of them a collection page, indexed.
    fn indexed_space() -> (TempDir, VaultLayout, Connection) {
        let (dir, vault, conn) = setup();
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::write(
            vault.root().join("Collections/Видео.md"),
            "---\ntype: channel\nsaved_at: 2026-08-05T00:00:00Z\nposition: 0\n---\n",
        )
        .unwrap();
        std::fs::write(vault.root().join("picture.jpg"), b"picture").unwrap();
        write_note(&vault, "First", "![[picture.jpg]]\n");
        write_note(&vault, "Second", "second");
        let first = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(first.upserted.len(), 3);
        assert!(db::index_is_ready(&conn).unwrap());
        (dir, vault, conn)
    }

    /// SPEC_STORAGE.md, «Проход без изменений»: a pass over a space where
    /// nothing changed, the one before an action and the background one,
    /// walks the space once and writes nothing into the index, the readiness
    /// flag included. Until 15.11.2026 it wrote the flag twice and walked
    /// the space three times: for its notes, for the names of every file,
    /// and for the check after the pass.
    #[test]
    fn a_pass_that_finds_nothing_walks_the_space_once_and_writes_nothing() {
        let (_dir, vault, conn) = indexed_space();
        let written = conn.total_changes();
        let listed = media_refs::link_index_builds();
        let walked = inventory_walks();

        let action = reconcile_vault_for_action(&conn, &vault).unwrap();
        let background = reconcile_vault(&conn, &vault).unwrap();

        for report in [&action.report, &background] {
            assert_eq!(
                (report.unchanged, report.content_reads, report.database_writes),
                (3, 0, 0),
                "{report:?}"
            );
            assert!(report.is_fresh());
        }
        assert!(action.deferred.is_empty());
        assert_eq!(conn.total_changes(), written, "a pass that found nothing wrote into the index");
        assert_eq!(inventory_walks() - walked, 2, "one walk for each of the two passes");
        assert_eq!(media_refs::link_index_builds(), listed, "a pass walked again for names");
        assert!(db::index_is_ready(&conn).unwrap());
    }

    /// The one walk of a pass lists the notes the walk for notes listed and
    /// the files the walk for names listed: the same folders are skipped.
    #[test]
    fn the_walk_of_a_pass_lists_what_the_two_walks_listed() {
        let (_dir, vault, _conn) = setup();
        for file in [
            "Top.md",
            "Cards/Note.md",
            "Cards/Sub/Deep.md",
            "Cards/.hidden note.md",
            "Collections/Видео.md",
            "Media/photo.jpg",
            "Media/Sub/clip.mp4",
            "Media/.DS_Store",
            "Board.canvas",
            ".obsidian/workspace.md",
            ".mine/layout.json",
            "node_modules/pkg/readme.md",
            "target/built.md",
            "__pycache__/cached.md",
            "Cards/.trash/Gone.md",
        ] {
            let path = vault.root().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"file").unwrap();
        }

        let found = inventory(&vault).unwrap();

        assert_eq!(found.notes, files::scan_md_files(&vault).unwrap());
        assert_eq!(found.notes.len(), 5, "{:?}", found.notes);
        let sorted = |mut list: Vec<String>| {
            list.sort();
            list
        };
        assert_eq!(sorted(found.files), sorted(media_refs::list_files(vault.root())));
    }

    /// The index of names kept between passes is the one of the files the
    /// last pass listed: a pass that lists the same files gets the same
    /// index, and a pass that lists other files builds one of them, which
    /// replaces the kept one.
    #[test]
    fn a_pass_keeps_the_index_of_names_only_of_the_files_it_listed() {
        let (_dir, vault, _conn) = setup();
        let root = vault.root();
        let files = |names: &[&str]| names.iter().map(ToString::to_string).collect::<Vec<_>>();

        let first = keep_files(root, files(&["Cards/A.md", "Media/a.jpg"]));
        let same = keep_files(root, files(&["Media/a.jpg", "Cards/A.md"]));
        assert!(Arc::ptr_eq(&first, &same), "the same files built an index again");

        let more = keep_files(root, files(&["Cards/A.md", "Media/a.jpg", "Media/b.jpg"]));
        assert!(!Arc::ptr_eq(&first, &more));
        assert!(more.shortest_link("Media/b.jpg", false).is_some());
        let renamed = keep_files(root, files(&["Cards/A.md", "Media/a.jpg", "Media/c.jpg"]));
        assert!(renamed.shortest_link("Media/b.jpg", false).is_none(), "a file that is gone stayed");
        assert!(renamed.shortest_link("Media/c.jpg", false).is_some());
        let again = keep_files(root, files(&["Media/c.jpg", "Media/a.jpg", "Cards/A.md"]));
        assert!(Arc::ptr_eq(&renamed, &again));
    }

    /// An index whose flag says it is not ready, as an interrupted run of
    /// passes leaves it, is ready after a pass that finds every note as the
    /// index holds it: that pass is the check.
    #[test]
    fn a_pass_that_finds_nothing_makes_an_unready_index_ready() {
        let (_dir, vault, conn) = indexed_space();
        db::set_index_ready(&conn, false).unwrap();

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!((report.unchanged, report.database_writes), (3, 0));
        assert!(db::index_is_ready(&conn).unwrap());
    }

    /// A pass that wrote nothing is not followed by the check of the files
    /// against the index: a note edited once the pass has compared it is
    /// read by the next pass, not by a second pass of this run.
    #[test]
    fn a_pass_that_finds_nothing_is_not_checked_against_the_files_again() {
        let (_dir, vault, conn) = indexed_space();

        let report = reconcile_vault_with_progress(&conn, &vault, &|processed, total| {
            if processed == total {
                write_note(&vault, "First", "edited after the pass compared it");
            }
        })
        .unwrap();

        assert_eq!((report.unchanged, report.content_reads), (3, 0), "{report:?}");
        assert!(db::index_is_ready(&conn).unwrap());
        let next = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(next.upserted, ["First"]);
    }

    /// A pass that wrote into the index is checked against the files again,
    /// as before: a note edited while the pass wrote another one is read by
    /// a second pass of the same run, and the index is ready only after it.
    #[test]
    fn a_pass_that_writes_is_checked_against_the_files_again() {
        let (_dir, vault, conn) = indexed_space();
        write_note(&vault, "First", "edited before the pass");
        let edits = std::sync::atomic::AtomicUsize::new(0);

        let report = reconcile_vault_with_progress(&conn, &vault, &|processed, total| {
            if processed == total && edits.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                write_note(&vault, "Second", "edited while the pass wrote");
            }
        })
        .unwrap();

        assert_eq!(report.upserted, ["First", "Second"], "{report:?}");
        assert!(db::index_is_ready(&conn).unwrap());
        assert!(index::get_block(&conn, "Second").unwrap().unwrap().body.contains("while the pass wrote"));
    }

    /// A pass that could not list the space changed nothing in the index:
    /// the index is as ready as it was. Until 15.11.2026 every pass began by
    /// marking the index not ready, and a pass that failed there left it so.
    #[cfg(unix)]
    #[test]
    fn a_failed_inventory_leaves_readiness_as_it_was() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, vault, conn) = indexed_space();
        let closed = vault.root().join("Closed");
        std::fs::create_dir(&closed).unwrap();
        std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o000)).unwrap();

        let outcome = reconcile_vault(&conn, &vault);

        std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(outcome, Err(ReconcileError::Inventory { .. })), "{outcome:?}");
        assert!(db::index_is_ready(&conn).unwrap());
    }

    /// A row of a collection no page backs is swept by a pass over a space
    /// where no note changed: every pass compares the rows of collections
    /// with the names of the pages it saw. The row is the one of the NSFV
    /// space (`sweeps_a_phantom_channel_row_no_document_backs`): its key is
    /// the page's own slug, so it reads neither as a removed note nor as a
    /// stale one.
    #[test]
    fn a_collection_row_without_a_page_is_swept_by_a_pass_that_reads_no_note() {
        let (_dir, vault, conn) = indexed_space();
        let phantom = Channel::new(
            "Collections/Видео",
            DateTime::new("2026-08-05T00:00:00Z").unwrap(),
        )
        .unwrap();
        index::upsert_channel(&conn, &phantom).unwrap();
        assert_eq!(index::list_channels(&conn).unwrap().len(), 2);

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!((report.unchanged, report.content_reads), (3, 0), "{report:?}");
        assert_eq!(
            index::list_channels(&conn)
                .unwrap()
                .iter()
                .map(|channel| channel.tag.as_str())
                .collect::<Vec<_>>(),
            ["Видео"]
        );
        assert!(db::index_is_ready(&conn).unwrap());
    }

    /// Х24: a background pass over a built index reads a note whose contents
    /// are in iCloud only after it has let the index go and brought the note
    /// down; the pass that follows reads it from this Mac.
    #[test]
    fn a_background_pass_brings_a_note_in_icloud_down_and_reads_it() {
        use crate::storage::cloud_files::test_seam;
        let (_dir, vault, conn) = indexed_space();
        let away = vault.root().join("Away.md");
        std::fs::write(&away, "# Away\n\nText from another Mac.\n").unwrap();
        test_seam::mark_offloaded(&away);

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert_eq!(report.upserted, ["Away"], "{report:?}");
        assert!(index::get_block(&conn, "Away").unwrap().unwrap().body.contains("another Mac"));
        assert!(db::index_is_ready(&conn).unwrap());
    }

    /// «Отказ чтения» (SPEC_CLOUD_STORAGE.md): a note a background pass must
    /// read whose read iCloud refuses, as macOS refuses the reads of a
    /// process that may not bring contents down (`EDEADLK`), waits as the
    /// index holds it. No «Could not read» error, the index stays ready, and
    /// the pass after its contents arrive reads it. Until 17.11.2026 the pass
    /// asked iCloud for the note, met the refusal at once and named the note
    /// it had just asked for among the notes it could not read.
    #[test]
    fn a_note_whose_read_icloud_refuses_waits_instead_of_failing() {
        use crate::storage::cloud_files::test_seam;
        let (_dir, vault, conn) = indexed_space();
        let away = vault.root().join("Away.md");
        std::fs::write(&away, "# Away\n\nFirst text.\n").unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        // Changed on another Mac; this Mac has its name and size, not its text.
        std::fs::write(&away, "# Away\n\nText from another Mac, a little longer.\n").unwrap();
        test_seam::refuse_reads_of(&away);

        let report = reconcile_vault(&conn, &vault).unwrap();

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(test_seam::reads_of(&away) > 0, "the pass did not try the note");
        let kept = index::get_block(&conn, "Away").unwrap().unwrap();
        assert!(kept.body.contains("First text"), "{}", kept.body);
        assert!(db::index_is_ready(&conn).unwrap());

        test_seam::mark_downloaded(&away);
        let report = reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(report.upserted, ["Away"], "{report:?}");
        assert!(index::get_block(&conn, "Away").unwrap().unwrap().body.contains("another Mac"));
    }

    /// SPEC_INTEGRATION.md, «Точное перечитывание»: the notes that name a
    /// file are found by its name, whatever folder the note recorded it in,
    /// its letter case, its Unicode form and percent-encoding; a note that
    /// names no such file is neither found nor read.
    #[test]
    fn reading_again_for_a_file_reads_only_the_notes_that_name_it() {
        let (_dir, vault, conn) = setup();
        for folder in ["Cards", "Media"] {
            std::fs::create_dir_all(vault.root().join(folder)).unwrap();
        }
        let note = |name: &str, body: &str| {
            std::fs::write(
                vault.root().join(format!("Cards/{name}.md")),
                format!("---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\n{body}\n"),
            )
            .unwrap();
        };
        note("Embed", "![[\u{439}ога.jpg]]");
        note("Path", "![](../Media/%D0%B9%D0%BE%D0%B3%D0%B0.jpg)");
        note("Upper", "![[\u{419}ОГА.JPG]]");
        note("Decomposed", "![[\u{438}\u{306}ога.jpg]]");
        note("Other", "![[other.jpg]]");
        note("Plain", "No picture.");
        std::fs::write(vault.root().join("Media/other.jpg"), b"other").unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        let passes = reread_passes();

        let landed = vault.root().join("Media/\u{439}ога.jpg");
        std::fs::write(&landed, b"the picture").unwrap();
        assert_eq!(follow_path(&vault, &landed), SeenPath::File);
        let reread = reread_notes_naming(&conn, &vault, &[landed], &BTreeSet::new()).unwrap();

        assert_eq!(reread.reread, ["Cards/Decomposed", "Cards/Embed", "Cards/Path", "Cards/Upper"]);
        assert!(reread.errors.is_empty() && !reread.left_in_cloud, "{:?}", reread.errors);
        assert_eq!(reread_passes() - passes, 1);
        assert_eq!(
            reread.naming.keys().collect::<Vec<_>>(),
            ["Cards/Decomposed", "Cards/Embed", "Cards/Path", "Cards/Upper"]
        );
        // The notes that resolve the name are projected with the file.
        for slug in ["Cards/Embed", "Cards/Path"] {
            let block = index::get_block(&conn, slug).unwrap().unwrap();
            assert!(
                block.media_urls.as_deref().is_some_and(|urls| urls.contains("Media/")),
                "{slug}: {:?}",
                block.media_urls
            );
        }
        // Already read by the caller: found, not read again.
        let again = reread_notes_naming(
            &conn,
            &vault,
            &[vault.root().join("Media/other.jpg")],
            &BTreeSet::from(["Cards/Other".to_string()]),
        )
        .unwrap();
        assert_eq!(again.naming.keys().collect::<Vec<_>>(), ["Cards/Other"]);
        assert!(again.reread.is_empty());
    }

    /// SPEC_STORAGE.md, `source_dependency_names`: the names a note is found
    /// by are written with its stamp and follow it: an edit that drops a
    /// picture drops its name, and a note that goes takes its names with it.
    #[test]
    fn the_names_of_a_notes_dependencies_follow_its_stamp() {
        let (_dir, vault, conn) = setup();
        let names = |conn: &Connection| -> Vec<(String, String)> {
            let mut stmt = conn
                .prepare("SELECT name, slug FROM source_dependency_names ORDER BY name, slug")
                .unwrap();
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let pair = |name: &str, slug: &str| (name.to_string(), slug.to_string());
        std::fs::write(vault.root().join("Photo.JPG"), b"photo").unwrap();
        // A link in the text is recorded decoded; a property is recorded as
        // written, and is found by its decoded name too.
        let two = |text: &str| {
            std::fs::write(
                vault.block_path("Two"),
                format!("---\ntype: article\nthumbnail: my%20cover.png\nsaved_at: 2026-07-10T00:00:00Z\n---\n{text}"),
            )
            .unwrap();
        };
        two("![[Photo.JPG]]\n\n![](my%20clip.mp4)\n");
        write_note(&vault, "One", "![[photo.jpg]]\n");
        write_note(&vault, "None", "No picture.\n");
        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(
            names(&conn),
            [
                pair("my clip.mp4", "Two"),
                pair("my cover.png", "Two"),
                pair("my%20cover.png", "Two"),
                pair("photo.jpg", "One"),
                pair("photo.jpg", "Two"),
            ]
        );
        let found = notes_naming_files(
            &conn,
            &HashSet::from(["photo.jpg".to_string(), "my cover.png".to_string()]),
        )
        .unwrap();
        assert_eq!(found.keys().collect::<Vec<_>>(), ["One", "Two"]);
        assert_eq!(found["Two"].len(), 2);

        two("![](my%20clip.mp4)\n");
        std::fs::remove_file(vault.block_path("One")).unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(
            names(&conn),
            [
                pair("my clip.mp4", "Two"),
                pair("my cover.png", "Two"),
                pair("my%20cover.png", "Two"),
            ]
        );
        assert!(notes_naming_files(&conn, &HashSet::from(["photo.jpg".to_string()]))
            .unwrap()
            .is_empty());
    }

    /// A note that names a changed file and whose contents are in iCloud is
    /// not read: it stays as the index holds it, and the caller is told to
    /// ask for a background pass (Х12).
    #[test]
    fn reading_again_leaves_a_note_in_icloud_to_the_background_pass() {
        use crate::storage::cloud_files::test_seam;
        let (_dir, vault, conn) = setup();
        let away = vault.root().join("Away.md");
        std::fs::write(&away, "---\ntype: article\n---\n![[late.jpg]]\n").unwrap();
        reconcile_vault(&conn, &vault).unwrap();
        test_seam::mark_offloaded(&away);
        let reads = test_seam::reads_of(&away);

        let landed = vault.root().join("late.jpg");
        std::fs::write(&landed, b"the picture").unwrap();
        let reread = reread_notes_naming(&conn, &vault, &[landed], &BTreeSet::new()).unwrap();

        assert!(reread.left_in_cloud);
        assert!(reread.reread.is_empty());
        assert_eq!(test_seam::reads_of(&away), reads, "a note in iCloud was read");
    }

    /// The kept names follow the paths a watcher reports: a file that
    /// appears and one that goes, a path that came and went, a folder, and
    /// a path gone under which files were known. With no names kept, a path
    /// that is gone may have been a folder.
    #[test]
    fn the_kept_names_follow_the_paths_a_watcher_reports() {
        let (_dir, vault, conn) = indexed_space();
        let root = vault.root().to_path_buf();
        assert_eq!(kept_names_hold(&root, "picture.jpg"), Some(true));

        let new = root.join("Collections/new.png");
        std::fs::write(&new, b"new").unwrap();
        assert_eq!(follow_path(&vault, &new), SeenPath::File);
        assert_eq!(kept_names_hold(&root, "Collections/new.png"), Some(true));
        std::fs::remove_file(&new).unwrap();
        assert_eq!(follow_path(&vault, &new), SeenPath::GoneFile);
        assert_eq!(kept_names_hold(&root, "Collections/new.png"), Some(false));
        assert_eq!(follow_path(&vault, &root.join("came and went.tmp")), SeenPath::GoneFile);
        // The names followed file by file are the names a walk lists.
        let followed = kept_link_index(&vault).unwrap();
        forget_kept_files(&root);
        assert_eq!(*followed, *kept_link_index(&vault).unwrap());

        std::fs::rename(root.join("Collections"), root.join("Pages")).unwrap();
        assert_eq!(follow_path(&vault, &root.join("Collections")), SeenPath::Folder);
        assert_eq!(kept_names_hold(&root, "picture.jpg"), None, "the names were kept");
        assert_eq!(follow_path(&vault, &root.join("Pages")), SeenPath::Folder);
        assert_eq!(follow_path(&vault, &root.join("gone.jpg")), SeenPath::Folder);
        drop(conn);
    }

    /// Passes over the unchanged space timed; the limit holds for their
    /// median: on a machine busy with other work one pass of five may wait
    /// for a core.
    const TIMED_PASSES: usize = 5;
    /// Б2: a pass over a space where nothing changed.
    const UNCHANGED_PASS_LIMIT: Duration = Duration::from_millis(100);

    /// AUDIT_PERFORMANCE.md, Б2 and Б3 (SPEC_STORAGE.md, «Проход без
    /// изменений»): the pass before an action and the background pass over a
    /// space of 10 000 notes where nothing changed answer within
    /// `UNCHANGED_PASS_LIMIT`, read no note and write nothing. The limit is an
    /// optimised build's: a speed test, run by `test:rust-speed` alone
    /// (ARCHITECTURE.md, «Тесты скорости Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_pass_over_10_000_unchanged_notes_answers_within_its_limit() {
        let (directory, derived) = (TempDir::new().unwrap(), TempDir::new().unwrap());
        let vault = VaultLayout::with_derived_root(
            directory.path().to_path_buf(),
            derived.path().to_path_buf(),
        );
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let media = timed_space::write(vault.root());
        let notes = timed_space::NOTES + timed_space::COLLECTIONS;
        let started = Instant::now();
        let first = reconcile_vault(&conn, &vault).unwrap();
        let build = started.elapsed();
        assert!(first.is_fresh(), "{:?}", first.errors.first());
        assert_eq!(first.upserted.len(), notes);

        let median_of = |pass: &dyn Fn() -> ReconcileReport| {
            let mut times = Vec::with_capacity(TIMED_PASSES);
            for _ in 0..TIMED_PASSES {
                let started = Instant::now();
                let report = pass();
                times.push(started.elapsed());
                assert_eq!(
                    (report.unchanged, report.content_reads, report.database_writes),
                    (notes, 0, 0),
                    "{report:?}"
                );
            }
            times.sort();
            (times[TIMED_PASSES / 2], times[TIMED_PASSES - 1])
        };
        let (action, action_slowest) = median_of(&|| {
            let pass = reconcile_vault_for_action(&conn, &vault).unwrap();
            assert!(pass.deferred.is_empty());
            pass.report
        });
        let (background, background_slowest) =
            median_of(&|| reconcile_vault(&conn, &vault).unwrap());
        assert!(db::index_is_ready(&conn).unwrap());
        // The first pass of a process over a space has no index of names
        // kept and builds one of the files it lists. The same limit holds
        // for it, by the median of its passes.
        let (unkept, unkept_slowest) = median_of(&|| {
            KEPT_FILES
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(vault.root());
            reconcile_vault_for_action(&conn, &vault).unwrap().report
        });
        eprintln!(
            "pass over an unchanged space, {notes} notes, {media} media files: before an action median {action:?}, slowest {action_slowest:?}; background median {background:?}, slowest {background_slowest:?}; before an action with no index of names kept median {unkept:?}, slowest {unkept_slowest:?}; limit {UNCHANGED_PASS_LIMIT:?}, asserted for all three; the first pass, which builds the index: {build:?}",
        );

        assert!(
            action <= UNCHANGED_PASS_LIMIT,
            "the pass before an action {action:?} over {UNCHANGED_PASS_LIMIT:?} (slowest {action_slowest:?})"
        );
        assert!(
            background <= UNCHANGED_PASS_LIMIT,
            "the background pass {background:?} over {UNCHANGED_PASS_LIMIT:?} (slowest {background_slowest:?})"
        );
        assert!(
            unkept <= UNCHANGED_PASS_LIMIT,
            "the pass with no index of names kept {unkept:?} over {UNCHANGED_PASS_LIMIT:?} (slowest {unkept_slowest:?})"
        );
    }
}
