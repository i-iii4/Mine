/// Asking iCloud for file contents ahead of reading them.
///
/// Reading a file whose contents are in iCloud brings it down and waits for
/// it, one file at a time: about two seconds a note on the space measured on
/// 08.10.2026. Asking for every such file first lets iCloud fetch them side by
/// side while the reader goes through them in its usual order, waiting only
/// for those not here yet (SPEC_CLOUD_STORAGE.md, Х24). The request returns at
/// once; it never waits for a download.
use std::path::Path;

/// Ask iCloud to start bringing down the contents of `paths`. Returns how
/// many requests the system accepted; a refused one is left to the plain read
/// that follows, which still brings the file down.
#[cfg(target_os = "macos")]
pub fn request_downloads<'a>(paths: impl IntoIterator<Item = &'a Path>) -> usize {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let manager = NSFileManager::defaultManager();
    let mut accepted = 0;
    for path in paths {
        let Some(text) = path.to_str() else {
            continue;
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        match manager.startDownloadingUbiquitousItemAtURL_error(&url) {
            Ok(()) => accepted += 1,
            Err(error) => log::debug!(
                "iCloud download request refused for {}: {}",
                path.display(),
                error.localizedDescription()
            ),
        }
    }
    accepted
}

/// No iCloud here: the reader brings each file in as it reads it.
#[cfg(not(target_os = "macos"))]
pub fn request_downloads<'a>(_paths: impl IntoIterator<Item = &'a Path>) -> usize {
    0
}
