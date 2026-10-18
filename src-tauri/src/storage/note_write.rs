//! The steps every write of a note's body from the open card shares
//! (SPEC_EDITING.md, Л3.3 steps 1, 2, 6 and 7, Л3.6; SPEC_READING_MODE.md,
//! Ч12.3): a toggled task (`task_toggle`) and a saved body (`note_edit`).
//!
//! First the checks that read no contents, from the cheapest: the note is on
//! disk, its contents are on this Mac (a note in iCloud is asked for and
//! refused at once, never waited for), Mine may write the file and its
//! folder. Then the note is read the way reconciliation reads it. The new
//! version is published by the checked source mutation
//! (`SourceFileWrite::replace` through `StagedSourceMutation::commit_with_index`):
//! a file that holds anything else by the time the new version would become
//! visible is not overwritten, and the index takes the written note in the
//! same step.
//!
//! Before the publication the write is marked as Mine's own by the hash of
//! its bytes (Л3.6): the watcher drops an event of the note only while the
//! file holds exactly those bytes, so an outside write is never hidden, not
//! even one that lands right after Mine's.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::domain::block::{parse_markdown_document, Block, DateTime, ParsedMarkdownBlock};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::source_mutation::{SourceFileWrite, SourceMutationError, StagedSourceMutation};
use crate::storage::{cloud_files, files, icloud_downloads, index, media_refs, reconcile};

/// How long a write Mine made to a note stays recognisable as its own to the
/// watcher (Л3.6). Events of one write arrive within milliseconds; the
/// margin covers a watcher that is busy with a burst.
pub const EDIT_OWN_WRITE_TTL_MS: u64 = 5000;

/// Why a note was not written. Nothing was written in any case; each command
/// gives the reason its own error type with the note's slug.
#[derive(Debug, Error)]
pub enum NoteWriteRefusal {
    /// The note is not on disk.
    #[error("the note is not on disk")]
    SourceNotFound,
    /// The note's contents are in iCloud: Mine asked iCloud to download them
    /// and did not wait.
    #[error("the contents of “{file_name}” are in iCloud; Mine asked iCloud to download them")]
    InCloud { file_name: String },
    /// Mine may not write the note or its folder: no permission, a file
    /// locked in Finder, a read-only volume.
    #[error("Mine may not write “{file_name}” or its folder")]
    ReadOnly { file_name: String },
    /// The file changed between Mine's read and the publication of the new
    /// version; the other version stays.
    #[error("the note changed outside Mine while it was written; nothing was overwritten")]
    Changed,
    /// Any other failure, with every cause down to the reason the system gave.
    #[error("{0}")]
    Internal(String),
}

impl NoteWriteRefusal {
    /// Any other failure, with every cause.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal(format!("{error:#}"))
    }
}

/// A note on disk whose contents are on this Mac and that Mine may write.
#[derive(Debug, Clone)]
pub struct WritableNote {
    pub path: PathBuf,
    /// The file's name, as the person reads it in a notice.
    pub file_name: String,
}

/// The note `slug` once it is on disk, its contents are on this Mac and Mine
/// may write it and its folder. None of the checks reads the contents, so
/// none waits for iCloud; a note in iCloud is asked for and refused.
///
/// # Errors
///
/// [`NoteWriteRefusal`] says which check refused.
pub fn writable_note(vault: &VaultLayout, slug: &str) -> Result<WritableNote, NoteWriteRefusal> {
    let path = local_note(vault, slug)?;
    let file_name = note_file_name(&path, slug);
    let folder = path
        .parent()
        .ok_or_else(|| NoteWriteRefusal::internal(format!("{} has no folder", path.display())))?;
    if !may_write(&path).map_err(NoteWriteRefusal::internal)?
        || !may_write(folder).map_err(NoteWriteRefusal::internal)?
    {
        return Err(NoteWriteRefusal::ReadOnly { file_name });
    }
    Ok(WritableNote { path, file_name })
}

/// The path of the note `slug` once it is on disk and its contents are on
/// this Mac: the checks of [`writable_note`] that do not ask about the right
/// to write. A note in iCloud is asked for and refused.
///
/// # Errors
///
/// `SourceNotFound`, `InCloud`, or `Internal` for a slug that names no note.
pub fn local_note(vault: &VaultLayout, slug: &str) -> Result<PathBuf, NoteWriteRefusal> {
    validate_slug(slug).map_err(|error| {
        NoteWriteRefusal::internal(format!("'{slug}' names no note of the space: {error}"))
    })?;
    let path = vault.block_path(slug);
    if !path.is_file() {
        return Err(NoteWriteRefusal::SourceNotFound);
    }
    if cloud_files::is_content_offloaded(&path) {
        icloud_downloads::request_downloads([path.as_path()]);
        return Err(NoteWriteRefusal::InCloud {
            file_name: note_file_name(&path, slug),
        });
    }
    Ok(path)
}

/// The name of the note's file, for a notice.
pub fn note_file_name(path: &Path, slug: &str) -> String {
    path.file_name().map_or_else(
        || format!("{slug}.md"),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Whether Mine may write at `path`: replace the file, or create a file in
/// the folder. A file locked in Finder counts as one Mine may not write.
fn may_write(path: &Path) -> io::Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: `c_path` is a NUL-terminated string that outlives the call.
    if unsafe { libc::access(c_path.as_ptr(), libc::W_OK) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if is_write_refusal(&error) {
        Ok(false)
    } else {
        Err(error)
    }
}

/// Whether the system refused a write for want of the right to it: no
/// permission, a locked file, a read-only volume.
fn is_write_refusal(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
    )
}

/// A note as read from its file.
#[derive(Debug)]
pub struct ReadNote {
    /// The text of the file: a write is refused unless the file still holds
    /// it when the new version is published.
    pub text: String,
    /// `text` read the way reconciliation reads the file.
    pub parsed: ParsedMarkdownBlock,
    /// The fallback `saved_at` of the read, for a new version read back.
    pub read_at: DateTime,
}

impl ReadNote {
    /// Read `text`, a new version of this note, the way reconciliation would
    /// read it from the same file.
    ///
    /// # Errors
    ///
    /// `Internal` when the parser refuses it.
    pub fn read_back(&self, text: &str) -> Result<ParsedMarkdownBlock, NoteWriteRefusal> {
        let slug = self.parsed.block.slug.as_str();
        parse_markdown_document(slug, text, self.read_at.clone()).map_err(|error| {
            NoteWriteRefusal::internal(format!("failed to read back '{slug}': {error}"))
        })
    }

    /// Where the body starts in the file (Л0.2).
    ///
    /// # Errors
    ///
    /// `Internal` when the body is not the end of the file, which the parser
    /// never gives.
    pub fn body_start(&self) -> Result<usize, NoteWriteRefusal> {
        body_start(&self.text, &self.parsed.block.body).ok_or_else(|| {
            NoteWriteRefusal::internal(format!(
                "the body of '{}' does not end its file",
                self.parsed.block.slug
            ))
        })
    }
}

/// Read the note at `path` the way reconciliation reads it.
///
/// # Errors
///
/// `SourceNotFound` when the file is gone, `Internal` when it cannot be read
/// (not UTF-8) or parsed.
pub fn read_note(vault: &VaultLayout, path: &Path) -> Result<ReadNote, NoteWriteRefusal> {
    let (slug, text) = files::read_block_file(vault, path).map_err(|error| {
        if path.exists() {
            NoteWriteRefusal::internal(error)
        } else {
            NoteWriteRefusal::SourceNotFound
        }
    })?;
    #[cfg(test)]
    hooks::run_after_read(path);
    let read_at = reconcile::file_saved_at(path);
    let parsed = parse_markdown_document(&slug, &text, read_at.clone())
        .map_err(|error| NoteWriteRefusal::internal(format!("failed to read '{slug}': {error}")))?;
    Ok(ReadNote {
        text,
        parsed,
        read_at,
    })
}

/// Where `body` starts in `content`, the file it was read from. The parser
/// takes the body as the end of the file in every reading of it: after the
/// front matter, or the whole file when there is none or it does not parse.
pub fn body_start(content: &str, body: &str) -> Option<usize> {
    let start = content.len().checked_sub(body.len())?;
    (content.get(start..)? == body).then_some(start)
}

/// A note written and indexed.
#[derive(Debug)]
pub struct PublishedNote {
    /// The card as the index holds it now.
    pub indexed: IndexedBlock,
    /// The written note as the index took it, media references resolved.
    pub block: Block,
}

/// Publish `written_text` over `read`, the note at `path` as it was read,
/// and index it as reconciliation does in the same step (Л3.3 steps 6 and 7).
/// `written` is `written_text` read back. The write is marked as Mine's own
/// for the watcher before it becomes visible (Л3.6).
///
/// # Errors
///
/// `Changed` when the file holds anything else by the publication, `ReadOnly`
/// when the system refused the right to write after the checks passed,
/// `SourceNotFound` when the file went meanwhile, `Internal` for the rest.
pub fn publish_note(
    conn: &Connection,
    vault: &VaultLayout,
    note: &WritableNote,
    read: ReadNote,
    written_text: String,
    written: &ParsedMarkdownBlock,
    operation: &'static str,
) -> Result<PublishedNote, NoteWriteRefusal> {
    let mut block = written.block.clone();
    files::normalize_block_media_refs_for_index(&mut media_refs::MediaResolver::new(vault), &mut block);
    let refused = |error: SourceMutationError| mutation_refusal(&error, &note.path, &note.file_name);
    let bytes = written_text.into_bytes();
    let hash = content_hash(&bytes);
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
        note.path.clone(),
        read.text.into_bytes(),
        bytes,
    )])
    .map_err(refused)?;
    OWN_WRITES.record(vault.root(), &block.slug, hash, Instant::now());
    let indexed = staged
        .commit_with_index(conn, operation, |index_conn| {
            index::upsert_block_with_diagnostics(
                index_conn,
                &block,
                Some(vault.root()),
                Some(written.origin.as_str()),
                written.index_warning.as_deref(),
            )?;
            index::get_block(index_conn, &block.slug)?.ok_or_else(|| {
                anyhow::anyhow!("'{}' is missing from the index after it was written", block.slug)
            })
        })
        .map_err(refused)?;
    Ok(PublishedNote { indexed, block })
}

/// Index `read`, a note as it is on disk, without writing it: the index
/// catches up with a file it lags behind.
///
/// # Errors
///
/// `Internal` when the index refuses the row or no write may start (Mine is
/// quitting).
pub fn index_read_note(
    conn: &Connection,
    vault: &VaultLayout,
    read: &ReadNote,
) -> Result<IndexedBlock, NoteWriteRefusal> {
    let _write = crate::storage::source_mutation::begin_write().map_err(NoteWriteRefusal::internal)?;
    let mut block = read.parsed.block.clone();
    files::normalize_block_media_refs_for_index(&mut media_refs::MediaResolver::new(vault), &mut block);
    index::upsert_block_with_diagnostics(
        conn,
        &block,
        Some(vault.root()),
        Some(read.parsed.origin.as_str()),
        read.parsed.index_warning.as_deref(),
    )
    .map_err(NoteWriteRefusal::internal)?;
    index::get_block(conn, &block.slug)
        .map_err(NoteWriteRefusal::internal)?
        .ok_or_else(|| {
            NoteWriteRefusal::internal(format!("'{}' is missing from the index after it was read", block.slug))
        })
}

/// What a refused source mutation of the note at `path` comes to.
pub fn mutation_refusal(error: &SourceMutationError, path: &Path, file_name: &str) -> NoteWriteRefusal {
    if matches!(error, SourceMutationError::Changed { .. }) {
        return NoteWriteRefusal::Changed;
    }
    if !path.exists() {
        return NoteWriteRefusal::SourceNotFound;
    }
    if refused_for_permission(error) {
        return NoteWriteRefusal::ReadOnly {
            file_name: file_name.to_string(),
        };
    }
    NoteWriteRefusal::internal(error)
}

/// Whether staging or publishing the write met a system refusal of the right
/// to write, after the check before it passed.
fn refused_for_permission(error: &SourceMutationError) -> bool {
    let (SourceMutationError::Stage { source, .. }
    | SourceMutationError::CommitFile { source, .. }) = error
    else {
        return false;
    };
    source
        .chain()
        .filter_map(|cause| cause.downcast_ref::<io::Error>())
        .any(is_write_refusal)
}

/// The hash a write is recognised by: SHA-256 of every byte of the file.
fn content_hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// One write Mine made to a note.
#[derive(Debug, Clone, Copy)]
struct OwnWrite {
    hash: [u8; 32],
    expires: Instant,
}

/// The writes Mine made to notes in the last [`EDIT_OWN_WRITE_TTL_MS`], by
/// the space's folder and the note's slug; the last write of a note stands
/// for it (Л3.6).
#[derive(Debug, Default)]
pub struct OwnWrites {
    records: Mutex<HashMap<(PathBuf, String), OwnWrite>>,
}

impl OwnWrites {
    fn records(&self) -> std::sync::MutexGuard<'_, HashMap<(PathBuf, String), OwnWrite>> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Mine is about to publish bytes hashing to `hash` as the note `slug`
    /// of the space at `root`.
    fn record(&self, root: &Path, slug: &str, hash: [u8; 32], now: Instant) {
        let mut records = self.records();
        records.retain(|_, write| write.expires > now);
        records.insert(
            (root.to_path_buf(), slug.to_string()),
            OwnWrite {
                hash,
                expires: now + Duration::from_millis(EDIT_OWN_WRITE_TTL_MS),
            },
        );
    }

    /// Whether the note `slug` of the space at `root` holds exactly what Mine
    /// wrote there last, within the time a write stays recognisable.
    /// `current` gives the file's bytes now, or `None` when they are not on
    /// this Mac or the file is gone; it is asked only when there is a write
    /// to compare with.
    fn holds_own_write(
        &self,
        root: &Path,
        slug: &str,
        now: Instant,
        current: impl FnOnce() -> Option<Vec<u8>>,
    ) -> bool {
        let write = {
            let mut records = self.records();
            records.retain(|_, write| write.expires > now);
            records.get(&(root.to_path_buf(), slug.to_string())).copied()
        };
        write.is_some_and(|write| current().is_some_and(|bytes| content_hash(&bytes) == write.hash))
    }
}

/// The writes of this process: the app's commands record them, its watcher
/// asks. A writer in another process (the CLI, the MCP server, Obsidian) is
/// an outside writer to the app.
static OWN_WRITES: LazyLock<OwnWrites> = LazyLock::new(OwnWrites::default);

/// Whether the watcher's event at `path`, a note of `vault`, is one of
/// Mine's own writes: the file holds exactly the bytes Mine published there
/// last, at most [`EDIT_OWN_WRITE_TTL_MS`] ago. Anything else is an outside
/// change, and so is a note whose contents are in iCloud or that is gone.
pub fn is_own_write(vault: &VaultLayout, path: &Path) -> bool {
    let Ok(slug) = vault.slug_for_path(path) else {
        return false;
    };
    OWN_WRITES.holds_own_write(vault.root(), &slug, Instant::now(), || local_bytes(path))
}

/// The bytes of the file at `path` when they are on this Mac. A file in
/// iCloud is not read: reading it would wait for the download.
fn local_bytes(path: &Path) -> Option<Vec<u8>> {
    if cloud_files::is_content_offloaded(path) {
        return None;
    }
    std::fs::read(path).ok()
}

#[cfg(test)]
pub(crate) mod hooks {
    use std::cell::RefCell;
    use std::path::Path;

    type Hook = Box<dyn FnOnce(&Path)>;

    thread_local! {
        /// Runs once after the note was read and before the write is
        /// staged: the window an outside edit can hit.
        static AFTER_READ: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) fn run_after_read(path: &Path) {
        if let Some(hook) = AFTER_READ.with(|slot| slot.borrow_mut().take()) {
            hook(path);
        }
    }

    /// Run `hook` with the path of the next note read on this thread.
    pub(crate) fn after_next_read(hook: impl FnOnce(&Path) + 'static) {
        AFTER_READ.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;
    use std::os::unix::fs::PermissionsExt;

    fn space() -> (tempfile::TempDir, tempfile::TempDir, VaultLayout) {
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(root.path().to_path_buf(), derived.path().to_path_buf());
        (root, derived, vault)
    }

    /// Л3.6: a write is Mine's own only while the file holds exactly its
    /// bytes and only for the time it stays recognisable; the last write of
    /// a note stands for it.
    #[test]
    fn own_writes_are_recognised_by_their_bytes_and_expire() {
        let writes = OwnWrites::default();
        let root = Path::new("/spaces/A");
        let start = Instant::now();
        writes.record(root, "Note", content_hash(b"mine"), start);

        assert!(writes.holds_own_write(root, "Note", start, || Some(b"mine".to_vec())));
        assert!(
            !writes.holds_own_write(root, "Note", start, || Some(b"theirs".to_vec())),
            "an outside write right after Mine's was hidden"
        );
        assert!(!writes.holds_own_write(root, "Note", start, || None));
        assert!(!writes.holds_own_write(root, "Other", start, || Some(b"mine".to_vec())));
        assert!(!writes.holds_own_write(Path::new("/spaces/B"), "Note", start, || Some(b"mine".to_vec())));
        let expired = start + Duration::from_millis(EDIT_OWN_WRITE_TTL_MS);
        assert!(!writes.holds_own_write(root, "Note", expired, || Some(b"mine".to_vec())));

        writes.record(root, "Note", content_hash(b"first"), start);
        writes.record(root, "Note", content_hash(b"second"), start);
        assert!(writes.holds_own_write(root, "Note", start, || Some(b"second".to_vec())));
        assert!(!writes.holds_own_write(root, "Note", start, || Some(b"first".to_vec())));
    }

    /// Л3.6: without a write to compare with, the file is not even read.
    #[test]
    fn a_note_mine_did_not_write_is_not_read() {
        let writes = OwnWrites::default();
        let read = std::cell::Cell::new(false);
        assert!(!writes.holds_own_write(Path::new("/spaces/A"), "Note", Instant::now(), || {
            read.set(true);
            Some(Vec::new())
        }));
        assert!(!read.get());
    }

    /// Л3.6: the watcher's question goes to the file on disk: Mine's bytes
    /// are its own, an outside write over them is not, nor is a note in
    /// iCloud, which is not read.
    #[test]
    fn the_watcher_asks_the_file_on_disk() {
        let (_root, _derived, vault) = space();
        let path = vault.block_path("Заметка");
        std::fs::write(&path, "written by Mine\n").unwrap();
        OWN_WRITES.record(vault.root(), "Заметка", content_hash(b"written by Mine\n"), Instant::now());
        assert!(is_own_write(&vault, &path));

        cloud_files::test_seam::mark_offloaded(&path);
        let offloaded = is_own_write(&vault, &path);
        let reads = cloud_files::test_seam::reads_of(&path);
        cloud_files::test_seam::mark_downloaded(&path);
        assert!(!offloaded);
        assert_eq!(reads, 0);

        std::fs::write(&path, "written in Obsidian\n").unwrap();
        assert!(!is_own_write(&vault, &path));
        std::fs::remove_file(&path).unwrap();
        assert!(!is_own_write(&vault, &path));
    }

    /// Л3.3 step 1: the checks refuse a missing note, a note in iCloud and a
    /// note Mine may not write, before anything is read.
    #[test]
    fn the_checks_read_no_contents() {
        let (_root, _derived, vault) = space();
        assert!(matches!(
            writable_note(&vault, "Gone"),
            Err(NoteWriteRefusal::SourceNotFound)
        ));

        let path = vault.block_path("Note");
        std::fs::write(&path, "text\n").unwrap();
        let note = writable_note(&vault, "Note").unwrap();
        assert_eq!(note.path, path);
        assert_eq!(note.file_name, "Note.md");

        cloud_files::test_seam::mark_offloaded(&path);
        let outcome = writable_note(&vault, "Note");
        let reads = cloud_files::test_seam::reads_of(&path);
        cloud_files::test_seam::mark_downloaded(&path);
        assert!(matches!(outcome, Err(NoteWriteRefusal::InCloud { ref file_name }) if file_name == "Note.md"));
        assert_eq!(reads, 0);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let outcome = writable_note(&vault, "Note");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(outcome, Err(NoteWriteRefusal::ReadOnly { ref file_name }) if file_name == "Note.md"));
    }

    /// Л3.3 step 6: the published note is in the index and its write is
    /// Mine's own; an outside edit between the read and the publication
    /// stays and nothing is indexed.
    #[test]
    fn a_published_note_is_indexed_and_marked_as_own() {
        let (_root, _derived, vault) = space();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let path = vault.block_path("Note");
        std::fs::write(&path, "before\n").unwrap();

        let note = writable_note(&vault, "Note").unwrap();
        let read = read_note(&vault, &note.path).unwrap();
        let written = read.read_back("after\n").unwrap();
        let published =
            publish_note(&conn, &vault, &note, read, "after\n".into(), &written, "note_write_test").unwrap();
        assert_eq!(published.indexed.body, "after\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
        assert!(is_own_write(&vault, &path));

        let note = writable_note(&vault, "Note").unwrap();
        hooks::after_next_read(|path| std::fs::write(path, "outside\n").unwrap());
        let read = read_note(&vault, &note.path).unwrap();
        let written = read.read_back("mine\n").unwrap();
        let refusal =
            publish_note(&conn, &vault, &note, read, "mine\n".into(), &written, "note_write_test").unwrap_err();
        assert!(matches!(refusal, NoteWriteRefusal::Changed), "{refusal}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "outside\n");
        assert_eq!(index::get_block(&conn, "Note").unwrap().unwrap().body, "after\n");
        assert!(!is_own_write(&vault, &path));
    }
}
