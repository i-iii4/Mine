//! Preserve document metadata before publishing a replacement inode.

use std::fs::File;
use std::io;
use std::path::Path;

pub(super) fn preserve(source: &Path, destination: &File) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "replacement source must be a regular file, not a symlink",
        ));
    }
    preserve_platform(source, destination)
}

#[cfg(target_os = "macos")]
fn preserve_platform(source: &Path, destination: &File) -> io::Result<()> {
    use std::ffi::{c_int, c_long, c_void};
    use std::os::fd::AsRawFd;
    use std::os::macos::fs::MetadataExt;

    // Public layouts and constants from macOS sys/attr.h and sys/_types/_timespec.h.
    #[repr(C)]
    struct AttrList {
        bitmap_count: u16,
        reserved: u16,
        common: u32,
        volume: u32,
        directory: u32,
        file: u32,
        fork: u32,
    }
    #[repr(C)]
    struct Timespec {
        seconds: c_long,
        nanoseconds: c_long,
    }
    const ATTR_BIT_MAP_COUNT: u16 = 5;
    const ATTR_CMN_CRTIME: u32 = 0x0000_0200;

    // macOS SDK copyfile.h: metadata only; never copy the old document bytes.
    const COPYFILE_METADATA: u32 = (1 << 0) | (1 << 1) | (1 << 2);
    unsafe extern "C" {
        fn fcopyfile(from: c_int, to: c_int, state: *mut c_void, flags: u32) -> c_int;
        fn fsetattrlist(
            fd: c_int,
            attributes: *mut AttrList,
            buffer: *mut c_void,
            size: usize,
            options: u32,
        ) -> c_int;
    }
    let source = File::open(source)?;
    let source_metadata = source.metadata()?;
    let modified = destination.metadata()?.modified()?;
    // SAFETY: both descriptors remain open throughout the call. A null state is
    // the documented default; COPYFILE_METADATA does not read/write file data.
    let result = unsafe {
        fcopyfile(
            source.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            COPYFILE_METADATA,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // COPYFILE_STAT also copies mtime, but edited bytes must retain a new mtime
    // so file watchers/index freshness continue to detect content changes.
    destination.set_times(std::fs::FileTimes::new().set_modified(modified))?;
    // COPYFILE_STAT preserves mtime but does not guarantee birthtime. Set it
    // explicitly, including on a second replacement and on transaction rollback.
    let mut attributes = AttrList {
        bitmap_count: ATTR_BIT_MAP_COUNT,
        reserved: 0,
        common: ATTR_CMN_CRTIME,
        volume: 0,
        directory: 0,
        file: 0,
        fork: 0,
    };
    let mut created = Timespec {
        seconds: source_metadata.st_birthtime(),
        nanoseconds: source_metadata.st_birthtime_nsec(),
    };
    // SAFETY: the attrlist requests exactly one timespec, and the writable
    // buffer has that layout/size. The destination descriptor remains valid.
    let result = unsafe {
        fsetattrlist(
            destination.as_raw_fd(),
            &mut attributes,
            std::ptr::from_mut(&mut created).cast(),
            std::mem::size_of::<Timespec>(),
            0,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn preserve_platform(source: &Path, destination: &File) -> io::Result<()> {
    destination.set_permissions(std::fs::metadata(source)?.permissions())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::storage::files::{prepare_replacement_temp_file, write_atomically};
    use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::process::Command;

    fn seed(path: &Path) -> std::fs::Metadata {
        std::fs::write(path, b"position: 9\n").unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
            .unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(Command::new("/usr/bin/xattr")
            .args(["-w", "com.mine.metadata-test", "retained"])
            .arg(path)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("/bin/chmod")
            .args(["+a", "everyone allow readattr"])
            .arg(path)
            .status()
            .unwrap()
            .success());
        std::fs::metadata(path).unwrap()
    }

    fn assert_preserved(path: &Path, before: &std::fs::Metadata, bytes: &[u8]) {
        let after = std::fs::metadata(path).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(after.created().unwrap(), before.created().unwrap());
        assert_eq!(after.mode(), before.mode());
        assert_eq!(after.uid(), before.uid());
        assert_eq!(after.gid(), before.gid());
        assert!(after.modified().unwrap() > before.modified().unwrap());
        let attribute = Command::new("/usr/bin/xattr")
            .args(["-p", "com.mine.metadata-test"])
            .arg(path)
            .output()
            .unwrap();
        assert!(attribute.status.success());
        assert_eq!(attribute.stdout, b"retained\n");
        let acl = Command::new("/bin/ls")
            .arg("-le")
            .arg(path)
            .output()
            .unwrap();
        assert!(acl.status.success());
        let acl_text = String::from_utf8(acl.stdout).unwrap();
        // Sandboxed name lookup can print the well-known everyone UUID instead.
        assert!(
            acl_text.contains("everyone allow readattr")
                || acl_text.contains("ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C allow readattr"),
            "ACL after replacement: {acl_text}"
        );
    }

    #[test]
    fn atomic_replacement_preserves_document_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collection.md");
        let before = seed(&path);
        write_atomically(&path, b"position: 10\n").unwrap();
        assert_preserved(&path, &before, b"position: 10\n");
    }

    #[test]
    fn staged_replacement_and_rollback_preserve_document_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collection.md");
        let before = seed(&path);
        let committed = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
            path.clone(),
            b"position: 10\n".to_vec(),
        )])
        .unwrap()
        .commit()
        .unwrap();
        assert_preserved(&path, &before, b"position: 10\n");
        committed.rollback("injected index failure").unwrap();
        assert_preserved(&path, &before, b"position: 9\n");
    }

    #[test]
    fn rename_with_content_preserves_document_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("before.md");
        let destination = dir.path().join("after.md");
        let before = seed(&source);
        let committed = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            source.clone(),
            destination.clone(),
            b"position: 10\n".to_vec(),
        )])
        .unwrap()
        .commit()
        .unwrap();
        assert_preserved(&destination, &before, b"position: 10\n");
        committed.rollback("injected index failure").unwrap();
        assert!(!destination.exists());
    }

    #[test]
    fn metadata_failure_leaves_original_and_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collection.md");
        let before = seed(&path);
        let result = prepare_replacement_temp_file(&path, &dir.path().join("missing"), |file| {
            use std::io::Write;
            file.write_all(b"replacement")
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"position: 9\n");
        assert_eq!(
            std::fs::metadata(&path).unwrap().created().unwrap(),
            before.created().unwrap()
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn new_document_has_own_creation_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");
        let earliest = std::time::SystemTime::now() - std::time::Duration::from_secs(1);
        write_atomically(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(std::fs::metadata(&path).unwrap().created().unwrap() >= earliest);
    }
}
