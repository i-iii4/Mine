//! Shared local component ownership: version policy, lock, immutable bytes and probes.
//! CLI activation has one durable pointer, not another multi-resource state machine.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) const MANAGED_RUNTIME_DIRECTORY: &str = "managed-v1";
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InstallDecision {
    Install,
    ReuseNewer,
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum PolicyError {
    #[error("installed runtime marker schema {0} is unknown and has been preserved")]
    UnknownMarker(u32),
    #[error("{owner} runtime version cannot be ordered safely: {version}")]
    InvalidVersion {
        owner: &'static str,
        version: String,
    },
    #[error("a different runtime is already registered for release {0}; publish a new version or use an explicit development build")]
    ReleaseIdentityCollision(String),
}
pub(crate) fn install_decision(
    installed: Option<(u32, &str)>,
    version: &str,
    same_identity: bool,
    development: bool,
) -> Result<InstallDecision, PolicyError> {
    let next = semver::Version::parse(version).map_err(|_| PolicyError::InvalidVersion {
        owner: "candidate",
        version: version.into(),
    })?;
    let Some((schema, previous)) = installed else {
        return Ok(InstallDecision::Install);
    };
    if schema != 1 {
        return Err(PolicyError::UnknownMarker(schema));
    }
    let previous = semver::Version::parse(previous).map_err(|_| PolicyError::InvalidVersion {
        owner: "installed",
        version: previous.into(),
    })?;
    match previous.cmp_precedence(&next) {
        std::cmp::Ordering::Greater => Ok(InstallDecision::ReuseNewer),
        std::cmp::Ordering::Equal if !same_identity && !development => {
            Err(PolicyError::ReleaseIdentityCollision(version.into()))
        }
        _ => Ok(InstallDecision::Install),
    }
}
pub(crate) fn install_lock(parent: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(parent)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join("runtime-install.lock"))?;
    file.try_lock_exclusive()?;
    Ok(file)
}
pub(crate) fn fingerprint(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn install_binary(source: &Path, destination: &Path) -> std::io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("runtime directory is missing"))?;
    std::fs::create_dir_all(parent)?;
    if destination.is_file() {
        let hash = fingerprint(destination)?;
        let name = destination
            .file_name()
            .ok_or_else(|| std::io::Error::other("runtime filename is missing"))?
            .to_string_lossy();
        let retained = parent.join("retained").join(format!("{name}-{hash}"));
        if !retained.exists() {
            let retention = retained
                .parent()
                .ok_or_else(|| std::io::Error::other("retention parent missing"))?;
            std::fs::create_dir_all(retention)?;
            let mut staged = tempfile::NamedTempFile::new_in(retention)?;
            std::io::copy(&mut std::fs::File::open(destination)?, staged.as_file_mut())?;
            staged
                .as_file()
                .set_permissions(std::fs::metadata(destination)?.permissions())?;
            staged.as_file().sync_all()?;
            staged.persist(&retained).map_err(|error| error.error)?;
            std::fs::File::open(retention)?.sync_all()?;
        }
        if fingerprint(&retained)? != hash {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "retained runtime verification failed",
            ));
        }
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    std::io::copy(&mut std::fs::File::open(source)?, staged.as_file_mut())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        staged
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    staged.as_file().sync_all()?;
    staged.persist(destination).map_err(|error| error.error)?;
    std::fs::File::open(parent)?.sync_all()
}

pub(crate) fn probe_runtime_host(
    host: &Path,
    expected_version: &str,
    expected_build_id: Option<&str>,
    timeout: Duration,
) -> std::io::Result<crate::runtime_protocol::RuntimeProbe> {
    use std::process::{Command, Stdio};
    let output = tempfile::NamedTempFile::new()?;
    let mut child = Command::new(host)
        .arg("--runtime-probe")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.as_file().try_clone()?))
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(std::io::Error::other(format!(
                    "candidate probe exited with {status}"
                )));
            }
            break;
        }
        if std::time::Instant::now() >= deadline || output.as_file().metadata()?.len() > 65536 {
            let _ = child.kill();
            child.wait()?;
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "candidate launch probe exceeded its time or output bound",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(output.path())?
        .take(65537)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "candidate probe response is too large",
        ));
    }
    let probe: crate::runtime_protocol::RuntimeProbe =
        serde_json::from_slice(&bytes).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("candidate probe response is malformed: {error}"),
            )
        })?;
    if probe.schema_version != 1
        || probe.version != expected_version
        || !valid_id(&probe.build_id)
        || expected_build_id.is_some_and(|expected| expected != probe.build_id)
        || !probe
            .save_protocols
            .contains(&crate::runtime_protocol::BASE_SAVE_PROTOCOL)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "candidate launch identity or protocol differs from its package",
        ));
    }
    Ok(probe)
}
fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Explicit developer CLI sources; installing CLI never requires a browser bundle.
pub struct DevelopmentCliInputs {
    /// The freshly built CLI component, probed before any publication.
    pub source: PathBuf,
    /// Mine's application support root, shared with the clipper runtime owner.
    pub app_data_dir: PathBuf,
    /// The exact PATH entry; existing foreign files or links are never replaced.
    pub entrypoint: PathBuf,
    /// The expected semantic version of the compiled component.
    pub app_version: String,
}
/// Read-back evidence for the actual managed CLI pointer, not public delivery.
#[derive(Debug, Serialize)]
pub struct DevelopmentCliReport {
    /// The stable PATH entry pointing at an immutable complete executable.
    pub entrypoint: PathBuf,
    /// The actual immutable executor, which may be newer than the caller.
    pub executable: PathBuf,
    /// The selected actual semantic version.
    pub version: String,
    /// Actual component build identity.
    pub build_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CliManifest {
    schema_version: u32,
    version: String,
    build_id: String,
    commit: String,
    sha256: String,
    bytes: u64,
}
fn manifest_id(manifest: &CliManifest) -> std::io::Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(manifest).map_err(std::io::Error::other)?)
    ))
}
fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}
fn verify_cli(executable: &Path, manifest: &CliManifest) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::symlink_metadata(executable)?;
    if manifest.schema_version != 1
        || !valid_id(&manifest.build_id)
        || !valid_id(&manifest.sha256)
        || !metadata.is_file()
        || metadata.permissions().mode() & 0o111 == 0
        || metadata.len() != manifest.bytes
        || fingerprint(executable)? != manifest.sha256
    {
        return Err(invalid(
            "managed CLI package changed or has an unknown schema; it was preserved",
        ));
    }
    Ok(())
}
fn installed_cli(
    entrypoint: &Path,
    owner: &Path,
) -> std::io::Result<Option<(PathBuf, CliManifest)>> {
    let metadata = match std::fs::symlink_metadata(entrypoint) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_symlink() {
        return Err(invalid(
            "existing CLI entry is not managed by Mine; it was not overwritten",
        ));
    }
    let executable = std::fs::read_link(entrypoint)?;
    let package = executable
        .parent()
        .ok_or_else(|| invalid("foreign CLI pointer preserved"))?;
    let id = package
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("foreign CLI pointer preserved"))?;
    if executable.file_name().is_none_or(|name| name != "mine-cli")
        || package.parent() != Some(owner.join("packages").as_path())
        || !valid_id(id)
    {
        return Err(invalid(
            "existing CLI pointer belongs to another owner; it was not overwritten",
        ));
    }
    if !std::fs::symlink_metadata(package)?.is_dir()
        || !std::fs::symlink_metadata(package.join("cli-manifest.json"))?.is_file()
    {
        return Err(invalid(
            "managed CLI package or manifest is a foreign link; preserved",
        ));
    }
    let manifest: CliManifest =
        serde_json::from_slice(&std::fs::read(package.join("cli-manifest.json"))?)
            .map_err(|_| invalid("unknown CLI manifest preserved"))?;
    if manifest_id(&manifest)? != id {
        return Err(invalid(
            "CLI package identity differs from its manifest; preserved",
        ));
    }
    verify_cli(&executable, &manifest)?;
    Ok(Some((executable, manifest)))
}
fn prepare_cli(owner: &Path, source: &Path, manifest: &CliManifest) -> std::io::Result<PathBuf> {
    let packages = owner.join("packages");
    std::fs::create_dir_all(&packages)?;
    let package = packages.join(manifest_id(manifest)?);
    let executable = package.join("mine-cli");
    if package.exists() {
        if !std::fs::symlink_metadata(&package)?.is_dir()
            || !std::fs::symlink_metadata(package.join("cli-manifest.json"))?.is_file()
        {
            return Err(invalid(
                "prepared CLI package or manifest is a foreign link; preserved",
            ));
        }
        let stored: CliManifest =
            serde_json::from_slice(&std::fs::read(package.join("cli-manifest.json"))?)
                .map_err(|_| invalid("unknown prepared CLI manifest preserved"))?;
        if stored != *manifest {
            return Err(invalid(
                "immutable prepared CLI manifest changed and was preserved",
            ));
        }
        verify_cli(&executable, manifest)?;
        return Ok(executable);
    }
    let staged = tempfile::Builder::new()
        .prefix(".preparing-cli-")
        .tempdir_in(&packages)?;
    install_binary(source, &staged.path().join("mine-cli"))?;
    crate::storage::files::write_atomically(
        &staged.path().join("cli-manifest.json"),
        &serde_json::to_vec(manifest).map_err(std::io::Error::other)?,
    )
    .map_err(std::io::Error::other)?;
    verify_cli(&staged.path().join("mine-cli"), manifest)?;
    std::fs::File::open(staged.path())?.sync_all()?;
    std::fs::rename(staged.path(), &package)?;
    std::fs::File::open(&packages)?.sync_all()?;
    Ok(executable)
}
fn publish_cli_pointer(
    entrypoint: &Path,
    owner: &Path,
    source: &Path,
    manifest: &CliManifest,
    mut after_effect: impl FnMut(bool) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let parent = entrypoint
        .parent()
        .ok_or_else(|| invalid("CLI entry parent missing"))?;
    std::fs::create_dir_all(parent)?;
    // Keep the temporary symlink on the same filesystem, under a private name.
    let staged = tempfile::Builder::new()
        .prefix(".mine-cli-pointer-")
        .tempdir_in(parent)?;
    let pointer = staged.path().join("mine");
    std::os::unix::fs::symlink(source, &pointer)?;
    std::fs::File::open(staged.path())?.sync_all()?;
    after_effect(false)?;
    // Refuse a foreign entry introduced since the initial owner check.
    let existing = installed_cli(entrypoint, owner)?;
    #[cfg(target_os = "macos")]
    if existing.is_none() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: std::ffi::c_uint,
            ) -> std::ffi::c_int;
        }
        let from = CString::new(pointer.as_os_str().as_bytes())
            .map_err(|_| invalid("unsafe CLI pointer path"))?;
        let to = CString::new(entrypoint.as_os_str().as_bytes())
            .map_err(|_| invalid("unsafe CLI entry path"))?;
        // RENAME_EXCL atomically refuses any entry introduced after the check.
        if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 0x00000004) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
    } else {
        std::fs::rename(&pointer, entrypoint)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = existing;
        std::fs::rename(&pointer, entrypoint)?;
    }
    std::fs::File::open(parent)?.sync_all()?;
    after_effect(true)?;
    let actual = installed_cli(entrypoint, owner)?
        .ok_or_else(|| invalid("CLI pointer disappeared after publication"))?;
    if actual.0 != source || actual.1 != *manifest {
        return Err(invalid(
            "CLI pointer read-back differs from published component",
        ));
    }
    Ok(())
}
/// Install an explicitly selected developer CLI with no downgrade or foreign overwrite.
/// One atomic durable PATH pointer is the commit; immutable old packages remain intact.
pub fn install_development_cli(
    inputs: DevelopmentCliInputs,
) -> std::io::Result<DevelopmentCliReport> {
    if !inputs.app_data_dir.is_absolute()
        || !inputs.entrypoint.is_absolute()
        || inputs
            .entrypoint
            .file_name()
            .is_none_or(|name| name != "mine")
    {
        return Err(invalid(
            "CLI installation requires absolute owner and exact mine entry paths",
        ));
    }
    let _writer = crate::storage::source_mutation::begin_write().map_err(std::io::Error::other)?;
    let owner = inputs
        .app_data_dir
        .join("clipper")
        .join(MANAGED_RUNTIME_DIRECTORY);
    let _lock = install_lock(&owner)?;
    let installed = installed_cli(&inputs.entrypoint, &owner)?;
    let identity = probe_runtime_host(&inputs.source, &inputs.app_version, None, PROBE_TIMEOUT)?;
    let candidate = CliManifest {
        schema_version: 1,
        version: identity.version,
        build_id: identity.build_id,
        commit: identity.commit,
        sha256: fingerprint(&inputs.source)?,
        bytes: std::fs::metadata(&inputs.source)?.len(),
    };
    let decision = install_decision(
        installed
            .as_ref()
            .map(|(_, manifest)| (manifest.schema_version, manifest.version.as_str())),
        &candidate.version,
        installed
            .as_ref()
            .is_some_and(|(_, value)| *value == candidate),
        true,
    )
    .map_err(std::io::Error::other)?;
    let (executable, selected) = if decision == InstallDecision::ReuseNewer {
        installed.ok_or_else(|| invalid("installed CLI disappeared"))?
    } else {
        let executable = prepare_cli(&owner, &inputs.source, &candidate)?;
        probe_runtime_host(
            &executable,
            &candidate.version,
            Some(&candidate.build_id),
            PROBE_TIMEOUT,
        )?;
        publish_cli_pointer(&inputs.entrypoint, &owner, &executable, &candidate, |_| {
            Ok(())
        })?;
        (executable, candidate)
    };
    verify_cli(&executable, &selected)?;
    probe_runtime_host(
        &executable,
        &selected.version,
        Some(&selected.build_id),
        PROBE_TIMEOUT,
    )?;
    Ok(DevelopmentCliReport {
        entrypoint: inputs.entrypoint,
        executable,
        version: selected.version,
        build_id: selected.build_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn source(root: &Path, version: &str, id: char) -> PathBuf {
        let path = root.join(format!("source-{version}-{id}"));
        let identity = crate::runtime_protocol::RuntimeProbe {
            schema_version: 1,
            version: version.into(),
            build_id: id.to_string().repeat(64),
            commit: "fixture".into(),
            save_protocols: vec![1],
        };
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nprintf '%s' '{}'\n",
                serde_json::to_string(&identity).unwrap()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
    fn inputs(root: &Path, source: PathBuf, version: &str) -> DevelopmentCliInputs {
        DevelopmentCliInputs {
            source,
            app_data_dir: root.join("app-data"),
            entrypoint: root.join("bin/mine"),
            app_version: version.into(),
        }
    }
    #[test]
    fn cli_same_version_development_replaces_pointer_and_retains_old_executor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let old =
            install_development_cli(inputs(root, source(root, "0.1.0", 'a'), "0.1.0")).unwrap();
        let bytes = std::fs::read(&old.executable).unwrap();
        let new =
            install_development_cli(inputs(root, source(root, "0.1.0", 'b'), "0.1.0")).unwrap();
        assert_ne!(old.executable, new.executable);
        assert_eq!(std::fs::read_link(new.entrypoint).unwrap(), new.executable);
        assert_eq!(std::fs::read(old.executable).unwrap(), bytes);
    }
    #[test]
    fn cli_older_developer_never_replaces_newer_verified_executor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let new =
            install_development_cli(inputs(root, source(root, "2.0.0", 'b'), "2.0.0")).unwrap();
        let old =
            install_development_cli(inputs(root, source(root, "1.0.0", 'a'), "1.0.0")).unwrap();
        assert_eq!(old.executable, new.executable);
        assert_eq!(old.version, "2.0.0");
    }
    #[test]
    fn cli_foreign_file_and_symlink_are_never_adopted_or_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir(root.join("bin")).unwrap();
        let compiled = source(root, "1.0.0", 'a');
        std::fs::write(root.join("bin/mine"), b"foreign").unwrap();
        assert!(install_development_cli(inputs(root, compiled.clone(), "1.0.0")).is_err());
        assert_eq!(std::fs::read(root.join("bin/mine")).unwrap(), b"foreign");
        std::fs::rename(root.join("bin/mine"), root.join("foreign")).unwrap();
        std::os::unix::fs::symlink(root.join("foreign"), root.join("bin/mine")).unwrap();
        assert!(install_development_cli(inputs(root, compiled, "1.0.0")).is_err());
        assert_eq!(
            std::fs::read_link(root.join("bin/mine")).unwrap(),
            root.join("foreign")
        );
        assert_eq!(std::fs::read(root.join("foreign")).unwrap(), b"foreign");
    }
    #[test]
    fn cli_pointer_is_complete_after_crash_before_and_after_atomic_commit() {
        for stopped_after in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let old =
                install_development_cli(inputs(root, source(root, "1.0.0", 'a'), "1.0.0")).unwrap();
            let owner = root.join("app-data/clipper/managed-v1");
            let compiled = source(root, "2.0.0", 'b');
            let manifest = CliManifest {
                schema_version: 1,
                version: "2.0.0".into(),
                build_id: "b".repeat(64),
                commit: "fixture".into(),
                sha256: fingerprint(&compiled).unwrap(),
                bytes: std::fs::metadata(&compiled).unwrap().len(),
            };
            let prepared = prepare_cli(&owner, &compiled, &manifest).unwrap();
            assert!(
                publish_cli_pointer(&old.entrypoint, &owner, &prepared, &manifest, |after| {
                    if after == stopped_after {
                        Err(std::io::Error::other("process stopped"))
                    } else {
                        Ok(())
                    }
                })
                .is_err()
            );
            let actual = installed_cli(&old.entrypoint, &owner).unwrap().unwrap();
            assert_eq!(
                actual.0,
                if stopped_after {
                    prepared
                } else {
                    old.executable
                }
            );
            let recovered = install_development_cli(inputs(root, compiled, "2.0.0")).unwrap();
            assert_eq!(recovered.version, "2.0.0");
        }
    }
    #[test]
    fn cli_unknown_manifest_and_damaged_package_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let old =
            install_development_cli(inputs(root, source(root, "1.0.0", 'a'), "1.0.0")).unwrap();
        let manifest = old.executable.parent().unwrap().join("cli-manifest.json");
        let bytes = std::fs::read(&manifest).unwrap();
        std::fs::write(&manifest, b"{\"schema_version\":99}").unwrap();
        let candidate = source(root, "2.0.0", 'b');
        assert!(install_development_cli(inputs(root, candidate.clone(), "2.0.0")).is_err());
        assert_eq!(
            std::fs::read(&manifest).unwrap(),
            b"{\"schema_version\":99}"
        );
        assert_eq!(std::fs::read_link(&old.entrypoint).unwrap(), old.executable);
        std::fs::write(&manifest, bytes).unwrap();
        std::fs::write(&old.executable, b"damage").unwrap();
        assert!(install_development_cli(inputs(root, candidate, "2.0.0")).is_err());
        assert_eq!(std::fs::read(&old.executable).unwrap(), b"damage");
    }
    #[test]
    fn common_policy_does_not_order_hashes_or_implicitly_replace_release_identity() {
        assert!(install_decision(Some((1, "1.0.0")), "1.0.0", false, false).is_err());
        assert_eq!(
            install_decision(Some((1, "1.0.0")), "1.0.0", false, true).unwrap(),
            InstallDecision::Install
        );
        assert!(install_decision(Some((99, "1.0.0")), "2.0.0", false, true).is_err());
        assert!(install_decision(None, "unordered", false, true).is_err());
    }
    #[test]
    fn cli_failed_candidate_probe_leaves_actual_pointer_and_old_bytes_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let old =
            install_development_cli(inputs(root, source(root, "1.0.0", 'a'), "1.0.0")).unwrap();
        let bytes = std::fs::read(&old.executable).unwrap();
        let candidate = source(root, "2.0.0", 'b');
        std::fs::write(&candidate, b"#!/bin/sh\nprintf '%s' 'malformed'\n").unwrap();
        assert!(install_development_cli(inputs(root, candidate, "2.0.0")).is_err());
        assert_eq!(std::fs::read_link(&old.entrypoint).unwrap(), old.executable);
        assert_eq!(std::fs::read(&old.executable).unwrap(), bytes);
    }
    #[test]
    fn cli_publication_refuses_a_foreign_entry_introduced_before_commit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let old =
            install_development_cli(inputs(root, source(root, "1.0.0", 'a'), "1.0.0")).unwrap();
        let owner = root.join("app-data/clipper/managed-v1");
        let (_, manifest) = installed_cli(&old.entrypoint, &owner).unwrap().unwrap();
        assert!(publish_cli_pointer(
            &old.entrypoint,
            &owner,
            &old.executable,
            &manifest,
            |after| {
                if !after {
                    std::fs::rename(&old.entrypoint, root.join("prior-pointer"))?;
                    std::fs::write(&old.entrypoint, b"foreign")?;
                }
                Ok(())
            }
        )
        .is_err());
        assert_eq!(std::fs::read(&old.entrypoint).unwrap(), b"foreign");
    }
}
