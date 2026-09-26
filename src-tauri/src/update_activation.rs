//! macOS activation supervision. The helper is a mode of the signed app itself.
//! A live or unidentifiable process is never killed or overwritten on recovery.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
static INTERACTIVE: AtomicBool = AtomicBool::new(false);
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;
fn nonce() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BuildIdentity {
    pub version: String,
    pub build_id: String,
    pub commit: String,
    pub save_protocols: Vec<u32>,
}
pub fn build_identity() -> BuildIdentity {
    BuildIdentity {
        version: env!("CARGO_PKG_VERSION").into(),
        build_id: env!("MINE_BUILD_ID").into(),
        commit: env!("MINE_BUILD_COMMIT").into(),
        save_protocols: vec![crate::runtime_protocol::BASE_SAVE_PROTOCOL],
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivationPhase {
    Prepared,
    Installed,
    LaunchIntent,
    Launched,
    Verified,
    RolledBack,
    RecoveryRequired,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActivationJournal {
    pub schema_version: u32,
    pub phase: ActivationPhase,
    pub target: PathBuf,
    pub previous: PathBuf,
    pub candidate: PathBuf,
    pub replacement: PathBuf,
    pub executable_relative: PathBuf,
    pub candidate_sha256: String,
    pub previous_sha256: String,
    pub executable_sha256: String,
    pub archive_sha256: String,
    pub identity: BuildIdentity,
    pub previous_identity: BuildIdentity,
    pub old_pid: u32,
    pub candidate_pid: Option<u32>,
    pub token: String,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Handshake {
    pid: u32,
    executable: PathBuf,
    identity: BuildIdentity,
    token: String,
}

pub fn file_hash(path: &Path) -> Result<String> {
    std::fs::read(path)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .map_err(|error| error.to_string())
}
/// Include every bundle member and symlink target, not just its main executable.
pub fn tree_hash(root: &Path) -> Result<String> {
    fn framed(hash: &mut Sha256, bytes: &[u8]) {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    fn visit(root: &Path, path: &Path, hash: &mut Sha256) -> Result<()> {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        framed(hash, relative.to_string_lossy().as_bytes());
        if metadata.file_type().is_symlink() {
            framed(hash, b"link");
            framed(
                hash,
                std::fs::read_link(path)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        } else if metadata.is_dir() {
            framed(hash, b"directory");
            let mut paths = std::fs::read_dir(path)
                .map_err(|error| error.to_string())?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?;
            paths.sort();
            for path in paths {
                visit(root, &path, hash)?;
            }
        } else if metadata.is_file() {
            framed(hash, b"file");
            framed(
                hash,
                &std::fs::read(path).map_err(|error| error.to_string())?,
            );
        } else {
            return Err("unsupported bundle member".into());
        }
        hash.update([0]);
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(root, root, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}
fn bounded_output(command: &mut Command, timeout: Duration) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;
    let reader = |pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(1024 * 1024 + 1).read_to_end(&mut bytes);
            result.map(|_| bytes)
        })
    };
    let out = reader(Box::new(stdout));
    let err = reader(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("owned verification/copy subprocess timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = out
        .join()
        .map_err(|_| "stdout reader failed")?
        .map_err(|error| error.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "stderr reader failed")?
        .map_err(|error| error.to_string())?;
    if stdout.len() > 1024 * 1024 || stderr.len() > 1024 * 1024 {
        return Err("verification output exceeds limit".into());
    }
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }
    Ok(stdout)
}
fn command_success(command: &mut Command) -> Result<()> {
    bounded_output(command, Duration::from_secs(120)).map(|_| ())
}
fn sync_tree(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            sync_tree(&entry.map_err(|error| error.to_string())?.path())?;
        }
    }
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}
fn tree_bytes(path: &Path) -> Result<u64> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    let mut total = 0u64;
    for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
        total = total
            .checked_add(tree_bytes(
                &entry.map_err(|error| error.to_string())?.path(),
            )?)
            .ok_or("package size overflow")?;
    }
    Ok(total)
}
fn check_disk(root: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut extracted = 0u64;
    for entry in archive.entries().map_err(|error| error.to_string())? {
        extracted = extracted
            .checked_add(entry.map_err(|error| error.to_string())?.size())
            .ok_or("archive size overflow")?;
    }
    let reserve = 256u64 * 1024 * 1024;
    let previous = tree_bytes(target)?;
    let needed = extracted
        .checked_add(previous)
        .and_then(|size| size.checked_add(reserve))
        .ok_or("disk budget overflow")?;
    if fs2::available_space(root).map_err(|error| error.to_string())? < needed
        || fs2::available_space(target.parent().ok_or("missing install parent")?)
            .map_err(|error| error.to_string())?
            < extracted.saturating_add(reserve)
    {
        return Err("insufficient free space for candidate and retained previous package".into());
    }
    Ok(())
}
pub fn verify_bundle(path: &Path) -> Result<()> {
    command_success(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(path),
    )?;
    command_success(
        Command::new("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute"])
            .arg(path),
    )
}
fn copy_bundle(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err("immutable retained bundle already exists".into());
    }
    command_success(Command::new("/usr/bin/ditto").arg(source).arg(destination))
}
fn bundle_executable(bundle: &Path) -> Result<PathBuf> {
    let value = plist::Value::from_file(bundle.join("Contents/Info.plist"))
        .map_err(|error| error.to_string())?;
    let name = value
        .as_dictionary()
        .and_then(|value| value.get("CFBundleExecutable"))
        .and_then(plist::Value::as_string)
        .ok_or("bundle executable is missing")?;
    if Path::new(name).components().count() != 1 || name == "." || name == ".." {
        return Err("unsafe executable name".into());
    }
    Ok(PathBuf::from("Contents/MacOS").join(name))
}
fn probe(executable: &Path) -> Result<BuildIdentity> {
    let output = bounded_output(
        Command::new(executable).arg("--mine-build-info"),
        Duration::from_secs(5),
    )?;
    let identity: BuildIdentity =
        serde_json::from_slice(&output).map_err(|error| error.to_string())?;
    if identity.build_id.len() != 64
        || !identity
            .save_protocols
            .contains(&crate::runtime_protocol::BASE_SAVE_PROTOCOL)
    {
        return Err("candidate does not support baseline startup/save contract".into());
    }
    Ok(identity)
}
/// The archive was already cryptographically verified by the updater owner.
pub fn extract_candidate(bytes: &[u8], directory: &Path) -> Result<PathBuf> {
    std::fs::create_dir(directory).map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut bundle = None;
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        let mut parts = path
            .components()
            .filter(|part| !matches!(part, std::path::Component::CurDir));
        let first = match parts.next() {
            Some(std::path::Component::Normal(first))
                if first.to_string_lossy().ends_with(".app") =>
            {
                first.to_owned()
            }
            _ => return Err("archive must contain exactly one app bundle".into()),
        };
        if parts.any(|part| !matches!(part, std::path::Component::Normal(_))) {
            return Err("unsafe archive path".into());
        }
        if bundle.as_ref().is_some_and(|name| name != &first) {
            return Err("multiple archive bundles".into());
        }
        bundle = Some(first);
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            return Err("unsupported archive member".into());
        }
        if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|error| error.to_string())?
                .ok_or("missing link target")?;
            let mut depth = path
                .components()
                .filter(|part| matches!(part, std::path::Component::Normal(_)))
                .count()
                - 1;
            for part in target.components() {
                match part {
                    std::path::Component::Normal(_) => depth += 1,
                    std::path::Component::CurDir => {}
                    std::path::Component::ParentDir if depth > 1 => depth -= 1,
                    _ => return Err("bundle symlink escapes signed archive".into()),
                }
            }
        }
        if !entry
            .unpack_in(directory)
            .map_err(|error| error.to_string())?
        {
            return Err("archive escapes staging root".into());
        }
    }
    Ok(directory.join(bundle.ok_or("empty archive")?))
}
/// Own only derived updater state. This remains writable after the source gate closes.
fn persist(path: &Path, journal: &ActivationJournal) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or("missing journal parent")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(&serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    std::fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}
fn read(path: &Path) -> Result<ActivationJournal> {
    let journal: ActivationJournal =
        serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if journal.schema_version != 1
        || !journal.target.is_absolute()
        || journal
            .target
            .extension()
            .is_none_or(|extension| extension != "app")
        || journal
            .executable_relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        || journal.token.len() < 32
    {
        return Err("unknown or unsafe activation journal preserved".into());
    }
    let root = path.parent().ok_or("missing root")?;
    if journal.previous != root.join("previous.app")
        || !journal.candidate.starts_with(root.join("candidate"))
        || journal.replacement.parent() != journal.target.parent()
        || journal
            .replacement
            .file_name()
            .is_none_or(|name| !name.to_string_lossy().starts_with("Mine-update-"))
    {
        return Err("retained package path escapes activation root".into());
    }
    Ok(journal)
}
pub fn prepare(
    root: &Path,
    bytes: &[u8],
    archive_hash: &str,
    target: &Path,
    version: &str,
) -> Result<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Err("safe activation is supported only on macOS".into());
    }
    verify_bundle(target)?;
    check_disk(root, target, bytes)?;
    let directory = root.join(format!("activation-{}", nonce()?));
    std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let candidate = extract_candidate(bytes, &directory.join("candidate"))?;
    verify_bundle(&candidate)?;
    let executable_relative = bundle_executable(&candidate)?;
    if executable_relative != bundle_executable(target)? {
        return Err("candidate changed the baseline helper executable location".into());
    }
    let identity = probe(&candidate.join(&executable_relative))?;
    if identity.version != version {
        return Err("signed build identity differs from announced version".into());
    }
    let previous = directory.join("previous.app");
    let previous_identity = probe(&target.join(bundle_executable(target)?))?;
    copy_bundle(target, &previous)?;
    verify_bundle(&previous)?;
    sync_tree(&previous)?;
    sync_tree(&candidate)?;
    let replacement = target.with_file_name(format!("Mine-update-{}.app", nonce()?));
    copy_bundle(&candidate, &replacement)?;
    verify_bundle(&replacement)?;
    sync_tree(&replacement)?;
    let journal = ActivationJournal {
        schema_version: 1,
        phase: ActivationPhase::Prepared,
        target: target.to_owned(),
        candidate_sha256: tree_hash(&candidate)?,
        previous_sha256: tree_hash(&previous)?,
        executable_sha256: file_hash(&candidate.join(&executable_relative))?,
        previous,
        candidate,
        replacement,
        executable_relative,
        archive_sha256: archive_hash.into(),
        identity,
        previous_identity,
        old_pid: std::process::id(),
        candidate_pid: None,
        token: nonce()?,
        error: None,
    };
    let path = directory.join("activation-journal.json");
    persist(&path, &journal)?;
    Ok(path)
}
pub fn mark_installed(path: &Path) -> Result<()> {
    let mut journal = read(path)?;
    journal.phase = ActivationPhase::Installed;
    persist(path, &journal)
}
#[cfg(target_os = "macos")]
fn atomic_swap(left: &Path, right: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let left =
        std::ffi::CString::new(left.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
    let right =
        std::ffi::CString::new(right.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    if unsafe { renamex_np(left.as_ptr(), right.as_ptr(), 2) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn atomic_swap(_left: &Path, _right: &Path) -> Result<()> {
    Err("atomic application swap unavailable".into())
}
pub fn activate(path: &Path) -> Result<()> {
    let journal = read(path)?;
    if tree_hash(&journal.target)? != journal.previous_sha256
        || tree_hash(&journal.replacement)? != journal.candidate_sha256
    {
        return Err("activation topology changed before swap".into());
    }
    verify_bundle(&journal.replacement)?;
    atomic_swap(&journal.target, &journal.replacement)?;
    std::fs::File::open(journal.target.parent().ok_or("missing install parent")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    mark_installed(path)
}
pub fn cancel(path: &Path, error: &str) -> Result<()> {
    let mut journal = read(path)?;
    journal.phase = ActivationPhase::RecoveryRequired;
    journal.error = Some(error.into());
    persist(path, &journal)
}
pub fn verify_archive_binding(
    path: &Path,
    hash: &str,
    bytes: &[u8],
    restoring: bool,
) -> Result<()> {
    let journal = read(path)?;
    if journal.archive_sha256 != hash {
        return Err("activation journal differs from signed download".into());
    }
    let temporary = tempfile::tempdir_in(path.parent().ok_or("missing updater root")?)
        .map_err(|error| error.to_string())?;
    let extracted = extract_candidate(bytes, &temporary.path().join("signed"))?;
    if tree_hash(&extracted)? != journal.candidate_sha256
        || tree_hash(&journal.candidate)? != journal.candidate_sha256
        || bundle_executable(&extracted)? != journal.executable_relative
    {
        return Err("activation candidate differs from signed archive".into());
    }
    verify_bundle(&extracted)?;
    if probe(&extracted.join(&journal.executable_relative))? != journal.identity {
        return Err("activation identity differs from signed executable".into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    if executable != journal.previous.join(&journal.executable_relative)
        || tree_hash(&journal.target)?
            != if restoring {
                journal.candidate_sha256.clone()
            } else {
                journal.previous_sha256.clone()
            }
    {
        return Err("watchdog is not the retained installed application".into());
    }
    Ok(())
}
pub fn latest_phase(
    root: &Path,
    archive_hash: Option<&str>,
) -> Result<Option<(ActivationPhase, Option<String>)>> {
    let pointer = root.join("latest-activation.json");
    let bytes = match std::fs::read(pointer) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let path: PathBuf = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if !path.starts_with(root)
        || path
            .file_name()
            .is_none_or(|name| name != "activation-journal.json")
    {
        return Err("activation pointer escapes updater root".into());
    }
    let journal = read(&path)?;
    if archive_hash != Some(journal.archive_sha256.as_str()) {
        return Ok(None);
    }
    if journal.phase == ActivationPhase::Verified
        && (std::env::current_exe().ok().as_deref()
            != Some(journal.target.join(&journal.executable_relative).as_path())
            || build_identity() != journal.identity)
    {
        return Ok(Some((ActivationPhase::RecoveryRequired,Some("verified activation belongs to another executable; current process has not passed its startup check".into()))));
    }
    Ok(Some((journal.phase, journal.error)))
}
pub fn publish_pointer(root: &Path, path: &Path) -> Result<()> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(root.join("latest-activation.json"))
        .map_err(|error| error.to_string())?;
    std::fs::File::open(root)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}
pub fn launch_watchdog(path: &Path, restoring: bool) -> Result<()> {
    // Current signed installed executable is the helper, never a development target.
    let journal = read(path)?;
    verify_bundle(&journal.target)?;
    let executable = journal.previous.join(&journal.executable_relative);
    let mut child = Command::new(executable)
        .arg(if restoring {
            "--mine-update-restore"
        } else {
            "--mine-update-watchdog"
        })
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    use std::io::BufRead;
    let stdout = child.stdout.take().ok_or("missing helper readiness pipe")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line);
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "installed watchdog readiness timed out")?
        .map_err(|error| error.to_string())?;
    if line.trim() != "mine-watchdog-ready" {
        return Err("installed watchdog did not confirm readiness".into());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn process_path(pid: u32) -> Option<PathBuf> {
    unsafe extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    }
    let mut bytes = vec![0u8; 4096];
    let size = unsafe { proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if size <= 0 {
        return None;
    }
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    Some(PathBuf::from(
        String::from_utf8_lossy(&bytes[..end]).to_string(),
    ))
}
#[cfg(not(target_os = "macos"))]
fn process_path(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}
fn process_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1) }
}
fn valid_handshake(
    journal: &ActivationJournal,
    handshake: &Handshake,
    actual_path: Option<&Path>,
) -> bool {
    let expected = journal.target.join(&journal.executable_relative);
    handshake.pid == journal.candidate_pid.unwrap_or(0)
        && handshake.token == journal.token
        && handshake.identity == journal.identity
        && handshake.executable == expected
        && actual_path == Some(expected.as_path())
        && file_hash(&expected).is_ok_and(|hash| hash == journal.executable_sha256)
}
/// Called only after the real frontend has committed an interactive surface.
pub fn record_interactive() -> Result<()> {
    INTERACTIVE.store(true, Ordering::Release);
    let Some(path) = std::env::var_os("MINE_UPDATE_HANDSHAKE_JOURNAL").map(PathBuf::from) else {
        return Ok(());
    };
    let journal = read(&path)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    if executable != journal.target.join(&journal.executable_relative)
        || build_identity() != journal.identity
    {
        return Err("startup does not match expected signed candidate".into());
    }
    let handshake = Handshake {
        pid: std::process::id(),
        executable,
        identity: build_identity(),
        token: journal.token,
    };
    let bytes = serde_json::to_vec(&handshake).map_err(|error| error.to_string())?;
    crate::storage::files::write_atomically(&path.with_file_name("handshake.json"), &bytes)
        .map_err(|error| error.to_string())
}
/// Recovery refuses every destructive action while a launched process may write.
fn recover(path: &Path, journal: &mut ActivationJournal, candidate_alive: bool) -> Result<()> {
    if candidate_alive
        || tree_hash(&journal.previous)? != journal.previous_sha256
        || tree_hash(&journal.target).ok().as_deref() != Some(&journal.candidate_sha256)
    {
        journal.phase = ActivationPhase::RecoveryRequired;
        journal.error=Some("candidate still running or package identity changed; previous app retained without overwrite".into());
        return persist(path, journal);
    }
    verify_bundle(&journal.previous)?;
    let instance = match crate::util::acquire_single_instance("com.mine.app")
        .map_err(|error| error.to_string())?
    {
        crate::util::SingleInstanceAcquire::Primary(guard) => guard,
        crate::util::SingleInstanceAcquire::Secondary => {
            journal.phase = ActivationPhase::RecoveryRequired;
            journal.error = Some(
                "another application process is active; previous app retained without overwrite"
                    .into(),
            );
            return persist(path, journal);
        }
    };
    let restored = journal
        .target
        .with_file_name(format!("Mine-restore-{}.app", nonce()?));
    copy_bundle(&journal.previous, &restored)?;
    verify_bundle(&restored)?;
    if probe(&restored.join(bundle_executable(&restored)?))? != journal.previous_identity {
        return Err("restored app identity differs from retained previous".into());
    }
    let failed = path.parent().ok_or("missing root")?.join("failed.app");
    sync_tree(&restored)?;
    atomic_swap(&journal.target, &restored)?;
    let _ = std::fs::rename(&restored, &failed);
    std::fs::File::open(journal.target.parent().ok_or("missing parent")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    journal.phase = ActivationPhase::RolledBack;
    persist(path, journal)?;
    drop(instance);
    if let Err(error) = Command::new(journal.target.join(bundle_executable(&journal.target)?))
        .env_remove("MINE_UPDATE_HANDSHAKE_JOURNAL")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        journal.error = Some(format!(
            "previous app restored but relaunch failed: {error}"
        ));
        persist(path, journal)?;
    }
    Ok(())
}
pub fn request_restore(path: &Path, pid: u32) -> Result<()> {
    let mut journal = read(path)?;
    if std::env::current_exe().map_err(|error| error.to_string())?
        != journal.target.join(&journal.executable_relative)
        || build_identity() != journal.identity
        || tree_hash(&journal.target)? != journal.candidate_sha256
        || tree_hash(&journal.previous)? != journal.previous_sha256
    {
        return Err("current process cannot safely restore this activation".into());
    }
    journal.old_pid = pid;
    journal.candidate_pid = Some(pid);
    journal.phase = ActivationPhase::RecoveryRequired;
    journal.error = Some("previous-version restoration explicitly requested".into());
    persist(path, &journal)
}
pub fn restore_watchdog(path: &Path) -> Result<()> {
    let lock = activation_lock(path)?;
    lock.try_lock_exclusive()
        .map_err(|_| "activation already has a supervising process")?;
    let mut journal = read(path)?;
    verify_bundle(&journal.previous)?;
    if tree_hash(&journal.previous)? != journal.previous_sha256 {
        return Err("retained previous app changed".into());
    }
    println!("mine-watchdog-ready");
    use std::io::Write;
    std::io::stdout()
        .flush()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while process_alive(journal.old_pid) {
        if Instant::now() >= deadline {
            journal.error =
                Some("current app did not exit; restoration refused without killing it".into());
            return persist(path, &journal);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    recover(path, &mut journal, false)
}
pub fn latest_path(root: &Path) -> Result<PathBuf> {
    let path: PathBuf = serde_json::from_slice(
        &std::fs::read(root.join("latest-activation.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if !path.starts_with(root) {
        return Err("activation pointer escapes updater root".into());
    }
    read(&path)?;
    Ok(path)
}
pub fn watchdog(path: &Path) -> Result<()> {
    let lock = activation_lock(path)?;
    if lock.try_lock_exclusive().is_err() {
        return Err("activation already has a supervising process".into());
    }
    let mut journal = read(path)?;
    if tree_hash(&journal.previous)? != journal.previous_sha256
        || tree_hash(&journal.candidate)? != journal.candidate_sha256
    {
        return Err("retained bundle differs from verified bytes".into());
    }
    verify_bundle(&journal.previous)?;
    verify_bundle(&journal.candidate)?;
    println!("mine-watchdog-ready");
    use std::io::Write;
    std::io::stdout()
        .flush()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while process_alive(journal.old_pid) {
        if read(path)?.phase == ActivationPhase::RecoveryRequired {
            return Ok(());
        }
        if Instant::now() >= deadline {
            journal.phase = ActivationPhase::RecoveryRequired;
            journal.error =
                Some("previous process did not exit; no replacement or kill performed".into());
            return persist(path, &journal);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let mut frozen = journal.clone();
    frozen.phase = ActivationPhase::Prepared;
    frozen.candidate_pid = None;
    frozen.error = None;
    journal = read(path)?;
    let mut reopened = journal.clone();
    reopened.phase = ActivationPhase::Prepared;
    reopened.candidate_pid = None;
    reopened.error = None;
    if reopened != frozen {
        return Err("activation identity changed while previous process was exiting".into());
    }
    if tree_hash(&journal.target)? != journal.candidate_sha256 {
        journal.phase = ActivationPhase::RecoveryRequired;
        journal.error = Some("installation was interrupted; previous app retained".into());
        return persist(path, &journal);
    }
    verify_bundle(&journal.target)?;
    let executable = journal.target.join(&journal.executable_relative);
    journal.phase = ActivationPhase::LaunchIntent;
    persist(path, &journal)?;
    let mut candidate = Command::new(&executable)
        .env("MINE_UPDATE_HANDSHAKE_JOURNAL", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    journal.phase = ActivationPhase::Launched;
    journal.candidate_pid = Some(candidate.id());
    persist(path, &journal)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(bytes) = std::fs::read(path.with_file_name("handshake.json")) {
            if let Ok(handshake) = serde_json::from_slice::<Handshake>(&bytes) {
                if valid_handshake(
                    &journal,
                    &handshake,
                    process_path(candidate.id()).as_deref(),
                ) {
                    verify_bundle(&journal.target)?;
                    journal.phase = ActivationPhase::Verified;
                    journal.error = None;
                    return persist(path, &journal);
                }
            }
        }
        if candidate
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return recover(path, &mut journal, false);
        }
        if Instant::now() >= deadline {
            return recover(path, &mut journal, true);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn activation_lock(path: &Path) -> Result<std::fs::File> {
    let lock = path.with_file_name("activation.lock");
    if std::fs::symlink_metadata(&lock).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("activation lock must not be a symlink".into());
    }
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock)
        .map_err(|error| error.to_string())
}

/// Reconcile an interrupted supervisor after an actual candidate startup.
/// Normal startup never activates a package or kills a process.
pub fn resume_startup(root: &Path, archive_hash: &str, bytes: &[u8]) -> Result<()> {
    let pointer = root.join("latest-activation.json");
    let path: PathBuf = match std::fs::read(pointer) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !path.starts_with(root) {
        return Err("activation pointer escapes updater root".into());
    }
    let mut journal = read(&path)?;
    if journal.archive_sha256 != archive_hash
        || !matches!(
            journal.phase,
            ActivationPhase::Prepared
                | ActivationPhase::Installed
                | ActivationPhase::LaunchIntent
                | ActivationPhase::Launched
        )
    {
        return Ok(());
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    if current != journal.target.join(&journal.executable_relative)
        || build_identity() != journal.identity
    {
        return Ok(());
    }
    let temporary = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
    let signed = extract_candidate(bytes, &temporary.path().join("signed"))?;
    if tree_hash(&signed)? != journal.candidate_sha256
        || tree_hash(&journal.target)? != journal.candidate_sha256
        || probe(&signed.join(&journal.executable_relative))? != journal.identity
    {
        return Err("startup recovery differs from signed candidate".into());
    }
    verify_bundle(&journal.target)?;
    let lock = activation_lock(&path)?;
    let deadline = Instant::now() + Duration::from_secs(95);
    loop {
        if lock.try_lock_exclusive().is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    journal = read(&path)?;
    if matches!(
        journal.phase,
        ActivationPhase::Verified | ActivationPhase::RolledBack
    ) {
        return Ok(());
    }
    while !INTERACTIVE.load(Ordering::Acquire) {
        if Instant::now() >= deadline {
            journal.phase = ActivationPhase::RecoveryRequired;
            journal.error = Some(
                "startup recovery did not reach an interactive surface; previous app retained"
                    .into(),
            );
            return persist(&path, &journal);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if process_path(std::process::id()).as_deref() != Some(current.as_path())
        || file_hash(&current)? != journal.executable_sha256
    {
        return Err("actual recovery process differs from signed executable".into());
    }
    journal.candidate_pid = Some(std::process::id());
    journal.phase = ActivationPhase::Verified;
    journal.error = None;
    persist(&path, &journal)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_archive_paths_never_escape_staging() {
        let temp = tempfile::tempdir().unwrap();
        let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(gzip);
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "other.txt", &b"x"[..])
            .unwrap();
        let bytes = tar.into_inner().unwrap().finish().unwrap();
        assert!(extract_candidate(&bytes, &temp.path().join("candidate")).is_err());
        assert!(!temp.path().join("other.txt").exists());
    }
    #[test]
    fn alive_candidate_retains_previous_without_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let target = root.join("Mine.app");
        let previous = root.join("previous.app");
        let candidate = root.join("candidate/Mine.app");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&previous).unwrap();
        std::fs::create_dir_all(&candidate).unwrap();
        std::fs::write(target.join("bytes"), b"new").unwrap();
        std::fs::write(previous.join("bytes"), b"old").unwrap();
        let mut journal = ActivationJournal {
            schema_version: 1,
            phase: ActivationPhase::Launched,
            target: target.clone(),
            replacement: root.join("Mine-update-fixture.app"),
            previous: previous.clone(),
            candidate,
            executable_relative: "Contents/MacOS/mine".into(),
            candidate_sha256: tree_hash(&target).unwrap(),
            previous_sha256: tree_hash(&previous).unwrap(),
            executable_sha256: "unknown".into(),
            archive_sha256: "unknown".into(),
            identity: build_identity(),
            previous_identity: build_identity(),
            old_pid: 0,
            candidate_pid: Some(std::process::id()),
            token: "x".repeat(64),
            error: None,
        };
        recover(&root.join("activation-journal.json"), &mut journal, true).unwrap();
        publish_pointer(root, &root.join("activation-journal.json")).unwrap();
        assert!(latest_phase(root, Some("new-staged-archive"))
            .unwrap()
            .is_none());
        assert_eq!(
            latest_phase(root, Some("unknown")).unwrap().unwrap().0,
            ActivationPhase::RecoveryRequired
        );
        assert_eq!(journal.phase, ActivationPhase::RecoveryRequired);
        assert_eq!(std::fs::read(target.join("bytes")).unwrap(), b"new");
        assert_eq!(std::fs::read(previous.join("bytes")).unwrap(), b"old");
    }
    #[test]
    fn token_alone_cannot_assert_startup_identity() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("Mine.app");
        std::fs::create_dir_all(target.join("Contents/MacOS")).unwrap();
        let exe = target.join("Contents/MacOS/mine");
        std::fs::write(&exe, b"candidate").unwrap();
        let journal = ActivationJournal {
            schema_version: 1,
            phase: ActivationPhase::Launched,
            target,
            replacement: temp.path().join("Mine-update-fixture.app"),
            previous: temp.path().join("previous.app"),
            candidate: temp.path().join("candidate/Mine.app"),
            executable_relative: "Contents/MacOS/mine".into(),
            candidate_sha256: String::new(),
            previous_sha256: String::new(),
            executable_sha256: file_hash(&exe).unwrap(),
            archive_sha256: String::new(),
            identity: build_identity(),
            previous_identity: build_identity(),
            old_pid: 0,
            candidate_pid: Some(42),
            token: "x".repeat(64),
            error: None,
        };
        let handshake = Handshake {
            pid: 42,
            executable: exe.clone(),
            identity: build_identity(),
            token: journal.token.clone(),
        };
        assert!(!valid_handshake(
            &journal,
            &handshake,
            Some(Path::new("/foreign/process"))
        ));
        assert!(valid_handshake(&journal, &handshake, Some(&exe)));
        std::fs::write(&exe, b"altered").unwrap();
        assert!(!valid_handshake(&journal, &handshake, Some(&exe)));
    }
    #[test]
    fn verification_processes_have_a_real_timeout_and_hash_records_are_unambiguous() {
        assert!(bounded_output(
            Command::new("/bin/sleep").arg("2"),
            Duration::from_millis(40)
        )
        .is_err());
        let left = tempfile::tempdir().unwrap();
        let right = tempfile::tempdir().unwrap();
        std::fs::write(left.path().join("a"), b"X").unwrap();
        std::fs::write(left.path().join("b"), b"Y").unwrap();
        std::fs::write(right.path().join("a"), b"X\0b\0fileY").unwrap();
        assert_ne!(
            tree_hash(left.path()).unwrap(),
            tree_hash(right.path()).unwrap()
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_swap_keeps_both_temporary_packages_available() {
        let temporary = tempfile::tempdir().unwrap();
        let old = temporary.path().join("Old.app");
        let new = temporary.path().join("New.app");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(old.join("bytes"), b"old").unwrap();
        std::fs::write(new.join("bytes"), b"new").unwrap();
        atomic_swap(&old, &new).unwrap();
        assert_eq!(std::fs::read(old.join("bytes")).unwrap(), b"new");
        assert_eq!(std::fs::read(new.join("bytes")).unwrap(), b"old");
        atomic_swap(&old, &new).unwrap();
        assert_eq!(std::fs::read(old.join("bytes")).unwrap(), b"old");
        assert!(new.exists());
    }
}
