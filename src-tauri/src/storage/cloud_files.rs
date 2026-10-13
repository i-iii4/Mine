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

/// What a test may not do itself: make a dataless file. Only the kernel sets
/// `SF_DATALESS`, so a test names the files that stand for evicted ones, and
/// every read of such a note is counted (`files::read_block_file`): a note
/// that was not to be brought down shows in the count (SPEC_DEEP_AUDIT.md,
/// Н5). Built only without release optimizations: a release build carries
/// none of it, and nothing in Mine marks a file.
#[cfg(debug_assertions)]
pub mod test_seam {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, PoisonError};

    static ANY_MARKED: AtomicBool = AtomicBool::new(false);
    static MARKED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    static READS: Mutex<BTreeMap<PathBuf, usize>> = Mutex::new(BTreeMap::new());

    /// The file at `path` stands for one whose contents are in iCloud.
    pub fn mark_offloaded(path: &Path) {
        MARKED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_path_buf());
        ANY_MARKED.store(true, Ordering::Release);
    }

    /// The contents of `path` arrived.
    pub fn mark_downloaded(path: &Path) {
        MARKED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(path);
    }

    pub(crate) fn is_marked(path: &Path) -> bool {
        ANY_MARKED.load(Ordering::Acquire)
            && MARKED
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(path)
    }

    /// A read of the note at `path` happened: counted when the note stands
    /// for an evicted one, since such a read brings it down.
    pub(crate) fn note_read(path: &Path) {
        if is_marked(path) {
            *READS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(path.to_path_buf())
                .or_default() += 1;
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
