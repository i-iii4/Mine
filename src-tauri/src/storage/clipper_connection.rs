//! One last extension-confirmed native handshake, separate from vaults and capture.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

/// Development identity derived from the bundled public manifest key.
pub const DEV_EXTENSION_ID: &str = "eioalidaccoahofcggkbinalibpajokh";
const SCHEMA_VERSION: u32 = 1;
const RECORD_NAME: &str = "last-connection-check.json";
const MAX_RECORD_BYTES: u64 = 4096;

/// Historical evidence that the extension received a host status response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ClipperConnectionCheck {
    pub schema_version: u32,
    pub check_id: String,
    pub confirmed_at: String,
    pub host_version: String,
    pub host_api_version: u32,
    pub extension_id: String,
}

fn valid_check_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn validate_record(record: &ClipperConnectionCheck) -> Result<()> {
    if record.schema_version != SCHEMA_VERSION
        || !valid_check_id(&record.check_id)
        || record.extension_id != DEV_EXTENSION_ID
        || record.host_api_version == 0
        || record.host_version.is_empty()
        || record.host_version.len() > 64
        || !record
            .host_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
    {
        bail!("invalid connection-check record");
    }
    crate::domain::block::DateTime::new(&record.confirmed_at)
        .map_err(|error| anyhow::anyhow!("invalid connection-check time: {error}"))?;
    Ok(())
}

fn check_directory(path: &Path, create: bool) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => bail!("connection-check directory is not a regular directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path).context("create connection-check directory")?;
            check_directory(path, false)
        }
        Err(error) => Err(error).context("inspect connection-check directory"),
    }
}

fn record_directory(app_data_root: &Path, create: bool) -> Result<Option<PathBuf>> {
    if !app_data_root.is_absolute() {
        bail!("connection-check root must be an absolute app-local path");
    }
    if !check_directory(app_data_root, create)? {
        return Ok(None);
    }
    let directory = app_data_root.join("clipper");
    Ok(check_directory(&directory, create)?.then_some(directory))
}

fn check_regular_file(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => bail!("connection-check path is not a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).context("inspect connection-check file"),
    }
}

/// Read historical evidence without creating directories or contacting a browser.
pub fn read_last_connection_check(app_data_root: &Path) -> Result<Option<ClipperConnectionCheck>> {
    let Some(directory) = record_directory(app_data_root, false)? else {
        return Ok(None);
    };
    let path = directory.join(RECORD_NAME);
    if !check_regular_file(&path)? {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        bail!("connection-check record exceeds size limit");
    }
    let record = serde_json::from_slice(&bytes).context("read connection-check record")?;
    validate_record(&record)?;
    Ok(Some(record))
}

/// Persist an explicit ACK. The caller supplies trusted process metadata, not request paths.
/// Failure is diagnostic only and must never alter a status or capture result.
pub fn confirm_connection_check(
    app_data_root: &Path,
    launch_origin: &str,
    check_id: &str,
    host_version: &str,
    host_api_version: u32,
) -> Result<ClipperConnectionCheck> {
    if launch_origin != format!("chrome-extension://{DEV_EXTENSION_ID}/") {
        bail!("connection-check origin is not allowed");
    }
    if !valid_check_id(check_id) {
        bail!("invalid connection-check ID");
    }
    let directory = record_directory(app_data_root, true)?
        .context("connection-check directory is unavailable")?;
    let lock_path = directory.join(".connection-check.lock");
    check_regular_file(&lock_path)?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(lock_path)
        .context("open connection-check lock")?;
    // Diagnostics never wait behind another writer or gate capture success.
    lock.try_lock_exclusive()
        .context("connection-check record is busy")?;
    let record = ClipperConnectionCheck {
        schema_version: SCHEMA_VERSION,
        check_id: check_id.into(),
        confirmed_at: crate::util::now_iso8601(),
        host_version: host_version.into(),
        host_api_version,
        extension_id: DEV_EXTENSION_ID.into(),
    };
    validate_record(&record)?;
    let path = directory.join(RECORD_NAME);
    check_regular_file(&path)?;
    let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
    staged.write_all(&serde_json::to_vec(&record)?)?;
    staged.as_file().sync_all()?;
    staged.persist(path).map_err(|error| error.error)?;
    File::open(directory)?.sync_all()?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHECK_ID: &str = "dd830aea-79ae-4b2e-9e09-66c37c70f96c";

    fn confirm(root: &Path, id: &str) -> Result<ClipperConnectionCheck> {
        confirm_connection_check(
            root,
            &format!("chrome-extension://{DEV_EXTENSION_ID}/"),
            id,
            "0.1.0",
            2,
        )
    }

    #[test]
    fn absent_record_read_has_no_side_effects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app-state");
        assert!(read_last_connection_check(&root).unwrap().is_none());
        assert!(!root.exists());
    }

    #[test]
    fn ack_persists_one_validated_historical_result() {
        let temp = tempfile::tempdir().unwrap();
        let first = confirm(temp.path(), CHECK_ID).unwrap();
        assert_eq!(
            read_last_connection_check(temp.path()).unwrap(),
            Some(first)
        );
        let second = confirm(temp.path(), "731f98f5-7d98-4369-b8ed-e2a23fd4c317").unwrap();
        assert_eq!(
            read_last_connection_check(temp.path()).unwrap(),
            Some(second)
        );
        assert_eq!(
            std::fs::read_dir(temp.path().join("clipper"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn untrusted_origin_and_path_like_id_never_create_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app-state");
        for origin in [
            "",
            "https://example.com/",
            "chrome-extension://wrong/",
            "chrome-extension://eioalidaccoahofcggkbinalibpajokh/extra",
        ] {
            assert!(confirm_connection_check(&root, origin, CHECK_ID, "0.1.0", 2).is_err());
        }
        assert!(confirm(&root, "../../outside").is_err());
        assert!(!root.exists());
    }

    #[test]
    fn corrupt_and_oversized_records_are_diagnostic_errors() {
        let temp = tempfile::tempdir().unwrap();
        confirm(temp.path(), CHECK_ID).unwrap();
        let path = temp.path().join("clipper").join(RECORD_NAME);
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_last_connection_check(temp.path()).is_err());
        std::fs::write(path, vec![b' '; MAX_RECORD_BYTES as usize + 1]).unwrap();
        assert!(read_last_connection_check(temp.path()).is_err());
    }

    #[test]
    fn busy_diagnostic_writer_is_skipped_without_replacing_last_result() {
        let temp = tempfile::tempdir().unwrap();
        let first = confirm(temp.path(), CHECK_ID).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp.path().join("clipper/.connection-check.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        assert!(confirm(temp.path(), "731f98f5-7d98-4369-b8ed-e2a23fd4c317").is_err());
        assert_eq!(
            read_last_connection_check(temp.path()).unwrap(),
            Some(first)
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_directory_record_and_lock_cannot_redirect_writes() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join("clipper")).unwrap();
        assert!(confirm(temp.path(), CHECK_ID).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        std::fs::remove_file(temp.path().join("clipper")).unwrap();
        std::fs::create_dir(temp.path().join("clipper")).unwrap();
        let external_file = outside.path().join("unchanged");
        std::fs::write(&external_file, b"original").unwrap();
        for name in [RECORD_NAME, ".connection-check.lock"] {
            let case = tempfile::tempdir().unwrap();
            std::fs::create_dir(case.path().join("clipper")).unwrap();
            let link = case.path().join("clipper").join(name);
            symlink(&external_file, &link).unwrap();
            assert!(confirm(case.path(), CHECK_ID).is_err());
            assert_eq!(std::fs::read(&external_file).unwrap(), b"original");
            std::fs::remove_file(link).unwrap();
        }
    }
}
