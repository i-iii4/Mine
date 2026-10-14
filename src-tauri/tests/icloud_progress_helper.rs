//! The iCloud progress helper (`native/icloud_progress_helper.swift`) on files
//! outside iCloud. What it says comes from the file's flags and from whether
//! iCloud keeps the file, never from the file's path; a sparse file is not an
//! evicted one (SPEC_CLOUD_STORAGE.md, Х3, Х4; SPEC_DEEP_AUDIT.md, Е5.2).
//!
//! The test compiles the helper's source into a temporary folder and runs
//! that, so what it checks is this source and nothing a build left behind. A
//! file iCloud really keeps, or really evicted, exists only in a live iCloud.
#![cfg(target_os = "macos")]

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

const SOURCE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/native/icloud_progress_helper.swift"
);

/// The helper compiled from its source into `dir`.
fn compiled_helper(dir: &Path) -> PathBuf {
    let executable = dir.join("icloud-progress-helper");
    let status = Command::new("xcrun")
        .arg("swiftc")
        .arg("-module-cache-path")
        .arg(dir.join("module-cache"))
        .arg("-o")
        .arg(&executable)
        .arg(SOURCE)
        .status()
        .expect("swiftc runs: Xcode Command Line Tools are required");
    assert!(status.success(), "the helper's source compiles");
    executable
}

/// The helper's one JSON line about `file`.
fn answer(helper: &Path, file: &Path) -> Value {
    let output = Command::new(helper).arg(file).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn the_helper_reads_the_file_not_its_path() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let helper = compiled_helper(&root);

    // A folder named like iCloud Drive does not make its files iCloud's.
    let looks_like_icloud = root.join("Library/Mobile Documents/com~apple~CloudDocs");
    std::fs::create_dir_all(&looks_like_icloud).unwrap();
    let note = looks_like_icloud.join("Note.md");
    std::fs::write(&note, "# Note\n").unwrap();
    assert_eq!(answer(&helper, &note), json!({ "status": "not_managed" }));

    // Full size and no allocated blocks is a sparse file. Only the kernel's
    // dataless flag marks an evicted one.
    let sparse = looks_like_icloud.join("Sparse.bin");
    std::fs::File::create(&sparse)
        .unwrap()
        .set_len(1 << 20)
        .unwrap();
    let metadata = std::fs::metadata(&sparse).unwrap();
    assert_eq!(
        (metadata.len(), metadata.blocks()),
        (1 << 20, 0),
        "the file system keeps the file sparse"
    );
    assert_eq!(answer(&helper, &sparse), json!({ "status": "not_managed" }));

    // A file that is not there has no state to tell.
    assert_eq!(
        answer(&helper, &root.join("Missing.md")),
        json!({ "status": "unknown" })
    );

    // The contract is one path: anything else is refused, with no answer.
    let refused = Command::new(&helper).output().unwrap();
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());
}
