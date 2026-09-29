//! Where browsers find the clipper helper (SPEC_CLIPPER.md, К4).
//!
//! One list, read by the installer that writes the registrations and by the
//! helper that checks whether it is still the one registered: a browser keeps
//! its connection to a running helper for the whole session, so a helper
//! replaced by a newer build must notice it and step aside.

use std::path::{Path, PathBuf};

/// Native messaging host name, matched by the extension's manifest.
pub const HOST_NAME: &str = "com.mine.clipper.v1";

/// A Chromium-family browser that supports native messaging.
pub struct BrowserTarget {
    /// Shown to the user.
    pub label: &'static str,
    /// Path of the browser's native messaging directory, relative to Library.
    pub manifest_dir: &'static str,
}

pub const BROWSERS: &[BrowserTarget] = &[
    BrowserTarget {
        label: "Chrome",
        manifest_dir: "Application Support/Google/Chrome/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Dia",
        manifest_dir: "Application Support/Dia/User Data/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Arc",
        manifest_dir: "Application Support/Arc/User Data/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Edge",
        manifest_dir: "Application Support/Microsoft Edge/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Brave",
        manifest_dir: "Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    },
];

/// The person's `~/Library`.
pub fn library_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library"))
}

/// The registration file of `browser` under `library`.
pub fn manifest_path(library: &Path, browser: &BrowserTarget) -> PathBuf {
    library
        .join(browser.manifest_dir)
        .join(format!("{HOST_NAME}.json"))
}

/// The helper executables the browsers' registrations name now.
pub fn registered_helpers(library: &Path) -> Vec<PathBuf> {
    BROWSERS
        .iter()
        .filter_map(|browser| {
            let bytes = std::fs::read(manifest_path(library, browser)).ok()?;
            let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            value
                .get("path")
                .and_then(serde_json::Value::as_str)
                .map(PathBuf::from)
        })
        .collect()
}

/// Whether `helper` is what some registration names.
pub fn is_registered(library: &Path, helper: &Path) -> bool {
    registered_helpers(library)
        .iter()
        .any(|path| same_file(path, helper))
}

/// A helper that was registered is superseded once no registration names it
/// and some registration names another helper that exists.
pub fn superseded(library: &Path, helper: &Path) -> bool {
    let registered = registered_helpers(library);
    !registered.iter().any(|path| same_file(path, helper))
        && registered.iter().any(|path| path.is_file())
}

fn same_file(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (std::fs::canonicalize(left), std::fs::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register(library: &Path, browser: &BrowserTarget, helper: &Path) {
        let path = manifest_path(library, browser);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            serde_json::json!({ "name": HOST_NAME, "path": helper, "type": "stdio" }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn a_new_registration_supersedes_the_running_helper() {
        let tmp = tempfile::tempdir().unwrap();
        let library = tmp.path().join("Library");
        let old = tmp.path().join("packages/old/native-host");
        let new = tmp.path().join("packages/new/native-host");
        for helper in [&old, &new] {
            std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
            std::fs::write(helper, b"helper").unwrap();
        }
        register(&library, &BROWSERS[0], &old);
        register(&library, &BROWSERS[1], &old);
        assert!(is_registered(&library, &old));
        assert!(!superseded(&library, &old));

        register(&library, &BROWSERS[0], &new);
        // Still named by one browser: the old helper keeps serving it.
        assert!(!superseded(&library, &old));
        register(&library, &BROWSERS[1], &new);
        assert!(superseded(&library, &old));
        assert!(!superseded(&library, &new));
    }

    #[test]
    fn a_registration_of_a_missing_helper_supersedes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let library = tmp.path().join("Library");
        let running = tmp.path().join("native-host");
        std::fs::write(&running, b"helper").unwrap();
        register(&library, &BROWSERS[0], &tmp.path().join("gone/native-host"));
        assert!(!superseded(&library, &running));
        assert!(!superseded(&tmp.path().join("NoLibrary"), &running));
    }
}
