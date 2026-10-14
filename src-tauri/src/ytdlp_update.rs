//! The video downloader keeps itself current (SPEC_DEEP_AUDIT.md, Н15;
//! SPEC_ONBOARDING.md, О8.4).
//!
//! The bundled `yt-dlp` is pinned when Mine is built, and YouTube changes its
//! player on its own schedule: a build a couple of months old starts getting
//! HTTP 403 for every video. Mine fetches the vendor's newest release itself:
//! the same unpacked macOS build `scripts/fetch-ytdlp.mjs` takes, checked
//! against the release's `SHA2-256SUMS` before it is unpacked, laid out and
//! signed ad hoc the way the bundle's copy is, with no quarantine attribute,
//! and run once before it is taken. It lives in this Mac's app data, never in
//! the bundle, and is used instead of the bundled one when it is newer, by
//! Download Media and by the clipper's helper alike.
//!
//! A failed update changes nothing: the previous downloader stays, and the
//! failure goes to the log.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::tool_process::{self, RunningTools, YTDLP_DIRECTORY, YTDLP_EXECUTABLE};

/// The version `scripts/fetch-ytdlp.mjs` puts in the bundle; a test keeps the
/// two the same.
pub const BUNDLED_VERSION: &str = "2026.08.19";
/// The folder in the app data that holds updated downloaders.
pub const UPDATES_DIRECTORY: &str = "yt-dlp-updates";
/// The record of the updated downloader in use, in `UPDATES_DIRECTORY`.
const INSTALLED_FILE: &str = "installed.json";
/// The vendor's unpacked macOS build, the asset `fetch-ytdlp.mjs` takes.
pub const ARCHIVE_ASSET: &str = "yt-dlp_macos.zip";
/// The release's list of SHA-256 sums.
pub const SUMS_ASSET: &str = "SHA2-256SUMS";
/// The vendor's name for the launcher inside the archive.
const VENDOR_EXECUTABLE: &str = "yt-dlp_macos";
/// The whole update, from asking for the newest release to the first run.
pub const UPDATE_TIME_LIMIT: Duration = Duration::from_secs(10 * 60);
/// The first run of a fresh copy is slow once (SPEC_ONBOARDING.md, О8.1):
/// 14 s measured on 07.10.2026.
const FIRST_RUN_TIME_LIMIT: Duration = Duration::from_secs(120);
/// No release asset is anywhere near this; a longer answer is not one.
const MAX_ASSET_BYTES: u64 = 400 * 1024 * 1024;
const QUARANTINE: &str = "com.apple.quarantine";

/// One update at a time: two downloads refused at once update once, and the
/// second finds the first's result current.
static UPDATING: Mutex<()> = Mutex::new(());

/// A release version as numbers: `2026.08.19` and `2026.08.19.1`. Anything
/// else is not a version, and never a folder name.
fn version_key(version: &str) -> Option<Vec<u64>> {
    if version.is_empty() || version.len() > 32 {
        return None;
    }
    version
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                None
            } else {
                part.parse().ok()
            }
        })
        .collect()
}

/// Whether `candidate` is a later release than `than`.
#[must_use]
pub fn is_newer(candidate: &str, than: &str) -> bool {
    match (version_key(candidate), version_key(than)) {
        (Some(candidate), Some(than)) => candidate > than,
        _ => false,
    }
}

/// The folder of updated downloaders in `app_data`.
#[must_use]
pub fn updates_dir(app_data: &Path) -> PathBuf {
    app_data.join(UPDATES_DIRECTORY)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Installed {
    version: String,
}

/// The updated downloader in `app_data`, with its version, when one was
/// installed and its launcher is there.
#[must_use]
pub fn installed(app_data: &Path) -> Option<(String, PathBuf)> {
    let dir = updates_dir(app_data);
    let record: Installed = serde_json::from_slice(&std::fs::read(dir.join(INSTALLED_FILE)).ok()?).ok()?;
    version_key(&record.version)?;
    let launcher = tool_process::ytdlp_in(&dir.join(&record.version));
    launcher.is_file().then_some((record.version, launcher))
}

/// The downloader to run: the updated copy in `app_data` when it is newer
/// than the bundled one, else the bundled one, else whatever was updated.
#[must_use]
pub fn choose(app_data: Option<&Path>, bundled: Option<PathBuf>) -> Option<PathBuf> {
    match (app_data.and_then(installed), bundled) {
        (Some((version, updated)), Some(bundled)) => {
            Some(if is_newer(&version, BUNDLED_VERSION) { updated } else { bundled })
        }
        (Some((_, updated)), None) => Some(updated),
        (None, bundled) => bundled,
    }
}

/// Where releases come from: GitHub in the app, a stand-in in tests.
pub trait Releases {
    /// The tag of the newest release.
    ///
    /// # Errors
    /// The answer did not come or named no release.
    fn latest_tag(&self) -> Result<String, String>;

    /// Write `asset` of release `tag` to `to`, giving up at `deadline` or
    /// when `stopped` says so.
    ///
    /// # Errors
    /// The asset did not come whole.
    fn download(
        &self,
        tag: &str,
        asset: &str,
        to: &Path,
        deadline: Instant,
        stopped: &dyn Fn() -> bool,
    ) -> Result<(), String>;
}

/// The project's official releases on GitHub.
pub struct GitHubReleases {
    agent: ureq::Agent,
}

impl Default for GitHubReleases {
    fn default() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(20))
                .timeout_read(Duration::from_secs(60))
                .redirects(5)
                .build(),
        }
    }
}

const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

impl Releases for GitHubReleases {
    fn latest_tag(&self) -> Result<String, String> {
        let answer: serde_json::Value = self
            .agent
            .get(LATEST)
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|error| format!("newest release: {error}"))?
            .into_json()
            .map_err(|error| format!("newest release: {error}"))?;
        answer
            .get("tag_name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "newest release: no tag in the answer".to_owned())
    }

    fn download(
        &self,
        tag: &str,
        asset: &str,
        to: &Path,
        deadline: Instant,
        stopped: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        let response = self
            .agent
            .get(&format!("{RELEASES}/{tag}/{asset}"))
            .call()
            .map_err(|error| format!("{asset}: {error}"))?;
        copy_within(response.into_reader(), to, deadline, stopped).map_err(|error| format!("{asset}: {error}"))
    }
}

/// Copy `from` into a new file `to`, no longer than `deadline` allows.
fn copy_within(mut from: impl Read, to: &Path, deadline: Instant, stopped: &dyn Fn() -> bool) -> Result<(), String> {
    let mut file = std::fs::File::create(to).map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut written = 0u64;
    loop {
        if stopped() {
            return Err("stopped".into());
        }
        if Instant::now() >= deadline {
            return Err("the update ran out of time".into());
        }
        let read = from.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        written += read as u64;
        if written > MAX_ASSET_BYTES {
            return Err("the asset is larger than any release".into());
        }
        file.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
    }
    file.sync_all().map_err(|error| error.to_string())
}

/// What an update came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// A newer downloader is installed now and used from here on.
    Installed(String),
    /// The downloader in use is the newest release.
    Current(String),
}

/// Why an update installed nothing. The downloader in use stays.
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("{0}")]
    Release(String),
    #[error("the release tag {0:?} is not a version")]
    Tag(String),
    #[error("{SUMS_ASSET} lists no sum for {ARCHIVE_ASSET}")]
    NoSum,
    #[error("{ARCHIVE_ASSET} has SHA-256 {actual}, the release lists {expected}")]
    Sum { expected: String, actual: String },
    #[error("unexpected yt-dlp layout: {0}")]
    Layout(String),
    #[error("the downloader could not be prepared: {0}")]
    Prepare(String),
    #[error("the new downloader does not run: {0}")]
    FirstRun(String),
    #[error("{0}")]
    Io(String),
}

fn io(error: impl std::fmt::Display) -> UpdateError {
    UpdateError::Io(error.to_string())
}

/// Install the newest release into `app_data` when it is newer than the
/// downloader in use. Every tool it runs is one of `tools`, so whoever owns
/// them ends the update with them; `stopped` ends the download of the assets.
///
/// # Errors
/// Nothing new was installed; the downloader in use stays.
pub fn update(
    app_data: &Path,
    releases: &dyn Releases,
    tools: &RunningTools,
    stopped: &dyn Fn() -> bool,
) -> Result<UpdateOutcome, UpdateError> {
    let _one = UPDATING.lock().unwrap_or_else(PoisonError::into_inner);
    let deadline = Instant::now() + UPDATE_TIME_LIMIT;
    let tag = releases.latest_tag().map_err(UpdateError::Release)?;
    if version_key(&tag).is_none() {
        return Err(UpdateError::Tag(tag));
    }
    let in_use = installed(app_data)
        .map(|(version, _)| version)
        .filter(|version| is_newer(version, BUNDLED_VERSION))
        .unwrap_or_else(|| BUNDLED_VERSION.to_owned());
    if !is_newer(&tag, &in_use) {
        return Ok(UpdateOutcome::Current(in_use));
    }

    let dir = updates_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(io)?;
    // Inside the updates folder: the finished copy is renamed into place on
    // the same volume, and an interrupted update leaves nothing in use.
    let staging = tempfile::Builder::new().prefix(".staging-").tempdir_in(&dir).map_err(io)?;

    let sums = staging.path().join(SUMS_ASSET);
    releases
        .download(&tag, SUMS_ASSET, &sums, deadline, stopped)
        .map_err(UpdateError::Release)?;
    let expected = listed_sum(&std::fs::read_to_string(&sums).map_err(io)?).ok_or(UpdateError::NoSum)?;
    let archive = staging.path().join(ARCHIVE_ASSET);
    releases
        .download(&tag, ARCHIVE_ASSET, &archive, deadline, stopped)
        .map_err(UpdateError::Release)?;
    let actual = sha256_of(&archive).map_err(io)?;
    if actual != expected {
        return Err(UpdateError::Sum { expected, actual });
    }

    let unpacked = staging.path().join(YTDLP_DIRECTORY);
    std::fs::create_dir(&unpacked).map_err(io)?;
    run(
        Command::new("/usr/bin/ditto").arg("-x").arg("-k").arg(&archive).arg(&unpacked),
        deadline,
        tools,
    )
    .map_err(|error| UpdateError::Prepare(format!("unpack: {error}")))?;
    normalize_onedir(&unpacked)?;
    clear_quarantine(&unpacked).map_err(|error| UpdateError::Prepare(format!("quarantine: {error}")))?;
    sign_and_verify(&unpacked, deadline, tools)?;
    let launcher = unpacked.join(YTDLP_EXECUTABLE);
    let first_run = tool_process::run_with_deadline(
        Command::new(&launcher).arg("--version"),
        FIRST_RUN_TIME_LIMIT.min(deadline.saturating_duration_since(Instant::now())),
        tools,
    )
    .map_err(|failure| UpdateError::FirstRun(failure.to_string()))?;
    let reported = first_run.stdout.trim();
    if reported != tag {
        return Err(UpdateError::FirstRun(format!("it reports version {reported:?}, the release is {tag}")));
    }
    if stopped() {
        return Err(UpdateError::Release("stopped".into()));
    }

    let target = dir.join(&tag);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(io)?;
    }
    std::fs::create_dir(&target).map_err(io)?;
    std::fs::rename(&unpacked, target.join(YTDLP_DIRECTORY)).map_err(io)?;
    write_installed(&dir, &tag)?;
    prune(&dir, &tag, &in_use);
    Ok(UpdateOutcome::Installed(tag))
}

fn run(command: &mut Command, deadline: Instant, tools: &RunningTools) -> Result<(), String> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err("the update ran out of time".into());
    }
    tool_process::run_with_deadline(command, left, tools)
        .map(|_| ())
        .map_err(|failure| failure.to_string())
}

/// The sum `SHA2-256SUMS` lists for the archive: `<hex>  <name>` lines.
fn listed_sum(sums: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == ARCHIVE_ASSET && sum.len() == 64 && sum.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| sum.to_ascii_lowercase())
    })
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Every entry under `root`, depth first, without following links.
fn walk(root: &Path) -> std::io::Result<Vec<(PathBuf, std::fs::FileType)>> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            }
            found.push((entry.path(), kind));
        }
    }
    Ok(found)
}

/// Turn the unpacked vendor archive at `root` into the tree that runs, by
/// the rule of `normalizeOnedir` in `scripts/fetch-ytdlp.mjs`: the copies of
/// `_internal/Python.framework` go after each proved a byte copy of what
/// stays, no symlink is left, and the launcher takes its stable name.
fn normalize_onedir(root: &Path) -> Result<(), UpdateError> {
    let layout = |text: String| UpdateError::Layout(text);
    let vendor = root.join(VENDOR_EXECUTABLE);
    let python = root.join("_internal").join("Python");
    for required in [&vendor, &python] {
        let is_file = std::fs::symlink_metadata(required).is_ok_and(|metadata| metadata.is_file());
        if !is_file {
            return Err(layout(format!("{} is missing", required.strip_prefix(root).unwrap_or(required).display())));
        }
    }
    let framework = root.join("_internal").join("Python.framework");
    if let Ok(metadata) = std::fs::symlink_metadata(&framework) {
        if !metadata.is_dir() {
            return Err(layout("Python.framework is not a directory".into()));
        }
        let python_bytes = std::fs::read(&python).map_err(io)?;
        let mut plist: Option<Vec<u8>> = None;
        for (path, kind) in walk(&framework).map_err(io)? {
            if kind.is_dir() {
                continue;
            }
            let inside = path.strip_prefix(&framework).unwrap_or(&path).display().to_string();
            if !kind.is_file() {
                return Err(layout(format!("Python.framework/{inside} is not a file")));
            }
            let bytes = std::fs::read(&path).map_err(io)?;
            match path.file_name().and_then(|name| name.to_str()) {
                Some("Python") if bytes == python_bytes => {}
                Some("Python") => return Err(layout(format!("Python.framework/{inside} differs from _internal/Python"))),
                Some("Info.plist") => {
                    let first = plist.get_or_insert_with(|| bytes.clone());
                    if *first != bytes {
                        return Err(layout(format!("Python.framework/{inside} differs from its copies")));
                    }
                }
                _ => return Err(layout(format!("Python.framework/{inside} has no kept counterpart"))),
            }
        }
        std::fs::remove_dir_all(&framework).map_err(io)?;
    }
    for (path, kind) in walk(root).map_err(io)? {
        if kind.is_symlink() {
            return Err(layout(format!("{} is a symlink", path.strip_prefix(root).unwrap_or(&path).display())));
        }
    }
    let launcher = root.join(YTDLP_EXECUTABLE);
    std::fs::rename(&vendor, &launcher).map_err(io)?;
    std::fs::set_permissions(&launcher, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755))
        .map_err(io)
}

/// Take the quarantine attribute off every entry under `root` and `root`
/// itself: ad-hoc signed code with it is what Gatekeeper refuses (О8.1).
fn clear_quarantine(root: &Path) -> std::io::Result<()> {
    let mut paths = vec![root.to_path_buf()];
    paths.extend(walk(root)?.into_iter().map(|(path, _)| path));
    for path in paths {
        remove_attribute(&path, QUARANTINE)?;
    }
    Ok(())
}

fn remove_attribute(path: &Path, name: &str) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let name = std::ffi::CString::new(name)?;
    // SAFETY: both arguments are valid NUL-terminated strings that outlive
    // the call.
    let removed = unsafe { libc::removexattr(path.as_ptr(), name.as_ptr(), libc::XATTR_NOFOLLOW) };
    if removed == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOATTR) {
        Ok(())
    } else {
        Err(error)
    }
}

/// Whether `path` names an attribute `name`.
#[cfg(test)]
fn has_attribute(path: &Path, name: &str) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let name = std::ffi::CString::new(name).unwrap();
    // SAFETY: valid NUL-terminated strings; a null buffer asks for the size.
    unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, libc::XATTR_NOFOLLOW) >= 0 }
}

const MACHO_MAGIC: [[u8; 4]; 8] = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca],
];

fn is_macho(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && MACHO_MAGIC.iter().any(|magic| bytes[..4] == *magic)
}

/// PyInstaller's archive cookie and its length.
const PYINSTALLER_COOKIE: [u8; 8] = [0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e];
const COOKIE_LENGTH: usize = 88;

fn be_u32(bytes: &[u8], at: usize) -> Option<usize> {
    let slice = bytes.get(at..at + 4)?;
    usize::try_from(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]])).ok()
}

/// Whether a PyInstaller archive in `bytes` writes anything to disk when it
/// starts, by the rule of `pyinstallerExtractedEntries` in
/// `scripts/verify-bundle-binaries.mjs`: a one-file build does, the launcher
/// of an unpacked build does not. A damaged archive counts as extracting.
fn unpacks_at_start(bytes: &[u8]) -> bool {
    let Some(cookie) = bytes.windows(PYINSTALLER_COOKIE.len()).rposition(|window| window == PYINSTALLER_COOKIE) else {
        return false;
    };
    let (Some(archive_length), Some(toc_offset), Some(toc_length)) =
        (be_u32(bytes, cookie + 8), be_u32(bytes, cookie + 12), be_u32(bytes, cookie + 16))
    else {
        return true;
    };
    let Some(archive_start) = (cookie + COOKIE_LENGTH).checked_sub(archive_length) else {
        return true;
    };
    let toc = archive_start + toc_offset;
    let Some(end) = toc.checked_add(toc_length).filter(|end| *end <= bytes.len()) else {
        return true;
    };
    let mut at = toc;
    while at < end {
        let Some(entry_length) = be_u32(bytes, at) else {
            return true;
        };
        if entry_length < 18 || at + entry_length > end {
            return true;
        }
        if matches!(bytes[at + 17], b'b' | b'x' | b'd' | b'n' | b'l') {
            return true;
        }
        at += entry_length;
    }
    false
}

/// Sign every Mach-O file under `root` ad hoc, as the bundle's copy is
/// (`scripts/finalize-local-bundle.mjs`), then check it by the rules of
/// `scripts/verify-bundle-binaries.mjs`: each signature verifies strictly and
/// none of them is a one-file build that unpacks itself at start.
fn sign_and_verify(root: &Path, deadline: Instant, tools: &RunningTools) -> Result<(), UpdateError> {
    let prepare = |text: String| UpdateError::Prepare(text);
    let mut code = Vec::new();
    for (path, kind) in walk(root).map_err(io)? {
        if !kind.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(io)?;
        if !is_macho(&bytes) {
            continue;
        }
        if unpacks_at_start(&bytes) {
            return Err(prepare(format!("{} is a one-file build", path.display())));
        }
        code.push(path);
    }
    for path in &code {
        run(
            Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-", "--timestamp=none"])
                .arg(path),
            deadline,
            tools,
        )
        .map_err(|error| prepare(format!("sign {}: {error}", path.display())))?;
    }
    for path in &code {
        run(Command::new("/usr/bin/codesign").args(["--verify", "--strict"]).arg(path), deadline, tools)
            .map_err(|error| prepare(format!("verify {}: {error}", path.display())))?;
    }
    Ok(())
}

/// Record `version` as the downloader in use, atomically.
fn write_installed(dir: &Path, version: &str) -> Result<(), UpdateError> {
    let bytes = serde_json::to_vec_pretty(&Installed { version: version.to_owned() }).map_err(io)?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(io)?;
    temporary.write_all(&bytes).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(dir.join(INSTALLED_FILE)).map_err(io)?;
    Ok(())
}

/// Remove updated downloaders other than the new one and the one it
/// replaces: a clipper may still be running that one.
fn prune(dir: &Path, new: &str, previous: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == new || name == previous || version_key(name).is_none() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(entry.path()) {
            log::warn!("old video downloader {}: {error}", entry.path().display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A release served from memory: the network is never asked.
    struct FakeReleases {
        tag: String,
        assets: HashMap<String, Vec<u8>>,
        downloads: AtomicUsize,
    }

    impl Releases for FakeReleases {
        fn latest_tag(&self) -> Result<String, String> {
            Ok(self.tag.clone())
        }

        fn download(&self, tag: &str, asset: &str, to: &Path, _: Instant, _: &dyn Fn() -> bool) -> Result<(), String> {
            assert_eq!(tag, self.tag);
            self.downloads.fetch_add(1, Ordering::SeqCst);
            let bytes = self.assets.get(asset).ok_or_else(|| format!("{asset}: 404"))?;
            std::fs::write(to, bytes).map_err(|error| error.to_string())?;
            if asset == ARCHIVE_ASSET {
                // As a browser would mark it: the attribute must not survive.
                set_quarantine(to);
            }
            Ok(())
        }
    }

    fn set_quarantine(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let name = std::ffi::CString::new(QUARANTINE).unwrap();
        let value = b"0081;00000000;Test;";
        // SAFETY: valid strings and a buffer of the given length.
        let set = unsafe {
            libc::setxattr(c_path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, libc::XATTR_NOFOLLOW)
        };
        assert_eq!(set, 0, "{}", std::io::Error::last_os_error());
    }

    /// The vendor's archive in miniature: a launcher that reports `version`,
    /// `_internal/Python` as real Mach-O code, and the framework copies the
    /// vendor writes in place of symlinks.
    fn vendor_archive(version: &str) -> Vec<u8> {
        let tree = tempfile::tempdir().unwrap();
        let launcher = tree.path().join(VENDOR_EXECUTABLE);
        std::fs::write(&launcher, format!("#!/bin/sh\necho {version}\n")).unwrap();
        std::fs::set_permissions(&launcher, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755))
            .unwrap();
        let internal = tree.path().join("_internal");
        std::fs::create_dir_all(internal.join("Python.framework/Versions/3.13/Resources")).unwrap();
        std::fs::copy("/usr/bin/true", internal.join("Python")).unwrap();
        std::fs::copy("/usr/bin/true", internal.join("Python.framework/Versions/3.13/Python")).unwrap();
        std::fs::write(internal.join("Python.framework/Versions/3.13/Resources/Info.plist"), b"<plist/>").unwrap();
        let archive = tempfile::tempdir().unwrap();
        let zip = archive.path().join(ARCHIVE_ASSET);
        let status = Command::new("/usr/bin/ditto")
            .args(["-c", "-k"])
            .arg(tree.path())
            .arg(&zip)
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::read(zip).unwrap()
    }

    fn release(tag: &str, archive: Vec<u8>, listed_sum: &str) -> FakeReleases {
        let sums = format!("{}  yt-dlp\n{listed_sum}  {ARCHIVE_ASSET}\n", "0".repeat(64));
        FakeReleases {
            tag: tag.to_owned(),
            assets: HashMap::from([(SUMS_ASSET.to_owned(), sums.into_bytes()), (ARCHIVE_ASSET.to_owned(), archive)]),
            downloads: AtomicUsize::new(0),
        }
    }

    fn sum(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    const NEWER: &str = "2026.10.01";

    /// Н15: a release whose archive matches its listed sum is unpacked, laid
    /// out, signed, freed of quarantine, run once and taken over the bundled
    /// downloader.
    #[test]
    fn a_release_with_the_right_sum_is_installed_and_taken() {
        let app_data = tempfile::tempdir().unwrap();
        let archive = vendor_archive(NEWER);
        let releases = release(NEWER, archive.clone(), &sum(&archive));
        let outcome = update(app_data.path(), &releases, &RunningTools::new(), &|| false).expect("installed");
        assert_eq!(outcome, UpdateOutcome::Installed(NEWER.to_owned()));

        let (version, launcher) = installed(app_data.path()).expect("recorded");
        assert_eq!(version, NEWER);
        let onedir = launcher.parent().unwrap();
        assert!(!onedir.join("_internal/Python.framework").exists(), "the framework copies stayed");
        let python = onedir.join("_internal/Python");
        let verified = Command::new("/usr/bin/codesign").args(["--verify", "--strict"]).arg(&python).status().unwrap();
        assert!(verified.success(), "the code is not signed");
        for (path, _) in walk(onedir).unwrap() {
            assert!(!has_attribute(&path, QUARANTINE), "{} is quarantined", path.display());
        }
        let bundled = PathBuf::from("/bundle/yt-dlp-onedir/yt-dlp");
        assert_eq!(choose(Some(app_data.path()), Some(bundled)), Some(launcher));
        // No working folder is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(updates_dir(app_data.path()))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".staging"))
            .collect();
        assert!(leftovers.is_empty());

        // Asked again, the release is current: nothing is downloaded.
        let before = releases.downloads.load(Ordering::SeqCst);
        let again = update(app_data.path(), &releases, &RunningTools::new(), &|| false).unwrap();
        assert_eq!(again, UpdateOutcome::Current(NEWER.to_owned()));
        assert_eq!(releases.downloads.load(Ordering::SeqCst), before);
    }

    /// Н15: an archive whose sum differs from the listed one is refused
    /// before it is unpacked; the downloader in use stays.
    #[test]
    fn a_release_with_the_wrong_sum_is_refused() {
        let app_data = tempfile::tempdir().unwrap();
        let archive = vendor_archive(NEWER);
        let releases = release(NEWER, archive, &"a".repeat(64));
        let error = update(app_data.path(), &releases, &RunningTools::new(), &|| false).expect_err("refused");
        assert!(matches!(error, UpdateError::Sum { .. }), "{error}");
        assert_eq!(installed(app_data.path()), None);
        assert!(!updates_dir(app_data.path()).join(NEWER).exists());
        let bundled = PathBuf::from("/bundle/yt-dlp-onedir/yt-dlp");
        assert_eq!(choose(Some(app_data.path()), Some(bundled.clone())), Some(bundled));
    }

    #[test]
    fn a_release_no_newer_than_the_bundled_one_is_not_fetched() {
        let app_data = tempfile::tempdir().unwrap();
        let releases = release(BUNDLED_VERSION, Vec::new(), &"a".repeat(64));
        let outcome = update(app_data.path(), &releases, &RunningTools::new(), &|| false).unwrap();
        assert_eq!(outcome, UpdateOutcome::Current(BUNDLED_VERSION.to_owned()));
        assert_eq!(releases.downloads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_updated_copy_older_than_the_bundled_one_is_not_taken() {
        let app_data = tempfile::tempdir().unwrap();
        let dir = updates_dir(app_data.path());
        let old = tool_process::ytdlp_in(&dir.join("2025.01.01"));
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"").unwrap();
        write_installed(&dir, "2025.01.01").unwrap();
        let bundled = PathBuf::from("/bundle/yt-dlp-onedir/yt-dlp");
        assert_eq!(choose(Some(app_data.path()), Some(bundled.clone())), Some(bundled));
        assert_eq!(choose(Some(app_data.path()), None), Some(old));
    }

    #[test]
    fn quarantine_is_taken_off_every_entry() {
        let tree = tempfile::tempdir().unwrap();
        let nested = tree.path().join("_internal");
        std::fs::create_dir(&nested).unwrap();
        let file = nested.join("lib.so");
        std::fs::write(&file, b"x").unwrap();
        for path in [tree.path(), nested.as_path(), file.as_path()] {
            set_quarantine(path);
        }
        clear_quarantine(tree.path()).unwrap();
        for path in [tree.path(), nested.as_path(), file.as_path()] {
            assert!(!has_attribute(path, QUARANTINE), "{}", path.display());
        }
    }

    #[test]
    fn versions_compare_as_numbers_and_nothing_else_is_one() {
        assert!(is_newer("2026.10.01", "2026.08.19"));
        assert!(is_newer("2026.08.19.1", "2026.08.19"));
        assert!(!is_newer("2026.08.19", "2026.08.19"));
        assert!(!is_newer("../evil", "2026.08.19"));
        assert!(!is_newer("2026.10.01-nightly", "2026.08.19"));
        assert_eq!(version_key(""), None);
    }

    #[test]
    fn the_listed_sum_is_the_archives_line() {
        let sums = format!("{}  yt-dlp\n{}  yt-dlp_macos.zip\n", "1".repeat(64), "AB".repeat(32));
        assert_eq!(listed_sum(&sums), Some("ab".repeat(32)));
        assert_eq!(listed_sum("nothing here"), None);
    }

    #[test]
    fn a_one_file_build_is_told_from_an_unpacked_launcher() {
        // An archive whose one entry has type `type_` and a cookie after it.
        fn archive(type_: u8) -> Vec<u8> {
            let mut bytes = vec![0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0];
            let toc_offset = bytes.len();
            let mut entry = vec![0u8; 18];
            entry.extend_from_slice(b"name\0");
            let entry_length = entry.len();
            entry[..4].copy_from_slice(&u32::try_from(entry_length).unwrap().to_be_bytes());
            entry[17] = type_;
            bytes.extend_from_slice(&entry);
            let mut cookie = PYINSTALLER_COOKIE.to_vec();
            let archive_length = bytes.len() + COOKIE_LENGTH;
            cookie.extend_from_slice(&u32::try_from(archive_length).unwrap().to_be_bytes());
            cookie.extend_from_slice(&u32::try_from(toc_offset).unwrap().to_be_bytes());
            cookie.extend_from_slice(&u32::try_from(entry_length).unwrap().to_be_bytes());
            cookie.resize(COOKIE_LENGTH, 0);
            bytes.extend_from_slice(&cookie);
            bytes
        }
        assert!(unpacks_at_start(&archive(b'b')));
        assert!(!unpacks_at_start(&archive(b'z')));
        assert!(!unpacks_at_start(&[0xcf, 0xfa, 0xed, 0xfe]));
    }

    #[test]
    fn the_bundled_version_is_the_one_the_fetch_script_pins() {
        let script = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fetch-ytdlp.mjs"))
            .unwrap();
        assert!(script.contains(&format!("const VERSION = '{BUNDLED_VERSION}';")), "fetch-ytdlp.mjs pins another version");
    }
}
