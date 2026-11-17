//! One rule for files iCloud manages (SPEC_DEEP_AUDIT.md, Н7).
//!
//! Whether a file is in iCloud and whether its contents are on this Mac are
//! properties of the file, read from the system, never guessed from its path.
//! Until 13.10.2026 both came from the path holding `Mobile Documents`, so a
//! space on the iCloud Desktop (`~/Desktop`, a FileProvider domain with no
//! such folder in its path) had every evicted note read, and every read
//! waited for its download (SPEC_DEEP_AUDIT.md, Е5.2). Reconciliation, the
//! preview pass, the `In iCloud` mark, the download percent and the root
//! guard all ask here.
//!
//! - Contents absent: the file carries `SF_DATALESS`, the flag the kernel
//!   sets on a dataless placeholder (`ls -lO` shows `dataless`). Reading the
//!   flag is a `stat`: it never brings the file down. A sparse local file has
//!   the old signature (full size, no blocks) and no such flag.
//! - In iCloud: `NSFileManager isUbiquitousItemAtURL`, true for iCloud Drive
//!   and for the Desktop and Documents folders it syncs.
//!
//! Every read of a file of the space whose contents iCloud may hold goes
//! through [`open`], [`read`] or [`read_to_string`]. A read of such a file
//! either brings its contents down and waits for them, or is refused at once
//! with `EDEADLK` ([`is_refusal`]): the process may not bring contents down
//! (its materialization policy is off, which a process inherits from the
//! one that started it), or the system will not. Mine asks for the first at
//! launch ([`let_reads_bring_contents_down`]); every reader still takes the
//! second as "in iCloud", never as a broken file (SPEC_CLOUD_STORAGE.md,
//! «Отказ чтения»).

use std::path::Path;

/// `SF_DATALESS` of `<sys/stat.h>`: the file is a dataless placeholder whose
/// contents the system brings down when it is read.
pub const SF_DATALESS: u32 = 0x4000_0000;

/// Whether file flags `flags` (`st_flags`) mark a file whose contents are
/// not on this Mac.
#[must_use]
pub fn flags_mark_dataless(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

/// Whether the file at `path` exists and its contents are in iCloud, not on
/// this Mac. Only the file's flags are read, so the check never brings the
/// file down; a missing file is not offloaded.
#[must_use]
pub fn is_content_offloaded(path: &Path) -> bool {
    #[cfg(debug_assertions)]
    if test_seam::is_marked(path) {
        return std::fs::symlink_metadata(path).is_ok();
    }
    file_flags(path).is_some_and(flags_mark_dataless)
}

#[cfg(target_os = "macos")]
fn file_flags(path: &Path) -> Option<u32> {
    use std::os::macos::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|metadata| metadata.st_flags())
}

#[cfg(target_os = "ios")]
fn file_flags(path: &Path) -> Option<u32> {
    use std::os::ios::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|metadata| metadata.st_flags())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn file_flags(_path: &Path) -> Option<u32> {
    None
}

/// Whether iCloud keeps the file or folder at `path`: iCloud Drive, or the
/// Desktop and Documents folders iCloud syncs. The system answers from the
/// file's provider, whatever its path.
#[must_use]
pub fn is_icloud_item(path: &Path) -> bool {
    is_ubiquitous(path)
}

#[cfg(target_os = "macos")]
fn is_ubiquitous(path: &Path) -> bool {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let Some(text) = path.to_str() else {
        return false;
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(text));
    NSFileManager::defaultManager().isUbiquitousItemAtURL(&url)
}

#[cfg(not(target_os = "macos"))]
fn is_ubiquitous(_path: &Path) -> bool {
    false
}

/// Read the contents of a file of the space that is not a note: a service
/// file of `.mine`, the space identity. Such a read of a file whose contents
/// are in iCloud waits for the download; the callers that must never wait ask
/// [`is_content_offloaded`] first. In a build without release optimizations
/// the read is counted for a file a test marked as evicted (`test_seam`).
pub fn read_contents(path: &Path) -> std::io::Result<Vec<u8>> {
    read(path)
}

/// Open a file of the space for reading: a note, a media file, a service
/// file. The one door of every such read, so a test can stand a file for one
/// whose contents are in iCloud on every path that reads it (`test_seam`).
/// In a release build this is [`std::fs::File::open`].
///
/// # Errors
///
/// As [`std::fs::File::open`]; a read iCloud refuses is `EDEADLK`
/// ([`is_refusal`]).
pub fn open(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(debug_assertions)]
    test_seam::before_read(path)?;
    std::fs::File::open(path)
}

/// [`std::fs::read`] through the door of [`open`].
///
/// # Errors
///
/// As [`std::fs::read`]; a read iCloud refuses is `EDEADLK` ([`is_refusal`]).
pub fn read(path: &Path) -> std::io::Result<Vec<u8>> {
    #[cfg(debug_assertions)]
    test_seam::before_read(path)?;
    std::fs::read(path)
}

/// [`std::fs::read_to_string`] through the door of [`open`].
///
/// # Errors
///
/// As [`std::fs::read_to_string`]; a read iCloud refuses is `EDEADLK`
/// ([`is_refusal`]).
pub fn read_to_string(path: &Path) -> std::io::Result<String> {
    #[cfg(debug_assertions)]
    test_seam::before_read(path)?;
    std::fs::read_to_string(path)
}

/// Whether `error` is the refusal macOS gives a read of a file whose
/// contents are in iCloud when the read may not bring them down: `EDEADLK`,
/// «Resource deadlock avoided». The file is not broken: its contents are
/// elsewhere, and iCloud brings them when asked
/// (`icloud_downloads::request_downloads`). Seen on 17.11.2026 in a copy of
/// Mine started from a terminal whose processes have materialization off:
/// about 15 000 refused reads of notes and media in one morning.
#[must_use]
pub fn is_refusal(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::EDEADLK)
}

/// Let this process's reads of files whose contents are in iCloud bring the
/// contents down, as SPEC_CLOUD_STORAGE.md, Х23, has it.
///
/// The policy is the process's own and starts as its parent's: macOS gives a
/// new process the materialization policy of the one that started it, and
/// the system default is off (`man setiopolicy_np`). A copy of Mine started
/// from a terminal whose shell has it off had every such read refused
/// (`EDEADLK`), on 17.11.2026; a copy started from Finder had them all
/// brought down. Mine is built around the second: the background passes
/// read the notes and media they need and wait for them (Х1, Х24), so it
/// sets the policy itself at launch rather than take whatever its parent had.
///
/// # Errors
///
/// When the system refuses the policy; reads then follow the inherited one,
/// and every reader takes a refused read as "in iCloud" ([`is_refusal`]).
#[cfg(target_os = "macos")]
pub fn let_reads_bring_contents_down() -> std::io::Result<()> {
    // <sys/resource.h>
    const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: libc::c_int = 3;
    const IOPOL_SCOPE_PROCESS: libc::c_int = 0;
    const IOPOL_MATERIALIZE_DATALESS_FILES_ON: libc::c_int = 2;
    extern "C" {
        fn setiopolicy_np(iotype: libc::c_int, scope: libc::c_int, policy: libc::c_int) -> libc::c_int;
    }
    // SAFETY: `setiopolicy_np` takes three integers and touches no memory of
    // ours; it only changes the calling process's I/O policy.
    let status = unsafe {
        setiopolicy_np(
            IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
            IOPOL_SCOPE_PROCESS,
            IOPOL_MATERIALIZE_DATALESS_FILES_ON,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// No iCloud placeholders here: nothing to allow.
#[cfg(not(target_os = "macos"))]
pub fn let_reads_bring_contents_down() -> std::io::Result<()> {
    Ok(())
}

/// What a test may not do itself: make a dataless file. Only the kernel sets
/// `SF_DATALESS`, so a test names the files that stand for evicted ones, and
/// every read of such a file through the door of [`open`] is counted: a file
/// that was not to be brought down shows in the count (SPEC_DEEP_AUDIT.md,
/// Н5). A counted read brings the file down, as it does on a Mac whose
/// process may bring contents down: the file is local afterwards. A file a
/// test marks with [`test_seam::refuse_reads_of`] answers every read as macOS
/// answers a process that may not (`EDEADLK`), and stays in iCloud until the
/// test says it arrived ([`test_seam::mark_downloaded`]). A test may also hold
/// the reads of one file ([`test_seam::hold_reads_of`]), as a download that
/// takes long holds them. Built only without release optimizations: a release
/// build carries none of it, and nothing in Mine marks a file.
#[cfg(debug_assertions)]
pub mod test_seam {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex, PoisonError};
    use std::time::{Duration, Instant};

    static ANY_MARKED: AtomicBool = AtomicBool::new(false);
    static MARKED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    /// Marked files whose reads iCloud refuses (`EDEADLK`).
    static REFUSED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    static READS: Mutex<BTreeMap<PathBuf, usize>> = Mutex::new(BTreeMap::new());
    /// Files whose reads wait, each with whether a read has come to wait.
    static HELD: Mutex<BTreeMap<PathBuf, bool>> = Mutex::new(BTreeMap::new());
    static HELD_CHANGED: Condvar = Condvar::new();

    /// The file at `path` stands for one whose contents are in iCloud.
    pub fn mark_offloaded(path: &Path) {
        MARKED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_path_buf());
        ANY_MARKED.store(true, Ordering::Release);
    }

    /// The file at `path` stands for one whose contents are in iCloud, and
    /// every read of it is refused as macOS refuses the reads of a process
    /// that may not bring contents down: `EDEADLK`, at once, the file left
    /// in iCloud. The reads are counted all the same.
    pub fn refuse_reads_of(path: &Path) {
        REFUSED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_path_buf());
        mark_offloaded(path);
    }

    /// The contents of `path` arrived.
    pub fn mark_downloaded(path: &Path) {
        MARKED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(path);
        REFUSED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(path);
    }

    /// A read of the file at `path` is about to happen through the door of
    /// [`super::open`]: counted when the file stands for an evicted one, and
    /// refused when the test said iCloud refuses it.
    pub(crate) fn before_read(path: &Path) -> std::io::Result<()> {
        if is_marked(path)
            && REFUSED
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(path)
        {
            *READS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(path.to_path_buf())
                .or_default() += 1;
            return Err(std::io::Error::from_raw_os_error(libc::EDEADLK));
        }
        note_read(path);
        Ok(())
    }

    pub(crate) fn is_marked(path: &Path) -> bool {
        ANY_MARKED.load(Ordering::Acquire)
            && MARKED
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(path)
    }

    /// A read of the file at `path` happened: counted when the file stands
    /// for an evicted one, since such a read brings it down. A held read
    /// waits here until the test lets it go, as a slow download waits.
    pub(crate) fn note_read(path: &Path) {
        if is_marked(path) {
            *READS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(path.to_path_buf())
                .or_default() += 1;
            let mut held = HELD.lock().unwrap_or_else(PoisonError::into_inner);
            while let Some(reached) = held.get_mut(path) {
                *reached = true;
                HELD_CHANGED.notify_all();
                held = HELD_CHANGED
                    .wait(held)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            drop(held);
            mark_downloaded(path);
        }
    }

    /// Reads of the evicted file at `path` wait until the hold is dropped.
    #[must_use]
    pub fn hold_reads_of(path: &Path) -> ReadHold {
        HELD.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_path_buf(), false);
        ReadHold(path.to_path_buf())
    }

    /// A hold on the reads of one file; dropping it lets them go.
    pub struct ReadHold(PathBuf);

    impl ReadHold {
        /// Whether a read of the file came to wait within `timeout`.
        pub fn reached_within(&self, timeout: Duration) -> bool {
            let deadline = Instant::now() + timeout;
            let mut held = HELD.lock().unwrap_or_else(PoisonError::into_inner);
            loop {
                if held.get(&self.0).copied().unwrap_or(false) {
                    return true;
                }
                let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                    return false;
                };
                held = HELD_CHANGED
                    .wait_timeout(held, left)
                    .map_or_else(|poisoned| poisoned.into_inner().0, |(held, _)| held);
            }
        }
    }

    impl Drop for ReadHold {
        fn drop(&mut self) {
            HELD.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.0);
            HELD_CHANGED.notify_all();
        }
    }

    /// How many times the evicted note at `path` was read.
    #[must_use]
    pub fn reads_of(path: &Path) -> usize {
        READS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(path)
            .copied()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The flags of a note of an iCloud Desktop space as `stat` read them
    /// on 13.10.2026 (`ls -lO`: `compressed,dataless`), and of a local file.
    #[test]
    fn the_dataless_flag_tells_an_evicted_file() {
        assert!(flags_mark_dataless(0x4000_0060));
        assert!(!flags_mark_dataless(0x0000_0060));
        assert!(!flags_mark_dataless(0));
    }

    /// Е5.2: a path through a folder named `Mobile Documents` proves nothing.
    /// A sparse file there has the old signature of an evicted one (its full
    /// size, no blocks) and is a local file all the same.
    #[test]
    fn a_sparse_file_under_mobile_documents_is_local() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("Mobile Documents").join("Space");
        std::fs::create_dir_all(&folder).unwrap();
        let sparse = folder.join("picture.png");
        std::fs::File::create(&sparse).unwrap().set_len(64 * 1024).unwrap();

        assert!(!is_content_offloaded(&sparse));
        assert!(!is_icloud_item(&folder));
        assert!(!is_content_offloaded(&folder.join("missing.png")));
    }

    /// A file whose reads iCloud refuses answers every door as macOS
    /// answers a process that may not bring contents down, and stays in
    /// iCloud until its contents arrive.
    #[test]
    fn a_refused_file_answers_every_read_as_macos_does() {
        let temp = tempfile::tempdir().unwrap();
        let picture = temp.path().join("picture.png");
        std::fs::write(&picture, b"picture").unwrap();
        test_seam::refuse_reads_of(&picture);

        for error in [
            open(&picture).map(drop).unwrap_err(),
            read(&picture).map(drop).unwrap_err(),
            read_to_string(&picture).map(drop).unwrap_err(),
        ] {
            assert!(is_refusal(&error), "{error}");
            assert_eq!(error.to_string(), "Resource deadlock avoided (os error 11)");
        }
        assert!(is_content_offloaded(&picture));
        assert_eq!(test_seam::reads_of(&picture), 3);

        test_seam::mark_downloaded(&picture);
        assert_eq!(read(&picture).unwrap(), b"picture");
    }

    #[test]
    fn a_marked_note_is_offloaded_and_its_reads_are_counted() {
        let temp = tempfile::tempdir().unwrap();
        let note = temp.path().join("Note.md");
        std::fs::write(&note, "text").unwrap();
        test_seam::mark_offloaded(&note);
        assert!(is_content_offloaded(&note));
        test_seam::note_read(&note);
        assert_eq!(test_seam::reads_of(&note), 1);
        test_seam::mark_downloaded(&note);
        assert!(!is_content_offloaded(&note));
    }
}
